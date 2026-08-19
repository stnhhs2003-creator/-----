/*
 * CloudStore + 資料 API 測試。
 *
 * 完全不打網路：假 fetch 把請求直接餵給 handleData，
 * handleData 背後接的是一顆用 db/schema.sql 建起來的記憶體 SQLite。
 * 這樣測到的是「真的 SQL 跑得起來、篩選真的下推」，而不是「我以為我組對了字串」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { LocalStore } from '../js/store.js';
import { CloudStore, CloudStoreError } from '../js/store-cloud.js';
import { handleData, eventsQuery, rowToEvent } from '../functions/api/data/[[route]].js';

const SCHEMA = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

/** 記憶體資料庫，介面跟 tursoClient 一樣是 execute(sql, args) -> rows[]。 */
function memoryDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const log = [];
  return {
    log,
    raw: db,
    async execute(sql, args = []) {
      log.push({ sql, args });
      const stmt = db.prepare(sql);
      return /^\s*SELECT/i.test(sql) ? stmt.all(...args) : (stmt.run(...args), []);
    },
  };
}

/** 把 CloudStore 接到記憶體後端上；回傳還原 fetch 的函式。 */
function mount({ teacherId = 't-alice', db = memoryDb(), fail = null } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async (path, init = {}) => {
    if (fail) throw new TypeError(fail);
    const req = new Request(`http://localhost${path}`, init);
    return handleData(req, { DEV_TEACHER_ID: teacherId }, db);
  };
  return { db, restore: () => { globalThis.fetch = original; } };
}

const behavior = { classId: 'c701', studentId: 's01', behaviorId: 'b-speak', delta: 2, kind: 'positive' };

// ---- 介面契約 ----

test('CloudStore 與 LocalStore 的方法名稱與簽名完全一致', () => {
  const shape = (o) =>
    Object.keys(o)
      .sort()
      .map((k) => `${k}:${typeof o[k] === 'function' ? `fn/${o[k].length}` : typeof o[k]}`);

  assert.deepEqual(shape(CloudStore), shape(LocalStore));

  // 契約文件列的十四個方法一個都不能少。
  const required = [
    'init', 'appendEvent', 'voidEvent', 'queryEvents',
    'getClasses', 'saveClasses', 'getBehaviors', 'saveBehaviors',
    'getRewards', 'saveRewards', 'getSettings', 'saveSettings',
    'exportAll', 'resetAll',
  ];
  for (const m of required) {
    assert.equal(typeof CloudStore[m], 'function', `CloudStore 缺少 ${m}`);
  }
});

test('每個方法都回傳 Promise（上層一律 await）', async () => {
  const { restore } = mount();
  try {
    const p = CloudStore.getClasses();
    assert.ok(p instanceof Promise);
    await p;
  } finally {
    restore();
  }
});

// ---- SQL 下推 ----

test('queryEvents 的篩選全部進 WHERE，不是撈回來再過濾', () => {
  const { sql, args } = eventsQuery('t-alice', {
    classId: 'c701', studentId: 's01', since: '2026-01-01', until: '2026-02-01',
  });
  assert.match(sql, /WHERE teacher_id = \? AND voided = 0 AND class_id = \? AND student_id = \? AND ts >= \? AND ts <= \?/);
  assert.deepEqual(args, ['t-alice', 'c701', 's01', '2026-01-01', '2026-02-01']);
  assert.match(sql, /ORDER BY ts ASC, id ASC/);
});

test('includeVoided 時才不加 voided 條件；teacher_id 永遠是第一個條件', () => {
  const a = eventsQuery('t-alice', { includeVoided: true });
  assert.doesNotMatch(a.sql, /voided = 0/);
  assert.deepEqual(a.args, ['t-alice']);

  const b = eventsQuery('t-alice', {});
  assert.match(b.sql, /voided = 0/);
  assert.match(b.sql, /WHERE teacher_id = \?/);
});

test('rowToEvent 把 SQLite 的 0/1 還原成布林，未撤銷不帶 voidedAt', () => {
  const live = rowToEvent({ id: 'e1', ts: 'T', kind: 'positive', delta: 2, voided: 0, voidedAt: null });
  assert.equal(live.voided, false);
  assert.equal('voidedAt' in live, false);

  const dead = rowToEvent({ id: 'e1', ts: 'T', kind: 'positive', delta: 2, voided: 1, voidedAt: 'T2' });
  assert.equal(dead.voided, true);
  assert.equal(dead.voidedAt, 'T2');
});

// ---- 端到端行為 ----

test('appendEvent 產生的事件欄位與 LocalStore 一致', async () => {
  const { restore } = mount();
  try {
    const evt = await CloudStore.appendEvent({ ...behavior, note: '上課主動舉手' });
    assert.deepEqual(
      Object.keys(evt).sort(),
      ['behaviorId', 'classId', 'delta', 'id', 'kind', 'note', 'period', 'studentId', 'ts', 'voided'],
    );
    assert.equal(evt.voided, false);
    assert.equal(evt.delta, 2);
    assert.equal(evt.period, '');
    assert.ok(!Number.isNaN(Date.parse(evt.ts)));
  } finally {
    restore();
  }
});

test('queryEvents 依 classId／studentId／時間區間篩選', async () => {
  const { restore } = mount();
  try {
    await CloudStore.appendEvent({ ...behavior });
    await CloudStore.appendEvent({ ...behavior, studentId: 's02' });
    await CloudStore.appendEvent({ ...behavior, classId: 'c702', studentId: 's09' });

    assert.equal((await CloudStore.queryEvents()).length, 3);
    assert.equal((await CloudStore.queryEvents({ classId: 'c701' })).length, 2);
    assert.equal((await CloudStore.queryEvents({ studentId: 's02' })).length, 1);
    assert.equal((await CloudStore.queryEvents({ since: '2999-01-01' })).length, 0);
    assert.equal((await CloudStore.queryEvents({ until: '1999-01-01' })).length, 0);
  } finally {
    restore();
  }
});

test('voidEvent 只標記不刪除：資料庫那一列還在，稽核查得到', async () => {
  const { db, restore } = mount();
  try {
    const evt = await CloudStore.appendEvent({ ...behavior });
    const voided = await CloudStore.voidEvent(evt.id);

    assert.equal(voided.voided, true);
    assert.ok(voided.voidedAt, '撤銷要留時間戳');

    // 預設查詢看不到，帶 includeVoided 就查得到。
    assert.equal((await CloudStore.queryEvents()).length, 0);
    const all = await CloudStore.queryEvents({ includeVoided: true });
    assert.equal(all.length, 1);
    assert.equal(all[0].id, evt.id);

    // 直接看資料庫：列數沒少，而且沒有任何 DELETE 打進去。
    const rows = db.raw.prepare('SELECT COUNT(*) AS n FROM events').all();
    assert.equal(rows[0].n, 1);
    assert.equal(db.log.some((q) => /DELETE\s+FROM\s+events/i.test(q.sql)), false);
  } finally {
    restore();
  }
});

test('事件流只 append：撤銷後再記一筆，舊那筆原封不動', async () => {
  const { restore } = mount();
  try {
    const first = await CloudStore.appendEvent({ ...behavior });
    await CloudStore.voidEvent(first.id);
    await CloudStore.appendEvent({ ...behavior, delta: 3 });

    const all = await CloudStore.queryEvents({ includeVoided: true });
    assert.equal(all.length, 2);
    assert.equal(all.find((e) => e.id === first.id).delta, 2);
  } finally {
    restore();
  }
});

test('teacherId 隔離：換一位老師看不到別人的資料', async () => {
  const db = memoryDb();
  let m = mount({ teacherId: 't-alice', db });
  await CloudStore.appendEvent({ ...behavior });
  await CloudStore.saveClasses([{ id: 'c701', name: '七年一班' }]);
  m.restore();

  m = mount({ teacherId: 't-bob', db });
  try {
    assert.deepEqual(await CloudStore.queryEvents(), []);
    assert.deepEqual(await CloudStore.getClasses(), []);
    await CloudStore.appendEvent({ ...behavior, studentId: 's99' });
    assert.equal((await CloudStore.queryEvents()).length, 1);
  } finally {
    m.restore();
  }

  m = mount({ teacherId: 't-alice', db });
  try {
    const mine = await CloudStore.queryEvents();
    assert.equal(mine.length, 1);
    assert.equal(mine[0].studentId, 's01');
  } finally {
    m.restore();
  }
});

test('設定類資料整包讀寫，未寫入前給空值不是 undefined', async () => {
  const { restore } = mount();
  try {
    assert.deepEqual(await CloudStore.getClasses(), []);
    assert.deepEqual(await CloudStore.getBehaviors(), []);
    assert.deepEqual(await CloudStore.getRewards(), []);
    assert.deepEqual(await CloudStore.getSettings(), {});

    await CloudStore.saveBehaviors([{ id: 'b-speak', delta: 2 }]);
    await CloudStore.saveSettings({ theme: 'warm' });
    assert.deepEqual(await CloudStore.getBehaviors(), [{ id: 'b-speak', delta: 2 }]);
    assert.deepEqual(await CloudStore.getSettings(), { theme: 'warm' });

    // 重複寫入是覆蓋不是長出第二列。
    await CloudStore.saveSettings({ theme: 'cool' });
    assert.deepEqual(await CloudStore.getSettings(), { theme: 'cool' });
  } finally {
    restore();
  }
});

test('init 只補沒有的東西，不覆蓋老師既有資料', async () => {
  const { restore } = mount();
  try {
    await CloudStore.saveClasses([{ id: 'c701', name: '我自己建的' }]);
    await CloudStore.init({ classes: [{ id: 'demo', name: '示範班' }], behaviors: [{ id: 'b1' }], settings: { a: 1 } });

    assert.deepEqual(await CloudStore.getClasses(), [{ id: 'c701', name: '我自己建的' }]);
    assert.deepEqual(await CloudStore.getBehaviors(), [{ id: 'b1' }]);
  } finally {
    restore();
  }
});

test('exportAll 的欄位與 LocalStore 相同，且含已撤銷事件', async () => {
  const { restore } = mount();
  try {
    const evt = await CloudStore.appendEvent({ ...behavior });
    await CloudStore.voidEvent(evt.id);
    const dump = await CloudStore.exportAll();

    assert.deepEqual(
      Object.keys(dump).sort(),
      ['behaviors', 'classes', 'events', 'exportedAt', 'rewards', 'settings'],
    );
    assert.equal(dump.events.length, 1);
    assert.equal(dump.events[0].voided, true);
  } finally {
    restore();
  }
});

test('resetAll 只清自己的資料', async () => {
  const db = memoryDb();
  let m = mount({ teacherId: 't-bob', db });
  await CloudStore.appendEvent({ ...behavior, studentId: 's99' });
  m.restore();

  m = mount({ teacherId: 't-alice', db });
  await CloudStore.appendEvent({ ...behavior });
  await CloudStore.resetAll();
  try {
    assert.deepEqual(await CloudStore.queryEvents(), []);
  } finally {
    m.restore();
  }

  m = mount({ teacherId: 't-bob', db });
  try {
    assert.equal((await CloudStore.queryEvents()).length, 1);
  } finally {
    m.restore();
  }
});

// ---- 失敗要看得見 ----

test('未登入回 401，而且是丟出來不是靜默回空陣列', async () => {
  const original = globalThis.fetch;
  const db = memoryDb();
  // 沒設 DEV_TEACHER_ID：session stub 會擋下來。
  globalThis.fetch = async (path, init = {}) =>
    handleData(new Request(`http://localhost${path}`, init), {}, db);
  try {
    await assert.rejects(
      () => CloudStore.queryEvents(),
      (err) => err instanceof CloudStoreError && err.status === 401,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('斷線時 appendEvent 丟錯，不會假裝記到了', async () => {
  const { restore } = mount({ fail: 'Failed to fetch' });
  try {
    await assert.rejects(
      () => CloudStore.appendEvent({ ...behavior }),
      (err) => err instanceof CloudStoreError && err.status === 0 && /連不上/.test(err.message),
    );
  } finally {
    restore();
  }
});

test('資料庫爆炸時回 500 並帶錯誤訊息', async () => {
  const original = globalThis.fetch;
  const broken = { async execute() { throw new Error('資料庫連線中斷'); } };
  globalThis.fetch = async (path, init = {}) =>
    handleData(new Request(`http://localhost${path}`, init), { DEV_TEACHER_ID: 't-alice' }, broken);
  try {
    await assert.rejects(
      () => CloudStore.queryEvents(),
      (err) => err.status === 500 && /資料庫連線中斷/.test(err.message),
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('不認得的路徑回 404，不會被當成成功', async () => {
  const db = memoryDb();
  const res = await handleData(
    new Request('http://localhost/api/data/nope'),
    { DEV_TEACHER_ID: 't-alice' },
    db,
  );
  assert.equal(res.status, 404);
});

test('回應帶 no-store，老師的資料不留在快取裡', async () => {
  const db = memoryDb();
  const res = await handleData(
    new Request('http://localhost/api/data/events'),
    { DEV_TEACHER_ID: 't-alice' },
    db,
  );
  assert.equal(res.headers.get('cache-control'), 'no-store');
});
