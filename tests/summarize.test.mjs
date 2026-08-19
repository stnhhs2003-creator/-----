/*
 * js/summarize.js 的事實層測試。
 *
 * 第三期三個文字功能（學期評語 3.1／親師草稿 3.2／導師週報 3.3）全部從這裡取材，
 * 而且這包 JSON 同時是 AI 潤稿的「數字白名單」——這裡算錯一個數字，
 * 錯的數字會直接被寫進給家長看的評語裡，而且會通過伺服器端的防虛構檢查，
 * 因為它「有出現在事實包裡」。所以這一層算錯比別處算錯更難被發現。
 *
 * 時區固定 Asia/Taipei，理由同 rules.test.mjs。
 */

process.env.TZ = 'Asia/Taipei';

import test from 'node:test';
import assert from 'node:assert/strict';

import { inRange, studentFacts, classFacts } from '../js/summarize.js';

const ev = (o) => ({
  id: o.id,
  ts: o.ts,
  classId: o.classId || 'c701',
  studentId: o.studentId || 's1',
  behaviorId: o.behaviorId || 'b-speak',
  delta: o.delta,
  kind: o.kind,
  period: o.period || '第1節',
  note: o.note || '',
  voided: o.voided || false,
});

const BEHAVIORS = [
  { id: 'b-speak', label: '主動發言' },
  { id: 'b-help', label: '幫助同學' },
  { id: 'b-talk', label: '上課聊天' },
];

const STUDENT = { id: 's1', no: 7, name: '謝欣妤' };

// ------------------------------------------------------------------ inRange

test('inRange：since 與 until 都是閉區間，剛好落在端點的事件要留下', () => {
  const events = [
    ev({ id: 'a', ts: '2026-08-01T00:00:00.000Z', delta: 2, kind: 'positive' }),
    ev({ id: 'b', ts: '2026-08-05T00:00:00.000Z', delta: 2, kind: 'positive' }),
    ev({ id: 'c', ts: '2026-08-10T00:00:00.000Z', delta: 2, kind: 'positive' }),
  ];
  const out = inRange(events, { since: '2026-08-01T00:00:00.000Z', until: '2026-08-10T00:00:00.000Z' });
  assert.deepEqual(out.map((e) => e.id), ['a', 'b', 'c']);
});

test('inRange：已撤銷的事件一律不留，即使落在區間正中央', () => {
  const events = [
    ev({ id: 'a', ts: '2026-08-05T00:00:00.000Z', delta: 2, kind: 'positive' }),
    ev({ id: 'v', ts: '2026-08-05T01:00:00.000Z', delta: 2, kind: 'positive', voided: true }),
  ];
  assert.deepEqual(inRange(events, {}).map((e) => e.id), ['a']);
});

test('inRange：不給 since／until 就只濾撤銷，其餘全留', () => {
  const events = [
    ev({ id: 'a', ts: '2020-01-01T00:00:00.000Z', delta: 2, kind: 'positive' }),
    ev({ id: 'b', ts: '2030-01-01T00:00:00.000Z', delta: 2, kind: 'positive' }),
  ];
  assert.equal(inRange(events).length, 2);
});

// ------------------------------------------------------------ studentFacts

test('studentFacts：別的學生的事件不得混進來', () => {
  const events = [
    ev({ id: 'a', ts: '2026-08-01T01:00:00.000Z', studentId: 's1', delta: 2, kind: 'positive' }),
    ev({ id: 'b', ts: '2026-08-01T02:00:00.000Z', studentId: 's2', delta: 5, kind: 'positive' }),
  ];
  const f = studentFacts({ events, student: STUDENT, behaviors: BEHAVIORS });
  assert.equal(f.totals.positive, 1);
  assert.equal(f.totals.positivePoints, 2);
});

test('studentFacts：兌換不進 totals，但要出現在 redeemed 讓老師知道點數花到哪', () => {
  const events = [
    ev({ id: 'a', ts: '2026-08-01T01:00:00.000Z', delta: 10, kind: 'positive' }),
    ev({ id: 'r', ts: '2026-08-02T01:00:00.000Z', behaviorId: 'r-nohw', delta: -8, kind: 'redeem', note: '免作業券' }),
    ev({ id: 'q', ts: '2026-08-03T01:00:00.000Z', behaviorId: 'r-nohw', delta: 0, kind: 'redeem-request' }),
  ];
  const f = studentFacts({ events, student: STUDENT, behaviors: BEHAVIORS });
  assert.equal(f.totals.net, 10, '兌換不該把行為淨分拉低');
  assert.deepEqual(f.redeemed, [{ ts: '2026-08-02', label: '免作業券' }]);
});

test('studentFacts：improvePoints 是絕對值，net 是加總後的原值', () => {
  const events = [
    ev({ id: 'a', ts: '2026-08-01T01:00:00.000Z', delta: 6, kind: 'positive' }),
    ev({ id: 'b', ts: '2026-08-02T01:00:00.000Z', behaviorId: 'b-talk', delta: -2, kind: 'improve' }),
    ev({ id: 'c', ts: '2026-08-03T01:00:00.000Z', behaviorId: 'b-talk', delta: -1, kind: 'improve' }),
  ];
  const f = studentFacts({ events, student: STUDENT, behaviors: BEHAVIORS });
  assert.equal(f.totals.improvePoints, 3);
  assert.equal(f.totals.net, 3);
});

test('studentFacts：一筆紀錄都沒有的學生也要能出評語骨架，不能炸也不能出 NaN', () => {
  const f = studentFacts({ events: [], student: STUDENT, behaviors: BEHAVIORS });
  assert.deepEqual(f.totals, { positive: 0, improve: 0, positivePoints: 0, improvePoints: 0, net: 0 });
  assert.equal(f.activeDays, 0);
  assert.deepEqual(f.positiveTop, []);
  assert.ok(Number.isFinite(f.range.days) && f.range.days >= 1);
});

test('studentFacts：notes 只收有備註的，最多 10 筆，而且要是最新的 10 筆', () => {
  const events = Array.from({ length: 14 }, (_, i) =>
    ev({
      id: `n${i}`,
      ts: `2026-08-${String(i + 1).padStart(2, '0')}T01:00:00.000Z`,
      delta: 2,
      kind: 'positive',
      note: `第 ${i} 筆`,
    }));
  const f = studentFacts({ events, student: STUDENT, behaviors: BEHAVIORS });
  assert.equal(f.notes.length, 10);
  assert.equal(f.notes[0].note, '第 4 筆');
  assert.equal(f.notes[9].note, '第 13 筆');
});

test('studentFacts：positiveTop 依次數排序並帶標籤，查不到標籤就退回 id', () => {
  const events = [
    ev({ id: '1', ts: '2026-08-01T01:00:00.000Z', behaviorId: 'b-help', delta: 2, kind: 'positive' }),
    ev({ id: '2', ts: '2026-08-02T01:00:00.000Z', behaviorId: 'b-help', delta: 2, kind: 'positive' }),
    ev({ id: '3', ts: '2026-08-03T01:00:00.000Z', behaviorId: 'b-speak', delta: 2, kind: 'positive' }),
    ev({ id: '4', ts: '2026-08-04T01:00:00.000Z', behaviorId: 'b-deleted', delta: 2, kind: 'positive' }),
  ];
  const f = studentFacts({ events, student: STUDENT, behaviors: BEHAVIORS });
  assert.deepEqual(f.positiveTop, [
    { behaviorId: 'b-help', label: '幫助同學', count: 2 },
    { behaviorId: 'b-speak', label: '主動發言', count: 1 },
    { behaviorId: 'b-deleted', label: 'b-deleted', count: 1 },
  ]);
});

test('studentFacts：activeDays 要用台灣當地日——早自習與下午同屬一天', () => {
  // 2026-08-09T23:30Z = 台北 8/10 07:30（早自習）；2026-08-10T06:00Z = 台北 8/10 14:00。
  // 同一天的兩筆紀錄，活躍天數只能是 1。
  const events = [
    ev({ id: 'am', ts: '2026-08-09T23:30:00.000Z', delta: 2, kind: 'positive' }),
    ev({ id: 'pm', ts: '2026-08-10T06:00:00.000Z', delta: 2, kind: 'positive' }),
  ];
  const f = studentFacts({ events, student: STUDENT, behaviors: BEHAVIORS });
  assert.equal(f.activeDays, 1, '早自習的紀錄被算成另外一天了');
});

test('studentFacts：只有一天的資料不得宣稱「進步」——一天沒有趨勢可言', () => {
  const events = [1, 2, 3].map((i) =>
    ev({ id: `d${i}`, ts: `2026-08-10T0${i}:00:00.000Z`, delta: 2, kind: 'positive' }));
  const f = studentFacts({ events, student: STUDENT, behaviors: BEHAVIORS });
  assert.equal(f.trend.direction, 'flat', '單日資料被判成有趨勢，評語會憑空說孩子進步');
});

test('studentFacts：兌換不得撐大趨勢的比較區間，把「持平」扭成「退步」', () => {
  // 月初拿了兩張正向卡（5 + 5），月底去商店把點數花掉。
  // 行為表現從頭到尾一樣，趨勢就該是 flat；兌換只是花錢，不是變差。
  const events = [
    ev({ id: 'a', ts: '2026-08-01T01:00:00.000Z', delta: 5, kind: 'positive' }),
    ev({ id: 'b', ts: '2026-08-03T01:00:00.000Z', delta: 5, kind: 'positive' }),
    ev({ id: 'r', ts: '2026-08-30T01:00:00.000Z', behaviorId: 'r-nohw', delta: -8, kind: 'redeem', note: '免作業券' }),
  ];
  const f = studentFacts({ events, student: STUDENT, behaviors: BEHAVIORS });
  assert.equal(f.trend.direction, 'flat', '去商店換東西讓學期評語說孩子退步了');
});

test('studentFacts：後半段明顯變好才說 up', () => {
  const events = [
    ev({ id: 'a', ts: '2026-08-01T01:00:00.000Z', behaviorId: 'b-talk', delta: -2, kind: 'improve' }),
    ev({ id: 'b', ts: '2026-08-03T01:00:00.000Z', behaviorId: 'b-talk', delta: -2, kind: 'improve' }),
    ev({ id: 'c', ts: '2026-08-25T01:00:00.000Z', delta: 4, kind: 'positive' }),
    ev({ id: 'd', ts: '2026-08-28T01:00:00.000Z', delta: 4, kind: 'positive' }),
  ];
  const f = studentFacts({ events, student: STUDENT, behaviors: BEHAVIORS });
  assert.equal(f.trend.direction, 'up');
});

test('studentFacts：小幅波動維持 flat，差一兩分不算趨勢', () => {
  const events = [
    ev({ id: 'a', ts: '2026-08-01T01:00:00.000Z', delta: 4, kind: 'positive' }),
    ev({ id: 'b', ts: '2026-08-05T01:00:00.000Z', delta: 4, kind: 'positive' }),
    ev({ id: 'c', ts: '2026-08-25T01:00:00.000Z', delta: 5, kind: 'positive' }),
    ev({ id: 'd', ts: '2026-08-28T01:00:00.000Z', delta: 4, kind: 'positive' }),
  ];
  const f = studentFacts({ events, student: STUDENT, behaviors: BEHAVIORS });
  assert.equal(f.trend.direction, 'flat');
});

// -------------------------------------------------------------- classFacts

const CLS = {
  id: 'c701',
  name: '七年一班',
  students: [{ id: 's1', no: 7, name: '謝欣妤' }, { id: 's2', no: 12, name: '林建佑' }],
};

test('classFacts：totals 只含行為事件，兌換扣點不得被讀成班級退步', () => {
  const events = [
    ev({ id: 'a', ts: '2026-08-01T01:00:00.000Z', studentId: 's1', delta: 3, kind: 'positive' }),
    ev({ id: 'b', ts: '2026-08-02T01:00:00.000Z', studentId: 's2', behaviorId: 'b-talk', delta: -1, kind: 'improve' }),
    ev({ id: 'r', ts: '2026-08-03T01:00:00.000Z', studentId: 's1', delta: -20, kind: 'redeem' }),
  ];
  const f = classFacts({ events, cls: CLS, behaviors: BEHAVIORS });
  assert.deepEqual(f.totals, { positive: 1, improve: 1, net: 2 });
});

test('classFacts：完全沒有行為事件時 positiveRatio 是 0，不能是 NaN', () => {
  const f = classFacts({ events: [], cls: CLS, behaviors: BEHAVIORS });
  assert.equal(f.positiveRatio, 0);
  assert.equal(f.students, 2);
});

test('classFacts：perStudent 要涵蓋全班，沒紀錄的學生也要在名單上而且是 0', () => {
  const events = [
    ev({ id: 'a', ts: '2026-08-01T01:00:00.000Z', studentId: 's1', delta: 3, kind: 'positive' }),
  ];
  const f = classFacts({ events, cls: CLS, behaviors: BEHAVIORS });
  assert.deepEqual(f.perStudent, [
    { id: 's1', no: 7, name: '謝欣妤', positive: 1, improve: 0, net: 3 },
    { id: 's2', no: 12, name: '林建佑', positive: 0, improve: 0, net: 0 },
  ]);
});

test('classFacts：別班的事件不得混進來', () => {
  const events = [
    ev({ id: 'a', ts: '2026-08-01T01:00:00.000Z', classId: 'c701', studentId: 's1', delta: 3, kind: 'positive' }),
    ev({ id: 'b', ts: '2026-08-01T02:00:00.000Z', classId: 'c702', studentId: 's9', delta: 9, kind: 'positive' }),
  ];
  const f = classFacts({ events, cls: CLS, behaviors: BEHAVIORS });
  assert.equal(f.totals.net, 3);
});

test('classFacts：已撤銷的事件不進任何統計，包含 positiveRatio', () => {
  const events = [
    ev({ id: 'a', ts: '2026-08-01T01:00:00.000Z', studentId: 's1', delta: 3, kind: 'positive' }),
    ev({ id: 'v', ts: '2026-08-01T02:00:00.000Z', studentId: 's2', behaviorId: 'b-talk', delta: -1, kind: 'improve', voided: true }),
  ];
  const f = classFacts({ events, cls: CLS, behaviors: BEHAVIORS });
  assert.equal(f.totals.improve, 0);
  assert.equal(f.positiveRatio, 1);
});
