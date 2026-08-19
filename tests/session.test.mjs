/*
 * session 簽章與登入守門的測試。
 *
 * 這裡守的是「後端怎麼認出老師是誰」。認錯人的後果是甲老師看到乙老師的班級，
 * 所以每一條偽造 token 的路徑都要有一條測試釘住。
 *
 * 全程不打 Google 的網路：id_token 的部分用自簽的假 token，
 * OAuth callback 只測「state 對不上就擋掉」這種在換 token 之前就結束的路徑。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  requireTeacher,
  signSession,
  verifySession,
  sessionCookie,
  clearSessionCookie,
  readCookie,
  Unauthorized,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from '../functions/_lib/session.js';

import { onRequest } from '../functions/api/auth/[[route]].js';

const SECRET = 'test-secret-不要用在正式環境';
const NOW = 1_770_000_000;

/** 造一個帶 cookie 的請求；host 預設用正式網域，要測本機後門再自己指定。 */
function req(url = 'https://class-points.pages.dev/api/auth/me', cookie = null) {
  const headers = cookie ? { Cookie: cookie } : {};
  return new Request(url, { headers });
}

/* ---- 簽章本身 ---- */

test('簽出來的 token 驗得回同一個 teacherId 與 email', async () => {
  const token = await signSession({ teacherId: '110', email: 'a@b.tw' }, SECRET, NOW);
  assert.deepEqual(await verifySession(token, SECRET, NOW), { teacherId: '110', email: 'a@b.tw' });
});

test('payload 被改過就驗不過（簽章涵蓋整段 payload）', async () => {
  const token = await signSession({ teacherId: '110', email: 'a@b.tw' }, SECRET, NOW);
  const [, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: '999', email: 'x@y.tw', exp: NOW + 999 }))
    .toString('base64url');
  assert.equal(await verifySession(`${forged}.${sig}`, SECRET, NOW), null);
});

test('簽章被改過就驗不過', async () => {
  const token = await signSession({ teacherId: '110' }, SECRET, NOW);
  const [body, sig] = token.split('.');
  const flipped = sig.slice(0, -1) + (sig.at(-1) === 'A' ? 'B' : 'A');
  assert.equal(await verifySession(`${body}.${flipped}`, SECRET, NOW), null);
});

test('換一把金鑰就驗不過（換掉 SESSION_SECRET 等於強制全部重新登入）', async () => {
  const token = await signSession({ teacherId: '110' }, SECRET, NOW);
  assert.equal(await verifySession(token, 'another-secret', NOW), null);
});

test('過期的 token 驗不過', async () => {
  const token = await signSession({ teacherId: '110' }, SECRET, NOW);
  assert.ok(await verifySession(token, SECRET, NOW + SESSION_TTL_SECONDS - 1));
  assert.equal(await verifySession(token, SECRET, NOW + SESSION_TTL_SECONDS + 1), null);
});

test('沒有金鑰時不簽發、也不驗過任何東西', async () => {
  await assert.rejects(() => signSession({ teacherId: '110' }, ''), /SESSION_SECRET/);
  const token = await signSession({ teacherId: '110' }, SECRET, NOW);
  assert.equal(await verifySession(token, undefined, NOW), null);
});

test('亂七八糟的字串不會讓驗證爆掉，只會回 null', async () => {
  for (const bad of ['', 'x', 'a.b', '.abc', 'abc.', '@@@.@@@', 'a.b.c']) {
    assert.equal(await verifySession(bad, SECRET, NOW), null, `輸入：${bad}`);
  }
});

/* ---- cookie ---- */

test('cookie 名稱要完全相符，不會被 xcp_session 這種前綴騙過去', () => {
  assert.equal(readCookie(req('https://x.tw/', 'xcp_session=fake'), SESSION_COOKIE), null);
  assert.equal(readCookie(req('https://x.tw/', 'a=1; cp_session=real; b=2'), SESSION_COOKIE), 'real');
});

test('session cookie 帶齊 HttpOnly / Secure / SameSite=Lax', () => {
  const c = sessionCookie('tok');
  assert.match(c, /HttpOnly/);
  assert.match(c, /Secure/);
  assert.match(c, /SameSite=Lax/);
  assert.match(clearSessionCookie(), /Max-Age=0/);
});

/* ---- requireTeacher ---- */

test('帶著有效 cookie 就認得出老師', async () => {
  const token = await signSession({ teacherId: 'sub-123', email: 't@school.tw' }, SECRET);
  const r = req('https://class-points.pages.dev/api/data/x', `${SESSION_COOKIE}=${token}`);
  assert.deepEqual(await requireTeacher(r, { SESSION_SECRET: SECRET }), {
    teacherId: 'sub-123',
    email: 't@school.tw',
  });
});

test('沒有 cookie 就 throw Unauthorized（status 401）', async () => {
  await assert.rejects(() => requireTeacher(req(), { SESSION_SECRET: SECRET }), (err) => {
    assert.ok(err instanceof Unauthorized);
    assert.equal(err.status, 401);
    return true;
  });
});

/* ---- 本機開發後門 ---- */

test('DEV_TEACHER_ID 在 localhost 才放行', async () => {
  const env = { DEV_TEACHER_ID: 'dev-1', SESSION_SECRET: SECRET };
  const local = req('http://localhost:8788/api/data/x');
  assert.equal((await requireTeacher(local, env)).teacherId, 'dev-1');
});

test('DEV_TEACHER_ID 就算被誤設在正式環境，正式網域一樣擋掉', async () => {
  const env = { DEV_TEACHER_ID: 'dev-1', SESSION_SECRET: SECRET };
  for (const url of [
    'https://class-points.pages.dev/api/data/x',
    'https://class-points.netlify.app/api/data/x',
    'https://points.example.edu.tw/api/data/x',
    'https://localhost.attacker.com/api/data/x',
  ]) {
    await assert.rejects(() => requireTeacher(req(url), env), Unauthorized, `網域：${url}`);
  }
});

test('沒設 DEV_TEACHER_ID 時，連本機也擋（後門預設是關的）', async () => {
  await assert.rejects(
    () => requireTeacher(req('http://localhost:8788/api/data/x'), { SESSION_SECRET: SECRET }),
    Unauthorized,
  );
});

test('有正式 session 時走 session，不會被 DEV_TEACHER_ID 蓋掉', async () => {
  const token = await signSession({ teacherId: 'real-sub', email: 'r@s.tw' }, SECRET);
  const r = req('http://localhost:8788/api/data/x', `${SESSION_COOKIE}=${token}`);
  const env = { DEV_TEACHER_ID: 'dev-1', SESSION_SECRET: SECRET };
  assert.equal((await requireTeacher(r, env)).teacherId, 'real-sub');
});

/* ---- /api/auth 路由（不碰網路的路徑）---- */

const call = (url, env, init = {}) =>
  onRequest({ request: new Request(url, init), env, params: { route: new URL(url).pathname.replace('/api/auth/', '').split('/') } });

test('設定不齊全時 /config 回報缺哪些變數（但不回傳值）', async () => {
  const res = await call('https://x.tw/api/auth/config', { GOOGLE_CLIENT_ID: 'id' });
  const body = await res.json();
  assert.equal(body.configured, false);
  assert.deepEqual(body.missing, ['GOOGLE_CLIENT_SECRET', 'SESSION_SECRET']);
  assert.equal(JSON.stringify(body).includes('id'), false);
});

test('設定齊全時 /config 回 configured: true', async () => {
  const res = await call('https://x.tw/api/auth/config', {
    GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec', SESSION_SECRET: SECRET,
  });
  assert.deepEqual(await res.json(), { configured: true, missing: [] });
});

test('沒設定就按登入，回 503 而不是把人送去一個壞掉的 Google 網址', async () => {
  const res = await call('https://x.tw/api/auth/login', {});
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'not_configured');
});

test('設定齊全時 /login 導去 Google 並種下 state cookie', async () => {
  const res = await call('https://x.tw/api/auth/login', {
    GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'sec', SESSION_SECRET: SECRET,
  });
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get('Location'));
  assert.equal(loc.origin + loc.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(loc.searchParams.get('redirect_uri'), 'https://x.tw/api/auth/callback');
  assert.equal(loc.searchParams.get('response_type'), 'code');
  const state = loc.searchParams.get('state');
  assert.match(res.headers.get('Set-Cookie'), new RegExp(`cp_oauth_state=${state};`));
  // client secret 絕不可以出現在導向網址裡
  assert.equal(res.headers.get('Location').includes('sec'), false);
});

test('callback 的 state 對不上就退回登入頁，不會去換 token', async () => {
  const env = { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec', SESSION_SECRET: SECRET };
  const res = await call('https://x.tw/api/auth/callback?code=abc&state=forged', env, {
    headers: { Cookie: 'cp_oauth_state=real' },
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), '/login.html?error=bad_state');
});

test('callback 完全沒有 state cookie 也擋掉', async () => {
  const env = { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec', SESSION_SECRET: SECRET };
  const res = await call('https://x.tw/api/auth/callback?code=abc&state=whatever', env);
  assert.equal(res.headers.get('Location'), '/login.html?error=bad_state');
});

test('/me 未登入回 401 且不吐任何身分資訊', async () => {
  const res = await call('https://x.tw/api/auth/me', { SESSION_SECRET: SECRET });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { signedIn: false });
});

test('/me 帶有效 cookie 回 teacherId', async () => {
  const token = await signSession({ teacherId: 'sub-9', email: 'm@n.tw' }, SECRET);
  const res = await call('https://x.tw/api/auth/me', { SESSION_SECRET: SECRET }, {
    headers: { Cookie: `${SESSION_COOKIE}=${token}` },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { signedIn: true, teacherId: 'sub-9', email: 'm@n.tw' });
});

test('/logout 會把 cookie 立刻作廢', async () => {
  const res = await call('https://x.tw/api/auth/logout', {}, { method: 'POST' });
  assert.match(res.headers.get('Set-Cookie'), /cp_session=; Path=\/; Max-Age=0/);
});

/* ---- 登入後回原頁（家長是從 parent.html 進來的，不能一律丟回 /） ---- */

test('next 只接受本站相對路徑，擋掉開放轉址', async () => {
  const { safeNext } = await import('../functions/api/auth/[[route]].js');

  assert.equal(safeNext('/parent.html?t=abc'), '/parent.html?t=abc');
  assert.equal(safeNext('/'), '/');

  // 這三種都會把人導出站外，一律退回首頁。
  assert.equal(safeNext('//evil.example/phish'), '/');
  assert.equal(safeNext('https://evil.example/phish'), '/');
  assert.equal(safeNext('javascript:alert(1)'), '/');

  assert.equal(safeNext(''), '/');
  assert.equal(safeNext(null), '/');
});
