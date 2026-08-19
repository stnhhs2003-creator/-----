/*
 * 「不參與記錄」（個資盤點 A5）。
 *
 * 這一支測試守的是四件會被日後重構默默弄壞的事：
 *   1. 寫入端真的擋得住（不是畫面藏起來）。
 *   2. 座位不會被抽掉——抽掉後面的人就會遞補，座位表跟教室對不起來。
 *   3. 匯出檔裡查不到這位學生（A5 的驗證條件原文）。
 *   4. 取消之後一切恢復正常。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OPT_OUT_LABEL,
  isOptedOut,
  optedOutIds,
  markOptOut,
  clearOptOut,
  canRecord,
  participating,
  seatCells,
  redactExport,
} from '../js/optout.js';

const AT = '2026-08-15T01:00:00.000Z';

function makeClasses() {
  return [{
    id: 'c1',
    name: '七年一班',
    cols: 2,
    students: [
      { id: 'c1-s1', no: 1, name: '甲', row: 0, col: 0 },
      { id: 'c1-s2', no: 2, name: '乙', row: 0, col: 1 },
      { id: 'c1-s3', no: 3, name: '丙', row: 1, col: 0 },
      { id: 'c1-s4', no: 4, name: '丁', row: 1, col: 1 },
    ],
  }, {
    id: 'c2',
    name: '七年三班',
    cols: 2,
    students: [{ id: 'c2-s1', no: 1, name: '戊', row: 0, col: 0 }],
  }];
}

function makeEvents() {
  return [
    { id: 'e1', ts: '2026-08-01T01:00:00.000Z', classId: 'c1', studentId: 'c1-s1', behaviorId: 'b-help', delta: 2, kind: 'positive', voided: false },
    { id: 'e2', ts: '2026-08-02T01:00:00.000Z', classId: 'c1', studentId: 'c1-s2', behaviorId: 'b-talk', delta: -1, kind: 'improve', voided: false },
    { id: 'e3', ts: '2026-08-03T01:00:00.000Z', classId: 'c1', studentId: 'c1-s2', behaviorId: 'b-help', delta: 2, kind: 'positive', voided: true },
    { id: 'e4', ts: '2026-08-04T01:00:00.000Z', classId: 'c1', studentId: 'c1-s2', behaviorId: '', delta: -5, kind: 'redeem', note: '免作業券', voided: false },
    { id: 'e5', ts: '2026-08-05T01:00:00.000Z', classId: 'c1', studentId: 'c1-s3', behaviorId: 'b-help', delta: 2, kind: 'positive', voided: false },
  ];
}

const optOut = (cs, id = 'c1-s2') => markOptOut(cs, { classId: 'c1', studentId: id, at: AT });

// ---------- 標記與取消 ----------

test('markOptOut 只標到指定那一位，且不就地改原陣列', () => {
  const before = makeClasses();
  const after = optOut(before);

  assert.equal(isOptedOut(after[0].students[1]), true);
  assert.equal(after[0].students[1].optOut.since, AT);

  // 同班其他人與別班都不受影響
  assert.equal(after[0].students.filter(isOptedOut).length, 1);
  assert.equal(after[1].students.some(isOptedOut), false);

  // 原陣列沒被動到
  assert.equal(before[0].students.some(isOptedOut), false);
});

test('clearOptOut 把標記整個拿掉，不是留一個 false 在那裡', () => {
  const marked = optOut(makeClasses());
  const back = clearOptOut(marked, { classId: 'c1', studentId: 'c1-s2' });
  const stu = back[0].students[1];

  assert.equal(isOptedOut(stu), false);
  assert.equal('optOut' in stu, false, 'optOut 欄位應該被刪掉，不是設成 falsy');
  assert.equal(stu.name, '乙', '取消後姓名要還在');
  assert.equal(stu.no, 2);
});

test('optedOutIds 可以只看一個班，也可以看全部', () => {
  const cs = optOut(optOut(makeClasses()), 'c2-s1');
  // 上一行第二次呼叫指定的是 classId c1，所以 c2-s1 標不到——這正是預期
  assert.deepEqual([...optedOutIds(cs, 'c1')], ['c1-s2']);
  assert.deepEqual([...optedOutIds(cs)], ['c1-s2']);

  const both = markOptOut(cs, { classId: 'c2', studentId: 'c2-s1', at: AT });
  assert.deepEqual([...optedOutIds(both)].sort(), ['c1-s2', 'c2-s1']);
  assert.deepEqual([...optedOutIds(both, 'c2')], ['c2-s1']);
});

// ---------- 寫入端 ----------

test('canRecord 擋住不參與的學生，其他人照舊', () => {
  const cs = optOut(makeClasses());

  const blocked = canRecord(cs, { classId: 'c1', studentId: 'c1-s2' });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /不參與記錄/);

  assert.equal(canRecord(cs, { classId: 'c1', studentId: 'c1-s1' }).ok, true);
  assert.equal(canRecord(cs, { classId: 'c2', studentId: 'c2-s1' }).ok, true);
});

test('canRecord 不看 kind——兌換、加分、扣分一律擋', () => {
  const cs = optOut(makeClasses());
  // 閘門只吃 classId/studentId，呼叫端傳什麼 kind 都不影響結果
  ['positive', 'improve', 'redeem-request', 'redeem'].forEach((kind) => {
    const r = canRecord(cs, { classId: 'c1', studentId: 'c1-s2', kind });
    assert.equal(r.ok, false, `${kind} 應該被擋`);
  });
});

test('canRecord 對不存在的班級或學生不誤擋（那是別種錯，不歸這裡管）', () => {
  const cs = optOut(makeClasses());
  assert.equal(canRecord(cs, { classId: 'nope', studentId: 'c1-s2' }).ok, true);
  assert.equal(canRecord(cs, { classId: 'c1', studentId: 'ghost' }).ok, true);
});

test('取消之後寫入端立刻放行', () => {
  const marked = optOut(makeClasses());
  assert.equal(canRecord(marked, { classId: 'c1', studentId: 'c1-s2' }).ok, false);

  const back = clearOptOut(marked, { classId: 'c1', studentId: 'c1-s2' });
  assert.equal(canRecord(back, { classId: 'c1', studentId: 'c1-s2' }).ok, true);
});

// ---------- 名單類（班級榜／評語／週報／家長端／學生端） ----------

test('participating 把不參與的人從名單裡拿掉', () => {
  const cs = optOut(makeClasses());
  const names = participating(cs[0].students).map((s) => s.name);
  assert.deepEqual(names, ['甲', '丙', '丁']);
});

test('participating 不改變其餘的人與順序', () => {
  const cs = optOut(makeClasses(), 'c1-s1');
  const ids = participating(cs[0].students).map((s) => s.id);
  assert.deepEqual(ids, ['c1-s2', 'c1-s3', 'c1-s4']);
});

// ---------- 座位表 ----------

test('座位不會被抽掉，後面的人不遞補', () => {
  const cs = optOut(makeClasses());
  const cells = seatCells(cs[0].students);

  assert.equal(cells.length, 4, '格子數要跟教室人數一樣');
  assert.deepEqual(cells.map((c) => c.no), [1, 2, 3, 4]);
  // 每個人的 row/col 都沒有位移
  assert.deepEqual(
    cells.map((c) => `${c.row},${c.col}`),
    ['0,0', '0,1', '1,0', '1,1'],
  );
});

test('不參與那一格不帶姓名，也印不出姓名', () => {
  const cs = optOut(makeClasses());
  const cell = seatCells(cs[0].students).find((c) => c.id === 'c1-s2');

  assert.equal(cell.optedOut, true);
  assert.equal(cell.name, '');
  assert.equal(cell.label, '—');
  assert.equal(JSON.stringify(cell).includes('乙'), false, '整個座位格物件裡不得出現姓名');

  // 座號要留著——老師靠座號對位，抽掉就對不上教室了
  assert.equal(cell.no, 2);
});

test('沒被標記的座位照常帶姓名', () => {
  const cells = seatCells(makeClasses()[0].students);
  assert.equal(cells.every((c) => c.optedOut === false), true);
  assert.deepEqual(cells.map((c) => c.label), ['甲', '乙', '丙', '丁']);
});

// ---------- 匯出檔（A5 的驗證條件原文） ----------

test('匯出檔裡查不到這位學生的姓名與任何一筆紀錄', () => {
  const classes = optOut(makeClasses());
  const dump = { exportedAt: AT, classes, events: makeEvents(), behaviors: [], rewards: [], settings: {} };
  const out = redactExport(dump);
  const json = JSON.stringify(out);

  assert.equal(json.includes('乙'), false, '匯出檔不得出現姓名');
  assert.equal(json.includes('c1-s2'), true, '座位佔位還在（只剩 id/座號/位置）');
  assert.equal(out.events.some((e) => e.studentId === 'c1-s2'), false, '事件要全數濾掉');
  assert.equal(json.includes('免作業券'), false, '兌換紀錄的備註也要跟著消失');
});

test('匯出檔不動到其他學生', () => {
  const classes = optOut(makeClasses());
  const dump = { exportedAt: AT, classes, events: makeEvents(), behaviors: [], rewards: [], settings: {} };
  const out = redactExport(dump);

  assert.deepEqual(out.events.map((e) => e.id), ['e1', 'e5']);
  assert.deepEqual(out.classes[0].students.map((s) => s.name), ['甲', '', '丙', '丁']);
  assert.deepEqual(out.classes[1].students.map((s) => s.name), ['戊']);
  assert.equal(out.exportedAt, AT);
});

test('沒有任何人不參與時，匯出檔一個位元組都不該變', () => {
  const dump = { exportedAt: AT, classes: makeClasses(), events: makeEvents(), behaviors: [], rewards: [], settings: {} };
  assert.deepEqual(redactExport(dump), dump);
});

test('redactExport 是安全網：匯入舊備份時，舊事件照樣被攔下來', () => {
  // 情境：老師標記不參與（當下已 purge），三個月後匯入一份標記前的備份。
  // 那份備份的 classes 帶著標記、events 帶著舊紀錄——不能讓它們復活。
  const classes = optOut(makeClasses());
  const stale = { classes, events: makeEvents(), behaviors: [], rewards: [], settings: {} };
  assert.equal(redactExport(stale).events.filter((e) => e.studentId === 'c1-s2').length, 0);
});

// ---------- 用字 ----------

test('標記用字是中性的，不帶懲罰意味', () => {
  assert.equal(OPT_OUT_LABEL, '未參與');
  ['停權', '停用', '封鎖', '禁止', '黑名單', '排除'].forEach((bad) => {
    assert.equal(OPT_OUT_LABEL.includes(bad), false, `標記不該用「${bad}」`);
    assert.equal(canRecord(optOut(makeClasses()), { classId: 'c1', studentId: 'c1-s2' }).reason.includes(bad), false,
      `擋下時給老師看的訊息不該用「${bad}」`);
  });
});
