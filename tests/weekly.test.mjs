/*
 * 導師手札週報（ROADMAP 3.3）。
 *
 * 驗收條件是「名單依告急規則產生，非 AI 自由發揮」，所以這裡最重要的一組測試
 * 是把 detectAlerts 的門檻換掉，看名單會不會跟著變——會變，才證明名單真的來自
 * 規則引擎，而不是週報自己另外寫了一套判斷（或哪天被人偷換成 AI 挑人）。
 *
 * 其餘四組守的是這個功能最容易腐化的地方：
 *   - 數字都追溯得回事實包（不能有憑空冒出來的統計）
 *   - 空白週誠實說沒事（不硬擠觀察）
 *   - 任意一週都能回顧（老師常是週末、月底才補看）
 *   - 需關心名單附得出「為什麼上榜」與具體事件
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { weekBounds, alertsForWeek, buildWeeklyDraft } from '../js/weekly.js';
import { classFacts } from '../js/summarize.js';

/* ---------- 固定裝置 ---------- */

const BEHAVIORS = [
  { id: 'b-speak', label: '主動發言', delta: 2, kind: 'positive' },
  { id: 'b-help', label: '幫助同學', delta: 3, kind: 'positive' },
  { id: 'b-talk', label: '課堂講話', delta: -1, kind: 'improve' },
  { id: 'b-nohw', label: '未交作業', delta: -2, kind: 'improve' },
  { id: 'b-late', label: '遲到', delta: -1, kind: 'improve' },
];

const CLS = {
  id: 'c1',
  name: '七年一班',
  students: [
    { id: 's1', no: 1, name: '王小明' },
    { id: 's2', no: 2, name: '陳小美' },
    { id: 's3', no: 3, name: '林大同' },
  ],
};

const SETTINGS = {
  alertConsecutiveImprove: 3,
  alertConsecutiveWindowDays: 7,
  alertClassImprovePerPeriod: 5,
};

let seq = 0;

/** 在某一週的第 dayIndex 天（0 = 週一）造一筆事件。 */
function evt({ week, dayIndex, hour = 9, studentId, behaviorId, period = '第1節', note = '' }) {
  const b = BEHAVIORS.find((x) => x.id === behaviorId);
  const d = new Date(week.startDate);
  d.setDate(d.getDate() + dayIndex);
  d.setHours(hour, 0, 0, 0);
  return {
    id: `e${seq++}`,
    ts: d.toISOString(),
    classId: CLS.id,
    studentId,
    behaviorId,
    delta: b.delta,
    kind: b.kind,
    period,
    note,
    voided: false,
  };
}

/** 走完整條產線：事件 → classFacts + alertsForWeek → buildWeeklyDraft。 */
function draftFor(events, week, settings = SETTINGS) {
  const weekEvents = events.filter((e) => !e.voided && e.ts >= week.since && e.ts <= week.until);
  const facts = classFacts({
    events,
    cls: CLS,
    behaviors: BEHAVIORS,
    since: week.since,
    until: week.until,
  });
  const alerts = alertsForWeek({
    events,
    students: CLS.students,
    settings,
    since: week.since,
    until: week.until,
  });
  return {
    facts,
    alerts,
    draft: buildWeeklyDraft({
      facts,
      alerts,
      events: weekEvents,
      behaviors: BEHAVIORS,
      settings,
      weekLabel: week.label,
    }),
  };
}

/** s1 連續三次待改進；另外補幾筆正向讓比例好看。 */
function scenario(week) {
  return [
    evt({ week, dayIndex: 0, hour: 8, studentId: 's2', behaviorId: 'b-speak' }),
    evt({ week, dayIndex: 0, hour: 9, studentId: 's1', behaviorId: 'b-talk', period: '第2節', note: '上課跟隔壁聊天' }),
    evt({ week, dayIndex: 1, hour: 10, studentId: 's3', behaviorId: 'b-help' }),
    evt({ week, dayIndex: 1, hour: 11, studentId: 's1', behaviorId: 'b-nohw', period: '第3節' }),
    evt({ week, dayIndex: 2, hour: 9, studentId: 's2', behaviorId: 'b-speak' }),
    evt({ week, dayIndex: 2, hour: 13, studentId: 's1', behaviorId: 'b-talk', period: '早自習', note: '早自習講不停' }),
    evt({ week, dayIndex: 3, hour: 9, studentId: 's3', behaviorId: 'b-speak' }),
  ];
}

/* ---------- 1. 名單來自告急規則 ---------- */

test('需關心名單來自 detectAlerts：換掉告急門檻，名單就跟著變', () => {
  const week = weekBounds(0);
  const events = scenario(week);

  // 門檻 = 連續 3 次 → s1 剛好達標
  const strict = draftFor(events, week, SETTINGS);
  assert.deepEqual(strict.draft.watchlist.map((w) => w.studentId), ['s1']);

  // 門檻拉到 4 次 → 同一批事件，沒有人該上榜
  const loose = draftFor(events, week, { ...SETTINGS, alertConsecutiveImprove: 4 });
  assert.deepEqual(loose.draft.watchlist, []);

  // 門檻降到 2 次 → s1 仍在，而且名單完全等於 detectAlerts 吐出來的學生層告急
  const wide = draftFor(events, week, { ...SETTINGS, alertConsecutiveImprove: 2 });
  assert.deepEqual(
    wide.draft.watchlist.map((w) => w.studentId),
    wide.alerts.filter((a) => a.level === 'student').map((a) => a.studentId)
  );
});

test('名單是空的時候要明講「沒有人達標」，不是靜靜略過', () => {
  const week = weekBounds(0);
  const { draft } = draftFor(scenario(week), week, { ...SETTINGS, alertConsecutiveImprove: 9 });
  const sec = draft.sections.find((s) => s.id === 'watchlist');
  assert.ok(sec, '就算沒人上榜，需關心名單這一段也要在');
  assert.match(sec.items[0].text, /沒有人達到告急門檻/);
  assert.match(draft.text, /這是好消息，不是漏掉了/);
});

test('班級層告急（同一節課全班待改進達標）也走同一套規則', () => {
  const week = weekBounds(0);
  const noisy = ['s1', 's2', 's3'].map((sid, i) => evt({
    week, dayIndex: 1, hour: 14, studentId: sid, behaviorId: 'b-talk', period: '第5節',
  })).concat([
    evt({ week, dayIndex: 1, hour: 14, studentId: 's1', behaviorId: 'b-late', period: '第5節' }),
    evt({ week, dayIndex: 1, hour: 14, studentId: 's2', behaviorId: 'b-late', period: '第5節' }),
  ]);

  const hit = draftFor(noisy, week, { ...SETTINGS, alertClassImprovePerPeriod: 5 });
  assert.ok(hit.draft.sections.some((s) => s.id === 'classAlerts'), '達標時要列出全班節奏');

  const miss = draftFor(noisy, week, { ...SETTINGS, alertClassImprovePerPeriod: 6 });
  assert.ok(!miss.draft.sections.some((s) => s.id === 'classAlerts'), '沒達標就不要生出這一段');
});

/* ---------- 2. 數字都追溯得到 ---------- */

test('週報裡的數字全部來自事實包，沒有憑空生出來的統計', () => {
  const week = weekBounds(0);
  const { facts, draft } = draftFor(scenario(week), week);

  const total = facts.totals.positive + facts.totals.improve;
  assert.equal(total, 7);
  assert.equal(facts.totals.positive, 4);
  assert.equal(facts.totals.improve, 3);

  const numbers = draft.sections
    .find((s) => s.id === 'numbers')
    .items.map((i) => i.text)
    .join(' ');
  assert.match(numbers, new RegExp(`行為紀錄 ${total} 筆`));
  assert.match(numbers, new RegExp(`正向 ${facts.totals.positive} 筆`));
  assert.match(numbers, new RegExp(`待改進 ${facts.totals.improve} 筆`));
  assert.match(numbers, new RegExp(`淨分 ${facts.totals.net} 分`));
  assert.match(numbers, new RegExp(`班上 ${facts.students} 人`));

  // 正向佔比直接引用 classFacts 的 positiveRatio，不另外算一次
  const ratio = draft.sections.find((s) => s.id === 'ratio').items[0].text;
  assert.match(ratio, new RegExp(`${Math.round(facts.positiveRatio * 100)}%`));

  // 行為排行的次數逐項對得回 facts.positiveTop / improveTop
  const top = draft.sections.find((s) => s.id === 'positiveTop').items.map((i) => i.text);
  assert.deepEqual(top, facts.positiveTop.map((b) => `${b.label} ${b.count} 次`));
});

test('統計只數行為事件：兌換與已撤銷的紀錄不會被算進「這一週的數字」', () => {
  const week = weekBounds(0);
  const redeem = {
    ...evt({ week, dayIndex: 2, studentId: 's2', behaviorId: 'b-speak' }),
    kind: 'redeem', behaviorId: 'r-pen', delta: -10, note: '換一支筆',
  };
  const scrapped = { ...evt({ week, dayIndex: 3, studentId: 's3', behaviorId: 'b-talk' }), voided: true };
  const events = [...scenario(week), redeem, scrapped];

  const { facts, draft } = draftFor(events, week);
  const total = facts.totals.positive + facts.totals.improve;

  // 原始事件有 9 筆，但兌換不是「表現」、撤銷的不算，行為統計只有 7 筆
  assert.equal(events.length, 9);
  assert.equal(total, 7);

  const numbers = draft.sections.find((s) => s.id === 'numbers').items.map((i) => i.text).join(' ');
  assert.match(numbers, /行為紀錄 7 筆/);
  assert.doesNotMatch(numbers, /行為紀錄 [89] 筆/);
  assert.match(numbers, new RegExp(`淨分 ${facts.totals.net} 分`));
});

test('正向佔比低於五成時要講成提醒，不是指責老師', () => {
  const week = weekBounds(0);
  const grim = [
    evt({ week, dayIndex: 0, studentId: 's1', behaviorId: 'b-talk' }),
    evt({ week, dayIndex: 1, studentId: 's2', behaviorId: 'b-nohw' }),
    evt({ week, dayIndex: 2, studentId: 's3', behaviorId: 'b-late' }),
    evt({ week, dayIndex: 3, studentId: 's2', behaviorId: 'b-speak' }),
  ];
  const { facts, draft } = draftFor(grim, week);
  assert.ok(facts.positiveRatio < 0.5);
  const line = draft.sections.find((s) => s.id === 'ratio').items[0].text;
  assert.match(line, /不是你帶得不好/);
  assert.match(line, /下週/);

  // 反過來，正向佔比高的時候不該還在講滅火
  const { draft: good } = draftFor(scenario(week), week);
  assert.doesNotMatch(good.sections.find((s) => s.id === 'ratio').items[0].text, /滅火/);
});

/* ---------- 3. 空白週要誠實 ---------- */

test('這一週沒事就說沒事，不硬生五個觀察', () => {
  const week = weekBounds(0);
  const { draft } = draftFor([], week);

  assert.equal(draft.quiet, true);
  assert.equal(draft.sections.length, 1, '空白週只留一段，不要為了填版面補欄位');
  assert.deepEqual(draft.watchlist, []);
  assert.match(draft.text, /沒有任何行為紀錄/);

  // 空白週不該出現任何統計語句或名單段落
  assert.doesNotMatch(draft.text, /正向佔比/);
  assert.doesNotMatch(draft.text, /需要關心的名單/);
  assert.doesNotMatch(draft.text, /最常出現/);
});

test('只有正向、沒有待改進時，不生一個空的待改進排行', () => {
  const week = weekBounds(0);
  const sunny = [
    evt({ week, dayIndex: 0, studentId: 's1', behaviorId: 'b-speak' }),
    evt({ week, dayIndex: 1, studentId: 's2', behaviorId: 'b-help' }),
  ];
  const { draft } = draftFor(sunny, week);
  assert.ok(draft.sections.some((s) => s.id === 'positiveTop'));
  assert.ok(!draft.sections.some((s) => s.id === 'improveTop'));
});

/* ---------- 4. 任意一週都能回顧 ---------- */

test('weekBounds 切的是週一到週日，offset 可以指定上一週', () => {
  const now = new Date(2026, 7, 15, 13, 0, 0); // 2026-08-15 是週六
  const thisWeek = weekBounds(0, now);
  const lastWeek = weekBounds(-1, now);

  assert.equal(thisWeek.startDate.getDay(), 1, '起點是週一');
  assert.equal(thisWeek.endDate.getDay(), 0, '終點是週日');
  assert.equal(thisWeek.label, '2026/08/10（一）～2026/08/16（日）');
  assert.equal(lastWeek.label, '2026/08/03（一）～2026/08/09（日）');

  // 週一 00:00 的 ISO 前十碼在 UTC+8 會是「上週日」，所以標籤不能用字串切
  assert.equal(thisWeek.endDate.getTime() - thisWeek.startDate.getTime(), 7 * 24 * 3600 * 1000 - 1);

  // 傳任意一天當錨點，就會得到那一天所在的那一週
  assert.equal(weekBounds(0, new Date(2026, 7, 5)).label, lastWeek.label);
});

test('回顧上一週時，只算上一週的事，本週的事不會混進來', () => {
  const thisWeek = weekBounds(0);
  const lastWeek = weekBounds(-1);
  const events = [
    ...scenario(lastWeek),
    // 本週再塞一批完全不同的紀錄，看看會不會漏進上一週的報告
    evt({ week: thisWeek, dayIndex: 0, studentId: 's2', behaviorId: 'b-speak' }),
    evt({ week: thisWeek, dayIndex: 0, studentId: 's3', behaviorId: 'b-speak' }),
    evt({ week: thisWeek, dayIndex: 0, studentId: 's3', behaviorId: 'b-help' }),
  ];

  const last = draftFor(events, lastWeek);
  assert.equal(last.facts.totals.positive + last.facts.totals.improve, 7);
  assert.equal(last.draft.weekLabel, lastWeek.label);
  assert.deepEqual(last.draft.watchlist.map((w) => w.studentId), ['s1'],
    '上一週的告急要算得出來，不能因為觀察窗綁死在今天就變成空的');

  const now = draftFor(events, thisWeek);
  assert.equal(now.facts.totals.positive + now.facts.totals.improve, 3);
  assert.deepEqual(now.draft.watchlist, [], '本週沒有人連續待改進');
});

test('已撤銷的紀錄不進週報，也不進告急名單', () => {
  const week = weekBounds(0);
  const events = scenario(week).map((e) => (
    e.studentId === 's1' ? { ...e, voided: true } : e
  ));
  const { facts, draft } = draftFor(events, week);
  assert.equal(facts.totals.improve, 0);
  assert.deepEqual(draft.watchlist, []);
});

/* ---------- 5. 名單附得出理由與具體事件 ---------- */

test('上榜的人要附「為什麼上榜」、本週統計與具體事件，不能只丟名字', () => {
  const week = weekBounds(0);
  const { draft } = draftFor(scenario(week), week);
  const [entry] = draft.watchlist;

  assert.match(entry.text, /1 號 王小明/);

  const sub = entry.sub.join('\n');
  assert.match(sub, /為什麼上榜：王小明 連續 3 次待改進/);
  assert.match(sub, /告急規則門檻：連續 3 次/);
  assert.match(sub, /本週統計：正向 0 次、待改進 3 次、淨分 -4 分/);
  // 重複出現兩次以上才算模式，才點名成切入點
  assert.match(sub, /建議切入點：課堂講話（本週 2 次）。/);

  // 具體事件：日期、節次、行為名稱都要在，老師才知道要談什麼
  assert.match(sub, /早自習　課堂講話：早自習講不停/);
  assert.match(sub, /第3節　未交作業/);
  assert.match(sub, /第2節　課堂講話：上課跟隔壁聊天/);
  assert.equal(entry.sub.filter((s) => /第|早自習/.test(s)).length, 3);

  // 純文字版必須包含同樣的內容，老師複製走的就是這一份
  assert.ok(draft.text.includes('為什麼上榜：王小明 連續 3 次待改進'));
});

test('待改進項目各只出現一次時，不硬挑一個當「建議切入點」', () => {
  const week = weekBounds(0);
  const scattered = [
    evt({ week, dayIndex: 0, studentId: 's1', behaviorId: 'b-talk', period: '第1節' }),
    evt({ week, dayIndex: 1, studentId: 's1', behaviorId: 'b-nohw', period: '第2節' }),
    evt({ week, dayIndex: 2, studentId: 's1', behaviorId: 'b-late', period: '第3節' }),
  ];
  const { draft } = draftFor(scattered, week);
  const sub = draft.watchlist[0].sub.join('\n');
  assert.doesNotMatch(sub, /建議切入點/, '三件事各一次不是模式，不該替老師編一個重點');
  // 但具體事件還是要在，老師自己看得出來
  assert.match(sub, /第3節　遲到/);
});

test('每一份週報都帶著「只給老師自己看」的分界提醒', () => {
  const week = weekBounds(0);
  for (const events of [scenario(week), []]) {
    const { draft } = draftFor(events, week);
    assert.match(draft.privacy, /只給老師自己看/);
    assert.ok(draft.text.includes(draft.privacy), '複製走的純文字版也要帶著這句');
  }
});
