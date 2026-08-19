/*
 * 班級積分堂 · 公開端（家長／學生那一份部署）
 *
 * 這支是 functions/api/student/[[route]].js 與 functions/api/parent/[[route]].js
 * 兩支的 GAS 版。形狀照抄，SQL 換成 Sheets 讀出來之後的 filter。
 *
 * ── 這份部署是什麼 ──
 * 獨立的 Apps Script 專案（manifest 是 gas/public-appsscript.json），
 * 只放這個檔案 ＋ S1 的 gas/Store.gs。**不放 Code.gs**——
 * Code.gs 的 OPS 有記分、改名冊、匯出、清空，那些絕對不能掛在一個
 * 「任何人（包含匿名）」都打得到的網址上。兩份 manifest、兩個專案、
 * 共用同一份試算表，是這條線的前提，不是實作細節。
 *
 * 執行身分是「以我（老師）的身分執行」，所以：
 *   · 存取者不需要 Google 帳號，也不需要對試算表有任何權限
 *   · Session 認不出呼叫者是誰（匿名一律空字串），認人只能靠個人代碼
 *   · 這支程式碼跑起來有老師的完整權限——所以這裡一條寫入路徑都不能亂開，
 *     全檔唯一的寫入是 redeem-request（delta 一律 0，真正扣點在老師端核可時）
 *
 * ── 三條紅線（照抄 Cloudflare 版，不得放寬）──
 *
 * 1. **家長端只吐正向、未撤銷的事件。** Turso 版是 SQL 的
 *    `WHERE kind='positive' AND voided=0`，這裡是 positiveEventsOf() 的 filter。
 *    這一層之後沒有任何地方能把待改進的紀錄放進回應。
 *
 * 2. **學生端拿不到任何人的待改進逐條明細，包括自己的。** 扣分只反映在總分。
 *    「自己的也不給」不是保護學生不知道，是因為這一頁常常是在教室裡、
 *    別人也看得到的螢幕上打開的；待改進要當面講，不是列在網頁上。
 *
 * 3. **餘額與可動用點數在後端算完只送一個數字。** 把逐筆事件撈回前端再加總，
 *    等於把待改進明細一起送出去了——這正是紅線 2 最常見的破法。
 *
 * ── 姓名 ──
 * docs/gas-contract.md 鐵則第 2 條：姓名根本不在試算表裡。所以班級榜只有座號，
 * 家長端只有「您的孩子（13號）」。這裡刻意再多做一件事：**就算試算表裡
 * 不知怎麼混進了 name 欄位，這個檔案也一個字都不會回出去**——
 * 底下每一處組回應的地方都是逐欄挑出來（id / no / 分數），不是整包 spread。
 *
 * ── 認不出來時只有一句話 ──
 * 「沒這個座號」「碼打錯」「這位學生不參與記錄」三種情況回一模一樣的字串
 * 與同一個 status。分開講等於送同學一支代碼探測器；而「這個人存在但不參與」
 * 本身也是一則關於這個孩子的資訊，差別本身就是洩漏。
 */

// ───────────────────────── 代碼比對（複製自 js/codes.js）─────────────────────────
//
// js/codes.js 是共用檔（主線名下），這條線不改它，把純函式邏輯複製過來。
// Apps Script 沒有模組系統，import 不了；複製的是最穩定的那 12 行，
// 而且底下的 selftest 會用同一組樣本驗過，兩邊行為不會偷偷分岔。

/**
 * 正規化。全形數字轉半形、去掉所有空白。
 * 學生是照紙條打的、家長是從 LINE 貼過來的，
 * 為了一個看不見的空白把人擋在門外，只會讓老師的電話響個不停。
 */
function pubNormalizeCode(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/[０-９]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xfee0);
    })
    .replace(/\s/g, '');
}

/** 代碼比對。空的期望值一律不通過——沒發代碼不等於誰都可以進。 */
function pubCodeMatches(input, expected) {
  var a = pubNormalizeCode(input);
  var b = pubNormalizeCode(expected);
  return !!b && a === b;
}

/** 複製自 js/optout.js 的 isOptedOut。 */
function pubIsOptedOut(student) {
  return !!(student && student.optOut && student.optOut.since);
}

// ───────────────────────── 認人 ─────────────────────────

/*
 * 認不出來時的那一句話。學生端與家長端各一句，各自的三種失敗共用同一句。
 *
 * 為什麼兩端的字不一樣：學生端打的是自己的代碼，家長端打的是家長代碼，
 * 講錯欄位會讓人一直重打同一組碼。字不同不構成洩漏——
 * 洩漏是「同一個端點的不同失敗原因看得出差別」，不是「兩個端點的用字不同」。
 */
var STUDENT_DENY = '座號跟代碼對不起來，再確認一次。';
var PARENT_DENY = '座號跟家長代碼對不起來，再確認一次。';
var DENY_STATUS = 403;

/**
 * 在名冊裡找「這位學生」而且「指定欄位的代碼對得上」。
 *
 * field 是 'code'（學生個人代碼）或 'parentCode'（家長個人代碼）。
 * 兩者是不同的兩組碼，理由寫在 parent-view 那一段。
 *
 * 語意照抄 js/codes.js 的 findStudentByCode：指名（studentId 或 no）本身不給任何東西，
 * 找到人但碼不對就直接 null，不繼續往下找——不然同座號的兩個班會互相當備援。
 */
function pubFindByCode(classes, spec, field) {
  var list = classes || [];
  for (var i = 0; i < list.length; i++) {
    var cls = list[i];
    if (spec.classId && cls.id !== spec.classId) continue;
    var students = cls.students || [];
    for (var j = 0; j < students.length; j++) {
      var s = students[j];
      var named = spec.studentId
        ? s.id === spec.studentId
        : String(s.no) === String(spec.no === null || spec.no === undefined ? '' : spec.no).trim();
      if (!named) continue;
      return pubCodeMatches(spec.code, s[field]) ? { cls: cls, student: s } : null;
    }
  }
  return null;
}

/**
 * 認人的唯一入口。回 { cls, student } 或 null。
 *
 * 不參與記錄的學生一律回 null，跟「碼打錯」走同一條路、回同一句話。
 * 呼叫端只看得到 null，看不出是哪一種——這是刻意的，見檔頭。
 */
function pubVerify(spec, field) {
  var hit = pubFindByCode(readDoc('classes'), spec || {}, field);
  if (hit && pubIsOptedOut(hit.student)) return null;
  return hit;
}

// ───────────────────────── 投影（紅線都在這一段）─────────────────────────

/**
 * 這位學生的正向事件。正向、未撤銷。
 *
 * Turso 版是 `WHERE kind='positive' AND voided=0`，這裡是同樣條件的 filter——
 * 條件一個字都不放寬。回傳的每一筆是逐欄挑出來的，note 不在裡面
 * （備註是老師寫給自己看的，常常寫著待改進的來龍去脈）。
 */
function positiveEventsOf(studentId) {
  return eventsOf(studentId)
    .filter(function (e) {
      return e.kind === 'positive' && !e.voided;
    })
    .sort(function (a, b) {
      if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .map(function (e) {
      return {
        id: e.id,
        ts: e.ts,
        behaviorId: e.behaviorId,
        delta: Number(e.delta) || 0,
        period: e.period || '',
        // 後端已經只送正向、未撤銷的資料；補這兩個欄位是為了讓前端可以
        // 照樣把整包丟給 parentView() / shop-core.js 的純函式，
        // 維持「只有一個投影閘門」的形狀。
        kind: 'positive',
        studentId: studentId,
        voided: false,
      };
    });
}

/**
 * 餘額。在這裡加總完只送一個數字出去。
 *
 * 這一支就是紅線 3 本身：把逐筆事件撈回前端再加總，等於把待改進明細
 * 一起送出去了。所以扣分只以「總分變小」的形式離開後端。
 */
function balanceOfStudent(studentId) {
  return eventsOf(studentId).reduce(function (sum, e) {
    return e.voided ? sum : sum + (Number(e.delta) || 0);
  }, 0);
}

/** 尚未處理的兌換申請（delta 為 0，核可時老師端才真的扣點）。 */
function pendingRequestsOf(studentId) {
  return eventsOf(studentId)
    .filter(function (e) {
      return e.kind === 'redeem-request' && !e.voided;
    })
    .sort(function (a, b) {
      if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

/**
 * 班級榜的彙總。
 *
 * Turso 版是一句 GROUP BY，逐筆事件從頭到尾沒有離開資料庫。
 * 這裡拉了全表進記憶體（Sheets 沒有索引，這是遷移唯一的實質退步），
 * 所以「不外流」這件事改由「回傳值只有兩個數字」來守：
 * 這個函式回的是 { studentId: { net, weekDelta } }，沒有任何一筆事件。
 */
function rankAgg(classId, nowMs) {
  var now = nowMs || Date.now();
  var day = 86400000;
  var thisStart = new Date(now - 6 * day).toISOString();
  var lastStart = new Date(now - 13 * day).toISOString();
  var agg = {};
  allEvents().forEach(function (e) {
    if (e.voided) return;
    if (e.classId !== classId) return;
    var row = agg[e.studentId] || (agg[e.studentId] = { net: 0, weekDelta: 0 });
    var delta = Number(e.delta) || 0;
    row.net += delta;
    // 進步幅度只看行為事件：兌換花掉的點數不該被讀成「退步」。
    if (e.kind !== 'positive' && e.kind !== 'improve') return;
    if (e.ts >= thisStart) row.weekDelta += delta;
    else if (e.ts >= lastStart) row.weekDelta -= delta;
  });
  return agg;
}

// ───────────────────────── 路由 ─────────────────────────

/**
 * 班級清單。公開，因為前端要有東西可以選班才看得到榜。
 * 只有 id 與名稱，一個學生都不帶——名冊本身不是公開資料。
 */
function publicClasses() {
  return (readDoc('classes') || []).map(function (c) {
    return { id: c.id, name: c.name };
  });
}

/**
 * 舊版公開班級榜已停用。即使不含姓名，座號搭配淨分仍能識別學生表現。
 */
function publicRank(classId) {
  void classId;
  throw httpError('公開班級排行已停用，以保護學生表現資料。', 410);
}

/**
 * 學生的個人頁。要學生個人代碼。
 *
 * 回傳裡沒有：別人的任何資料、自己的待改進逐條明細、備註、代碼、姓名。
 * 扣分唯一的痕跡是 balance 這個數字比較小。
 */
function publicMe(body) {
  var hit = pubVerify(body, 'code');
  if (!hit) throw denied(STUDENT_DENY);
  var sid = hit.student.id;

  return {
    cls: { id: hit.cls.id, name: hit.cls.name },
    // 姓名不在試算表裡，前端一律顯示「N號」。
    student: { id: sid, no: hit.student.no, label: String(hit.student.no) + '號' },
    balance: balanceOfStudent(sid),
    // 連行為卡清單都先篩過，前端就沒有東西可以「不小心」把待改進的卡片畫出來。
    behaviors: (readDoc('behaviors') || [])
      .filter(function (b) {
        return b.kind === 'positive';
      })
      .map(function (b) {
        return { id: b.id, label: b.label, icon: b.icon, kind: 'positive', delta: b.delta };
      }),
    /*
     * 商店品項。下架的在這裡就篩掉，不是送出去讓前端自己濾——
     * 前端漏一個 filter，學生就會看到換不到的東西。
     * 只送畫一張卡片需要的五個欄位；備註、成本結構那些是老師端的事。
     */
    rewards: (readDoc('rewards') || [])
      .filter(function (r) {
        return r.active === true;
      })
      .map(function (r) {
        return {
          id: r.id,
          name: r.name,
          cost: Number(r.cost) || 0,
          // 不限量在試算表裡是 null／undefined，照原樣送，前端才分得出「不限量」與「剩 0 份」。
          stock: (r.stock === null || r.stock === undefined) ? null : Number(r.stock),
          active: true,
        };
      }),
    pending: pendingRequestsOf(sid).map(function (p) {
      return { id: p.id, ts: p.ts, name: p.note || '獎勵' };
    }),
    events: positiveEventsOf(sid),
  };
}

/**
 * 送出兌換申請。要學生個人代碼——用別人的名義送申請等於替別人把點數花掉。
 *
 * 可動用點數 = 餘額 − 已送出但還沒處理的申請所需點數。
 * 申請事件 delta 是 0，不先扣起來的話學生可以無限連按送申請。
 * 這一段一定要在後端算：前端算的版本，關掉 JS 就繞過去了。
 */
function publicRedeemRequest(body) {
  var hit = pubVerify(body, 'code');
  if (!hit) throw denied(STUDENT_DENY);

  var rewards = readDoc('rewards') || [];
  var reward = rewards.filter(function (r) {
    return r.id === body.rewardId && r.active;
  })[0];
  if (!reward) throw notFound('這項獎勵已經下架了。');
  if (reward.stock !== null && reward.stock !== undefined && reward.stock <= 0) {
    throw conflict('這項獎勵已經被換完了。');
  }

  var balance = balanceOfStudent(hit.student.id);
  var held = pendingRequestsOf(hit.student.id).reduce(function (sum, p) {
    var r = rewards.filter(function (x) {
      return x.id === p.behaviorId;
    })[0];
    return sum + ((r && r.cost) || 0);
  }, 0);
  var avail = balance - held;
  if (avail < reward.cost) {
    throw conflict('點數不夠，還差 ' + (reward.cost - avail) + ' 點。');
  }

  appendEventRow({
    id: uid(),
    ts: nowISO(),
    classId: hit.cls.id,
    studentId: hit.student.id,
    behaviorId: reward.id,
    delta: 0,
    kind: 'redeem-request',
    period: '',
    note: reward.name,
    voided: false,
  });
  return { ok: true, name: reward.name };
}

/**
 * 家長看自己孩子。要家長個人代碼。
 *
 * ── 為什麼家長代碼跟學生代碼是「不同的兩組」（存在同一個 student 物件上）──
 *
 * 存在哪：`classes` doc 的 student 物件上，欄位 `parentCode`，
 * 跟學生的 `code` 並排。理由跟 js/codes.js 當初把 code 放這裡一樣——
 * 代碼跟著名冊走，名冊怎麼同步、怎麼移出、怎麼刪除、怎麼標記不參與，
 * 代碼就怎麼跟著走，不必再開一張對不起來的表。
 *
 * 為什麼不共用同一組碼（三個理由，任一個都足以否決共用）：
 *
 *   1. 兩者的失效節奏天差地遠。學生代碼在教室裡是會傳開的（同學互相看），
 *      老師一學期會重發幾次；家長代碼是 LINE 發一次就長期用。共用的話，
 *      每一次「因為同學看到了」重發，都要再打一輪電話通知家長，反過來也一樣。
 *      一把鎖配兩種換鎖頻率，結果一定是老師乾脆都不換。
 *   2. 兩邊拿到的東西不一樣，共用等於互相升權。學生端拿得到餘額而且**花得掉**
 *      點數（redeem-request）；家長端拿得到正向紀錄的逐筆歷程。
 *      共用一組碼＝看到孩子紙條的同學可以看家長那份歷程，
 *      而家長可以用孩子的名義去換東西。
 *   3. 撤銷的語意不同。「這位家長的代碼外流了」要能單獨換掉，
 *      不能連帶把孩子鎖在個人頁外面。
 *
 * 這裡只負責「比對」，不負責產生：`parentCode` 的產生、重發、列印
 * 屬於老師端（js/codes.js ＋ codes.html，主線名下）。
 * 這一支對長度與字元集完全不設限——沒有 parentCode 的學生一律進不來
 * （pubCodeMatches 的空期望值不通過），不會因為老師還沒發碼就變成大門敞開。
 *
 * 回傳一樣只有正向、未撤銷。家長端沒有「老師核可」那一道了，
 * 所以這條紅線是這一版家長端唯一的保護，更不能鬆。
 */
function publicParentView(body) {
  var hit = pubVerify(body, 'parentCode');
  if (!hit) throw denied(PARENT_DENY);
  var sid = hit.student.id;

  return {
    cls: { id: hit.cls.id, name: hit.cls.name },
    // 姓名不在試算表裡。家長本來就知道自己孩子叫什麼，座號足夠對得上人。
    student: { id: sid, no: hit.student.no, label: '您的孩子（' + hit.student.no + '號）' },
    // 行為卡也只給正向的：待改進那幾張卡的名字本身就是一份「我們在盯什麼」的清單，
    // 而家長端反正一筆待改進事件都拿不到，那些卡片留著只會讓前端有機會畫錯東西。
    behaviors: (readDoc('behaviors') || [])
      .filter(function (b) {
        return b.kind === 'positive';
      })
      .map(function (b) {
        return { id: b.id, label: b.label, icon: b.icon, kind: 'positive', delta: b.delta };
      }),
    events: positiveEventsOf(sid),
  };
}

// ───────────────────────── 進入點 ─────────────────────────

function httpError(message, status) {
  var err = new Error(message);
  err.status = status;
  return err;
}
function denied(message) {
  return httpError(message, DENY_STATUS);
}
function notFound(message) {
  return httpError(message, 404);
}
function conflict(message) {
  return httpError(message, 409);
}

function publicReply(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(
    ContentService.MimeType.JSON,
  );
}

/*
 * 讀走 GET、要代碼的走 POST。
 *
 * 不是形式主義：GET 的 query string 會留在各種地方（瀏覽器歷史、家長轉貼的截圖、
 * Apps Script 的執行紀錄）。個人代碼進了那裡就等於印出來貼在走廊上。
 * 所以帶代碼的三條一律 POST，代碼只在 body 裡。
 */
function publicRoute(op, payload) {
  switch (op) {
    case 'health':
      return { name: '班級積分堂 · 家長學生端' };
    case 'classes':
      return publicClasses();
    case 'rank':
      return publicRank(payload.classId || '');
    case 'me':
      return publicMe(payload);
    case 'redeem-request':
      return publicRedeemRequest(payload);
    case 'parent-view':
      return publicParentView(payload);
    default:
      throw notFound('不認得的操作：' + op);
  }
}

/** 回應信封跟 Code.gs 一致：ContentService 設不了狀態碼，成敗只能寫在 body 裡。 */
function publicRpc(op, payload, allowed) {
  try {
    if (allowed.indexOf(op) < 0) {
      throw notFound('不認得的操作：' + op);
    }
    return { ok: true, result: publicRoute(op, payload || {}) };
  } catch (err) {
    return {
      ok: false,
      error: String((err && err.message) || err),
      status: (err && err.status) || 500,
    };
  }
}

/** GET：只有不需要代碼的三條。 */
function doGet(e) {
  var params = (e && e.parameter) || {};
  var op = params.op || 'health';
  return publicReply(publicRpc(op, params, ['health', 'classes', 'rank']));
}

/** POST：要代碼的三條。body 是 { op, payload }，content-type 用 text/plain 避開 CORS 預檢。 */
function doPost(e) {
  var raw = (e && e.postData && e.postData.contents) || '{}';
  var req;
  try {
    req = JSON.parse(raw);
  } catch (err) {
    return publicReply({ ok: false, error: '請求格式不正確。', status: 400 });
  }
  return publicReply(
    publicRpc(req.op, req.payload || {}, ['me', 'redeem-request', 'parent-view']),
  );
}
