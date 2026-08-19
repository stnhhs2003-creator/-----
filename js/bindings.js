/*
 * 家長綁定後台（老師端）。
 *
 * 這一頁做三件事：設定通過碼、產生家長連結、逐筆核可或撤銷。
 *
 * 待核可清單住在雲端（parent_bindings 表），所以雲端沒開的時候，
 * 這一頁只能做「設定通過碼」這一半，另一半會誠實說明還沒生效——
 * 不要假裝有一個空清單，那會讓人以為「沒人申請」而不是「這功能還沒開」。
 */

import { store } from './store-select.js';
import { SEED, DEFAULT_SETTINGS } from './data.js';
import { CLOUD_ENABLED, API } from './config.js';

const root = document.getElementById('bindRoot');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const STATUS_LABEL = {
  pending: '待核可',
  approved: '已核可',
  rejected: '已退回',
  revoked: '已撤銷',
};

const state = {
  settings: {},
  classes: [],
  publicId: '',
  bindings: [],
  cloudError: '',
};

/* ---------- 資料 ---------- */

async function loadCloud() {
  if (!CLOUD_ENABLED) return;
  try {
    const res = await fetch(`${API.data.replace('/data', '/parent')}/admin/bindings`, {
      credentials: 'same-origin',
    });
    if (res.status === 401) {
      state.cloudError = '你還沒登入。要看待核可清單，請先用 Google 登入。';
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.publicId = data.publicId || '';
    state.bindings = data.bindings || [];
  } catch (err) {
    state.cloudError = `讀不到待核可清單：${err.message}`;
  }
}

async function decide(parentSub, studentId, status) {
  const res = await fetch(`${API.data.replace('/data', '/parent')}/admin/decide`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ parentSub, studentId, status }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await loadCloud();
  render();
}

function studentLabel(studentId) {
  for (const c of state.classes) {
    const s = (c.students || []).find((x) => x.id === studentId);
    if (s) return `${c.name} ${String(s.no).padStart(2, '0')} ${s.name}`;
  }
  // 名冊上已經沒有這個人了，至少不要印出原始 id 讓老師一頭霧水。
  return '（名冊上已無此學生）';
}

/* ---------- 畫面 ---------- */

function codePanel() {
  /*
   * 舊的 localStorage 是在還沒有這個欄位的時候建立的，讀出來會是 undefined。
   * 這時填上預設值當草稿，但明講「還沒生效」——後端沒有通過碼就一律不放行，
   * 顯示一組看起來已經設好、實際上擋不了任何人的碼，比空白更糟。
   */
  const saved = state.settings.parentCode;
  const code = saved || DEFAULT_SETTINGS.parentCode;
  return `
    <div class="panel">
      <h3>家長通過碼</h3>
      <p class="hint panel-hint">
        發給全班家長的一組號碼。家長輸入這組碼只是「送得出申請」，
        還是要你按核可才看得到東西——所以這組碼不必當機密保管，
        但覺得傳太開了隨時可以換一組，換掉之後舊碼立刻失效，已核可的不受影響。
      </p>
      <div class="codebox">
        <input id="codeInput" type="text" inputmode="numeric" value="${esc(code)}"
               maxlength="20" aria-label="家長通過碼">
        <button id="saveCode" class="btn btn-primary">儲存</button>
        <button id="rollCode" class="btn btn-ghost">換一組</button>
      </div>
      <p class="hint" id="codeHint">${saved ? '' : '這是預設值，還沒儲存過——按下「儲存」才會生效。'}</p>
    </div>`;
}

function linkPanel() {
  if (!CLOUD_ENABLED) {
    return `
      <div class="panel">
        <h3>家長連結</h3>
        <p class="notice">
          雲端還沒開啟，所以還沒有可以發給家長的連結。
          目前家長端只能在你自己這台裝置上預覽。
        </p>
      </div>`;
  }
  const url = new URL('parent.html', location.href);
  if (state.publicId) url.searchParams.set('t', state.publicId);
  return `
    <div class="panel">
      <h3>家長連結</h3>
      <p class="hint panel-hint">整班共用同一個連結，家長打開後自己登入、輸入通過碼、指名孩子。</p>
      <div class="linkbox">
        <input id="linkOut" type="text" readonly value="${esc(url.toString())}" aria-label="家長連結">
        <button id="copyLink" class="btn btn-primary">複製連結</button>
      </div>
      <p class="hint" id="linkHint">連結本身不是通行證，沒有通過碼也沒有你的核可就看不到任何資料。</p>
    </div>`;
}

function rows(list) {
  return list.map((b) => `
    <tr>
      <td>${esc(b.email || '（未提供）')}</td>
      <td>${esc(studentLabel(b.studentId))}</td>
      <td><span class="badge b-${esc(b.status)}">${esc(STATUS_LABEL[b.status] || b.status)}</span></td>
      <td class="acts">
        ${b.status === 'pending' ? `
          <button class="btn btn-primary btn-sm" data-act="approved"
                  data-sub="${esc(b.parentSub)}" data-stu="${esc(b.studentId)}">核可</button>
          <button class="btn btn-ghost btn-sm" data-act="rejected"
                  data-sub="${esc(b.parentSub)}" data-stu="${esc(b.studentId)}">退回</button>` : ''}
        ${b.status === 'approved' ? `
          <button class="btn btn-ghost btn-sm" data-act="revoked"
                  data-sub="${esc(b.parentSub)}" data-stu="${esc(b.studentId)}">撤銷</button>` : ''}
      </td>
    </tr>`).join('');
}

function listPanel() {
  if (!CLOUD_ENABLED) {
    return `
      <div class="panel">
        <h3>待核可的申請</h3>
        <p class="notice">
          這份清單住在雲端，要等雲端儲存與登入開啟之後才會有內容。
          在那之前，這一頁能先做的是把通過碼決定好。
        </p>
      </div>`;
  }
  if (state.cloudError) {
    return `<div class="panel"><h3>待核可的申請</h3><p class="notice">${esc(state.cloudError)}</p></div>`;
  }

  const pending = state.bindings.filter((b) => b.status === 'pending');
  const others = state.bindings.filter((b) => b.status !== 'pending');

  return `
    <div class="panel">
      <h3>待核可的申請 <span class="count">${pending.length}</span></h3>
      ${pending.length
        ? `<table class="tbl"><thead><tr><th>家長帳號</th><th>要看的孩子</th><th>狀態</th><th></th></tr></thead>
           <tbody>${rows(pending)}</tbody></table>`
        : '<p class="empty">目前沒有待處理的申請。</p>'}
    </div>

    <div class="panel">
      <h3>已處理</h3>
      ${others.length
        ? `<table class="tbl"><thead><tr><th>家長帳號</th><th>孩子</th><th>狀態</th><th></th></tr></thead>
           <tbody>${rows(others)}</tbody></table>`
        : '<p class="empty">還沒有處理過的紀錄。</p>'}
    </div>`;
}

function render() {
  root.innerHTML = codePanel() + linkPanel() + listPanel();
  wire();
}

/* ---------- 互動 ---------- */

function wire() {
  const $code = document.getElementById('codeInput');
  const $hint = document.getElementById('codeHint');

  document.getElementById('saveCode')?.addEventListener('click', async () => {
    const v = $code.value.trim();
    if (!v) {
      $hint.textContent = '通過碼不能留空——留空等於任何人都送不出申請，家長會直接卡住。';
      return;
    }
    state.settings = { ...state.settings, parentCode: v };
    await store.saveSettings(state.settings);
    $hint.textContent = `已儲存。現在的通過碼是 ${v}。`;
  });

  document.getElementById('rollCode')?.addEventListener('click', () => {
    // 六位數字好念好在電話裡講，也夠亂到不會被猜中——反正還要你核可。
    $code.value = String(Math.floor(100000 + Math.random() * 900000));
    $hint.textContent = '換好了，記得按「儲存」，然後把新的碼發給家長。';
  });

  document.getElementById('copyLink')?.addEventListener('click', async () => {
    const $out = document.getElementById('linkOut');
    const $lh = document.getElementById('linkHint');
    try {
      await navigator.clipboard.writeText($out.value);
      $lh.textContent = '已複製，可以貼到班級群組了。';
    } catch {
      $out.select();
      $lh.textContent = '這個瀏覽器擋住了自動複製，網址已選取，請按 Ctrl/⌘ + C。';
    }
  });

  root.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const { act, sub, stu } = btn.dataset;
      if (act !== 'approved' && !confirm(`確定要${act === 'rejected' ? '退回' : '撤銷'}這筆嗎？`)) return;
      btn.disabled = true;
      try {
        await decide(sub, stu, act);
      } catch (err) {
        btn.disabled = false;
        alert(`處理失敗：${err.message}`);
      }
    });
  });
}

/* ---------- 進入點 ---------- */

async function main() {
  if (!CLOUD_ENABLED) {
    root.innerHTML = `
      <section class="availability-card" aria-labelledby="bindingUnavailable">
        <img src="assets/access-shield.svg" alt="" width="180" height="140">
        <div>
          <p class="eyebrow">權限尚未啟用</p>
          <h2 id="bindingUnavailable">家長綁定暫不提供</h2>
          <p>本站目前採本機儲存，沒有安全的跨裝置身分驗證與老師核可流程，因此不收集通過碼，也不產生家長連結。</p>
          <a class="btn btn-primary" href="/">回教師主畫面</a>
        </div>
      </section>`;
    return;
  }
  await store.init(SEED);
  state.settings = await store.getSettings();
  state.classes = await store.getClasses();
  await loadCloud();
  render();
}

main();
