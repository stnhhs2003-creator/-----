/*
 * 匯入驗證與合併的測試（ROADMAP B.4）。
 *
 * 匯入是不可逆動作：一按下去，老師一學期的紀錄就換掉了。
 * 所以這裡守的不是「功能會動」，是「壞資料進不來、好資料不會被記兩次」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateBackup,
  summarizeBackup,
  mergeBackup,
  planImport,
  backupFilename,
  EVENT_KINDS,
} from '../js/backup.js';

// ---------- 測試資料 ----------

const ev = (o) => ({
  id: o.id,
  ts: o.ts || '2026-08-10T01:00:00.000Z',
  classId: o.classId || 'c701',
  studentId: o.studentId || 'c701-s1',
  behaviorId: o.behaviorId || 'b-speak',
  delta: 'delta' in o ? o.delta : 2,
  // 用 in 而不是 ||，不然測「kind 是空字串」時會被預設值救回去
  kind: 'kind' in o ? o.kind : 'positive',
  period: o.period || '第1節',
  note: o.note || '',
  voided: o.voided || false,
});

/** 一份合法的備份檔，形狀與 store.exportAll() 的輸出一致。 */
function goodBackup(over = {}) {
  return {
    exportedAt: '2026-08-15T02:00:00.000Z',
    classes: [{
      id: 'c701',
      name: '七年一班',
      cols: 6,
      students: [
        { id: 'c701-s1', no: 1, name: '王小明', row: 0, col: 0 },
        { id: 'c701-s2', no: 2, name: '陳小美', row: 0, col: 1 },
      ],
    }],
    behaviors: [
      { id: 'b-speak', label: '主動發言', delta: 2, kind: 'positive', icon: '🙋' },
      { id: 'b-talk', label: '課堂講話', delta: -1, kind: 'improve', icon: '💬' },
    ],
    rewards: [{ id: 'r-hw', name: '免作業券', cost: 20, stock: null, active: true }],
    events: [
      ev({ id: 'e1', ts: '2026-08-10T01:00:00.000Z' }),
      ev({ id: 'e2', ts: '2026-08-11T02:00:00.000Z', studentId: 'c701-s2', behaviorId: 'b-talk', delta: -1, kind: 'improve' }),
    ],
    settings: { alertConsecutiveImprove: 3, periods: ['第1節'] },
    ...over,
  };
}

// ---------- 格式與必要欄位 ----------

test('不是物件的東西一律擋下來', () => {
  [null, undefined, 42, '一串字', [], true].forEach((bad) => {
    const r = validateBackup(bad);
    assert.equal(r.ok, false, `${JSON.stringify(bad)} 不該通過驗證`);
    assert.ok(r.errors.length > 0);
  });
});

test('缺任何一個頂層欄位就不准匯入，而且訊息要指出缺哪一個', () => {
  ['classes', 'behaviors', 'rewards', 'events', 'settings'].forEach((key) => {
    const data = goodBackup();
    delete data[key];
    const r = validateBackup(data);
    assert.equal(r.ok, false, `缺 ${key} 竟然通過了`);
    assert.ok(r.errors.some((e) => e.includes(key)), `錯誤訊息沒提到 ${key}：${r.errors.join('｜')}`);
  });
});

test('頂層欄位型別不對也擋（events 是物件、settings 是陣列）', () => {
  assert.equal(validateBackup(goodBackup({ events: {} })).ok, false);
  assert.equal(validateBackup(goodBackup({ settings: [] })).ok, false);
  assert.equal(validateBackup(goodBackup({ classes: '七年一班' })).ok, false);
});

test('合法的備份檔要能通過，並且不留下沒必要的警告', () => {
  const r = validateBackup(goodBackup());
  assert.equal(r.ok, true, r.errors.join('｜'));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.orphanEvents, 0);
  assert.equal(r.summary.eventCount, 2);
});

// ---------- 事件欄位 ----------

test('kind 不在四種之內就擋下來', () => {
  ['praise', '', null, 'POSITIVE', 'redeem_request', 0].forEach((kind) => {
    const data = goodBackup({ events: [ev({ id: 'e1', kind })] });
    const r = validateBackup(data);
    assert.equal(r.ok, false, `kind=${JSON.stringify(kind)} 不該通過`);
    assert.ok(r.errors.some((e) => e.includes('kind')), r.errors.join('｜'));
  });
});

test('四種合法 kind 都要放行', () => {
  EVENT_KINDS.forEach((kind) => {
    const data = goodBackup({ events: [ev({ id: 'e1', kind })] });
    assert.equal(validateBackup(data).ok, true, `${kind} 應該要能通過`);
  });
});

test('delta 不是數字就擋下來（字串數字也不行）', () => {
  ['2', null, undefined, NaN, Infinity, {}, '兩分'].forEach((delta) => {
    const data = goodBackup({ events: [ev({ id: 'e1', delta })] });
    const r = validateBackup(data);
    assert.equal(r.ok, false, `delta=${JSON.stringify(delta)} 不該通過`);
    assert.ok(r.errors.some((e) => e.includes('delta')), r.errors.join('｜'));
  });
  // 負分與 0 是合法的：待改進會扣分，兌換申請是 0
  assert.equal(validateBackup(goodBackup({ events: [ev({ id: 'e1', delta: -3, kind: 'improve' })] })).ok, true);
  assert.equal(validateBackup(goodBackup({ events: [ev({ id: 'e1', delta: 0, kind: 'redeem-request' })] })).ok, true);
});

test('事件缺 id、缺 ts、時間亂寫都擋下來', () => {
  const noId = goodBackup({ events: [{ ...ev({ id: 'e1' }), id: '' }] });
  assert.equal(validateBackup(noId).ok, false);

  const badTs = goodBackup({ events: [ev({ id: 'e1', ts: '昨天下午' })] });
  const r = validateBackup(badTs);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('ts')), r.errors.join('｜'));
});

test('同一份檔案裡事件 id 重複要擋——事件流是唯一真相', () => {
  const data = goodBackup({
    events: [ev({ id: 'dup' }), ev({ id: 'dup', ts: '2026-08-12T01:00:00.000Z' })],
  });
  const r = validateBackup(data);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('重複')), r.errors.join('｜'));
});

// ---------- 參照完整性 ----------

test('事件指向不存在的班級或學生：strictRefs 會擋，預設只警告', () => {
  const badClass = goodBackup({ events: [ev({ id: 'e1', classId: 'c-nobody' })] });
  const badStudent = goodBackup({ events: [ev({ id: 'e1', studentId: 'c701-s99' })] });

  [badClass, badStudent].forEach((data) => {
    const strict = validateBackup(data, { strictRefs: true });
    assert.equal(strict.ok, false, 'strictRefs 應該擋下孤兒事件');
    assert.ok(strict.errors.some((e) => e.includes('不存在')), strict.errors.join('｜'));

    const loose = validateBackup(data);
    assert.equal(loose.ok, true, '預設模式應該放行，因為刪掉的學生本來就會留下稽核軌跡');
    assert.equal(loose.orphanEvents, 1);
    assert.equal(loose.warnings.length > 0, true, '放行但一定要有警告');
  });
});

// ---------- 班級、行為卡、獎勵 ----------

test('班級或學生缺 id、缺姓名要擋', () => {
  const noClassId = goodBackup({ classes: [{ name: '七年一班', students: [] }] });
  assert.equal(validateBackup(noClassId).ok, false);

  const noStuName = goodBackup({
    classes: [{ id: 'c701', name: '七年一班', cols: 6, students: [{ id: 'c701-s1', no: 1 }] }],
  });
  assert.equal(validateBackup(noStuName).ok, false);

  const dupStu = goodBackup({
    classes: [{
      id: 'c701',
      name: '七年一班',
      cols: 6,
      students: [{ id: 'c701-s1', no: 1, name: '甲' }, { id: 'c701-s1', no: 2, name: '乙' }],
    }],
  });
  assert.equal(validateBackup(dupStu).ok, false);
});

test('行為卡的 kind 只能是 positive／improve，delta 必須是數字', () => {
  const badKind = goodBackup({ behaviors: [{ id: 'b-x', label: 'x', delta: 1, kind: 'redeem' }] });
  assert.equal(validateBackup(badKind).ok, false);

  const badDelta = goodBackup({ behaviors: [{ id: 'b-x', label: 'x', delta: '1', kind: 'positive' }] });
  assert.equal(validateBackup(badDelta).ok, false);
});

test('錯誤訊息會收斂，不會把一千筆壞資料全倒出來', () => {
  const events = [];
  for (let i = 0; i < 500; i++) events.push(ev({ id: `e${i}`, kind: '亂寫' }));
  const r = validateBackup(goodBackup({ events }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.length <= 12, `錯誤訊息竟有 ${r.errors.length} 條`);
  assert.ok(r.errors.some((e) => e.includes('未列出')), '應該要告訴老師還有多少同類問題');
});

// ---------- 摘要 ----------

test('摘要要算對班級／學生／事件數與時間範圍', () => {
  const s = summarizeBackup(goodBackup());
  assert.equal(s.classCount, 1);
  assert.equal(s.studentCount, 2);
  assert.equal(s.eventCount, 2);
  assert.equal(s.behaviorCount, 2);
  assert.equal(s.rewardCount, 1);
  assert.equal(s.firstTs, '2026-08-10T01:00:00.000Z');
  assert.equal(s.lastTs, '2026-08-11T02:00:00.000Z');
  assert.equal(s.byKind.positive, 1);
  assert.equal(s.byKind.improve, 1);
});

test('空資料的摘要不會爆炸', () => {
  const s = summarizeBackup({ classes: [], behaviors: [], rewards: [], events: [], settings: {} });
  assert.equal(s.eventCount, 0);
  assert.equal(s.firstTs, '');
});

// ---------- 合併 ----------

test('合併不會把同一筆事件記兩次', () => {
  const current = goodBackup();
  const incoming = goodBackup({
    events: [
      ev({ id: 'e1' }),                                        // 重複
      ev({ id: 'e3', ts: '2026-08-12T01:00:00.000Z' }),        // 新的
    ],
  });

  const merged = mergeBackup(current, incoming);
  const ids = merged.events.map((e) => e.id);
  assert.deepEqual(ids, ['e1', 'e2', 'e3'], '應該去重並依時間排序');
  assert.equal(new Set(ids).size, ids.length, '不得有重複 id');
});

test('合併時「已撤銷」以撤銷為準——撤銷不可逆，不該被合併救回來', () => {
  const current = goodBackup({ events: [ev({ id: 'e1' })] });
  const incoming = goodBackup({
    events: [{ ...ev({ id: 'e1' }), voided: true, voidedAt: '2026-08-14T00:00:00.000Z' }],
  });

  const a = mergeBackup(current, incoming).events.find((e) => e.id === 'e1');
  assert.equal(a.voided, true);
  assert.equal(a.voidedAt, '2026-08-14T00:00:00.000Z');

  // 反過來也一樣：現況已撤銷，備份是舊的未撤銷版本，不能被覆蓋回去
  const b = mergeBackup(incoming, current).events.find((e) => e.id === 'e1');
  assert.equal(b.voided, true);
});

test('合併會保留現況的班級與學生，只補進備份多出來的', () => {
  const current = goodBackup();
  const incoming = goodBackup({
    classes: [
      {
        id: 'c701',
        name: '七年一班（舊名）',
        cols: 6,
        students: [
          { id: 'c701-s1', no: 1, name: '王小明（舊）', row: 0, col: 0 },
          { id: 'c701-s3', no: 3, name: '林大同', row: 0, col: 2 },
        ],
      },
      { id: 'c703', name: '七年三班', cols: 6, students: [{ id: 'c703-s1', no: 1, name: '楊晴文' }] },
    ],
  });

  const merged = mergeBackup(current, incoming);
  assert.equal(merged.classes.length, 2, '備份多出來的班級要補進來');

  const c701 = merged.classes.find((c) => c.id === 'c701');
  assert.equal(c701.name, '七年一班', '現況的班名優先，不被備份蓋掉');
  assert.equal(c701.students.length, 3, '備份多出來的學生要補進來');
  assert.equal(c701.students.find((s) => s.id === 'c701-s1').name, '王小明', '現況的姓名優先');
  assert.ok(c701.students.some((s) => s.id === 'c701-s3'));
});

test('合併時現況的設定優先，備份只補現況沒有的鍵', () => {
  const current = goodBackup({ settings: { alertConsecutiveImprove: 5 } });
  const incoming = goodBackup({ settings: { alertConsecutiveImprove: 3, periods: ['第1節', '第2節'] } });
  const merged = mergeBackup(current, incoming);
  assert.equal(merged.settings.alertConsecutiveImprove, 5);
  assert.deepEqual(merged.settings.periods, ['第1節', '第2節']);
});

test('合併結果本身要通過驗證', () => {
  const merged = mergeBackup(goodBackup(), goodBackup({ events: [ev({ id: 'e9', ts: '2026-08-13T01:00:00.000Z' })] }));
  const r = validateBackup(merged);
  assert.equal(r.ok, true, r.errors.join('｜'));
});

// ---------- 匯入前的預告 ----------

test('合併模式要能講清楚：幾筆新的、幾筆跳過、匯入後剩幾筆', () => {
  const current = goodBackup();
  const incoming = goodBackup({
    events: [ev({ id: 'e1' }), ev({ id: 'e3', ts: '2026-08-12T01:00:00.000Z' }), ev({ id: 'e4', ts: '2026-08-13T01:00:00.000Z' })],
  });

  const plan = planImport(current, incoming, 'merge');
  assert.equal(plan.newEvents, 2);
  assert.equal(plan.duplicateEvents, 1);
  assert.equal(plan.before.eventCount, 2);
  assert.equal(plan.after.eventCount, 4);
  assert.equal(plan.droppedEvents, 0, '合併不該弄丟任何東西');
});

test('覆蓋模式要老實說出會弄丟幾筆', () => {
  const current = goodBackup(); // e1, e2
  const incoming = goodBackup({ events: [ev({ id: 'e1' })] });

  const plan = planImport(current, incoming, 'replace');
  assert.equal(plan.before.eventCount, 2);
  assert.equal(plan.after.eventCount, 1);
  assert.equal(plan.droppedEvents, 1, 'e2 只存在現況，覆蓋後會消失，必須先講');
});

test('新班級數要算對', () => {
  const incoming = goodBackup({
    classes: [
      ...goodBackup().classes,
      { id: 'c703', name: '七年三班', cols: 6, students: [] },
    ],
  });
  assert.equal(planImport(goodBackup(), incoming, 'merge').newClasses, 1);
});

// ---------- 檔名 ----------

test('匯出檔名帶站名與日期時間，副檔名是 .json', () => {
  const name = backupFilename(new Date(2026, 7, 15, 14, 32));
  assert.equal(name, '班級積分堂-備份-含姓名-20260815-1432.json');
  assert.ok(name.endsWith('.json'));
});

test('同一天匯出兩次不會撞名（分鐘不同就不同檔）', () => {
  const a = backupFilename(new Date(2026, 7, 15, 9, 5));
  const b = backupFilename(new Date(2026, 7, 15, 9, 6));
  assert.equal(a, '班級積分堂-備份-含姓名-20260815-0905.json');
  assert.notEqual(a, b);
});

// ---------- 去識別化匯出（個資盤點 7.4）----------

import { deidentify, isDeidentified, DEID_MARKER } from '../js/backup.js';
import { SEED, DEMO_CLASSES, DEFAULT_SETTINGS } from '../js/data.js';

/** 示範資料的兩班共 36 個擬真姓名，一個都不能出現在去識別化檔裡。 */
const DEMO_NAMES = DEMO_CLASSES.flatMap((c) => c.students.map((s) => s.name));

/** 用示範資料組一份跟 store.exportAll() 同形狀的備份。 */
function demoBackup() {
  return {
    exportedAt: '2026-08-15T02:00:00.000Z',
    classes: JSON.parse(JSON.stringify(DEMO_CLASSES)),
    behaviors: SEED.behaviors,
    rewards: [{ id: 'r-hw', name: '免作業券', cost: 20, stock: null, active: true }],
    events: JSON.parse(JSON.stringify(SEED.events)),
    settings: { ...DEFAULT_SETTINGS },
  };
}

test('去識別化之後，示範資料的 36 個姓名一個都不剩（逐一掃過，不抽樣）', () => {
  const { data } = deidentify(demoBackup());
  const text = JSON.stringify(data);

  assert.equal(DEMO_NAMES.length, 36, '示範資料應該有 36 位學生，測試前提變了要重寫');
  const leaked = DEMO_NAMES.filter((n) => text.includes(n));
  assert.deepEqual(leaked, [], `這些姓名還留在去識別化檔裡：${leaked.join('、')}`);

  // 姓名欄位本身也要真的變成座號，不是空字串
  data.classes.forEach((c) => c.students.forEach((s) => {
    assert.match(s.name, /^\d+號$/, `學生 ${s.id} 的代稱不是座號：${JSON.stringify(s.name)}`);
  }));
});

test('去識別化不會動到統計：事件筆數、總分、各 kind 筆數、撤銷數全部一樣', () => {
  const src = demoBackup();
  const { data } = deidentify(src);

  const sum = (list) => list.reduce((n, e) => n + e.delta, 0);
  const countKind = (list) => list.reduce((m, e) => ({ ...m, [e.kind]: (m[e.kind] || 0) + 1 }), {});

  assert.equal(data.events.length, src.events.length);
  assert.equal(sum(data.events), sum(src.events));
  assert.deepEqual(countKind(data.events), countKind(src.events));
  assert.equal(
    data.events.filter((e) => e.voided).length,
    src.events.filter((e) => e.voided).length,
  );

  const before = summarizeBackup(src);
  const after = summarizeBackup(data);
  assert.equal(after.eventCount, before.eventCount);
  assert.equal(after.studentCount, before.studentCount);
  assert.deepEqual(after.byKind, before.byKind);
});

test('班級名稱、座位、可推算的 id 都要換掉——只換姓名不算去識別化', () => {
  const { data } = deidentify(demoBackup());
  const text = JSON.stringify(data);

  assert.ok(!text.includes('七年一班'), '班級名稱還在');
  assert.ok(!text.includes('七年三班'), '班級名稱還在');
  assert.ok(!text.includes('c701'), '原本的 classId 還在，事件可以被對回原檔');
  assert.ok(!text.includes('c701-s1'), '原本的 studentId（可推算格式）還在');

  data.classes.forEach((c) => c.students.forEach((s) => {
    assert.equal(s.row, undefined, '座位列還在——班內唯一，等於另一個識別碼');
    assert.equal(s.col, undefined, '座位欄還在');
  }));
});

test('備註一律清空，而且要老實說清掉幾則', () => {
  const src = demoBackup();
  // 示範資料本身就有幾則備註（兌換獎勵會寫入品名），所以算的是「多出來的兩則」
  const base = src.events.filter((e) => e.note).length;
  src.events[0].note = '媽媽說最近家裡在辦離婚，情緒不穩';
  src.events[1].note = '午餐時跟王品睿起衝突';
  const { data, stats } = deidentify(src);

  assert.equal(stats.notesRemoved, base + 2);
  assert.ok(!JSON.stringify(data).includes('離婚'));
  assert.ok(!JSON.stringify(data).includes('王品睿'));
  data.events.forEach((e) => assert.equal(e.note, ''));
});

test('家長綁定通過碼不會跟著去識別化檔外流（設定走白名單）', () => {
  const src = demoBackup();
  src.settings.parentCode = '9876543';
  const { data } = deidentify(src);

  assert.ok(!JSON.stringify(data).includes('9876543'));
  assert.equal(data.settings.parentCode, undefined);
  assert.equal(data.settings.retentionMonths, DEFAULT_SETTINGS.retentionMonths, '無害的設定要留著');
});

test('學生物件上任何沒被白名單放行的欄位都不會漏出去', () => {
  const src = demoBackup();
  src.classes[0].students[0].personalCode = 'ABC123';
  src.classes[0].students[0].parentEmail = 'mom@example.com';
  const { data } = deidentify(src);

  const text = JSON.stringify(data);
  assert.ok(!text.includes('ABC123'));
  assert.ok(!text.includes('mom@example.com'));
});

test('事件時間只留到日期，事件 id 重新編號——毫秒時間戳可以還原孩子的作息', () => {
  const src = demoBackup();
  const { data } = deidentify(src);

  data.events.forEach((e, i) => {
    assert.match(e.ts, /^\d{4}-\d{2}-\d{2}$/, `事件 ${i} 的時間還帶著時分秒：${e.ts}`);
    assert.equal(e.id, `e${i + 1}`);
  });
  assert.ok(!JSON.stringify(data).includes(src.events[0].id));
});

test('指向已刪除學生的事件也有代號，筆數不會因此對不上', () => {
  const src = demoBackup();
  src.events.push({
    id: 'ghost-1', ts: '2026-08-12T01:00:00.000Z', classId: 'c701', studentId: 'c701-s99',
    behaviorId: 'b-speak', delta: 2, kind: 'positive', period: '第1節', note: '', voided: false,
  });
  const { data } = deidentify(src);

  assert.equal(data.events.length, src.events.length);
  const ghost = data.events[data.events.length - 1];
  assert.ok(ghost.studentId && !ghost.studentId.includes('s99'), '原本的 studentId 不能留著');
});

test('去識別化的輸出帶著標記，而且認得出來', () => {
  const { data } = deidentify(demoBackup());
  assert.equal(data.deidentified, true);
  assert.equal(data.deidentifiedFormat, DEID_MARKER);
  assert.equal(data.restorable, false, '這份檔案不可還原，要在檔案裡就講明白');
  assert.ok(isDeidentified(data));
  assert.ok(!isDeidentified(demoBackup()), '一般備份不該被誤判成去識別化檔');
});

test('匯入端明確拒絕去識別化檔，並指出該去用哪一種檔', () => {
  const { data } = deidentify(demoBackup());
  const r = validateBackup(data);

  assert.equal(r.ok, false, '去識別化檔絕對不能匯入——會把名冊洗成沒有姓名');
  assert.ok(r.errors.some((e) => e.includes('去識別化')), `錯誤訊息沒講清楚：${r.errors.join(' / ')}`);
  assert.ok(r.errors.some((e) => e.includes('含姓名')), '要告訴老師改用哪一種檔');
});

test('被拔掉標記的去識別化檔仍然認得出來（姓名全是座號）', () => {
  const { data } = deidentify(demoBackup());
  delete data.deidentified;
  delete data.deidentifiedFormat;

  const r = validateBackup(data);
  assert.equal(r.ok, true, '結構本身是合法的，不該被當成壞檔');
  assert.ok(
    r.warnings.some((w) => w.includes('去識別化')),
    `沒有提醒老師這看起來是去識別化檔：${r.warnings.join(' / ')}`,
  );
});

test('去識別化檔本身的結構是合法的（拿掉標記就能通過驗證）', () => {
  const { data } = deidentify(demoBackup());
  delete data.deidentified;
  delete data.deidentifiedFormat;
  const r = validateBackup(data, { strictRefs: true });
  assert.deepEqual(r.errors, []);
});

test('去識別化不會改動傳進來的原始資料', () => {
  const src = demoBackup();
  const snapshot = JSON.stringify(src);
  deidentify(src);
  assert.equal(JSON.stringify(src), snapshot, '原始資料被改了，老師的名冊就毀了');
});

test('兩種匯出的檔名一眼分得出來，不是只差一個字', () => {
  const at = new Date(2026, 7, 15, 14, 32);
  const plain = backupFilename(at, { kind: 'plain' });
  const deid = backupFilename(at, { kind: 'deid' });

  assert.equal(plain, '班級積分堂-備份-含姓名-20260815-1432.json');
  assert.equal(deid, '班級積分堂-去識別-無姓名-20260815-1432.json');
  assert.equal(backupFilename(at), plain, '沒指定種類時預設是含姓名的備份檔');
  assert.ok(plain.includes('含姓名') && deid.includes('無姓名'));
  assert.ok(!plain.includes('無姓名'));
});

test('空資料去識別化不會爆炸', () => {
  const { data, stats } = deidentify({});
  assert.deepEqual(data.classes, []);
  assert.deepEqual(data.events, []);
  assert.equal(stats.namesRemoved, 0);
  assert.ok(isDeidentified(data));
});
