/*
 * GAS 儲存層：與 js/store.js 的 LocalStore 完全同介面，資料放老師自己的 Google 試算表。
 *
 * 跟 store-cloud.js 的差別只有「話講給誰聽」：
 *   store-cloud.js → fetch 到 Cloudflare Pages Functions → Turso
 *   store-gas.js   → google.script.run 或 fetch → Apps Script 網頁應用程式 → Sheets
 *
 * 上層六個頁面只認 store-select.js 給的那個物件，所以這裡唯一的責任還是
 * 「長得跟 LocalStore 一模一樣」——多一個方法、少一個方法、簽名不同，都算沒做完。
 * （本檔刻意「不」接上 store-select.js：那是共用檔，由主線統一改。）
 *
 * ---- 為什麼是一支 RPC 端點，不是 REST 路徑 ----
 *
 * Apps Script 的網頁應用程式只有 doGet / doPost 兩個進入點，網址固定是
 * `https://script.google.com/macros/s/<id>/exec`，後面接不了 `/events/xxx/void`
 * 這種路徑（pathInfo 只有在少數部署形態下才有，靠它就是在賭）。
 * 所以這裡把 CloudStore 的十幾條路由收斂成一支 POST，body 裡帶 `{ op, payload }`。
 *
 * ---- 為什麼 content-type 是 text/plain ----
 *
 * GAS 不處理 CORS 預檢（OPTIONS）。送 `application/json` 會觸發預檢，直接失敗。
 * `text/plain;charset=utf-8` 屬於 CORS 的「簡單請求」，不預檢，body 照樣是 JSON 字串，
 * GAS 端用 `e.postData.contents` 讀得到一模一樣的東西。這不是偷懶，是唯一走得通的路。
 * 同理 credentials 必須是 'omit'：帶 cookie 會讓請求變成非簡單請求。
 *
 * 錯誤一律往外丟，不吞。老師在課堂上點了學生、畫面沒紅字、事實上沒記到，
 * 比當場噴錯還糟：噴錯至少他會重點一次。
 *
 * ---- 姓名分離（這一版的核心設計，見 docs/gas-contract.md）----
 *
 * 部署帳號是老師的個人 Gmail，所以 36 個欄位裡唯一能直接識別自然人的
 * `student.name` 不上雲。分離就做在這一層：
 *
 *   寫（init／saveClasses／importAll）：把 name 拆進 localStorage 的 cp:names，其餘才送上去
 *   讀（getClasses／exportAll）：把雲上的 classes 跟 cp:names 合起來還原
 *
 * 上層（app.js / roster.js / comments.js …）看到的永遠是有姓名的完整 classes，
 * 跟 LocalStore 一模一樣，一行都不用改。沒有對照表的裝置（換電腦、家長學生的手機）
 * 統一 fallback 成 `{no}號`，也集中在這裡做——上層各自判斷就一定會有人漏掉。
 */

/** 傳輸或伺服器出問題時丟這個。status 沿用 CloudStoreError 的語意：0 = 連不上。 */
export class GasStoreError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'GasStoreError';
    this.status = status;
  }
}

/**
 * 端點網址。GAS 的 /exec 網址是公開值（家長與學生的瀏覽器都看得到），不是秘密；
 * 真正的門鎖在 Apps Script 端（個人代碼、老師核可、部署權限），不在這條網址。
 *
 * 目前先從 globalThis 讀，方便單檔測試。
 * TODO（需主線改共用檔）：改成 `import { GAS_ENDPOINT } from './config.js'`。
 */
function defaultEndpoint() {
  return (typeof globalThis !== 'undefined' && globalThis.CP_GAS_ENDPOINT) || '';
}

/**
 * 傳輸層之一：同源的 google.script.run。
 * 只有在整個前端由 HtmlService 端出來（跟 Apps Script 同一個 googleusercontent 沙箱）
 * 時才存在。它是 callback 式的、沒有 Promise，也沒有 fetch 的那套 Response，
 * 所以包成 Promise 讓上層感覺不到差別。
 */
export function googleScriptRunTransport() {
  return (req) =>
    new Promise((resolve, reject) => {
      const runner = globalThis.google && globalThis.google.script && globalThis.google.script.run;
      if (!runner) {
        reject(new GasStoreError('這個頁面不是由 Apps Script 端出來的，沒有 google.script.run', 0));
        return;
      }
      runner
        .withSuccessHandler((raw) => {
          try {
            resolve(unwrap(typeof raw === 'string' ? JSON.parse(raw) : raw));
          } catch (err) {
            reject(err instanceof GasStoreError ? err : new GasStoreError(err.message, 0));
          }
        })
        // google.script.run 的失敗處理拿到的是 Error，沒有 HTTP 狀態可用。
        .withFailureHandler((err) => reject(new GasStoreError(`Apps Script 執行失敗：${err && err.message}`, 0)))
        .rpc(JSON.stringify(req));
    });
}

/** 傳輸層之二：跨網域 fetch 到 /exec。理由見檔頭。 */
export function fetchTransport(endpoint) {
  return async (req) => {
    if (!endpoint) throw new GasStoreError('尚未設定 Apps Script 端點網址', 0);
    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        // 這一行不可以改成 application/json，改了就會觸發 CORS 預檢而全盤失敗。
        headers: { 'content-type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(req),
        credentials: 'omit',
        // GAS 的 /exec 會 302 到 script.googleusercontent.com 才吐內容，一定要跟。
        redirect: 'follow',
      });
    } catch (err) {
      throw new GasStoreError(`連不上 Apps Script：${err.message}`, 0);
    }

    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        /*
         * GAS 出錯時吐的是一整頁 HTML（登入頁或錯誤頁），不是 JSON。
         * 最常見的兩種原因：部署的存取權限不是「任何人」，或者網址複製到 /dev 而不是 /exec。
         */
        throw new GasStoreError(
          `Apps Script 回的不是 JSON（HTTP ${res.status}）——多半是部署權限或網址不對`,
          res.status,
        );
      }
    }
    if (!res.ok) throw new GasStoreError(`Apps Script 錯誤（HTTP ${res.status}）`, res.status);
    return unwrap(data);
  };
}

/**
 * GAS 端一律以 HTTP 200 回應（ContentService 沒有辦法設狀態碼），
 * 所以「成功還是失敗」只能看 body 的 ok 欄位，錯誤碼放在 status。
 * 這一層把它翻回呼叫端熟悉的「丟例外」語意。
 */
function unwrap(data) {
  if (!data || typeof data !== 'object') throw new GasStoreError('Apps Script 回應格式不對', 0);
  if (data.ok === false) throw new GasStoreError(data.error || 'Apps Script 錯誤', data.status || 500);
  return data.result;
}

/** 沒指定就自己挑：同源沙箱優先，否則走 fetch。 */
function autoTransport(endpoint) {
  return (req) => {
    const inSandbox = !!(globalThis.google && globalThis.google.script && globalThis.google.script.run);
    return (inSandbox ? googleScriptRunTransport() : fetchTransport(endpoint))(req);
  };
}

/**
 * 幫每一次 RPC 附上 ID token，並在拿到 401 的時候換一枚重試一次。
 *
 * ---- 為什麼 token 塞在 body 而不是 Authorization 標頭 ----
 *
 * 自訂標頭（含 Authorization）會讓請求變成 CORS 的「非簡單請求」，
 * 瀏覽器會先送一個 OPTIONS 預檢——而 Apps Script 的網頁應用程式沒有辦法回應 OPTIONS。
 * 預檢失敗，整個請求連送都送不出去。所以 token 只能跟 op／payload 一起放在 JSON body 裡。
 * 這不是偷懶，跟檔頭那個 `text/plain` 是同一個限制的兩個面向。
 *
 * ---- 為什麼只重試一次 ----
 *
 * 401 有兩種可能：token 過期了（重取一枚就好），或這個 Google 帳號根本不是這份部署的老師
 * （重取幾次都一樣）。重試第二次只會讓老師連續看到兩三次登入框，然後還是失敗。
 * 一次之後就把錯誤原樣往上丟，讓他看得到「沒有權限」這句話。
 */
export function withAuth(inner, { getToken, onAuthFail = () => {} }) {
  return async (req) => {
    let token = await getToken();
    try {
      return await inner({ ...req, idToken: token });
    } catch (err) {
      if (!(err instanceof GasStoreError) || err.status !== 401) throw err;
      onAuthFail();
      token = await getToken();
      return inner({ ...req, idToken: token });
    }
  };
}

/** 事件 id。跟 js/store.js 的 uid() 同一套，兩個儲存層產出的 id 才不會長得不一樣。 */
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ================= 姓名對照表：只存在老師這台裝置的 localStorage ================= */

/**
 * 對照表的 key。形狀 `{ "c701-s13": "洪語彤" }`，只有這一個 key，不分班——
 * 分班存的話，班級改名或合班時會出現孤兒 key，反而更難清乾淨。
 */
export const NAMES_KEY = 'cp:names';

/** localStorage 在 Node（測試）與 GAS 伺服器端不存在，拿不到就當成空的對照表。 */
function ls() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

/** 讀對照表。壞掉的 JSON 當成空的，不讓一個壞掉的 key 卡死整個畫面。 */
export function readNameMap() {
  const store = ls();
  if (!store) return {};
  try {
    const raw = store.getItem(NAMES_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 寫對照表。沒有 localStorage（公開端、測試）就靜靜跳過：
 * 那些情境本來就不該有姓名，寫不進去是正確結果，不是錯誤。
 */
export function writeNameMap(map) {
  const store = ls();
  if (!store) return;
  store.setItem(NAMES_KEY, JSON.stringify(map));
}

/** 沒有對照表時上層看到的名字。座號是雲端本來就有的，不算個資。 */
function fallbackName(student) {
  return `${student.no}號`;
}

/**
 * 這個 name 值得記進對照表嗎？
 *
 * 關鍵在第二個條件：沒有對照表的裝置讀到的是 fallback 的「13號」，
 * 上層若原樣存回來（例如換座位、改班級名稱都會整包 saveClasses），
 * 「13號」就會被當成真名寫進對照表，之後那台電腦永遠顯示 13號 而不是真名。
 */
function isRealName(name, student) {
  return typeof name === 'string' && name.trim() !== '' && name !== fallbackName(student);
}

/** 這個 studentId 屬於這批 classes 裡的某一班嗎？依 `{classId}-s{n}` 的命名慣例判斷。 */
function belongsTo(studentId, classIds) {
  return classIds.some((cid) => studentId.startsWith(`${cid}-`));
}

/**
 * 拆：回傳「拿掉 name 的 classes」與「這批 classes 帶來的姓名」。
 * 不改動呼叫端傳進來的物件（上層還握著同一份參考在畫面上用）。
 * 沒有 students 陣列的班級原樣放行——硬塞一個空陣列會改變送上雲的形狀。
 */
function splitNames(classes) {
  const names = {};
  if (!Array.isArray(classes)) return { stripped: classes, names };
  const stripped = classes.map((cls) => {
    if (!cls || !Array.isArray(cls.students)) return cls;
    const students = cls.students.map((stu) => {
      if (!stu || typeof stu !== 'object') return stu;
      const { name, ...rest } = stu;
      if (isRealName(name, stu)) names[stu.id] = name;
      return rest;
    });
    return { ...cls, students };
  });
  return { stripped, names };
}

/** 合：把對照表接回雲上的 classes。查不到就用座號，讓上層永遠有東西可以顯示。 */
function mergeNames(classes, map = readNameMap()) {
  if (!Array.isArray(classes)) return classes;
  return classes.map((cls) => {
    if (!cls || !Array.isArray(cls.students)) return cls;
    return {
      ...cls,
      students: cls.students.map((stu) =>
        stu && typeof stu === 'object' ? { ...stu, name: map[stu.id] || fallbackName(stu) } : stu,
      ),
    };
  });
}

/**
 * 把一次寫入帶來的姓名記進對照表，同時清掉「這批班級裡已經不存在的學生」。
 *
 * 清除範圍只到這批 payload 涵蓋的班級：所有呼叫端目前都是整包 state.classes 存回來，
 * 但萬一哪天有人只存一個班，也不該把其他班的姓名連坐清掉（那是救不回來的資料損失）。
 * 反過來說，被移出名冊的學生一定要當場清掉——不清就是個資留在裝置上。
 */
function recordNames(classes, names) {
  if (!Array.isArray(classes)) return;
  const map = readNameMap();
  const classIds = classes.filter((c) => c && c.id).map((c) => c.id);
  const alive = new Set(
    classes.flatMap((c) => (c && Array.isArray(c.students) ? c.students.map((s) => s && s.id) : [])),
  );
  for (const id of Object.keys(map)) {
    if (belongsTo(id, classIds) && !alive.has(id)) delete map[id];
  }
  Object.assign(map, names);
  writeNameMap(map);
}

/** 刪掉對照表裡符合條件的項目。回傳有沒有真的動到。 */
function dropNames(predicate) {
  const map = readNameMap();
  let changed = false;
  for (const id of Object.keys(map)) {
    if (predicate(id)) {
      delete map[id];
      changed = true;
    }
  }
  if (changed) writeNameMap(map);
  return changed;
}

/**
 * 建一個 GAS 儲存層。
 *
 * @param {object}   [opts]
 * @param {string}   [opts.endpoint]   Apps Script 的 /exec 網址
 * @param {Function} [opts.transport]  注入傳輸層，測試用（收 { op, payload }，回結果）
 * @param {Function} [opts.getToken]   回一枚 Google ID token 的 async 函式；有給才會加驗證層
 * @param {Function} [opts.onAuthFail] 收到 401 時呼叫，用來清掉快取的 token
 *
 * 注意：回傳物件的鍵必須跟 LocalStore 完全相同，所以 endpoint／transport
 * 一律留在閉包裡，不掛成物件屬性——掛上去介面一致性測試就會紅。
 */
export function createGasStore({ endpoint = defaultEndpoint(), transport, getToken, onAuthFail } = {}) {
  const base = transport || autoTransport(endpoint);
  // 沒給 getToken 就不套驗證層：測試與 gas/selftest 都直接注入 transport，
  // 那些情境沒有瀏覽器也沒有 Google 登入。真正的頁面一律由 store-select.js 給。
  const send = getToken ? withAuth(base, { getToken, onAuthFail }) : base;
  const call = (op, payload = {}) => send({ op, payload });

  return {
    name: 'Google 試算表',

    async init(seed) {
      // 種子資料（示範班級）也走同一條分離路徑，姓名不因為是「示範」就例外上雲。
      const { stripped, names } = splitNames(seed && seed.classes);
      const payload = seed && typeof seed === 'object' ? { ...seed, classes: stripped } : seed;
      await call('init', { seed: payload });
      recordNames(seed && seed.classes, names);
    },

    // ---- 事件 ----

    /**
     * 記一筆行為。delta 由行為卡帶入，呼叫端不得自由填分數。
     *
     * id 在前端產、當成冪等鍵送上去，GAS 端看到同一個 id 就不再寫第二列。
     * 理由：會重送的情境（課堂上網路不穩、老師連點兩下、GAS 逾時但其實寫進去了）
     * 都發生在前端，只有前端知道「這是同一次動作的重試」；GAS 端自己產 id 的話，
     * 每一次重試都是一個新 id，怎麼擋都擋不掉。
     *
     * ⚠️ 待對齊（S1）：這是本線的假設，冪等實作在 S1 那邊。若 S1 決定 id 由 GAS 產，
     * 這裡要改成送一個獨立的 requestId 欄位，`uid()` 與這段註解一起改。
     * ts 仍由 GAS 端 `nowISO()` 決定——時間要有單一來源，不能讓各裝置的時鐘各說各話。
     */
    async appendEvent({ classId, studentId, behaviorId, delta, kind, period, note }) {
      return call('appendEvent', { id: uid(), classId, studentId, behaviorId, delta, kind, period, note });
    },

    /** 撤銷不刪除，保留稽核軌跡。GAS 端只把 voided 欄位改成 1，不刪列。 */
    async voidEvent(id) {
      return call('voidEvent', { id });
    },

    async queryEvents({ classId, studentId, since, until, includeVoided = false } = {}) {
      // 篩選一律送到 GAS 端做。把整份事件抓回瀏覽器再過濾，
      // 等於把待改進的明細也一起送出去了（家長端與學生端共用這一層）。
      return call('queryEvents', { classId, studentId, since, until, includeVoided });
    },

    // ---- 設定 ----

    /** 雲上的 classes ＋ 本機對照表 = 上層看到的完整 classes（跟 LocalStore 一模一樣）。 */
    async getClasses() {
      return mergeNames(await call('getDoc', { name: 'classes' }));
    },
    /** 姓名留在本機，其餘欄位才上雲。這條線上的 JSON 一個姓名都沒有。 */
    async saveClasses(classes) {
      const { stripped, names } = splitNames(classes);
      await call('saveDoc', { name: 'classes', value: stripped });
      // 先確定雲端寫成功才動對照表：RPC 失敗時本機姓名維持原狀，重試一次就好。
      recordNames(classes, names);
    },
    async getBehaviors() {
      return call('getDoc', { name: 'behaviors' });
    },
    async saveBehaviors(behaviors) {
      await call('saveDoc', { name: 'behaviors', value: behaviors });
    },
    /** 積分商店的獎勵品項（第二期 2.2）。 */
    async getRewards() {
      return call('getDoc', { name: 'rewards' });
    },
    async saveRewards(rewards) {
      await call('saveDoc', { name: 'rewards', value: rewards });
    },

    async getSettings() {
      return call('getDoc', { name: 'settings' });
    },
    async saveSettings(settings) {
      await call('saveDoc', { name: 'settings', value: settings });
    },

    /**
     * 整份匯出。**含姓名**——這是想過之後的決定，不是漏掉。
     *
     * 匯出檔同時是「換電腦搬家用」與「備份用」，兩個用途都指向同一個結論：
     *   1. 不含姓名的話，老師的電腦一壞，那份對照表就真的沒有第二份了。
     *      雲端依設計不存姓名，救不回來——這個設計的代價不能大到「硬碟壞掉＝全班變號碼」。
     *   2. 含姓名的匯出檔，配上 importAll 會把姓名重新拆回新機器的 cp:names，
     *      是換裝置時唯一能讓 studentId 完全對得上的路徑（重貼名冊會產生新 id，見下方註記）。
     *   3. 匯出動作發生在老師自己的裝置、產生的是一個下載到本機的檔案，全程不經過雲端。
     *      這跟「姓名不上雲」沒有衝突：紅線是「不要進 Sheets」，不是「不准存在老師電腦上」。
     *
     * 代價要講清楚（S4 的部署指南與 privacy.html 要寫）：這個備份檔含個資，
     * 等同一份紙本名冊，不能隨手丟共用雲端硬碟或用 email 轉寄。
     */
    async exportAll() {
      const dump = await call('exportAll', {});
      if (!dump || typeof dump !== 'object' || !Array.isArray(dump.classes)) return dump;
      return { ...dump, classes: mergeNames(dump.classes) };
    },

    /*
     * ---- 刪除 ----
     * 跟 voidEvent 是兩件事：void 是「記錯了」要留稽核軌跡，
     * purge 是「畢業／轉學了，目的消失」要真的刪掉（個資法第 11 條第 3 項）。
     * 在 Sheets 上這是唯一會真的 deleteRows 的路徑。
     */

    /**
     * 刪掉某位學生的全部事件（含已撤銷的）。回傳刪了幾筆。
     * 同時清掉他在 cp:names 的那一筆——雲端刪乾淨了、名字還留在老師的瀏覽器裡，
     * 就等於個資沒刪。這條在 GAS 版比 Cloudflare 版更要緊，因為姓名只存在這裡。
     */
    async purgeStudent({ classId, studentId }) {
      const result = await call('purgeStudent', { classId, studentId });
      dropNames((id) => id === studentId);
      return result;
    },

    /** 刪掉整個班級的全部事件。回傳刪了幾筆。對照表同班的姓名一起清掉。 */
    async purgeClass(classId) {
      const result = await call('purgeClass', { classId });
      // 依 `{classId}-s{n}` 的命名慣例比對（roster.js makeStudents 與 data.js buildClass 都照這個產）。
      if (classId) dropNames((id) => id.startsWith(`${classId}-`));
      return result;
    },

    /**
     * 整份還原（B.4 匯入用）。事件照原樣寫回，id 與 ts 都不重編。
     * 匯入檔含姓名（見 exportAll），所以這裡要再拆一次：姓名進 cp:names，其餘上雲。
     * 這也是換裝置的正路——studentId 完全沿用備份檔裡的，事件對得回原本的人。
     */
    async importAll(payload) {
      const { stripped, names } = splitNames(payload && payload.classes);
      const clean = payload && typeof payload === 'object' ? { ...payload, classes: stripped } : payload;
      const result = await call('importAll', { payload: clean });
      // 整份還原是「換掉全部」，對照表也整份換掉，避免上一份資料的姓名殘留。
      writeNameMap(names);
      return result;
    },

    /** 清空一切。cp:names 一起清——留著就是清了雲端卻沒清裝置。 */
    async resetAll() {
      await call('resetAll', {});
      const store = ls();
      if (store) store.removeItem(NAMES_KEY);
    },
  };
}

/** 預設實例，給頁面直接用（等主線把 GAS_ENDPOINT 放進 config.js 之後才會真的通）。 */
export const GasStore = createGasStore();
