/*
 * 後端共用：從請求裡取出目前登入的老師。
 *
 * session 不進資料庫，改用「簽章過的 cookie」：把 { sub, email, exp } 直接放在
 * cookie 裡，後面接一段 HMAC-SHA256 簽章。這樣後端不必為了認人多打一次 DB，
 * 而 Cloudflare Pages Functions 每次冷啟都是新的 isolate，本來也存不住記憶體 session。
 *
 * 簽章金鑰只從 env.SESSION_SECRET 讀，程式碼裡不留任何預設值——
 * 少了金鑰就一律當成未登入，不要用空字串簽出「大家都驗得過」的 cookie。
 */

/** cookie 名稱。前綴 cp_ 是為了跟同網域其他小工具的 cookie 分開。 */
export const SESSION_COOKIE = 'cp_session';

/** session 有效期。老師一週上五天課，14 天足以撐過一個連假不用重登。 */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;

export class Unauthorized extends Error {
  constructor(message = '尚未登入') {
    super(message);
    this.status = 401;
  }
}

/* ---- base64url：cookie 不能放 + / = 這些字元，所以不能用原味 base64 ---- */

function base64urlFromBytes(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesFromBase64url(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

/*
 * 用字串長度與內容都不提前 return 的方式比對，避免用回應時間一位一位試出正確簽章。
 * 這是 HMAC 驗證的基本功，不是過度設計。
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 簽發 session token：`<base64url(payload JSON)>.<base64url(HMAC)>`。
 * payload 一定會被覆寫成帶 exp 的版本，呼叫端不能自己塞一個永不過期的 exp。
 */
export async function signSession({ teacherId, email }, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!secret) throw new Error('缺少 SESSION_SECRET，不簽發 session');
  if (!teacherId) throw new Error('缺少 teacherId，不簽發 session');
  const payload = { sub: teacherId, email: email || '', exp: nowSeconds + SESSION_TTL_SECONDS };
  const body = base64urlFromBytes(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `${body}.${base64urlFromBytes(new Uint8Array(sig))}`;
}

/**
 * 驗證 token，回傳 { teacherId, email } 或 null。
 * 任何一步不對就回 null，不對外區分「簽章錯」與「過期」——那是給攻擊者的線索。
 */
export async function verifySession(token, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!token || !secret) return null;
  const dot = token.indexOf('.');
  if (dot < 1 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  let expected;
  try {
    const key = await hmacKey(secret);
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
    expected = base64urlFromBytes(new Uint8Array(mac));
  } catch {
    return null;
  }
  if (!timingSafeEqual(sig, expected)) return null;

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytesFromBase64url(body)));
  } catch {
    return null;
  }
  if (!payload || typeof payload.sub !== 'string' || !payload.sub) return null;
  if (typeof payload.exp !== 'number' || payload.exp <= nowSeconds) return null;
  return { teacherId: payload.sub, email: typeof payload.email === 'string' ? payload.email : '' };
}

/** 從 Cookie 標頭裡取一個值。名稱後面一定要接 `=`，避免 `xcp_session` 被誤認。 */
export function readCookie(request, name) {
  const raw = request?.headers?.get?.('Cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const s = part.trim();
    const eq = s.indexOf('=');
    if (eq > 0 && s.slice(0, eq) === name) return decodeURIComponent(s.slice(eq + 1));
  }
  return null;
}

/*
 * HttpOnly：JS 拿不到，XSS 也偷不走。
 * Secure：只走 HTTPS（本機 http://localhost 瀏覽器仍接受這個組合）。
 * SameSite=Lax：跨站表單 POST 帶不上這個 cookie，擋掉 CSRF 的主要路徑，
 *   但從 Google 導回來的 top-level GET 仍然帶得到，登入流程才不會斷。
 */
export function sessionCookie(token, maxAge = SESSION_TTL_SECONDS) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

/** 登出用：同名同 Path 覆寫成立即過期，瀏覽器才會真的刪掉。 */
export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/*
 * 本機開發後門的第二道鎖。
 *
 * 光看 env.DEV_TEACHER_ID 有沒有設是不夠的——環境變數會被人不小心貼進
 * Cloudflare Pages 的 Production 設定裡。所以再要求請求本身來自本機主機名，
 * 正式網域（*.pages.dev / *.netlify.app / 自訂網域）永遠不符合這個條件，
 * 就算變數被誤設也開不起來。
 */
function isLocalRequest(request) {
  let host;
  try {
    host = new URL(request.url).hostname;
  } catch {
    return false;
  }
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host.endsWith('.localhost');
}

/**
 * 回傳 { teacherId, email }，未登入則 throw Unauthorized。
 * B.1 的資料 API 也用這支，介面不可改。
 */
export async function requireTeacher(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  const session = await verifySession(token, env?.SESSION_SECRET);
  if (session) return session;

  // 只有「沒有正式 session」＋「變數有設」＋「請求來自本機」三個條件同時成立才放行。
  if (env?.DEV_TEACHER_ID && isLocalRequest(request)) {
    return { teacherId: env.DEV_TEACHER_ID, email: 'dev@localhost' };
  }
  throw new Unauthorized();
}
