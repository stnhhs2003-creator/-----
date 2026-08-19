/*
 * 親師溝通草稿（ROADMAP 3.2）。
 *
 * 這一頁跟其他文字功能最大的不同：它的輸出會被一個家長讀到，而內容是他的孩子。
 * 所以這個檔案的重點不是「怎麼把句子寫得漂亮」，是「怎麼讓某些句子寫不出來」。
 *
 * 三條寫死在程式裡的線：
 *
 *   1. 草稿裡的每一個數字都必須追溯得到來源（traceNumbers）。
 *      沒有來源的數字＝憑空生出來的指控。
 *
 *   2. 結論式標籤一律攔在輸出之外（labelHits / scrubText）。
 *      「他上課愛講話」是對一個人的判定，「這週有 3 節課因為聊天被提醒」是一件事。
 *      前者家長只能同意或防衛，後者家長可以一起查。攔截器同時掃三個入口：
 *      老師的備註、老師自訂的行為卡名稱、老師填的「希望家長協助」，
 *      最後再掃一次自己產出的成品——連範本自己都要受檢。
 *
 *   3. 報憂草稿一定有正向段落（positiveOpening）。
 *      這不是粉飾。只講壞消息的聯絡會直接把家長推到防衛位置，
 *      家長防衛之後最常見的下一步是回家罵小孩，孩子學到的是「老師打小報告」，
 *      於是問題沒解決，還多賠一個願意跟老師講話的孩子。
 *      正向段落的功能是把對話從「你的孩子有問題」換成「我們一起看這件事」。
 *      找不到正向事實時，不會捏造優點——捏造的稱讚家長聞得出來，比不講更傷；
 *      這時退回「合作前提句」，講的是老師自己的立場，那句話永遠是真的。
 *
 * 純函式，不碰 DOM、不碰 store、不碰 AI，可以單獨 import 測。
 * 檔案下半段的 DOM 綁定用 typeof document 守住，Node 測試載入時不會執行。
 */

/* ------------------------------------------------------------------ *
 * 1. 結論式標籤攔截
 * ------------------------------------------------------------------ */

/*
 * 分四類，因為它們傷人的方式不一樣：
 *
 *   trait   把行為講成人格。行為可以改，人格不行——講成人格等於宣告沒救。
 *   always  全稱量詞。「總是」「每次都」幾乎不可能為真，一被家長抓到反例，
 *           整封信的可信度就跟著沒了。
 *   verdict 結案式判定。這是老師在扮演法官，而不是提供觀察。
 *   clinic  醫療診斷用語。老師不是醫師，寫下去可能構成標籤化，也可能構成誤診。
 *   compare 跟別人比。家長要的是自己的孩子，不是排名。
 *
 * 只收「幾乎沒有安全用法」的詞。像「講話」這種正常詞不進表——
 * 預設行為卡就叫「課堂講話」，那是中性的事實描述，攔它只會讓工具沒法用。
 */
/*
 * 標籤字典與濾網已經搬到 js/labels.js——評語那條線也要用同一份，
 * 安全規則分成兩份遲早會走鐘。這裡原樣再匯出，呼叫端不用改。
 */
export { LABEL_TERMS, labelHits, scrubText } from './labels.js';

import { labelHits, scrubText } from './labels.js';

/* ------------------------------------------------------------------ *
 * 2. 數字可追溯
 * ------------------------------------------------------------------ */

/**
 * 找出文字裡「來源不明」的數字。
 *
 * allowed 是這份草稿允許出現的數字集合：事實包算出來的次數、選定事件的日期與節次、
 * 以及被引用的原文（備註、行為卡名稱）裡本來就有的數字。
 * 集合以外的數字一律視為虛構——這跟 ai-client 送去伺服器的白名單是同一套邏輯，
 * 差別只在這一份連 AI 都還沒進場就先檢查自己。
 */
export function traceNumbers(text, allowed) {
  const set = allowed instanceof Set ? allowed : new Set(allowed || []);
  const found = String(text || '').match(/\d+/g) || [];
  return [...new Set(found.map(Number).filter((n) => !set.has(n)))];
}

/** 把一段被引用的原文裡的數字放行——它們本來就在老師寫的字裡。 */
function allowFrom(set, text) {
  (String(text || '').match(/\d+/g) || []).forEach((n) => set.add(Number(n)));
}

/* ------------------------------------------------------------------ *
 * 3. 骨架產生
 * ------------------------------------------------------------------ */

export const ASK_PLACEHOLDER =
  '〔請在這裡寫下你希望家長做的一件具體小事，例如：今晚花五分鐘問問他這週在學校最順利的一件事〕';

const MODES = ['auto', 'praise', 'concern', 'routine'];

const behaviorMap = (behaviors) => new Map((behaviors || []).map((b) => [b.id, b]));

/** 本地時區的「8月12日」。用本地而非 UTC 切字串，晚自習與早自習才不會跳到前一天。 */
function mdOf(ts) {
  const d = new Date(ts);
  return { m: d.getMonth() + 1, d: d.getDate() };
}
const mdText = (ts) => {
  const { m, d } = mdOf(ts);
  return `${m}月${d}日`;
};

/**
 * 決定情境。
 *
 * 只要選定的事件裡有一件待改進，就走報憂——不因為「好消息比較多」就當成報喜。
 * 把壞消息包在好消息裡送出去（三明治話術）家長只會覺得被套路，
 * 而且真正要談的事很容易在客套裡被忽略掉。
 */
function decideTone(evts, mode) {
  if (mode && mode !== 'auto' && MODES.includes(mode)) return mode;
  if (evts.some((e) => e.kind === 'improve')) return 'concern';
  if (evts.some((e) => e.kind === 'positive')) return 'praise';
  return 'routine';
}

/** 把事件依「行為卡」聚成一句可讀的事實：「課堂講話」2 次（8月12日、8月13日）。 */
function groupByBehavior(evts, bmap, allowed, warnings) {
  const groups = new Map();
  evts.forEach((e) => {
    const beh = bmap.get(e.behaviorId);
    const rawLabel = (beh && beh.label) || e.behaviorId;
    if (!groups.has(rawLabel)) groups.set(rawLabel, { rawLabel, kind: e.kind, list: [] });
    groups.get(rawLabel).list.push(e);
  });

  return [...groups.values()].map((g) => {
    const hits = labelHits(g.rawLabel);
    /*
     * 老師可以自訂行為卡名稱，於是有人會把卡片直接命名成「愛講話」。
     * 這種名字在老師自己的稽核紀錄裡沒問題（那是他的速記），
     * 但不能原樣送到家長眼前，所以給家長的那一份換成中性描述，
     * 給老師自己看的通話要點保留原名——否則老師對不上自己記的是哪張卡。
     */
    const safeLabel = hits.length
      ? (g.kind === 'positive' ? '一次正向紀錄' : '一次課堂提醒')
      : g.rawLabel;
    if (hits.length) {
      warnings.push(
        `行為卡「${g.rawLabel}」的名稱帶有結論式字眼（${hits.map((h) => h.term).join('、')}），`
        + '給家長的留言已改成中性描述。建議到「行為卡」頁把卡片改名。'
      );
    } else {
      allowFrom(allowed, g.rawLabel);
    }
    g.list.sort((a, b) => a.ts.localeCompare(b.ts));
    const dates = [...new Set(g.list.map((e) => mdText(e.ts)))];
    g.list.forEach((e) => {
      const { m, d } = mdOf(e.ts);
      allowed.add(m);
      allowed.add(d);
      allowFrom(allowed, e.period);
    });
    allowed.add(g.list.length);
    return { ...g, safeLabel, dates, count: g.list.length };
  });
}

/**
 * 報憂草稿的正向段落。三層退路，愈往下愈不依賴「這孩子最近有沒有好表現」。
 * 回傳 { text, level }，level 讓 UI 有機會提醒老師第三層代表什麼。
 */
function positiveOpening({ name, selectedPositive, facts, allowed }) {
  // 第一層：老師這次就順手選了正向事件——最切題，直接引用。
  if (selectedPositive.length) {
    const labels = [...new Set(selectedPositive.map((g) => g.safeLabel))].slice(0, 2);
    return {
      level: 1,
      text: `先跟您說一件好的：這段期間${name}在班上也有被記下「${labels.join('」和「')}」。`,
    };
  }
  // 第二層：這次沒選，但事實包裡這段期間有正向紀錄——一樣是真的，拿來用。
  const top = (facts && facts.positiveTop) || [];
  const totalPositive = facts && facts.totals ? facts.totals.positive : 0;
  if (top.length && totalPositive > 0) {
    allowed.add(totalPositive);
    allowed.add(top[0].count);
    allowFrom(allowed, top[0].label);
    const safe = labelHits(top[0].label).length ? '正向表現' : top[0].label;
    return {
      level: 2,
      text: `先跟您說一件好的：這段期間${name}在班上被記下 ${totalPositive} 次正向表現，`
        + `其中「${safe}」就有 ${top[0].count} 次。`,
    };
  }
  /*
   * 第三層：這段期間真的找不到正向紀錄。
   *
   * 這裡刻意不編一句「其實他本性不壞」之類的話。那種句子是空的，
   * 家長讀得出來是墊檔用的，反而證明老師沒有真的在看這個孩子。
   * 改成講老師自己的立場——這句話不需要任何事實支撐就永遠為真，
   * 而它要達成的事（把對話從指控換成合作）跟稱讚是一樣的。
   */
  return {
    level: 3,
    text: '先說明我為什麼聯絡您：我不是要告狀，也還沒有要下任何結論，'
      + '是想趁事情還小的時候，跟您一起看看發生了什麼。',
  };
}

/**
 * 產生一份親師溝通草稿。
 *
 * @param {object}   o
 * @param {object}   o.facts        summarize.js 的 studentFacts() 產物，當背景脈絡
 * @param {object[]} o.events       老師「選定」的事件（這條線的起點，不是整學期統計）
 * @param {object[]} o.behaviors    行為卡，用來把 behaviorId 翻成名稱
 * @param {string}   o.teacherName  署名，留空就用「導師」
 * @param {string}   o.mode         auto | praise | concern | routine
 * @param {string[]} o.asks         老師自己寫的「希望家長協助」，系統不代寫
 * @returns {{ok:boolean, tone:string, note:string, callPoints:string,
 *            allowed:number[], warnings:string[], reason:string}}
 */
export function buildContactDraft({
  facts = null,
  events = [],
  behaviors = [],
  teacherName = '',
  mode = 'auto',
  asks = [],
} = {}) {
  const warnings = [];
  const selected = (events || []).filter((e) => e && !e.voided);

  /*
   * 沒選事件就不生。
   *
   * 「隨便生一份範本讓老師自己填」聽起來貼心，實際上是把一份長得很像成品的空殼
   * 交到趕時間的老師手上，而那份空殼裡的每一句話都不是針對這個孩子寫的。
   * 這種東西送出去比沒有更糟。
   */
  if (!selected.length) {
    return {
      ok: false,
      tone: '',
      note: '',
      callPoints: '',
      allowed: [],
      warnings: [],
      reason: '還沒有選任何事件。這份草稿要從具體事件長出來，沒有事件就沒有可以講的事實。',
    };
  }
  if (!facts || !facts.student) {
    return {
      ok: false, tone: '', note: '', callPoints: '', allowed: [], warnings: [],
      reason: '缺少學生的事實包，無法產生草稿。',
    };
  }

  const name = facts.student.name;
  const className = facts.className || '';
  const teacher = String(teacherName || '').trim() || '導師';
  const bmap = behaviorMap(behaviors);
  const allowed = new Set();
  // 姓名、班級名稱裡本來就有的數字（「七年一班」沒有，但「3年5班」有）先放行
  allowFrom(allowed, name);
  allowFrom(allowed, className);
  allowFrom(allowed, teacher);

  const tone = decideTone(selected, mode);

  const improveEvents = selected.filter((e) => e.kind === 'improve');
  const positiveEvents = selected.filter((e) => e.kind === 'positive');
  const otherEvents = selected.filter((e) => e.kind !== 'improve' && e.kind !== 'positive');

  const improveGroups = groupByBehavior(improveEvents, bmap, allowed, warnings);
  const positiveGroups = groupByBehavior(positiveEvents, bmap, allowed, warnings);
  const otherGroups = groupByBehavior(otherEvents, bmap, allowed, warnings);

  /*
   * 一次聯絡談太多件事，家長接收到的不是「幾件事」，是「一份清算」。
   * 這是提醒不是阻擋——要談幾件是老師的判斷，工具沒有立場替他決定。
   */
  if (improveGroups.length > 3 || improveEvents.length > 5) {
    warnings.push(
      `這次選了 ${improveEvents.length} 筆待改進、涵蓋 ${improveGroups.length} 種狀況。`
      + '一次談超過兩三件，家長容易進入防衛而聽不進去，建議挑最關鍵的先談。'
    );
  }

  // 老師填的「希望家長協助」：系統不代寫，但要過同一道濾網
  const askInput = (asks || []).map((a) => String(a || '').trim()).filter(Boolean);
  const { kept: askKept, dropped: askDropped } = scrubText(askInput);
  askDropped.forEach(({ item, hits }) => {
    warnings.push(
      `你寫的「${item}」含有結論式字眼（${hits.map((h) => h.term).join('、')}），已從草稿移除。`
      + '改成「請家長做的一件具體的事」會有用得多。'
    );
  });
  if (askKept.length > 2) {
    warnings.push('請家長協助的事項超過兩件，只保留前兩件。一次要求三件以上等於沒有要求。');
  }
  const finalAsks = askKept.slice(0, 2);
  finalAsks.forEach((a) => allowFrom(allowed, a));

  // 老師的隨手備註：整包資料裡最具體的素材，但也是最容易夾帶標籤的地方
  const rawNotes = selected
    .filter((e) => e.note)
    .map((e) => ({ ts: e.ts, kind: e.kind, text: e.note }));
  const { kept: noteKept, dropped: noteDropped } = scrubText(rawNotes);
  noteDropped.forEach(({ item, hits }) => {
    warnings.push(
      `${mdText(item.ts)} 的備註「${item.text}」含有結論式字眼（${hits.map((h) => h.term).join('、')}），`
      + '未被引用到草稿裡。'
    );
  });
  noteKept.forEach((n) => {
    allowFrom(allowed, n.text);
    const { m, d } = mdOf(n.ts);
    allowed.add(m);
    allowed.add(d);
  });

  const opening = positiveOpening({
    name,
    selectedPositive: positiveGroups,
    facts,
    allowed,
  });
  if (tone === 'concern' && opening.level === 3) {
    warnings.push(
      '這段期間查不到這位學生的正向紀錄，草稿改用「合作前提」開場，沒有替你編一句稱讚。'
      + '如果情況允許，先累積幾筆正向紀錄再聯絡，這通電話會好講很多。'
    );
  }

  const factLine = (g) => `「${g.safeLabel}」${g.count} 次（${g.dates.join('、')}）`;
  const rawLine = (g) => `「${g.rawLabel}」${g.count} 次（${g.dates.join('、')}）`;

  const askBlockNote = finalAsks.length
    ? `想請您幫一個忙：${finalAsks.join('；也想請您')}。`
    : ASK_PLACEHOLDER;

  /* ---------- 格式一：聯絡簿短留言（家長讀的） ---------- */

  const nameLine = `${name}家長您好，我是${className ? `${className}的` : ''}${teacher}。`;
  let note;

  if (tone === 'praise') {
    const quoted = noteKept[0];
    note = [
      nameLine,
      '',
      `想跟您分享一件好事。${positiveGroups.map(factLine).join('、')}——這些都記在班上的紀錄裡了。`,
      quoted ? `${mdText(quoted.ts)}那次的情況是：${quoted.text}` : null,
      '這些不是什麼大事，但每一次都是他自己做的選擇，班上同學也都看得到。想讓您也知道。',
      finalAsks.length ? `想請您幫一個忙：${finalAsks.join('；也想請您')}。` : null,
      '',
      `${teacher} 敬上`,
    ].filter((x) => x !== null).join('\n');
  } else if (tone === 'concern') {
    const quoted = noteKept.find((n) => n.kind === 'improve');
    note = [
      nameLine,
      '',
      opening.text,
      '',
      `想跟您同步這段時間班上紀錄到的狀況：${improveGroups.map(factLine).join('、')}。`,
      quoted ? `其中${mdText(quoted.ts)}那次，我當時記的是：${quoted.text}` : null,
      '我寫下來的都是當下看到的情況，沒有要據此判斷他是什麼樣的孩子。'
        + '想先問問看，最近家裡有沒有什麼事，或是您在家有觀察到什麼？',
      '',
      askBlockNote,
      '',
      '如果方便，這幾天想找個時間跟您通個電話，直接聊會比寫字清楚。',
      '',
      `${teacher} 敬上`,
    ].filter((x) => x !== null).join('\n');
  } else {
    const groups = [...positiveGroups, ...improveGroups, ...otherGroups];
    note = [
      nameLine,
      '',
      `跟您同步一下${name}最近在班上的紀錄：${groups.map(factLine).join('、')}。`,
      '沒有特別的事，只是讓您知道我這邊看到的情況。有想了解的隨時跟我說。',
      finalAsks.length ? `另外想請您幫一個忙：${finalAsks.join('；也想請您')}。` : null,
      '',
      `${teacher} 敬上`,
    ].filter((x) => x !== null).join('\n');
  }

  /* ---------- 格式二：電話溝通要點（老師自己看的） ---------- */

  /*
   * 這一份跟上面那份的差別不只是「條列 vs 段落」：
   * 這裡可以出現老師自己的速記與原始行為卡名稱，因為讀者是老師本人。
   *
   * 「要問家長的」這一段是流程提醒，不是替老師想建議——分得很清楚：
   * 「家長該怎麼協助孩子」是教育專業判斷，跟這個家庭、這個孩子綁在一起，
   * 系統只有事件次數，編出來的建議一定是罐頭，老師照唸會被聽出來。
   * 但「先問再說」「只講行為不下定論」「約好下次回報」是溝通方法本身，
   * 跟這個孩子是誰無關，系統提供這個不會僭越任何人的專業。
   */
  const toneLabel = { praise: '報喜', concern: '需要家長一起協助', routine: '例行同步' }[tone];
  const callLines = [];
  callLines.push(`【${name}／${className || '未指定班級'}／${toneLabel}】`);
  callLines.push('');
  callLines.push('■ 通話前先想好');
  callLines.push(`・這通電話要達成的一件事：${tone === 'praise' ? '讓家長知道孩子做對了什麼' : '取得家長的視角，不是取得家長的處置'}`);
  if (tone === 'concern') {
    callLines.push('・先講的正向事實（不要跳過）：' + opening.text.replace(/^先跟您說一件好的：/, ''));
  }
  callLines.push('');
  callLines.push('■ 要講的具體事實（只講看到的，不講推論）');
  [...positiveGroups, ...improveGroups, ...otherGroups].forEach((g) => {
    callLines.push(`・${rawLine(g)}`);
  });
  if (noteKept.length) {
    callLines.push('');
    callLines.push('■ 我當時記下的備註');
    noteKept.forEach((n) => callLines.push(`・${mdText(n.ts)}：${n.text}`));
  }
  callLines.push('');
  callLines.push('■ 要問家長的（先問，不要先給建議）');
  if (tone === 'praise') {
    callLines.push('・他回家有提過學校的事嗎？');
    callLines.push('・您希望我多注意他哪一塊？');
  } else {
    callLines.push('・這樣的情況，您在家裡有看到類似的嗎？');
    callLines.push('・最近家裡有沒有什麼變動，是我這邊該知道的？');
  }
  /*
   * 報喜時不塞「希望家長協助」的佔位符。
   * 打電話報喜卻夾帶一句待辦，家長下次看到來電會先緊張——
   * 報喜這通電話的唯一任務就是報喜，老師真的有事要請託才列出來。
   */
  if (finalAsks.length || tone !== 'praise') {
    callLines.push('');
    callLines.push('■ 希望家長協助');
    if (finalAsks.length) finalAsks.forEach((a) => callLines.push(`・${a}`));
    else callLines.push(`・${ASK_PLACEHOLDER}`);
  }
  callLines.push('');
  callLines.push('■ 收尾');
  callLines.push('・約好下次回報的時間，讓家長知道這件事有人繼續看');
  callLines.push('・提醒自己：全程只講行為與時間，不對孩子下定論');
  const callPoints = callLines.join('\n');

  /* ---------- 自我檢查：連範本自己都要過同一關 ---------- */

  const selfHits = [...labelHits(note), ...labelHits(callPoints)];
  if (selfHits.length) {
    warnings.push(
      `草稿本身出現結論式字眼（${selfHits.map((h) => h.term).join('、')}），這是程式的錯，請回報。`
    );
  }
  const untraceable = [
    ...traceNumbers(note, allowed),
    ...traceNumbers(callPoints, allowed),
  ];
  if (untraceable.length) {
    warnings.push(
      `草稿裡有追溯不到來源的數字（${untraceable.join('、')}），這是程式的錯，請回報。`
    );
  }

  return {
    ok: true,
    tone,
    note,
    callPoints,
    allowed: [...allowed].sort((a, b) => a - b),
    warnings,
    reason: '',
    openingLevel: opening.level,
  };
}

/* ================================================================== *
 * 以下是頁面綁定。Node 測試載入這個模組時不會執行到。
 * ================================================================== */

if (typeof document !== 'undefined') {
  const { store } = await import('./store-select.js');
  const { SEED } = await import('./data.js');
  const { studentFacts } = await import('./summarize.js');
  const { polish } = await import('./ai-client.js');
  const { AI_ENABLED } = await import('./config.js');

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const state = {
    classes: [],
    behaviors: [],
    events: [],
    classId: '',
    studentId: '',
    days: 14,
    picked: new Set(),
    draft: null,
  };

  const isoDaysAgo = (n) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - n);
    return d.toISOString();
  };

  function toast(msg) {
    const t = $('toast');
    $('toastText').textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 2400);
  }

  const cls = () => state.classes.find((c) => c.id === state.classId);
  const stu = () => (cls()?.students || []).find((s) => s.id === state.studentId);

  function fillClassSelect() {
    $('classSelect').innerHTML = state.classes
      .map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    $('classSelect').value = state.classId;
  }

  function fillStudentSelect() {
    const list = cls()?.students || [];
    $('studentSelect').innerHTML = list
      .map((s) => `<option value="${esc(s.id)}">${esc(s.no)} ${esc(s.name)}</option>`).join('');
    if (!list.some((s) => s.id === state.studentId)) state.studentId = list[0]?.id || '';
    $('studentSelect').value = state.studentId;
  }

  function myEvents() {
    const since = isoDaysAgo(state.days - 1);
    return state.events
      .filter((e) => e.studentId === state.studentId && e.ts >= since && !e.voided)
      .sort((a, b) => b.ts.localeCompare(a.ts));
  }

  function renderEvents() {
    const list = myEvents();
    const bmap = new Map(state.behaviors.map((b) => [b.id, b]));
    if (!list.length) {
      $('eventList').innerHTML = '<p class="empty">這段期間沒有紀錄。把天數拉長，或先去記幾筆。</p>';
      return;
    }
    $('eventList').innerHTML = list.map((e) => {
      const b = bmap.get(e.behaviorId) || {};
      const d = new Date(e.ts);
      const when = `${d.getMonth() + 1}/${d.getDate()}`;
      const on = state.picked.has(e.id) ? ' checked' : '';
      return `<label class="ev ev-${esc(e.kind)}">
        <input type="checkbox" data-ev="${esc(e.id)}"${on}>
        <span class="ev-when">${esc(when)}</span>
        <span class="ev-label">${esc(b.icon || '')} ${esc(b.label || e.behaviorId)}</span>
        <span class="ev-period">${esc(e.period || '')}</span>
        ${e.note ? `<span class="ev-note">${esc(e.note)}</span>` : ''}
      </label>`;
    }).join('');
  }

  function renderDraft() {
    const d = state.draft;
    const box = $('draftBox');
    if (!d) { box.hidden = true; return; }
    box.hidden = false;
    if (!d.ok) {
      $('draftBody').innerHTML = `<p class="empty">${esc(d.reason)}</p>`;
      $('warnBox').innerHTML = '';
      return;
    }
    const toneText = { praise: '報喜', concern: '需要家長一起協助', routine: '例行同步' }[d.tone];
    $('draftBody').innerHTML = `
      <p class="hint">情境判定：<strong>${esc(toneText)}</strong>。兩份都可以直接改，改完按複製。</p>
      <div class="draft-pane">
        <div class="pane-head"><h4>聯絡簿短留言（給家長讀）</h4>
          <button class="btn btn-ghost btn-sm" data-copy="noteOut">複製</button></div>
        <textarea id="noteOut" rows="14"></textarea>
      </div>
      <div class="draft-pane">
        <div class="pane-head"><h4>電話溝通要點（給你自己看）</h4>
          <button class="btn btn-ghost btn-sm" data-copy="callOut">複製</button></div>
        <textarea id="callOut" rows="18"></textarea>
      </div>`;
    $('noteOut').value = d.note;
    $('callOut').value = d.callPoints;
    $('warnBox').innerHTML = d.warnings.length
      ? `<div class="notice"><strong>要提醒你幾件事</strong><ul>${
        d.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`
      : '';
  }

  function generate() {
    const s = stu();
    if (!s) return;
    const picked = myEvents().filter((e) => state.picked.has(e.id));
    state.draft = buildContactDraft({
      facts: studentFacts({
        events: state.events,
        student: s,
        className: cls()?.name || '',
        behaviors: state.behaviors,
        since: isoDaysAgo(state.days - 1),
      }),
      events: picked,
      behaviors: state.behaviors,
      teacherName: $('teacherName').value,
      mode: $('modeSelect').value,
      asks: [$('ask1').value, $('ask2').value],
    });
    renderDraft();
  }

  async function doPolish() {
    if (!state.draft?.ok) return;
    const s = stu();
    const facts = studentFacts({
      events: state.events, student: s, className: cls()?.name || '',
      behaviors: state.behaviors, since: isoDaysAgo(state.days - 1),
    });
    const { text, source, notice } = await polish($('noteOut').value, facts, {
      instruction: '這是老師寫給家長的聯絡簿留言。只調整語氣讓它更自然，'
        + '不得新增任何事實或數字，不得對學生下任何評價或標籤。',
    });
    if (labelHits(text).length || traceNumbers(text, new Set(state.draft.allowed)).length) {
      toast('潤稿結果沒通過標籤／數字檢查，維持原稿。');
      return;
    }
    $('noteOut').value = text;
    toast(source === 'ai' ? '已潤稿。請自己再讀一遍。' : (notice || '潤稿未開啟，維持原稿。'));
  }

  function wire() {
    $('classSelect').onchange = (e) => {
      state.classId = e.target.value; state.picked.clear();
      fillStudentSelect(); renderEvents(); state.draft = null; renderDraft();
    };
    $('studentSelect').onchange = (e) => {
      state.studentId = e.target.value; state.picked.clear();
      renderEvents(); state.draft = null; renderDraft();
    };
    $('daySelect').onchange = (e) => {
      state.days = Number(e.target.value); state.picked.clear(); renderEvents();
    };
    $('eventList').addEventListener('change', (e) => {
      const id = e.target.dataset.ev;
      if (!id) return;
      if (e.target.checked) state.picked.add(id); else state.picked.delete(id);
    });
    $('genBtn').onclick = generate;
    $('polishBtn').onclick = doPolish;
    document.body.addEventListener('click', async (e) => {
      const target = e.target.dataset?.copy;
      if (!target) return;
      try {
        await navigator.clipboard.writeText($(target).value);
        toast('已複製。貼到聯絡簿或 LINE 之前，請再讀一遍。');
      } catch {
        $(target).select();
        toast('請按 Ctrl/⌘+C 複製。');
      }
    });
  }

  async function main() {
    await store.init(SEED);
    state.classes = await store.getClasses();
    state.behaviors = await store.getBehaviors();
    state.events = await store.queryEvents({});
    state.classId = state.classes[0]?.id || '';
    fillClassSelect();
    fillStudentSelect();
    renderEvents();
    wire();
    if (!AI_ENABLED) $('polishBtn').title = '潤稿服務未開啟，按了會維持原稿。';
  }

  await main();
}
