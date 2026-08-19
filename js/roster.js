/*
 * 班級與名冊管理（第二期 2.5）。
 *
 * 原則上只碰 classes，事件流不動——移出名冊的學生仍留在稽核軌跡裡。
 * 唯一的例外是「永久刪除」與「保存期限清理」：那兩條是個資法第 11 條第 3 項
 * 「特定目的消失應主動刪除」的實作，會真的把事件刪掉，也只有老師本人按得下去。
 */

import { store } from './store-select.js';
import { SEED, DEFAULT_SETTINGS } from './data.js';
import { expiredClasses } from './rules.js';
import { isOptedOut, markOptOut, clearOptOut, seatCells, OPT_OUT_LABEL } from './optout.js';


// ---------- 純函式：貼上解析 ----------

/** 去掉半形／全形空白與零寬字元。 */
function tidy(s) {
  return String(s)
    .replace(/[​-‍﻿]/g, '')
    .replace(/^[\s　]+|[\s　]+$/g, '')
    .replace(/^["'「『]+|["'」』]+$/g, '')
    .replace(/^[\s　]+|[\s　]+$/g, '');
}

const HEADER_WORDS = ['座號', '學號', '號碼', '姓名', '名字', '學生', 'no', 'name', '編號'];

function looksLikeHeader(cells) {
  const joined = cells.join('').toLowerCase();
  return HEADER_WORDS.some((w) => joined.includes(w)) && !/\d{1,3}\s*$/.test(cells[0] || '');
}

/** 把一行切成欄位：Tab、半形逗號、全形逗號、頓號都算分隔。 */
function splitCells(line) {
  if (/[\t,，、]/.test(line)) return line.split(/[\t,，、]/).map(tidy);
  // 沒有分隔符號時，允許「1 王小明」這種空白分隔（限開頭是數字）
  const m = line.match(/^(\d{1,3})[\s　]+(.+)$/);
  if (m) return [tidy(m[1]), tidy(m[2])];
  return [tidy(line)];
}

/**
 * 解析老師從 Excel 貼上的兩欄名單。
 * 回傳 { rows: [{no, name}], warnings: [] }，rows 已排除空行與無姓名列。
 */
export function parseRoster(text) {
  const warnings = [];
  const rows = [];
  const lines = String(text || '').split(/\r\n|\r|\n/);
  let lastNo = 0;
  let skippedHeader = false;

  lines.forEach((raw) => {
    const line = tidy(raw);
    if (!line) return;

    let cells = splitCells(line).filter((c, i, arr) => !(c === '' && i === arr.length - 1));
    cells = cells.filter((c) => c !== '');
    if (!cells.length) return;

    if (!skippedHeader && !rows.length && looksLikeHeader(cells)) {
      skippedHeader = true;
      return;
    }

    let no = null;
    let name = '';

    if (cells.length >= 2 && /^\d{1,3}$/.test(cells[0])) {
      no = Number(cells[0]);
      name = cells.slice(1).join(' ');
    } else if (cells.length >= 2 && /^\d{1,3}$/.test(cells[1])) {
      // 少數人習慣「姓名, 座號」
      no = Number(cells[1]);
      name = cells[0];
    } else {
      name = cells.join(' ');
    }

    name = tidy(name).replace(/[\s　]+/g, '');
    if (!name) {
      warnings.push(`「${line}」沒有姓名，已略過。`);
      return;
    }
    if (/^\d+$/.test(name)) {
      warnings.push(`「${line}」只有數字沒有姓名，已略過。`);
      return;
    }

    if (no === null || !Number.isFinite(no) || no <= 0) no = lastNo + 1;
    lastNo = no;
    rows.push({ no, name });
  });

  const seen = new Map();
  rows.forEach((r) => seen.set(r.no, (seen.get(r.no) || 0) + 1));
  [...seen.entries()].filter(([, n]) => n > 1).forEach(([no]) => {
    warnings.push(`座號 ${no} 重複出現，匯入後請確認。`);
  });

  return { rows, warnings };
}

/** 依 cols 把學生按順序排進座位。回傳新陣列，不改原物件。 */
export function layoutSeats(students, cols) {
  const c = Math.max(1, Number(cols) || 6);
  return [...students]
    .sort((a, b) => a.no - b.no)
    .map((s, i) => ({ ...s, row: Math.floor(i / c), col: i % c }));
}

// ---------- 狀態 ----------

const state = {
  classes: [],
  events: [],
  settings: {},
  classId: null,
  preview: null,
  pendingDel: null,
  pendingOptOut: null,
};

const $ = (sel) => document.querySelector(sel);

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function currentClass() {
  return state.classes.find((c) => c.id === state.classId) || state.classes[0] || null;
}

/**
 * 下一個學生流水號：取「現有學生」與「事件流裡出現過的 studentId」兩者最大值 +1。
 * 事件是用 studentId 綁定的，重用已刪除學生的 id 會讓舊紀錄掛到新學生身上。
 */
export function nextSerialOf(classId, students, events) {
  const re = new RegExp(`^${classId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-s(\\d+)$`);
  let max = 0;
  (students || []).forEach((s) => {
    const m = re.exec(s.id || '');
    if (m) max = Math.max(max, Number(m[1]));
  });
  (events || []).forEach((e) => {
    if (e.classId !== classId) return;
    const m = re.exec(e.studentId || '');
    if (m) max = Math.max(max, Number(m[1]));
  });
  return max + 1;
}

function nextSerial(classId) {
  const cls = state.classes.find((c) => c.id === classId);
  return nextSerialOf(classId, cls?.students || [], state.events);
}

function makeStudents(classId, rows, startSerial) {
  let n = startSerial;
  return rows.map((r) => ({ id: `${classId}-s${n++}`, no: r.no, name: r.name, row: 0, col: 0 }));
}

function newClassId() {
  const used = new Set(state.classes.map((c) => c.id));
  let id;
  do {
    id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  } while (used.has(id));
  return id;
}

function countEvents({ classId, studentId }) {
  return state.events.filter(
    (e) => e.classId === classId && (!studentId || e.studentId === studentId)
  ).length;
}

async function persist(classes) {
  state.classes = classes;
  await store.saveClasses(classes);
  render();
}

async function updateClass(classId, fn) {
  const classes = state.classes.map((c) => (c.id === classId ? fn({ ...c }) : c));
  await persist(classes);
}

// ---------- 畫面 ----------

function render() {
  renderClassSelect();
  renderClassRows();
  renderStudents();
  renderSwap();
  renderSeatPreview();
  renderRetention();
}

function renderClassSelect() {
  const sel = $('#classSelect');
  sel.innerHTML = state.classes
    .map((c) => `<option value="${esc(c.id)}"${c.id === state.classId ? ' selected' : ''}>${esc(c.name)}</option>`)
    .join('');
  sel.disabled = !state.classes.length;
}

function renderClassRows() {
  const body = $('#classRows');
  if (!state.classes.length) {
    body.innerHTML = '<tr><td colspan="4" class="empty">還沒有班級，先按「新增班級」。</td></tr>';
    return;
  }
  body.innerHTML = state.classes.map((c) => `
    <tr${c.id === state.classId ? ' class="is-current"' : ''}>
      <td><button class="linkbtn cls-name" data-pick="${esc(c.id)}">${esc(c.name)}</button></td>
      <td class="num">${c.students.length}</td>
      <td>
        <input type="number" class="cols-input" min="1" max="12" value="${c.cols}" data-cols="${esc(c.id)}" aria-label="每列座位數">
      </td>
      <td class="col-act">
        <button class="btn btn-ghost btn-sm" data-rename="${esc(c.id)}">改名</button>
        <button class="btn btn-ghost btn-sm" data-delclass="${esc(c.id)}">刪除</button>
      </td>
    </tr>
  `).join('');
}

function renderStudents() {
  const cls = currentClass();
  const body = $('#studentRows');
  $('#rosterTitle').textContent = cls ? `學生名冊：${cls.name}` : '學生名冊';
  $('#rosterCount').textContent = cls ? `共 ${cls.students.length} 人` : '';
  $('#addStudentForm').hidden = !cls;

  if (!cls) {
    body.innerHTML = '<tr><td colspan="4" class="empty">先選一個班級。</td></tr>';
    return;
  }
  if (!cls.students.length) {
    body.innerHTML = '<tr><td colspan="4" class="empty">這個班還沒有學生，用下面的批次匯入最快。</td></tr>';
    return;
  }
  const sorted = [...cls.students].sort((a, b) => a.no - b.no);
  body.innerHTML = sorted.map((s) => {
    const out = isOptedOut(s);
    return `
    <tr${out ? ' class="is-optout"' : ''}>
      <td class="num">${s.no}</td>
      <td>
        <span class="stu-name">${esc(s.name)}</span>
        ${out ? `<span class="chip-optout">${OPT_OUT_LABEL}</span>` : ''}
      </td>
      <td class="pos">第 ${s.row + 1} 排 第 ${s.col + 1} 位</td>
      <td class="col-act">
        <button class="btn btn-ghost btn-sm" data-edit="${esc(s.id)}">編輯</button>
        <button class="btn btn-ghost btn-sm" data-optout="${esc(s.id)}">${out ? '恢復參與' : '不參與'}</button>
        <button class="btn btn-ghost btn-sm" data-del="${esc(s.id)}">刪除</button>
      </td>
    </tr>`;
  }).join('');
}

function renderSwap() {
  const cls = currentClass();
  const opts = !cls ? '' : [...cls.students]
    .sort((a, b) => a.no - b.no)
    .map((s) => `<option value="${esc(s.id)}">${s.no} ${esc(s.name)}</option>`)
    .join('');
  const a = $('#swapA');
  const b = $('#swapB');
  const prevA = a.value;
  const prevB = b.value;
  a.innerHTML = opts;
  b.innerHTML = opts;
  if (prevA) a.value = prevA;
  if (prevB) b.value = prevB;
}

function renderSeatPreview() {
  const cls = currentClass();
  const grid = $('#seatPreview');
  if (!cls || !cls.students.length) {
    grid.style.gridTemplateColumns = '';
    grid.innerHTML = '<p class="empty">目前沒有座位可顯示。</p>';
    return;
  }
  grid.style.gridTemplateColumns = `repeat(${cls.cols}, minmax(0, 1fr))`;
  // seatCells 不過濾——不參與的位子要留在原位，抽掉的話後面所有人往前遞補，
  // 這張預覽就跟教室對不起來了。那一格只換成不具名的佔位格。
  grid.innerHTML = seatCells([...cls.students].sort((a, b) => a.row - b.row || a.col - b.col))
    .map((c) => `<div class="seat-mini${c.optedOut ? ' is-optout' : ''}"${
      c.optedOut ? ' aria-label="這個座位不參與記錄"' : ''
    }><span class="no">${c.no}</span><span class="nm">${esc(c.label)}</span></div>`)
    .join('');
}

let toastTimer = null;
function toast(msg) {
  const box = $('#toast');
  $('#toastText').textContent = msg;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 2600);
}

// ---------- 匯入預覽 ----------

function renderPreview() {
  const box = $('#importPreview');
  const p = state.preview;
  if (!p) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;

  if (!p.rows.length) {
    box.innerHTML = `<p class="empty">解析不到任何資料，請確認貼上的內容。</p>
      ${p.warnings.map((w) => `<p class="warn">${esc(w)}</p>`).join('')}`;
    return;
  }
  const cls = currentClass();
  const modeLabel = p.mode === 'replace' ? '取代整份名冊' : '附加在名冊後面';
  box.innerHTML = `
    <p class="preview-head">解析到 <strong>${p.rows.length}</strong> 筆，將以「${modeLabel}」寫入 <strong>${esc(cls.name)}</strong>。</p>
    ${p.warnings.map((w) => `<p class="warn">${esc(w)}</p>`).join('')}
    <div class="logtable preview-table">
      <table>
        <thead><tr><th class="num">座號</th><th>姓名</th></tr></thead>
        <tbody>${p.rows.map((r) => `<tr><td class="num">${r.no}</td><td>${esc(r.name)}</td></tr>`).join('')}</tbody>
      </table>
    </div>
    <div class="inline-form">
      <button id="confirmImport" class="btn btn-primary btn-sm" type="button">確認匯入 ${p.rows.length} 筆</button>
      <button id="cancelImport" class="btn btn-ghost btn-sm" type="button">取消</button>
    </div>`;
}

async function doImport() {
  const p = state.preview;
  const cls = currentClass();
  if (!p || !cls || !p.rows.length) return;

  if (p.mode === 'replace' && cls.students.length) {
    const n = countEvents({ classId: cls.id });
    const ok = confirm(
      `「取代整份名冊」會移除 ${cls.name} 目前的 ${cls.students.length} 位學生。\n\n` +
      `這個班已有 ${n} 筆歷史紀錄，紀錄不會被刪除、仍會保留在匯出資料中，但主畫面不再顯示被移除的學生。\n\n確定要取代嗎？`
    );
    if (!ok) return;
  }

  const start = nextSerial(cls.id);
  const added = makeStudents(cls.id, p.rows, start);
  const merged = p.mode === 'replace' ? added : [...cls.students, ...added];

  await updateClass(cls.id, (c) => ({ ...c, students: layoutSeats(merged, c.cols) }));
  state.preview = null;
  renderPreview();
  $('#importText').value = '';
  toast(`已匯入 ${added.length} 位學生。`);
}

// ---------- 互動 ----------

function bind() {
  $('#classSelect').addEventListener('change', (e) => {
    state.classId = e.target.value;
    state.preview = null;
    renderPreview();
    render();
  });

  $('#addClass').addEventListener('click', async () => {
    const name = prompt('新班級名稱', '七年 班');
    if (!name || !tidy(name)) return;
    const id = newClassId();
    const classes = [...state.classes, { id, name: tidy(name), cols: 6, students: [] }];
    state.classId = id;
    await persist(classes);
    toast('班級已新增，接著匯入名單。');
  });

  $('#classRows').addEventListener('click', async (e) => {
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      state.classId = pick.dataset.pick;
      state.preview = null;
      renderPreview();
      render();
      return;
    }
    const rename = e.target.closest('[data-rename]');
    if (rename) {
      const cls = state.classes.find((c) => c.id === rename.dataset.rename);
      const name = prompt('班級名稱', cls.name);
      if (!name || !tidy(name)) return;
      await updateClass(cls.id, (c) => ({ ...c, name: tidy(name) }));
      toast('班級已改名。');
      return;
    }
    const del = e.target.closest('[data-delclass]');
    if (del) {
      const cls = state.classes.find((c) => c.id === del.dataset.delclass);
      const n = countEvents({ classId: cls.id });
      const ok = confirm(
        `確定要刪除「${cls.name}」（${cls.students.length} 人）嗎？\n\n` +
        `這個班已有 ${n} 筆歷史紀錄。紀錄不會被刪除，會保留在匯出資料中，但主畫面不再顯示。`
      );
      if (!ok) return;
      const classes = state.classes.filter((c) => c.id !== cls.id);
      if (state.classId === cls.id) state.classId = classes[0]?.id || null;
      await persist(classes);
      toast('班級已刪除，歷史紀錄仍保留。');
    }
  });

  $('#classRows').addEventListener('change', async (e) => {
    const input = e.target.closest('[data-cols]');
    if (!input) return;
    const cols = Math.min(12, Math.max(1, Number(input.value) || 6));
    await updateClass(input.dataset.cols, (c) => ({ ...c, cols, students: layoutSeats(c.students, cols) }));
    toast(`每列改為 ${cols} 個座位，已重新排座。`);
  });

  $('#addStudentForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const cls = currentClass();
    if (!cls) return;
    const no = Number($('#newNo').value);
    const name = tidy($('#newName').value).replace(/[\s　]+/g, '');
    if (!name || !Number.isFinite(no) || no <= 0) return;
    if (cls.students.some((s) => s.no === no)) {
      if (!confirm(`座號 ${no} 已經有人，還是要新增嗎？`)) return;
    }
    const [stu] = makeStudents(cls.id, [{ no, name }], nextSerial(cls.id));
    await updateClass(cls.id, (c) => ({ ...c, students: layoutSeats([...c.students, stu], c.cols) }));
    $('#newNo').value = '';
    $('#newName').value = '';
    $('#newNo').focus();
    toast(`已新增 ${name}。`);
  });

  $('#studentRows').addEventListener('click', async (e) => {
    const cls = currentClass();
    if (!cls) return;

    const edit = e.target.closest('[data-edit]');
    if (edit) {
      const stu = cls.students.find((s) => s.id === edit.dataset.edit);
      const name = prompt(`姓名（座號 ${stu.no}）`, stu.name);
      if (name === null) return;
      const noStr = prompt('座號', String(stu.no));
      if (noStr === null) return;
      const nextName = tidy(name).replace(/[\s　]+/g, '') || stu.name;
      const nextNo = Number(tidy(noStr)) || stu.no;
      await updateClass(cls.id, (c) => ({
        ...c,
        students: layoutSeats(
          c.students.map((s) => (s.id === stu.id ? { ...s, name: nextName, no: nextNo } : s)),
          c.cols
        ),
      }));
      toast('已更新。');
      return;
    }

    const oo = e.target.closest('[data-optout]');
    if (oo) {
      const stu = cls.students.find((s) => s.id === oo.dataset.optout);
      if (isOptedOut(stu)) await restoreParticipation(cls, stu);
      else openOptOutDialog(cls, stu);
      return;
    }

    const del = e.target.closest('[data-del]');
    if (del) {
      const stu = cls.students.find((s) => s.id === del.dataset.del);
      openDelDialog(cls, stu);
    }
  });

  $('#parseBtn').addEventListener('click', () => {
    const cls = currentClass();
    if (!cls) { toast('先新增一個班級。'); return; }
    const parsed = parseRoster($('#importText').value);
    state.preview = { ...parsed, mode: $('#importMode').value };
    renderPreview();
  });

  $('#clearImport').addEventListener('click', () => {
    $('#importText').value = '';
    state.preview = null;
    renderPreview();
  });

  $('#importMode').addEventListener('change', () => {
    if (!state.preview) return;
    state.preview.mode = $('#importMode').value;
    renderPreview();
  });

  $('#importPreview').addEventListener('click', (e) => {
    if (e.target.id === 'confirmImport') doImport();
    if (e.target.id === 'cancelImport') { state.preview = null; renderPreview(); }
  });

  $('#reflow').addEventListener('click', async () => {
    const cls = currentClass();
    if (!cls) return;
    await updateClass(cls.id, (c) => ({ ...c, students: layoutSeats(c.students, c.cols) }));
    toast('已依座號重新排列。');
  });

  $('#swapBtn').addEventListener('click', async () => {
    const cls = currentClass();
    if (!cls) return;
    const aId = $('#swapA').value;
    const bId = $('#swapB').value;
    if (!aId || !bId || aId === bId) { toast('請選兩位不同的學生。'); return; }
    const a = cls.students.find((s) => s.id === aId);
    const b = cls.students.find((s) => s.id === bId);
    await updateClass(cls.id, (c) => ({
      ...c,
      students: c.students.map((s) => {
        if (s.id === a.id) return { ...s, row: b.row, col: b.col };
        if (s.id === b.id) return { ...s, row: a.row, col: a.col };
        return s;
      }),
    }));
    toast(`${a.name} 與 ${b.name} 已互換座位。`);
  });
}

/* ---------- 移除學生 ---------- */

/*
 * 「移出名冊」和「永久刪除」是兩件語意完全不同的事，
 * 用一個確認框問完，按錯的那一邊都很難救：
 * 該刪沒刪＝資料一路留到永遠；不該刪刪了＝稽核軌跡沒了。
 * 所以拆成兩顆各自寫清楚後果的按鈕。
 */
function openDelDialog(cls, stu) {
  const n = countEvents({ classId: cls.id, studentId: stu.id });
  state.pendingDel = { classId: cls.id, studentId: stu.id, name: stu.name, no: stu.no, n };
  $('#delTitle').textContent = `移除 ${stu.no} ${stu.name}`;
  $('#delBody').textContent = n
    ? `這位學生目前有 ${n} 筆歷史紀錄。要怎麼處理？`
    : '這位學生還沒有任何紀錄，兩個選項的結果是一樣的。';
  $('#delDialog').hidden = false;
}

function closeDelDialog() {
  $('#delDialog').hidden = true;
  state.pendingDel = null;
}

async function removeFromRoster(classId, studentId) {
  await updateClass(classId, (c) => ({
    ...c,
    students: layoutSeats(c.students.filter((s) => s.id !== studentId), c.cols),
  }));
}

/* ---------- 不參與記錄（個資盤點 A5） ---------- */

/*
 * 為什麼設定的當下就把既有紀錄刪掉，而不是問老師要留還是要刪：
 *
 * 一、家長拒絕的是「蒐集這件事」，不是「從今天起才蒐集」。個資法上當事人
 *     請求停止蒐集時，已持有的部分沒有繼續持有的依據。
 * 二、把它做成選項，等於把「要不要尊重家長」變成老師的裁量。老師與家長的
 *     權力關係本來就不對等，這種裁量權不該存在。
 * 三、A5 的驗證條件白紙黑字寫「確認該生不出現在匯出檔中」。留著紀錄就驗不過。
 *
 * 代價是不可逆，所以按下去之前要把筆數講清楚、要提醒先備份。
 */
function openOptOutDialog(cls, stu) {
  const n = countEvents({ classId: cls.id, studentId: stu.id });
  state.pendingOptOut = { classId: cls.id, studentId: stu.id, name: stu.name, no: stu.no, n };
  $('#optOutTitle').textContent = `設為不參與記錄：${stu.no} ${stu.name}`;
  $('#optOutBody').textContent = n
    ? `${stu.name}目前有 ${n} 筆紀錄。設為不參與時，這 ${n} 筆會一併永久刪除——`
      + '家長拒絕的是蒐集這件事本身，不是只拒絕往後的部分。座位會留在座位表上，'
      + '之後不會再有任何紀錄寫得進來。刪掉的紀錄救不回來，需要留底請先去備份匯出。'
    : `${stu.name}目前沒有任何紀錄。設定後座位會留在座位表上，之後不會再有紀錄寫進來。`;
  $('#optOutDialog').hidden = false;
}

function closeOptOutDialog() {
  $('#optOutDialog').hidden = true;
  state.pendingOptOut = null;
}

async function restoreParticipation(cls, stu) {
  if (!confirm(`要讓「${stu.no} ${stu.name}」恢復參與記錄嗎？\n\n之前刪掉的紀錄不會回來，從現在起可以重新記錄。`)) return;
  await persist(clearOptOut(state.classes, { classId: cls.id, studentId: stu.id }));
  toast(`${stu.name}已恢復參與記錄。`);
}

function bindOptOut() {
  $('#optOutDialog').addEventListener('click', async (e) => {
    if (e.target.closest('[data-oc]')) {
      // 「先不要」那顆裡面有一條連到備份頁的連結，點連結時不要順手關掉對話框
      if (e.target.closest('a')) return;
      closeOptOutDialog();
      return;
    }
    if (!e.target.closest('#optOutConfirm')) return;

    const po = state.pendingOptOut;
    if (!po) return;
    closeOptOutDialog();

    // 先刪紀錄再標記：反過來的話，中間萬一失敗會留下「標了但紀錄還在」的狀態。
    const { deleted } = await store.purgeStudent({ classId: po.classId, studentId: po.studentId });
    await persist(markOptOut(state.classes, {
      classId: po.classId,
      studentId: po.studentId,
      at: new Date().toISOString(),
    }));
    state.events = await store.queryEvents({ includeVoided: true });
    render();
    toast(deleted
      ? `${po.name}已設為不參與記錄，並刪除 ${deleted} 筆既有紀錄。`
      : `${po.name}已設為不參與記錄。`);
  });
}

/* ---------- 保存期限 ---------- */

function renderRetention() {
  const months = Number(state.settings.retentionMonths) || DEFAULT_SETTINGS.retentionMonths;
  $('#retention').value = String(months);

  const expired = expiredClasses(state.classes, state.events, months);
  const box = $('#expiredList');

  if (!expired.length) {
    $('#retentionHint').textContent = '目前沒有超過期限的班級。';
    box.innerHTML = '';
    return;
  }

  $('#retentionHint').textContent = `有 ${expired.length} 個班級超過期限。`;
  box.innerHTML = `
    <div class="expired">
      <p class="hint">
        這些班級已經超過 ${months} 個月沒有新紀錄了。刪除前建議先到
        <a href="backup.html">備份</a> 匯出一份留底——刪掉就找不回來。
      </p>
      <ul>
        ${expired.map((x) => `
          <li>
            <span>${esc(x.name)}</span>
            <span class="hint">${x.count} 筆・最後一筆 ${x.lastTs.slice(0, 10)}</span>
            <button class="btn btn-danger btn-sm" data-purge="${esc(x.classId)}">刪除這個班的紀錄</button>
          </li>`).join('')}
      </ul>
    </div>`;
}

function bindRetention() {
  $('#delDialog').addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]')) { closeDelDialog(); return; }

    const pd = state.pendingDel;
    if (!pd) return;

    if (e.target.closest('#delKeep')) {
      closeDelDialog();
      await removeFromRoster(pd.classId, pd.studentId);
      toast('已移出名冊，歷史紀錄仍保留。');
      return;
    }

    if (e.target.closest('#delPurge')) {
      // 永久刪除要再問一次。名字打在確認框裡，避免點錯行刪到別人。
      if (!confirm(`確定要永久刪除「${pd.no} ${pd.name}」的 ${pd.n} 筆紀錄嗎？這個動作救不回來。`)) return;
      closeDelDialog();
      const { deleted } = await store.purgeStudent({ classId: pd.classId, studentId: pd.studentId });
      await removeFromRoster(pd.classId, pd.studentId);
      state.events = await store.queryEvents({ includeVoided: true });
      render();
      toast(`已永久刪除 ${pd.name} 的 ${deleted} 筆紀錄。`);
    }
  });

  $('#retention').addEventListener('change', async () => {
    state.settings = { ...state.settings, retentionMonths: Number($('#retention').value) };
    await store.saveSettings(state.settings);
    renderRetention();
    toast('保存期限已更新。');
  });

  $('#expiredList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-purge]');
    if (!btn) return;
    const cls = state.classes.find((c) => c.id === btn.dataset.purge);
    if (!cls) return;
    if (!confirm(`確定要永久刪除「${cls.name}」的所有紀錄嗎？建議先匯出留底，這個動作救不回來。`)) return;
    const { deleted } = await store.purgeClass(cls.id);
    state.events = await store.queryEvents({ includeVoided: true });
    render();
    toast(`已永久刪除 ${cls.name} 的 ${deleted} 筆紀錄。`);
  });
}

async function init() {
  await store.init(SEED);
  state.classes = await store.getClasses();
  state.events = await store.queryEvents({ includeVoided: true });
  state.settings = await store.getSettings();
  state.classId = state.classes[0]?.id || null;
  bind();
  bindOptOut();
  bindRetention();
  render();
}

if (typeof document !== 'undefined') init();
