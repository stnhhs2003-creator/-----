/*
 * 「不參與記錄」在伺服器端的閘門。
 *
 * 前端那一道（座位表灰掉、名單濾掉）擋的是老師的手誤。
 * 這一組守的是另一件事：**繞過畫面直接打 API，一樣進不去**。
 * 個資權利不能靠對方乖乖用我們寫的介面——curl 一行就繞過去的東西不叫閘門。
 *
 * 跟 student-gate / parent-binding 同一套做法：不打網路，
 * 直接把 Request 餵給 handler，後面接一顆用 db/schema.sql 建的記憶體 SQLite。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { handleData, writeDoc } from '../functions/api/data/[[route]].js';
import { handleStudent } from '../functions/api/student/[[route]].js';
import { handleParent, findStudent } from '../functions/api/parent/[[route]].js';

const SCHEMA = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

const TEACHER = 't-alice';
const PUBLIC_ID = 'abc123xyz9';

/** 5 號不參與，6 號照常。兩位都有代碼，才驗得出「碼對也不給」。 */
const CLASSES = [
  {
    id: 'c701',
    name: '七年一班',
    students: [
      { id: 'c701-s5', no: 5, name: '張耘睿', code: '4821', optOut: { since: '2026-08-15T00:00:00.000Z' } },
      { id: 'c701-s6', no: 6, name: '黃詩涵', code: '7390' },
    ],
  },
];

function memoryDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return {
    async execute(sql, args = []) {
      const stmt = db.prepare(sql);
      return /^\s*SELECT/i.test(sql) ? stmt.all(...args) : (stmt.run(...args), []);
    },
  };
}

async function seed() {
  const db = memoryDb();
  await writeDoc(db, TEACHER, 'classes', JSON.parse(JSON.stringify(CLASSES)));
  await writeDoc(db, TEACHER, 'behaviors', [
    { id: 'b-speak', label: '主動發言', icon: '🙋', kind: 'positive' },
  ]);
  await writeDoc(db, TEACHER, 'rewards', [
    { id: 'r-lunch', name: '午餐優先排隊券', cost: 1, stock: 20, active: true },
  ]);
  await db.execute(
    'INSERT INTO teacher_public (public_id, teacher_id, created_at) VALUES (?, ?, ?)',
    [PUBLIC_ID, TEACHER, '2026-08-15T00:00:00.000Z'],
  );
  return db;
}

const dataCall = (db, path, body) =>
  handleData(
    new Request(`http://localhost/api/data${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    { DEV_TEACHER_ID: TEACHER },
    db,
  );

const studentCall = (db, path, body) =>
  handleStudent(
    new Request(`http://localhost/api/student${path}`, {
      ...(body ? {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      } : {}),
    }),
    {},
    db,
  );

// ───────────────────────── 寫入端 ─────────────────────────

test('繞過畫面直接 POST /events，不參與的學生照樣寫不進去', async () => {
  const db = await seed();
  const res = await dataCall(db, '/events', {
    classId: 'c701', studentId: 'c701-s5',
    behaviorId: 'b-speak', delta: 3, kind: 'positive',
  });
  assert.equal(res.status, 403);

  const rows = await db.execute(
    'SELECT COUNT(*) AS n FROM events WHERE teacher_id = ? AND student_id = ?',
    [TEACHER, 'c701-s5'],
  );
  assert.equal(Number(rows[0].n), 0, '回了 403 卻還是寫進去了，那 403 只是裝飾');
});

test('同班其他人不受影響——閘門只擋被標記的那一位', async () => {
  const db = await seed();
  const res = await dataCall(db, '/events', {
    classId: 'c701', studentId: 'c701-s6',
    behaviorId: 'b-speak', delta: 3, kind: 'positive',
  });
  assert.equal(res.status, 200);
  const rows = await db.execute(
    'SELECT COUNT(*) AS n FROM events WHERE teacher_id = ? AND student_id = ?',
    [TEACHER, 'c701-s6'],
  );
  assert.equal(Number(rows[0].n), 1);
});

// ───────────────────────── 學生端 ─────────────────────────

test('代碼打對也進不去個人頁，而且回的是跟打錯一樣的話', async () => {
  const db = await seed();
  const blocked = await studentCall(db, '/me', {
    t: PUBLIC_ID, classId: 'c701', studentId: 'c701-s5', code: '4821',
  });
  const wrongCode = await studentCall(db, '/me', {
    t: PUBLIC_ID, classId: 'c701', studentId: 'c701-s6', code: '0000',
  });
  assert.equal(blocked.status, wrongCode.status);
  assert.deepEqual(await blocked.json(), await wrongCode.json(),
    '「這個人不參與」跟「碼打錯」分開講，等於告訴同學這位同學的家長做了什麼決定');
});

test('也不能用自己的代碼去送兌換申請', async () => {
  const db = await seed();
  const res = await studentCall(db, '/redeem-request', {
    t: PUBLIC_ID, classId: 'c701', studentId: 'c701-s5', code: '4821', rewardId: 'r-lunch',
  });
  assert.equal(res.status, 403);
  const rows = await db.execute(
    "SELECT COUNT(*) AS n FROM events WHERE teacher_id = ? AND kind = 'redeem-request'",
    [TEACHER],
  );
  assert.equal(Number(rows[0].n), 0);
});

test('公開班級榜已停用，不會列出任何學生', async () => {
  const db = await seed();
  const res = await studentCall(db, `/rank?t=${PUBLIC_ID}&classId=c701`);
  const body = await res.json();
  assert.equal(res.status, 410);
  assert.ok(!JSON.stringify(body).includes('張耘睿'));
  assert.ok(!JSON.stringify(body).includes('黃詩涵'));
});

// ───────────────────────── 家長端 ─────────────────────────

test('findStudent 找不到不參與的孩子——綁定是取得查看權的入口', () => {
  assert.equal(findStudent(CLASSES, { classId: 'c701', no: 5, name: '張耘睿' }), null);
  assert.ok(findStudent(CLASSES, { classId: 'c701', no: 6, name: '黃詩涵' }),
    '把別人也一起擋掉了');
});

test('綁定成立之後才標記不參與，家長端立刻查不到', async () => {
  const db = await seed();
  // 先在還沒標記的狀態下建立一筆已核可的綁定。
  await writeDoc(db, TEACHER, 'classes', [{
    ...CLASSES[0],
    students: CLASSES[0].students.map((s) => {
      const { optOut, ...rest } = s;
      return rest;
    }),
  }]);
  await db.execute(
    'INSERT INTO parent_bindings (teacher_id, parent_sub, email, class_id, student_id, status, created_at)' +
      " VALUES (?, ?, ?, ?, ?, 'approved', ?)",
    [TEACHER, 'p-mom', 'mom@example.com', 'c701', 'c701-s5', '2026-08-15T00:00:00.000Z'],
  );

  const view = () => handleParent(
    new Request(`http://localhost/api/parent/view?t=${PUBLIC_ID}&s=c701-s5`),
    { DEV_TEACHER_ID: 'p-mom' },
    db,
  );

  const before = await view();
  assert.equal(before.status, 200, '前置條件不成立：標記之前本來就該看得到');

  // 家長改變主意，老師標記不參與。
  await writeDoc(db, TEACHER, 'classes', JSON.parse(JSON.stringify(CLASSES)));

  const after = await view();
  assert.equal(after.status, 403);
  assert.equal((await after.json()).error, '這個帳號還沒有被老師核可查看這位學生。',
    '訊息跟「沒核可」不一致，差別本身也是一則關於這個孩子的資訊');
});
