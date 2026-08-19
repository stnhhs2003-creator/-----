/*
 * 老師端積分商店（第二期 2.2）。
 *
 * 兌換流程一律走既有事件流，不新增 localStorage key：
 *   核可 = voidEvent(申請事件) → appendEvent({ delta: -cost, kind: 'redeem' })
 *   退回 = voidEvent(申請事件)
 * 核可前用 scoreByStudent() 重算當下餘額再把關一次，
 * 因為學生送出申請之後、老師處理之前可能又被扣分。
 */

import { store } from './store-select.js';
import { SEED } from './data.js';
import {
  ensureRewards, newRewardId, canApprove, afterStockDecrement,
  pendingRequests, balanceOf,
} from './shop-core.js';

const $ = (s) => document.querySelector(s);

const state = {
  classes: [],
  rewards: [],
  events: [],
  editingId: null,
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function classOf(id) {
  return state.classes.find((c) => c.id === id);
}

function studentName(classId, studentId) {
  const s = classOf(classId)?.students.find((x) => x.id === studentId);
  return s ? `${s.no}號 ${s.name}` : studentId;
}

/** 某班的有效事件，算餘額用。 */
function liveOf(classId) {
  return state.events.filter((e) => !e.voided && e.classId === classId);
}

// ---------- 初始化 ----------

async function init() {
  await store.init(SEED);
  state.classes = await store.getClasses();
  state.rewards = await ensureRewards(store);
  await reloadEvents();
  bind();
  render();
}

async function reloadEvents() {
  state.events = await store.queryEvents({});
}

function render() {
  renderPending();
  renderRewards();
}

// ---------- 待核可 ----------

function renderPending() {
  const rows = pendingRequests(state.events).sort((a, b) => a.ts.localeCompare(b.ts));

  if (!rows.length) {
    $('#pendingTable').innerHTML = '<p class="empty">目前沒有待核可的申請。</p>';
    return;
  }

  $('#pendingTable').innerHTML = `
    <table>
      <thead>
        <tr><th>申請時間</th><th>班級</th><th>學生</th><th>獎勵</th><th class="num">所需</th><th class="num">目前餘額</th><th></th></tr>
      </thead>
      <tbody>
        ${rows.map((e) => {
          const reward = state.rewards.find((r) => r.id === e.behaviorId);
          const balance = balanceOf(liveOf(e.classId), e.studentId);
          const cost = reward ? reward.cost : '—';
          const short = reward && balance < reward.cost;
          const d = new Date(e.ts);
          const ts = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
          return `
            <tr>
              <td>${ts}</td>
              <td>${esc(classOf(e.classId)?.name || e.classId)}</td>
              <td>${esc(studentName(e.classId, e.studentId))}</td>
              <td>${esc(e.note || (reward ? reward.name : '（品項已刪除）'))}</td>
              <td class="num">${cost}</td>
              <td class="num ${short ? 'stu-short' : ''}">${balance}</td>
              <td class="stu-actions">
                <button class="btn btn-primary btn-sm" data-approve="${e.id}">核可</button>
                <button class="btn btn-ghost btn-sm" data-reject="${e.id}">退回</button>
              </td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

async function approve(eventId) {
  const req = state.events.find((e) => e.id === eventId);
  if (!req || req.voided) return;
  const reward = state.rewards.find((r) => r.id === req.behaviorId);

  const check = canApprove(liveOf(req.classId), req.studentId, reward);
  if (!check.ok) {
    showToast(`擋下：${check.reason}`);
    return;
  }

  // 先作廢申請，再寫一筆真正的扣點事件。
  await store.voidEvent(req.id);
  try {
    await store.appendEvent({
      classId: req.classId,
      studentId: req.studentId,
      behaviorId: reward.id,
      delta: -reward.cost,
      kind: 'redeem',
      note: reward.name,
    });
  } catch (err) {
    showToast(err.message);
    return;
  }

  // 庫存有設定才遞減，扣到 0 自動下架。
  const updated = afterStockDecrement(reward);
  state.rewards = state.rewards.map((r) => (r.id === reward.id ? updated : r));
  await store.saveRewards(state.rewards);

  await reloadEvents();
  const off = updated.stock === 0 ? '，庫存歸零已自動下架' : '';
  showToast(`已核可「${reward.name}」，扣 ${reward.cost} 點${off}。`);
  render();
}

async function reject(eventId) {
  const req = state.events.find((e) => e.id === eventId);
  if (!req || req.voided) return;
  await store.voidEvent(req.id);
  await reloadEvents();
  showToast(`已退回「${req.note || '兌換申請'}」，沒有扣點。`);
  render();
}

// ---------- 品項管理 ----------

function renderRewards() {
  if (!state.rewards.length) {
    $('#rewardTable').innerHTML = '<p class="empty">還沒有任何獎勵品項。</p>';
    return;
  }

  $('#rewardTable').innerHTML = `
    <table>
      <thead>
        <tr><th>名稱</th><th class="num">所需點數</th><th class="num">庫存</th><th>狀態</th><th></th></tr>
      </thead>
      <tbody>
        ${state.rewards.map((r) => `
          <tr class="${r.active ? '' : 'stu-off'}">
            <td>${esc(r.name)}</td>
            <td class="num">${r.cost}</td>
            <td class="num">${r.stock === null || r.stock === undefined ? '不限' : r.stock}</td>
            <td><span class="pill ${r.active ? 'positive' : 'improve'}">${r.active ? '上架中' : '已停用'}</span></td>
            <td class="stu-actions">
              <button class="btn btn-ghost btn-sm" data-edit="${r.id}">編輯</button>
              <button class="btn btn-ghost btn-sm" data-toggle="${r.id}">${r.active ? '停用' : '重新上架'}</button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

function openForm(reward) {
  state.editingId = reward ? reward.id : null;
  $('#formTitle').textContent = reward ? `編輯：${reward.name}` : '新增品項';
  $('#fName').value = reward ? reward.name : '';
  $('#fCost').value = reward ? reward.cost : 20;
  $('#fStock').value = reward && reward.stock !== null && reward.stock !== undefined ? reward.stock : '';
  $('#fActive').checked = reward ? !!reward.active : true;
  $('#rewardForm').hidden = false;
  $('#fName').focus();
}

function closeForm() {
  state.editingId = null;
  $('#rewardForm').hidden = true;
}

async function saveForm(e) {
  e.preventDefault();
  const name = $('#fName').value.trim();
  const cost = Number($('#fCost').value);
  const stockRaw = $('#fStock').value.trim();
  const stock = stockRaw === '' ? null : Math.max(0, Number(stockRaw));
  const active = $('#fActive').checked;

  if (!name) return showToast('請填名稱。');
  if (!Number.isFinite(cost) || cost < 1) return showToast('所需點數要是 1 以上的整數。');

  if (state.editingId) {
    state.rewards = state.rewards.map((r) =>
      r.id === state.editingId ? { ...r, name, cost, stock, active } : r);
    showToast(`已更新「${name}」。`);
  } else {
    state.rewards = [...state.rewards, { id: newRewardId(), name, cost, stock, active }];
    showToast(`已新增「${name}」。`);
  }

  await store.saveRewards(state.rewards);
  closeForm();
  render();
}

async function toggleActive(id) {
  const r = state.rewards.find((x) => x.id === id);
  if (!r) return;
  if (!r.active && r.stock === 0) {
    showToast('庫存是 0，請先補庫存再重新上架。');
    return;
  }
  state.rewards = state.rewards.map((x) => (x.id === id ? { ...x, active: !x.active } : x));
  await store.saveRewards(state.rewards);
  showToast(`${r.name} 已${r.active ? '停用' : '重新上架'}。`);
  render();
}

// ---------- 共用 ----------

let toastTimer = null;
function showToast(text) {
  $('#toastText').textContent = text;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500);
}

function bind() {
  $('#pendingTable').addEventListener('click', (e) => {
    const a = e.target.closest('[data-approve]');
    if (a) return approve(a.dataset.approve);
    const r = e.target.closest('[data-reject]');
    if (r) return reject(r.dataset.reject);
  });

  $('#rewardTable').addEventListener('click', (e) => {
    const ed = e.target.closest('[data-edit]');
    if (ed) return openForm(state.rewards.find((r) => r.id === ed.dataset.edit));
    const tg = e.target.closest('[data-toggle]');
    if (tg) return toggleActive(tg.dataset.toggle);
  });

  $('#addBtn').addEventListener('click', () => openForm(null));
  $('#cancelBtn').addEventListener('click', closeForm);
  $('#rewardForm').addEventListener('submit', saveForm);
}

init();
