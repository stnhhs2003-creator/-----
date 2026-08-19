/*
 * 公開端 client（js/store-public.js）。
 *
 * 這一組守三件事，其他都不是這一層的責任：
 *   1. 四條路由送出去的 op 與 payload 形狀對不對
 *   2. 個人代碼**沒有**出現在網址裡（紅線，理由見 gas/Public.gs 檔頭）
 *   3. 後端的 { ok:false, error, status } 有沒有原封不動變成帶 status 的例外
 *
 * 投影（過濾／加總／判讀 kind）是 gas/Public.gs 的事，由 gas/public-selftest.mjs 驗。
 * 這裡反而要驗「client 沒有動過手腳」——後端回什麼，呼叫端就該拿到什麼。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPublicClient, PublicStoreError } from '../js/store-public.js';

const ENDPOINT = 'https://script.google.com/macros/s/FAKE/exec';

/** 錄下每一次請求，並依序吐出預先排好的信封。 */
function fakeTransport(envelopes) {
  const queue = Array.isArray(envelopes) ? [...envelopes] : [envelopes];
  const seen = [];
  const transport = async (req) => {
    seen.push(req);
    return queue.length > 1 ? queue.shift() : queue[0];
  };
  return { transport, seen };
}

function clientWith(envelopes) {
  const { transport, seen } = fakeTransport(envelopes);
  return { client: createPublicClient({ endpoint: ENDPOINT, transport }), seen };
}

const ok = (result) => ({ ok: true, result });

test('classes() 走 GET，op 放在 query string', async () => {
  const { client, seen } = clientWith(ok([{ id: 'c701', name: '七年一班' }]));
  assert.deepEqual(await client.classes(), [{ id: 'c701', name: '七年一班' }]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'GET', '班級清單不需要代碼，該走 GET');
  assert.equal(seen[0].url, `${ENDPOINT}?op=classes`);
  assert.equal(seen[0].body, undefined, 'GET 不該帶 body');
});

test('me() 走 POST，op 是 me、payload 帶 classId／no／code', async () => {
  const { client, seen } = clientWith(ok({ balance: 12 }));
  await client.me({ classId: 'c701', no: 13, code: 'A1B2' });
  assert.equal(seen[0].method, 'POST');
  assert.deepEqual(seen[0].body, {
    op: 'me',
    payload: { classId: 'c701', no: 13, code: 'A1B2' },
  });
});

test('parentView() 送的 op 是 parent-view（不是 parentView，GAS 白名單只認這個字）', async () => {
  const { client, seen } = clientWith(ok({ events: [] }));
  await client.parentView({ classId: 'c701', no: 13, code: 'P9Z8' });
  assert.equal(seen[0].method, 'POST');
  assert.deepEqual(seen[0].body, {
    op: 'parent-view',
    payload: { classId: 'c701', no: 13, code: 'P9Z8' },
  });
});

test('redeemRequest() 送的 op 是 redeem-request，payload 多一個 rewardId', async () => {
  const { client, seen } = clientWith(ok({ ok: true, name: '免寫一次作業' }));
  const got = await client.redeemRequest({ classId: 'c701', no: 13, code: 'A1B2', rewardId: 'r1' });
  assert.deepEqual(got, { ok: true, name: '免寫一次作業' });
  assert.equal(seen[0].method, 'POST');
  assert.deepEqual(seen[0].body, {
    op: 'redeem-request',
    payload: { classId: 'c701', no: 13, code: 'A1B2', rewardId: 'r1' },
  });
});

test('🚨 紅線：個人代碼一個字都不准出現在網址裡', async () => {
  // query string 會留在瀏覽器歷史、家長轉貼的截圖、Apps Script 執行紀錄裡。
  // 代碼進了那裡，等於把它印出來貼在走廊上。
  const CODE = 'SECRET-CODE-9527';
  const { client, seen } = clientWith(ok({}));

  await client.me({ classId: 'c701', no: 13, code: CODE });
  await client.parentView({ classId: 'c701', no: 13, code: CODE });
  await client.redeemRequest({ classId: 'c701', no: 13, code: CODE, rewardId: 'r1' });

  assert.equal(seen.length, 3);
  for (const req of seen) {
    assert.equal(req.method, 'POST', '帶代碼的三條一律 POST');
    assert.equal(req.url, ENDPOINT, `網址不該接任何參數，實際是 ${req.url}`);
    assert.equal(
      req.url.includes(CODE) || req.url.includes(encodeURIComponent(CODE)),
      false,
      `代碼漏進網址：${req.url}`,
    );
    assert.equal(req.url.includes('?'), false, '網址上出現 query string，代碼遲早會被塞進去');
    assert.equal(req.body.payload.code, CODE, '代碼該在 body 裡');
  }
});

test('403 / 404 / 409 / 410 各自轉成帶正確 status 的 PublicStoreError', async () => {
  const cases = [
    { status: 403, error: '座號跟代碼對不起來，再確認一次。' },
    { status: 404, error: '這項獎勵已經下架了。' },
    { status: 409, error: '點數不夠，還差 3 點。' },
    { status: 410, error: '公開班級排行已停用，以保護學生表現資料。' },
  ];

  for (const { status, error } of cases) {
    const { client } = clientWith({ ok: false, error, status });
    await assert.rejects(
      () => client.me({ classId: 'c701', no: 13, code: 'X' }),
      (err) => {
        assert.ok(err instanceof PublicStoreError, `HTTP ${status} 沒有轉成 PublicStoreError`);
        assert.equal(err.status, status, `status 沒透出來，前端就分不出「碼錯」跟「換完了」`);
        assert.equal(err.message, error, '後端寫給家長看的那句話被改掉了');
        return true;
      },
    );
  }
});

test('沒帶 status 的錯誤信封當成 500，不會變成 undefined', async () => {
  const { client } = clientWith({ ok: false, error: '爆炸了' });
  await assert.rejects(
    () => client.classes(),
    (err) => err instanceof PublicStoreError && err.status === 500,
  );
});

test('回應不是物件（GAS 吐 HTML 被上層解成 null）也丟 PublicStoreError', async () => {
  const { client } = clientWith(null);
  await assert.rejects(
    () => client.classes(),
    (err) => err instanceof PublicStoreError && err.status === 0,
  );
});

test('後端回的 events 原封不動透出，client 沒有動過手腳', async () => {
  // 投影是後端唯一的閘門。這裡若出現任何 filter／sort／加總，就變成兩個閘門，
  // 改了一邊之後兩邊會偷偷分岔。所以這裡要驗的是「一模一樣」。
  const events = [
    { id: 'e1', ts: '2026-08-01T00:00:00.000Z', behaviorId: 'b1', delta: 2, period: '', kind: 'positive', studentId: 's1', voided: false },
    { id: 'e2', ts: '2026-08-02T00:00:00.000Z', behaviorId: 'b2', delta: 1, period: '3', kind: 'positive', studentId: 's1', voided: false },
  ];
  const payload = {
    cls: { id: 'c701', name: '七年一班' },
    student: { id: 's1', no: 13, label: '您的孩子（13號）' },
    behaviors: [{ id: 'b1', label: '主動發言', icon: '🙋', kind: 'positive', delta: 2 }],
    events,
  };

  const { client } = clientWith(ok(payload));
  const got = await client.parentView({ classId: 'c701', no: 13, code: 'P9Z8' });
  assert.deepEqual(got, payload, 'client 改動了後端的回應');
  assert.equal(got.events.length, 2, '事件被 client 篩掉了');
});

test('me() 的整包回應照原樣交出去，balance 不由前端重算', async () => {
  // 紅線 3：餘額在後端算完只送一個數字。前端若自己 reduce 一次，
  // 就代表逐筆事件（含待改進）得先送到前端來——那正是這條紅線要擋的事。
  const payload = {
    cls: { id: 'c701', name: '七年一班' },
    student: { id: 's1', no: 13, label: '13號' },
    balance: 7,
    behaviors: [],
    pending: [{ id: 'p1', ts: '2026-08-03T00:00:00.000Z', name: '免寫一次作業' }],
    events: [{ id: 'e1', delta: 99, kind: 'positive', voided: false }],
  };
  const { client } = clientWith(ok(payload));
  const got = await client.me({ classId: 'c701', no: 13, code: 'A1B2' });
  assert.equal(got.balance, 7, 'balance 被前端重算了——那代表明細跑到前端來了');
  assert.deepEqual(got, payload);
});

test('沒有 endpoint 就直接丟錯，不會送出一個打到相對路徑的請求', async () => {
  let called = false;
  const client = createPublicClient({
    endpoint: '',
    transport: async () => {
      called = true;
      return ok(null);
    },
  });
  await assert.rejects(() => client.me({ classId: 'c701', no: 1, code: 'X' }), PublicStoreError);
  await assert.rejects(() => client.classes(), PublicStoreError);
  assert.equal(called, false, '端點是空的還是把代碼送出去了');
});
