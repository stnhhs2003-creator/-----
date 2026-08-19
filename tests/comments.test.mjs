/*
 * 學期評語骨架測試（ROADMAP 3.1）。
 *
 * 這裡要守的核心只有一句：**評語裡的每一句話都追得回具體事件**。
 * 所以測試不自己造事實包，而是從真實事件流跑 studentFacts() 再產草稿——
 * 中間任何一層算錯，這裡都會紅。
 *
 * 其中最關鍵的一項，是把 functions/api/ai 那道「數字白名單」直接拿來量骨架自己：
 * 擋 AI 虛構用的是哪一把尺，量骨架就用同一把。骨架若自己造了一個事實包裡
 * 沒有的數字（例如把正向與待改進加起來寫成「共 14 筆」），這裡就會抓到。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { studentFacts } from '../js/summarize.js';
import { DEFAULT_BEHAVIORS } from '../js/data.js';
import { numbersIn, fabricatedNumbers } from '../functions/api/ai/[[route]].js';
import {
  buildComment, buildClassComments, containsLabelWords,
  LABEL_WORDS, MIN_EVENTS, MIN_ACTIVE_DAYS, TARGET_MAX,
} from '../js/comments.js';

const B = Object.fromEntries(DEFAULT_BEHAVIORS.map((b) => [b.id, b]));
const BASE = new Date('2026-06-30T08:00:00.000Z');

let seq = 0;
/** 造一筆事件。daysAgo 從 2026-06-30 往回推。 */
function ev(daysAgo, behaviorId, note = '') {
  const d = new Date(BASE);
  d.setDate(d.getDate() - daysAgo);
  const b = B[behaviorId];
  return {
    id: `e${seq++}`, ts: d.toISOString(), classId: 'c701', studentId: 's1',
    behaviorId, delta: b.delta, kind: b.kind, period: '第3節', note, voided: false,
  };
}

const STUDENT = { id: 's1', no: 7, name: '陳映彤' };
const factsOf = (events) => studentFacts({
  events, student: STUDENT, className: '七年一班', behaviors: DEFAULT_BEHAVIORS,
});

/** 一份典型的、資料充足的一學期。 */
const FULL = [
  ev(100, 'b-talk', '上課跟隔壁聊漫畫，提醒後有收斂'),
  ev(95, 'b-help'),
  ev(90, 'b-help', '主動教隔壁組同學數學第三題'),
  ev(88, 'b-speak'),
  ev(80, 'b-nohw'),
  ev(70, 'b-speak'),
  ev(60, 'b-focus'),
  ev(50, 'b-help'),
  ev(40, 'b-duty', '午餐時間主動留下來擦桌子'),
  ev(30, 'b-progress', '段考數學從 48 進步到 71'),
  ev(20, 'b-speak'),
  ev(10, 'b-focus'),
  ev(5, 'b-help'),
  ev(2, 'b-speak'),
];

// ---- 不得虛構：數字全部要有來源 ----

test('骨架裡的每個數字都在事實包裡找得到來源', () => {
  const facts = factsOf(FULL);
  const { text } = buildComment(facts);
  const bad = fabricatedNumbers(text, numbersIn({ facts }));
  assert.deepEqual(bad, [], `這些數字在事實包裡找不到：${bad.join('、')}`);
});

test('概況句不做加總——正向與待改進分開講，不寫憑空算出來的合計', () => {
  const facts = factsOf(FULL);
  const { text } = buildComment(facts);
  const total = facts.totals.positive + facts.totals.improve;
  const first = text.slice(0, text.indexOf('。') + 1);
  assert.match(first, /正向 12 次、待改進 2 次/);
  assert.ok(!numbersIn(first).has(String(total)),
    `概況句出現了事實包裡沒有的合計數 ${total}：${first}`);
});

test('換一份事件流，數字來源檢查一樣要過（不是剛好對到）', () => {
  const other = [
    ev(80, 'b-duty'), ev(70, 'b-duty'), ev(60, 'b-speak'),
    ev(50, 'b-phone'), ev(40, 'b-phone'), ev(30, 'b-phone'),
    ev(20, 'b-focus'), ev(10, 'b-focus', '整節課都在寫講義，沒有分心'),
  ];
  const facts = factsOf(other);
  const { text } = buildComment(facts);
  assert.deepEqual(fabricatedNumbers(text, numbersIn({ facts })), []);
});

// ---- 資料不足不硬生 ----

test('只有 2 筆紀錄時說資料不足，不硬湊評語', () => {
  const facts = factsOf([ev(30, 'b-help'), ev(10, 'b-speak')]);
  const r = buildComment(facts);
  assert.equal(r.enough, false);
  assert.match(r.text, /樣本不足/);
  assert.ok(r.text.length < 120, '資料不足時不該生出一大段話');
});

test('筆數夠但全擠在同一天，一樣算資料不足', () => {
  const sameDay = Array.from({ length: 8 }, () => ev(10, 'b-help'));
  const facts = factsOf(sameDay);
  assert.equal(facts.activeDays, 1);
  const r = buildComment(facts);
  assert.equal(r.enough, false);
  assert.match(r.reasons.join(), /只分布在 1 天/);
});

test('剛好踩在門檻上要生得出來，門檻本身別寫歪', () => {
  const events = [];
  for (let i = 0; i < MIN_EVENTS; i++) events.push(ev(60 - i * 10, 'b-help'));
  const facts = factsOf(events);
  assert.equal(facts.totals.positive, MIN_EVENTS);
  assert.ok(facts.activeDays >= MIN_ACTIVE_DAYS);
  assert.equal(buildComment(facts).enough, true);
});

test('資料不足的說明也不能虛構數字', () => {
  const facts = factsOf([ev(30, 'b-help'), ev(10, 'b-speak')]);
  const r = buildComment(facts);
  const allowed = numbersIn({ facts, extra: [MIN_EVENTS, MIN_ACTIVE_DAYS] });
  assert.deepEqual(fabricatedNumbers(r.text, allowed), []);
});

// ---- 老師的備註是金礦 ----

test('老師寫的備註原話有被引進評語，而且是照抄不改寫', () => {
  const { text } = buildComment(factsOf(FULL));
  assert.ok(text.includes('段考數學從 48 進步到 71'),
    `備註沒有被用到：${text}`);
});

test('備註只引最近兩則，不會把 150 字全吃掉', () => {
  const withNotes = [
    ev(90, 'b-help', '第一則備註'),
    ev(80, 'b-help', '第二則備註'),
    ev(70, 'b-help', '第三則備註'),
    ev(60, 'b-speak', '第四則備註'),
    ev(50, 'b-focus'), ev(40, 'b-duty'), ev(30, 'b-speak'),
  ];
  const { text } = buildComment(factsOf(withNotes));
  assert.ok(text.includes('第四則備註') && text.includes('第三則備註'));
  assert.ok(!text.includes('第一則備註'), '引了太舊的備註');
});

test('沒有任何備註時照樣寫得出評語，只是少一句具體事例', () => {
  const noNotes = FULL.map((e) => ({ ...e, note: '' }));
  const r = buildComment(factsOf(noNotes));
  assert.equal(r.enough, true);
  assert.ok(r.length > 50);
  assert.deepEqual(fabricatedNumbers(r.text, numbersIn({ facts: factsOf(noNotes) })), []);
});

// ---- 待改進的立場（決策二）----

test('待改進的備註原文不進評語——那是老師寫給自己看的', () => {
  const { text } = buildComment(factsOf(FULL));
  assert.ok(!text.includes('上課跟隔壁聊漫畫'),
    '負向備註原文被寫進要給家長看的評語了');
});

test('偶發一兩次的待改進不寫成一學期的定論', () => {
  const { text } = buildComment(factsOf(FULL)); // 待改進只有 2 次
  assert.ok(!text.includes('需要一起留意'), `偶發的待改進不該入評語：${text}`);
});

test('待改進總數夠、但分散在三種行為時不點名任何一項（實測示範資料抓到的）', () => {
  const scattered = [
    ev(90, 'b-help'), ev(80, 'b-speak'), ev(70, 'b-focus'), ev(65, 'b-duty'),
    ev(60, 'b-conflict'), ev(50, 'b-talk'), ev(40, 'b-late'),
  ];
  const facts = factsOf(scattered);
  assert.equal(facts.totals.improve, 3, '前提：總數有踩到門檻');
  assert.equal(facts.improveTop[0].count, 1, '前提：沒有任何一項重複');
  const { text } = buildComment(facts);
  assert.ok(!text.includes('需要一起留意'),
    `沒有反覆出現的模式卻點名了某一項：${text}`);
  assert.match(text, /待改進 3 次/, '概況句仍要誠實交代待改進的總次數');
});

test('待改進達到門檻就要寫，不能整段抹掉', () => {
  const many = [
    ev(90, 'b-help'), ev(80, 'b-speak'), ev(70, 'b-focus'),
    ev(60, 'b-nohw'), ev(50, 'b-nohw'), ev(40, 'b-nohw'),
    ev(30, 'b-talk'), ev(20, 'b-help'),
  ];
  const { text } = buildComment(factsOf(many));
  assert.match(text, /需要一起留意的是未交作業/);
  assert.match(text, /3 次/);
});

test('寫待改進時只給行為與次數，不列日期明細', () => {
  const many = [
    ev(90, 'b-help'), ev(80, 'b-speak'), ev(70, 'b-focus'),
    ev(60, 'b-nohw', '第三次忘記帶作業本'), ev(50, 'b-nohw'), ev(40, 'b-nohw'),
    ev(30, 'b-talk'), ev(20, 'b-help'),
  ];
  const { text } = buildComment(factsOf(many));
  const tail = text.slice(text.indexOf('需要一起留意'));
  assert.ok(!/\d+\/\d+/.test(tail), `待改進那一句出現了日期：${tail}`);
  assert.ok(!text.includes('第三次忘記帶作業本'));
});

// ---- 不下標籤 ----

test('骨架不出現標籤式字眼', () => {
  const cases = [FULL, [
    ev(90, 'b-talk'), ev(80, 'b-talk'), ev(70, 'b-phone'),
    ev(60, 'b-conflict'), ev(50, 'b-help'), ev(40, 'b-speak'),
    ev(30, 'b-nohw'), ev(20, 'b-late'),
  ]];
  cases.forEach((events, i) => {
    const { text } = buildComment(factsOf(events));
    assert.deepEqual(containsLabelWords(text), [], `第 ${i + 1} 組出現標籤字眼：${text}`);
  });
});

test('標籤字清單本身有在把關（防呆：檢查函式不是永遠回空陣列）', () => {
  assert.ok(LABEL_WORDS.length > 5);
  assert.deepEqual(containsLabelWords('他是個熱心的孩子，個性活潑'), ['個性', '熱心的孩子']);
});

// ---- 長度與整班 ----

test('資料充足時長度落在可用範圍，不會爆成一篇作文', () => {
  const r = buildComment(factsOf(FULL));
  assert.ok(r.length <= TARGET_MAX, `太長了：${r.length} 字`);
  assert.ok(r.length >= 80, `太短了：${r.length} 字`);
});

test('備註超長也不會讓評語失控——會砍到只引一則', () => {
  const longNote = '這學期擔任午餐長，每天中午都留下來把餐桶推回廚房再回教室吃飯';
  const events = [
    ev(90, 'b-duty', longNote), ev(80, 'b-duty', longNote + '，而且從來沒有遲到過'),
    ev(70, 'b-help'), ev(60, 'b-speak'), ev(50, 'b-focus'), ev(40, 'b-progress'),
  ];
  const r = buildComment(factsOf(events));
  assert.ok(r.length <= TARGET_MAX + 40, `長度失控：${r.length} 字`);
});

test('整班一次產生，每個人都有結果與可追溯的依據', () => {
  const rosterFacts = [
    factsOf(FULL),
    studentFacts({
      events: [], student: { id: 's2', no: 8, name: '林彥廷' },
      className: '七年一班', behaviors: DEFAULT_BEHAVIORS,
    }),
  ];
  const out = buildClassComments(rosterFacts);
  assert.equal(out.length, 2);
  assert.equal(out[0].enough, true);
  assert.ok(out[0].cited.length >= 3, '沒有列出依據就沒辦法追溯');
  assert.equal(out[1].enough, false, '完全沒紀錄的學生不該生出評語');
  assert.equal(out[1].name, '林彥廷');
});

test('趨勢不明顯時不硬說有進步或退步', () => {
  const flat = [
    ev(90, 'b-help'), ev(75, 'b-help'), ev(60, 'b-help'),
    ev(45, 'b-help'), ev(30, 'b-help'), ev(15, 'b-help'),
  ];
  const facts = factsOf(flat);
  assert.equal(facts.trend.direction, 'flat');
  const { text } = buildComment(facts);
  assert.ok(!text.includes('後半學期'), `趨勢是 flat 卻寫了趨勢句：${text}`);
});

/* ── 引用備註的標籤濾網（2026-08-15 補）──────────────────────
 * 評語是要交到家長手上的文件，而備註是老師寫給自己看的口吻。
 * 兩者中間必須有一道濾網：老師隨手寫的「他就是懶」不該原封不動變成評語的一句。
 * 親師溝通草稿早就有這道濾網，評語漏掉了——這組測試把它補上。
 */

import { labelHits } from '../js/labels.js';

const factsWith = (notes) => ({
  student: { id: 's1', no: 1, name: '王小明' },
  className: '七年一班',
  range: { from: '2026-07-01', to: '2026-07-08', days: 8 },
  totals: { positive: 8, improve: 0, positivePoints: 24, improvePoints: 0, net: 24 },
  positiveTop: [{ behaviorId: 'b-help', label: '幫助同學', count: 8 }],
  improveTop: [],
  trend: { firstHalf: 12, secondHalf: 12, direction: 'flat' },
  activeDays: 8,
  notes,
  redeemed: [],
});

test('老師備註帶結論式標籤時，整句不進評語——那是要給家長看的', () => {
  const facts = factsWith([
    { ts: '2026-07-08', kind: 'positive', label: '幫助同學', note: '雖然他智商不高，但很努力，總是第一個到' },
  ]);
  const out = buildComment(facts);
  assert.ok(!out.text.includes('智商不高'), '醫療／能力判定不能出現在評語裡');
  assert.ok(!out.text.includes('總是'), '全稱量詞不能出現在評語裡');
});

test('乾淨的備註照樣引用，濾網不能連好東西一起擋掉', () => {
  const facts = factsWith([
    { ts: '2026-07-08', kind: 'positive', label: '幫助同學', note: '主動去教隔壁組不會的同學，講到下課還在講。' },
  ]);
  const out = buildComment(facts);
  assert.ok(out.text.includes('主動去教隔壁組'), '沒有標籤的備註應該要被引用');
});

test('被擋下的備註要讓老師知道，不能無聲無息地消失', () => {
  const facts = factsWith([
    { ts: '2026-07-08', kind: 'positive', label: '幫助同學', note: '他個性就是這樣，講不聽' },
  ]);
  const out = buildComment(facts);
  assert.ok(Array.isArray(out.warnings), '要有 warnings 欄位');
  assert.equal(out.warnings.length, 1);
  assert.ok(out.warnings[0].includes('講不聽'), '警告裡要看得到原文，老師才知道是哪一則');
});

test('兩則備註只有一則有標籤時，乾淨那則還是要引用', () => {
  const facts = factsWith([
    { ts: '2026-07-06', kind: 'positive', label: '幫助同學', note: '午餐時間主動留下來擦桌子。' },
    { ts: '2026-07-08', kind: 'positive', label: '幫助同學', note: '他就是懶，這次難得' },
  ]);
  const out = buildComment(facts);
  assert.ok(out.text.includes('擦桌子'), '乾淨的備註不該被連坐');
  assert.ok(!out.text.includes('他就是懶'));
});

test('評語與親師草稿共用同一份字典——安全規則只能有一份', async () => {
  const contact = await import('../js/contact.js');
  assert.deepEqual(contact.LABEL_TERMS, (await import('../js/labels.js')).LABEL_TERMS);
  assert.ok(labelHits('屢教不改').length > 0);
});
