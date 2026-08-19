/*
 * Apps Script 管理端的 ID token 驗證（前端這半邊）。
 *
 * 這一層是被實測逼出來的：管理端部署權限原本是「只有我自己」，
 * 想靠 Google 的登入牆當門鎖，結果瀏覽器根本連不上（CORS，見 gas/Auth.gs 檔頭）。
 * 權限改成「任何人」之後，門鎖就只剩下「每一次 RPC 都附一枚 ID token」這件事——
 * 所以這組測試守的是「附了沒」與「過期了會不會自己換一枚」。
 *
 * 真正的驗證在 Apps Script 端（gas/Auth.gs，由 gas/selftest.mjs 跑）。
 * 這裡驗的是前端有沒有把 token 送出去、以及 401 的處理有沒有變成無限迴圈。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { withAuth, GasStoreError, createGasStore } from '../js/store-gas.js';
import { decodeJwt, isFresh } from '../js/gas-auth.js';

/** 組一枚形狀正確的假 JWT。簽章是假的——前端本來就不驗簽，驗簽在 GAS 端。 */
function fakeJwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256' })}.${b64(payload)}.sig`;
}

const HOUR = 3600;
const nowSec = () => Math.floor(Date.now() / 1000);

test('decodeJwt 讀得出 payload，壞掉的字串回 null 而不是丟例外', () => {
  assert.equal(decodeJwt(fakeJwt({ email: 'teacher@example.com' })).email, 'teacher@example.com');
  assert.equal(decodeJwt('不是一枚 JWT'), null);
  assert.equal(decodeJwt(''), null);
  assert.equal(decodeJwt(undefined), null);
});

test('decodeJwt 讀得出中文與非 ASCII 內容', () => {
  // Google 的 name 欄位會是使用者的顯示名稱，很可能是中文。
  // base64 解出來是 binary string，沒有做 UTF-8 還原的話這裡會是亂碼。
  assert.equal(decodeJwt(fakeJwt({ name: '陳乃誠' })).name, '陳乃誠');
});

test('快到期的 token 提早當成過期，免得送到 Google 手上剛好失效', () => {
  assert.ok(isFresh(fakeJwt({ exp: nowSec() + HOUR })), '還有一小時卻判定過期');
  assert.equal(isFresh(fakeJwt({ exp: nowSec() + 30 })), false, '只剩 30 秒還敢送出去');
  assert.equal(isFresh(fakeJwt({ exp: nowSec() - 10 })), false);
  assert.equal(isFresh(fakeJwt({ sub: '沒有 exp' })), false, '沒有 exp 就不該當成有效');
});

test('每一次 RPC 都附上 idToken，而且不動到原本的 op／payload', async () => {
  const seen = [];
  const send = withAuth(
    async (req) => {
      seen.push(req);
      return 'ok';
    },
    { getToken: async () => 'T1' },
  );

  await send({ op: 'saveDoc', payload: { name: 'classes' } });
  assert.deepEqual(seen, [{ op: 'saveDoc', payload: { name: 'classes' }, idToken: 'T1' }]);
});

test('401 會換一枚 token 重試一次，並且先清掉舊的', async () => {
  const tokens = ['過期的', '新的'];
  const seen = [];
  let cleared = 0;

  const send = withAuth(
    async (req) => {
      seen.push(req.idToken);
      if (req.idToken === '過期的') throw new GasStoreError('沒有權限。', 401);
      return '成功';
    },
    { getToken: async () => tokens.shift(), onAuthFail: () => { cleared++; } },
  );

  assert.equal(await send({ op: 'getDoc', payload: {} }), '成功');
  assert.deepEqual(seen, ['過期的', '新的']);
  assert.equal(cleared, 1, '沒有清掉過期的 token，下一次還是會拿到同一枚');
});

test('重試之後還是 401 就往上丟，不無限重試', async () => {
  let calls = 0;
  const send = withAuth(
    async () => {
      calls++;
      throw new GasStoreError('沒有權限。請重新登入這個班級積分堂。', 401);
    },
    { getToken: async () => 'T', onAuthFail: () => {} },
  );

  await assert.rejects(() => send({ op: 'resetAll', payload: {} }), /沒有權限/);
  assert.equal(calls, 2, '重試次數不對——超過一次會讓老師連續看到好幾個登入框');
});

test('不是 401 的錯誤不重試，也不會被誤判成登入問題', async () => {
  for (const status of [0, 404, 409, 500]) {
    let calls = 0;
    const send = withAuth(
      async () => {
        calls++;
        throw new GasStoreError('這份名冊已經被另一個分頁存過一次了', status);
      },
      { getToken: async () => 'T', onAuthFail: () => assert.fail(`HTTP ${status} 被當成登入失敗`) },
    );
    await assert.rejects(() => send({ op: 'saveDoc', payload: {} }), /另一個分頁/);
    assert.equal(calls, 1, `HTTP ${status} 不該重試`);
  }
});

test('沒給 getToken 就不套驗證層——測試與離線自測走的是這條路', async () => {
  const seen = [];
  const store = createGasStore({
    transport: async (req) => {
      seen.push(req);
      return [];
    },
  });
  await store.getBehaviors();
  assert.equal('idToken' in seen[0], false, '注入 transport 的情境不該憑空多一個 idToken 欄位');
});
