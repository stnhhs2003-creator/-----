/*
 * 學生端個人代碼的測試。
 *
 * 這一組守的是一句話：**選一下下拉、改一下 sessionStorage，都拿不到別人的東西**。
 *
 * 舊的學生端只要把下拉拉到同學的名字，就看得到他的點數餘額、個人成長，
 * 還能用他的名義去商店送兌換申請。所以這裡最重要的幾條，
 * 全部是「假裝自己是別人」會不會被擋，以及「班級榜不該被擋」。
 *
 * 前半段測純函式層（js/codes.js，前端後端共用的同一份比對邏輯），
 * 後半段跟 parent-binding 那組一樣不打網路：直接把 Request 餵給 handleStudent，
 * 後面接一顆用 db/schema.sql 建起來的記憶體 SQLite——測到的是真的 SQL。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  normalizeCode, codeMatches, randomCode, ensureCodes,
  reissueOne, reissueClass, findStudentByCode,
} from '../js/codes.js';
import { handleStudent } from '../functions/api/student/[[route]].js';
import { writeDoc } from '../functions/api/data/[[route]].js';

const SCHEMA = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
const STUDENT_JS = readFileSync(new URL('../js/student.js', import.meta.url), 'utf8');
/** 註解裡會提到「不讀 location.search」這件事，所以要驗的是去掉註解之後的程式碼。 */
const STUDENT_CODE = STUDENT_JS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const TEACHER = 't-alice';
const PUBLIC_ID = 'abc123xyz9';

/** 兩位學生，代碼寫死才驗得出「打錯就不給」。 */
const CLASSES = [
  {
    id: 'c701',
    name: '七年一班',
    students: [
      { id: 'c701-s5', no: 5, name: '張耘睿', code: '4821' },
      { id: 'c701-s6', no: 6, name: '黃詩涵', code: '7390' },
    ],
  },
  {
    id: 'c703',
    name: '七年三班',
    students: [{ id: 'c703-s1', no: 1, name: '楊晴文', code: '1234' }],
  },
];

const clone = (v) => JSON.parse(JSON.stringify(v));

// ───────────────────────── 純函式層 ─────────────────────────

test('代碼正規化：全形數字與空白都吃得下（學生是照紙條打的）', () => {
  assert.equal(normalizeCode('４８２１'), '4821');
  assert.equal(normalizeCode(' 48 21 '), '4821');
  assert.equal(normalizeCode(null), '');
});

test('沒設代碼的人一律不通過——沒發代碼不等於誰都可以進', () => {
  assert.equal(codeMatches('', ''), false);
  assert.equal(codeMatches('', undefined), false);
  assert.equal(codeMatches('0000', null), false);
});

test('代碼對了才回得到人，打錯就是 null', () => {
  const hit = findStudentByCode(CLASSES, { classId: 'c701', studentId: 'c701-s5', code: '4821' });
  assert.equal(hit.student.name, '張耘睿');
  assert.equal(findStudentByCode(CLASSES, { classId: 'c701', studentId: 'c701-s5', code: '9999' }), null);
  assert.equal(findStudentByCode(CLASSES, { classId: 'c701', studentId: 'c701-s5', code: '' }), null);
});

test('沒有代碼就看不到個人頁：連 code 欄位都不給的話一律不通過', () => {
  assert.equal(findStudentByCode(CLASSES, { classId: 'c701', studentId: 'c701-s5' }), null);
});

test('拿自己的代碼配同學的座號，換不到同學的資料', () => {
  // 這就是「把 sessionStorage 的 studentId 改成隔壁同學」那一招。
  assert.equal(
    findStudentByCode(CLASSES, { classId: 'c701', studentId: 'c701-s6', code: '4821' }),
    null,
  );
});

test('代碼綁班：拿七年一班的代碼進不了七年三班', () => {
  assert.equal(
    findStudentByCode(CLASSES, { classId: 'c703', studentId: 'c703-s1', code: '4821' }),
    null,
  );
});

test('用座號指名也一樣要驗代碼', () => {
  assert.equal(findStudentByCode(CLASSES, { classId: 'c701', no: 5, code: '4821' }).student.id, 'c701-s5');
  assert.equal(findStudentByCode(CLASSES, { classId: 'c701', no: 5, code: '7390' }), null);
});

test('代碼是 4 位數，而且是亂數不是座號', () => {
  const seen = new Set();
  for (let i = 0; i < 300; i++) {
    const c = randomCode();
    assert.match(c, /^\d{4}$/);
    seen.add(c);
  }
  // 從座號、班級或任何固定規則推出來的話，這裡會塌成幾個值。
  assert.ok(seen.size > 200, `亂數不夠散：300 次只出現 ${seen.size} 種`);
});

test('同一班內代碼不重複', () => {
  const big = [{
    id: 'c705',
    name: '七年五班',
    students: Array.from({ length: 35 }, (_, i) => ({ id: `c705-s${i + 1}`, no: i + 1, name: `學生${i + 1}` })),
  }];
  const { classes, added } = ensureCodes(big);
  assert.equal(added, 35);
  const codes = classes[0].students.map((s) => s.code);
  assert.equal(new Set(codes).size, 35);
  codes.forEach((c) => assert.match(c, /^\d{4}$/));
});

test('整班重發之後仍然不重複，而且每個人都換了新的', () => {
  const before = clone(CLASSES[0]);
  const after = reissueClass(before);
  assert.equal(new Set(after.students.map((s) => s.code)).size, after.students.length);
  after.students.forEach((s, i) => assert.notEqual(s.code, before.students[i].code));
});

test('單獨重發只換那一位，而且不會撞到同班其他人', () => {
  const before = clone(CLASSES[0]);
  const after = reissueOne(before, 'c701-s5');
  assert.equal(after.students[1].code, before.students[1].code);
  assert.notEqual(after.students[0].code, after.students[1].code);
  // 舊碼立刻失效
  assert.equal(findStudentByCode([after], { classId: 'c701', studentId: 'c701-s5', code: '4821' }), null);
});

test('舊資料沒有 code 會自動補發，不是壞掉；已經有的不動', () => {
  const legacy = [{
    id: 'c701',
    name: '七年一班',
    students: [
      { id: 'c701-s5', no: 5, name: '張耘睿' },          // 舊資料，沒有 code
      { id: 'c701-s6', no: 6, name: '黃詩涵', code: '7390' }, // 已經有了
    ],
  }];
  const { classes, added } = ensureCodes(legacy);
  assert.equal(added, 1);
  assert.match(classes[0].students[0].code, /^\d{4}$/);
  assert.equal(classes[0].students[1].code, '7390', '已經有代碼的人不該被換掉');

  // 補發完就進得去了
  assert.ok(findStudentByCode(classes, {
    classId: 'c701', studentId: 'c701-s5', code: classes[0].students[0].code,
  }));

  // 全都有代碼時再跑一次不會亂動
  const again = ensureCodes(classes);
  assert.equal(again.added, 0);
  assert.equal(again.classes, classes, '沒有要補的時候應該原封不動回傳');
});

// ───────────────────── 前端：身分不得掛在網址上 ─────────────────────

test('學生端不從網址取身分——改網址就能換人等於沒做', () => {
  assert.equal(/location\.(search|hash)/.test(STUDENT_CODE), false, 'student.js 不該讀網址參數');
  assert.equal(/URLSearchParams/.test(STUDENT_CODE), false, 'student.js 不該讀網址參數');
  assert.ok(STUDENT_CODE.includes('sessionStorage'), '身分應該記在 sessionStorage');
});

test('那個「選誰就看得到誰」的學生下拉已經拿掉了', () => {
  assert.equal(/#studentSelect/.test(STUDENT_CODE), false);
  const html = readFileSync(new URL('../student.html', import.meta.url), 'utf8');
  assert.equal(/id="studentSelect"/.test(html), false);
});

test('個人成長與商店的內容預設是藏起來的，不是算好再遮住', () => {
  const html = readFileSync(new URL('../student.html', import.meta.url), 'utf8');
  assert.match(html, /id="meContent" hidden/);
  assert.match(html, /id="shopContent" hidden/);
});

// ───────────────────────── 伺服器端 ─────────────────────────

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
  await writeDoc(db, TEACHER, 'classes', CLASSES);
  await writeDoc(db, TEACHER, 'behaviors', [
    { id: 'b-speak', label: '主動發言', icon: '🙋', kind: 'positive' },
    { id: 'b-talk', label: '課堂講話', icon: '💬', kind: 'improve' },
  ]);
  await writeDoc(db, TEACHER, 'rewards', [
    { id: 'r-lunch', name: '午餐優先排隊券', cost: 8, stock: 20, active: true },
    { id: 'r-seat', name: '自選座位一週', cost: 999, stock: null, active: true },
  ]);
  await db.execute(
    'INSERT INTO teacher_public (public_id, teacher_id, created_at) VALUES (?, ?, ?)',
    [PUBLIC_ID, TEACHER, '2026-08-15T00:00:00.000Z'],
  );
  return db;
}

async function addEvent(db, { id, studentId, kind, delta, behaviorId = 'b-speak', voided = 0 }) {
  await db.execute(
    'INSERT INTO events (teacher_id, id, ts, class_id, student_id, behavior_id, delta, kind, period, note, voided)' +
      " VALUES (?, ?, ?, 'c701', ?, ?, ?, ?, '第2節', '', ?)",
    [TEACHER, id, new Date().toISOString(), studentId, behaviorId, delta, kind, voided],
  );
}

function call(db, { path, method = 'GET', body = null }) {
  const req = new Request(`http://localhost/api/student${path}`, {
    method,
    ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
  return handleStudent(req, {}, db);
}

async function withEvents() {
  const db = await seed();
  await addEvent(db, { id: 'e1', studentId: 'c701-s5', kind: 'positive', delta: 3 });
  await addEvent(db, { id: 'e2', studentId: 'c701-s5', kind: 'positive', delta: 2 });
  await addEvent(db, { id: 'e3', studentId: 'c701-s5', kind: 'improve', delta: -2, behaviorId: 'b-talk' });
  await addEvent(db, { id: 'e4', studentId: 'c701-s5', kind: 'positive', delta: 5, voided: 1 });
  await addEvent(db, { id: 'e5', studentId: 'c701-s6', kind: 'positive', delta: 9 });
  return db;
}

test('沒有代碼就拿不到個人頁', async () => {
  const db = await withEvents();
  const res = await call(db, {
    path: '/me', method: 'POST',
    body: { t: PUBLIC_ID, classId: 'c701', studentId: 'c701-s5' },
  });
  assert.equal(res.status, 403);
});

test('代碼錯了就拿不到個人頁', async () => {
  const db = await withEvents();
  const res = await call(db, {
    path: '/me', method: 'POST',
    body: { t: PUBLIC_ID, classId: 'c701', studentId: 'c701-s5', code: '0000' },
  });
  assert.equal(res.status, 403);
  const data = await res.json();
  assert.equal(data.balance, undefined);
  assert.equal(data.events, undefined);
});

test('拿自己的代碼要同學的資料，後端擋下來', async () => {
  const db = await withEvents();
  const res = await call(db, {
    path: '/me', method: 'POST',
    // s5 的碼配 s6 的 id：前端改 sessionStorage 之後就是送出這一包。
    body: { t: PUBLIC_ID, classId: 'c701', studentId: 'c701-s6', code: '4821' },
  });
  assert.equal(res.status, 403);
});

test('代碼對了才拿得到，而且只有正向、未撤銷的紀錄', async () => {
  const db = await withEvents();
  const res = await call(db, {
    path: '/me', method: 'POST',
    body: { t: PUBLIC_ID, classId: 'c701', studentId: 'c701-s5', code: '4821' },
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.student.name, '張耘睿');
  // 餘額含扣分：3 + 2 - 2 = 3（撤銷那筆不算）
  assert.equal(data.balance, 3);
  assert.deepEqual(data.events.map((e) => e.id).sort(), ['e1', 'e2']);
  data.events.forEach((e) => assert.equal(e.kind, 'positive'));
  // 行為卡也只送正向的，前端連「課堂講話」四個字都拿不到
  assert.deepEqual(data.behaviors.map((b) => b.id), ['b-speak']);
});

test('回應裡不得出現任何人的代碼', async () => {
  const db = await withEvents();
  const me = await (await call(db, {
    path: '/me', method: 'POST',
    body: { t: PUBLIC_ID, classId: 'c701', studentId: 'c701-s5', code: '4821' },
  })).text();
  assert.equal(me.includes('4821'), false, '個人頁不該把代碼回傳回去');
  assert.equal(me.includes('7390'), false);

  const rank = await (await call(db, { path: `/rank?t=${PUBLIC_ID}&classId=c701` })).text();
  assert.equal(rank.includes('4821'), false, '班級榜更不該有代碼');
  assert.equal(rank.includes('7390'), false);
});

test('公開班級榜已停用，不回傳姓名、分數或事件', async () => {
  const db = await withEvents();
  const res = await call(db, { path: `/rank?t=${PUBLIC_ID}&classId=c701` });
  assert.equal(res.status, 410);
  const data = await res.json();
  assert.equal(JSON.stringify(data).includes('黃詩涵'), false);
  assert.equal(JSON.stringify(data).includes('張耘睿'), false);
  assert.equal(JSON.stringify(data).includes('behaviorId'), false);
});

test('即使已有同分資料，公開班級榜仍不開放', async () => {
  const db = await seed();
  await addEvent(db, { id: 'e1', studentId: 'c701-s5', kind: 'positive', delta: 4 });
  await addEvent(db, { id: 'e2', studentId: 'c701-s6', kind: 'positive', delta: 4 });
  const res = await call(db, { path: `/rank?t=${PUBLIC_ID}&classId=c701` });
  assert.equal(res.status, 410);
});

test('沒有代碼送不出兌換申請，而且真的沒寫進資料庫', async () => {
  const db = await withEvents();
  await addEvent(db, { id: 'e6', studentId: 'c701-s5', kind: 'positive', delta: 20 });

  const res = await call(db, {
    path: '/redeem-request', method: 'POST',
    body: { t: PUBLIC_ID, classId: 'c701', studentId: 'c701-s5', code: '0000', rewardId: 'r-lunch' },
  });
  assert.equal(res.status, 403);
  const rows = await db.execute(
    "SELECT id FROM events WHERE teacher_id = ? AND kind = 'redeem-request'", [TEACHER],
  );
  assert.equal(rows.length, 0);
});

test('用同學的名義送申請也擋得住', async () => {
  const db = await withEvents();
  const res = await call(db, {
    path: '/redeem-request', method: 'POST',
    body: { t: PUBLIC_ID, classId: 'c701', studentId: 'c701-s6', code: '4821', rewardId: 'r-lunch' },
  });
  assert.equal(res.status, 403);
});

test('代碼對了、點數夠，申請才寫得進去', async () => {
  const db = await withEvents();
  await addEvent(db, { id: 'e6', studentId: 'c701-s5', kind: 'positive', delta: 20 });

  const res = await call(db, {
    path: '/redeem-request', method: 'POST',
    body: { t: PUBLIC_ID, classId: 'c701', studentId: 'c701-s5', code: '4821', rewardId: 'r-lunch' },
  });
  assert.equal(res.status, 200);
  const rows = await db.execute(
    "SELECT student_id AS sid, delta FROM events WHERE teacher_id = ? AND kind = 'redeem-request'",
    [TEACHER],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sid, 'c701-s5');
  assert.equal(Number(rows[0].delta), 0, '申請本身不扣點，核可才扣');
});

test('點數不夠擋在後端，不是只靠前端把按鈕變灰', async () => {
  const db = await withEvents();
  const res = await call(db, {
    path: '/redeem-request', method: 'POST',
    body: { t: PUBLIC_ID, classId: 'c701', studentId: 'c701-s5', code: '4821', rewardId: 'r-seat' },
  });
  assert.equal(res.status, 409);
});

test('認不出班級的連結一律 404，不透露有沒有這位老師', async () => {
  const db = await withEvents();
  const res = await call(db, { path: '/rank?t=nosuchid&classId=c701' });
  assert.equal(res.status, 404);
});
