/*
 * 學期評語草稿（ROADMAP 3.1）。
 *
 * 這支檔案分兩層：
 *   上半 = 純函式骨架產生器（buildComment / buildClassComments）——不碰 DOM、不碰 AI，
 *          事實包進、評語草稿出，可以單獨測。
 *   下半 = 頁面（只有在瀏覽器裡才會跑）。
 *
 * 骨架本身就必須是一份老師可以直接用的評語。AI 潤稿是可選的第二步，
 * 關掉時只是文字生硬一點，不是功能殘廢。
 *
 * ── 為什麼一句話都不敢多寫 ────────────────────────────────────
 * 驗收條件是「內容必須可追溯到具體事件，不得虛構」。所以這裡有一條硬規矩：
 * **骨架裡的每一個阿拉伯數字，都必須是事實包裡原封不動存在的值，不做任何加減運算。**
 * 例如「正向 12 次、待改進 2 次」可以寫，但「共 14 筆紀錄」不行——
 * 14 是我算出來的，事實包裡找不到，它會被 functions/api/ai 的數字白名單判定為虛構。
 * 換句話說：擋 AI 虛構的那道機器檢查，同一把尺也拿來量骨架自己。
 */

/* ──────────────────────────────────────────────────────────────
 * 決策一：資料太少時不硬生
 *
 * 門檻＝行為事件 6 筆以上，且分布在 3 天以上。兩個條件都要滿足。
 *
 * 6 筆：一份 150 字的評語大概要撐起 5～6 個可引用的事實點（總量、前幾名行為、
 *       具體事例、趨勢、參與密度）。少於 6 筆時，「最常出現的行為」是 1 次比 1 次，
 *       排名沒有意義；前後半段的趨勢比較也只是雜訊。硬寫出來的東西看起來像評語，
 *       其實是把雜訊包裝成結論——那比空白更糟。
 * 3 天：6 筆紀錄如果全擠在同一天，代表的是「那天發生了什麼事」，
 *       不是「這學期這個孩子怎麼樣」。學期評語要的是後者。
 *
 * 不足時回傳的不是空字串，是一句誠實的說明加上手上僅有的資料，
 * 讓老師知道「不是系統壞了，是資料真的不夠」，並且知道還差多少。
 * ────────────────────────────────────────────────────────────── */
import { labelHits } from './labels.js';

export const MIN_EVENTS = 6;
export const MIN_ACTIVE_DAYS = 3;

/* ──────────────────────────────────────────────────────────────
 * 決策二：待改進怎麼寫（這一題最難）
 *
 * 立場：**寫，但只寫彙整後的行為與次數，不寫日期、不引用負向備註原文，
 *       而且偶發的不寫。**
 *
 * 理由分三層：
 *
 * 1. 不能不寫。學期評語是老師對家長的專業判斷，把待改進整段抹掉，
 *    等於讓家長在毫無預警下接到下學期的電話。隱瞞不是善意。
 *
 * 2. 但不能寫成流水帳。學期評語會被存檔、會被轉傳、可能跟著孩子好幾年。
 *    「4/15 課堂講話、4/22 未交作業、5/3 課堂講話」這種明細寫進去，
 *    就是把當下已經處理完的事變成永久檔案。契約也寫明：給家長或學生看的文字
 *    不得出現負向行為的明細。所以只保留「最常出現的那一項 + 次數」。
 *
 * 3. 負向備註原文一個字都不引用。備註是老師當下的私人記事
 *    （「上課跟隔壁聊漫畫，提醒後有收斂」），寫給自己看的口吻，
 *    直接搬進給家長的評語會變成翻舊帳。正向備註則相反——那是最好的素材，
 *    見決策三。老師如果真的想提某一件事，頁面上會把負向備註原文列給他看，
 *    由他自己決定怎麼措辭，而不是由程式替他做這個決定。
 *
 * 偶發的不寫，而且門檻要看「同一項行為」而不是總數。三道條件同時成立才寫：
 *   a. 待改進總次數 ≥ 3         —— 一兩次是當天就處理完的事。
 *   b. 佔行為紀錄 ≥ 15%          —— 3 次待改進配 60 次正向，那不是問題。
 *   c. 被點名那一項本身 ≥ 3 次   —— 這一條是實際跑示範資料才補上的。
 *
 * c 的由來：原本只看總數，結果一位學生「待改進 3 次」但分散在三種行為，
 * 評語卻寫成「需要一起留意的是與人衝突，這學期記了 2 次」——
 * 把一件偶發的事點名成整學期的代表，正是這一段一開始就說不要做的事。
 * 沒有任何一項重複到 3 次，就代表沒有「反覆出現的模式」可講；
 * 這時不寫這一句，概況句裡的待改進總次數已經誠實交代過了，不算隱瞞。
 * ────────────────────────────────────────────────────────────── */
export const IMPROVE_MIN_COUNT = 3;
export const IMPROVE_MIN_RATIO = 0.15;

/* 目標長度。中文非空白字元計。低於下限不硬補（沒有事實就是沒有），
 * 超過上限則依優先度砍掉可省的句子。 */
export const TARGET_MIN = 120;
export const TARGET_MAX = 200;

/* 決策三之外的第三條紅線：不下標籤。
 * 這串字是「不准出現在骨架裡」的清單，測試會拿它來掃。
 * 它們的共同點是把行為說成人格——一旦寫成人格，家長就沒得討論了。 */
export const LABEL_WORDS = [
  '個性', '性格', '天生', '本性', '資質', '聰明', '愚笨', '懶',
  '內向', '外向', '活潑開朗', '孤僻', '乖巧', '調皮', '散漫',
  '態度不佳', '態度不好', '品行', '沒禮貌', '不受教', '孺子可教',
  '熱心的孩子', '善良的孩子', '是個好學生', '問題學生',
];

export function containsLabelWords(text) {
  return LABEL_WORDS.filter((w) => String(text).includes(w));
}

/** 2026-05-31 → 5/31。只取月日，年份在開頭的期間已經交代過了。 */
function md(iso) {
  const [, m, d] = String(iso).split('-');
  return `${Number(m)}/${Number(d)}`;
}

const charCount = (s) => String(s).replace(/\s/g, '').length;

/** 「幫助同學 4 次、主動發言 4 次」 */
function behaviorPhrase(list, limit) {
  return list.slice(0, limit).map((b) => `${b.label} ${b.count} 次`).join('、');
}

/**
 * 決策三：老師的備註怎麼用。
 *
 * 這一欄是整包資料裡唯一「有人味」的東西——其它全是次數。
 * 一份只有次數的評語就是罐頭；差別完全在能不能引到當初那一句話。
 *
 * 用法有三個刻意的選擇：
 *   a. 原話照抄，不改寫。改寫就會失真，而且老師當下寫的口語本來就是最具體的
 *      （「段考數學從 48 進步到 71」比「學業有所進步」有用一百倍）。
 *      引號原封不動，也讓老師一眼認得出「這句是我自己寫的」，改起來有把握。
 *   b. 只引正向備註（理由見決策二第 3 點）。
 *   c. 由近而遠取最多 2 則。近期的事家長比較有感，老師自己也還記得細節；
 *      引超過 2 則會把 150 字全吃掉，其它面向就沒位置了。
 */
function noteCandidates(facts) {
  return (facts.notes || []).filter((n) => n.kind === 'positive' && String(n.note).trim());
}

/*
 * 濾網要在取前兩則「之前」跑。
 * 先取後濾的話，一則帶標籤的近期備註會佔掉名額然後被丟掉，
 * 結果是明明還有乾淨的備註可用，評語裡卻一則都沒有。
 */
function pickNotes(facts, limit = 2) {
  return noteCandidates(facts)
    .filter((n) => labelHits(n.note).length === 0)
    .slice(-limit)
    .reverse();
}

/*
 * 被濾網擋下的備註。
 *
 * 評語是要交到家長手上的文件，備註卻是老師寫給自己看的速記口吻——
 * 「他就是懶」原封不動變成評語的一句，傷的是一個孩子。
 * 但也不能無聲無息地丟掉：老師要知道是哪一則、踩到哪個字，才有機會自己改寫。
 */
function noteWarnings(facts) {
  return noteCandidates(facts)
    .map((n) => ({ n, hits: labelHits(n.note) }))
    .filter((x) => x.hits.length)
    .map(({ n, hits }) => `${n.ts} 的備註「${n.note}」含有結論式字眼`
      + `（${hits.map((h) => h.term).join('、')}），沒有引用到評語裡。`);
}

/**
 * 一位學生的評語草稿。
 *
 * @param {object} facts summarize.js 的 studentFacts() 產物
 * @returns {{enough:boolean, text:string, reasons:string[], cited:object[], length:number}}
 *   enough=false 代表資料不足，text 是誠實的說明而不是硬湊的評語。
 */
export function buildComment(facts, { name } = {}) {
  const who = name || facts?.student?.name || '這位學生';
  const t = facts?.totals || { positive: 0, improve: 0 };
  const total = t.positive + t.improve; // 只用來判斷門檻，絕不寫進文字
  const activeDays = facts?.activeDays || 0;
  const range = facts?.range || {};
  const span = range.from && range.to ? `${md(range.from)}–${md(range.to)}` : '';

  // ---- 資料不足：誠實說不夠，並說明還差多少 ----
  if (total < MIN_EVENTS || activeDays < MIN_ACTIVE_DAYS) {
    const reasons = [];
    if (total < MIN_EVENTS) reasons.push(`行為紀錄不到 ${MIN_EVENTS} 筆`);
    if (activeDays < MIN_ACTIVE_DAYS) reasons.push(`只分布在 ${activeDays} 天`);
    return {
      enough: false,
      reasons,
      cited: [],
      warnings: noteWarnings(facts),
      text: `${who}目前的紀錄是正向 ${t.positive} 次、待改進 ${t.improve} 次，`
        + `${reasons.join('、')}，樣本不足以代表整學期，這裡不生成評語。`
        + `請先補登紀錄，或直接由你手寫——硬湊出來的評語對家長沒有意義。`,
      length: 0,
    };
  }

  const cited = [];
  const sentences = [];

  // S1 概況。只搬事實包裡原有的數字，不做加總。
  sentences.push({
    key: 'overview',
    keep: true,
    text: span
      ? `${who}這學期（${span}）的紀錄裡，正向 ${t.positive} 次、待改進 ${t.improve} 次。`
      : `${who}這學期的紀錄裡，正向 ${t.positive} 次、待改進 ${t.improve} 次。`,
  });
  cited.push({ from: 'totals', detail: `正向 ${t.positive}／待改進 ${t.improve}` });

  // S2 最常出現的正向行為
  const posTop = facts.positiveTop || [];
  if (posTop.length) {
    sentences.push({
      key: 'positiveTop',
      keep: true,
      text: `最常出現的是${behaviorPhrase(posTop, 3)}。`,
    });
    cited.push({ from: 'positiveTop', detail: behaviorPhrase(posTop, 3) });
  }

  // S3 具體事例——老師自己寫的備註，這一句是整份評語會不會像罐頭的分水嶺
  const notes = pickNotes(facts);
  if (notes.length) {
    const quoted = notes.map((n) => `${md(n.ts)}「${n.note}」`).join('、');
    sentences.push({
      key: 'notes',
      keep: true,
      text: `其中幾次當下留了紀錄：${quoted}。`,
    });
    notes.forEach((n) => cited.push({ from: 'notes', detail: `${n.ts} ${n.note}` }));
  }

  // S4 趨勢。summarize.js 已經把「差一兩分就宣稱有趨勢」擋掉了，
  // 這裡拿到 up/down 就是真的有差距，可以照寫。
  const tr = facts.trend || {};
  if (tr.direction === 'up') {
    sentences.push({
      key: 'trend',
      text: `後半學期累積的分數比前半段多（${tr.firstHalf} 分到 ${tr.secondHalf} 分）。`,
    });
    cited.push({ from: 'trend', detail: `${tr.firstHalf} → ${tr.secondHalf}` });
  } else if (tr.direction === 'down') {
    sentences.push({
      key: 'trend',
      text: `後半學期累積的分數比前半段少（${tr.firstHalf} 分到 ${tr.secondHalf} 分），`
        + `這段時間的變化值得我們再一起看看。`,
    });
    cited.push({ from: 'trend', detail: `${tr.firstHalf} → ${tr.secondHalf}` });
  }

  // S5 待改進（決策二）
  const impTop = facts.improveTop || [];
  const ratio = total ? t.improve / total : 0;
  const top = impTop[0];
  if (t.improve >= IMPROVE_MIN_COUNT && ratio >= IMPROVE_MIN_RATIO
      && top && top.count >= IMPROVE_MIN_COUNT) {
    sentences.push({
      key: 'improve',
      keep: true,
      text: `需要一起留意的是${top.label}，這學期記了 ${top.count} 次，`
        + `下學期我們會在課堂上多提醒。`,
    });
    cited.push({ from: 'improveTop', detail: `${top.label} ${top.count} 次` });
  }

  // S6 參與密度。最不重要，字數超標時第一個砍。
  sentences.push({
    key: 'activeDays',
    text: `整學期共有 ${activeDays} 天留下紀錄。`,
  });
  cited.push({ from: 'activeDays', detail: `${activeDays} 天` });

  // ---- 依優先度收斂到目標字數 ----
  const dropOrder = ['activeDays', 'trend'];
  let picked = sentences.slice();
  const join = (list) => list.map((s) => s.text).join('');
  for (const key of dropOrder) {
    if (charCount(join(picked)) <= TARGET_MAX) break;
    picked = picked.filter((s) => s.key !== key || s.keep);
  }
  // 還是太長就把引用的備註砍到一則（最後手段，因為備註最有價值）
  if (charCount(join(picked)) > TARGET_MAX && notes.length > 1) {
    picked = picked.map((s) => (s.key === 'notes'
      ? { ...s, text: `其中幾次當下留了紀錄：${md(notes[0].ts)}「${notes[0].note}」。` }
      : s));
  }

  const text = join(picked);
  return {
    enough: true,
    text,
    reasons: [],
    cited,
    warnings: noteWarnings(facts),
    length: charCount(text),
  };
}

/** 整班一次產生。30 個人一個一個點沒人會用。 */
export function buildClassComments(factsList) {
  return (factsList || []).map((facts) => ({
    studentId: facts?.student?.id,
    no: facts?.student?.no,
    name: facts?.student?.name,
    ...buildComment(facts),
  }));
}

/* ══════════════════════════════════════════════════════════════
 * 以下是頁面。node 跑測試時 document 不存在，整段不會執行。
 * ══════════════════════════════════════════════════════════════ */

if (typeof document !== 'undefined') {
  const { store } = await import('./store-select.js');
  const { SEED } = await import('./data.js');
  const { studentFacts } = await import('./summarize.js');
  const { polish } = await import('./ai-client.js');
  const { AI_ENABLED } = await import('./config.js');

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const state = {
    classes: [], behaviors: [], events: [],
    classId: null, since: '', until: '',
    rows: [], // { studentId, name, no, facts, result, text, notice }
  };

  /** 預設期間＝本學期。8 月到隔年 1 月算上學期，2 月到 7 月算下學期。 */
  function defaultRange() {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    const iso = (d) => d.toISOString().slice(0, 10);
    if (m >= 8) return { since: `${y}-08-01`, until: iso(now) };
    if (m <= 1) return { since: `${y - 1}-08-01`, until: iso(now) };
    return { since: `${y}-02-01`, until: iso(now) };
  }

  function toast(msg) {
    const el = $('#toast');
    $('#toastText').textContent = msg;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 2600);
  }

  /*
   * 複製。navigator.clipboard 在非 https 的本機開發、舊瀏覽器、或使用者拒絕權限時
   * 會直接丟例外——老師只會看到「按了沒反應」。所以留一條 execCommand 的舊路，
   * 兩條都不通才報錯，而且報錯時把文字選起來讓他自己按 Cmd+C，不是叫他自求多福。
   */
  async function copy(text, msg = '已複製', srcEl = null) {
    try {
      // 加逾時：某些情境（例如頁面被嵌在 iframe 裡、權限提示卡住）
      // writeText 的 promise 會永遠不 settle，按下去完全沒有反應。
      // 實測就踩到這個，所以寧可 1.5 秒後改走舊路，也不要讓老師對著沒動靜的按鈕發呆。
      await Promise.race([
        navigator.clipboard.writeText(text),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500)),
      ]);
      return toast(msg);
    } catch { /* 換下一招 */ }

    const tmp = document.createElement('textarea');
    tmp.value = text;
    tmp.style.cssText = 'position:fixed;top:-9999px';
    document.body.appendChild(tmp);
    tmp.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    tmp.remove();
    if (ok) return toast(msg);

    if (srcEl) srcEl.select();
    toast('這個瀏覽器擋住了自動複製，文字已選起來，請按 Cmd/Ctrl + C。');
  }

  function currentClass() {
    return state.classes.find((c) => c.id === state.classId) || state.classes[0];
  }

  function generate() {
    const cls = currentClass();
    if (!cls) return;
    const until = state.until ? `${state.until}T23:59:59.999Z` : undefined;
    const since = state.since ? `${state.since}T00:00:00.000Z` : undefined;
    state.rows = (cls.students || []).map((s) => {
      const facts = studentFacts({
        events: state.events, student: s, className: cls.name,
        behaviors: state.behaviors, since, until,
      });
      const result = buildComment(facts);
      return {
        studentId: s.id, no: s.no, name: s.name,
        facts, result, text: result.text, notice: '',
      };
    });
    render();
  }

  function factList(facts) {
    const rows = [];
    const t = facts.totals;
    rows.push(`正向 ${t.positive} 次（${t.positivePoints} 分）／待改進 ${t.improve} 次（${t.improvePoints} 分）`);
    if (facts.positiveTop.length) rows.push(`正向前幾名：${behaviorPhrase(facts.positiveTop, 5)}`);
    if (facts.improveTop.length) rows.push(`待改進前幾名：${behaviorPhrase(facts.improveTop, 5)}`);
    rows.push(`有紀錄的天數：${facts.activeDays} 天`);
    const notes = facts.notes || [];
    if (notes.length) {
      rows.push('你當初寫的備註：');
      notes.slice().reverse().forEach((n) => {
        rows.push(`　${n.ts}　${n.kind === 'positive' ? '正向' : '待改進'}　${n.label}：${n.note}`);
      });
    }
    return rows;
  }

  function cardHTML(row, i) {
    const r = row.result;
    const short = !r.enough;
    return `
      <article class="cmt ${short ? 'is-short' : ''}" data-i="${i}">
        <div class="cmt-head">
          <h3>${String(row.no).padStart(2, '0')} ${esc(row.name)}</h3>
          <span class="cmt-len">${short ? '資料不足' : `${r.length} 字`}</span>
        </div>
        <textarea class="cmt-text" rows="5" data-i="${i}"
          aria-label="${esc(row.name)}的評語草稿">${esc(row.text)}</textarea>
        ${row.notice ? `<p class="cmt-notice">${esc(row.notice)}</p>` : ''}
        ${(r.warnings || []).map((w) => `<p class="cmt-warn">${esc(w)}</p>`).join('')}
        <div class="cmt-acts">
          <button class="btn btn-primary btn-sm" data-act="copy" data-i="${i}">複製</button>
          <button class="btn btn-ghost btn-sm" data-act="polish" data-i="${i}"
            ${short ? 'disabled' : ''}>潤稿</button>
          <button class="btn btn-ghost btn-sm" data-act="reset" data-i="${i}">還原草稿</button>
        </div>
        <details class="cmt-facts">
          <summary>這段話的依據（${r.cited.length} 項）</summary>
          <ul>${factList(row.facts).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        </details>
      </article>`;
  }

  function render() {
    const enough = state.rows.filter((r) => r.result.enough).length;
    $('#summary').textContent = state.rows.length
      ? `${state.rows.length} 位學生，${enough} 位資料足夠、${state.rows.length - enough} 位資料不足。`
      : '';
    $('#cards').innerHTML = state.rows.map(cardHTML).join('');
  }

  function bind() {
    $('#classSelect').addEventListener('change', (e) => {
      state.classId = e.target.value;
      generate();
    });
    $('#since').addEventListener('change', (e) => { state.since = e.target.value; });
    $('#until').addEventListener('change', (e) => { state.until = e.target.value; });
    $('#genBtn').addEventListener('click', generate);

    $('#copyAll').addEventListener('click', () => {
      const text = state.rows
        .filter((r) => r.result.enough)
        .map((r) => `${String(r.no).padStart(2, '0')} ${r.name}\n${r.text}`)
        .join('\n\n');
      if (!text) return toast('目前沒有資料足夠的評語可以複製。');
      copy(text, `已複製 ${state.rows.filter((r) => r.result.enough).length} 位學生的草稿`);
    });

    $('#cards').addEventListener('input', (e) => {
      const ta = e.target.closest('.cmt-text');
      if (!ta) return;
      state.rows[Number(ta.dataset.i)].text = ta.value; // 老師改過的就是老師的
    });

    $('#cards').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const row = state.rows[Number(btn.dataset.i)];
      if (btn.dataset.act === 'copy') {
        return copy(row.text, `已複製 ${row.name} 的草稿`,
          btn.closest('.cmt').querySelector('.cmt-text'));
      }
      if (btn.dataset.act === 'reset') {
        row.text = row.result.text;
        row.notice = '';
        return render();
      }
      if (btn.dataset.act === 'polish') {
        btn.disabled = true;
        btn.textContent = '潤稿中…';
        const { text, source, notice } = await polish(row.text, row.facts);
        row.text = text;
        row.notice = notice || (source === 'skeleton' && AI_ENABLED ? '潤稿沒成功，這是原始草稿。' : '');
        render();
      }
    });
  }

  async function init() {
    await store.init(SEED);
    state.classes = await store.getClasses();
    state.behaviors = await store.getBehaviors();
    state.events = await store.queryEvents({});
    state.classId = state.classes[0]?.id || null;

    const d = defaultRange();
    state.since = d.since;
    state.until = d.until;
    $('#since').value = d.since;
    $('#until').value = d.until;

    $('#classSelect').innerHTML = state.classes
      .map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    $('#classSelect').value = state.classId;

    if (!AI_ENABLED) {
      $('#aiHint').textContent = '潤稿服務目前關閉，以下是資料直接組出來的草稿——'
        + '它本來就該是可以直接用的，潤稿只是讓它讀起來順一點。';
    }

    bind();
    generate();
  }

  init();
}
