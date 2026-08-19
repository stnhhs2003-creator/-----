/*
 * js/rules.js 的純函式層直接測試。
 *
 * 這一層是整個站的地基：座位表的分數、趨勢圖、告急名單、保存期限提醒
 * 全部由它算出來。之前只有 parentView() 有直接測試，其餘都靠頁面間接踩過。
 *
 * 時區固定成 Asia/Taipei。這不是裝飾——rules.js 開頭那段註解說得很清楚：
 * 台灣是 UTC+8，早自習 08:00 前的事件在 ISO 字串裡屬於「前一天」。
 * 不釘住時區，這幾條測試在別台機器上會得到不同答案，等於沒測。
 * node --test 每個檔案跑在獨立子行程，這裡改 TZ 不會波及其他測試檔。
 */

process.env.TZ = 'Asia/Taipei';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  localDay,
  startOfDay,
  daysAgoISO,
  scoreByStudent,
  countsByStudent,
  dailyTotals,
  detectAlerts,
  expiredClasses,
} from '../js/rules.js';

const ev = (o) => ({
  id: o.id,
  ts: o.ts,
  classId: o.classId || 'c701',
  studentId: o.studentId || 's1',
  behaviorId: o.behaviorId || 'b1',
  delta: o.delta,
  kind: o.kind,
  period: o.period || '第1節',
  note: o.note || '',
  voided: o.voided || false,
});

/** 相對於「現在」的時間戳。dailyTotals 內部直接用 new Date()，只能這樣配合。 */
const atDaysAgo = (n, hour = 10) => {
  const d = startOfDay();
  d.setDate(d.getDate() - n);
  d.setHours(hour);
  return d.toISOString();
};

const SETTINGS = {
  alertConsecutiveImprove: 3,
  alertConsecutiveWindowDays: 7,
  alertClassImprovePerPeriod: 4,
};

// ---------------------------------------------------------------- localDay

test('localDay：台北早自習 07:30 算當天，不能被 ISO 字串騙成前一天', () => {
  // 2026-08-02T23:30Z 在台北是 8/3 07:30——正是早自習。
  assert.equal(localDay('2026-08-02T23:30:00.000Z'), '2026-08-03');
});

test('localDay：跨年也要用本地日，12/31 16:00Z 在台北已經是隔年 1/1', () => {
  assert.equal(localDay('2026-12-31T16:00:00.000Z'), '2027-01-01');
});

// -------------------------------------------------------------- startOfDay

test('startOfDay：不得改動呼叫端傳進來的 Date 物件', () => {
  const src = new Date('2026-08-10T15:20:30.000+08:00');
  const before = src.getTime();
  startOfDay(src);
  assert.equal(src.getTime(), before, 'startOfDay 不該有副作用');
});

// -------------------------------------------------------------- daysAgoISO

test('daysAgoISO：跨月回推要真的跨過去（3/3 往前 5 天 = 2/26）', () => {
  const iso = daysAgoISO(5, new Date('2026-03-03T12:00:00+08:00'));
  assert.equal(localDay(iso), '2026-02-26');
});

test('daysAgoISO：跨年回推（2027/1/2 往前 5 天 = 2026/12/28）', () => {
  const iso = daysAgoISO(5, new Date('2027-01-02T12:00:00+08:00'));
  assert.equal(localDay(iso), '2026-12-28');
});

test('daysAgoISO：n = 0 是今天的 00:00，不是此刻', () => {
  const now = new Date('2026-08-10T15:20:30.000+08:00');
  assert.equal(daysAgoISO(0, now), new Date('2026-08-10T00:00:00.000+08:00').toISOString());
});

// --------------------------------------------------------- scoreByStudent

test('scoreByStudent：空陣列回空 Map，沒紀錄的學生查不到 key（不是 0）', () => {
  const m = scoreByStudent([]);
  assert.equal(m.size, 0);
  assert.equal(m.get('s1'), undefined);
});

test('scoreByStudent：兌換的負 delta 要進餘額——點數花掉就是花掉了', () => {
  const m = scoreByStudent([
    ev({ id: 'a', ts: '2026-08-01T01:00:00.000Z', studentId: 's1', delta: 10, kind: 'positive' }),
    ev({ id: 'b', ts: '2026-08-02T01:00:00.000Z', studentId: 's1', delta: -8, kind: 'redeem' }),
    ev({ id: 'c', ts: '2026-08-03T01:00:00.000Z', studentId: 's1', delta: 0, kind: 'redeem-request' }),
  ]);
  assert.equal(m.get('s1'), 2);
});

// -------------------------------------------------------- countsByStudent

test('countsByStudent：兌換與兌換申請一律不進行為統計', () => {
  const m = countsByStudent([
    ev({ id: 'a', ts: '2026-08-01T01:00:00.000Z', delta: 2, kind: 'positive' }),
    ev({ id: 'b', ts: '2026-08-01T02:00:00.000Z', delta: -1, kind: 'improve' }),
    ev({ id: 'c', ts: '2026-08-01T03:00:00.000Z', delta: -8, kind: 'redeem' }),
    ev({ id: 'd', ts: '2026-08-01T04:00:00.000Z', delta: 0, kind: 'redeem-request' }),
  ]);
  assert.deepEqual(m.get('s1'), { positive: 1, improve: 1 });
});

test('countsByStudent：只有一種行為時，另一邊要是 0 而不是 undefined', () => {
  const m = countsByStudent([
    ev({ id: 'a', ts: '2026-08-01T01:00:00.000Z', delta: 2, kind: 'positive' }),
  ]);
  assert.deepEqual(m.get('s1'), { positive: 1, improve: 0 });
});

// ------------------------------------------------------------ dailyTotals

test('dailyTotals：桶數等於 days，而且最後一桶是今天', () => {
  const buckets = dailyTotals([], 5);
  assert.equal(buckets.length, 5);
  assert.equal(localDay(buckets[4].date), localDay(new Date()));
  assert.equal(localDay(buckets[0].date), localDay(new Date(atDaysAgo(4))));
});

test('dailyTotals：improve 記絕對值、net 記原值，兩者不可混為一談', () => {
  const buckets = dailyTotals([
    ev({ id: 'a', ts: atDaysAgo(0), delta: 3, kind: 'positive' }),
    ev({ id: 'b', ts: atDaysAgo(0), delta: -2, kind: 'improve' }),
  ], 3);
  const today = buckets[2];
  assert.equal(today.positive, 3);
  assert.equal(today.improve, 2, 'improve 應該是絕對值');
  assert.equal(today.net, 1, 'net 應該是 3 + (-2)');
});

test('dailyTotals：窗外的舊事件不得落進任何一桶', () => {
  const buckets = dailyTotals([
    ev({ id: 'old', ts: atDaysAgo(30), delta: 5, kind: 'positive' }),
  ], 7);
  assert.equal(buckets.reduce((s, b) => s + b.net, 0), 0);
});

test('dailyTotals：台北早自習 07:30 的事件要落在「今天」那一桶', () => {
  const d = startOfDay();
  d.setHours(7, 30);
  const buckets = dailyTotals([
    ev({ id: 'am', ts: d.toISOString(), delta: 2, kind: 'positive' }),
  ], 7);
  assert.equal(buckets[6].positive, 2, '早自習的事件被算到別天去了');
});

// ------------------------------------------------------------ detectAlerts

test('detectAlerts：沒有事件就沒有告急', () => {
  assert.deepEqual(detectAlerts([], [], SETTINGS, new Date('2026-08-10T12:00:00+08:00')), []);
});

test('detectAlerts：中間有正向打斷就不算連續，不該上榜', () => {
  const now = new Date('2026-08-10T12:00:00+08:00');
  const events = [
    ev({ id: '1', ts: '2026-08-08T01:00:00.000Z', delta: -1, kind: 'improve' }),
    ev({ id: '2', ts: '2026-08-08T02:00:00.000Z', delta: -1, kind: 'improve' }),
    ev({ id: '3', ts: '2026-08-08T03:00:00.000Z', delta: 2, kind: 'positive' }),
    ev({ id: '4', ts: '2026-08-09T01:00:00.000Z', delta: -1, kind: 'improve' }),
    ev({ id: '5', ts: '2026-08-09T02:00:00.000Z', delta: -1, kind: 'improve' }),
  ];
  const alerts = detectAlerts(events, [{ id: 's1', name: '甲' }], SETTINGS, now);
  assert.deepEqual(alerts.filter((a) => a.level === 'student'), []);
});

test('detectAlerts：連續達標就上榜，標題要有名字與次數', () => {
  const now = new Date('2026-08-10T12:00:00+08:00');
  const events = [1, 2, 3].map((i) =>
    ev({ id: `i${i}`, ts: `2026-08-09T0${i}:00:00.000Z`, delta: -1, kind: 'improve', period: '第3節' }));
  const alerts = detectAlerts(events, [{ id: 's1', name: '謝欣妤' }], SETTINGS, now);
  const mine = alerts.filter((a) => a.level === 'student');
  assert.equal(mine.length, 1);
  assert.match(mine[0].title, /謝欣妤 連續 3 次待改進/);
  assert.equal(mine[0].studentId, 's1');
});

test('detectAlerts：now 參數要真的把觀察窗移過去（週報回看上一週靠這個）', () => {
  const events = [1, 2, 3].map((i) =>
    ev({ id: `i${i}`, ts: `2026-08-09T0${i}:00:00.000Z`, delta: -1, kind: 'improve' }));
  const students = [{ id: 's1', name: '甲' }];

  const inside = detectAlerts(events, students, SETTINGS, new Date('2026-08-10T12:00:00+08:00'));
  assert.equal(inside.filter((a) => a.level === 'student').length, 1, '錨在那一週應該看得到');

  const later = detectAlerts(events, students, SETTINGS, new Date('2026-09-20T12:00:00+08:00'));
  assert.deepEqual(later, [], '錨點往後移一個月，那一週的事件就該落在窗外');
});

test('detectAlerts：不帶 now 時預設錨在此刻，昨天的連續待改進要撈得到', () => {
  const events = [1, 2, 3].map((i) =>
    ev({ id: `i${i}`, ts: atDaysAgo(1, 8 + i), delta: -1, kind: 'improve' }));
  const alerts = detectAlerts(events, [{ id: 's1', name: '甲' }], SETTINGS);
  assert.equal(alerts.filter((a) => a.level === 'student').length, 1);
});

test('detectAlerts：兌換事件既不計次也不打斷連續', () => {
  const now = new Date('2026-08-10T12:00:00+08:00');
  const events = [
    ev({ id: '1', ts: '2026-08-09T01:00:00.000Z', delta: -1, kind: 'improve' }),
    ev({ id: '2', ts: '2026-08-09T02:00:00.000Z', delta: -8, kind: 'redeem' }),
    ev({ id: '3', ts: '2026-08-09T03:00:00.000Z', delta: 0, kind: 'redeem-request' }),
    ev({ id: '4', ts: '2026-08-09T04:00:00.000Z', delta: -1, kind: 'improve' }),
    ev({ id: '5', ts: '2026-08-09T05:00:00.000Z', delta: -1, kind: 'improve' }),
  ];
  const alerts = detectAlerts(events, [{ id: 's1', name: '甲' }], SETTINGS, now);
  const mine = alerts.filter((a) => a.level === 'student');
  assert.equal(mine.length, 1, '兌換不該把連續三次切斷');
  assert.match(mine[0].title, /連續 3 次/);
});

test('detectAlerts：同一天同一節課全班達標會產生班級層級告急', () => {
  const now = new Date('2026-08-10T12:00:00+08:00');
  const events = [1, 2, 3, 4].map((i) =>
    ev({ id: `c${i}`, ts: `2026-08-09T0${i}:00:00.000Z`, studentId: `s${i}`, delta: -1, kind: 'improve', period: '第5節' }));
  const alerts = detectAlerts(events, [], SETTINGS, now);
  const cls = alerts.filter((a) => a.level === 'class');
  assert.equal(cls.length, 1);
  assert.match(cls[0].title, /第5節 全班待改進 4 次/);
});

test('detectAlerts：不同節次分開計，不會湊在一起達標', () => {
  const now = new Date('2026-08-10T12:00:00+08:00');
  const events = [1, 2, 3, 4].map((i) =>
    ev({ id: `c${i}`, ts: `2026-08-09T0${i}:00:00.000Z`, studentId: `s${i}`, delta: -1, kind: 'improve', period: `第${i}節` }));
  const alerts = detectAlerts(events, [], SETTINGS, now);
  assert.deepEqual(alerts.filter((a) => a.level === 'class'), []);
});

test('detectAlerts：門檻被設成 0 也不能整頁炸掉（還原備份可能帶進這種設定）', () => {
  const events = [ev({ id: 'p', ts: '2026-08-09T01:00:00.000Z', delta: 2, kind: 'positive' })];
  const settings = { ...SETTINGS, alertConsecutiveImprove: 0 };
  assert.doesNotThrow(() => {
    detectAlerts(events, [{ id: 's1', name: '甲' }], settings, new Date('2026-08-10T12:00:00+08:00'));
  }, '座位表的告急區一炸，整頁就不會 render');
});

// --------------------------------------------------------- expiredClasses

test('expiredClasses：沒設保存期限（0）就不提醒任何班級', () => {
  const classes = [{ id: 'c1', name: '七年一班' }];
  const events = [ev({ id: 'a', ts: '2020-01-01T00:00:00.000Z', classId: 'c1', delta: 2, kind: 'positive' })];
  assert.deepEqual(expiredClasses(classes, events, 0, new Date('2026-08-10T12:00:00+08:00')), []);
});

test('expiredClasses：完全沒有紀錄的班級不算逾期——那只是還沒開始用', () => {
  const classes = [{ id: 'c1', name: '空班' }];
  assert.deepEqual(expiredClasses(classes, [], 12, new Date('2026-08-10T12:00:00+08:00')), []);
});

test('expiredClasses：回推月份不得因月底溢位而提早判定逾期', () => {
  // 站在 3/31、保存期限一個月，界線應該是 2/28（或 2/29）。
  // 3/1 還在一個月內，不該被叫去刪——刪掉就是真的把學生紀錄刪了。
  const classes = [{ id: 'c1', name: '七年一班' }];
  const events = [ev({ id: 'a', ts: '2026-03-01T02:00:00.000Z', classId: 'c1', delta: 2, kind: 'positive' })];
  const out = expiredClasses(classes, events, 1, new Date('2026-03-31T12:00:00+08:00'));
  assert.deepEqual(out, [], '3/1 的紀錄在 3/31 時只過了 30 天，還沒滿一個月');
});

test('expiredClasses：真的逾期就要撈出來，並帶上最後紀錄時間與筆數', () => {
  const classes = [{ id: 'c1', name: '七年一班' }, { id: 'c2', name: '七年二班' }];
  const events = [
    ev({ id: 'a', ts: '2024-01-01T02:00:00.000Z', classId: 'c1', delta: 2, kind: 'positive' }),
    ev({ id: 'b', ts: '2024-02-01T02:00:00.000Z', classId: 'c1', delta: 2, kind: 'positive' }),
    ev({ id: 'c', ts: '2026-08-01T02:00:00.000Z', classId: 'c2', delta: 2, kind: 'positive' }),
  ];
  const out = expiredClasses(classes, events, 12, new Date('2026-08-10T12:00:00+08:00'));
  assert.deepEqual(out, [{ classId: 'c1', name: '七年一班', lastTs: '2024-02-01T02:00:00.000Z', count: 2 }]);
});
