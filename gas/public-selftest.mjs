/*
 * gas/Public.gs 的離線驗證腳本（S2 名下）。
 *
 *   node gas/public-selftest.mjs
 *
 * ── 為什麼要有這個東西 ──
 * Apps Script 只能在 Google 的伺服器上跑，push 上去點一點「看起來對」
 * 不構成驗證——尤其這條線上的三條紅線，錯了不會噴錯，只會安靜地多送一些
 * 不該送的資料出去。所以這裡用假的 SpreadsheetApp 把真的 Store.gs 與
 * 真的 Public.gs 一起載進 Node，實際跑過每一條路由，
 * 然後**逐條證明紅線**：不是「應該不會漏」，是把回應整包字串抓出來搜。
 *
 * 載的是真的 Store.gs（S1 名下，本腳本只讀不改）而不是自己寫一份假的儲存層：
 * 假的儲存層驗不出「Public.gs 對 Store.gs 的用法有沒有錯」。
 *
 * 這支刻意不進 tests/（不吃 node --test），因為它載的是 .gs 而不是 ESM 模組，
 * 而且它是「部署前的一次性證明」，不是回歸測試。npm test 不受影響。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const read = (f) => readFileSync(HERE + f, 'utf8');

// ───────────────────────── 假的 Apps Script 執行環境 ─────────────────────────

function makeSheet(rows) {
  const data = rows.map((r) => [...r]);
  const clone = () => data.map((r) => [...r]);
  return {
    _rows: data,
    getDataRange: () => ({ getValues: clone }),
    getLastRow: () => data.length,
    appendRow: (r) => data.push([...r]),
    setFrozenRows: () => {},
    getRange(row, col, numRows, numCols) {
      return {
        getValues: () =>
          data.slice(row - 1, row - 1 + numRows).map((r) => r.slice(col - 1, col - 1 + numCols)),
        setValues: (vals) => {
          vals.forEach((line, i) => {
            line.forEach((v, j) => {
              data[row - 1 + i][col - 1 + j] = v;
            });
          });
        },
      };
    },
  };
}

const EVENT_HEADER = [
  'id', 'ts', 'classId', 'studentId', 'behaviorId',
  'delta', 'kind', 'period', 'note', 'voided', 'voidedAt',
];

const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();

/*
 * 假資料。
 *
 * 兩個刻意埋的陷阱：
 *   · 13 號身上放了一個 name 欄位。鐵則第 2 條說姓名不該在試算表裡，
 *     但「不該在」不等於「一定不在」（老師手動貼過一次名冊就有了）。
 *     Public.gs 必須逐欄挑欄位，所以就算欄位在，也一個字都不會回出去。
 *   · 13 號有一筆 improve（帶著一句很敏感的備註）與一筆已撤銷的正向事件。
 *     這兩筆是紅線的靶。
 */
const CLASSES = [
  {
    id: 'c701',
    name: '七年一班',
    students: [
      { id: 'c701-s5', no: 5, code: '4821', parentCode: 'k7m2q9rp', optOut: { since: iso(30) } },
      { id: 'c701-s6', no: 6, code: '7390', parentCode: 'w4n8tz3b' },
      { id: 'c701-s13', no: 13, code: '1122', parentCode: 'h9j5vx2c', name: '洪語彤' },
    ],
  },
  { id: 'c702', name: '七年二班', students: [{ id: 'c702-s1', no: 1, code: '5555' }] },
];

const BEHAVIORS = [
  { id: 'b-speak', label: '主動發言', icon: '🙋', kind: 'positive', delta: 2 },
  { id: 'b-help', label: '幫助同學', icon: '🤝', kind: 'positive', delta: 3 },
  { id: 'b-late', label: '上課吃東西', icon: '🍞', kind: 'improve', delta: -2 },
];

const REWARDS = [
  { id: 'r-lunch', name: '午餐優先排隊券', cost: 2, stock: 20, active: true },
  { id: 'r-book', name: '圖書館特權卡', cost: 50, stock: 5, active: true },
  { id: 'r-old', name: '已下架的舊獎勵', cost: 1, stock: 3, active: false },
];

const EVENTS = [
  ['e1', iso(3), 'c701', 'c701-s13', 'b-speak', 2, 'positive', '第二節', '', 0, ''],
  ['e2', iso(2), 'c701', 'c701-s13', 'b-help', 3, 'positive', '第四節', '', 0, ''],
  ['e3', iso(2), 'c701', 'c701-s13', 'b-late', -2, 'improve', '第五節', '午休吃麵包被登記', 0, ''],
  ['e4', iso(1), 'c701', 'c701-s13', 'b-speak', 4, 'positive', '第一節', '', 1, iso(0)],
  ['e5', iso(4), 'c701', 'c701-s6', 'b-speak', 1, 'positive', '第三節', '', 0, ''],
  ['e6', iso(5), 'c701', 'c701-s5', 'b-speak', 9, 'positive', '第一節', '', 0, ''],
];

const SHEETS = {
  docs: makeSheet([
    ['name', 'json', 'updatedAt'],
    ['classes', JSON.stringify(CLASSES), iso(0)],
    ['behaviors', JSON.stringify(BEHAVIORS), iso(0)],
    ['rewards', JSON.stringify(REWARDS), iso(0)],
    ['settings', JSON.stringify({ term: '114-1' }), iso(0)],
  ]),
  events: makeSheet([EVENT_HEADER, ...EVENTS]),
};

const SpreadsheetApp = {
  getActiveSpreadsheet: () => ({
    getSheetByName: (n) => SHEETS[n] || null,
    insertSheet: (n) => (SHEETS[n] = makeSheet([])),
  }),
  openById: () => SpreadsheetApp.getActiveSpreadsheet(),
};

const PropertiesService = { getScriptProperties: () => ({ getProperty: () => null }) };
const LockService = {
  // 獨立專案在真實環境拿不到文件鎖（回 null），見 gas/Store.gs 的 withLock 檔頭。
  getDocumentLock: () => null,
  getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }),
};
let uidSeq = 0;
const Utilities = { getUuid: () => `fake-uuid-${++uidSeq}`.padEnd(20, '0') };
const ContentService = {
  MimeType: { JSON: 'application/json' },
  createTextOutput: (s) => ({ _s: s, setMimeType: () => ({ getContent: () => s }) }),
};

// ───────────────────────── 把真的 .gs 載進來 ─────────────────────────

const load = new Function(
  'SpreadsheetApp', 'PropertiesService', 'LockService', 'Utilities', 'ContentService',
  `${read('Store.gs')}\n${read('Public.gs')}\nreturn { doGet: doGet, doPost: doPost };`,
);
const { doGet, doPost } = load(
  SpreadsheetApp, PropertiesService, LockService, Utilities, ContentService,
);

const GET = (op, parameter = {}) =>
  JSON.parse(doGet({ parameter: { op, ...parameter } }).getContent());
const POST = (op, payload = {}) =>
  JSON.parse(doPost({ postData: { contents: JSON.stringify({ op, payload }) } }).getContent());

// ───────────────────────── 斷言 ─────────────────────────

let failed = 0;
function ok(cond, label, detail = '') {
  if (cond) {
    console.log(`  ✔ ${label}`);
  } else {
    failed++;
    console.log(`  ✘ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}
const show = (label, v) => console.log(`  ${label} ${JSON.stringify(v)}`);
const head = (s) => console.log(`\n── ${s} ──`);

/** 一段回應裡不得出現的東西：姓名、待改進、備註、代碼、已撤銷那一筆。 */
const FORBIDDEN = [
  ['姓名「洪語彤」', '洪語彤'],
  ['待改進行為卡 b-late', 'b-late'],
  ['待改進的行為卡名稱', '上課吃東西'],
  ['待改進事件的備註', '午休吃麵包被登記'],
  ['已撤銷的那一筆事件 e4', '"e4"'],
  ['improve 這個字', 'improve'],
  ['學生個人代碼 1122', '1122'],
  ['家長個人代碼 h9j5vx2c', 'h9j5vx2c'],
];

function assertClean(label, payload) {
  const s = JSON.stringify(payload);
  FORBIDDEN.forEach(([what, needle]) => {
    ok(!s.includes(needle), `${label}：沒有${what}`, `實際回應：${s}`);
  });
}

/*
 * 只看 kind 欄位驗不夠：投影那一段是把 kind 寫死成 'positive' 送出去的，
 * 所以萬一 filter 被放寬，待改進事件會**頂著 positive 的名義**漏出來。
 * 抓得住它的是 delta——正向事件的 delta 一定大於 0。
 */
function assertAllPositive(label, events) {
  ok(events.every((e) => e.kind === 'positive' && e.voided === false),
    `${label}：每一筆都標成 positive 且未撤銷`);
  ok(events.every((e) => Number(e.delta) > 0),
    `${label}：每一筆的 delta 都大於 0（沒有頂著 positive 名義的扣分）`,
    `實際：${JSON.stringify(events.map((e) => [e.behaviorId, e.delta]))}`);
}

// ═════════════════════════ 1. 公開路由 ═════════════════════════

head('1. 公開路由（不需要代碼）');
const health = GET('health');
show('health   ', health);
const classes = GET('classes');
show('classes  ', classes);
ok(!JSON.stringify(classes).includes('students'), '班級清單不帶任何學生');

/*
 * 公開班級榜已永久停用：即使不含姓名，座號配上淨分仍然指認得出人。
 * 這裡要驗的不是「榜長什麼樣」，是「它不會再回任何一列」——
 * 哪天有人把 publicRank 接回去，這兩條就會紅。
 */
const rank = GET('rank', { classId: 'c701' });
show('rank     ', rank);
ok(rank.ok === false && rank.status === 410, 'rank 一律回 410 停用');
ok(rank.result === undefined && !JSON.stringify(rank).includes('c701-s13'),
  'rank 沒有夾帶任何一列學生資料');

const badClass = GET('rank', { classId: 'c999' });
show('rank(壞班)', badClass);
ok(badClass.ok === false && badClass.status === 410,
  '壞班級也是同一句 410——停用的路由不該順便告訴外人哪個班存在');

// ═════════════════════════ 2. 學生端 /me ═════════════════════════

head('2. 學生端 me（要學生個人代碼）');
const me = POST('me', { classId: 'c701', no: 13, code: '1122' });
console.log(`  回應：${JSON.stringify(me, null, 2).split('\n').join('\n  ')}`);

ok(me.ok === true, '代碼正確，認得出人');
ok(me.result.balance === 3, `balance 是 3（一個數字，不是逐筆）：實際 ${me.result.balance}`);
ok(me.result.events.length === 2, '只回兩筆正向未撤銷事件');
assertAllPositive('學生端 me', me.result.events);
ok(me.result.events.reduce((s, e) => s + e.delta, 0) === 5,
  '逐筆事件加起來是 5，但 balance 是 3——扣分只反映在總分，明細沒送出去');
ok(me.result.events.every((e) => e.studentId === 'c701-s13'),
  '沒有任何一筆是別人的事件');
ok(me.result.events.every((e) => !('note' in e)), '事件裡沒有備註欄位');
ok(!JSON.stringify(me.result).includes('c701-s6'), '沒有別人的資料（6 號）');
ok(me.result.behaviors.every((b) => b.kind === 'positive'),
  '行為卡清單也只有正向的，前端沒有東西可以畫錯');
ok(me.result.student.label === '13號', `學生只顯示座號：${me.result.student.label}`);
assertClean('學生端 me', me.result);

/*
 * 商店品項跟著 me 一起送。
 *
 * 學生端沒有別的路由拿得到獎勵表，前端也刻意不拿 DEFAULT_REWARDS 頂替——
 * 定價與上下架是老師改的東西，猜一份出來只會讓學生按了才發現換不到。
 * 下架的品項要在後端就篩掉：留在回應裡，前端只要漏了一個 filter 就會畫出來。
 */
ok(Array.isArray(me.result.rewards), 'me 回獎勵清單');
ok(me.result.rewards.length === 2, `只有上架中的兩項：實際 ${me.result.rewards.length}`);
ok(!JSON.stringify(me.result.rewards).includes('已下架的舊獎勵'),
  '下架的品項在後端就篩掉了，沒送到前端');
ok(me.result.rewards.every((r) => r.active === true), '送出去的每一項都是上架中');
ok(me.result.rewards.every((r) => Object.keys(r).sort().join() === 'active,cost,id,name,stock'),
  '每一項只有 id/name/cost/stock/active 五個欄位',
  JSON.stringify(me.result.rewards[0]));

head('2b. 學生端認不出來時，三種情況回同一句話');
const meWrongCode = POST('me', { classId: 'c701', no: 13, code: '9999' });
const meNoSuchNo = POST('me', { classId: 'c701', no: 99, code: '1122' });
const meOptedOut = POST('me', { classId: 'c701', no: 5, code: '4821' });
console.log(`  碼打錯          ${JSON.stringify(meWrongCode)}`);
console.log(`  沒這個座號      ${JSON.stringify(meNoSuchNo)}`);
console.log(`  不參與記錄(碼對) ${JSON.stringify(meOptedOut)}`);
const meAll = [meWrongCode, meNoSuchNo, meOptedOut].map((r) => JSON.stringify(r));
ok(new Set(meAll).size === 1, '三種失敗的回應一字不差完全相同', meAll.join('\n      '));
ok(meWrongCode.status === 403, '狀態碼也一樣是 403');

head('2c. 全形數字與空白照樣進得去（家長學生都是複製貼上來的）');
const meFullWidth = POST('me', { classId: 'c701', no: 13, code: ' １１２２ ' });
ok(meFullWidth.ok === true, '全形＋前後空白的代碼正規化後通過');

// ═════════════════════════ 3. 兌換申請 ═════════════════════════

head('3. 兌換申請（要學生個人代碼，唯一的寫入路徑）');
const rowsBefore = SHEETS.events._rows.length;
const buy = POST('redeem-request', {
  classId: 'c701', no: 13, code: '1122', rewardId: 'r-lunch',
});
show('換 2 點的券', buy);
ok(buy.ok === true, '餘額 3 換 2 點的獎勵：成功');
ok(SHEETS.events._rows.length === rowsBefore + 1, '事件表真的多了一列');
const appended = SHEETS.events._rows[SHEETS.events._rows.length - 1];
show('落盤那一列', appended);
ok(appended[6] === 'redeem-request' && Number(appended[5]) === 0,
  'kind 是 redeem-request 而且 delta 是 0（真正扣點在老師端核可時）');

const buyAgain = POST('redeem-request', {
  classId: 'c701', no: 13, code: '1122', rewardId: 'r-lunch',
});
show('再換一次    ', buyAgain);
ok(buyAgain.ok === false && buyAgain.status === 409,
  '可動用點數 = 3 − 已送出的 2 = 1，不夠再換一張：擋下來');
ok(SHEETS.events._rows.length === rowsBefore + 1, '被擋下來的那次沒有寫進事件表');

const buyRich = POST('redeem-request', {
  classId: 'c701', no: 13, code: '1122', rewardId: 'r-book',
});
show('換 50 點的  ', buyRich);
ok(buyRich.ok === false && buyRich.error.includes('還差'), '點數不夠有講差幾點');

const buyOld = POST('redeem-request', {
  classId: 'c701', no: 13, code: '1122', rewardId: 'r-old',
});
show('換下架的    ', buyOld);
ok(buyOld.ok === false && buyOld.status === 404, '已下架的獎勵換不了');

head('3b. 兌換申請認不出來時，三種情況回同一句話');
const rqWrongCode = POST('redeem-request', { classId: 'c701', no: 13, code: '9999', rewardId: 'r-lunch' });
const rqNoSuchNo = POST('redeem-request', { classId: 'c701', no: 99, code: '1122', rewardId: 'r-lunch' });
const rqOptedOut = POST('redeem-request', { classId: 'c701', no: 5, code: '4821', rewardId: 'r-lunch' });
console.log(`  碼打錯          ${JSON.stringify(rqWrongCode)}`);
console.log(`  沒這個座號      ${JSON.stringify(rqNoSuchNo)}`);
console.log(`  不參與記錄(碼對) ${JSON.stringify(rqOptedOut)}`);
const rqAll = [rqWrongCode, rqNoSuchNo, rqOptedOut].map((r) => JSON.stringify(r));
ok(new Set(rqAll).size === 1, '三種失敗的回應一字不差完全相同', rqAll.join('\n      '));
ok(SHEETS.events._rows.length === rowsBefore + 1, '三次失敗都沒有寫進事件表');

// ═════════════════════════ 4. 家長端 ═════════════════════════

head('4. 家長端 parent-view（要家長個人代碼）');
const pv = POST('parent-view', { classId: 'c701', no: 13, code: 'h9j5vx2c' });
console.log(`  回應：${JSON.stringify(pv, null, 2).split('\n').join('\n  ')}`);

ok(pv.ok === true, '家長代碼正確，認得出孩子');
ok(pv.result.events.length === 2, '只回兩筆正向未撤銷事件');
assertAllPositive('家長端 parent-view', pv.result.events);
ok(pv.result.events.every((e) => e.studentId === 'c701-s13'), '沒有別的孩子的事件');
ok(!('balance' in pv.result), '家長端連餘額都不給（那是學生端與商店的事）');
ok(pv.result.student.label === '您的孩子（13號）',
  `家長端顯示：${pv.result.student.label}`);
assertClean('家長端 parent-view', pv.result);

head('4b. 家長端認不出來時，三種情況回同一句話');
const pvWrongCode = POST('parent-view', { classId: 'c701', no: 13, code: 'zzzzzzzz' });
const pvNoSuchNo = POST('parent-view', { classId: 'c701', no: 99, code: 'h9j5vx2c' });
const pvOptedOut = POST('parent-view', { classId: 'c701', no: 5, code: 'k7m2q9rp' });
console.log(`  碼打錯          ${JSON.stringify(pvWrongCode)}`);
console.log(`  沒這個座號      ${JSON.stringify(pvNoSuchNo)}`);
console.log(`  不參與記錄(碼對) ${JSON.stringify(pvOptedOut)}`);
const pvAll = [pvWrongCode, pvNoSuchNo, pvOptedOut].map((r) => JSON.stringify(r));
ok(new Set(pvAll).size === 1, '三種失敗的回應一字不差完全相同', pvAll.join('\n      '));

head('4c. 沒發家長代碼的學生，家長端進不去（空的期望值一律不通過）');
const pvNoCode = POST('parent-view', { classId: 'c702', no: 1, code: '' });
show('二班 1 號   ', pvNoCode);
ok(pvNoCode.ok === false, '名冊上沒有 parentCode 的學生，任何輸入都認不出來');

// ═════════════════════════ 5. 兩組代碼不可互換 ═════════════════════════

head('5. 家長代碼與學生代碼是兩組，不可互換');
const crossA = POST('parent-view', { classId: 'c701', no: 13, code: '1122' });
const crossB = POST('me', { classId: 'c701', no: 13, code: 'h9j5vx2c' });
show('學生碼打家長端', crossA);
show('家長碼打學生端', crossB);
ok(crossA.ok === false, '拿學生代碼打家長端：不給');
ok(crossB.ok === false, '拿家長代碼打學生端：不給（家長換不掉孩子的點數）');

// ═════════════════════════ 6. 路由分界 ═════════════════════════

head('6. 路由分界：帶代碼的一律不走 GET');
const meViaGet = GET('me', { classId: 'c701', no: 13, code: '1122' });
show('GET me     ', meViaGet);
ok(meViaGet.ok === false && meViaGet.status === 404,
  '代碼不進 query string（會留在瀏覽器歷史、截圖、執行紀錄裡）');
const rankViaPost = POST('rank', { classId: 'c701' });
show('POST rank  ', rankViaPost);
ok(rankViaPost.ok === false, '讀的路由不走 POST');
const bogus = POST('purgeStudent', { classId: 'c701', studentId: 'c701-s13' });
show('POST purge ', bogus);
ok(bogus.ok === false && bogus.status === 404,
  'Code.gs 的管理 op 打不到（這份部署根本沒有那些函式，也不在白名單裡）');

// ═════════════════════════ 結果 ═════════════════════════

console.log(`\n${failed === 0 ? '全部通過。' : `有 ${failed} 項沒過。`}`);
process.exit(failed === 0 ? 0 : 1);
