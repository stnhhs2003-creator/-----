/*
 * gas/selftest.mjs — 離線自測
 *
 * Apps Script 不能在本機跑，所以這裡用假的 SpreadsheetApp／LockService／
 * PropertiesService／Session／Utilities 把 Store.gs 與 Code.gs 載進 Node 的 vm，
 * 實際跑一遍主要路徑。這是不部署就能證明它會動的唯一辦法。
 *
 *   node gas/selftest.mjs
 *
 * 不掛在 npm test 上（那是前端的 331 項），這支是 GAS 端專用。
 */

import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// ---- 假試算表 ----

function makeSheet(name) {
  const rows = []; // 二維陣列，含表頭

  const rangeOf = (r, c, nr, nc) => ({
    getValues() {
      const out = [];
      for (let i = 0; i < nr; i++) {
        const src = rows[r - 1 + i] || [];
        const line = [];
        for (let j = 0; j < nc; j++) line.push(src[c - 1 + j] === undefined ? '' : src[c - 1 + j]);
        out.push(line);
      }
      return out;
    },
    setValues(values) {
      values.forEach((line, i) => {
        const target = r - 1 + i;
        while (rows.length <= target) rows.push([]);
        line.forEach((v, j) => {
          rows[target][c - 1 + j] = v;
        });
      });
      return this;
    },
  });

  return {
    _name: name,
    _rows: rows,
    getName: () => name,
    appendRow(row) {
      rows.push(row.slice());
      return this;
    },
    setFrozenRows() {
      return this;
    },
    getLastRow: () => rows.length,
    getDataRange: () => {
      const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
      return rangeOf(1, 1, rows.length, width);
    },
    getRange: (r, c, nr = 1, nc = 1) => rangeOf(r, c, nr, nc),
    deleteRow(r) {
      rows.splice(r - 1, 1);
      return this;
    },
    deleteRows(start, count) {
      rows.splice(start - 1, count);
      return this;
    },
  };
}

function makeBook() {
  const sheets = new Map();
  return {
    getSheetByName: (n) => sheets.get(n) || null,
    insertSheet(n) {
      const sh = makeSheet(n);
      sheets.set(n, sh);
      return sh;
    },
    _sheets: sheets,
  };
}

const activeBook = makeBook();
let lockHeld = 0;
let uuidCounter = 0;
let clock = Date.parse('2026-08-15T01:00:00.000Z');

// ---- 假的身分驗證環境（gas/Auth.gs 用）----

const CLIENT_ID = '1234.apps.googleusercontent.com';
const TEACHER = 'teacher@example.com';
const SCRIPT_PROPS = { GOOGLE_CLIENT_ID: CLIENT_ID, TEACHER_EMAIL: TEACHER };

/** 假的 tokeninfo 回應表。key 就是 token 字串。查不到的一律當成 Google 說「不認識」。 */
const TOKENINFO = {
  好token: { aud: CLIENT_ID, iss: 'https://accounts.google.com', email: TEACHER, email_verified: 'true', exp: Math.floor(Date.now() / 1000) + 3600 },
  別人的: { aud: CLIENT_ID, iss: 'https://accounts.google.com', email: 'someone@gmail.com', email_verified: 'true', exp: Math.floor(Date.now() / 1000) + 3600 },
  別的應用程式: { aud: '9999.apps.googleusercontent.com', iss: 'https://accounts.google.com', email: TEACHER, email_verified: 'true', exp: Math.floor(Date.now() / 1000) + 3600 },
  未驗證信箱: { aud: CLIENT_ID, iss: 'https://accounts.google.com', email: TEACHER, email_verified: 'false', exp: Math.floor(Date.now() / 1000) + 3600 },
};

let tokeninfoCalls = 0;
const cacheStore = new Map();

const sandbox = {
  console,
  SpreadsheetApp: {
    getActiveSpreadsheet: () => activeBook,
    openById: () => activeBook,
  },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: (k) => (Object.prototype.hasOwnProperty.call(SCRIPT_PROPS, k) ? SCRIPT_PROPS[k] : null),
    }),
  },
  CacheService: {
    getScriptCache: () => ({
      get: (k) => (cacheStore.has(k) ? cacheStore.get(k) : null),
      put: (k, v) => cacheStore.set(k, v),
    }),
  },
  UrlFetchApp: {
    fetch(url) {
      tokeninfoCalls++;
      const token = decodeURIComponent(String(url).split('id_token=')[1] || '');
      const info = TOKENINFO[token];
      return {
        getResponseCode: () => (info ? 200 : 400),
        getContentText: () => JSON.stringify(info || { error: 'invalid_token' }),
      };
    },
  },
  LockService: {
    // 獨立（standalone）專案拿不到文件鎖，真實環境回的是 null，不是一把鎖。
    // 假環境照著回 null，是為了讓「用錯 API」在這裡就爆，而不是上線才爆——
    // 這個坑真的踩過一次，見 gas/Store.gs 的 withLock 檔頭。
    getDocumentLock: () => null,
    getScriptLock: () => ({
      tryLock() {
        lockHeld++;
        return true;
      },
      releaseLock() {
        lockHeld--;
      },
    }),
  },
  Session: {
    getEffectiveUser: () => ({ getEmail: () => 'teacher@example.com' }),
  },
  Utilities: {
    getUuid: () => `00000000-0000-0000-0000-${String(++uuidCounter).padStart(12, '0')}`,
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' },
    // 這裡不需要真的雜湊，只需要「同一枚 token 對到同一個 key」。
    computeDigest: (_algo, value) => Array.from(Buffer.from(String(value), 'utf8')),
    base64EncodeWebSafe: (bytes) => Buffer.from(bytes).toString('base64url'),
  },
  ContentService: {
    MimeType: { JSON: 'application/json' },
    createTextOutput: (text) => ({ _text: text, setMimeType: () => ({ _text: text }) }),
  },
  Date: class extends Date {
    constructor(...args) {
      // 無參數的 new Date() 每次前進一毫秒，讓 updatedAt 一定會變
      if (args.length === 0) super((clock += 1));
      else super(...args);
    }
  },
};

const ctx = vm.createContext(sandbox);
for (const f of ['Auth.gs', 'Store.gs', 'Code.gs']) {
  vm.runInContext(fs.readFileSync(path.join(here, f), 'utf8'), ctx, { filename: f });
}

// ---- 跑一遍 ----

/** 想送什麼就送什麼，第 9 節用來測「連 idToken 這個欄位都沒有」。 */
const rawCall = (req) => JSON.parse(sandbox.rpc(JSON.stringify(req)));
/** 一般呼叫都帶一枚合格的 token；驗證本身在第 9 節單獨測。 */
const call = (op, payload = {}, idToken = '好token') => rawCall({ op, payload, idToken });
const show = (label, v) => console.log(label, JSON.stringify(v));
let failures = 0;
function check(label, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra === undefined ? '' : '  ' + JSON.stringify(extra)}`);
  if (!cond) failures++;
}

console.log('=== 1. init：不得寫入示範資料 ===');
const SEED = {
  classes: [
    { id: 'c701', name: '七年一班', students: [{ id: 'c701-s13', no: 13, name: '洪語彤' }] },
  ],
  behaviors: [{ id: 'b1', label: '主動發言', delta: 2, kind: 'positive' }],
  rewards: [{ id: 'r1', label: '免作業卡', cost: 20 }],
  settings: { periods: ['第一節'] },
  events: [
    { id: 'demo-0', ts: '2026-08-01T00:00:00.000Z', classId: 'c701', studentId: 'c701-s13', behaviorId: 'b1', delta: 2, kind: 'positive', period: '', note: '', voided: false },
  ],
};
show('init →', call('init', { seed: SEED }).result);
const afterInitClasses = call('getDoc', { name: 'classes' }).result;
const afterInitEvents = call('queryEvents', { includeVoided: true }).result;
show('classes →', afterInitClasses);
show('behaviors →', call('getDoc', { name: 'behaviors' }).result);
show('settings →', call('getDoc', { name: 'settings' }).result);
check('classes 是空的（示範班級沒進來）', Array.isArray(afterInitClasses) && afterInitClasses.length === 0);
check('events 是空的（seed.events 沒進來）', afterInitEvents.length === 0);
check('behaviors 預設值有建起來', call('getDoc', { name: 'behaviors' }).result.length === 1);
show('init 重跑（已有就不動）→', call('init', { seed: SEED }).result);

console.log('\n=== 2. appendEvent + 重送同一筆（冪等）===');
const evtPayload = {
  id: 'evt-abc-123',
  classId: 'c701',
  studentId: 'c701-s13',
  behaviorId: 'b1',
  delta: 2,
  kind: 'positive',
  period: '第一節',
  note: '',
};
const first = call('appendEvent', evtPayload).result;
show('第一次 →', first);
const retry = call('appendEvent', evtPayload).result;
show('重送同一個 id →', retry);
const noId = call('appendEvent', { classId: 'c701', studentId: 'c701-s13', behaviorId: 'b1', delta: 2, kind: 'positive' }).result;
show('沒帶 id（GAS 自己產）→', noId);
const rows = call('queryEvents', { includeVoided: true }).result;
show('目前事件數 →', rows.length);
check('重送沒有變成兩列', rows.filter((e) => e.id === 'evt-abc-123').length === 1);
check('重送回傳標記 duplicate', retry.duplicate === true);
check('重送回的 ts 跟第一次一樣', retry.ts === first.ts, { first: first.ts, retry: retry.ts });
check('沒帶 id 的仍寫得進去', rows.length === 2);

console.log('\n=== 3. voidEvent ===');
const voided = call('voidEvent', { id: 'evt-abc-123' }).result;
show('void →', voided);
show('查詢（預設不含撤銷）→', call('queryEvents', {}).result.map((e) => e.id));
show('查詢（含撤銷）→', call('queryEvents', { includeVoided: true }).result.map((e) => e.id));
check('撤銷後預設查不到', call('queryEvents', {}).result.every((e) => e.id !== 'evt-abc-123'));
check('voidedAt 有寫上', !!voided.voidedAt);
show('voidEvent 不存在的 id →', call('voidEvent', { id: '不存在' }).result);

console.log('\n=== 4. saveDoc 姓名剝除 ===');
const withNames = [
  {
    id: 'c701',
    name: '七年一班',
    students: [
      { id: 'c701-s13', no: 13, name: '洪語彤', row: 0, col: 0 },
      { id: 'c701-s14', no: 14, name: '陳彥廷', row: 0, col: 1 },
      { id: 'c701-s15', no: 15, row: 0, col: 2 },
    ],
  },
];
const saved = call('saveDoc', { name: 'classes', value: withNames }).result;
show('saveDoc →', saved);
const stored = call('getDoc', { name: 'classes' }).result;
show('落盤後的 classes →', stored);
check('回報剝了 2 筆', saved.strippedNames === 2);
check('落盤沒有任何 student.name', !JSON.stringify(stored).includes('洪語彤') && !JSON.stringify(stored).includes('陳彥廷'));
check('班級名稱保留', stored[0].name === '七年一班');
check('座號等其他欄位保留', stored[0].students[0].no === 13);

console.log('\n=== 5. saveDoc 樂觀鎖衝突 ===');
const meta = call('getDocMeta', { name: 'classes' }).result;
show('分頁 A 讀到的 updatedAt →', meta.updatedAt);
const okSave = call('saveDoc', { name: 'classes', value: stored, updatedAt: meta.updatedAt }).result;
show('分頁 B 先存（帶對的 updatedAt）→', okSave);
const conflict = call('saveDoc', { name: 'classes', value: stored, updatedAt: meta.updatedAt });
show('分頁 A 後存（帶舊的 updatedAt）→', conflict);
check('衝突被擋下', conflict.ok === false);
check('錯誤訊息是白話、沒有 409', !/409/.test(conflict.error) && conflict.error.includes('重新整理'));
const forced = call('saveDoc', { name: 'classes', value: stored }).result;
check('沒帶 updatedAt 仍放行（相容缺口）', forced.ok === true, forced);

console.log('\n=== 6. importAll 也要剝姓名 ===');
const imported = call('importAll', {
  payload: {
    classes: withNames,
    behaviors: SEED.behaviors,
    rewards: SEED.rewards,
    settings: SEED.settings,
    events: [
      { id: 'bk-1', ts: '2026-08-10T01:00:00.000Z', classId: 'c701', studentId: 'c701-s13', behaviorId: 'b1', delta: 2, kind: 'positive', period: '', note: '', voided: false },
      { id: 'bk-2', ts: '2026-08-11T01:00:00.000Z', classId: 'c701', studentId: 'c701-s14', behaviorId: 'b1', delta: 2, kind: 'positive', period: '', note: '', voided: true, voidedAt: '2026-08-11T02:00:00.000Z' },
    ],
  },
}).result;
show('importAll →', imported);
check('匯入時剝了 2 筆姓名', imported.strippedNames === 2);
check('匯入後試算表無姓名', !JSON.stringify(call('getDoc', { name: 'classes' }).result).includes('洪語彤'));
check('事件 id 照原樣還原', call('queryEvents', { includeVoided: true }).result.map((e) => e.id).join(',') === 'bk-1,bk-2');

console.log('\n=== 7. purgeStudent ===');
show('事件（刪前）→', call('queryEvents', { includeVoided: true }).result.map((e) => `${e.id}/${e.studentId}`));
const purged = call('purgeStudent', { classId: 'c701', studentId: 'c701-s13' }).result;
show('purgeStudent →', purged);
show('事件（刪後）→', call('queryEvents', { includeVoided: true }).result.map((e) => `${e.id}/${e.studentId}`));
check('刪掉 1 筆', purged.deleted === 1);
check('別人的事件沒被誤刪', call('queryEvents', { includeVoided: true }).result.length === 1);
show('purgeStudent 少帶參數 →', call('purgeStudent', { classId: 'c701' }));

console.log('\n=== 8. 其他 ===');
show('exportAll →', (() => { const x = call('exportAll').result; return { keys: Object.keys(x), events: x.events.length }; })());
show('未知 op →', call('沒這個'));
show('doGet health →', JSON.parse(sandbox.doGet({ parameter: {} })._text));
check('鎖有正確釋放', lockHeld === 0, { lockHeld });
check('doGet health 不吐老師的 email', !JSON.stringify(JSON.parse(sandbox.doGet({ parameter: {} })._text)).includes('@'));

/*
 * 這一節是整份自測裡最要緊的。
 * 這個部署的存取權是「任何人（包含匿名）」——因為「只有我自己」在瀏覽器裡連不上
 * （CORS，理由見 gas/Auth.gs 檔頭）。所以沒有 Google 的登入牆替我們擋人，
 * 擋人的就只剩下 verifyTeacher()。它漏一個洞，整份試算表就是公開的。
 */
console.log('\n=== 9. 身分驗證（門鎖本身）===');
const AUTH_CASES = [
  // 連欄位都沒有，是匿名訪客直接打這支端點時最可能的形狀。
  ['沒帶 idToken 欄位', { op: 'exportAll', payload: {} }],
  ['空字串', { op: 'exportAll', payload: {}, idToken: '' }],
  ['null', { op: 'exportAll', payload: {}, idToken: null }],
  ['Google 不認識的 token', { op: 'exportAll', payload: {}, idToken: '亂打的' }],
  ['別人的 Google 帳號', { op: 'exportAll', payload: {}, idToken: '別人的' }],
  ['別的應用程式簽的 token（aud 不符）', { op: 'exportAll', payload: {}, idToken: '別的應用程式' }],
  ['信箱未經 Google 驗證', { op: 'exportAll', payload: {}, idToken: '未驗證信箱' }],
];
for (const [label, req] of AUTH_CASES) {
  const res = rawCall(req);
  check(`擋下：${label}`, res.ok === false && res.status === 401, res);
}
// 失敗訊息必須一模一樣，不能讓人靠訊息差異推敲出這份部署的設定。
const messages = new Set(AUTH_CASES.map(([, req]) => rawCall(req).error));
check(`${AUTH_CASES.length} 種失敗講的是同一句話`, messages.size === 1, [...messages]);
check('合格的 token 放行', call('exportAll').ok === true);

const before = tokeninfoCalls;
call('getDoc', { name: 'behaviors' });
call('getDoc', { name: 'rewards' });
check('驗過的 token 走快取，不重複問 Google', tokeninfoCalls === before, {
  before,
  after: tokeninfoCalls,
});

console.log(`\n${failures === 0 ? '全部通過' : failures + ' 項失敗'}`);
process.exit(failures === 0 ? 0 : 1);
