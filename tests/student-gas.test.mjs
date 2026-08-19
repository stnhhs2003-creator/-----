/*
 * 學生端 GAS 模式（公開端 Apps Script）的測試。
 *
 * 這一組守的是四句話：
 *   1. 餘額用後端送來的那個數字，前端不自己加總——加總等於要求後端把待改進
 *      明細一起送出來（gas/Public.gs 紅線 3）。
 *   2. 個人代碼只在請求 body 裡，不進網址、不進 localStorage。
 *   3. 403／409 顯示後端原句。403 刻意不分「沒這個人」與「碼打錯」，
 *      前端一細分就是送同學一支代碼探測器；409 差幾點只有後端算得準。
 *   4. gas 模式不去打 rank——後端固定回 410，打了只是白等一個註定失敗的請求。
 *
 * 純函式直接測；要 DOM 的部分改成靜態檢查原始碼（跟 student-gate 那組同一招）。
 * js/store-public.js 由另一位同事負責，這裡一律注入 fake，不碰真的網路。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { gasStats, gasErrorText, gasRewardState, gasSubmitGate, gasSubmitRedeem } from '../js/student.js';

const STUDENT_JS = readFileSync(new URL('../js/student.js', import.meta.url), 'utf8');
/** 註解裡會提到 rank、localStorage 這些字，所以要驗的是去掉註解之後的程式碼。 */
const CODE = STUDENT_JS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const IDENT = { classId: 'c701', no: '13', code: '4821' };

/** 後端錯誤的形狀：訊息 ＋ status（契約上的 PublicStoreError）。 */
class FakeError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** 記下每一次呼叫，才驗得出「代碼有送出去」與「rank 沒被打到」。 */
function fakeApi(handlers = {}) {
  const calls = [];
  const wrap = (name, fn) => async (payload) => {
    calls.push({ name, payload });
    if (!fn) throw new Error(`不該呼叫 ${name}`);
    return fn(payload);
  };
  return {
    calls,
    classes: wrap('classes', handlers.classes),
    me: wrap('me', handlers.me),
    redeemRequest: wrap('redeemRequest', handlers.redeemRequest),
    rank: wrap('rank', handlers.rank),
  };
}

// ───────────────────── 餘額：後端的數字才算數 ─────────────────────

test('餘額用後端的 balance，不是拿 events 自己加總', () => {
  /*
   * 後端 balance 是 5（正向 9 減掉待改進 4 之後的淨分）。
   * events 只有正向那三筆——前端加總會得到 9，也就是把「被扣過分」這件事抹掉，
   * 更糟的是這種畫法需要後端把待改進明細送出來才算得對。
   */
  const me = {
    balance: 5,
    events: [
      { id: 'e1', ts: '2026-08-10T01:00:00.000Z', behaviorId: 'b-speak', delta: 3, kind: 'positive' },
      { id: 'e2', ts: '2026-08-11T01:00:00.000Z', behaviorId: 'b-help', delta: 4, kind: 'positive' },
      { id: 'e3', ts: '2026-08-12T01:00:00.000Z', behaviorId: 'b-speak', delta: 2, kind: 'positive' },
    ],
    pending: [],
  };
  const s = gasStats(me);
  assert.equal(s.balance, 5, '餘額要等於後端給的數字');
  assert.notEqual(s.balance, 9, '不可以是 events 的加總');
  assert.equal(s.positiveCount, 3);
  assert.equal(s.positiveTotal, 9, '「累積正向分數」是另一個數字，跟餘額不是同一件事');
});

test('後端萬一混進非正向的事件，也不會被算進正向統計', () => {
  const s = gasStats({
    balance: 1,
    events: [
      { id: 'e1', ts: '2026-08-10T01:00:00.000Z', delta: 3, kind: 'positive' },
      { id: 'e2', ts: '2026-08-10T02:00:00.000Z', delta: -2, kind: 'improve' },
    ],
  });
  assert.equal(s.positiveCount, 1);
  assert.equal(s.positiveTotal, 3);
  assert.equal(s.balance, 1);
});

test('me 是空的也不能炸掉，餘額當 0', () => {
  const s = gasStats(null);
  assert.deepEqual(s, { balance: 0, positiveCount: 0, positiveTotal: 0, pendingCount: 0 });
});

// ───────────────────── 403／409：顯示後端原句 ─────────────────────

test('403 顯示後端那一句，前端不自己細分「沒這個人／碼打錯」', async () => {
  const api = fakeApi({
    me: () => { throw new FakeError('座號跟代碼對不起來，再確認一次。', 403); },
  });
  const r = await gasSubmitGate(api, IDENT);
  assert.equal(r.ok, false);
  assert.equal(r.message, '座號跟代碼對不起來，再確認一次。');
  assert.equal(/沒這個|不存在|代碼錯/.test(r.message), false, '不得自己改寫成更細的說法');
});

test('409 點數不夠：差幾點用後端算的，不是前端估的', async () => {
  const api = fakeApi({
    redeemRequest: () => { throw new FakeError('點數不夠，還差 7 點。', 409); },
  });
  const r = await gasSubmitRedeem(api, IDENT, 'r-song');
  assert.equal(r.ok, false);
  assert.equal(r.message, '點數不夠，還差 7 點。');
});

test('409 已被換完：一樣照抄後端的話', async () => {
  const api = fakeApi({
    redeemRequest: () => { throw new FakeError('這項獎勵已經被換完了。', 409); },
  });
  const r = await gasSubmitRedeem(api, IDENT, 'r-seat');
  assert.equal(r.message, '這項獎勵已經被換完了。');
});

test('後端連訊息都沒有時才用備援字串', () => {
  assert.equal(gasErrorText(new Error('')), '連線出了點狀況，等一下再試一次。');
  assert.equal(gasErrorText(undefined), '連線出了點狀況，等一下再試一次。');
  assert.equal(gasErrorText(new Error('這項獎勵已經下架了。')), '這項獎勵已經下架了。');
});

// ───────────────────── 每次操作都把代碼送給後端 ─────────────────────

test('查個人頁與送兌換都把座號＋代碼一起送出去，不靠前端記住「驗過了」', async () => {
  const api = fakeApi({
    me: () => ({ balance: 10, events: [], pending: [] }),
    redeemRequest: () => ({ ok: true, name: '班級點歌' }),
  });
  await gasSubmitGate(api, IDENT);
  await gasSubmitRedeem(api, IDENT, 'r-song');

  assert.deepEqual(api.calls.map((c) => c.name), ['me', 'redeemRequest']);
  api.calls.forEach((c) => {
    assert.equal(c.payload.code, '4821', '每一次請求都要帶代碼');
    assert.equal(c.payload.no, '13');
    assert.equal(c.payload.classId, 'c701');
  });
  assert.equal(api.calls[1].payload.rewardId, 'r-song');
});

test('兌換成功回的是後端給的品項名稱', async () => {
  const api = fakeApi({ redeemRequest: () => ({ ok: true, name: '免作業券' }) });
  const r = await gasSubmitRedeem(api, IDENT, 'r-nohw');
  assert.equal(r.ok, true);
  assert.match(r.message, /免作業券/);
});

// ───────────────────── 商店按鈕：前端先擋，後端才是門 ─────────────────────

test('點數不夠與已換完的品項按不下去', () => {
  assert.deepEqual(gasRewardState({ id: 'r1', cost: 12, stock: null }, 5), { disabled: true, note: '還差 7 點' });
  assert.deepEqual(gasRewardState({ id: 'r2', cost: 8, stock: 0 }, 99), { disabled: true, note: '已被換完' });
  assert.deepEqual(gasRewardState({ id: 'r3', cost: 8, stock: 3 }, 8), { disabled: false, note: '' });
  assert.deepEqual(gasRewardState({ id: 'r4', cost: 8, stock: undefined }, 8), { disabled: false, note: '' });
});

// ───────────────────── 靜態檢查：不該存在的東西 ─────────────────────

test('gas 模式不打班級榜——後端固定回 410', () => {
  const used = new Set([...CODE.matchAll(/\bapi\.(\w+)\s*\(/g)].map((m) => m[1]));
  used.delete('calls');
  assert.deepEqual([...used].sort(), ['classes', 'me', 'redeemRequest'],
    '公開端只准打這三條');
  assert.equal(/rank\s*\(\s*\{/.test(CODE), false, '不得呼叫 rank');
  // 而且那個分頁要被藏起來，不留一個按了會 410 的入口。
  assert.match(CODE, /dataset\.view === 'rank'\) t\.hidden = true/);
  assert.match(STUDENT_JS, /班級排行已停用/);
});

test('個人代碼不進網址、不進 localStorage', () => {
  assert.equal(/location\.(search|hash)/.test(CODE), false);
  assert.equal(/URLSearchParams/.test(CODE), false);
  assert.equal(/localStorage/.test(CODE), false, '身分只能放 sessionStorage');
  assert.match(CODE, /sessionStorage/);
});

test('gas 閘門只有兩個輸入框，沒有把名冊攤開來的座號下拉', () => {
  const gate = CODE.slice(CODE.indexOf('function gasGateHtml'));
  const body = gate.slice(0, gate.indexOf('\n}\n'));
  assert.equal(/<select/.test(body), false, 'gas 模式拿不到名冊，也不該生下拉');
  assert.match(body, /id="\$\{host\}No"[\s\S]*?type="text"/);
  assert.match(body, /id="\$\{host\}Code"/);
});
