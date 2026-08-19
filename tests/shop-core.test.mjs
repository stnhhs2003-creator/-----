/*
 * 班級榜的排名。
 *
 * 這支測試是先有 bug 才有的：同分時第二位的名次會顯示成 undefined，
 * 學生端班級榜上實際印出過「undefined 謝欣妤 +7」。
 * 班級榜是全班一起看的東西，這種錯誤是當著全班的面出的。
 */

process.env.TZ = 'Asia/Taipei';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  rankRows,
  balanceOf,
  availableOf,
  pendingRequests,
  weeklyDelta,
  weeklyPositive,
  positiveRecords,
  ensureRewards,
  DEFAULT_REWARDS,
} from '../js/shop-core.js';
import { startOfDay } from '../js/rules.js';

const students = [
  { id: 's1', no: 1, name: '甲' },
  { id: 's2', no: 2, name: '乙' },
  { id: 's3', no: 3, name: '丙' },
  { id: 's4', no: 4, name: '丁' },
];

/** 直接指定每個人的淨分，省掉組事件的雜訊。 */
function eventsFor(scores) {
  return Object.entries(scores).map(([studentId, delta], i) => ({
    id: `e${i}`,
    ts: '2026-08-01T00:00:00.000Z',
    studentId,
    behaviorId: 'b1',
    delta,
    kind: delta >= 0 ? 'positive' : 'improve',
    voided: false,
  }));
}

test('同分同名次，而且名次不會是 undefined', () => {
  const rows = rankRows(eventsFor({ s1: 10, s2: 7, s3: 7, s4: 3 }), students);
  assert.deepEqual(rows.map((r) => r.rank), [1, 2, 2, 4]);
  assert.ok(rows.every((r) => Number.isInteger(r.rank)), '名次必須都是數字');
});

test('連續三個人同分也不會斷掉——名次要一路傳下去', () => {
  const rows = rankRows(eventsFor({ s1: 5, s2: 5, s3: 5, s4: 1 }), students);
  assert.deepEqual(rows.map((r) => r.rank), [1, 1, 1, 4]);
});

test('同分時照座號排，順序才穩定', () => {
  const rows = rankRows(eventsFor({ s3: 7, s2: 7, s1: 9, s4: 0 }), students);
  assert.deepEqual(rows.map((r) => r.student.no), [1, 2, 3, 4]);
});

test('全班都是 0 分時，每個人都是第 1 名', () => {
  const rows = rankRows([], students);
  assert.deepEqual(rows.map((r) => r.rank), [1, 1, 1, 1]);
});

/* ------------------------------------------------------------------------
 * 以下是餘額／可動用點數／學生端圖表的直接測試。
 *
 * 學生端那一頁有一條紅線：不得出現任何負向資料。紅線靠的就是這幾支函式
 * 各自把 kind 濾乾淨，所以每一支都要單獨守。
 *
 * weeklyDelta() 與 weeklyPositive() 內部直接呼叫 new Date()，沒有 now 參數，
 * 因此測資只能相對於「執行當下」產生（見 atDaysAgo）。這是能寫的最穩寫法，
 * 但代價是：測試若剛好跨過午夜就可能翻臉。這一點已列進回報的設計問題。
 * ---------------------------------------------------------------------- */

const ev = (o) => ({
  id: o.id,
  ts: o.ts,
  classId: 'c701',
  studentId: o.studentId || 's1',
  behaviorId: o.behaviorId || 'b-speak',
  delta: o.delta,
  kind: o.kind,
  period: '第1節',
  note: o.note || '',
  voided: o.voided || false,
});

/** 相對於此刻的時間戳。hour 取 10 點，離午夜兩端都遠。 */
const atDaysAgo = (n, hour = 10) => {
  const d = startOfDay();
  d.setDate(d.getDate() - n);
  d.setHours(hour);
  return d.toISOString();
};

const REWARDS = [
  { id: 'r-lunch', name: '午餐優先排隊券', cost: 8, stock: 20, active: true },
  { id: 'r-nohw', name: '免作業券', cost: 20, stock: 10, active: true },
];

// -------------------------------------------------------------- balanceOf

test('balanceOf：完全沒有事件回 0，不是 undefined', () => {
  assert.equal(balanceOf([], 's1'), 0);
});

test('balanceOf：兌換要扣餘額，兌換申請（delta 0）不動餘額', () => {
  const events = [
    ev({ id: 'a', ts: '2026-08-01T01:00:00.000Z', delta: 10, kind: 'positive' }),
    ev({ id: 'b', ts: '2026-08-02T01:00:00.000Z', behaviorId: 'r-lunch', delta: -8, kind: 'redeem' }),
    ev({ id: 'c', ts: '2026-08-03T01:00:00.000Z', behaviorId: 'r-nohw', delta: 0, kind: 'redeem-request' }),
  ];
  assert.equal(balanceOf(events, 's1'), 2);
});

test('balanceOf：只算自己的，同班同學的分數不得混進來', () => {
  const events = [
    ev({ id: 'a', ts: '2026-08-01T01:00:00.000Z', studentId: 's1', delta: 3, kind: 'positive' }),
    ev({ id: 'b', ts: '2026-08-01T02:00:00.000Z', studentId: 's2', delta: 99, kind: 'positive' }),
  ];
  assert.equal(balanceOf(events, 's1'), 3);
});

// --------------------------------------------------------- pendingRequests

test('pendingRequests：不指定學生時回全班待處理的申請', () => {
  const events = [
    ev({ id: 'q1', ts: '2026-08-01T01:00:00.000Z', studentId: 's1', behaviorId: 'r-lunch', delta: 0, kind: 'redeem-request' }),
    ev({ id: 'q2', ts: '2026-08-01T02:00:00.000Z', studentId: 's2', behaviorId: 'r-nohw', delta: 0, kind: 'redeem-request' }),
    ev({ id: 'p', ts: '2026-08-01T03:00:00.000Z', studentId: 's1', delta: 2, kind: 'positive' }),
  ];
  assert.deepEqual(pendingRequests(events).map((e) => e.id), ['q1', 'q2']);
});

test('pendingRequests：已撤銷（＝老師退回）的申請不再算待處理', () => {
  const events = [
    ev({ id: 'q1', ts: '2026-08-01T01:00:00.000Z', behaviorId: 'r-lunch', delta: 0, kind: 'redeem-request', voided: true }),
    ev({ id: 'q2', ts: '2026-08-01T02:00:00.000Z', behaviorId: 'r-nohw', delta: 0, kind: 'redeem-request' }),
  ];
  assert.deepEqual(pendingRequests(events, 's1').map((e) => e.id), ['q2']);
});

// ------------------------------------------------------------ availableOf

test('availableOf：已送出的申請要先把點數凍起來，否則學生能連按送到爆', () => {
  const events = [
    ev({ id: 'a', ts: '2026-08-01T01:00:00.000Z', delta: 30, kind: 'positive' }),
    ev({ id: 'q1', ts: '2026-08-02T01:00:00.000Z', behaviorId: 'r-nohw', delta: 0, kind: 'redeem-request' }),
    ev({ id: 'q2', ts: '2026-08-02T02:00:00.000Z', behaviorId: 'r-lunch', delta: 0, kind: 'redeem-request' }),
  ];
  assert.equal(balanceOf(events, 's1'), 30);
  assert.equal(availableOf(events, 's1', REWARDS), 2, '30 − 20 − 8');
});

test('availableOf：沒有待處理申請時就等於餘額', () => {
  const events = [ev({ id: 'a', ts: '2026-08-01T01:00:00.000Z', delta: 30, kind: 'positive' })];
  assert.equal(availableOf(events, 's1', REWARDS), 30);
});

// ------------------------------------------------------------ weeklyDelta

test('weeklyDelta：本週淨分減上週淨分', () => {
  const events = [
    ev({ id: 'l1', ts: atDaysAgo(9), delta: 2, kind: 'positive' }),
    ev({ id: 'l2', ts: atDaysAgo(8), delta: 1, kind: 'positive' }),
    ev({ id: 't1', ts: atDaysAgo(2), delta: 5, kind: 'positive' }),
    ev({ id: 't2', ts: atDaysAgo(1), behaviorId: 'b-talk', delta: -1, kind: 'improve' }),
  ];
  assert.equal(weeklyDelta(events, 's1'), 1, '(5 − 1) − (2 + 1)');
});

test('weeklyDelta：這週兌換花掉的點數不得被讀成退步', () => {
  const events = [
    ev({ id: 'l1', ts: atDaysAgo(8), delta: 3, kind: 'positive' }),
    ev({ id: 't1', ts: atDaysAgo(1), delta: 3, kind: 'positive' }),
    ev({ id: 'r1', ts: atDaysAgo(1, 11), behaviorId: 'r-nohw', delta: -20, kind: 'redeem' }),
  ];
  assert.equal(weeklyDelta(events, 's1'), 0);
});

test('weeklyDelta：兩週以前的舊帳不進計算', () => {
  const events = [
    ev({ id: 'old', ts: atDaysAgo(40), delta: 100, kind: 'positive' }),
    ev({ id: 't1', ts: atDaysAgo(1), delta: 3, kind: 'positive' }),
  ];
  assert.equal(weeklyDelta(events, 's1'), 3);
});

// --------------------------------------------------------- weeklyPositive

test('weeklyPositive：桶數等於 weeks，最後一桶叫「本週」', () => {
  const buckets = weeklyPositive([], 's1', 6);
  assert.equal(buckets.length, 6);
  assert.equal(buckets[5].label, '本週');
  assert.equal(buckets[0].label, '5 週前');
});

test('weeklyPositive：只收 positive——improve 與 redeem 不得出現在學生端圖表', () => {
  const events = [
    ev({ id: 'p', ts: atDaysAgo(1), delta: 4, kind: 'positive' }),
    ev({ id: 'i', ts: atDaysAgo(1, 11), behaviorId: 'b-talk', delta: -3, kind: 'improve' }),
    ev({ id: 'r', ts: atDaysAgo(1, 12), behaviorId: 'r-nohw', delta: -20, kind: 'redeem' }),
  ];
  const buckets = weeklyPositive(events, 's1', 6);
  assert.equal(buckets[5].value, 4);
  assert.equal(buckets.reduce((s, b) => s + b.value, 0), 4, '負向資料滲進了學生端的長條圖');
});

test('weeklyPositive：上一週的分數要落在「1 週前」那一桶，不會被吸進本週', () => {
  const buckets = weeklyPositive([ev({ id: 'p', ts: atDaysAgo(8), delta: 4, kind: 'positive' })], 's1', 6);
  assert.equal(buckets[4].label, '1 週前');
  assert.equal(buckets[4].value, 4);
  assert.equal(buckets[5].value, 0);
});

// -------------------------------------------------------- positiveRecords

test('positiveRecords：只回正向、由新到舊、受 limit 限制', () => {
  const events = [
    ev({ id: 'p1', ts: '2026-08-01T01:00:00.000Z', delta: 2, kind: 'positive' }),
    ev({ id: 'i1', ts: '2026-08-02T01:00:00.000Z', behaviorId: 'b-talk', delta: -1, kind: 'improve' }),
    ev({ id: 'p2', ts: '2026-08-03T01:00:00.000Z', delta: 2, kind: 'positive' }),
    ev({ id: 'p3', ts: '2026-08-04T01:00:00.000Z', delta: 2, kind: 'positive' }),
  ];
  assert.deepEqual(positiveRecords(events, 's1', 2).map((e) => e.id), ['p3', 'p2']);
});

test('positiveRecords：一筆正向都沒有時回空陣列，不是 undefined', () => {
  const events = [ev({ id: 'i1', ts: '2026-08-02T01:00:00.000Z', behaviorId: 'b-talk', delta: -1, kind: 'improve' })];
  assert.deepEqual(positiveRecords(events, 's1'), []);
});

// ----------------------------------------------------------- ensureRewards

test('ensureRewards：清單空的時候補上預設品項並寫回', () => {
  const saved = [];
  const store = { getRewards: async () => [], saveRewards: async (r) => saved.push(r) };
  return ensureRewards(store).then((out) => {
    assert.deepEqual(out.map((r) => r.id), DEFAULT_REWARDS.map((r) => r.id));
    assert.equal(saved.length, 1, '預設品項必須真的存下去，不然每次進商店都重補一次');
  });
});

test('ensureRewards：已經有品項就原封不動回傳，絕不覆寫老師改過的定價', () => {
  const mine = [{ id: 'r-mine', name: '掃地免一天', cost: 15, stock: null, active: true }];
  let wrote = false;
  const store = { getRewards: async () => mine, saveRewards: async () => { wrote = true; } };
  return ensureRewards(store).then((out) => {
    assert.deepEqual(out, mine);
    assert.equal(wrote, false, '不該覆寫既有清單');
  });
});

test('ensureRewards：補進去的是副本，改動不得污染 DEFAULT_REWARDS', () => {
  const store = { getRewards: async () => [], saveRewards: async () => {} };
  return ensureRewards(store).then((out) => {
    out[0].cost = 999;
    assert.equal(DEFAULT_REWARDS[0].cost, 8);
  });
});

// ----------------------------------------------------------------- rankRows

test('rankRows：班級榜的淨分含兌換扣點，花掉的點數要真的從榜上消失', () => {
  const events = [
    ev({ id: 'a', ts: '2026-08-01T01:00:00.000Z', studentId: 's1', delta: 20, kind: 'positive' }),
    ev({ id: 'r', ts: '2026-08-02T01:00:00.000Z', studentId: 's1', behaviorId: 'r-nohw', delta: -20, kind: 'redeem' }),
    ev({ id: 'b', ts: '2026-08-01T01:00:00.000Z', studentId: 's2', delta: 5, kind: 'positive' }),
  ];
  const rows = rankRows(events, students);
  assert.equal(rows[0].student.id, 's2');
  assert.equal(rows.find((r) => r.student.id === 's1').net, 0);
});
