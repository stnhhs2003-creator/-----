/*
 * /api/auth/* —— Google 登入流程與 session 簽發。
 *
 * 走的是標準 OAuth 2.0 authorization code flow：
 *   /api/auth/login    → 302 導去 Google 同意畫面
 *   /api/auth/callback → Google 帶 code 回來，換 id_token，簽出 session cookie
 *   /api/auth/me       → 前端問「現在是誰」
 *   /api/auth/logout   → 清掉 cookie
 *
 * client secret 只從 env.GOOGLE_CLIENT_SECRET 讀，任何情況都不寫進回應或紀錄。
 */

import {
  requireTeacher,
  signSession,
  sessionCookie,
  clearSessionCookie,
  readCookie,
  Unauthorized,
} from '../../_lib/session.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/* state 用一顆短命 cookie 存，回來時比對，擋掉別人偽造的 callback（CSRF）。 */
const STATE_COOKIE = 'cp_oauth_state';
/* 登入完要回哪一頁。家長是從 parent.html 進來的，登完丟回 / 會掉到老師的主畫面。 */
const NEXT_COOKIE = 'cp_oauth_next';
const STATE_TTL_SECONDS = 600;

/*
 * 只接受本站的相對路徑。放行完整網址等於做了一個開放轉址，
 * 別人可以拿我們的網域把人導去釣魚頁。`//evil.com` 也是完整網址，要一起擋。
 */
export function safeNext(value) {
  const v = String(value || '');
  if (!v.startsWith('/') || v.startsWith('//')) return '/';
  return v;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

/*
 * Set-Cookie 允許給陣列。多個 cookie 必須各自 append 一行——
 * 用逗號串成一個標頭，瀏覽器會把它讀成一顆值裡含逗號的 cookie，兩顆都壞掉。
 */
function redirect(location, headers = {}) {
  const h = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  for (const [k, v] of Object.entries(headers)) {
    if (Array.isArray(v)) v.forEach((one) => h.append(k, one));
    else h.set(k, v);
  }
  return new Response(null, { status: 302, headers: h });
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 設定是否齊全。三個都要有，缺一個就沒辦法完成流程，早點講清楚比中途壞掉好。 */
function missingConfig(env) {
  return ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SESSION_SECRET'].filter((k) => !env?.[k]);
}

function callbackUrl(request) {
  return new URL('/api/auth/callback', new URL(request.url).origin).toString();
}

/*
 * id_token 是 Google 直接透過 TLS 回給我們的（不是瀏覽器轉手），
 * 所以這裡只解 payload、不重驗簽章——要驗簽章得再抓一次 JWKS，
 * 對這條「後端直接跟 Google 換 token」的路徑沒有多出安全性。
 */
function decodeIdToken(idToken) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) return null;
  const pad = parts[1].length % 4 === 0 ? '' : '='.repeat(4 - (parts[1].length % 4));
  try {
    const bin = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/') + pad);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

async function handleLogin(request, env) {
  const missing = missingConfig(env);
  if (missing.length) {
    return json({ error: 'not_configured', missing, message: '尚未設定 Google 登入' }, 503);
  }
  const state = randomToken();
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', callbackUrl(request));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  // 只認人、不代替老師操作 Google 的任何服務，所以不要 refresh token。
  url.searchParams.set('access_type', 'online');
  url.searchParams.set('prompt', 'select_account');

  const next = safeNext(new URL(request.url).searchParams.get('next'));
  return redirect(url.toString(), {
    'Set-Cookie': [
      `${STATE_COOKIE}=${state}; Path=/api/auth; Max-Age=${STATE_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
      `${NEXT_COOKIE}=${encodeURIComponent(next)}; Path=/api/auth; Max-Age=${STATE_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
    ],
  });
}

async function handleCallback(request, env) {
  const url = new URL(request.url);
  const back = (reason) => redirect(`/login.html?error=${encodeURIComponent(reason)}`, {
    'Set-Cookie': `${STATE_COOKIE}=; Path=/api/auth; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
  });

  if (missingConfig(env).length) return back('not_configured');
  if (url.searchParams.get('error')) return back('denied');

  const state = url.searchParams.get('state');
  const expected = readCookie(request, STATE_COOKIE);
  if (!state || !expected || state !== expected) return back('bad_state');

  const code = url.searchParams.get('code');
  if (!code) return back('no_code');

  let idToken;
  try {
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: callbackUrl(request),
        grant_type: 'authorization_code',
      }),
    });
    if (!res.ok) return back('token_exchange_failed');
    idToken = (await res.json()).id_token;
  } catch {
    return back('token_exchange_failed');
  }

  const claims = decodeIdToken(idToken);
  // teacherId 用 sub 不用 email：老師換學校信箱時資料不該跟著不見。
  if (!claims || !claims.sub) return back('bad_token');

  const token = await signSession({ teacherId: claims.sub, email: claims.email || '' }, env.SESSION_SECRET);
  // 回原本那一頁：家長回家長端，老師回主畫面。cookie 用完就清掉。
  const next = safeNext(readCookie(request, NEXT_COOKIE));
  return redirect(next, {
    'Set-Cookie': [
      sessionCookie(token),
      `${NEXT_COOKIE}=; Path=/api/auth; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    ],
  });
}

async function handleMe(request, env) {
  try {
    const teacher = await requireTeacher(request, env);
    return json({ signedIn: true, ...teacher });
  } catch (err) {
    if (err instanceof Unauthorized) return json({ signedIn: false }, 401);
    throw err;
  }
}

function handleLogout() {
  return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const route = Array.isArray(params?.route) ? params.route.join('/') : String(params?.route || '');
  const method = request.method.toUpperCase();

  if (route === 'login' && method === 'GET') return handleLogin(request, env);
  if (route === 'callback' && method === 'GET') return handleCallback(request, env);
  if (route === 'me' && method === 'GET') return handleMe(request, env);
  if (route === 'logout' && (method === 'POST' || method === 'GET')) return handleLogout();

  // 設定狀態要能在沒登入時查，登入頁靠它顯示「尚未設定」。回傳缺哪些變數，但不回傳值。
  if (route === 'config' && method === 'GET') {
    const missing = missingConfig(env);
    return json({ configured: missing.length === 0, missing });
  }

  return json({ error: 'not_found' }, 404);
}
