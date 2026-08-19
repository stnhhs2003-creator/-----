/*
 * 事實層：把事件流整理成「可以直接引用的事實」。
 *
 * 第三期三個功能（學期評語／親師草稿／導師週報）全部從這裡取材。
 * 這一層只做統計，不生成任何句子——句子長什麼樣是各功能自己的事。
 *
 * 之所以要把事實與句子拆開：LLM 潤稿時，這包 JSON 就是事實白名單。
 * 潤出來的文字只要冒出這裡沒有的數字，就判定為虛構、退回原始骨架。
 * 「不得虛構」因此是可以機器檢查的，不是靠提示詞拜託模型自律。
 */

import { isBehaviorEvent, localDay } from './rules.js';
import { participating } from './optout.js';

const DAY = 24 * 60 * 60 * 1000;

/** 只取區間內、未撤銷的事件。since／until 是 ISO 字串，兩端都可省略。 */
export function inRange(events, { since, until } = {}) {
  return events.filter((e) => {
    if (e.voided) return false;
    if (since && e.ts < since) return false;
    if (until && e.ts > until) return false;
    return true;
  });
}

const labelMap = (behaviors) =>
  new Map((behaviors || []).map((b) => [b.id, b.label]));

/** 依次數由多到少排出前幾名行為。 */
function topBehaviors(events, labels, limit = 5) {
  const count = new Map();
  events.forEach((e) => count.set(e.behaviorId, (count.get(e.behaviorId) || 0) + 1));
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([behaviorId, n]) => ({
      behaviorId,
      label: labels.get(behaviorId) || behaviorId,
      count: n,
    }));
}

const sumDelta = (list) => list.reduce((s, e) => s + e.delta, 0);
// 活躍天數要用台灣當地日。ts.slice(0, 10) 是 UTC，早自習 08:00 前的紀錄
// 會被切成前一天，同一天的兩筆就變成兩天。這個錯數字會混進事實包，
// 於是通過伺服器端的防虛構白名單——比別處的錯更難抓。
const dayKey = (ts) => localDay(ts);

/**
 * 前後半段比較。
 * 只有差距夠明顯才說「進步」或「退步」——差 1、2 分就宣稱有趨勢是在唬人，
 * 老師拿這句話去跟家長講會站不住腳。
 */
function trendOf(events, range) {
  // 只有一天的資料沒有前後半段可言：中線會剛好落在當天開頭，
  // 所有事件都掉進後半段、前半段恆為 0，評語就會對只被記過一天的孩子說「有進步」。
  if (range.days < 2) {
    return { firstHalf: 0, secondHalf: sumDelta(events), direction: 'flat' };
  }
  // 中線用「起日 00:00 到迄日隔天 00:00」的正中間，讓迄日整天都算進後半段。
  const start = new Date(`${range.from}T00:00:00.000Z`).getTime();
  const end = new Date(`${range.to}T00:00:00.000Z`).getTime() + DAY;
  const mid = new Date(start + (end - start) / 2).toISOString();
  const first = sumDelta(events.filter((e) => e.ts < mid));
  const second = sumDelta(events.filter((e) => e.ts >= mid));
  const diff = second - first;
  const base = Math.max(Math.abs(first), 5);
  let direction = 'flat';
  if (Math.abs(diff) >= 3 && Math.abs(diff) / base >= 0.2) {
    direction = diff > 0 ? 'up' : 'down';
  }
  return { firstHalf: first, secondHalf: second, direction };
}

function rangeOf(events, { since, until } = {}) {
  const sorted = events.map((e) => e.ts).sort();
  const from = since || sorted[0] || new Date().toISOString();
  const to = until || sorted[sorted.length - 1] || from;
  return {
    from: from.slice(0, 10),
    to: to.slice(0, 10),
    days: Math.max(1, Math.round((new Date(to) - new Date(from)) / DAY) + 1),
  };
}

/**
 * 一位學生的事實包。
 *
 * notes 是老師當初隨手打的備註——那是整包資料裡最具體、最像「人」的素材，
 * 評語能不能寫得不像罐頭，幾乎都靠這一欄。
 */
export function studentFacts({ events, student, className = '', behaviors, since, until }) {
  const labels = labelMap(behaviors);
  const mine = inRange(events, { since, until }).filter((e) => e.studentId === student.id);
  const behaviorEvents = mine.filter(isBehaviorEvent);
  const positive = behaviorEvents.filter((e) => e.kind === 'positive');
  const improve = behaviorEvents.filter((e) => e.kind === 'improve');
  const range = rangeOf(mine, { since, until });

  return {
    student: { id: student.id, no: student.no, name: student.name },
    className,
    range,
    totals: {
      positive: positive.length,
      improve: improve.length,
      positivePoints: sumDelta(positive),
      improvePoints: Math.abs(sumDelta(improve)),
      net: sumDelta(behaviorEvents),
    },
    positiveTop: topBehaviors(positive, labels),
    improveTop: topBehaviors(improve, labels),
    // 趨勢的比較區間只能由「行為事件」決定。若沿用含兌換的 range，
    // 學生月底去商店花點數就會把區間拉到月底、中線往後推，
    // 月初那幾張正向卡全被歸進前半段——越是把點數花掉，評語越說他退步。
    trend: trendOf(behaviorEvents, rangeOf(behaviorEvents, { since, until })),
    activeDays: new Set(behaviorEvents.map((e) => dayKey(e.ts))).size,
    notes: mine
      .filter((e) => e.note)
      .slice(-10)
      .map((e) => ({
        ts: e.ts.slice(0, 10),
        kind: e.kind,
        label: labels.get(e.behaviorId) || e.behaviorId,
        note: e.note,
      })),
    redeemed: mine
      .filter((e) => e.kind === 'redeem')
      .map((e) => ({ ts: e.ts.slice(0, 10), label: e.note || '兌換獎勵' })),
  };
}

/** 一個班的事實包。需關心名單不在這裡算——那是 rules.js 的 detectAlerts 的事。 */
export function classFacts({ events, cls, behaviors, since, until }) {
  const labels = labelMap(behaviors);
  const mine = inRange(events, { since, until }).filter((e) => e.classId === cls.id);
  const behaviorEvents = mine.filter(isBehaviorEvent);
  const positive = behaviorEvents.filter((e) => e.kind === 'positive');
  const improve = behaviorEvents.filter((e) => e.kind === 'improve');

  // 不參與的學生不進任何一份文字產出（學期評語／親師草稿／導師週報）。
  const roster = participating(cls.students);
  const perStudent = roster.map((s) => {
    const his = behaviorEvents.filter((e) => e.studentId === s.id);
    return {
      id: s.id,
      no: s.no,
      name: s.name,
      positive: his.filter((e) => e.kind === 'positive').length,
      improve: his.filter((e) => e.kind === 'improve').length,
      net: sumDelta(his),
    };
  });

  return {
    className: cls.name,
    students: roster.length,
    range: rangeOf(mine, { since, until }),
    totals: {
      positive: positive.length,
      improve: improve.length,
      net: sumDelta(behaviorEvents),
    },
    // 正向佔比是老師自我檢查的鏡子：低於五成通常代表這週在忙著滅火
    positiveRatio: behaviorEvents.length
      ? Math.round((positive.length / behaviorEvents.length) * 100) / 100
      : 0,
    positiveTop: topBehaviors(positive, labels),
    improveTop: topBehaviors(improve, labels),
    activeDays: new Set(behaviorEvents.map((e) => dayKey(e.ts))).size,
    perStudent,
  };
}
