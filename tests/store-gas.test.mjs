/*
 * GasStore 測試。完全不打網路：傳輸層用假的注入進去，只驗兩件事——
 *
 *   1. 介面形狀跟 LocalStore 一模一樣。這是「換儲存層不會炸掉上層」的唯一保證：
 *      六個頁面都只認 store-select.js 給的那個物件，少一個方法就是線上壞掉。
 *   2. 送出去的 payload 形狀正確。GAS 端讀的是這些欄位名，錯一個字就查無資料，
 *      而且不會噴錯——只會安靜地回空陣列，那比噴錯難查十倍。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { LocalStore } from '../js/store.js';
import { createGasStore, GasStore, GasStoreError, fetchTransport } from '../js/store-gas.js';

/** 錄下每一次 RPC；reply 決定回什麼結果。 */
function recorder(reply = () => ({})) {
  const calls = [];
  const transport = async (req) => {
    calls.push(req);
    return reply(req);
  };
  return { calls, transport, store: createGasStore({ transport }) };
}

const behavior = {
  classId: 'c701',
  studentId: 's01',
  behaviorId: 'b-speak',
  delta: 2,
  kind: 'positive',
  period: '第三節',
  note: '',
};

// ---- 介面契約 ----

test('GasStore 與 LocalStore 的方法名稱與簽名完全一致', () => {
  const shape = (o) =>
    Object.keys(o)
      .sort()
      .map((k) => `${k}:${typeof o[k] === 'function' ? `fn/${o[k].length}` : typeof o[k]}`);

  assert.deepEqual(shape(GasStore), shape(LocalStore));
  assert.deepEqual(shape(createGasStore({ transport: async () => ({}) })), shape(LocalStore));

  // 契約文件列的方法一個都不能少。
  const required = [
    'init', 'appendEvent', 'voidEvent', 'queryEvents',
    'getClasses', 'saveClasses', 'getBehaviors', 'saveBehaviors',
    'getRewards', 'saveRewards', 'getSettings', 'saveSettings',
    'exportAll', 'importAll', 'purgeStudent', 'purgeClass', 'resetAll',
  ];
  for (const m of required) {
    assert.equal(typeof GasStore[m], 'function', `GasStore 缺少 ${m}`);
  }
});

test('注入的 endpoint 與 transport 不會變成物件上的屬性', () => {
  // 掛成屬性的話，上面那條 deepEqual 就會紅——這條是把理由寫下來，避免有人「順手」加回去。
  const { store } = recorder();
  assert.equal(store.endpoint, undefined);
  assert.equal(store.transport, undefined);
});

// ---- payload 形狀 ----

test('appendEvent 把七個欄位原樣送出，不自己編分數；另外附一個前端產的 id', async () => {
  const { calls, store } = recorder((req) => ({ ...req.payload }));
  await store.appendEvent(behavior);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].op, 'appendEvent');
  assert.deepEqual(Object.keys(calls[0].payload).sort(), [
    'behaviorId', 'classId', 'delta', 'id', 'kind', 'note', 'period', 'studentId',
  ]);
  const { id, ...rest } = calls[0].payload;
  assert.deepEqual(rest, behavior);
  assert.equal(typeof id, 'string');
  assert.ok(id.length >= 8, 'id 太短，撞號機率會變高');
  // ts 不由前端決定：時間要有單一來源（GAS 的 nowISO），不能讓各裝置的時鐘各說各話。
  assert.equal('ts' in calls[0].payload, false);
});

test('每次 appendEvent 的 id 都不同，才擋得住「同一筆重送」以外的情況', async () => {
  const { calls, store } = recorder(() => ({}));
  for (let i = 0; i < 50; i++) await store.appendEvent(behavior);
  const ids = new Set(calls.map((c) => c.payload.id));
  assert.equal(ids.size, 50);
});

test('voidEvent 送 id，不送整包事件', async () => {
  const { calls, store } = recorder();
  await store.voidEvent('e-123');
  assert.deepEqual(calls[0], { op: 'voidEvent', payload: { id: 'e-123' } });
});

test('queryEvents 的篩選條件全部下推給 GAS，includeVoided 預設 false', async () => {
  const { calls, store } = recorder(() => []);

  await store.queryEvents();
  assert.equal(calls[0].op, 'queryEvents');
  assert.equal(calls[0].payload.includeVoided, false);

  await store.queryEvents({ classId: 'c701', studentId: 's01', since: '2026-08-01', until: '2026-08-31', includeVoided: true });
  assert.deepEqual(calls[1].payload, {
    classId: 'c701',
    studentId: 's01',
    since: '2026-08-01',
    until: '2026-08-31',
    includeVoided: true,
  });
});

test('四包設定共用 getDoc／saveDoc，name 各自對上', async () => {
  const { calls, store } = recorder(() => []);
  await store.getClasses();
  await store.getBehaviors();
  await store.getRewards();
  await store.getSettings();
  assert.deepEqual(
    calls.map((c) => [c.op, c.payload.name]),
    [
      ['getDoc', 'classes'],
      ['getDoc', 'behaviors'],
      ['getDoc', 'rewards'],
      ['getDoc', 'settings'],
    ],
  );

  calls.length = 0;
  await store.saveClasses([{ id: 'c701' }]);
  await store.saveSettings({ retentionMonths: 12 });
  assert.deepEqual(calls[0], { op: 'saveDoc', payload: { name: 'classes', value: [{ id: 'c701' }] } });
  assert.deepEqual(calls[1], { op: 'saveDoc', payload: { name: 'settings', value: { retentionMonths: 12 } } });
});

test('purge 兩支各自帶足夠的範圍，importAll 整包塞在 payload 底下', async () => {
  const { calls, store } = recorder(() => ({ deleted: 3 }));

  const a = await store.purgeStudent({ classId: 'c701', studentId: 's01' });
  assert.deepEqual(calls[0], { op: 'purgeStudent', payload: { classId: 'c701', studentId: 's01' } });
  assert.deepEqual(a, { deleted: 3 });

  await store.purgeClass('c701');
  assert.deepEqual(calls[1], { op: 'purgeClass', payload: { classId: 'c701' } });

  const dump = { classes: [], behaviors: [], rewards: [], events: [{ id: 'e1' }], settings: {} };
  await store.importAll(dump);
  assert.deepEqual(calls[2], { op: 'importAll', payload: { payload: dump } });
});

test('init／exportAll／resetAll 的 op 名稱固定', async () => {
  const { calls, store } = recorder(() => ({}));
  await store.init({ classes: [] });
  await store.exportAll();
  await store.resetAll();
  assert.deepEqual(calls.map((c) => c.op), ['init', 'exportAll', 'resetAll']);
  assert.deepEqual(calls[0].payload, { seed: { classes: [] } });
});

// ---- 錯誤處理（不吞） ----

test('GAS 回 ok:false 時翻成 GasStoreError，而不是安靜地回 undefined', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: false, error: '要刪哪一班沒講清楚，不動手。', status: 400 }), {
      status: 200,
    });
  try {
    const store = createGasStore({ transport: fetchTransport('https://example.test/exec') });
    await assert.rejects(() => store.purgeClass(''), (err) => {
      assert.ok(err instanceof GasStoreError);
      assert.equal(err.status, 400);
      assert.match(err.message, /不動手/);
      return true;
    });
  } finally {
    globalThis.fetch = original;
  }
});

test('GAS 吐 HTML（部署權限或網址不對）時給看得懂的錯，不是 JSON parse 爆掉', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('<!DOCTYPE html><title>登入</title>', { status: 200 });
  try {
    const store = createGasStore({ transport: fetchTransport('https://example.test/exec') });
    await assert.rejects(() => store.getClasses(), (err) => {
      assert.ok(err instanceof GasStoreError);
      assert.match(err.message, /不是 JSON/);
      return true;
    });
  } finally {
    globalThis.fetch = original;
  }
});

test('連不上時 status 為 0，呼叫端分得出「沒網路」和「伺服器說不行」', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  try {
    const store = createGasStore({ transport: fetchTransport('https://example.test/exec') });
    await assert.rejects(() => store.getClasses(), (err) => {
      assert.equal(err.status, 0);
      return true;
    });
  } finally {
    globalThis.fetch = original;
  }
});

test('POST 用 text/plain 避開 CORS 預檢，body 是 JSON 字串', async () => {
  const original = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
  };
  try {
    const store = createGasStore({ transport: fetchTransport('https://example.test/exec') });
    await store.getBehaviors();
    assert.equal(seen.init.method, 'POST');
    // 這一行改成 application/json 就會觸發預檢，GAS 不處理 OPTIONS，整條線會死。
    assert.equal(seen.init.headers['content-type'], 'text/plain;charset=utf-8');
    assert.equal(seen.init.credentials, 'omit');
    assert.deepEqual(JSON.parse(seen.init.body), { op: 'getDoc', payload: { name: 'behaviors' } });
  } finally {
    globalThis.fetch = original;
  }
});
