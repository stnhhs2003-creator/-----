/*
 * 家長端成長頁（第二期 2.3）。
 *
 * 設計紅線：這一頁「唯一」的學生資料來源是 rules.js 的 parentView()。
 * parentView() 在資料層就只投影 kind === 'positive' 的事件，
 * 所以家長端不是把其他紀錄藏起來，而是根本沒拿到。
 *
 * 這個檔案因此有兩條自律：
 *   1. 從 store 取回的原始事件陣列，只准做兩件事——整包丟給 parentView()，
 *      或依 ts 切出時間區間後再丟給 parentView()。任何一筆事件的 kind／delta，
 *      都不由這裡判讀。
 *   2. 畫面上出現的每一筆紀錄，都必須是 parentView() 回傳值裡的東西。
 *
 * 對應 tests/parent-view.test.mjs：那組測試守的就是 parentView() 這道閘門。
 */

import { store } from './store-select.js';
import { SEED } from './data.js';
import { parentView, startOfDay } from './rules.js';
import { CLOUD_ENABLED, STORE_BACKEND } from './config.js';

/*
 * 雲端開啟之後，這一頁不再是「知道網址就看得到」。
 * 家長要先用 Google 登入、輸入老師發的通過碼、指名孩子的座號與姓名，
 * 再由老師在後台核可。核可前後端一律回 403，前端拿不到任何資料。
 * 詳見 functions/api/parent/[[route]].js。
 */
const PARENT_API = '/api/parent';

const root = document.getElementById('parentRoot');

const WEEKS = 6;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/* ---------- 資料 ---------- */

/**
 * 取這位學生在這個班級的事件，並「原封不動」交給 parentView() 投影。
 * 這裡刻意不把 raw 留在外面給別人用，避免日後有人順手拿去自己算。
 */
async function viewOf(classId, studentId) {
  const raw = await store.queryEvents({ classId, studentId });
  return { view: parentView(raw, studentId), weekly: weeklyPositive(raw, studentId) };
}

/**
 * 每週的正向分數。
 * 切片條件只看 e.ts（時間），切完仍然由 parentView() 決定哪些算數、加多少，
 * 所以這段程式碼看不到、也算不出任何非正向的東西。
 */
function weeklyPositive(raw, studentId) {
  const weeks = [];
  for (let i = WEEKS - 1; i >= 0; i--) {
    const from = startOfDay();
    from.setDate(from.getDate() - i * 7 - 6);
    const to = startOfDay();
    to.setDate(to.getDate() - i * 7 + 1);
    const slice = raw.filter((e) => e.ts >= from.toISOString() && e.ts < to.toISOString());
    weeks.push({
      label: `${from.getMonth() + 1}/${from.getDate()}`,
      value: parentView(slice, studentId).totalPositive,
      isCurrent: i === 0,
    });
  }
  return weeks;
}

/* ---------- 小工具 ---------- */

function behaviorOf(behaviors, id) {
  return behaviors.find((b) => b.id === id) || { label: '好表現', icon: '⭐' };
}

function fmtDate(ts) {
  const d = new Date(ts);
  const w = '日一二三四五六'[d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()}（${w}）`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 依累積次數換一句給家長看的話。 */
function encourage(count) {
  if (count === 0) return '老師還沒有在這段期間記下新的紀錄，過幾天再回來看看。';
  if (count < 5) return '好的開始已經被看見了，這些都是老師在課堂上當下記下來的。';
  if (count < 15) return '這些紀錄累積起來，是孩子每天在教室裡一點一點做到的事。';
  return '這麼長的一串，代表孩子在課堂上被看見的時刻真的很多。';
}

/* ---------- 畫面 ---------- */

function renderError(title, detail) {
  root.innerHTML = `
    <div class="panel parent-error">
      <h3>${esc(title)}</h3>
      <p class="hint">${esc(detail)}</p>
      <p class="hint">如果這是老師給的連結，請把整段網址（含問號後面的部分）完整貼上，或請老師重新產生一次。</p>
      <p class="parent-error-actions"><a class="btn btn-ghost btn-sm" href="parent.html">重新產生連結</a></p>
    </div>`;
}

function renderReport({ cls, student, view, weekly, behaviors }) {
  const max = Math.max(1, ...weekly.map((w) => w.value));

  const highlights = view.highlights.slice(0, 5).map(([behaviorId, n]) => {
    const b = behaviorOf(behaviors, behaviorId);
    return `
      <li class="hl">
        <span class="hl-icon">${esc(b.icon)}</span>
        <span class="hl-label">${esc(b.label)}</span>
        <span class="hl-count">${n} 次</span>
      </li>`;
  }).join('');

  const timeline = view.recent.map((e) => {
    const b = behaviorOf(behaviors, e.behaviorId);
    return `
      <li>
        <span class="t">${esc(fmtDate(e.ts))} ${esc(fmtTime(e.ts))}</span>
        <span class="pl-icon">${esc(b.icon)}</span>
        <span class="pl-label">${esc(b.label)}${e.period ? `<span class="pl-period">${esc(e.period)}</span>` : ''}</span>
        <span class="d pos">+${e.delta}</span>
      </li>`;
  }).join('');

  const bars = weekly.map((w) => `
    <div class="wcol${w.isCurrent ? ' is-current' : ''}">
      <span class="wval">${w.value || ''}</span>
      <div class="wbar" style="height:${Math.round((w.value / max) * 100)}%"></div>
      <span class="wlabel">${esc(w.label)}${w.isCurrent ? '<br>本週' : ''}</span>
    </div>`).join('');

  root.innerHTML = `
    <section class="parent-hero">
      <p class="parent-cls">${esc(cls.name)}</p>
      <!--
        GAS 那條線的後端不給姓名（試算表裡根本沒有這個欄位，docs/gas-contract.md 鐵則第 2 條），
        送過來的是 student.label＝「您的孩子（13號）」。前端不補姓名、也不去猜，
        就照後端給的稱呼顯示；Cloudflare 那條線仍然有 name，所以 label 缺席時原樣退回。
      -->
      <h2>${esc(student.label ?? student.name)} 的成長紀錄</h2>
      <p class="hint">${esc(encourage(view.count))}</p>
    </section>

    <div class="stats parent-stats">
      <div class="stat">
        <div class="k">累積鼓勵分數</div>
        <div class="v">${view.totalPositive}</div>
      </div>
      <div class="stat">
        <div class="k">被記下的好表現</div>
        <div class="v">${view.count} <span class="unit">次</span></div>
      </div>
      <div class="stat">
        <div class="k">最常出現的亮點</div>
        <div class="v v-sm">${view.highlights.length
          ? esc(behaviorOf(behaviors, view.highlights[0][0]).label)
          : '再等等'}</div>
      </div>
    </div>

    <div class="panel">
      <h3>最常出現的表現</h3>
      ${highlights
        ? `<ul class="hl-list">${highlights}</ul>`
        : '<p class="empty">還沒有累積到可以看出習慣的紀錄，再過一陣子回來看。</p>'}
    </div>

    <div class="panel">
      <h3>每週鼓勵分數</h3>
      <p class="hint panel-hint">看的是趨勢，不是名次——和自己上一週比就好。</p>
      <div class="weekly">${bars}</div>
    </div>

    <div class="panel">
      <h3>最近的紀錄</h3>
      ${timeline
        ? `<ul class="timeline parent-timeline">${timeline}</ul>`
        : '<p class="empty">這段期間還沒有新的紀錄。</p>'}
    </div>

    <p class="parent-note">
      這一頁由老師在課堂當下逐筆記錄產生，只呈現孩子的正向表現。
      課堂上其他需要老師陪著調整的部分，老師會直接和您聯繫，不會出現在這個頁面。
    </p>`;
}

function renderPicker(classes) {
  root.innerHTML = `
    <section class="parent-hero">
      <h2>產生家長專屬連結</h2>
      <p class="hint">選一位學生，把產生的連結傳給家長。家長打開只會看到這位孩子的正向紀錄。</p>
    </section>

    <div class="panel">
      <div class="filters">
        <label>班級
          <select id="pickClass"></select>
        </label>
        <label>學生
          <select id="pickStudent"></select>
        </label>
      </div>
      <div class="linkbox">
        <input id="linkOut" type="text" readonly aria-label="家長專屬連結">
        <button id="copyBtn" class="btn btn-primary">複製連結</button>
      </div>
      <p class="hint" id="copyHint">
        這是本機預覽用的連結，只在你自己這台裝置上打得開。
        真的要發給家長，請到 <a href="bindings.html">家長綁定</a> 那一頁——
        家長要登入、輸入通過碼，再由你核可才看得到。
      </p>
      <p class="parent-preview"><a id="previewLink" href="#" target="_blank" rel="noopener">先自己開一次看看 →</a></p>
    </div>`;

  const $cls = document.getElementById('pickClass');
  const $stu = document.getElementById('pickStudent');
  const $out = document.getElementById('linkOut');
  const $hint = document.getElementById('copyHint');
  const $preview = document.getElementById('previewLink');

  $cls.innerHTML = classes
    .map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  $cls.value = classes[0].id;

  function fillStudents() {
    const cls = classes.find((c) => c.id === $cls.value) || classes[0];
    const students = cls.students || [];
    $stu.innerHTML = students
      .map((s) => `<option value="${esc(s.id)}">${String(s.no).padStart(2, '0')} ${esc(s.name)}</option>`)
      .join('');
    $stu.value = students[0]?.id || '';
    fillLink();
  }

  function fillLink() {
    const url = new URL('parent.html', location.href);
    url.searchParams.set('c', $cls.value);
    url.searchParams.set('s', $stu.value);
    $out.value = url.toString();
    $preview.href = url.toString();
  }

  $cls.addEventListener('change', fillStudents);
  $stu.addEventListener('change', fillLink);

  document.getElementById('copyBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($out.value);
      $hint.textContent = '已複製，可以直接貼到聯絡管道了。';
    } catch {
      $out.select();
      $hint.textContent = '這個瀏覽器擋住了自動複製，網址已選取，請按 Ctrl/⌘ + C。';
    }
  });

  fillStudents();
}

/* ---------- 雲端：登入 + 通過碼 + 老師核可 ---------- */

function renderSignIn() {
  root.innerHTML = `
    <section class="parent-hero">
      <h2>孩子的成長紀錄</h2>
      <p class="hint">請先用 Google 登入。登入只是為了確認您是哪一位家長，
        我們不會讀取您的信件、雲端硬碟或聯絡人。</p>
    </section>
    <div class="panel parent-gate">
      <a class="btn btn-primary" href="/api/auth/login?next=${encodeURIComponent(location.href)}">
        用 Google 帳號登入
      </a>
    </div>`;
}

function renderPending(email) {
  root.innerHTML = `
    <section class="parent-hero">
      <h2>已送出，等老師確認</h2>
      <p class="hint">您的申請已經送到老師那裡。老師確認之後，這一頁就會出現孩子的紀錄。</p>
    </section>
    <div class="panel parent-gate">
      <p>目前登入的帳號：<strong>${esc(email || '')}</strong></p>
      <p class="hint">如果等太久，直接跟老師說一聲就好——核可要老師本人按，這是刻意的設計。</p>
      <p><button id="refreshPending" class="btn btn-ghost btn-sm">重新整理看看</button></p>
    </div>`;
  document.getElementById('refreshPending').addEventListener('click', () => location.reload());
}

function renderCodeForm(publicId, email, message = '') {
  root.innerHTML = `
    <section class="parent-hero">
      <h2>第一次進來，先確認身分</h2>
      <p class="hint">請輸入老師發的通過碼，並填上孩子的座號與姓名。送出後由老師確認才會開通。</p>
    </section>
    <div class="panel parent-gate">
      <p class="hint">目前登入的帳號：<strong>${esc(email || '')}</strong></p>
      <label class="fld">通過碼
        <input id="pCode" type="text" inputmode="numeric" autocomplete="one-time-code">
      </label>
      <label class="fld">孩子的座號
        <input id="pNo" type="text" inputmode="numeric">
      </label>
      <label class="fld">孩子的姓名
        <input id="pName" type="text">
      </label>
      <p class="hint" id="pMsg">${esc(message)}</p>
      <button id="pSend" class="btn btn-primary">送出申請</button>
    </div>`;

  document.getElementById('pSend').addEventListener('click', async () => {
    const $msg = document.getElementById('pMsg');
    $msg.textContent = '送出中…';
    try {
      const res = await fetch(`${PARENT_API}/request?t=${encodeURIComponent(publicId)}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: document.getElementById('pCode').value,
          no: document.getElementById('pNo').value,
          name: document.getElementById('pName').value,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        $msg.textContent = data.error || '送不出去，請稍後再試一次。';
        return;
      }
      renderPending(email);
    } catch (err) {
      $msg.textContent = `網路好像有點問題：${err.message}`;
    }
  });
}

/** 後端已經只送正向、未撤銷的事件；這裡仍然走 parentView()，維持只有一個投影閘門。 */
async function renderCloudReport(publicId, studentId) {
  const res = await fetch(
    `${PARENT_API}/view?t=${encodeURIComponent(publicId)}&s=${encodeURIComponent(studentId)}`,
    { credentials: 'same-origin' },
  );
  if (!res.ok) {
    renderError('目前看不到這位學生的紀錄', '可能是老師還沒核可，或這個帳號的權限被取消了。');
    return;
  }
  const data = await res.json();
  document.title = `${data.student.name} 的成長紀錄 — 班級積分堂`;
  renderReport({
    cls: data.cls,
    student: data.student,
    view: parentView(data.events, studentId),
    weekly: weeklyPositive(data.events, studentId),
    behaviors: data.behaviors || [],
  });
}

async function cloudMain(publicId) {
  const res = await fetch(`${PARENT_API}/me?t=${encodeURIComponent(publicId)}`, {
    credentials: 'same-origin',
  });
  if (res.status === 401) {
    renderSignIn();
    return;
  }
  const me = await res.json();
  if (!me.known) {
    renderError('這個連結認不出是哪一班', '請跟老師要一次新的連結。');
    return;
  }

  const approved = (me.bindings || []).filter((b) => b.status === 'approved');
  if (approved.length) {
    // 兄弟姊妹同校時會有多筆；先顯示第一位，其餘用網址的 s 參數切換。
    const wanted = new URLSearchParams(location.search).get('s');
    const pick = approved.find((b) => b.studentId === wanted) || approved[0];
    await renderCloudReport(publicId, pick.studentId);
    return;
  }
  if ((me.bindings || []).some((b) => b.status === 'pending')) {
    renderPending(me.email);
    return;
  }
  const rejected = (me.bindings || []).some((b) => b.status === 'rejected' || b.status === 'revoked');
  renderCodeForm(
    publicId,
    me.email,
    rejected ? '先前的申請沒有通過。如果是填錯了，可以再送一次；如果不確定，請直接問老師。' : '',
  );
}

/* ---------- Apps Script：班級 + 座號 + 家長代碼 ---------- */

/*
 * 家長身分只活在這個分頁的 sessionStorage 裡。
 *
 * 用 sessionStorage 而不是 localStorage：家長常常是拿別人的手機、或在學校的公用電腦上
 * 點開老師傳的連結，關掉分頁就該忘掉，不要留在那台裝置上等下一個人打開。
 * 用 sessionStorage 而不是網址參數：網址是可以隨手改的，那等於沒驗；而且網址會留在
 * 瀏覽器歷史、家長轉貼的截圖、Apps Script 的執行紀錄裡——家長代碼進了那些地方，
 * 等於印出來貼在走廊上（gas/Public.gs 那三條路由一律走 POST 就是同一個理由）。
 *
 * 跟 js/student.js 的差別：那邊每次都拿名冊在本機重新比對代碼，這邊比不了——
 * 前端手上根本沒有名冊。所以這裡存的東西不代表「已經驗過」，只是「上次打了什麼」；
 * 真正的驗證每一次都在 publicParentView() 重做一遍，重整一次就是重驗一次。
 */
const PARENT_SESSION_KEY = 'cp:parent-identity';

export function loadParentIdentity() {
  try {
    const raw = sessionStorage.getItem(PARENT_SESSION_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && v.classId && v.no && v.code ? v : null;
  } catch {
    return null;
  }
}

export function saveParentIdentity(identity) {
  try {
    if (identity) sessionStorage.setItem(PARENT_SESSION_KEY, JSON.stringify(identity));
    else sessionStorage.removeItem(PARENT_SESSION_KEY);
  } catch {
    /* 無痕模式擋掉 sessionStorage 也不該讓頁面壞掉，只是重整後要再打一次碼。 */
  }
}

/**
 * 失敗時要顯示哪一句話。
 *
 * 後端認不出人的時候只回一句話（「座號跟家長代碼對不起來，再確認一次。」），
 * 三種失敗共用同一句是刻意的——分開講等於送人一支代碼探測器，理由見 gas/Public.gs 檔頭。
 * 所以這裡的規則是：**後端說什麼就顯示什麼**，不改寫、不加料、不依狀態碼細分。
 * 只有連後端都沒回話（傳輸炸掉）才用自己的 fallback，那句話不帶任何關於這個孩子的資訊。
 */
export function backendMessage(err, fallback = '送不出去，請等一下再試一次。') {
  const looksBackend = !!err && (err.name === 'PublicStoreError' || typeof err.status === 'number');
  const msg = err && typeof err.message === 'string' ? err.message.trim() : '';
  return looksBackend && msg ? msg : fallback;
}

function renderParentGate(classes, { message = '', values = {} } = {}) {
  const options = classes
    .map((c) => `<option value="${esc(c.id)}"${c.id === values.classId ? ' selected' : ''}>${esc(c.name)}</option>`)
    .join('');

  root.innerHTML = `
    <section class="parent-hero">
      <h2>孩子的成長紀錄</h2>
      <p class="hint">請選孩子的班級，填上座號與老師發的家長代碼。
        這一頁只會顯示這個孩子的正向紀錄。</p>
    </section>
    <div class="panel parent-gate">
      <label class="fld">班級
        <select id="pgClass">${options}</select>
      </label>
      <label class="fld">孩子的座號
        <input id="pgNo" type="text" inputmode="numeric" autocomplete="off" value="${esc(values.no || '')}">
      </label>
      <label class="fld">家長代碼
        <input id="pgCode" type="text" autocomplete="off">
      </label>
      <p class="hint" id="pgMsg">${esc(message)}</p>
      <button id="pgSend" class="btn btn-primary">看孩子的紀錄</button>
      <p class="hint">代碼只留在這個分頁，關掉就忘掉，也不會出現在網址上。</p>
    </div>`;
}

/**
 * 拿到資料就整包交給既有的 renderReport()。
 *
 * 後端（publicParentView）已經只送正向、未撤銷的事件，這裡仍然走 parentView()，
 * 維持整頁只有一個投影閘門——不是不信後端，是不想讓「哪些事件算數」這件事
 * 在前端多出第二個說法。前端不看 kind、不看 voided、不自己加總。
 */
async function showGasReport(api, identity) {
  const data = await api.parentView(identity);
  const studentId = data.student.id;
  // 標題不帶稱呼：這一頁常常是在別人看得到的螢幕上開的，分頁標題會被瞄到。
  document.title = '成長紀錄 — 班級積分堂';
  renderReport({
    cls: data.cls,
    student: data.student,
    view: parentView(data.events, studentId),
    weekly: weeklyPositive(data.events, studentId),
    behaviors: data.behaviors || [],
  });
}

export async function gasMain(injectedApi) {
  // store-public.js 用動態載入：家長端以外的分頁（老師本機預覽、Cloudflare 那條線）
  // 根本不該把公開端的用戶端拉進來，靜態 import 會讓它們一起載。
  const api = injectedApi || (await import('./store-public.js')).createPublicClient();

  let classes;
  try {
    classes = await api.classes();
  } catch (err) {
    renderError('現在連不上老師的資料', backendMessage(err, '請稍後重新整理一次；如果一直這樣，請跟老師說一聲。'));
    return;
  }
  if (!classes.length) {
    renderError('老師還沒有建立班級', '等老師把名冊建好，這一頁就會出現孩子的紀錄。');
    return;
  }

  /*
     每次重畫表單都要重掛一次事件：innerHTML 一寫，舊的 #pgSend 連同它的
     listener 就一起沒了。第一次打錯是最常見的情況，掉了這一步家長就卡在
     「按了沒反應」，而且完全看不出原因。
  */
  function gate(opts) {
    renderParentGate(classes, opts);
    document.getElementById('pgSend').addEventListener('click', onSend);
  }

  async function attempt(identity, values) {
    try {
      await showGasReport(api, identity);
      saveParentIdentity(identity);
      return true;
    } catch (err) {
      // 沒過就把身分丟掉，免得一組打錯的代碼在這個分頁裡被一直重送。
      saveParentIdentity(null);
      gate({ message: backendMessage(err), values });
      return false;
    }
  }

  async function onSend() {
    const classId = document.getElementById('pgClass').value;
    const no = document.getElementById('pgNo').value.trim();
    const code = document.getElementById('pgCode').value.trim();
    if (!no || !code) {
      document.getElementById('pgMsg').textContent = '座號跟家長代碼都要填。';
      return;
    }
    document.getElementById('pgMsg').textContent = '確認中…';
    // values 只帶班級與座號回表單，代碼一律要重打——代碼不留在畫面上。
    await attempt({ classId, no, code }, { classId, no });
  }

  const saved = loadParentIdentity();
  if (saved && classes.some((c) => c.id === saved.classId)) {
    // 重整同一個分頁不用重打；代碼還是會在後端重驗一次，這裡省的只是手打。
    // 失敗的話 attempt() 內部已經把表單畫回來了，這裡不用再補一次。
    await attempt(saved, { classId: saved.classId, no: saved.no });
    return;
  }
  gate();
}

/* ---------- 進入點 ---------- */

async function main() {
  /*
   * GAS 那條線的家長端是「公開網址 + 家長代碼」，不是 Google 登入，
   * 所以不能借 CLOUD_ENABLED 的分支（config.js 那段註解講的就是這件事）。
   * 這一條要排在 !CLOUD_ENABLED 之前：gas 模式下 CLOUD_ENABLED 也是 false，
   * 排在後面就會先掉進「尚未開放」那張卡。
   */
  if (STORE_BACKEND === 'gas') {
    try {
      await gasMain();
    } catch (err) {
      console.error(err);
      renderError('頁面載入時出了狀況', '請重新整理一次；如果還是一樣，請把這個情況告訴老師。');
    }
    return;
  }
  if (!CLOUD_ENABLED) {
    root.innerHTML = `
      <section class="availability-card" aria-labelledby="parentUnavailable">
        <img src="assets/access-shield.svg" alt="" width="180" height="140">
        <div>
          <p class="eyebrow">家長資料保護</p>
          <h2 id="parentUnavailable">家長端尚未開放</h2>
          <p>目前正式站的資料只存在老師的瀏覽器，無法安全地跨裝置分享，也不會產生可轉傳的學生連結。</p>
          <p class="hint">完成家長登入、老師核可及伺服器端權限驗證後才會開放。</p>
          <a class="btn btn-primary" href="/">回教師主畫面</a>
        </div>
      </section>`;
    return;
  }
  if (CLOUD_ENABLED) {
    const publicId = new URLSearchParams(location.search).get('t');
    if (publicId) {
      try {
        await cloudMain(publicId);
      } catch (err) {
        console.error(err);
        renderError('頁面載入時出了狀況', '請重新整理一次；如果還是一樣，請把這個情況告訴老師。');
      }
      return;
    }
    // 沒有 t 參數＝老師自己在本機預覽，往下走原本那條路。
  }
  return localMain();
}

async function localMain() {
  try {
    await store.init(SEED);
    const classes = await store.getClasses();
    const params = new URLSearchParams(location.search);
    const classId = params.get('c');
    const studentId = params.get('s');

    if (!classId && !studentId) {
      if (!classes.length) {
        renderError('這台裝置上還沒有班級資料', '請老師先在主畫面建立班級，再回到這一頁產生連結。');
        return;
      }
      renderPicker(classes);
      return;
    }

    const cls = classes.find((c) => c.id === classId);
    if (!cls) {
      renderError('找不到這個班級', `連結裡的班級代號「${classId || '（空白）'}」在這台裝置上查不到資料。`);
      return;
    }

    const student = (cls.students || []).find((s) => s.id === studentId);
    if (!student) {
      renderError('找不到這位學生', `連結裡的學生代號「${studentId || '（空白）'}」不在「${cls.name}」裡。`);
      return;
    }

    const behaviors = await store.getBehaviors();
    const { view, weekly } = await viewOf(cls.id, student.id);
    document.title = `${student.name} 的成長紀錄 — 班級積分堂`;
    renderReport({ cls, student, view, weekly, behaviors });
  } catch (err) {
    console.error(err);
    renderError('頁面載入時出了狀況', '請重新整理一次；如果還是一樣，請把這個情況告訴老師。');
  }
}

main();
