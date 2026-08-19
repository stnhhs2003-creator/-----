/*
 * 家長端紅線測試。
 *
 * 這個站的設計承諾是：家長端不是「把負向紀錄藏起來」，
 * 而是資料層根本不把它送出去（README「家長觀感疑慮」那一列）。
 * parentView() 是家長端唯一的資料出口，所以守住這裡就等於守住紅線。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parentView } from '../js/rules.js';

const ev = (o) => ({
  id: o.id,
  ts: o.ts,
  classId: o.classId || 'c701',
  studentId: o.studentId,
  behaviorId: o.behaviorId,
  delta: o.delta,
  kind: o.kind,
  period: o.period || '第1節',
  note: o.note || '',
  voided: false,
});

/** 四種 kind 混在一起的事件流，貼近實際 localStorage 裡的樣子。 */
function mixedEvents() {
  return [
    ev({ id: 'e1', ts: '2026-08-10T01:00:00.000Z', studentId: 's1', behaviorId: 'b-speak', delta: 2, kind: 'positive' }),
    ev({ id: 'e2', ts: '2026-08-10T02:00:00.000Z', studentId: 's1', behaviorId: 'b-talk', delta: -1, kind: 'improve' }),
    ev({ id: 'e3', ts: '2026-08-11T01:00:00.000Z', studentId: 's1', behaviorId: 'b-help', delta: 3, kind: 'positive' }),
    ev({ id: 'e4', ts: '2026-08-11T03:00:00.000Z', studentId: 's1', behaviorId: 'b-conflict', delta: -3, kind: 'improve' }),
    ev({ id: 'e5', ts: '2026-08-12T01:00:00.000Z', studentId: 's1', behaviorId: 'r-snack', delta: -10, kind: 'redeem', note: '免寫作業券' }),
    ev({ id: 'e6', ts: '2026-08-12T02:00:00.000Z', studentId: 's1', behaviorId: 'r-snack', delta: 0, kind: 'redeem-request', note: '免寫作業券' }),
    ev({ id: 'e7', ts: '2026-08-13T01:00:00.000Z', studentId: 's1', behaviorId: 'b-speak', delta: 2, kind: 'positive' }),
  ];
}

test('parentView 的輸出裡完全不存在任何非 positive 的事件', () => {
  const view = parentView(mixedEvents(), 's1');

  // recent：逐筆檢查 kind
  view.recent.forEach((e) => {
    assert.equal(e.kind, 'positive', `recent 混進了 kind=${e.kind} 的事件（${e.id}）`);
  });

  // recent：連事件 id 都不該出現負向／兌換那幾筆
  const ids = view.recent.map((e) => e.id);
  ['e2', 'e4', 'e5', 'e6'].forEach((id) => {
    assert.equal(ids.includes(id), false, `recent 不該包含 ${id}`);
  });

  // highlights：只能是正向行為卡
  const highlightIds = view.highlights.map(([behaviorId]) => behaviorId);
  ['b-talk', 'b-conflict', 'r-snack'].forEach((behaviorId) => {
    assert.equal(highlightIds.includes(behaviorId), false, `highlights 不該包含 ${behaviorId}`);
  });
  assert.deepEqual(highlightIds.sort(), ['b-help', 'b-speak']);

  // 保險絲：把整包輸出序列化，不准出現任何負向／兌換的痕跡
  const dump = JSON.stringify(view);
  ['improve', 'redeem', 'redeem-request', 'b-talk', 'b-conflict', 'r-snack', '免寫作業券'].forEach((needle) => {
    assert.equal(dump.includes(needle), false, `parentView 輸出洩漏了「${needle}」`);
  });

  assert.equal(view.count, 3);
});

test('totalPositive 只加總正向 delta，不會被 improve 的負分抵銷', () => {
  const view = parentView(mixedEvents(), 's1');
  // 正向：2 + 3 + 2 = 7；improve 的 -1 -3 與兌換的 -10 都不該進來
  assert.equal(view.totalPositive, 7);
  assert.equal(view.totalPositive > 0, true);
});

test('學生只有 improve 事件時，回傳空結果而不是報錯', () => {
  const events = [
    ev({ id: 'x1', ts: '2026-08-10T01:00:00.000Z', studentId: 's9', behaviorId: 'b-talk', delta: -1, kind: 'improve' }),
    ev({ id: 'x2', ts: '2026-08-11T01:00:00.000Z', studentId: 's9', behaviorId: 'b-late', delta: -1, kind: 'improve' }),
  ];

  let view;
  assert.doesNotThrow(() => {
    view = parentView(events, 's9');
  });

  assert.deepEqual(view, {
    totalPositive: 0,
    count: 0,
    highlights: [],
    recent: [],
  });
});

test('完全沒有事件時也回傳空結果', () => {
  assert.deepEqual(parentView([], 's1'), {
    totalPositive: 0,
    count: 0,
    highlights: [],
    recent: [],
  });
});

test('不同 studentId 的事件不會互相汙染', () => {
  const events = [
    ...mixedEvents(),
    ev({ id: 'o1', ts: '2026-08-10T04:00:00.000Z', studentId: 's2', behaviorId: 'b-duty', delta: 3, kind: 'positive' }),
    ev({ id: 'o2', ts: '2026-08-11T04:00:00.000Z', studentId: 's2', behaviorId: 'b-duty', delta: 3, kind: 'positive' }),
    ev({ id: 'o3', ts: '2026-08-12T04:00:00.000Z', studentId: 's2', behaviorId: 'b-talk', delta: -1, kind: 'improve' }),
  ];

  const a = parentView(events, 's1');
  const b = parentView(events, 's2');

  assert.equal(a.totalPositive, 7);
  assert.equal(b.totalPositive, 6);
  assert.equal(a.count, 3);
  assert.equal(b.count, 2);

  a.recent.forEach((e) => assert.equal(e.studentId, 's1'));
  b.recent.forEach((e) => assert.equal(e.studentId, 's2'));

  assert.deepEqual(b.highlights, [['b-duty', 2]]);
  assert.equal(a.highlights.some(([id]) => id === 'b-duty'), false);

  // 查一個根本不存在的學生，不該撈到別人的資料
  assert.deepEqual(parentView(events, 's-nobody'), {
    totalPositive: 0,
    count: 0,
    highlights: [],
    recent: [],
  });
});

test('recent 只保留最近 10 筆正向紀錄，且由新到舊', () => {
  const events = [];
  for (let i = 0; i < 14; i++) {
    events.push(ev({
      id: `p${i}`,
      ts: `2026-08-${String(i + 1).padStart(2, '0')}T01:00:00.000Z`,
      studentId: 's1',
      behaviorId: 'b-focus',
      delta: 2,
      kind: 'positive',
    }));
    // 中間夾雜負向，確認不影響切片結果
    events.push(ev({
      id: `n${i}`,
      ts: `2026-08-${String(i + 1).padStart(2, '0')}T02:00:00.000Z`,
      studentId: 's1',
      behaviorId: 'b-talk',
      delta: -1,
      kind: 'improve',
    }));
  }

  const view = parentView(events, 's1');
  assert.equal(view.count, 14);
  assert.equal(view.totalPositive, 28);
  assert.equal(view.recent.length, 10);
  assert.equal(view.recent[0].id, 'p13');
  assert.equal(view.recent[9].id, 'p4');
  view.recent.forEach((e) => assert.equal(e.kind, 'positive'));
});

test('已撤銷的正向紀錄不得出現在家長端', () => {
  // 老師記錯人按了撤銷，家長頁就不該再看到那筆稱讚。
  // 呼叫端目前是走 queryEvents() 預設排除已撤銷，這條測試守的是
  // 「日後有人改用 includeVoided 的事件流」時 parentView 仍然安全。
  const events = [
    ev({ id: 'a', ts: '2026-08-10T01:00:00.000Z', studentId: 's1', behaviorId: 'b-speak', delta: 2, kind: 'positive' }),
    { ...ev({ id: 'b', ts: '2026-08-10T02:00:00.000Z', studentId: 's1', behaviorId: 'b-help', delta: 3, kind: 'positive' }), voided: true },
  ];

  const view = parentView(events, 's1');
  assert.equal(view.count, 1, '只算沒被撤銷的那一筆');
  assert.equal(view.totalPositive, 2, '撤銷的 +3 不計入');
  assert.ok(!view.recent.some((e) => e.id === 'b'), '撤銷的紀錄不出現在時間軸');
  assert.ok(!view.highlights.some(([id]) => id === 'b-help'), '撤銷的紀錄不進亮點統計');
});
