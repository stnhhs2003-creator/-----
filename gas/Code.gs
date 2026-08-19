/*
 * 班級積分堂 · Apps Script 管理端
 *
 * 對應 js/store-gas.js。一支 RPC 端點，body 是 { op, payload }，
 * 回應一律 HTTP 200 + { ok, result } 或 { ok:false, error, status }
 * ——ContentService 設不了狀態碼，成敗只能寫在 body 裡，前端那層會翻回例外。
 *
 * 儲存原語（工作表、鎖、doc 讀寫、事件讀寫）全部在 gas/Store.gs，
 * 這一檔只放業務規則與進入點。Apps Script 沒有模組系統，同專案的 .gs
 * 共用全域，直接呼叫即可。
 *
 * 儲存結構刻意跟 db/schema.sql 對齊，換過來時上層看到的形狀不變：
 *   工作表 events：一列一筆事件，append-only（只有 voided 欄位會被就地改）
 *   工作表 docs  ：一列一包 JSON（classes / behaviors / rewards / settings）
 *
 * 差別只有一個：schema.sql 每張表第一欄都是 teacher_id，這裡沒有。
 * 理由見 teacherId() 的註解——這份部署天生就是一位老師的。
 */

// ---- 身分 ----

/**
 * 這份部署屬於哪位老師。
 *
 * 【這是整個遷移最關鍵的一個決定，先講結論】
 * 網頁應用程式的「執行身分」選「以我（部署者）的身分執行」，
 * 也就是說 SpreadsheetApp 拿到的永遠是老師自己的試算表，跟誰在瀏覽器前面無關。
 * 因此 teacherId 不是從請求裡讀出來的，而是這份部署的常數——
 * 一位老師一份 Apps Script 專案、一份試算表、一組 /exec 網址。
 *
 * 不從請求讀，跟 functions/api/data/[[route]].js 的鐵則是同一條：
 * 只要有一條路徑讓呼叫端自己指定 teacherId，隔離就等於沒做。
 * 在單租戶的 GAS 上，這條鐵則的實作就是「根本沒有那個欄位」。
 *
 * 部署帳號已拍板為老師的個人 Gmail（docs/gas-contract.md）。
 * 隨之而來的代價是「學生姓名不上雲端」，見下面的 stripStudentNames()。
 */
function teacherId() {
  return Session.getEffectiveUser().getEmail();
}

// ---- 姓名絕不落盤（契約鐵則第 2 條）----

/** doc 名稱對老師講得出口的說法，錯誤訊息用。 */
var DOC_LABELS = {
  classes: '名冊',
  behaviors: '行為卡',
  rewards: '獎勵品項',
  settings: '設定',
};

/**
 * 把 classes 裡每一位學生的 name 剝掉。
 *
 * 分離本來就做在 js/store-gas.js（上層看到的永遠是有姓名的完整 classes），
 * 但那是前端，改一下前端就繞過去了。這裡是最後一道防線：
 * 只要姓名走到 Sheets 的門口就攔下來，不相信上游。
 *
 * 班級本身的 name（「七年一班」）不是個資，留著。
 * 回傳 { classes, stripped }，stripped 是被剝掉的筆數。
 */
function stripStudentNames(classes) {
  var stripped = 0;
  if (!Array.isArray(classes)) return { classes: classes, stripped: 0 };
  var clean = classes.map(function (cls) {
    if (!cls || typeof cls !== 'object') return cls;
    var copy = {};
    Object.keys(cls).forEach(function (k) {
      copy[k] = cls[k];
    });
    if (Array.isArray(cls.students)) {
      copy.students = cls.students.map(function (stu) {
        if (!stu || typeof stu !== 'object') return stu;
        var s = {};
        Object.keys(stu).forEach(function (k) {
          if (k === 'name') return;
          s[k] = stu[k];
        });
        if (Object.prototype.hasOwnProperty.call(stu, 'name')) stripped++;
        return s;
      });
    }
    return copy;
  });
  return { classes: clean, stripped: stripped };
}

// ---- 樂觀鎖 ----

/**
 * 老師開兩個分頁改名冊，後存的不該整包蓋掉先存的。
 *
 * 前端讀 doc 時一起拿 updatedAt（op: getDocMeta），存的時候原樣帶回來。
 * 帶回來的跟試算表上的不一樣，就代表這中間有人存過 → 不覆蓋，丟白話錯誤。
 *
 * 沒帶 updatedAt 的呼叫一律放行（第一次寫入、匯入、還沒接上這條線的呼叫端）。
 * 這是刻意的相容缺口，不是漏掉——見回報。
 */
function assertNoConflict(name, meta, clientUpdatedAt) {
  if (clientUpdatedAt === undefined || clientUpdatedAt === null || clientUpdatedAt === '') return;
  if (!meta.exists) return;
  if (String(clientUpdatedAt) === meta.updatedAt) return;
  var label = DOC_LABELS[name] || name;
  throw new Error(
    '這份' + label + '在你編輯的時候，已經被另一個分頁（或另一台裝置）存過一次了。' +
      '為了不蓋掉那一次的修改，這次沒有存進去。' +
      '請重新整理這個頁面，看到最新的內容之後再改一次。',
  );
}

// ---- 各 op ----

var OPS = {
  /**
   * 首次進站補齊四包 doc。「已有就不動」而不是「覆蓋」——
   * 老師可能同時開兩個分頁。
   *
   * 【雲端版不鋪示範資料】（個資盤點 C3）
   * localStorage 版第一次進站會鋪 18 位假學生 + 一週假事件，那是單機玩具的作法。
   * 雲端版鋪下去等於把假資料寫進老師真正的試算表，之後還得自己刪。
   * 所以這裡：
   *   - seed.events    → 一律忽略
   *   - seed.classes   → 一律忽略，classes 開站就是空陣列（老師自己貼名冊）
   *   - behaviors / rewards / settings 的預設值 → 照建，那是設定不是資料
   */
  init: function (p) {
    var seed = p.seed || {};
    return withLock(function () {
      var existing = docsSheet().getDataRange().getValues();
      var have = {};
      for (var i = 1; i < existing.length; i++) have[String(existing[i][0])] = true;

      var created = [];
      DOC_NAMES.forEach(function (name) {
        if (have[name]) return;
        var value;
        if (name === 'classes') {
          value = [];
        } else {
          value = seed[name] === undefined ? docFallback(name) : seed[name];
        }
        putDocRow(name, value);
        created.push(name);
      });
      // 事件永遠不鋪。events 工作表只要存在（含表頭）就好。
      eventsSheet();
      return { ok: true, created: created, seededEvents: 0 };
    });
  },

  /**
   * 記一筆行為。
   *
   * 【事件 id 由前端產生】
   * 冪等只有在「重試送的是同一個 id」時才成立。id 若在 GAS 端產，
   * 每次重試都是新 id，怎麼掃都擋不住重複。所以 payload 帶 id 上來，
   * Store.gs 的 appendEventRow() 在最後 200 列裡掃同 id，有就不寫第二列。
   *
   * 沒帶 id 的呼叫端（舊版前端、手動測試）仍然收得下，只是那種呼叫沒有冪等保護。
   * ts 一律由伺服器產：時間戳是排序與統計的依據，不能讓客戶端的時鐘決定。
   */
  appendEvent: function (p) {
    var evt = {
      id: p.id ? String(p.id) : uid(),
      ts: nowISO(),
      classId: p.classId || '',
      studentId: p.studentId || '',
      behaviorId: p.behaviorId || '',
      delta: Number(p.delta) || 0,
      kind: p.kind,
      period: p.period || '',
      note: p.note || '',
      voided: false,
    };
    return appendEventRow(evt);
  },

  voidEvent: function (p) {
    return withLock(function () {
      var rows = allEventRows();
      for (var i = 0; i < rows.length; i++) {
        if (String(rows[i][0]) !== String(p.id)) continue;
        var at = nowISO();
        // 只改 voided / voidedAt 兩欄，不刪列：撤銷本身也是要留下來的事實。
        eventsSheet().getRange(i + 2, 10, 1, 2).setValues([[1, at]]);
        var evt = rowToEvent(rows[i]);
        evt.voided = true;
        evt.voidedAt = at;
        return evt;
      }
      return null;
    });
  },

  /**
   * 篩選在這裡做完才回傳。
   * 上層（家長端、學生端）的紅線是「待改進的明細不得離開後端」，
   * 這條線只有落在這個函式裡才守得住——前端過濾的東西，改一下前端就繞過去了。
   */
  queryEvents: function (p) {
    var includeVoided = !!p.includeVoided;
    var source = p.studentId ? eventsOf(p.studentId) : allEvents();
    return source.filter(function (e) {
      if (!includeVoided && e.voided) return false;
      if (p.classId && e.classId !== p.classId) return false;
      if (p.since && e.ts < p.since) return false;
      if (p.until && e.ts > p.until) return false;
      return true;
    });
  },

  getDoc: function (p) {
    if (DOC_NAMES.indexOf(p.name) < 0) throw new Error('不認得的設定名稱：' + p.name);
    return readDoc(p.name);
  },

  /** 樂觀鎖用：讀 doc 的同時拿到 updatedAt，存回來時原樣帶上。 */
  getDocMeta: function (p) {
    if (DOC_NAMES.indexOf(p.name) < 0) throw new Error('不認得的設定名稱：' + p.name);
    var meta = readDocMeta(p.name);
    return { value: meta.value, updatedAt: meta.updatedAt };
  },

  saveDoc: function (p) {
    var name = p.name;
    if (DOC_NAMES.indexOf(name) < 0) throw new Error('不認得的設定名稱：' + name);
    return withLock(function () {
      var meta = readDocMeta(name);
      assertNoConflict(name, meta, p.updatedAt);
      var value = p.value;
      var stripped = 0;
      if (name === 'classes') {
        var res = stripStudentNames(value);
        value = res.classes;
        stripped = res.stripped;
      }
      var at = putDocRow(name, value);
      return { ok: true, updatedAt: at, strippedNames: stripped };
    });
  },

  exportAll: function () {
    return {
      exportedAt: nowISO(),
      classes: readDoc('classes'),
      behaviors: readDoc('behaviors'),
      rewards: readDoc('rewards'),
      // 匯出含已撤銷的事件，備份才對得回原本那一份。
      events: allEvents(),
      settings: readDoc('settings'),
    };
  },

  /*
   * ---- 刪除（個資法第 11 條第 3 項）----
   * 這是唯一會真的 deleteRows 的路徑，跟 voidEvent 的稽核語意無關。
   * 由後往前刪：從前面刪會讓後面的列號整個位移。
   */

  purgeStudent: function (p) {
    if (!p.classId || !p.studentId) throw new Error('要刪哪一位學生沒講清楚，不動手。');
    return withLock(function () {
      return deleteWhere(function (e) {
        return e.classId === p.classId && e.studentId === p.studentId;
      });
    });
  },

  purgeClass: function (p) {
    if (!p.classId) throw new Error('要刪哪一班沒講清楚，不動手。');
    return withLock(function () {
      return deleteWhere(function (e) {
        return e.classId === p.classId;
      });
    });
  },

  /**
   * 整份還原。事件的 id、ts、voided 全部照備份檔原樣寫回——
   * 重編號等於偽造一份新的歷史，匯出的檔案就再也對不回原本那一份。
   *
   * 備份檔可能是從有姓名的裝置匯出的，所以這裡也要剝一次姓名。
   */
  importAll: function (p) {
    var payload = p.payload || {};
    var events = Array.isArray(payload.events) ? payload.events : [];
    return withLock(function () {
      clearEvents();
      if (events.length) {
        eventsSheet()
          .getRange(2, 1, events.length, EVENT_HEADER.length)
          .setValues(events.map(eventToRow));
      }
      var stripped = 0;
      DOC_NAMES.forEach(function (name) {
        var value = payload[name] === undefined ? docFallback(name) : payload[name];
        if (name === 'classes') {
          var res = stripStudentNames(value);
          value = res.classes;
          stripped = res.stripped;
        }
        putDocRow(name, value);
      });
      return { ok: true, events: events.length, strippedNames: stripped };
    });
  },

  resetAll: function () {
    return withLock(function () {
      clearEvents();
      var sh = docsSheet();
      if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
      return { ok: true };
    });
  },
};

function clearEvents() {
  var sh = eventsSheet();
  if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
}

function deleteWhere(pred) {
  var sh = eventsSheet();
  var rows = allEventRows();
  var deleted = 0;
  for (var i = rows.length - 1; i >= 0; i--) {
    if (pred(rowToEvent(rows[i]))) {
      sh.deleteRow(i + 2);
      deleted++;
    }
  }
  return { deleted: deleted };
}

// ---- 進入點 ----

function reply(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(
    ContentService.MimeType.JSON,
  );
}

/**
 * RPC 核心。doPost 與 google.script.run 都走這裡，只有一份分派邏輯。
 * 收字串、回字串，因為 google.script.run 只能傳簡單型別。
 */
function rpc(raw) {
  var out;
  try {
    var req = typeof raw === 'string' ? JSON.parse(raw) : raw || {};
    var op = OPS[req.op];
    if (!op) {
      out = { ok: false, error: '不認得的操作：' + req.op, status: 404 };
    } else {
      /*
       * 【門鎖在這裡，不在部署權限】
       * 這份部署的存取權是「任何人」——不是因為它公開，而是因為「只有我自己」
       * 在瀏覽器裡根本連不上（CORS，理由寫在 gas/Auth.gs 的檔頭）。
       * 所以每一個 op 執行前都要先驗 ID token，一個都不例外：
       * 只要有一條路徑繞得過去，這道門就等於沒有。
       *
       * 驗證失敗丟的是 AUTH_FAIL，會被下面的 catch 接住轉成 500——
       * 但權限問題要回 401，前端才知道該把人帶去重新登入而不是顯示「伺服器錯誤」。
       * 所以這裡自己接一次。
       */
      try {
        verifyTeacher(req.idToken);
      } catch (authErr) {
        return JSON.stringify({
          ok: false,
          error: String((authErr && authErr.message) || authErr),
          status: 401,
        });
      }
      out = { ok: true, result: op(req.payload || {}) };
    }
  } catch (err) {
    // 課堂上點了學生卻沒記到，比噴錯還糟——錯誤一定要讓前端看得見。
    out = { ok: false, error: String((err && err.message) || err), status: 500 };
  }
  return JSON.stringify(out);
}

function doPost(e) {
  // content-type 是 text/plain（避開 CORS 預檢），所以 body 一律從 postData.contents 拿。
  var raw = (e && e.postData && e.postData.contents) || '{}';
  return reply(JSON.parse(rpc(raw)));
}

/**
 * GET 只有健康檢查。
 *
 * 部署形態：兩個獨立的 Apps Script 專案。
 * 這一份是**管理端**，全部的 OPS 都掛在它的 doPost 上，門鎖是 gas/Auth.gs 的
 * ID token 驗證（不是部署權限——那條路在瀏覽器裡走不通，見 Auth.gs 檔頭）。
 * 家長／學生端是另一個專案（gas/public-appsscript.json），只掛投影過的唯讀路由。
 *
 * 所以這支 doGet 不會、也不該吐任何學生資料。
 *
 * 【健康檢查不回老師的 email】
 * 存取權改成「任何人」之後，這支 GET 誰都打得到。原本這裡會回 teacherId()，
 * 那就等於把老師的 Gmail 掛在一個公開網址上給人抓。健康檢查只需要證明
 * 「這支端點活著、而且是這個專案」，回一個名字就夠了。
 */
function doGet(e) {
  var route = (e && e.parameter && e.parameter.op) || 'health';
  if (route === 'health') {
    return reply({ ok: true, result: { name: '班級積分堂 GAS 後端（管理端）' } });
  }
  return reply({ ok: false, error: '不認得的操作：' + route, status: 404 });
}
