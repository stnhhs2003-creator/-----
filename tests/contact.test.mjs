/*
 * 親師溝通草稿的紅線測試（ROADMAP 3.2）。
 *
 * 這條線的輸出會被一個家長讀到，而內容是他的孩子，所以這裡守的不是「功能有沒有動」，
 * 是「有沒有寫出傷人的東西」。四件事必須是機器擋住的，不是註解裡許的願：
 *
 *   1. 草稿裡的每個數字都追溯得到來源
 *   2. 報憂的草稿一定含正向段落
 *   3. 結論式標籤（人格化／全稱／診斷／比較）進不了輸出
 *   4. 沒選事件就不硬生一份範本
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildContactDraft,
  labelHits,
  scrubText,
  traceNumbers,
  ASK_PLACEHOLDER,
} from '../js/contact.js';
import { studentFacts } from '../js/summarize.js';

/* ---------- 測試素材 ---------- */

const BEHAVIORS = [
  { id: 'b-speak', label: '主動發言', delta: 2, kind: 'positive' },
  { id: 'b-help', label: '幫助同學', delta: 3, kind: 'positive' },
  { id: 'b-talk', label: '課堂講話', delta: -1, kind: 'improve' },
  { id: 'b-nohw', label: '未交作業', delta: -2, kind: 'improve' },
];

const STUDENT = { id: 's1', no: 7, name: '林彥廷' };

const ev = (o) => ({
  id: o.id,
  ts: o.ts,
  classId: 'c701',
  studentId: o.studentId || 's1',
  behaviorId: o.behaviorId,
  delta: o.delta,
  kind: o.kind,
  period: o.period || '第3節',
  note: o.note || '',
  voided: o.voided || false,
});

const POSITIVES = [
  ev({ id: 'p1', ts: '2026-08-04T01:10:00.000Z', behaviorId: 'b-speak', delta: 2, kind: 'positive' }),
  ev({ id: 'p2', ts: '2026-08-06T02:10:00.000Z', behaviorId: 'b-help', delta: 3, kind: 'positive', note: '主動幫轉學生找教室' }),
  ev({ id: 'p3', ts: '2026-08-07T01:10:00.000Z', behaviorId: 'b-speak', delta: 2, kind: 'positive' }),
];

const IMPROVES = [
  ev({ id: 'i1', ts: '2026-08-11T01:20:00.000Z', behaviorId: 'b-talk', delta: -1, kind: 'improve', period: '第2節' }),
  ev({ id: 'i2', ts: '2026-08-12T03:20:00.000Z', behaviorId: 'b-talk', delta: -1, kind: 'improve', period: '第5節', note: '和鄰座聊天，提醒後有停下來' }),
  ev({ id: 'i3', ts: '2026-08-13T02:20:00.000Z', behaviorId: 'b-nohw', delta: -2, kind: 'improve', period: '第4節' }),
];

const ALL = [...POSITIVES, ...IMPROVES];

function factsOf(events = ALL, behaviors = BEHAVIORS) {
  return studentFacts({
    events,
    student: STUDENT,
    className: '七年一班',
    behaviors,
  });
}

function draft(opts = {}) {
  return buildContactDraft({
    facts: opts.facts !== undefined ? opts.facts : factsOf(opts.pool || ALL, opts.behaviors),
    events: opts.events || [],
    behaviors: opts.behaviors || BEHAVIORS,
    teacherName: opts.teacherName || '陳老師',
    mode: opts.mode || 'auto',
    asks: opts.asks || [],
  });
}

/* ---------- 1. 數字必須追溯得到 ---------- */

test('報喜草稿裡的每個數字都追溯得到來源', () => {
  const d = draft({ events: POSITIVES });
  assert.equal(d.ok, true);
  assert.deepEqual(traceNumbers(d.note, new Set(d.allowed)), []);
  assert.deepEqual(traceNumbers(d.callPoints, new Set(d.allowed)), []);
});

test('報憂草稿裡的每個數字都追溯得到來源', () => {
  const d = draft({ events: IMPROVES, asks: ['今晚問問他這週最順利的一件事'] });
  assert.equal(d.tone, 'concern');
  assert.deepEqual(traceNumbers(d.note, new Set(d.allowed)), []);
  assert.deepEqual(traceNumbers(d.callPoints, new Set(d.allowed)), []);
  // 程式自我檢查也不該留下任何「數字追溯不到」的警告
  assert.equal(d.warnings.some((w) => w.includes('追溯不到')), false);
});

test('次數與日期都對得回選定的事件', () => {
  const d = draft({ events: IMPROVES });
  // 課堂講話 2 次（8/11、8/12）、未交作業 1 次（8/13）
  assert.match(d.note, /「課堂講話」2 次/);
  assert.match(d.note, /8月11日/);
  assert.match(d.note, /8月12日/);
  assert.match(d.note, /「未交作業」1 次/);
  // 沒選的正向事件日期不該被當成待改進的日期寫進去
  assert.equal(/「課堂講話」3 次/.test(d.note), false);
});

test('traceNumbers 抓得到白名單外的數字', () => {
  assert.deepEqual(traceNumbers('這週有 3 節課被提醒', new Set([2])), [3]);
  assert.deepEqual(traceNumbers('這週有 3 節課被提醒', new Set([3])), []);
});

/* ---------- 2. 報憂一定有正向段落 ---------- */

test('報憂草稿一定含正向段落（選定事件裡沒有正向也一樣）', () => {
  const d = draft({ events: IMPROVES });
  assert.equal(d.tone, 'concern');
  assert.match(d.note, /先跟您說一件好的/);
  assert.match(d.callPoints, /先講的正向事實/);
});

test('整段期間都沒有正向紀錄時，不編一句假的稱讚，改講老師自己的立場', () => {
  const onlyBad = IMPROVES;
  const d = draft({ events: IMPROVES, pool: onlyBad });
  assert.equal(d.tone, 'concern');
  assert.equal(d.openingLevel, 3);
  assert.match(d.note, /不是要告狀/);
  // 沒有正向事實可引用時，絕不能冒出「他有 N 次正向表現」這種句子
  assert.equal(/次正向表現/.test(d.note), false);
  assert.equal(d.warnings.some((w) => w.includes('查不到這位學生的正向紀錄')), true);
});

test('正向段落優先引用老師這次選定的正向事件', () => {
  const d = draft({ events: [...IMPROVES, POSITIVES[1]] });
  assert.equal(d.tone, 'concern');
  assert.equal(d.openingLevel, 1);
  assert.match(d.note, /幫助同學/);
});

/* ---------- 3. 標籤式字眼被擋掉 ---------- */

test('labelHits 分得出標籤與事實', () => {
  assert.equal(labelHits('他上課愛講話').length > 0, true);
  assert.equal(labelHits('他總是不交作業').length > 0, true);
  assert.equal(labelHits('這孩子可能有過動').length > 0, true);
  assert.equal(labelHits('全班最差的一個').length > 0, true);
  // 事實描述不能被誤殺，否則工具沒法用
  assert.deepEqual(labelHits('這週有 3 節課因為聊天被提醒'), []);
  assert.deepEqual(labelHits('課堂講話 2 次'), []);
});

test('老師備註含結論式字眼時不進草稿，而且會告訴老師擋了什麼', () => {
  const bad = ev({
    id: 'i9', ts: '2026-08-12T03:20:00.000Z', behaviorId: 'b-talk',
    delta: -1, kind: 'improve', note: '他就是懶惰又愛講話，講不聽',
  });
  const d = draft({ events: [bad], pool: [...ALL, bad] });
  assert.equal(d.note.includes('懶惰'), false);
  assert.equal(d.note.includes('愛講話'), false);
  assert.equal(d.callPoints.includes('講不聽'), false);
  assert.equal(d.warnings.some((w) => w.includes('未被引用')), true);
  assert.equal(d.warnings.some((w) => w.includes('懶惰')), true);
});

test('老師自訂的行為卡名稱含標籤時，給家長那份改成中性描述，給老師那份保留原名', () => {
  const behaviors = [{ id: 'b-x', label: '愛講話', delta: -1, kind: 'improve' }];
  const e = ev({ id: 'x1', ts: '2026-08-12T03:20:00.000Z', behaviorId: 'b-x', delta: -1, kind: 'improve' });
  const d = draft({ events: [e], behaviors, pool: [e] });
  assert.equal(d.note.includes('愛講話'), false);
  assert.match(d.note, /一次課堂提醒/);
  assert.match(d.callPoints, /愛講話/); // 老師自己的速記，讀者是老師本人
  assert.equal(d.warnings.some((w) => w.includes('建議到「行為卡」頁把卡片改名')), true);
});

test('老師在「希望家長協助」寫下標籤時，整條移除並說明原因', () => {
  const d = draft({
    events: IMPROVES,
    asks: ['請糾正他散漫的態度', '今晚陪他把數學作業寫完'],
  });
  assert.equal(d.note.includes('散漫'), false);
  assert.match(d.note, /今晚陪他把數學作業寫完/);
  assert.equal(d.warnings.some((w) => w.includes('已從草稿移除')), true);
});

test('程式自己產出的草稿也要過同一道濾網', () => {
  [POSITIVES, IMPROVES, [...POSITIVES, ...IMPROVES]].forEach((events) => {
    const d = draft({ events });
    assert.deepEqual(labelHits(d.note), []);
    assert.deepEqual(labelHits(d.callPoints), []);
    assert.equal(d.warnings.some((w) => w.includes('這是程式的錯')), false);
  });
});

test('scrubText 留下乾淨的、丟掉髒的', () => {
  const { kept, dropped } = scrubText(['今晚陪他念十分鐘', '他老是這樣', '']);
  assert.deepEqual(kept, ['今晚陪他念十分鐘']);
  assert.equal(dropped.length, 1);
});

/* ---------- 4. 沒選事件不硬生 ---------- */

test('沒選事件時不生草稿', () => {
  const d = draft({ events: [] });
  assert.equal(d.ok, false);
  assert.equal(d.note, '');
  assert.equal(d.callPoints, '');
  assert.match(d.reason, /沒有選任何事件/);
});

test('選到的全是已撤銷的事件，等同沒選', () => {
  const voided = IMPROVES.map((e) => ({ ...e, voided: true }));
  const d = draft({ events: voided });
  assert.equal(d.ok, false);
});

test('缺事實包時不生草稿', () => {
  const d = draft({ events: IMPROVES, facts: null });
  assert.equal(d.ok, false);
});

/* ---------- 5. 建議欄位的張力：留位置，但系統不代寫 ---------- */

test('老師沒填協助事項時，草稿留下看得見的佔位符而不是自動編一條建議', () => {
  const d = draft({ events: IMPROVES });
  assert.equal(d.note.includes(ASK_PLACEHOLDER), true);
  assert.equal(d.callPoints.includes(ASK_PLACEHOLDER), true);
});

test('老師填了就用老師的話，佔位符消失', () => {
  const d = draft({ events: IMPROVES, asks: ['今晚花五分鐘聽他講學校的事'] });
  assert.equal(d.note.includes(ASK_PLACEHOLDER), false);
  assert.match(d.note, /今晚花五分鐘聽他講學校的事/);
});

test('協助事項超過兩件只留兩件', () => {
  const d = draft({ events: IMPROVES, asks: ['甲件事', '乙件事', '丙件事'] });
  assert.equal(d.note.includes('丙件事'), false);
  assert.equal(d.warnings.some((w) => w.includes('超過兩件')), true);
});

/* ---------- 6. 情境判定與兩種格式 ---------- */

test('全是正向事件走報喜，語氣不帶提醒與請託', () => {
  const d = draft({ events: POSITIVES });
  assert.equal(d.tone, 'praise');
  assert.match(d.note, /想跟您分享一件好事/);
  // 報喜就純粹報喜：兩份都不夾帶待辦，否則家長下次看到來電會先緊張
  assert.equal(d.note.includes(ASK_PLACEHOLDER), false);
  assert.equal(d.callPoints.includes(ASK_PLACEHOLDER), false);
  assert.equal(d.callPoints.includes('■ 希望家長協助'), false);
});

test('報喜時老師若真的有事要請託，還是照列', () => {
  const d = draft({ events: POSITIVES, asks: ['幫我跟他說一聲老師有看到'] });
  assert.match(d.callPoints, /■ 希望家長協助/);
  assert.match(d.note, /幫我跟他說一聲老師有看到/);
});

test('混合事件不會被好消息稀釋成報喜', () => {
  const d = draft({ events: [...POSITIVES, IMPROVES[0]] });
  assert.equal(d.tone, 'concern');
});

test('既無正向也無待改進時走例行同步', () => {
  const redeem = ev({ id: 'r1', ts: '2026-08-12T03:00:00.000Z', behaviorId: 'r-pen', delta: -10, kind: 'redeem' });
  const d = draft({ events: [redeem], pool: [...ALL, redeem] });
  assert.equal(d.tone, 'routine');
  assert.match(d.note, /跟您同步一下/);
});

test('老師可以手動指定情境，蓋過自動判斷', () => {
  const d = draft({ events: POSITIVES, mode: 'concern' });
  assert.equal(d.tone, 'concern');
});

test('兩種格式互不混用：家長那份不出現分數與內部條列符號', () => {
  const d = draft({ events: IMPROVES });
  assert.equal(d.note.includes('■'), false);
  assert.equal(d.note.includes('・'), false);
  assert.equal(/[-+]?\d+\s*分/.test(d.note), false); // 積分是班內工具，不該變成家長眼中的排名
  assert.match(d.callPoints, /■ 要講的具體事實/);
  assert.match(d.callPoints, /■ 要問家長的/);
  assert.match(d.callPoints, /不對孩子下定論/);
});

test('署名與班級名稱會出現在家長那份', () => {
  const d = draft({ events: POSITIVES, teacherName: '陳乃誠' });
  assert.match(d.note, /林彥廷家長您好/);
  assert.match(d.note, /七年一班/);
  assert.match(d.note, /陳乃誠 敬上/);
});

test('一次選太多待改進會提醒老師，但不阻擋', () => {
  const many = [
    ...IMPROVES,
    ev({ id: 'i4', ts: '2026-08-13T04:00:00.000Z', behaviorId: 'b-talk', delta: -1, kind: 'improve' }),
    ev({ id: 'i5', ts: '2026-08-13T05:00:00.000Z', behaviorId: 'b-nohw', delta: -2, kind: 'improve' }),
    ev({ id: 'i6', ts: '2026-08-13T06:00:00.000Z', behaviorId: 'b-talk', delta: -1, kind: 'improve' }),
  ];
  const d = draft({ events: many });
  assert.equal(d.ok, true);
  assert.equal(d.warnings.some((w) => w.includes('容易進入防衛')), true);
});
