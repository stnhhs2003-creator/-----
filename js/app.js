import { store } from './store-select.js';
import { SEED } from './data.js';
import {
  scoreByStudent, countsByStudent, dailyTotals,
  detectAlerts, daysAgoISO, startOfDay, isBehaviorEvent,
} from './rules.js';
import { canRecord, participating, seatCells } from './optout.js';
import { escapeHtml as esc } from './dom-safe.js';
import { requireTeacherUnlock, lockTeacherView } from './teacher-lock.js';
import { behaviorArtPath, studentAvatarPath } from './visual-assets.js';


const state = {
  classes: [],
  behaviors: [],
  settings: {},
  events: [],
  classId: null,
  period: '',
  view: 'record',
  multi: false,
  selected: new Set(),
  frontBottom: false,
  lastEventIds: [],
  lastFocus: null,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// ---------- 初始化 ----------

async function init() {
  await requireTeacherUnlock();
  await store.init(SEED);
  await reload();

  state.classId = state.classes[0]?.id || null;
  state.period = state.settings.periods?.[0] || '';

  renderClassSelect();
  renderPeriodSelect();
  renderDemoBanner();
  bindEvents();
  render();
}

async function reload() {
  state.classes = await store.getClasses();
  state.behaviors = await store.getBehaviors();
  state.settings = await store.getSettings();
  state.events = await store.queryEvents({ includeVoided: true });
}

function currentClass() {
  return state.classes.find((c) => c.id === state.classId) || state.classes[0];
}

function renderDemoBanner() {
  const students = state.classes.flatMap((cls) => cls.students || []);
  $('#demoBanner').hidden = !(students.length === 36 && students.every((s) => /^示範\d{2}$/.test(s.name)));
}

/** 目前班級的有效事件（不含已撤銷）。 */
function liveEvents(classId = state.classId) {
  return state.events.filter((e) => !e.voided && e.classId === classId);
}

function behaviorOf(id) {
  return state.behaviors.find((b) => b.id === id) || { label: '未知行為', icon: '•' };
}

/** 記錄面板只給沒被停用的行為卡。停用的卡歷史紀錄仍查得到名稱。 */
function activeBehaviors(kind) {
  return state.behaviors.filter((b) => b.kind === kind && !b.archived);
}

/** 事件的顯示名稱。積分商店的兌換不是行為卡，要另外處理。 */
function eventLabel(e) {
  if (e.kind === 'redeem') return { icon: '🎁', label: `兌換：${e.note || '獎勵'}` };
  if (e.kind === 'redeem-request') return { icon: '📝', label: `申請兌換：${e.note || '獎勵'}` };
  const b = behaviorOf(e.behaviorId);
  return { icon: b.icon, label: b.label };
}

/** pill 樣式只有三種，兌換相關一律歸到 redeem。 */
function pillClass(kind) {
  return kind === 'positive' ? 'positive' : kind === 'improve' ? 'improve' : 'redeem';
}

// ---------- 頂列 ----------

function renderClassSelect() {
  const sel = $('#classSelect');
  sel.innerHTML = state.classes
    .map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`)
    .join('');
  sel.value = state.classId;
}

function renderPeriodSelect() {
  const sel = $('#periodSelect');
  sel.innerHTML = (state.settings.periods || [])
    .map((p) => `<option value="${esc(p)}">${esc(p)}</option>`)
    .join('');
  sel.value = state.period;
}

// ---------- 座位表 ----------

function renderSeating() {
  const cls = currentClass();
  if (!cls) return;

  const all = liveEvents();
  const totals = scoreByStudent(all);
  const todayStart = startOfDay().toISOString();
  const todayTotals = scoreByStudent(all.filter((e) => e.ts >= todayStart));

  const grid = $('#seating');
  grid.style.gridTemplateColumns = `repeat(${cls.cols}, minmax(0, 1fr))`;

  // 不參與的學生留著位子，只換成不具名佔位格。
  // 抽掉那一格，後面所有人往前遞補，整張座位表就跟教室對不起來——
  // 老師點錯人，等於把一個個資問題換成另一個（紀錄記到別人身上）。
  const students = seatCells(cls.students).sort((a, b) =>
    state.frontBottom ? b.row - a.row || a.col - b.col : a.row - b.row || a.col - b.col
  );

  grid.innerHTML = students.map((s) => {
    if (s.optedOut) {
      return `
      <span class="seat is-optout" aria-label="${esc(s.no)}號 未參與記錄">
        <span class="seat-no">${esc(s.no)}號</span>
        <span class="seat-name">${esc(s.label)}</span>
      </span>`;
    }
    const total = totals.get(s.id) || 0;
    const today = todayTotals.get(s.id) || 0;
    const cls2 = total > 0 ? 'pos' : total < 0 ? 'neg' : 'zero';
    const sel = state.selected.has(s.id) ? ' is-selected' : '';
    const todayLabel = today === 0 ? '今天 —' : `今天 ${today > 0 ? '+' : ''}${today}`;
    return `
      <button class="seat${sel}" data-student="${esc(s.id)}">
        <img class="seat-avatar" src="${esc(studentAvatarPath(s.id, state.classes))}" alt="" width="44" height="44" loading="lazy" decoding="async">
        <span class="seat-no">${esc(s.no)}號</span>
        <span class="seat-name">${esc(s.name)}</span>
        <span class="seat-score ${cls2}">${total > 0 ? '+' : ''}${total}</span>
        <span class="seat-today">${todayLabel}</span>
      </button>`;
  }).join('');

  $('#boardTop').hidden = state.frontBottom;
  $('#boardBottom').hidden = !state.frontBottom;
}

// ---------- 記錄面板 ----------

let sheetTargets = [];

function openSheet(studentIds) {
  const cls = currentClass();
  // 多選框選、補登都可能夾帶不參與的學生進來。這裡是第二道保險，
  // 真正的閘門在 store.appendEvent——這裡只是讓面板不要開了才失敗。
  studentIds = studentIds.filter((id) =>
    canRecord(state.classes, { classId: state.classId, studentId: id }).ok);
  if (!studentIds.length) return;
  sheetTargets = studentIds;
  const names = studentIds
    .map((id) => cls.students.find((s) => s.id === id)?.name)
    .filter(Boolean);

  $('#sheetTitle').textContent =
    names.length === 1 ? `記錄：${names[0]}` : `記錄：${names.length} 位學生`;

  const card = (b) => {
    const art = behaviorArtPath(b.id);
    const visual = art
      ? `<img class="behavior-art" src="${esc(art)}" alt="" width="52" height="52" loading="lazy" decoding="async">`
      : `<span class="icon">${esc(b.icon)}</span>`;
    return `
    <button class="bcard ${esc(b.kind)}" data-behavior="${esc(b.id)}">
      ${visual}
      <span class="label">${esc(b.label)}</span>
      <span class="delta">${b.delta > 0 ? '+' : ''}${b.delta}</span>
    </button>`;
  };

  $('#behaviorsPositive').innerHTML = activeBehaviors('positive').map(card).join('');
  $('#behaviorsImprove').innerHTML = activeBehaviors('improve').map(card).join('');

  openDialog('#sheet');
}

function closeSheet() {
  closeDialog('#sheet');
  sheetTargets = [];
  // 備註是「這一筆」的，不能黏到下一位學生身上——關閉時一律清掉並收合。
  const box = $('#noteBox');
  const input = $('#eventNote');
  if (input) input.value = '';
  if (box) box.open = false;
}

async function recordBehavior(behaviorId) {
  const beh = behaviorOf(behaviorId);
  const ids = [...sheetTargets];
  // 備註要在 closeSheet() 之前讀——關閉時會把欄位清空。
  const note = ($('#eventNote')?.value || '').trim().slice(0, 100);
  if (beh.id === 'b-conflict' && !note) {
    $('#noteBox').open = true;
    $('#eventNote').focus();
    showToast('記錄「與人衝突」前，請先寫下可查證的具體情況。');
    return;
  }
  if (beh.kind === 'improve' && ids.length > 1 &&
      !confirm(`要為 ${ids.length} 位學生記下「${beh.label}」嗎？請確認這是逐一觀察後的紀錄。`)) {
    return;
  }
  closeSheet();

  const created = [];
  for (const studentId of ids) {
    let evt;
    try {
      evt = await store.appendEvent({
        classId: state.classId,
        studentId,
        behaviorId: beh.id,
        delta: beh.delta,
        kind: beh.kind,
        period: state.period,
        note,
      });
    } catch (err) {
      // 儲存層的不參與閘門會丟錯。訊息本身就是給老師看的白話，直接顯示。
      showToast(err.message);
      continue;
    }
    created.push(evt);
    state.events.push(evt);
  }
  if (!created.length) return;

  state.lastEventIds = created.map((e) => e.id);

  const cls = currentClass();
  const label = ids.length === 1
    ? cls.students.find((s) => s.id === ids[0])?.name
    : `${ids.length} 位學生`;

  showToast(`${label} ${beh.label} ${beh.delta > 0 ? '+' : ''}${beh.delta}`);

  if (state.multi) clearSelection();
  render();
  flashSeats(ids, beh.kind);
}

function flashSeats(ids, kind) {
  ids.forEach((id) => {
    const el = document.querySelector(`.seat[data-student="${id}"]`);
    if (!el) return;
    const c = kind === 'positive' ? 'flash-up' : 'flash-down';
    el.classList.add(c);
    setTimeout(() => el.classList.remove(c), 500);
  });
}

// ---------- 提示與撤銷 ----------

let toastTimer = null;

function showToast(text) {
  $('#toastText').textContent = text;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5000);
}

async function undoLast() {
  for (const id of state.lastEventIds) {
    await store.voidEvent(id);
    const e = state.events.find((x) => x.id === id);
    if (e) e.voided = true;
  }
  state.lastEventIds = [];
  $('#toast').hidden = true;
  render();
}

// ---------- 多選 ----------

function clearSelection() {
  state.selected.clear();
  updateMultiBar();
  renderSeating();
}

function updateMultiBar() {
  $('#multiBar').hidden = !state.multi;
  $('#multiCount').textContent = `已選 ${state.selected.size} 人`;
  $('#multiToggle').classList.toggle('is-on', state.multi);
  $('#recordHint').textContent = state.multi
    ? '點學生加入選取，選完按「為這些人記錄」。'
    : '點一位學生就能記錄。想一次記多人，先開「多選」。';
}

// ---------- 補登與稽核 ----------

function renderLog() {
  const days = Number($('#logRange').value);
  const kind = $('#logKind').value;
  const showVoided = $('#logShowVoided').checked;
  const cls = currentClass();
  const since = days >= 9999 ? '' : daysAgoISO(days - 1);

  let rows = state.events.filter((e) => e.classId === state.classId);
  if (since) rows = rows.filter((e) => e.ts >= since);
  if (kind) rows = rows.filter((e) => e.kind === kind);
  if (!showVoided) rows = rows.filter((e) => !e.voided);
  rows.sort((a, b) => b.ts.localeCompare(a.ts));

  if (!rows.length) {
    $('#logTable').innerHTML = '<p class="empty">這個範圍內沒有紀錄。</p>';
    return;
  }

  const nameOf = (id) => cls.students.find((s) => s.id === id)?.name || id;

  $('#logTable').innerHTML = `
    <table>
      <thead>
        <tr><th>時間</th><th>學生</th><th>行為</th><th>節次</th><th class="num">分數</th><th></th></tr>
      </thead>
      <tbody>
        ${rows.map((e) => {
          const b = eventLabel(e);
          const d = new Date(e.ts);
          const ts = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
          return `
            <tr class="${e.voided ? 'voided' : ''}">
              <td>${ts}</td>
              <td>${esc(nameOf(e.studentId))}</td>
              <td><span class="pill ${pillClass(e.kind)}">${esc(b.icon)} ${esc(b.label)}</span></td>
              <td>${esc(e.period || '—')}</td>
              <td class="num">${e.delta > 0 ? '+' : ''}${e.delta}</td>
              <td>${e.voided ? '已撤銷' : `<button class="linkbtn" data-void="${esc(e.id)}">撤銷</button>`}</td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

function openQuickAdd() {
  const cls = currentClass();
  state.multi = true;
  updateMultiBar();
  switchView('record');
  showToast('已開多選模式，選好學生後按「為這些人記錄」補登。');
  void cls;
}

// ---------- 儀表板 ----------

function renderDash() {
  const cls = currentClass();
  const days = Number($('#dashRange').value);
  const since = daysAgoISO(days - 1);
  const evts = liveEvents().filter((e) => e.ts >= since);

  // 告急。名冊裡已經沒有的學生不再提醒，否則會顯示原始 id。
  const active = participating(cls.students);
  const roster = new Set(active.map((s) => s.id));
  const alerts = detectAlerts(
    liveEvents().filter((e) => roster.has(e.studentId)),
    active,
    state.settings
  );
  $('#alerts').innerHTML = alerts.length
    ? alerts.map((a) => `
        <div class="alert ${a.level}">
          <h4>${esc(a.title)}</h4>
          <p>${esc(a.detail)}</p>
        </div>`).join('')
    : '<div class="alert-empty">目前沒有需要留意的訊號。</div>';

  // 數字。兌換不是行為，不能灌進筆數與正向佔比的分母。
  const behaviorEvts = evts.filter(isBehaviorEvent);
  const positive = behaviorEvts.filter((e) => e.kind === 'positive');
  const improve = behaviorEvts.filter((e) => e.kind === 'improve');
  const ratio = behaviorEvts.length
    ? Math.round((positive.length / behaviorEvts.length) * 100)
    : 0;
  const covered = new Set(behaviorEvts.map((e) => e.studentId)).size;

  $('#stats').innerHTML = `
    <div class="stat"><div class="k">紀錄總筆數</div><div class="v">${behaviorEvts.length}</div></div>
    <div class="stat"><div class="k">正向佔比</div><div class="v">${ratio}%</div></div>
    <div class="stat"><div class="k">待改進筆數</div><div class="v">${improve.length}</div></div>
    <div class="stat"><div class="k">被記錄到的學生</div><div class="v">${covered}/${active.length}</div></div>`;

  // 趨勢
  const buckets = dailyTotals(evts, Math.min(days, 30));
  const max = Math.max(1, ...buckets.map((b) => Math.max(b.positive, b.improve)));
  $('#trend').innerHTML = buckets.map((b) => `
    <div class="tcol">
      <div class="tbars">
        <div class="tbar p" style="height:${(b.positive / max) * 100}%" title="正向 ${b.positive}"></div>
        <div class="tbar i" style="height:${(b.improve / max) * 100}%" title="待改進 ${b.improve}"></div>
      </div>
      <div class="tlabel">${esc(b.label)}</div>
    </div>`).join('');

  // 學生一覽
  const totals = scoreByStudent(evts);
  const counts = countsByStudent(evts);
  const rows = active
    .map((s) => ({
      s,
      total: totals.get(s.id) || 0,
      c: counts.get(s.id) || { positive: 0, improve: 0 },
    }))
    .sort((a, b) => b.total - a.total);

  $('#studentTable').innerHTML = `
    <table>
      <thead>
        <tr><th>座號</th><th>姓名</th><th class="num">正向</th><th class="num">待改進</th><th class="num">淨分</th></tr>
      </thead>
      <tbody>
        ${rows.map(({ s, total, c }) => `
          <tr data-detail="${esc(s.id)}" tabindex="0" role="button" aria-label="查看 ${esc(s.name)} 的詳細紀錄">
            <td>${esc(s.no)}</td>
            <td>${esc(s.name)}</td>
            <td class="num">${c.positive}</td>
            <td class="num">${c.improve}</td>
            <td class="num">${total > 0 ? '+' : ''}${total}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

// ---------- 學生詳情 ----------

function openDetail(studentId) {
  const cls = currentClass();
  const stu = cls.students.find((s) => s.id === studentId);
  if (!stu) return;

  const mine = liveEvents().filter((e) => e.studentId === studentId);
  const positive = mine.filter((e) => e.kind === 'positive');
  const improve = mine.filter((e) => e.kind === 'improve');
  const total = mine.reduce((s, e) => s + e.delta, 0);

  $('#detailTitle').textContent = `${stu.no}號 ${stu.name}`;
  $('#detailBody').innerHTML = `
    <div class="detail-stats">
      <div class="detail-stat"><div class="k">淨分</div><div class="v">${total > 0 ? '+' : ''}${total}</div></div>
      <div class="detail-stat"><div class="k">正向</div><div class="v">${positive.length}</div></div>
      <div class="detail-stat"><div class="k">待改進</div><div class="v">${improve.length}</div></div>
    </div>
    <div class="notice">家長端只會看到上面「正向」那一欄的內容與進步曲線，待改進紀錄不會外流。</div>
    <ul class="timeline">
      ${[...mine].reverse().slice(0, 40).map((e) => {
        const b = eventLabel(e);
        const d = new Date(e.ts);
        const ts = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        return `<li>
          <span class="t">${ts}</span>
          <span>${esc(b.icon)} ${esc(b.label)}</span>
          <span class="d ${e.delta > 0 ? 'pos' : 'neg'}">${e.delta > 0 ? '+' : ''}${e.delta}</span>
        </li>`;
      }).join('') || '<li>還沒有紀錄。</li>'}
    </ul>`;

  openDialog('#detail');
}

function openDialog(selector) {
  const dialog = $(selector);
  state.lastFocus = document.activeElement;
  dialog.hidden = false;
  requestAnimationFrame(() => dialog.querySelector('button, input, select, [tabindex="0"]')?.focus());
}

function closeDialog(selector) {
  const dialog = $(selector);
  if (dialog.hidden) return;
  dialog.hidden = true;
  if (state.lastFocus instanceof HTMLElement) state.lastFocus.focus();
  state.lastFocus = null;
}

function trapDialog(e) {
  const dialog = ['#detail', '#sheet'].map($).find((node) => node && !node.hidden);
  if (!dialog || e.key !== 'Tab') return;
  const focusable = [...dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [tabindex="0"]')];
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

// ---------- 檢視切換 ----------

function switchView(view) {
  state.view = view;
  $$('.tab').forEach((t) => {
    const active = t.dataset.view === view;
    t.classList.toggle('is-active', active);
    t.setAttribute('aria-selected', String(active));
    t.tabIndex = active ? 0 : -1;
  });
  $$('.view').forEach((v) => {
    const active = v.id === `view-${view}`;
    v.classList.toggle('is-active', active);
    v.hidden = !active;
  });
  render();
}

const EMPTY_HTML =
  '<p class="empty">還沒有班級。先到 <a href="roster.html">班級名冊</a> 建立一個班級與名單。</p>';

function render() {
  // 班級可能在名冊頁被刪光，這裡先擋住，否則下面每個 render 都會拿到 undefined。
  if (!currentClass()) {
    $('#seating').innerHTML = EMPTY_HTML;
    $('#logTable').innerHTML = EMPTY_HTML;
    $('#alerts').innerHTML = '';
    $('#stats').innerHTML = '';
    $('#trend').innerHTML = '';
    $('#studentTable').innerHTML = EMPTY_HTML;
    return;
  }
  if (state.view === 'record') renderSeating();
  if (state.view === 'log') renderLog();
  if (state.view === 'dash') renderDash();
}

// ---------- 事件綁定 ----------

function bindEvents() {
  $('#classSelect').addEventListener('change', (e) => {
    state.classId = e.target.value;
    clearSelection();
    render();
  });

  $('#periodSelect').addEventListener('change', (e) => {
    state.period = e.target.value;
  });

  $('#lockBtn').addEventListener('click', lockTeacherView);

  const tabs = $$('.tab');
  tabs.forEach((t, index) => {
    t.addEventListener('click', () => switchView(t.dataset.view));
    t.addEventListener('keydown', (e) => {
      let next = null;
      if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
      if (e.key === 'Home') next = 0;
      if (e.key === 'End') next = tabs.length - 1;
      if (next === null) return;
      e.preventDefault();
      tabs[next].focus();
      switchView(tabs[next].dataset.view);
    });
  });

  $('#seating').addEventListener('click', (e) => {
    const btn = e.target.closest('.seat');
    if (!btn) return;
    const id = btn.dataset.student;
    if (state.multi) {
      // 只切換這一格的樣式，不整張重畫——重畫會讓連點時掉觸控。
      if (state.selected.has(id)) state.selected.delete(id);
      else state.selected.add(id);
      btn.classList.toggle('is-selected', state.selected.has(id));
      updateMultiBar();
    } else {
      openSheet([id]);
    }
  });

  $('#multiToggle').addEventListener('click', () => {
    state.multi = !state.multi;
    state.selected.clear();
    updateMultiBar();
    renderSeating();
  });

  $('#multiClear').addEventListener('click', clearSelection);

  $('#multiRecord').addEventListener('click', () => {
    if (!state.selected.size) {
      showToast('還沒選學生。');
      return;
    }
    openSheet([...state.selected]);
  });

  $('#frontToggle').addEventListener('click', () => {
    state.frontBottom = !state.frontBottom;
    renderSeating();
  });

  $('#sheet').addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) return closeSheet();
    const card = e.target.closest('.bcard');
    if (card) recordBehavior(card.dataset.behavior);
  });

  $('#detail').addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeDialog('#detail');
  });

  $('#toastUndo').addEventListener('click', undoLast);

  ['#logRange', '#logKind', '#logShowVoided'].forEach((sel) =>
    $(sel).addEventListener('change', renderLog));

  $('#logTable').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-void]');
    if (!btn) return;
    await store.voidEvent(btn.dataset.void);
    const evt = state.events.find((x) => x.id === btn.dataset.void);
    if (evt) evt.voided = true;
    renderLog();
  });

  $('#quickAdd').addEventListener('click', openQuickAdd);

  // 匯出集中在備份頁一個入口。這裡本來會直接下載一份含全班姓名的明文檔，
  // 沒有任何警語、也沒有去識別化選項——留著它，等於整套匯出警示都可以繞過。
  $('#exportBtn').addEventListener('click', () => {
    location.href = 'backup.html';
  });

  $('#dashRange').addEventListener('change', renderDash);

  $('#studentTable').addEventListener('click', (e) => {
    const row = e.target.closest('[data-detail]');
    if (row) openDetail(row.dataset.detail);
  });
  $('#studentTable').addEventListener('keydown', (e) => {
    const row = e.target.closest('[data-detail]');
    if (row && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      openDetail(row.dataset.detail);
    }
  });

  $('#resetBtn').addEventListener('click', async () => {
    if (!confirm('這會清掉目前所有紀錄，換回示範資料。確定嗎？')) return;
    await store.resetAll();
    await store.init(SEED);
    await reload();
    state.classId = state.classes[0]?.id || null;
    renderClassSelect();
    renderDemoBanner();
    clearSelection();
    render();
  });

  document.addEventListener('keydown', (e) => {
    trapDialog(e);
    if (e.key === 'Escape') {
      closeSheet();
      closeDialog('#detail');
    }
  });
}

init();
