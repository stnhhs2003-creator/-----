/*
 * 家長端（GAS 那條線）的門：班級 + 座號 + 家長代碼。
 *
 * 這一組守的是三句話：
 *   1. 認不出來的時候，畫面上出現的是**後端那一句**，不是前端自己編的分類。
 *      分開講「沒這個座號」「碼打錯」等於送人一支代碼探測器（gas/Public.gs 檔頭）。
 *   2. 家長代碼**不進網址**，也不進 localStorage——只在這個分頁的 sessionStorage。
 *   3. 畫面上的每一筆紀錄都還是走 rules.js 的 parentView()，前端不自己挑事件。
 *
 * 這個 repo 沒有 jsdom，所以下面自己搭一個夠用的假 DOM：innerHTML 只當字串存，
 * getElementById 從那串字裡認 id。測得到的是「渲染出來的 HTML 內容」與
 * 「按鈕按下去之後發生什麼事」，測不到真正的排版——排版本來也不是這組要守的東西。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/** gas/Public.gs 的 PARENT_DENY，一個字都不能不一樣。 */
const PARENT_DENY = '座號跟家長代碼對不起來，再確認一次。';

// ───────────────────────── 假 DOM ─────────────────────────

function makeElement(id) {
  const listeners = [];
  return {
    id,
    value: '',
    textContent: '',
    focus() {},
    addEventListener(type, fn) {
      if (type === 'click') listeners.push(fn);
    },
    async click() {
      for (const fn of [...listeners]) await fn();
    },
  };
}

function makeDom() {
  let html = '';
  let live = new Map();
  const root = {
    get innerHTML() {
      return html;
    },
    set innerHTML(next) {
      // 真的 DOM 一寫 innerHTML，舊節點連同 listener 一起消失；這裡照做，
      // 不然「重畫表單之後按鈕還能按」這種假通過會漏掉。
      html = String(next);
      live = new Map();
    },
  };
  return {
    root,
    el(id) {
      if (id === 'parentRoot') return root;
      if (!html.includes(`id="${id}"`)) return null;
      if (!live.has(id)) live.set(id, makeElement(id));
      return live.get(id);
    },
  };
}

/** 把假 DOM／假 sessionStorage 裝上去，然後載入 parent.js（只載一次，之後重設狀態）。 */
async function loadParentModule() {
  const dom = makeDom();
  const bag = new Map();
  const session = {
    getItem: (k) => (bag.has(k) ? bag.get(k) : null),
    setItem: (k, v) => bag.set(k, String(v)),
    removeItem: (k) => bag.delete(k),
  };
  globalThis.document = { getElementById: (id) => dom.el(id), title: '' };
  globalThis.sessionStorage = session;
  globalThis.localStorage = {
    getItem: () => null,
    setItem() {
      throw new Error('家長端不准寫 localStorage');
    },
    removeItem() {},
  };
  globalThis.location = { href: 'https://example.test/parent.html', search: '' };
  const mod = await import('../js/parent.js');
  return { mod, dom, session, bag };
}

const { mod, dom, bag } = await loadParentModule();

function reset() {
  bag.clear();
  dom.root.innerHTML = '';
}

// ───────────────────────── 假後端 ─────────────────────────

const CLASSES = [
  { id: 'c701', name: '七年一班' },
  { id: 'c703', name: '七年三班' },
];

/** 後端只送正向、未撤銷的事件——所以這裡的 fixture 也只有正向的。 */
const VIEW = {
  cls: { id: 'c701', name: '七年一班' },
  student: { id: 'c701-s13', no: 13, label: '您的孩子（13號）' },
  behaviors: [
    { id: 'b1', label: '主動幫忙', icon: '🤝', kind: 'positive', delta: 1 },
    { id: 'b2', label: '認真發表', icon: '🗣', kind: 'positive', delta: 2 },
  ],
  events: [
    { id: 'e1', ts: new Date().toISOString(), classId: 'c701', studentId: 'c701-s13', behaviorId: 'b1', delta: 1, kind: 'positive' },
    { id: 'e2', ts: new Date().toISOString(), classId: 'c701', studentId: 'c701-s13', behaviorId: 'b1', delta: 1, kind: 'positive' },
    { id: 'e3', ts: new Date().toISOString(), classId: 'c701', studentId: 'c701-s13', behaviorId: 'b2', delta: 2, kind: 'positive' },
  ],
};

class FakePublicStoreError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'PublicStoreError';
    this.status = status;
  }
}

/** 只有 (c701, 13, k7m2npqr) 這組過得去，其餘一律同一句、同一個狀態。 */
function fakeApi(overrides = {}) {
  const calls = [];
  return {
    calls,
    async classes() {
      return CLASSES;
    },
    async parentView(spec) {
      calls.push(spec);
      if (overrides.parentView) return overrides.parentView(spec);
      if (spec.classId === 'c701' && String(spec.no) === '13' && spec.code === 'k7m2npqr') {
        return VIEW;
      }
      throw new FakePublicStoreError(PARENT_DENY, 403);
    },
  };
}

async function submit({ classId = 'c701', no = '13', code = 'k7m2npqr' } = {}) {
  dom.el('pgClass').value = classId;
  dom.el('pgNo').value = no;
  dom.el('pgCode').value = code;
  await dom.el('pgSend').click();
}

// ───────────────────────── 純函式 ─────────────────────────

test('backendMessage：後端說什麼就顯示什麼，不改寫也不細分', () => {
  const denied = new FakePublicStoreError(PARENT_DENY, 403);
  assert.equal(mod.backendMessage(denied), PARENT_DENY);
});

test('backendMessage：連不上後端的時候用不帶任何孩子資訊的 fallback', () => {
  assert.equal(mod.backendMessage(new TypeError('fetch failed')), '送不出去，請等一下再試一次。');
  assert.equal(mod.backendMessage(null), '送不出去，請等一下再試一次。');
});

test('身分只認完整的三件組，缺一件就當沒存過', () => {
  reset();
  mod.saveParentIdentity({ classId: 'c701', no: '13' });
  assert.equal(mod.loadParentIdentity(), null);
  mod.saveParentIdentity({ classId: 'c701', no: '13', code: 'k7m2npqr' });
  assert.deepEqual(mod.loadParentIdentity(), { classId: 'c701', no: '13', code: 'k7m2npqr' });
  mod.saveParentIdentity(null);
  assert.equal(mod.loadParentIdentity(), null);
});

// ───────────────────────── 畫面 ─────────────────────────

test('第一次進來看到的是班級 + 座號 + 家長代碼的表單', async () => {
  reset();
  await mod.gasMain(fakeApi());
  assert.match(dom.root.innerHTML, /id="pgClass"/);
  assert.match(dom.root.innerHTML, /id="pgNo"/);
  assert.match(dom.root.innerHTML, /id="pgCode"/);
  assert.ok(dom.root.innerHTML.includes('七年一班'), '班級沒有從 api.classes() 帶進來');
});

test('代碼對不上時，顯示的是後端那一句，不是前端自己編的理由', async () => {
  reset();
  await mod.gasMain(fakeApi());
  await submit({ code: '00000000' });

  assert.ok(dom.root.innerHTML.includes(PARENT_DENY), '沒有把後端那句話原樣顯示出來');
  for (const leak of ['沒有這個座號', '找不到這位學生', '代碼錯誤', '這位學生不參與']) {
    assert.ok(!dom.root.innerHTML.includes(leak), `把失敗原因分開講了：${leak}`);
  }
  assert.match(dom.root.innerHTML, /id="pgSend"/, '打錯之後表單要留著讓家長重打');
  assert.equal(mod.loadParentIdentity(), null, '沒過的身分不該留在 sessionStorage');
});

test('打錯一次之後還能再送出（重畫表單有重掛事件）', async () => {
  reset();
  const api = fakeApi();
  await mod.gasMain(api);
  await submit({ code: '00000000' });
  await submit();
  assert.equal(api.calls.length, 2, '第二次按下去沒有打到後端＝listener 掉了');
  assert.ok(dom.root.innerHTML.includes('的成長紀錄'));
});

test('代碼不進網址、不進 localStorage，只留在這個分頁的 sessionStorage', async () => {
  reset();
  await mod.gasMain(fakeApi());
  await submit();

  assert.equal(globalThis.location.search, '', '動到網址了');
  assert.ok(!globalThis.location.href.includes('k7m2npqr'), '代碼跑到網址上了');
  assert.ok(!dom.root.innerHTML.includes('k7m2npqr'), '代碼被畫回畫面上了');
  assert.equal(
    bag.get('cp:parent-identity'),
    JSON.stringify({ classId: 'c701', no: '13', code: 'k7m2npqr' }),
  );
  // localStorage 的 setItem 在這組測試裡會直接 throw，跑到這裡就代表沒人碰過它。
});

test('重整同一個分頁不用重打，但代碼每一次都送回後端重驗', async () => {
  reset();
  const first = fakeApi();
  await mod.gasMain(first);
  await submit();

  const again = fakeApi();
  await mod.gasMain(again);
  assert.deepEqual(again.calls, [{ classId: 'c701', no: '13', code: 'k7m2npqr' }]);
  assert.ok(again.calls.length === 1, '重整之後沒有重新驗一次');
  assert.ok(dom.root.innerHTML.includes('的成長紀錄'), '重整之後沒有直接顯示紀錄');
});

test('老師把代碼換掉之後，記著的身分會被擋下來並要求重打', async () => {
  reset();
  await mod.gasMain(fakeApi());
  await submit();

  // 同一組身分，但後端這次不認了。
  const revoked = fakeApi({
    parentView() {
      throw new FakePublicStoreError(PARENT_DENY, 403);
    },
  });
  await mod.gasMain(revoked);
  assert.ok(dom.root.innerHTML.includes(PARENT_DENY));
  assert.match(dom.root.innerHTML, /id="pgCode"/);
  assert.equal(mod.loadParentIdentity(), null);
});

test('報表用的是後端給的稱呼，前端不捏造姓名', async () => {
  reset();
  await mod.gasMain(fakeApi());
  await submit();
  assert.ok(dom.root.innerHTML.includes('您的孩子（13號） 的成長紀錄'));
  assert.ok(!dom.root.innerHTML.includes('undefined'), 'student.name 不存在時漏出 undefined');
});

test('分數與亮點來自 rules.js 的 parentView()，不是前端另外算的', async () => {
  reset();
  await mod.gasMain(fakeApi());
  await submit();
  const html = dom.root.innerHTML;
  assert.ok(html.includes('<div class="v">4</div>'), '累積鼓勵分數應為 1+1+2＝4');
  assert.ok(html.includes('3 <span class="unit">次</span>'), '次數應為 3');
  assert.ok(html.includes('主動幫忙'), '最常出現的亮點沒算對');
});

// ───────────────────────── 原始碼層的紅線 ─────────────────────────

test('parent.js 不在前端挑事件的 kind、也不自己加總', async () => {
  const src = await readFile(new URL('../js/parent.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/kind\s*===\s*'positive'/.test(code), '前端自己判 kind 了＝閘門變兩個');
  assert.ok(!/\.voided/.test(code), '前端自己判 voided 了');
  assert.ok(!/localStorage/.test(code), '家長身分不准寫 localStorage');
  assert.ok(!/searchParams\.set\(\s*['"]code/.test(code), '代碼跑進網址了');
  assert.ok(!/searchParams\.set\(\s*['"]no/.test(code), '座號跑進網址了');
});
