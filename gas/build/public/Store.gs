/*
 * 班級積分堂 · 儲存原語（S1 名下，S2 唯讀使用）
 *
 * Apps Script 沒有模組系統：同一個專案裡的 .gs 檔共用同一個全域，
 * 所以 Code.gs 與 Public.gs 直接呼叫這裡的函式即可，不需要 import。
 *
 * docs/gas-contract.md「交界」那張表列的七支，簽名固定不得更動：
 *   readDoc(name) / allEvents() / eventsOf(studentId) / appendEventRow(evt)
 *   withLock(fn)  / nowISO()    / uid()
 *
 * 這一層只管「怎麼把資料放進／拿出試算表」，不管業務規則。
 * 投影、權限、姓名剝除那些都在 Code.gs 與 Public.gs。
 */

/** docs 工作表放的四包 JSON。settings 是物件，其餘是陣列。 */
var DOC_NAMES = ['classes', 'behaviors', 'rewards', 'settings'];

var EVENT_HEADER = [
  'id', 'ts', 'classId', 'studentId', 'behaviorId',
  'delta', 'kind', 'period', 'note', 'voided', 'voidedAt',
];

var DOC_HEADER = ['name', 'json', 'updatedAt'];

/*
 * 寫入鎖的等待秒數。
 *
 * Sheets 沒有交易。兩個分頁同時按下同一張行為卡，兩個 appendRow 交錯不會壞
 * （append-only 的好處：誰先誰後都不會少一筆），但 voidEvent／saveDoc／purge
 * 是「讀出來、改、寫回去」，沒有鎖就會有一邊的修改被整個蓋掉。
 * 所以所有會寫的 op 一律進鎖，讀的不進。
 */
var LOCK_WAIT_MS = 15000;

/*
 * 冪等掃描窗口。
 *
 * 重送只會發生在「前端送出後沒收到回應，幾秒內重試」這一種情境，
 * 所以只掃最後 N 列就夠。掃全表（一學期上萬列）只為了防重複並不划算，
 * 而且 appendEvent 是課堂上最熱的路徑，不能為它拉全表。
 */
var DEDUP_WINDOW = 200;

// ---- 資料位置 ----

/**
 * 資料放哪一份試算表。
 * 走指令碼屬性而不是寫死 ID：ID 進了原始碼就等於進了 git。
 * 沒設定就退回「跟這個專案綁定的那一份」（容器繫結部署）。
 */
function book() {
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function sheetOf(name, header) {
  var ss = book();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(header);
    sh.setFrozenRows(1);
  }
  return sh;
}

function eventsSheet() {
  return sheetOf('events', EVENT_HEADER);
}

function docsSheet() {
  return sheetOf('docs', DOC_HEADER);
}

// ---- 基本原語 ----

function uid() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 14);
}

function nowISO() {
  return new Date().toISOString();
}

/*
 * 寫入互斥。
 *
 * ⚠️ 這裡原本是 `getDocumentLock()`，實測會 **回 null**：文件鎖只有「綁在某份
 * 試算表底下的指令碼」才拿得到，這兩支都是獨立（standalone）專案，只是用
 * SpreadsheetApp.openById() 去開試算表而已，對 Apps Script 來說沒有「所屬文件」。
 * 症狀是每一條寫入路徑（含開站的 init）都炸在
 * `Cannot read properties of null (reading 'tryLock')`。
 * 之所以到現在才發現：管理端先前的部署權限是「只有我自己」，
 * 瀏覽器根本連不上，寫入路徑一次都沒真的跑過。
 *
 * 已知限制：指令碼鎖是**各專案各一把**，管理端與公開端這兩個專案不會互斥。
 * 目前可以接受，因為公開端全檔唯一的寫入是 redeem-request 的 appendEventRow，
 * 那是「往後面加一列」，不是先讀再改寫；跟管理端搶的最壞情況是兩列的先後順序，
 * 不會互相蓋掉。哪天公開端出現任何 read-modify-write，這個假設就破了，
 * 到時要改成在試算表裡自己做一把鎖（例如 docs 表上的一列）而不是回頭用文件鎖。
 */
function withLock(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    throw new Error('另一個操作正在寫入，請再試一次。');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ---- 列 ↔ 物件 ----

function rowToEvent(row) {
  var evt = {
    id: String(row[0]),
    ts: String(row[1]),
    classId: String(row[2] || ''),
    studentId: String(row[3] || ''),
    behaviorId: String(row[4] || ''),
    delta: Number(row[5]) || 0,
    kind: String(row[6] || ''),
    period: String(row[7] || ''),
    note: String(row[8] || ''),
    voided: !!row[9],
  };
  if (row[10]) evt.voidedAt = String(row[10]);
  return evt;
}

function eventToRow(e) {
  return [
    e.id, e.ts, e.classId || '', e.studentId || '', e.behaviorId || '',
    Number(e.delta) || 0, e.kind, e.period || '', e.note || '',
    e.voided ? 1 : 0, e.voidedAt || '',
  ];
}

/**
 * 讀出全部事件列（原始列陣列，不轉物件）。
 *
 * getDataRange().getValues() 是一次 API 呼叫把整張表拉進記憶體——
 * 一位老師兩三個班、一學期幾千筆，這個量級一次讀完只要幾百毫秒，是划算的。
 * 逐列 getRange() 才是 GAS 上的效能地獄（每一次都是一趟往返）。
 *
 * TODO（量的天花板）：超過約五萬列就要按學年／學期分工作表，
 *   或改用 SpreadsheetApp 以外的儲存（Drive 上的 JSONL、或 Firestore）。
 *   在那之前不要為了想像中的規模先拆——見 docs/gas-migration.md 的「量」那一節。
 */
function allEventRows() {
  var values = eventsSheet().getDataRange().getValues();
  return values.length > 1 ? values.slice(1) : [];
}

// ---- 交界 API：事件 ----

/** 全部事件，含已撤銷。呼叫端自己濾。 */
function allEvents() {
  return allEventRows().map(rowToEvent);
}

/** 單一學生的全部事件，含已撤銷。 */
function eventsOf(studentId) {
  var want = String(studentId || '');
  if (!want) return [];
  return allEventRows()
    .filter(function (row) {
      return String(row[3] || '') === want;
    })
    .map(rowToEvent);
}

/**
 * 已帶 id/ts 的事件直接落盤，走 withLock。
 *
 * 冪等：同一個 id 已經在最後 DEDUP_WINDOW 列裡出現過，就不再寫一列，
 * 直接回傳已存在的那一筆。網路重試不會變成兩筆分數。
 * （Turso 版對應的是 `ON CONFLICT (teacher_id, id) DO NOTHING`。）
 *
 * append 是唯一不需要「讀出來再寫回去」的寫入，但還是進鎖：
 * appendRow 與同一刻的 purge（deleteRows）交錯會寫到被刪掉的位置。
 */
function appendEventRow(evt) {
  return withLock(function () {
    var existing = findEventById(evt.id);
    if (existing) {
      existing.duplicate = true;
      return existing;
    }
    eventsSheet().appendRow(eventToRow(evt));
    return evt;
  });
}

/** 在最後 DEDUP_WINDOW 列裡找同 id 的事件；找不到回 null。 */
function findEventById(id) {
  var want = String(id || '');
  if (!want) return null;
  var sh = eventsSheet();
  var last = sh.getLastRow();
  if (last < 2) return null;
  var start = Math.max(2, last - DEDUP_WINDOW + 1);
  var rows = sh.getRange(start, 1, last - start + 1, EVENT_HEADER.length).getValues();
  for (var i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i][0]) === want) return rowToEvent(rows[i]);
  }
  return null;
}

// ---- 交界 API：docs ----

function docFallback(name) {
  return name === 'settings' ? {} : [];
}

/** name ∈ classes / behaviors / rewards / settings，回物件或陣列。 */
function readDoc(name) {
  var meta = readDocMeta(name);
  return meta.value;
}

/**
 * 連同 updatedAt 一起讀出來。樂觀鎖用得到，S2 用不到。
 * 回 { value, updatedAt, exists }。
 */
function readDocMeta(name) {
  var rows = docsSheet().getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) !== name) continue;
    var value;
    try {
      value = JSON.parse(rows[i][1]);
    } catch (err) {
      value = docFallback(name);
    }
    return { value: value, updatedAt: String(rows[i][2] || ''), exists: true, rowIndex: i + 1 };
  }
  return { value: docFallback(name), updatedAt: '', exists: false, rowIndex: 0 };
}

/**
 * 就地寫回一包 doc（不含鎖、不含樂觀鎖檢查）。
 * 呼叫端要自己包在 withLock 裡——因為通常還有別的動作要跟它同一個交易。
 * 回傳新的 updatedAt。
 */
function putDocRow(name, value, stamp) {
  var sh = docsSheet();
  var rows = sh.getDataRange().getValues();
  var at = stamp || nowISO();
  var json = JSON.stringify(value === undefined || value === null ? docFallback(name) : value);
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === name) {
      sh.getRange(i + 1, 2, 1, 2).setValues([[json, at]]);
      return at;
    }
  }
  sh.appendRow([name, json, at]);
  return at;
}
