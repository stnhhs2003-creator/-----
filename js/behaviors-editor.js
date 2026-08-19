/*
 * 行為卡自訂（第二期 2.4）。
 *
 * 最重要的一條規則：這一頁只改行為卡，絕不碰事件。
 * 事件在 store.appendEvent 當下就把 delta 快照寫進去了，
 * 所以改分數只影響之後的紀錄，過去的紀錄維持原樣——
 * 這裡沒有、也不該有任何「同步更新舊事件」的邏輯。
 */

import { store } from './store-select.js';
import { SEED, DEFAULT_BEHAVIORS } from './data.js';
import { behaviorArtPath } from './visual-assets.js';


// ---------- 純函式：驗證與排序（不碰 DOM、不碰儲存） ----------

export const DELTA_MIN = -10;
export const DELTA_MAX = 10;
export const DEFAULT_ICON = { positive: '⭐', improve: '⚠️' };

export const KIND_LABEL = { positive: '正向', improve: '待改進' };

/**
 * 驗證一張行為卡。
 * @returns {{ ok: boolean, errors: string[], value: object|null }}
 */
export function validateBehavior(input, behaviors = [], editingId = null) {
  const errors = [];
  const kind = input.kind === 'improve' ? 'improve' : 'positive';
  const label = String(input.label ?? '').trim();
  const iconRaw = String(input.icon ?? '').trim();
  const deltaRaw = String(input.delta ?? '').trim();

  if (!label) {
    errors.push('名稱必填，不能只有空白。');
  } else if (
    behaviors.some(
      (b) => b.id !== editingId && b.kind === kind
        && String(b.label ?? '').trim() === label
    )
  ) {
    errors.push(`${KIND_LABEL[kind]}裡已經有「${label}」了，同一類型不能有兩張同名的卡。`);
  }

  let delta = null;
  if (deltaRaw === '') {
    errors.push('分數必填。');
  } else if (!/^[+-]?\d+$/.test(deltaRaw)) {
    errors.push('分數必須是整數，不能有小數點或其他文字。');
  } else {
    delta = Number(deltaRaw);
    if (delta < DELTA_MIN || delta > DELTA_MAX) {
      errors.push(`分數要在 ${DELTA_MIN} 到 ${DELTA_MAX} 之間。`);
    } else if (kind === 'positive' && delta <= 0) {
      errors.push('正向卡的分數必須大於 0。要記負分請把類型改成待改進。');
    } else if (kind === 'improve' && delta >= 0) {
      errors.push('待改進卡的分數必須小於 0。要記正分請把類型改成正向。');
    }
  }

  if (errors.length) return { ok: false, errors, value: null };

  return {
    ok: true,
    errors: [],
    value: {
      label,
      icon: iconRaw || DEFAULT_ICON[kind],
      delta,
      kind,
    },
  };
}

/** 產生不與既有 id 衝突的新 id。 */
export function makeBehaviorId(behaviors = []) {
  const used = new Set(behaviors.map((b) => b.id));
  let id;
  do {
    id = `b-u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  } while (used.has(id));
  return id;
}

/**
 * 在同類型的相鄰兩張卡之間交換位置（跨類型的卡跳過不算鄰居）。
 * 回傳新陣列，不改動原陣列。
 */
export function moveBehavior(behaviors, id, dir) {
  const list = [...behaviors];
  const i = list.findIndex((b) => b.id === id);
  if (i < 0) return list;
  const kind = list[i].kind;
  const step = dir === 'up' ? -1 : 1;
  let j = i + step;
  while (j >= 0 && j < list.length && list[j].kind !== kind) j += step;
  if (j < 0 || j >= list.length) return list;
  [list[i], list[j]] = [list[j], list[i]];
  return list;
}

/** 某張行為卡在事件流裡被用過幾次。刪除前用來提醒老師。 */
export function countUsage(events, behaviorId) {
  const all = events.filter((e) => e.behaviorId === behaviorId);
  return { total: all.length, voided: all.filter((e) => e.voided).length };
}

// ---------- 以下是 UI；在 node 測試環境不會執行 ----------

const hasDOM = typeof document !== 'undefined';

const $ = (sel) => document.querySelector(sel);

const state = {
  behaviors: [],
  editingId: null, // null = 沒在編輯；'new' = 新增中；其他 = 編輯該 id
};

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const fmtDelta = (n) => `${n > 0 ? '+' : ''}${n}`;

async function init() {
  await store.init(SEED);
  state.behaviors = await store.getBehaviors();
  bind();
  render();
}

async function persist() {
  await store.saveBehaviors(state.behaviors);
}

// ---------- 清單 ----------

function render() {
  ['positive', 'improve'].forEach((kind) => {
    const list = state.behaviors.filter((b) => b.kind === kind);
    const el = kind === 'positive' ? $('#listPositive') : $('#listImprove');
    const countEl = kind === 'positive' ? $('#countPositive') : $('#countImprove');
    const active = list.filter((b) => !b.archived).length;
    countEl.textContent = `啟用 ${active} 張／共 ${list.length} 張`;

    if (!list.length) {
      el.innerHTML = '<p class="empty">這個類型還沒有行為卡。</p>';
      return;
    }

    el.innerHTML = list.map((b, i) => {
      const art = behaviorArtPath(b.id);
      const visual = art
        ? `<img class="behavior-art" src="${esc(art)}" alt="" width="52" height="52" loading="lazy" decoding="async">`
        : `<span class="icon">${esc(b.icon || DEFAULT_ICON[b.kind])}</span>`;
      return `
      <div class="bx-row ${b.archived ? 'is-archived' : ''}">
        <span class="bcard ${b.kind} bx-card">
          ${visual}
          <span class="label">${esc(b.label)}</span>
          <span class="delta">${fmtDelta(b.delta)}</span>
        </span>
        <div class="bx-row-main">
          <div class="bx-row-title">
            ${esc(b.label)}
            ${b.archived ? '<span class="bx-badge">已停用</span>' : ''}
          </div>
          <div class="bx-row-meta">${KIND_LABEL[b.kind]}　${fmtDelta(b.delta)} 分</div>
        </div>
        <div class="bx-row-actions">
          <button class="btn btn-ghost btn-sm" data-move="up" data-id="${b.id}" ${i === 0 ? 'disabled' : ''} title="上移">↑</button>
          <button class="btn btn-ghost btn-sm" data-move="down" data-id="${b.id}" ${i === list.length - 1 ? 'disabled' : ''} title="下移">↓</button>
          <button class="btn btn-ghost btn-sm" data-edit="${b.id}">編輯</button>
          <button class="btn btn-ghost btn-sm" data-archive="${b.id}">${b.archived ? '啟用' : '停用'}</button>
          <button class="btn btn-ghost btn-sm bx-danger" data-delete="${b.id}">刪除</button>
        </div>
      </div>`;
    }).join('');
  });
}

// ---------- 表單 ----------

function openEditor(id) {
  state.editingId = id;
  const editing = id === 'new' ? null : state.behaviors.find((b) => b.id === id);

  $('#editorTitle').textContent = editing ? `編輯：${editing.label}` : '新增行為卡';
  $('#fLabel').value = editing ? editing.label : '';
  $('#fIcon').value = editing ? (editing.icon || '') : '';
  $('#fDelta').value = editing ? String(editing.delta) : '';
  $('#fKind').value = editing ? editing.kind : 'positive';

  showErrors([]);
  updatePreview();
  $('#editor').hidden = false;
  $('#fLabel').focus();
}

function closeEditor() {
  state.editingId = null;
  $('#editor').hidden = true;
}

function showErrors(errors) {
  const box = $('#formErrors');
  if (!errors.length) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  box.innerHTML = `<ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`;
}

function readForm() {
  return {
    label: $('#fLabel').value,
    icon: $('#fIcon').value,
    delta: $('#fDelta').value,
    kind: $('#fKind').value,
  };
}

function updatePreview() {
  const raw = readForm();
  const kind = raw.kind === 'improve' ? 'improve' : 'positive';
  const p = $('#preview');
  p.className = `bcard ${kind} bx-preview`;
  p.querySelector('.icon').textContent = String(raw.icon).trim() || DEFAULT_ICON[kind];
  p.querySelector('.label').textContent = String(raw.label).trim() || '行為名稱';
  const n = Number(String(raw.delta).trim());
  p.querySelector('.delta').textContent =
    /^[+-]?\d+$/.test(String(raw.delta).trim()) ? fmtDelta(n) : '—';
}

async function submitForm(e) {
  e.preventDefault();
  const editingId = state.editingId === 'new' ? null : state.editingId;
  const result = validateBehavior(readForm(), state.behaviors, editingId);
  if (!result.ok) {
    showErrors(result.errors);
    return;
  }

  if (editingId) {
    const b = state.behaviors.find((x) => x.id === editingId);
    // 只改卡片本身，事件一筆都不動。
    Object.assign(b, result.value);
    toast(`已更新「${b.label}」。這只影響之後的紀錄，過去的紀錄維持原樣。`);
  } else {
    state.behaviors.push({ id: makeBehaviorId(state.behaviors), ...result.value });
    toast(`已新增「${result.value.label}」，記錄面板馬上就看得到。`);
  }

  await persist();
  closeEditor();
  render();
}

// ---------- 動作 ----------

async function onMove(id, dir) {
  state.behaviors = moveBehavior(state.behaviors, id, dir);
  await persist();
  render();
}

async function onArchive(id) {
  const b = state.behaviors.find((x) => x.id === id);
  if (!b) return;
  b.archived = !b.archived;
  if (!b.archived) delete b.archived;
  await persist();
  render();
  toast(b.archived
    ? `已停用「${b.label}」，記錄面板不會再出現，歷史紀錄照樣查得到。`
    : `已重新啟用「${b.label}」。`);
}

async function onDelete(id) {
  const b = state.behaviors.find((x) => x.id === id);
  if (!b) return;
  const events = await store.queryEvents({ includeVoided: true });
  const { total, voided } = countUsage(events, id);

  const warn = total
    ? `刪除「${b.label}」會讓稽核頁 ${total} 筆歷史紀錄`
      + `${voided ? `（其中 ${voided} 筆已撤銷）` : ''}顯示成「未知行為」，`
      + '分數不會變，但看不出當初記的是什麼。\n\n'
      + '通常「停用」就夠了：卡片不再出現在記錄面板，歷史紀錄仍顯示正確名稱。\n\n'
      + '確定要刪除嗎？'
    : `「${b.label}」還沒有任何歷史紀錄，可以安全刪除。確定嗎？`;

  if (!confirm(warn)) return;

  state.behaviors = state.behaviors.filter((x) => x.id !== id);
  await persist();
  if (state.editingId === id) closeEditor();
  render();
  toast(`已刪除「${b.label}」。`);
}

async function onResetDefault() {
  if (!confirm(`這會把行為卡整份換回預設的 ${DEFAULT_BEHAVIORS.length} 張（自訂的卡片會消失，停用狀態也會清掉）。\n\n歷史紀錄與分數完全不受影響。確定嗎？`)) return;
  state.behaviors = DEFAULT_BEHAVIORS.map((b) => ({ ...b }));
  await persist();
  closeEditor();
  render();
  toast('已重設為預設行為卡。');
}

// ---------- 提示 ----------

let toastTimer = null;
function toast(text) {
  $('#toastText').textContent = text;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4000);
}

// ---------- 綁定 ----------

function bind() {
  $('#addBtn').addEventListener('click', () => openEditor('new'));
  $('#editorClose').addEventListener('click', closeEditor);
  $('#behaviorForm').addEventListener('submit', submitForm);
  $('#resetDefaultBtn').addEventListener('click', onResetDefault);

  ['#fLabel', '#fIcon', '#fDelta', '#fKind'].forEach((sel) =>
    $(sel).addEventListener('input', updatePreview));
  $('#fKind').addEventListener('change', updatePreview);

  document.addEventListener('click', (e) => {
    const move = e.target.closest('[data-move]');
    if (move) return onMove(move.dataset.id, move.dataset.move);
    const edit = e.target.closest('[data-edit]');
    if (edit) return openEditor(edit.dataset.edit);
    const archive = e.target.closest('[data-archive]');
    if (archive) return onArchive(archive.dataset.archive);
    const del = e.target.closest('[data-delete]');
    if (del) return onDelete(del.dataset.delete);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.editingId) closeEditor();
  });
}

if (hasDOM) init();
