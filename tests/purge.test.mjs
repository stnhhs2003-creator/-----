/*
 * 刪除與保存期限測試（個資法第 11 條第 3 項：特定目的消失應主動刪除）。
 *
 * 這一組要守住兩件互相拉扯的事：
 *   1. 撤銷（void）永遠不刪資料——那是稽核軌跡，學生才不會被隨手改分數
 *   2. 刪除（purge）要真的刪掉——不然一位學生的紀錄會跟著匯出檔留到永遠
 * 搞混任何一邊都會出事，所以兩者的界線在這裡釘死。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { expiredClasses } from '../js/rules.js';
import { handleData } from '../functions/api/data/[[route]].js';

const SCHEMA = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
const TEACHER = 't-alice';

function memoryDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return {
    raw: db,
    async execute(sql, args = []) {
      const stmt = db.prepare(sql);
      return /^\s*SELECT/i.test(sql) ? stmt.all(...args) : (stmt.run(...args), []);
    },
  };
}

function call(db, path, body, teacherId = TEACHER) {
  const req = new Request(`http://localhost/api/data${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  return handleData(req, { DEV_TEACHER_ID: teacherId }, db);
}

async function addEvent(db, { teacher = TEACHER, id, classId, studentId, voided = 0 }) {
  await db.execute(
    'INSERT INTO events (teacher_id, id, ts, class_id, student_id, behavior_id, delta, kind, period, note, voided)' +
      " VALUES (?, ?, '2026-08-01T00:00:00.000Z', ?, ?, 'b1', 2, 'positive', '', '', ?)",
    [teacher, id, classId, studentId, voided],
  );
}

const countEvents = async (db) => (await db.execute('SELECT COUNT(*) AS n FROM events', []))[0].n;

// ---- 刪一位學生 ----

test('刪一位學生：連已撤銷的那筆也一起刪，別人的一筆都不動', async () => {
  const db = memoryDb();
  await addEvent(db, { id: 'a1', classId: 'c701', studentId: 's5' });
  await addEvent(db, { id: 'a2', classId: 'c701', studentId: 's5', voided: 1 });
  await addEvent(db, { id: 'b1', classId: 'c701', studentId: 's6' });
  await addEvent(db, { id: 'c1', classId: 'c703', studentId: 's5' });

  const res = await call(db, '/purge/student', { classId: 'c701', studentId: 's5' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).deleted, 2);

  const left = await db.execute('SELECT id FROM events ORDER BY id', []);
  assert.deepEqual(left.map((r) => r.id), ['b1', 'c1']);
});

test('刪學生會一併清掉家長的查看權限', async () => {
  const db = memoryDb();
  await addEvent(db, { id: 'a1', classId: 'c701', studentId: 's5' });
  await db.execute(
    "INSERT INTO parent_bindings (teacher_id, parent_sub, student_id, class_id, email, status, created_at)" +
      " VALUES (?, 'p-mom', 's5', 'c701', 'm@x', 'approved', '2026-08-01T00:00:00.000Z')",
    [TEACHER],
  );

  await call(db, '/purge/student', { classId: 'c701', studentId: 's5' });
  const rows = await db.execute('SELECT * FROM parent_bindings', []);
  assert.equal(rows.length, 0);
});

test('刪除只碰自己的資料：別位老師同 id 的學生不受影響', async () => {
  const db = memoryDb();
  await addEvent(db, { id: 'a1', classId: 'c701', studentId: 's5' });
  await addEvent(db, { teacher: 't-bob', id: 'a1', classId: 'c701', studentId: 's5' });

  await call(db, '/purge/student', { classId: 'c701', studentId: 's5' });
  const left = await db.execute('SELECT teacher_id AS t FROM events', []);
  assert.deepEqual(left.map((r) => r.t), ['t-bob']);
});

test('沒講清楚要刪誰就不動手', async () => {
  const db = memoryDb();
  await addEvent(db, { id: 'a1', classId: 'c701', studentId: 's5' });

  assert.equal((await call(db, '/purge/student', { classId: 'c701' })).status, 400);
  assert.equal((await call(db, '/purge/student', { studentId: 's5' })).status, 400);
  assert.equal((await call(db, '/purge/class', {})).status, 400);
  assert.equal(await countEvents(db), 1);
});

test('未登入不能刪任何東西', async () => {
  const db = memoryDb();
  await addEvent(db, { id: 'a1', classId: 'c701', studentId: 's5' });

  const req = new Request('http://localhost/api/data/purge/class', {
    method: 'POST',
    body: JSON.stringify({ classId: 'c701' }),
    headers: { 'content-type': 'application/json' },
  });
  const res = await handleData(req, {}, db);
  assert.equal(res.status, 401);
  assert.equal(await countEvents(db), 1);
});

// ---- 刪整班 ----

test('刪整班：那一班全清，別班一筆不動', async () => {
  const db = memoryDb();
  await addEvent(db, { id: 'a1', classId: 'c701', studentId: 's5' });
  await addEvent(db, { id: 'a2', classId: 'c701', studentId: 's6' });
  await addEvent(db, { id: 'b1', classId: 'c703', studentId: 's1' });

  const res = await call(db, '/purge/class', { classId: 'c701' });
  assert.equal((await res.json()).deleted, 2);
  const left = await db.execute('SELECT id FROM events', []);
  assert.deepEqual(left.map((r) => r.id), ['b1']);
});

// ---- 撤銷與刪除是兩件事 ----

test('撤銷不會刪資料——這條界線不能被 purge 帶壞', async () => {
  const db = memoryDb();
  await addEvent(db, { id: 'a1', classId: 'c701', studentId: 's5' });

  const req = new Request('http://localhost/api/data/events/a1/void', { method: 'POST' });
  await handleData(req, { DEV_TEACHER_ID: TEACHER }, db);

  const rows = await db.execute('SELECT voided FROM events WHERE id = ?', ['a1']);
  assert.equal(rows.length, 1, '撤銷之後那一列必須還在');
  assert.equal(rows[0].voided, 1);
});

// ---- 保存期限 ----

const NOW = new Date('2026-08-15T00:00:00.000Z');
const CLASSES = [{ id: 'c701', name: '七年一班' }, { id: 'c900', name: '畢業班' }];

test('超過保存期限的班級會被撈出來，還在用的不會', () => {
  const events = [
    { classId: 'c701', ts: '2026-08-10T00:00:00.000Z' },
    { classId: 'c900', ts: '2025-06-30T00:00:00.000Z' },
    { classId: 'c900', ts: '2025-05-01T00:00:00.000Z' },
  ];
  const out = expiredClasses(CLASSES, events, 12, NOW);
  assert.deepEqual(out.map((x) => x.classId), ['c900']);
  assert.equal(out[0].count, 2);
  assert.equal(out[0].lastTs, '2025-06-30T00:00:00.000Z');
});

test('判準是最後一筆紀錄，不是最早那筆——還在記錄就代表目的還在', () => {
  const events = [
    { classId: 'c701', ts: '2023-01-01T00:00:00.000Z' },
    { classId: 'c701', ts: '2026-08-14T00:00:00.000Z' },
  ];
  assert.deepEqual(expiredClasses(CLASSES, events, 12, NOW), []);
});

test('完全沒有紀錄的班級不算逾期，那只是還沒開始用', () => {
  assert.deepEqual(expiredClasses(CLASSES, [], 12, NOW), []);
});

test('保存期限沒設定或設成 0 時不提醒，但也絕不會自作主張刪東西', () => {
  const events = [{ classId: 'c900', ts: '2000-01-01T00:00:00.000Z' }];
  assert.deepEqual(expiredClasses(CLASSES, events, 0, NOW), []);
  assert.deepEqual(expiredClasses(CLASSES, events, undefined, NOW), []);
});
