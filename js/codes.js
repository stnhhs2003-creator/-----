/*
 * 個人代碼：學生端身分驗證的唯一依據，以及老師端的代碼後台。
 *
 * ── 為什麼要有這個東西 ──
 * 學生端原本是「班級下拉 ＋ 學生下拉」：選誰就看得到誰。個資盤點把它列為未修缺口——
 * 隔壁同學順手把下拉拉到你的名字，就看得到你的點數餘額、個人成長，還能用你的名義
 * 去商店送兌換申請。
 *
 * ── 這條線要擋的分界（很重要，不要弄反）──
 *   班級榜      已停用。座號與分數仍是可識別的學生表現資料。
 *   個人成長    要代碼。這是「這個人」的資料。
 *   點數餘額    要代碼。
 *   商店申請    要代碼。用別人的名義送申請，等於替別人花掉點數。
 *
 * ── 這不是密碼，不要當密碼做 ──
 * 它擋的是「隔壁同學順手點開」，不是入侵。所以刻意不做：
 *   不雜湊（老師要看得到、要唸得出來、要印得出來）
 *   不鎖定重試（國一生打錯三次就被鎖在外面，隔天全班圍著老師解鎖）
 *   不假裝它安全（真正的機密防線是雲端那層的 Google 登入 + 伺服器端投影）
 * 但也因為它擋的是同學，所以「全班代碼一次印在畫面上」是自打嘴巴——
 * 這一頁預設遮起來，列印要另外開一頁，由老師主動按。
 *
 * ── 存在哪 ──
 * 存在 classes 這份 doc 的 student 物件上（`code: '4821'`）。
 * 不動 db/schema.sql：那是主線保留檔案，而且代碼跟著名冊走本來就對——
 * 名冊怎麼同步到雲端，代碼就怎麼跟著走，不必再多一張表去對不起來。
 *
 * 這個檔案上半段是純函式（沒有任何 import、不碰 DOM），
 * 所以瀏覽器、node 測試、Cloudflare Worker 三邊共用同一份比對邏輯——
 * 前端一份、後端另一份的話，遲早會有一邊改了另一邊沒改。
 * 下半段才是老師端 codes.html 的頁面程式，只在瀏覽器裡跑。
 */

// ───────────────────────── 純函式層 ─────────────────────────

export const CODE_LENGTH = 4;

/**
 * 正規化。全形數字轉半形、去掉所有空白。
 * 理由跟家長通過碼那支一樣：學生是從老師發的紙條上照打的，
 * 為了一個看不見的空白把人擋在門外，只會讓老師下課被圍住。
 */
export function normalizeCode(v) {
  return String(v ?? '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s/g, '');
}

/** 代碼比對。空的期望值一律不通過——沒發代碼不等於誰都可以進。 */
export function codeMatches(input, expected) {
  const a = normalizeCode(input);
  const b = normalizeCode(expected);
  return !!b && a === b;
}

/**
 * 產一組 4 位數代碼。
 *
 * 一律走亂數，而且刻意「不」從座號、生日、學號推導：那種碼同學第一次就猜中，
 * 等於沒做。taken 是同班已用掉的碼，同一班內不重複——不然兩個人的代碼撞在一起，
 * 打誰的碼都能進誰的頁面。
 */
export function randomCode(taken = new Set()) {
  const pick = () => {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return String(buf[0] % 10000).padStart(CODE_LENGTH, '0');
  };
  // 一班幾十人、碼池一萬組，撞碼機率極低；上限只是保證迴圈一定會停。
  for (let i = 0; i < 200; i++) {
    const code = pick();
    if (!taken.has(code)) return code;
  }
  throw new Error('這一班的代碼快用完了，請改用更長的代碼。');
}

/*
 * ───────── 家長個人代碼（GAS 版才用得到）─────────
 *
 * 為什麼不沿用 4 位數：學生代碼擋的是「隔壁同學順手點開」，那條線上還有一層
 * ——同學得先坐在教室裡、得先知道你的座號。家長端不一樣，Apps Script 的
 * `/exec` 是一個誰都打得到的公開網址，4 位數只有一萬組，一支腳本幾分鐘掃完，
 * 掃到的是一個孩子完整的正向紀錄。所以這一組刻意做得長、做得不好猜。
 *
 * 字元集刻意拿掉 i l o 0 1 與所有大寫：家長是從聯絡簿上照打的，
 * 「l 還是 1」這種問題會直接變成老師的電話。
 */
export const PARENT_CODE_LENGTH = 8;
const PARENT_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** 家長代碼的正規化。大小寫不計較、空白與連字號一律去掉。 */
export function normalizeParentCode(v) {
  return String(v ?? '').toLowerCase().replace(/[\s-]/g, '');
}

/** 家長代碼比對。跟學生代碼一樣：空的期望值一律不通過。 */
export function parentCodeMatches(input, expected) {
  const a = normalizeParentCode(input);
  const b = normalizeParentCode(expected);
  return !!b && a === b;
}

/** 產一組家長代碼。taken 是同班已用掉的，避免兩位家長的碼撞在一起。 */
export function randomParentCode(taken = new Set()) {
  const pick = () => {
    const buf = new Uint32Array(PARENT_CODE_LENGTH);
    crypto.getRandomValues(buf);
    return Array.from(buf, (n) => PARENT_ALPHABET[n % PARENT_ALPHABET.length]).join('');
  };
  for (let i = 0; i < 200; i++) {
    const code = pick();
    if (!taken.has(code)) return code;
  }
  throw new Error('家長代碼產生失敗，請重試。');
}

/** 這一班已經用掉的家長代碼。 */
export function usedParentCodes(cls, exceptStudentId = null) {
  const set = new Set();
  for (const s of cls?.students || []) {
    if (s.id === exceptStudentId) continue;
    const c = normalizeParentCode(s.parentCode);
    if (c) set.add(c);
  }
  return set;
}

/** 補發某一位的家長代碼。 */
export function reissueParentOne(cls, studentId) {
  const taken = usedParentCodes(cls, studentId);
  return {
    ...cls,
    students: (cls.students || []).map((s) =>
      s.id === studentId ? { ...s, parentCode: randomParentCode(taken) } : s
    ),
  };
}

/**
 * 補齊缺家長代碼的人。
 *
 * 跟 ensureCodes 分開兩支、而不是合成一支：學生代碼是本機版就要用的東西，
 * 家長代碼只有 GAS 版用得到。合在一起的話，本機模式的老師每開一次這一頁，
 * 就被塞一整班永遠用不到的碼進名冊，還跟著同步上雲。
 */
export function ensureParentCodes(classes) {
  let added = 0;
  const next = (classes || []).map((cls) => {
    const taken = usedParentCodes(cls);
    let touched = 0;
    const students = (cls.students || []).map((s) => {
      if (normalizeParentCode(s.parentCode)) return s;
      const code = randomParentCode(taken);
      taken.add(code);
      touched++;
      return { ...s, parentCode: code };
    });
    added += touched;
    return touched ? { ...cls, students } : cls;
  });
  return { classes: added ? next : classes, added };
}

/** 這一班已經用掉的代碼。 */
export function usedCodes(cls, exceptStudentId = null) {
  const set = new Set();
  for (const s of cls?.students || []) {
    if (s.id === exceptStudentId) continue;
    const c = normalizeCode(s.code);
    if (c) set.add(c);
  }
  return set;
}

/**
 * 補發某一位學生的代碼。回傳新的 students 陣列（不就地改參數）。
 */
export function reissueOne(cls, studentId) {
  const taken = usedCodes(cls, studentId);
  return {
    ...cls,
    students: (cls.students || []).map((s) =>
      s.id === studentId ? { ...s, code: randomCode(taken) } : s
    ),
  };
}

/** 整班重發。全部打掉重來，逐一發、逐一登記，確保班內不重複。 */
export function reissueClass(cls) {
  const taken = new Set();
  return {
    ...cls,
    students: (cls.students || []).map((s) => {
      const code = randomCode(taken);
      taken.add(code);
      return { ...s, code };
    }),
  };
}

/**
 * 補齊缺代碼的人。
 *
 * 舊的 localStorage 是在還沒有這個欄位的時候寫的，讀出來每個人都沒有 code。
 * 這種情況要「自動補發」而不是壞掉——一整班學生打不開個人頁，
 * 老師隔天早自習就得處理三十個人來問，那比漏洞還糟。
 * 已經有代碼的人不動：補發應該是老師的動作，不是每次開頁面就換一次。
 *
 * 回傳 { classes, added }；added 是這次補發了幾個人，0 代表不必存檔。
 */
export function ensureCodes(classes) {
  let added = 0;
  const next = (classes || []).map((cls) => {
    const taken = usedCodes(cls);
    let touched = 0;
    const students = (cls.students || []).map((s) => {
      if (normalizeCode(s.code)) return s;
      const code = randomCode(taken);
      taken.add(code);
      touched++;
      return { ...s, code };
    });
    added += touched;
    return touched ? { ...cls, students } : cls;
  });
  return { classes: added ? next : classes, added };
}

/**
 * 驗證：在指定班級裡，找到「這位學生」而且「代碼對得上」。
 *
 * 學生可以用 studentId 或座號 no 指名自己（前端用 id、後端也吃 no），
 * 但指名本身不給任何東西——一定要 code 對上才回得到人。
 * 對不上就回 null，而且不區分「沒這個人」與「碼打錯」：
 * 分開講等於送同學一支座號探測器。
 */
export function findStudentByCode(classes, { classId, studentId, no, code } = {}) {
  for (const cls of classes || []) {
    if (classId && cls.id !== classId) continue;
    for (const s of cls.students || []) {
      const named = studentId ? s.id === studentId : String(s.no) === String(no ?? '').trim();
      if (!named) continue;
      return codeMatches(code, s.code) ? { cls, student: s } : null;
    }
  }
  return null;
}

// ───────────────────────── 老師端頁面（codes.html）─────────────────────────

const root = typeof document !== 'undefined' ? document.getElementById('codesRoot') : null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const state = {
  store: null,
  classes: [],
  classId: null,
  // GAS 版才需要家長代碼。由 config.js 的 STORE_BACKEND 決定，不是使用者選項。
  parentMode: false,
  // 哪幾位的代碼「暫時」顯示出來。刻意不做「全部顯示」：
  // 老師常常是在講台上開著這一頁的，一整面代碼等於發給全班看。
  revealed: new Set(),
  msg: '',
};

function currentClass() {
  return state.classes.find((c) => c.id === state.classId) || state.classes[0] || null;
}

async function saveClasses(classes) {
  state.classes = classes;
  await state.store.saveClasses(classes);
}

function rowsHtml(cls) {
  return (cls.students || []).map((s) => {
    const shown = state.revealed.has(s.id);
    // 家長代碼那一欄只在 GAS 版出現。本機版與 Cloudflare 版的家長端走的是
    // Google 登入＋老師核可，多一欄用不到的碼只會讓老師以為自己漏發了東西。
    const parentCell = state.parentMode
      ? `<td class="code-cell">${shown ? `<span class="code code-long">${esc(s.parentCode || '—')}</span>` : '<span class="code masked">••••••••</span>'}</td>`
      : '';
    return `
      <tr>
        <td class="num">${esc(s.no)}</td>
        <td>${esc(s.name)}</td>
        <td class="code-cell">${shown ? `<span class="code">${esc(s.code || '—')}</span>` : '<span class="code masked">••••</span>'}</td>
        ${parentCell}
        <td class="acts">
          <button class="btn btn-ghost btn-sm" data-reveal="${esc(s.id)}">${shown ? '遮起來' : '顯示'}</button>
          <button class="btn btn-ghost btn-sm" data-reissue="${esc(s.id)}">重發</button>
          ${state.parentMode ? `<button class="btn btn-ghost btn-sm" data-reissue-parent="${esc(s.id)}">重發家長碼</button>` : ''}
        </td>
      </tr>`;
  }).join('');
}

function render() {
  const cls = currentClass();
  if (!cls) {
    root.innerHTML = '<div class="panel"><p class="empty">還沒有班級。請先到「班級名冊」建立班級。</p></div>';
    return;
  }

  root.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h3>${esc(cls.name)} 的個人代碼</h3>
        <span class="hint">${(cls.students || []).length} 人</span>
      </div>
      <p class="hint panel-hint">
        每位學生一組 4 位數代碼，學生在學生端選了自己的座號之後要打這組碼，
        才看得到自己的個人成長與點數餘額、才申請得了兌換。班級榜不需要代碼，
        那本來就是全班一起看的東西。
      </p>
      <p class="notice">
        代碼預設遮起來，要看哪一位就按那一列的「顯示」——這一頁常常是開在講台的螢幕上，
        一整面代碼等於發給全班看，那就跟原本的下拉選單一樣沒防到人。
      </p>
      <div class="codes-acts">
        <button id="printAll" class="btn btn-primary">列印整班（一張紙剪開發）</button>
        <button id="reissueAll" class="btn btn-ghost">整班重發</button>
      </div>
      ${state.msg ? `<p class="hint" id="codesMsg">${esc(state.msg)}</p>` : ''}
      <div class="logtable">
        <table>
          <thead><tr><th class="num">座號</th><th>姓名</th><th>學生代碼</th>${state.parentMode ? '<th>家長代碼</th>' : ''}<th class="col-act">操作</th></tr></thead>
          <tbody>${rowsHtml(cls)}</tbody>
        </table>
      </div>
    </div>

    <div class="panel">
      <h3>發下去之後</h3>
      <p class="hint panel-hint">
        代碼不是密碼，別當密碼保管：它擋的是「隔壁同學順手點開」，不是入侵。
        所以不必要求學生背起來、不會鎖帳號、打錯就再打一次。
        真的傳開了就按「重發」換一組，舊的立刻失效。
      </p>
    </div>`;
  wire();
}

/**
 * 列印頁另開一個視窗。
 *
 * 刻意不做成「在這一頁展開全班代碼再列印」：那一瞬間全班代碼就攤在講台螢幕上了。
 * 另開視窗＝老師主動、在自己看得到的地方按下去，關掉就沒了。
 */
function printSlips(cls) {
  const win = window.open('', '_blank');
  if (!win) {
    state.msg = '瀏覽器擋掉了新視窗，請允許這個網站開新視窗再按一次。';
    render();
    return;
  }
  const slips = (cls.students || []).map((s) => `
    <div class="slip">
      <div class="slip-cls">${esc(cls.name)}</div>
      <div class="slip-name">${esc(s.no)}號　${esc(s.name)}</div>
      <div class="slip-code">${esc(s.code || '—')}</div>
      <div class="slip-note">學生端選好自己的座號後輸入這組碼，就看得到自己的成長與點數。</div>
      ${state.parentMode ? `
      <div class="slip-parent">
        <div class="slip-parent-label">家長代碼（給家長，不要給學生）</div>
        <div class="slip-parent-code">${esc(s.parentCode || '—')}</div>
      </div>` : ''}
    </div>`).join('');

  win.document.write(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
    <title>${esc(cls.name)} 個人代碼</title>
    <style>
      body { font-family: system-ui, "Noto Sans TC", sans-serif; margin: 12mm; }
      h1 { font-size: 16pt; margin: 0 0 6mm; }
      .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4mm; }
      .slip { border: 1px dashed #999; border-radius: 3mm; padding: 4mm; text-align: center; }
      .slip-cls { font-size: 9pt; color: #666; }
      .slip-name { font-size: 12pt; margin: 1mm 0 2mm; }
      .slip-code { font-size: 22pt; font-weight: 700; letter-spacing: .18em; }
      .slip-note { font-size: 7.5pt; color: #666; margin-top: 2mm; line-height: 1.4; }
      .slip-parent { border-top: 1px dashed #ccc; margin-top: 2.5mm; padding-top: 2mm; }
      .slip-parent-label { font-size: 7pt; color: #666; }
      .slip-parent-code { font-size: 13pt; font-weight: 700; letter-spacing: .1em; font-family: ui-monospace, monospace; }
      @media print { .tip { display: none; } }
    </style></head><body>
    <h1>${esc(cls.name)}　個人代碼</h1>
    <p class="tip">沿虛線剪開，一人一張發下去。這一頁不要貼在公布欄。</p>
    <div class="grid">${slips}</div>
    </body></html>`);
  win.document.close();
  win.focus();
  win.print();
}

function wire() {
  document.getElementById('printAll')?.addEventListener('click', () => printSlips(currentClass()));

  document.getElementById('reissueAll')?.addEventListener('click', async () => {
    const cls = currentClass();
    if (!confirm(`確定要重發「${cls.name}」全班的代碼嗎？舊的代碼會立刻失效，要重新發一次給學生。`)) return;
    await saveClasses(state.classes.map((c) => (c.id === cls.id ? reissueClass(c) : c)));
    state.revealed.clear();
    state.msg = '整班重發完成。記得按「列印整班」印一份新的發下去，舊的碼已經失效。';
    render();
  });

  root.querySelectorAll('[data-reveal]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.reveal;
      if (state.revealed.has(id)) state.revealed.delete(id);
      else state.revealed.add(id);
      render();
    });
  });

  root.querySelectorAll('[data-reissue-parent]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.reissueParent;
      const cls = currentClass();
      const stu = (cls.students || []).find((s) => s.id === id);
      if (!confirm(`確定要重發「${stu.name}」的家長代碼嗎？舊的立刻失效，家長要重新拿一次。`)) return;
      await saveClasses(state.classes.map((c) => (c.id === cls.id ? reissueParentOne(c, id) : c)));
      state.revealed.add(id);
      state.msg = `${stu.name} 的家長代碼已經重發，記得單獨通知家長新的碼。`;
      render();
    });
  });

  root.querySelectorAll('[data-reissue]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.reissue;
      const cls = currentClass();
      const stu = (cls.students || []).find((s) => s.id === id);
      if (!confirm(`確定要重發「${stu.name}」的代碼嗎？舊的立刻失效。`)) return;
      await saveClasses(state.classes.map((c) => (c.id === cls.id ? reissueOne(c, id) : c)));
      state.revealed.add(id); // 剛重發的這一組直接顯示，不然老師還要多按一次才抄得到
      state.msg = `${stu.name} 的代碼已經重發，記得單獨告訴他新的碼。`;
      render();
    });
  });
}

function renderClassSelect() {
  const sel = document.getElementById('classSelect');
  if (!sel) return;
  sel.innerHTML = state.classes.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  sel.value = state.classId;
  sel.addEventListener('change', (e) => {
    state.classId = e.target.value;
    state.revealed.clear();
    state.msg = '';
    render();
  });
}

async function main() {
  // 動態載入，讓這個檔案的純函式層在 node 測試與 Worker 裡都 import 得動。
  const [{ store }, { SEED }, { STORE_BACKEND }] = await Promise.all([
    import('./store-select.js'),
    import('./data.js'),
    import('./config.js'),
  ]);
  state.store = store;
  state.parentMode = STORE_BACKEND === 'gas';
  await store.init(SEED);

  const loaded = await store.getClasses();
  const step1 = ensureCodes(loaded);
  // 家長代碼只有 GAS 版才補；本機版補了也用不到，還會跟著名冊一路存下去。
  const step2 = state.parentMode ? ensureParentCodes(step1.classes) : { classes: step1.classes, added: 0 };
  const { classes } = step2;
  if (step1.added || step2.added) {
    await saveClasses(classes);
    const bits = [];
    if (step1.added) bits.push(`${step1.added} 位學生還沒有代碼`);
    if (step2.added) bits.push(`${step2.added} 位還沒有家長代碼`);
    state.msg = `有 ${bits.join('、')}，已經自動補發。`;
  } else {
    state.classes = classes;
  }

  state.classId = state.classes[0]?.id || null;
  renderClassSelect();
  render();
}

if (root) main();
