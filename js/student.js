/*
 * 學生端（第二期 2.1 + 2.2 的學生側）。
 *
 * 紅線一：這一頁不得出現任何負向行為的明細。
 * 班級榜只有淨分與進步幅度這種彙總數字；個人成長的紀錄列表只列 kind === 'positive'。
 * 商店的申請只寫入 kind: 'redeem-request'、delta: 0，真正扣點由老師端核可時才發生。
 *
 * 紅線二（這一輪補的）：身分要驗，而且分界在這裡——
 *
 *   班級榜      已停用。姓名、座號與淨分都屬於可識別的學生表現資料。
 *   個人成長    要代碼。
 *   點數餘額    要代碼。
 *   商店申請    要代碼。用別人的名義送申請，等於替別人把點數花掉。
 *
 * 原本的做法是「班級下拉 ＋ 學生下拉」：拉到誰就看得到誰。隔壁同學順手一拉，
 * 就看得到你的餘額、你的成長，還能用你的名義去換東西。那個學生下拉已經拿掉了。
 *
 * 通過之後的身分記在 sessionStorage，**不是網址參數**——
 * 放網址上就變成「改一下網址就換一個人」，跟原本的下拉是同一個洞換一個位置而已。
 * 這一頁從頭到尾不讀任何 location.search／location.hash 的身分參數。
 *
 * 而且 sessionStorage 裡存的是「學生 id ＋ 當初打對的那組代碼」，
 * 每次要用身分時都重新拿去跟名冊比對（verifiedStudent()）：
 * 手動把 sessionStorage 的 studentId 改成同學的，代碼就對不上，閘門立刻關回去。
 *
 * 雲端模式（CLOUD_ENABLED = true）的驗證與投影都在伺服器端，
 * 見 functions/api/student/[[route]].js——前端過濾可以被繞過，SQL WHERE 不行。
 */

import { store } from './store-select.js';
import { SEED } from './data.js';
import { STORE_BACKEND } from './config.js';
import { ensureCodes, findStudentByCode } from './codes.js';
import {
  ensureRewards, rankRows, weeklyPositive, positiveRecords,
  balanceOf, availableOf, pendingRequests,
} from './shop-core.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  classes: [],
  rewards: [],
  events: [],
  classId: null,
  // identity = { classId, studentId, code }，來自 sessionStorage，**每次用都要重驗**。
  identity: null,
  view: 'rank',
  gateErr: '',
};

/*
 * 身分只活在這個分頁的 sessionStorage 裡。
 *
 * 用 sessionStorage 而不是 localStorage：學生常常是借同學的手機或用班級平板開的，
 * 關掉分頁就該忘掉，不要留在那台裝置上等下一個人打開。
 * 用 sessionStorage 而不是網址參數：網址是可以隨手改的，那等於沒驗。
 */
const SESSION_KEY = 'cp:student-identity';

function loadIdentity() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveIdentity(identity) {
  state.identity = identity;
  try {
    if (identity) sessionStorage.setItem(SESSION_KEY, JSON.stringify(identity));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* 無痕模式擋掉 sessionStorage 也不該讓頁面壞掉，只是重整後要再打一次碼。 */
  }
}

/**
 * 目前這個分頁「驗過的」學生，沒有就回 null。
 *
 * 關鍵在於它每次都重新比對代碼，而不是相信 sessionStorage 裡寫著誰。
 * 所以下面三種手腳都會被擋下來：
 *   改 sessionStorage 的 studentId → 代碼對不上，回 null
 *   自己編一組 identity 塞進去    → 代碼對不上，回 null
 *   老師剛剛把這個人的代碼重發    → 舊碼失效，回 null，要重打新碼
 * 換班級看榜也不會順便把身分帶過去：identity.classId 不是目前這班就不算數。
 */
function verifiedStudent() {
  const id = state.identity;
  if (!id || id.classId !== state.classId) return null;
  const hit = findStudentByCode(state.classes, {
    classId: id.classId,
    studentId: id.studentId,
    code: id.code,
  });
  return hit ? hit.student : null;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const signed = (n) => (n > 0 ? `+${n}` : `${n}`);

function currentClass() {
  return state.classes.find((c) => c.id === state.classId) || state.classes[0];
}

/** 目前班級的有效事件。學生端一律不看已撤銷的資料。 */
function liveEvents() {
  return state.events.filter((e) => !e.voided && e.classId === state.classId);
}

// ---------- 初始化 ----------

async function init() {
  if (STORE_BACKEND === 'gas') {
    await initGas();
    return;
  }
  await store.init(SEED);

  /*
   * 舊的名冊沒有 code 欄位，讀出來每個人都是 undefined。
   * 這裡自動補發而不是壞掉——不然升級當天全班都打不開自己的頁面。
   * 已經有代碼的人一律不動，補發是老師在 codes.html 的動作，不是每次開頁就換一次。
   */
  const loaded = await store.getClasses();
  const { classes, added } = ensureCodes(loaded);
  state.classes = classes;
  if (added) await store.saveClasses(classes);

  behaviorCache = await store.getBehaviors();
  state.rewards = await ensureRewards(store);
  state.classId = state.classes[0]?.id || null;
  state.identity = loadIdentity();
  await reloadEvents();

  renderClassSelect();
  bind();
  render();
}

async function reloadEvents() {
  state.events = await store.queryEvents({});
}

function renderClassSelect() {
  const sel = $('#classSelect');
  sel.innerHTML = state.classes.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  sel.value = state.classId;
}

// ---------- 個人代碼閘門 ----------

/*
 * 閘門畫面。同一份表單會出現在「個人成長」與「積分商店」兩個分頁，
 * 所以用 host 當前綴產生不重複的 id。
 *
 * 表單只有兩格：選座號 ＋ 打代碼。選座號本身不給任何東西——
 * 舊版就是「選了就給」，那正是要修掉的那個洞。
 */
function gateHtml(host) {
  const cls = currentClass();
  const options = (cls?.students || [])
    .map((s) => `<option value="${esc(s.id)}">${esc(s.no)}號 ${esc(s.name)}</option>`)
    .join('');
  return `
    <div class="gate">
      <h3>先確認一下是你本人</h3>
      <p class="hint">
        選自己的座號，再打老師發給你的 4 位數代碼。
        代碼只有你自己知道，別人就沒辦法用你的名義看你的分數、換你的點數。
        忘記了就跟老師講，老師可以重發一組。
      </p>
      <form class="gate-form" id="${host}Form">
        <label>座號
          <select id="${host}No" aria-label="選擇自己的座號">
            <option value="">選座號…</option>
            ${options}
          </select>
        </label>
        <label>個人代碼
          <input id="${host}Code" class="gate-code" type="text" inputmode="numeric"
                 maxlength="6" autocomplete="off" placeholder="••••" aria-label="個人代碼">
        </label>
        <button class="btn btn-primary" type="submit">進入</button>
      </form>
      ${state.gateErr ? `<p class="gate-err">${esc(state.gateErr)}</p>` : ''}
    </div>`;
}

/** 已驗過的時候顯示的那一條：讓學生知道現在是誰，也給一個「換人」的出口。 */
function whoHtml(stu, host) {
  return `
    <div class="gate-who">
      <span>目前是</span>
      <span class="who-name">${esc(stu.no)}號 ${esc(stu.name)}</span>
      <button class="btn btn-ghost btn-sm" id="${host}Leave">不是我／換人</button>
    </div>`;
}

function renderGate(host) {
  const stu = verifiedStudent();
  const gateBox = $(`#${host}Gate`);
  const content = $(`#${host}Content`);

  if (stu) {
    gateBox.innerHTML = whoHtml(stu, host);
    content.hidden = false;
    $(`#${host}Leave`).addEventListener('click', () => {
      saveIdentity(null);
      state.gateErr = '';
      render();
    });
    return stu;
  }

  // 沒驗過就把整包內容藏起來——不是先算好再遮住，是根本不算、不放進 DOM。
  gateBox.innerHTML = gateHtml(host);
  content.hidden = true;
  $(`#${host}Form`).addEventListener('submit', (e) => {
    e.preventDefault();
    submitGate(host);
  });
  return null;
}

function submitGate(host) {
  const studentId = $(`#${host}No`).value;
  const code = $(`#${host}Code`).value;
  if (!studentId) {
    state.gateErr = '請先選自己的座號。';
    render();
    return;
  }
  const hit = findStudentByCode(state.classes, { classId: state.classId, studentId, code });
  if (!hit) {
    // 刻意不分「沒這個人」與「碼打錯」：分開講等於送同學一支代碼探測器。
    state.gateErr = '座號跟代碼對不起來，再確認一次。忘記代碼可以請老師重發。';
    render();
    return;
  }
  state.gateErr = '';
  saveIdentity({ classId: state.classId, studentId: hit.student.id, code });
  render();
}

// ---------- 班級榜 ----------

/*
 * 舊版班級榜畫面保留在程式碼中供資料遷移參考，但本機模式入口已停用，
 * 雲端 API 的公開排行也固定回 410，不會對外投影學生表現。
 */
function renderRank() {
  const cls = currentClass();
  if (!cls) return;
  const meId = verifiedStudent()?.id || null;
  const rows = rankRows(liveEvents(), cls.students);

  $('#rankTable').innerHTML = `
    <table>
      <thead>
        <tr><th>名次</th><th>姓名</th><th class="num">淨分</th><th class="num">進步幅度</th></tr>
      </thead>
      <tbody>
        ${rows.map((r) => {
          const me = meId && r.student.id === meId ? ' class="stu-me"' : '';
          const arrow = r.delta > 0 ? '▲' : r.delta < 0 ? '▼' : '—';
          const dcls = r.delta > 0 ? 'up' : r.delta < 0 ? 'down' : 'flat';
          const dtext = r.delta === 0 ? '持平' : `${arrow} ${Math.abs(r.delta)}`;
          return `
            <tr${me}>
              <td class="stu-rank">${r.rank}</td>
              <td>${esc(r.student.name)}</td>
              <td class="num">${signed(r.net)}</td>
              <td class="num"><span class="stu-delta ${dcls}">${dtext}</span></td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

// ---------- 個人成長 ----------

function renderMe() {
  // 要代碼。沒通過就只有閘門，下面一個數字都不算。
  const stu = renderGate('me');
  if (!stu) {
    $('#meTitle').textContent = '個人成長';
    return;
  }

  const evts = liveEvents();
  const positives = evts.filter((e) => e.studentId === stu.id && e.kind === 'positive');
  const balance = balanceOf(evts, stu.id);
  const spent = evts
    .filter((e) => e.studentId === stu.id && e.kind === 'redeem')
    .reduce((s, e) => s + Math.abs(e.delta), 0);

  $('#meTitle').textContent = `${stu.no}號 ${stu.name} 的成長`;
  $('#meStats').innerHTML = `
    <div class="stat"><div class="k">淨分餘額</div><div class="v">${signed(balance)}</div></div>
    <div class="stat"><div class="k">正向次數</div><div class="v">${positives.length}</div></div>
    <div class="stat"><div class="k">累積正向分數</div><div class="v">+${positives.reduce((s, e) => s + e.delta, 0)}</div></div>
    <div class="stat"><div class="k">已兌換點數</div><div class="v">${spent}</div></div>`;

  const buckets = weeklyPositive(evts, stu.id, 6);
  const max = Math.max(1, ...buckets.map((b) => b.value));
  $('#meChart').innerHTML = buckets.map((b) => `
    <div class="stu-col">
      <div class="stu-val">${b.value || ''}</div>
      <div class="stu-bar" style="height:${(b.value / max) * 100}%"></div>
      <div class="tlabel">${b.label}</div>
    </div>`).join('');

  const recs = positiveRecords(evts, stu.id, 12);
  $('#meRecords').innerHTML = recs.length
    ? recs.map((e) => {
        const d = new Date(e.ts);
        const ts = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        return `<li>
          <span class="t">${ts}</span>
          <span>${esc(labelOf(e.behaviorId))}</span>
          <span class="d pos">+${e.delta}</span>
        </li>`;
      }).join('')
    : '<li>還沒有正向紀錄，繼續加油。</li>';
}

/** 學生端只顯示正向行為名稱，因此只查得到正向卡的字。 */
let behaviorCache = [];
function labelOf(id) {
  const b = behaviorCache.find((x) => x.id === id && x.kind === 'positive');
  return b ? `${b.icon} ${b.label}` : '正向表現';
}

// ---------- 積分商店 ----------

function renderShop() {
  // 要代碼。餘額是個人資料，用別人的名義送申請等於替別人把點數花掉。
  const stu = renderGate('shop');
  if (!stu) return;

  const evts = liveEvents();
  const active = state.rewards.filter((r) => r.active);

  const balance = balanceOf(evts, stu.id);
  const availNow = availableOf(evts, stu.id, state.rewards);
  $('#shopBalance').innerHTML = `${esc(stu.name)}　目前淨分 <strong>${balance}</strong> 點`
    + (availNow !== balance ? `，扣掉申請中的品項還可動用 <strong>${availNow}</strong> 點。` : '。');

  // 申請中
  const pending = pendingRequests(evts, stu.id);
  $('#shopPending').innerHTML = pending.length
    ? `<div class="panel"><h3>申請中（等老師核可）</h3><ul class="timeline">${
        pending.map((e) => `<li><span class="t">${new Date(e.ts).toLocaleDateString('zh-TW')}</span><span>${esc(e.note || '獎勵')}</span><span class="d">待核可</span></li>`).join('')
      }</ul></div>`
    : '';

  if (!active.length) {
    $('#shopList').innerHTML = '<p class="empty">老師還沒上架任何獎勵。</p>';
    return;
  }

  $('#shopList').innerHTML = active.map((r) => {
    const out = r.stock !== null && r.stock !== undefined && r.stock <= 0;
    const lack = r.cost - availNow;
    let disabled = '';
    let note = '';
    if (out) { disabled = 'disabled'; note = '已被換完'; }
    else if (lack > 0) { disabled = 'disabled'; note = `還差 ${lack} 點`; }
    const stockText = (r.stock === null || r.stock === undefined) ? '不限量' : `剩 ${r.stock} 份`;
    return `
      <div class="stu-reward">
        <div class="stu-reward-head">
          <span class="stu-reward-name">${esc(r.name)}</span>
          <span class="stu-cost">${r.cost} 點</span>
        </div>
        <div class="stu-reward-meta">${stockText}</div>
        <button class="btn btn-primary btn-sm" data-redeem="${r.id}" ${disabled}>申請兌換</button>
        ${note ? `<p class="stu-lack">${esc(note)}</p>` : ''}
      </div>`;
  }).join('');
}

async function requestRedeem(rewardId) {
  const reward = state.rewards.find((r) => r.id === rewardId);
  /*
   * 再驗一次。畫面上按得到不等於可以寫進去——
   * 按鈕是 DOM，DOM 是可以被改的；這一行才是真正決定「用誰的名義送申請」的地方。
   */
  const stu = verifiedStudent();
  if (!reward || !stu) {
    showToast('身分已經過期，請重新輸入你的個人代碼。');
    render();
    return;
  }

  const evts = liveEvents();
  const avail = availableOf(evts, stu.id, state.rewards);
  if (avail < reward.cost) {
    showToast(`點數不夠，還差 ${reward.cost - avail} 點。`);
    return;
  }
  if (reward.stock !== null && reward.stock !== undefined && reward.stock <= 0) {
    showToast('這項獎勵已經被換完了。');
    return;
  }

  try {
    await store.appendEvent({
      classId: state.classId,
      studentId: stu.id,
      behaviorId: reward.id,
      delta: 0,
      kind: 'redeem-request',
      note: reward.name,
    });
  } catch (err) {
    showToast(err.message);
    return;
  }
  await reloadEvents();
  showToast(`已送出「${reward.name}」的兌換申請，等老師核可。`);
  render();
}

// ---------- 共用 ----------

let toastTimer = null;
function showToast(text) {
  $('#toastText').textContent = text;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4000);
}

function switchView(view) {
  state.view = view;
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${view}`));
  render();
}

function render() {
  if (state.view === 'rank') renderRank();
  if (state.view === 'me') renderMe();
  if (state.view === 'shop') renderShop();
}

function bind() {
  $('#classSelect').addEventListener('change', async (e) => {
    // 切班只影響班級榜。身分不跟著換班（verifiedStudent() 會比對 classId），
    // 所以切去別班看榜，不會順便拿到別班的個人頁。
    state.classId = e.target.value;
    state.gateErr = '';
    render();
  });

  $$('.tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));

  $('#shopList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-redeem]');
    if (btn && !btn.disabled) requestRedeem(btn.dataset.redeem);
  });
}

// ══════════════════════ GAS 模式（公開端 Apps Script）══════════════════════
/*
 * 上面那一整段是本機／雲端版；這一段是 STORE_BACKEND === 'gas' 的學生端。
 * 兩邊的差別不是換一個 fetch，是「誰在驗、誰在算」整個換人：
 *
 *   本機版   名冊在瀏覽器裡，所以前端才能自己比對代碼、自己加總餘額。
 *   GAS 版   名冊不出老師的電腦（docs/gas-contract.md），
 *            前端手上**沒有**名冊，也不該有——所以：
 *
 *   · 閘門沒有學生下拉，只有「自己填座號」＋「填個人代碼」兩格。
 *     下拉要先有名冊才生得出來，而名冊本身就是舊版那個
 *     「拉到誰就看得到誰」的洞；這裡連生成的材料都不給。
 *   · 沒有 verifiedStudent() 那種本機比對。等價的作法是
 *     **每一次操作都把代碼一起送給後端**（gas/Public.gs 的 pubVerify 每次都驗），
 *     前端不留任何「已通過」的布林值當通行證——那種旗標改一下就通行了。
 *   · 餘額直接用後端送來的 balance 數字。前端拿 events 自己加總
 *     等於要求後端把待改進明細一起送出來，那正是 Public.gs 紅線 3 擋的事。
 *   · 班級榜不畫。後端 publicRank() 固定回 410（座號＋淨分仍可識別學生表現），
 *     所以連那個分頁都藏起來，不去打一個註定失敗的端點。
 *
 * 身分一樣只活在 sessionStorage 的 SESSION_KEY，存 { classId, no, code }，
 * 理由跟檔頭那一段一模一樣：網址參數等於沒驗，localStorage 會留給下一個借手機的人。
 */

const gasState = {
  api: null,
  classes: [],
  classId: null,
  /** 最近一次 api.me() 的回應。只是畫面材料，不是通行證——每次重新整理都要重打一次。 */
  me: null,
  view: 'me',
  gateErr: '',
};

/** 目前這個班的身分。換班不把身分帶過去，跟本機版 verifiedStudent() 的 classId 檢查同義。 */
function gasIdentity() {
  const id = state.identity;
  if (!id || id.classId !== gasState.classId) return null;
  if (!id.no || !id.code) return null;
  return { classId: id.classId, no: id.no, code: id.code };
}

/**
 * 後端訊息優先。
 *
 * 403 的「座號跟代碼對不起來，再確認一次。」與 409 的「點數不夠，還差 N 點。」
 * 都是後端算完才知道的事，前端自己改寫只會講出跟事實不一樣的話——
 * 而且 403 那句刻意不分「沒這個人」與「碼打錯」，前端一細分就等於
 * 送同學一支代碼探測器。所以這裡原句照搬，只有真的沒訊息才用備援字串。
 */
export function gasErrorText(err, fallback = '連線出了點狀況，等一下再試一次。') {
  const msg = err && typeof err.message === 'string' ? err.message.trim() : '';
  return msg || fallback;
}

/**
 * 個人成長的數字。
 *
 * balance 一律用後端那一個數字，不從 events 加總——這是 Public.gs 紅線 3。
 * events 只用來數正向次數與畫長條圖；後端送來的本來就只有正向、未撤銷的事件，
 * 這裡再篩一次 kind === 'positive' 是為了讓「畫出非正向資料」在前端也無路可走。
 */
export function gasStats(me) {
  const positives = (me?.events || []).filter((e) => e.kind === 'positive');
  return {
    balance: Number(me?.balance) || 0,
    positiveCount: positives.length,
    positiveTotal: positives.reduce((s, e) => s + (Number(e.delta) || 0), 0),
    pendingCount: (me?.pending || []).length,
  };
}

/**
 * 商店單一品項的按鈕狀態。前端先擋只是省一次來回，**真正的守門在後端**：
 * 按鈕是 DOM，DOM 改得動；gas/Public.gs 的 publicRedeemRequest 才是那道門。
 * 所以這裡擋掉的每一種情況，後端都會再擋一次並回 409。
 */
export function gasRewardState(reward, balance) {
  const out = reward.stock !== null && reward.stock !== undefined && reward.stock <= 0;
  if (out) return { disabled: true, note: '已被換完' };
  const lack = reward.cost - balance;
  if (lack > 0) return { disabled: true, note: `還差 ${lack} 點` };
  return { disabled: false, note: '' };
}

/**
 * 把座號＋代碼送去後端驗，順便把個人頁的資料一起拿回來。
 *
 * 「驗身分」與「拿資料」是同一次呼叫，不是先驗再拿——分成兩次的話，
 * 中間那個「已通過」的狀態就會變成前端的通行證。回 { ok, me } 或 { ok: false, message }。
 */
export async function gasSubmitGate(api, identity) {
  try {
    const me = await api.me({ classId: identity.classId, no: identity.no, code: identity.code });
    return { ok: true, me };
  } catch (err) {
    return { ok: false, message: gasErrorText(err) };
  }
}

/**
 * 送出兌換申請。代碼跟著這一次請求一起送——後端每次都重驗，
 * 前端這邊就不需要（也不該）記得「這個人剛剛驗過了」。
 * 409 是點數不夠或已被換完，訊息用後端原句：差幾點只有後端算得準。
 */
export async function gasSubmitRedeem(api, identity, rewardId) {
  try {
    const r = await api.redeemRequest({
      classId: identity.classId,
      no: identity.no,
      code: identity.code,
      rewardId,
    });
    return { ok: true, message: `已送出「${r?.name || '獎勵'}」的兌換申請，等老師核可。` };
  } catch (err) {
    return { ok: false, message: gasErrorText(err) };
  }
}

// ---------- GAS 模式的畫面 ----------

async function initGas() {
  let mod;
  try {
    mod = await import('./store-public.js');
    gasState.api = mod.createPublicClient();
  } catch (err) {
    console.error('[student] 公開端 client 載入失敗', err);
    $('#rankTable').innerHTML = '';
    showToast('連不上公開端，請跟老師確認網址設定。');
    return;
  }

  // 班級榜整個下線：分頁按鈕與內容都拿掉，不留一個「按了會 410」的入口。
  $$('.tab').forEach((t) => { if (t.dataset.view === 'rank') t.hidden = true; });
  const rankView = $('#view-rank');
  if (rankView) {
    rankView.classList.remove('is-active');
    rankView.innerHTML = `
      <div class="view-head"><div>
        <h2>班級排行已停用</h2>
        <p class="hint">就算不寫姓名，座號配上分數還是認得出是誰，所以這一頁不再對外顯示。</p>
      </div></div>`;
  }

  try {
    gasState.classes = await gasState.api.classes();
  } catch (err) {
    showToast(gasErrorText(err));
    return;
  }
  gasState.classId = gasState.classes[0]?.id || null;
  state.identity = loadIdentity();

  const sel = $('#classSelect');
  sel.innerHTML = gasState.classes.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  sel.value = gasState.classId;

  bindGas();
  switchGasView('me');
}

function bindGas() {
  $('#classSelect').addEventListener('change', (e) => {
    gasState.classId = e.target.value;
    gasState.gateErr = '';
    refreshGas();
  });
  $$('.tab').forEach((t) => t.addEventListener('click', () => switchGasView(t.dataset.view)));
  $('#shopList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-redeem]');
    if (btn && !btn.disabled) gasRedeem(btn.dataset.redeem);
  });
}

function switchGasView(view) {
  gasState.view = view;
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${view}`));
  refreshGas();
}

/**
 * 每次要顯示東西，就把代碼再送一次。
 *
 * 這是本機版 verifiedStudent()「每次都重驗」在這條線上的等價作法。
 * 後端回 403 就把身分丟掉（老師剛重發代碼、或有人手改 sessionStorage 都會走到這裡），
 * 閘門立刻關回去，而且顯示的是後端那一句，不是我們自己編的。
 */
async function refreshGas() {
  const ident = gasIdentity();
  if (!ident) {
    gasState.me = null;
    renderGas();
    return;
  }
  const r = await gasSubmitGate(gasState.api, ident);
  if (r.ok) {
    gasState.me = r.me;
    gasState.gateErr = '';
  } else {
    saveIdentity(null);
    gasState.me = null;
    gasState.gateErr = r.message;
  }
  renderGas();
}

function renderGas() {
  if (gasState.view === 'me') renderGasMe();
  if (gasState.view === 'shop') renderGasShop();
}

/*
 * GAS 版的閘門。只有兩格：自己填座號、填個人代碼。
 * 沒有座號下拉——下拉要先有名冊，而前端拿不到名冊，也不該拿。
 */
function gasGateHtml(host) {
  return `
    <div class="gate">
      <h3>先確認一下是你本人</h3>
      <p class="hint">
        填自己的座號，再打老師發給你的個人代碼。
        代碼只有你自己知道，別人就沒辦法用你的名義看你的分數、換你的點數。
        忘記了就跟老師講，老師可以重發一組。
      </p>
      <form class="gate-form" id="${host}Form">
        <label>座號
          <input id="${host}No" type="text" inputmode="numeric" maxlength="3"
                 autocomplete="off" placeholder="例如 13" aria-label="自己的座號">
        </label>
        <label>個人代碼
          <input id="${host}Code" class="gate-code" type="text" inputmode="numeric"
                 maxlength="6" autocomplete="off" placeholder="••••" aria-label="個人代碼">
        </label>
        <button class="btn btn-primary" type="submit">進入</button>
      </form>
      ${gasState.gateErr ? `<p class="gate-err">${esc(gasState.gateErr)}</p>` : ''}
    </div>`;
}

/** 回傳目前這一頁能不能往下畫（也就是後端認了這組座號＋代碼）。 */
function renderGasGate(host) {
  const gateBox = $(`#${host}Gate`);
  const content = $(`#${host}Content`);
  const me = gasState.me;

  if (me) {
    // 姓名不在試算表裡（docs/gas-contract.md 鐵則 2），後端只給「N號」這個 label。
    gateBox.innerHTML = `
      <div class="gate-who">
        <span>目前是</span>
        <span class="who-name">${esc(me.student?.label || `${me.student?.no}號`)}</span>
        <button class="btn btn-ghost btn-sm" id="${host}Leave">不是我／換人</button>
      </div>`;
    content.hidden = false;
    $(`#${host}Leave`).addEventListener('click', () => {
      saveIdentity(null);
      gasState.me = null;
      gasState.gateErr = '';
      renderGas();
    });
    return true;
  }

  // 沒通過就整包不畫——不是先算好再遮住。
  gateBox.innerHTML = gasGateHtml(host);
  content.hidden = true;
  $(`#${host}Form`).addEventListener('submit', (e) => {
    e.preventDefault();
    const no = $(`#${host}No`).value.trim();
    const code = $(`#${host}Code`).value;
    if (!no) {
      gasState.gateErr = '請先填自己的座號。';
      renderGas();
      return;
    }
    saveIdentity({ classId: gasState.classId, no, code });
    refreshGas();
  });
  return false;
}

function renderGasMe() {
  if (!renderGasGate('me')) {
    $('#meTitle').textContent = '個人成長';
    return;
  }
  const me = gasState.me;
  const s = gasStats(me);

  $('#meTitle').textContent = `${me.student?.label || ''} 的成長`;
  $('#meStats').innerHTML = `
    <div class="stat"><div class="k">淨分餘額</div><div class="v">${signed(s.balance)}</div></div>
    <div class="stat"><div class="k">正向次數</div><div class="v">${s.positiveCount}</div></div>
    <div class="stat"><div class="k">累積正向分數</div><div class="v">+${s.positiveTotal}</div></div>
    <div class="stat"><div class="k">申請中</div><div class="v">${s.pendingCount}</div></div>`;

  const positives = (me.events || []).filter((e) => e.kind === 'positive');
  const buckets = weeklyPositive(positives, me.student.id, 6);
  const max = Math.max(1, ...buckets.map((b) => b.value));
  $('#meChart').innerHTML = buckets.map((b) => `
    <div class="stu-col">
      <div class="stu-val">${b.value || ''}</div>
      <div class="stu-bar" style="height:${(b.value / max) * 100}%"></div>
      <div class="tlabel">${b.label}</div>
    </div>`).join('');

  // 後端的 behaviors 已經只有正向卡，查不到就用中性字樣，不去猜是哪一張。
  const labelFor = (id) => {
    const b = (me.behaviors || []).find((x) => x.id === id);
    return b ? `${b.icon} ${b.label}` : '正向表現';
  };
  const recs = [...positives].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 12);
  $('#meRecords').innerHTML = recs.length
    ? recs.map((e) => {
        const d = new Date(e.ts);
        const ts = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        return `<li>
          <span class="t">${ts}</span>
          <span>${esc(labelFor(e.behaviorId))}</span>
          <span class="d pos">+${e.delta}</span>
        </li>`;
      }).join('')
    : '<li>還沒有正向紀錄，繼續加油。</li>';
}

function renderGasShop() {
  if (!renderGasGate('shop')) return;
  const me = gasState.me;
  const balance = gasStats(me).balance;

  $('#shopBalance').innerHTML = `${esc(me.student?.label || '')}　目前淨分 <strong>${balance}</strong> 點。`;

  const pending = me.pending || [];
  $('#shopPending').innerHTML = pending.length
    ? `<div class="panel"><h3>申請中（等老師核可）</h3><ul class="timeline">${
        pending.map((p) => `<li><span class="t">${new Date(p.ts).toLocaleDateString('zh-TW')}</span><span>${esc(p.name || '獎勵')}</span><span class="d">待核可</span></li>`).join('')
      }</ul></div>`
    : '';

  /*
   * 品項清單只認後端隨 me 送來的 rewards。
   *
   * ⚠️ 目前 gas/Public.gs 的 publicMe() 還沒有這一欄（公開端沒有 rewards 路由），
   * 所以在後端補上之前，這一頁會顯示空狀態。這是刻意的：前端沒有獎勵表，
   * 也不拿 shop-core.js 的 DEFAULT_REWARDS 頂替——定價與上下架是老師改的東西，
   * 顯示一份猜的清單，只會讓學生按下去才發現換不到。
   */
  const active = (me.rewards || []).filter((r) => r.active);
  if (!active.length) {
    $('#shopList').innerHTML = '<p class="empty">目前沒有可以兌換的品項。</p>';
    return;
  }

  $('#shopList').innerHTML = active.map((r) => {
    const st = gasRewardState(r, balance);
    const stockText = (r.stock === null || r.stock === undefined) ? '不限量' : `剩 ${r.stock} 份`;
    return `
      <div class="stu-reward">
        <div class="stu-reward-head">
          <span class="stu-reward-name">${esc(r.name)}</span>
          <span class="stu-cost">${r.cost} 點</span>
        </div>
        <div class="stu-reward-meta">${stockText}</div>
        <button class="btn btn-primary btn-sm" data-redeem="${esc(r.id)}" ${st.disabled ? 'disabled' : ''}>申請兌換</button>
        ${st.note ? `<p class="stu-lack">${esc(st.note)}</p>` : ''}
      </div>`;
  }).join('');
}

async function gasRedeem(rewardId) {
  const ident = gasIdentity();
  if (!ident) {
    showToast('身分已經過期，請重新輸入你的個人代碼。');
    renderGas();
    return;
  }
  const r = await gasSubmitRedeem(gasState.api, ident, rewardId);
  showToast(r.message);
  // 成功與否都重新拉一次：後端才知道現在的餘額、庫存與申請中清單長什麼樣。
  await refreshGas();
}

/*
 * node 直接 import 這個檔案（測試用）時不要自己跑起來——
 * 上面那些純函式要能單獨驗，不能被一個 document is not defined 擋在門外。
 */
if (typeof document !== 'undefined') init();
