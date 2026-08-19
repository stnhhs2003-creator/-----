/*
 * 家長綁定 API 測試。
 *
 * 這一組守的是一句話：**改網址繞不過去**。
 * 舊的家長端只要把 ?s=c701-s5 改成 -s6 就看得到隔壁同學，
 * 所以這裡最重要的幾條，全部是「拿著合法的登入去要別人的資料」會不會被擋。
 *
 * 跟 store-cloud 那組一樣不打網路：直接把 Request 餵給 handleParent，
 * 後面接一顆用 db/schema.sql 建起來的記憶體 SQLite——測到的是真的 SQL。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { handleParent, codeMatches, findStudent } from '../functions/api/parent/[[route]].js';
import { writeDoc } from '../functions/api/data/[[route]].js';

const SCHEMA = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

const TEACHER = 't-alice';
const PUBLIC_ID = 'abc123xyz9';

const CLASSES = [
  {
    id: 'c701',
    name: '七年一班',
    students: [
      { id: 'c701-s5', no: 5, name: '張耘睿' },
      { id: 'c701-s6', no: 6, name: '黃詩涵' },
    ],
  },
];

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

async function seed() {
  const db = memoryDb();
  await writeDoc(db, TEACHER, 'classes', CLASSES);
  await writeDoc(db, TEACHER, 'settings', { parentCode: '1150818' });
  await writeDoc(db, TEACHER, 'behaviors', [{ id: 'b-speak', label: '主動發言', icon: '🙋', kind: 'positive' }]);
  await db.execute(
    'INSERT INTO teacher_public (public_id, teacher_id, created_at) VALUES (?, ?, ?)',
    [PUBLIC_ID, TEACHER, '2026-08-15T00:00:00.000Z'],
  );
  return db;
}

async function addEvent(db, { id, studentId, kind, delta, voided = 0 }) {
  await db.execute(
    'INSERT INTO events (teacher_id, id, ts, class_id, student_id, behavior_id, delta, kind, period, note, voided)' +
      " VALUES (?, ?, ?, 'c701', ?, 'b-speak', ?, ?, '第2節', '', ?)",
    [TEACHER, id, `2026-08-1${id.length}T01:00:00.000Z`, studentId, delta, kind, voided],
  );
}

/** parentSub 用 DEV_TEACHER_ID 灌進去——那是 session 層唯一的注入點。 */
function call(db, { path, method = 'GET', sub = null, body = null }) {
  const req = new Request(`http://localhost/api/parent${path}`, {
    method,
    ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
  return handleParent(req, sub ? { DEV_TEACHER_ID: sub } : {}, db);
}

async function bind(db, sub, { no, name, code = '1150818' }) {
  return call(db, {
    path: `/request?t=${PUBLIC_ID}`,
    method: 'POST',
    sub,
    body: { code, no, name },
  });
}

async function approve(db, sub, studentId, status = 'approved') {
  return call(db, {
    path: '/admin/decide',
    method: 'POST',
    sub: TEACHER,
    body: { parentSub: sub, studentId, status },
  });
}

// ---- 通過碼 ----

test('通過碼比對會吃掉空白與全形數字——家長是從 LINE 貼過來的', () => {
  assert.ok(codeMatches('1150818', '1150818'));
  assert.ok(codeMatches(' 1150818 ', '1150818'));
  assert.ok(codeMatches('１１５０８１８', '1150818'));
  assert.ok(!codeMatches('1150819', '1150818'));
});

test('老師沒設通過碼時，任何輸入都不通過（含空字串）', () => {
  assert.ok(!codeMatches('', ''));
  assert.ok(!codeMatches('1150818', ''));
  assert.ok(!codeMatches('', undefined));
});

test('座號對但姓名不對就找不到人——只憑座號等於讓人一號一號試過去', () => {
  assert.ok(findStudent(CLASSES, { no: 5, name: '張耘睿' }));
  assert.equal(findStudent(CLASSES, { no: 5, name: '黃詩涵' }), null);
  assert.equal(findStudent(CLASSES, { no: 99, name: '張耘睿' }), null);
});

// ---- 申請 ----

test('沒登入就送申請：401，而且資料庫裡不會多出任何一筆綁定', async () => {
  const db = await seed();
  const res = await bind(db, null, { no: 5, name: '張耘睿' });
  assert.equal(res.status, 401);
  const rows = await db.execute('SELECT * FROM parent_bindings', []);
  assert.equal(rows.length, 0);
});

test('通過碼錯：403，不會產生綁定', async () => {
  const db = await seed();
  const res = await bind(db, 'p-mom', { no: 5, name: '張耘睿', code: '0000000' });
  assert.equal(res.status, 403);
  const rows = await db.execute('SELECT * FROM parent_bindings', []);
  assert.equal(rows.length, 0);
});

test('通過碼對但姓名對不上：404，不會產生綁定', async () => {
  const db = await seed();
  const res = await bind(db, 'p-mom', { no: 5, name: '王小明' });
  assert.equal(res.status, 404);
  const rows = await db.execute('SELECT * FROM parent_bindings', []);
  assert.equal(rows.length, 0);
});

test('通過碼與座號姓名都對：產生 pending，不是直接放行', async () => {
  const db = await seed();
  const res = await bind(db, 'p-mom', { no: 5, name: '張耘睿' });
  assert.equal(res.status, 200);
  const rows = await db.execute('SELECT status, student_id AS s FROM parent_bindings', []);
  assert.deepEqual(rows.map((r) => ({ status: r.status, s: r.s })), [{ status: 'pending', s: 'c701-s5' }]);
});

// ---- 檢視權限：這一段是這支 API 存在的理由 ----

test('pending 狀態看不到任何東西', async () => {
  const db = await seed();
  await bind(db, 'p-mom', { no: 5, name: '張耘睿' });
  const res = await call(db, { path: `/view?t=${PUBLIC_ID}&s=c701-s5`, sub: 'p-mom' });
  assert.equal(res.status, 403);
});

test('核可之後才看得到，而且只看得到正向、未撤銷的紀錄', async () => {
  const db = await seed();
  await addEvent(db, { id: 'e1', studentId: 'c701-s5', kind: 'positive', delta: 2 });
  await addEvent(db, { id: 'e22', studentId: 'c701-s5', kind: 'improve', delta: -1 });
  await addEvent(db, { id: 'e333', studentId: 'c701-s5', kind: 'positive', delta: 3, voided: 1 });
  await addEvent(db, { id: 'e4444', studentId: 'c701-s5', kind: 'redeem', delta: -8 });

  await bind(db, 'p-mom', { no: 5, name: '張耘睿' });
  await approve(db, 'p-mom', 'c701-s5');

  const res = await call(db, { path: `/view?t=${PUBLIC_ID}&s=c701-s5`, sub: 'p-mom' });
  assert.equal(res.status, 200);
  const data = await res.json();

  assert.equal(data.student.name, '張耘睿');
  assert.deepEqual(data.events.map((e) => e.id), ['e1']);
  assert.ok(data.events.every((e) => e.kind === 'positive'));
  assert.ok(!JSON.stringify(data).includes('improve'));
  assert.ok(!JSON.stringify(data).includes('redeem'));
});

test('改網址要別人的孩子：核可的是 s5，去要 s6 一樣 403', async () => {
  const db = await seed();
  await addEvent(db, { id: 'e1', studentId: 'c701-s6', kind: 'positive', delta: 2 });
  await bind(db, 'p-mom', { no: 5, name: '張耘睿' });
  await approve(db, 'p-mom', 'c701-s5');

  const res = await call(db, { path: `/view?t=${PUBLIC_ID}&s=c701-s6`, sub: 'p-mom' });
  assert.equal(res.status, 403);
  assert.ok(!JSON.stringify(await res.json()).includes('黃詩涵'));
});

test('別人的 Google 帳號帶著同一個連結，什麼都拿不到', async () => {
  const db = await seed();
  await bind(db, 'p-mom', { no: 5, name: '張耘睿' });
  await approve(db, 'p-mom', 'c701-s5');

  const res = await call(db, { path: `/view?t=${PUBLIC_ID}&s=c701-s5`, sub: 'p-stranger' });
  assert.equal(res.status, 403);
});

test('老師撤銷之後立刻失效', async () => {
  const db = await seed();
  await bind(db, 'p-mom', { no: 5, name: '張耘睿' });
  await approve(db, 'p-mom', 'c701-s5');
  assert.equal((await call(db, { path: `/view?t=${PUBLIC_ID}&s=c701-s5`, sub: 'p-mom' })).status, 200);

  await approve(db, 'p-mom', 'c701-s5', 'revoked');
  assert.equal((await call(db, { path: `/view?t=${PUBLIC_ID}&s=c701-s5`, sub: 'p-mom' })).status, 403);
});

test('重送申請不會把已核可的那筆打回 pending', async () => {
  const db = await seed();
  await bind(db, 'p-mom', { no: 5, name: '張耘睿' });
  await approve(db, 'p-mom', 'c701-s5');
  await bind(db, 'p-mom', { no: 5, name: '張耘睿' });

  const rows = await db.execute('SELECT status FROM parent_bindings', []);
  assert.deepEqual(rows.map((r) => r.status), ['approved']);
});

// ---- 老師後台 ----

test('後台要老師登入，家長帳號打不開', async () => {
  const db = await seed();
  await bind(db, 'p-mom', { no: 5, name: '張耘睿' });

  const asParent = await call(db, { path: '/admin/bindings', sub: 'p-mom' });
  const data = await asParent.json();
  // 家長帳號查到的是「自己那一份」，看不到別的老師的班級名單。
  assert.deepEqual(data.bindings, []);

  const asTeacher = await call(db, { path: '/admin/bindings', sub: TEACHER });
  assert.equal((await asTeacher.json()).bindings.length, 1);
});

test('未登入開後台：401', async () => {
  const db = await seed();
  assert.equal((await call(db, { path: '/admin/bindings' })).status, 401);
});

test('後台不接受不認得的處理結果，也不能把人改回 pending', async () => {
  const db = await seed();
  await bind(db, 'p-mom', { no: 5, name: '張耘睿' });
  assert.equal((await approve(db, 'p-mom', 'c701-s5', 'ok')).status, 400);
  assert.equal((await approve(db, 'p-mom', 'c701-s5', 'pending')).status, 400);
});

test('家長連結的公開代號認不出來就什麼都不給', async () => {
  const db = await seed();
  const res = await call(db, { path: '/view?t=nope&s=c701-s5', sub: 'p-mom' });
  assert.equal(res.status, 404);
});
