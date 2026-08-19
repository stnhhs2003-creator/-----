/*
 * 導師手札週報（ROADMAP 3.3）。
 *
 * ⚠️ 閱讀對象紅線 ⚠️
 * ------------------------------------------------------------------
 * 這一頁的讀者是「老師自己」，不是家長、不是學生。
 * 全站只有兩個地方可以出現負向行為明細與需關心名單：這一頁，以及稽核頁。
 * 家長端一律走 rules.js 的 parentView()，學生端一律只看自己的正向紀錄。
 *
 * 所以：**不要把這裡的任何函式接到 parent.html / student.html**，
 * 也不要把 buildWeeklyDraft() 的輸出丟進任何會寄給家長的管道。
 * 要給家長看的東西請另外組骨架，從 parentView() 取材。
 * 這一頁的複製按鈕複製的是「老師自己的手札」，不是「聯絡簿」。
 * ------------------------------------------------------------------
 *
 * 設計上的另一條線：需關心名單一律由 rules.js 的 detectAlerts() 產生。
 * 這裡不自己判斷誰該被關心，AI 更不參與這個判斷——AI 只可能潤飾文字。
 * ROADMAP 的驗收條件「名單依告急規則產生，非 AI 自由發揮」講的就是這件事。
 */

import { detectAlerts } from './rules.js';

const DAY = 24 * 60 * 60 * 1000;
const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

const pad2 = (n) => String(n).padStart(2, '0');

/*
 * 日期一律用本地時區算，不用 ts.slice(0, 10)。
 * 台灣是 UTC+8，週一 00:00 的 ISO 字串前十碼會是「上週日」——
 * 用字串切日期在這裡剛好每次都錯一天。
 */
const fmtDate = (d) => `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
const fmtMD = (ts) => {
  const d = new Date(ts);
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
};

/**
 * 某一週的起訖（週一 00:00:00 ～ 週日 23:59:59.999，本地時區）。
 *
 * 老師常常是週末或月底才回頭補看，所以「任意一週」是基本需求，不是加分項。
 * @param {number} offset 0 = now 所在的那一週，-1 = 上一週，1 = 下一週
 * @param {Date}   now    當作錨點的日期；傳任意一天就會得到那一天所在的週
 */
export function weekBounds(offset = 0, now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const dow = (start.getDay() + 6) % 7; // 讓週一 = 0
  start.setDate(start.getDate() - dow + offset * 7);

  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  end.setHours(23, 59, 59, 999);

  return {
    since: start.toISOString(),
    until: end.toISOString(),
    startDate: start,
    endDate: end,
    label: `${fmtDate(start)}（${WEEKDAY[start.getDay()]}）～${fmtDate(end)}（${WEEKDAY[end.getDay()]}）`,
  };
}

/**
 * 取這一週的告急清單。
 *
 * 兩件事一起決定範圍：事件先切到目標那一週，時間錨點也設在那一週的最後一刻。
 * 門檻（連續幾次、一節課幾次）原封不動用老師自己的設定，
 * 換掉設定，名單就會跟著變——這是「名單來自規則引擎」最直接的證據。
 */
export function alertsForWeek({ events, students, settings, since, until }) {
  const weekEvents = (events || []).filter(
    (e) => !e.voided && e.ts >= since && e.ts <= until
  );
  /*
   * 錨點設在那一週的最後一刻，而不是「今天」。
   * 這樣觀察窗會跟著移到目標週，門檻用老師原本的設定、一個字都不動——
   * 名單是不是那一週真的該關心的人，由規則說了算。
   */
  return detectAlerts(weekEvents, students || [], settings, new Date(until));
}

/** 正向佔比的旁白。這是鏡子不是成績單——低分要指向「下週怎麼做」，不是指責老師。 */
function ratioLine(ratio, total) {
  const pct = Math.round(ratio * 100);
  if (ratio >= 0.7) {
    return `正向佔比 ${pct}%。這一週你大多在記錄孩子做對的事，維持住。`;
  }
  if (ratio >= 0.5) {
    return `正向佔比 ${pct}%。正負大致平衡，還在可以接受的範圍。`;
  }
  return `正向佔比 ${pct}%（${total} 筆裡只有一部分是正向）。`
    + '低於五成通常代表這一週班上剛好出了狀況、你在忙著滅火——'
    + '這不是你帶得不好，只是提醒你下週可以刻意找幾個機會，把好的地方也記下來。';
}

const sectionText = (sec) => {
  const lines = [`【${sec.heading}】`];
  if (sec.note) lines.push(sec.note);
  sec.items.forEach((it) => {
    lines.push(`・${it.text}`);
    (it.sub || []).forEach((s) => lines.push(`　　- ${s}`));
  });
  return lines.join('\n');
};

/**
 * 週報骨架產生器。純函式：事實包 + 告急清單進、週報草稿出。
 * 不碰 AI、不碰 DOM、不碰儲存。AI 關著的時候，這個輸出就是老師實際看到的東西，
 * 所以它本身就必須是一份可以直接用的週報。
 *
 * @param {object} facts      summarize.js 的 classFacts() 輸出
 * @param {Array}  alerts     rules.js 的 detectAlerts() 輸出（請用 alertsForWeek 取得）
 * @param {Array}  events     這一週、這個班、未撤銷的事件（拿來附具體事件）
 * @param {Array}  behaviors  行為卡，用來把 behaviorId 翻成看得懂的名字
 * @param {object} settings   告急門檻，只拿來說明「為什麼會上榜」
 * @param {string} weekLabel  weekBounds().label
 */
export function buildWeeklyDraft({
  facts,
  alerts = [],
  events = [],
  behaviors = [],
  settings = {},
  weekLabel = '',
}) {
  const labelOf = new Map((behaviors || []).map((b) => [b.id, b.label]));
  const total = facts.totals.positive + facts.totals.improve;
  const quiet = total === 0;

  const title = `導師手札週報｜${facts.className}`;
  const privacy = '※ 這一頁只給老師自己看：含待改進明細與需關心名單，請勿轉發給家長或學生。';
  const sections = [];

  if (quiet) {
    /*
     * 誠實說沒事。
     * 這種產品最快失去信任的方式，就是明明沒事也硬擠五個觀察出來——
     * 老師看兩週就知道你在講廢話，第三週就不會再打開了。
     */
    sections.push({
      id: 'quiet',
      heading: '這一週',
      items: [
        { text: '這一週沒有任何行為紀錄，沒有東西可以回顧。' },
        { text: '可能是段考週、可能是你忙別的去了——都不需要交代。' },
      ],
    });
    const text = `${[title, weekLabel, privacy].join('\n')}\n\n${sectionText(sections[0])}`;
    return { title, weekLabel, privacy, quiet, sections, watchlist: [], text };
  }

  // ---- 數字 ----
  sections.push({
    id: 'numbers',
    heading: '這一週的數字',
    items: [
      { text: `行為紀錄 ${total} 筆：正向 ${facts.totals.positive} 筆、待改進 ${facts.totals.improve} 筆。` },
      { text: `淨分 ${facts.totals.net} 分，有記錄的天數 ${facts.activeDays} 天，班上 ${facts.students} 人。` },
    ],
  });

  // ---- 正向佔比這面鏡子 ----
  sections.push({
    id: 'ratio',
    heading: '正向佔比這面鏡子',
    items: [{ text: ratioLine(facts.positiveRatio, total) }],
  });

  // ---- 行為排行：沒有就不列，不生空欄位 ----
  if (facts.positiveTop.length) {
    sections.push({
      id: 'positiveTop',
      heading: '最常出現的正向行為',
      items: facts.positiveTop.map((b) => ({ text: `${b.label} ${b.count} 次` })),
    });
  }
  if (facts.improveTop.length) {
    sections.push({
      id: 'improveTop',
      heading: '最常出現的待改進行為',
      items: facts.improveTop.map((b) => ({ text: `${b.label} ${b.count} 次` })),
    });
  }

  // ---- 需要關心的名單：完全由 detectAlerts 決定誰在榜上 ----
  const studentAlerts = alerts.filter((a) => a.level === 'student');
  const classAlerts = alerts.filter((a) => a.level === 'class');
  const statOf = new Map((facts.perStudent || []).map((s) => [s.id, s]));

  const watchlist = studentAlerts.map((a) => {
    const stat = statOf.get(a.studentId) || { no: '', name: a.studentId, positive: 0, improve: 0, net: 0 };
    const mine = events
      .filter((e) => e.studentId === a.studentId && e.kind === 'improve')
      .sort((x, y) => y.ts.localeCompare(x.ts));

    // 建議切入點＝這一週最常出現的那一項，老師才知道要談什麼
    const tally = new Map();
    mine.forEach((e) => tally.set(e.behaviorId, (tally.get(e.behaviorId) || 0) + 1));
    const top = [...tally.entries()].sort((p, q) => q[1] - p[1])[0];

    const sub = [
      `為什麼上榜：${a.title}（告急規則門檻：連續 ${settings.alertConsecutiveImprove} 次待改進未被正向紀錄打斷）`,
      `本週統計：正向 ${stat.positive} 次、待改進 ${stat.improve} 次、淨分 ${stat.net} 分。`,
    ];
    /*
     * 只有重複出現才算「模式」，才值得點名成切入點。
     * 三件事各發生一次的時候硬挑一個講，是在無中生有一個結論——
     * 老師看具體事件那幾行自己就會判斷，不需要我替他編一個重點。
     */
    if (top && top[1] >= 2) {
      sub.push(`建議切入點：${labelOf.get(top[0]) || top[0]}（本週 ${top[1]} 次）。`);
    }
    mine.slice(0, 6).forEach((e) => {
      sub.push(`${fmtMD(e.ts)} ${e.period || '未註明節次'}　${labelOf.get(e.behaviorId) || e.behaviorId}${e.note ? `：${e.note}` : ''}`);
    });

    return {
      studentId: a.studentId,
      text: `${stat.no ? `${stat.no} 號 ` : ''}${stat.name}`,
      sub,
    };
  });

  sections.push({
    id: 'watchlist',
    heading: '需要關心的名單',
    note: '（依告急規則自動產生，不是憑印象也不是 AI 挑的）',
    items: watchlist.length
      ? watchlist
      : [{ text: '這一週沒有人達到告急門檻。名單是空的——這是好消息，不是漏掉了。' }],
  });

  if (classAlerts.length) {
    sections.push({
      id: 'classAlerts',
      heading: '全班節奏',
      note: `（同一節課全班待改進達 ${settings.alertClassImprovePerPeriod} 次就會列出來）`,
      items: classAlerts.map((a) => ({ text: a.title, sub: [a.detail] })),
    });
  }

  const text = `${[title, weekLabel, privacy].join('\n')}\n\n${sections.map(sectionText).join('\n\n')}`;

  return { title, weekLabel, privacy, quiet, sections, watchlist, text };
}

/* ==================================================================
 * 以下是頁面接線。node --test 匯入這支檔案時不會執行到（沒有 document）。
 * ================================================================== */

if (typeof document !== 'undefined' && document.getElementById('weeklyRoot')) {
  const { store } = await import('./store-select.js');
  const { SEED, DEFAULT_SETTINGS } = await import('./data.js');
  const { classFacts } = await import('./summarize.js');
  const { AI_ENABLED } = await import('./config.js');
  const { polish } = await import('./ai-client.js');

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  await store.init(SEED);

  const state = {
    classes: await store.getClasses(),
    behaviors: await store.getBehaviors(),
    settings: { ...DEFAULT_SETTINGS, ...(await store.getSettings()) },
    classId: '',
    anchor: new Date(),   // 目標週裡的任何一天
    draft: null,
  };
  state.classId = state.classes[0]?.id || '';

  function toast(msg) {
    const el = $('#toast');
    $('#toastText').textContent = msg;
    el.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { el.hidden = true; }, 4000);
  }

  function renderClassSelect() {
    $('#classSelect').innerHTML = state.classes
      .map((c) => `<option value="${esc(c.id)}"${c.id === state.classId ? ' selected' : ''}>${esc(c.name)}</option>`)
      .join('');
  }

  async function render() {
    const cls = state.classes.find((c) => c.id === state.classId);
    if (!cls) {
      $('#weeklyRoot').innerHTML = '<p class="hint">還沒有班級。請先到「班級名冊」建立一個班。</p>';
      return;
    }

    const week = weekBounds(0, state.anchor);
    $('#weekLabel').textContent = week.label;
    $('#jumpDate').value = `${week.startDate.getFullYear()}-${pad2(week.startDate.getMonth() + 1)}-${pad2(week.startDate.getDate())}`;

    const all = await store.queryEvents({ classId: cls.id });
    const weekEvents = all.filter((e) => e.ts >= week.since && e.ts <= week.until);

    const facts = classFacts({
      events: all,
      cls,
      behaviors: state.behaviors,
      since: week.since,
      until: week.until,
    });
    const alerts = alertsForWeek({
      events: all,
      students: cls.students || [],
      settings: state.settings,
      since: week.since,
      until: week.until,
    });

    state.facts = facts;
    state.draft = buildWeeklyDraft({
      facts,
      alerts,
      events: weekEvents,
      behaviors: state.behaviors,
      settings: state.settings,
      weekLabel: week.label,
    });
    paint(state.draft);
  }

  function paint(draft) {
    const body = draft.sections.map((sec) => `
      <section class="wk-sec">
        <h3>${esc(sec.heading)}</h3>
        ${sec.note ? `<p class="hint">${esc(sec.note)}</p>` : ''}
        <ul class="wk-list">
          ${sec.items.map((it) => `
            <li>
              <span class="wk-item">${esc(it.text)}</span>
              ${(it.sub || []).length ? `<ul class="wk-sub">${it.sub.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
            </li>`).join('')}
        </ul>
      </section>`).join('');

    $('#weeklyRoot').innerHTML = `
      <article class="wk-paper">
        <h2 class="wk-title">${esc(draft.title)}</h2>
        <p class="wk-range">${esc(draft.weekLabel)}</p>
        <p class="wk-private">${esc(draft.privacy)}</p>
        ${body}
      </article>`;
    $('#plainText').value = draft.text;
  }

  /* ---- 操作 ---- */

  $('#classSelect').addEventListener('change', (e) => {
    state.classId = e.target.value;
    render();
  });

  $('#prevWeek').addEventListener('click', () => {
    state.anchor = new Date(state.anchor.getTime() - 7 * DAY);
    render();
  });
  $('#nextWeek').addEventListener('click', () => {
    state.anchor = new Date(state.anchor.getTime() + 7 * DAY);
    render();
  });
  $('#thisWeek').addEventListener('click', () => {
    state.anchor = new Date();
    render();
  });
  $('#jumpDate').addEventListener('change', (e) => {
    if (!e.target.value) return;
    const [y, m, d] = e.target.value.split('-').map(Number);
    state.anchor = new Date(y, m - 1, d);
    render();
  });

  $('#copyBtn').addEventListener('click', async () => {
    const text = $('#plainText').value;
    try {
      await navigator.clipboard.writeText(text);
      toast('已複製全文，可以貼進手札或校務系統了');
    } catch {
      // 沒有剪貼簿權限（http、舊 Safari）時退回選取，老師自己按 Cmd+C
      $('#plainText').hidden = false;
      $('#plainText').select();
      toast('這個瀏覽器不給自動複製，已幫你選起來，請按 Cmd/Ctrl + C');
    }
  });

  $('#showText').addEventListener('click', () => {
    const ta = $('#plainText');
    ta.hidden = !ta.hidden;
    $('#showText').textContent = ta.hidden ? '看純文字版' : '收起純文字版';
  });

  $('#printBtn').addEventListener('click', () => window.print());

  const aiBtn = $('#polishBtn');
  if (AI_ENABLED) {
    aiBtn.addEventListener('click', async () => {
      aiBtn.disabled = true;
      // 傳的是 summarize 的事實包，它同時是伺服器端的數字白名單
      const { text, source, notice } = await polish($('#plainText').value, state.facts);
      $('#plainText').value = text;
      $('#plainText').hidden = false;
      // notice 一定要顯示給老師看，不能吞掉：他有權知道拿到的是骨架還是潤過的
      $('#aiNote').textContent = notice
        || (source === 'ai' ? '已潤稿。數字經伺服器白名單比對，沒有出現骨架以外的數字。' : '');
      aiBtn.disabled = false;
    });
  } else {
    aiBtn.hidden = true;
    $('#aiNote').textContent = '潤稿服務目前關著（AI_ENABLED = false），你看到的是資料直接組出來的骨架。';
  }

  renderClassSelect();
  await render();
}
