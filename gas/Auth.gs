/*
 * 班級積分堂 · 管理端身分驗證
 *
 * ---- 為什麼需要這一層（這是被實測逼出來的，不是設計潔癖）----
 *
 * 原本管理端的部署權限是「只有我自己」，想法是「讓 Google 的登入牆當門鎖」。
 * 那個想法在 curl 上驗得過，在瀏覽器裡卻完全走不通，原因是 CORS：
 *
 *   - `/exec` 遇到未登入的請求，會 302 到 accounts.google.com。
 *     那個轉址回應沒有 Access-Control-Allow-Origin，跨網域的 fetch 直接被瀏覽器擋掉，
 *     連狀態碼都拿不到，只看得到一句 `Failed to fetch`。
 *   - 想帶 Google 的 session cookie 就得用 `credentials: 'include'`，
 *     但 Google 回的是 `Access-Control-Allow-Origin: *`，`*` 跟 include 在規範上互斥，
 *     一樣被擋。
 *
 * 兩條路都是死的：**只要前端不是同源，「只有我自己」這個權限就用不了。**
 * 所以部署權限改成「任何人（包含匿名）」，門鎖從 Google 的登入牆搬進程式碼裡——
 * 也就是這一支檔案。每一個管理操作都必須附上一枚 Google ID token，
 * 這裡驗它是不是 Google 簽的、是不是發給我們這個 Client ID 的、
 * 以及裡面那個 email 是不是這份部署的老師本人。三個條件缺一不可。
 *
 * ---- 為什麼不自己驗簽章 ----
 *
 * 自己驗要抓 Google 的 JWKS、解 RSA、比對 kid、處理輪替金鑰。Apps Script 沒有現成的
 * RS256 驗證，手寫一份等於自己實作密碼學——那是最不該自己寫的東西。
 * 改打 Google 官方的 tokeninfo 端點：它會替我們驗簽章與有效期，
 * 驗不過就不是 200。我們只需要再檢查「這枚 token 是發給誰、屬於誰」。
 *
 * 代價是每次請求多一趟外部 HTTP（約 200–400ms）。所以驗過的 token 進 CacheService，
 * 有效期內同一枚 token 只查一次 Google。快取的 key 是 token 的 SHA-256，不是 token 本身，
 * 免得整枚憑證躺在快取裡。
 */

/**
 * 驗不過時一律講同一句話。
 *
 * 不區分「沒帶 token」「token 過期」「不是這個 Client ID」「不是老師本人」——
 * 分得越細，外面的人越容易靠錯誤訊息摸出這份部署的設定長什麼樣。
 * 老師自己遇到的時候，前端會直接把他帶去重新登入，看不到這句話。
 */
var AUTH_FAIL = '沒有權限。請重新登入這個班級積分堂。';

/** 尚未設定時的訊息。這一句要講清楚，因為只有老師自己（在部署時）會看到。 */
var AUTH_UNCONFIGURED =
  '這份部署還沒設定 GOOGLE_CLIENT_ID 與 TEACHER_EMAIL。' +
  '請到 Apps Script 專案的「專案設定 → 指令碼屬性」補上，見 docs/gas-deploy.md。';

/** tokeninfo 說了算的簽發者。Google 目前兩種寫法都會出現。 */
var GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

/**
 * 快取上限。ID token 本身活一小時，這裡取 50 分鐘留安全邊際——
 * 快取比 token 活得久的話，會出現「token 早就過期了但我們還放行」的破口。
 */
var AUTH_CACHE_MAX_SECONDS = 3000;

function authProps() {
  var props = PropertiesService.getScriptProperties();
  var clientId = String(props.getProperty('GOOGLE_CLIENT_ID') || '').trim();
  var teacher = String(props.getProperty('TEACHER_EMAIL') || '')
    .trim()
    .toLowerCase();
  if (!clientId || !teacher) throw new Error(AUTH_UNCONFIGURED);
  return { clientId: clientId, teacher: teacher };
}

/** 拿 token 的 SHA-256 當快取 key。整枚憑證不進快取。 */
function tokenCacheKey(idToken) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken, Utilities.Charset.UTF_8);
  return 'idtok:' + Utilities.base64EncodeWebSafe(bytes);
}

/**
 * 問 Google 這枚 ID token 的內容。
 * 簽章與有效期由 Google 驗；非 200 一律當成不合格，不去分辨原因。
 */
function fetchTokenInfo(idToken) {
  var res = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
    { muteHttpExceptions: true },
  );
  if (res.getResponseCode() !== 200) return null;
  try {
    return JSON.parse(res.getContentText());
  } catch (err) {
    return null;
  }
}

/**
 * 驗證這枚 ID token 屬於這份部署的老師，驗不過就丟例外。
 * 通過時回傳 email（呼叫端目前不用，但除錯時想知道是誰進來的）。
 *
 * @param {string} idToken 前端從 Google Identity Services 拿到的 JWT
 */
function verifyTeacher(idToken) {
  var cfg = authProps(); // 沒設定就先炸，這是部署疏漏不是權限問題
  if (!idToken || typeof idToken !== 'string') throw new Error(AUTH_FAIL);

  var cache = CacheService.getScriptCache();
  var key = tokenCacheKey(idToken);
  if (cache.get(key) === cfg.teacher) return cfg.teacher;

  var info = fetchTokenInfo(idToken);
  if (!info) throw new Error(AUTH_FAIL);
  // aud 是「這枚 token 是發給哪個應用程式的」。不比對的話，
  // 任何一個 Google 應用程式簽出來的 token 都能拿來打我們這支端點。
  if (info.aud !== cfg.clientId) throw new Error(AUTH_FAIL);
  if (GOOGLE_ISSUERS.indexOf(String(info.iss)) < 0) throw new Error(AUTH_FAIL);
  // email_verified 在 tokeninfo 的回應裡是字串 "true"，不是布林值。
  if (String(info.email_verified) !== 'true') throw new Error(AUTH_FAIL);
  if (String(info.email || '').toLowerCase() !== cfg.teacher) throw new Error(AUTH_FAIL);

  // exp 是秒級 Unix 時間。快取活不過 token 本身。
  var remaining = Math.floor(Number(info.exp) - Date.now() / 1000);
  var ttl = Math.min(AUTH_CACHE_MAX_SECONDS, remaining - 60);
  if (ttl > 0) cache.put(key, cfg.teacher, ttl);
  return cfg.teacher;
}
