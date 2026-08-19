/*
 * GAS 管理端的登入：拿一枚 Google ID token 給 Apps Script 驗。
 *
 * ---- 跟 js/auth.js 是兩套，不要合併 ----
 *
 * js/auth.js 服務的是 Cloudflare 那條線：授權碼流程，client secret 在後端，
 * session 是 HttpOnly cookie，前端連 token 長什麼樣都看不到。那是正統作法。
 *
 * GAS 這條線沒有那個條件——Apps Script 端沒有地方安全地放 client secret，
 * 也發不出 cookie 給另一個網域。所以改用純前端的隱含式流程：
 * Google Identity Services 直接給一枚 ID token（JWT），前端把它附在每一次 RPC 上，
 * Apps Script 端問 Google 這枚 token 是誰的（gas/Auth.gs）。
 *
 * 這樣做的安全性來自三件事，缺一不可：
 *   1. token 是 Google 簽的，前端偽造不了
 *   2. Client ID 綁死了「授權的 JavaScript 來源」，別的網站拿不到發給我們的 token
 *   3. Apps Script 端比對 token 裡的 email 是不是這份部署的老師
 *
 * ---- token 放哪裡 ----
 *
 * sessionStorage，不是 localStorage。這個站是多頁式的（14 個 .html），
 * 純記憶體會讓老師每點一次分頁就重登一次，那是沒人受得了的。sessionStorage
 * 跟著分頁走，關掉分頁就沒了，是這兩者之間唯一站得住的折衷。
 *
 * ID token 活一小時。過期時 Apps Script 回 401，store-gas.js 會清掉快取重取一次。
 */

const GIS_SRC = 'https://accounts.google.com/gsi/client';

/** sessionStorage 的 key。跟 cp:names 用同一個前綴，清理的時候一眼看得出是誰的。 */
export const TOKEN_KEY = 'cp:gas-idtoken';

/**
 * 提早多久當成過期。
 * 剛好卡在到期那一秒送出去的請求，等它抵達 Google 就已經無效了。
 */
const SKEW_SECONDS = 120;

function ss() {
  try {
    return globalThis.sessionStorage || null;
  } catch {
    return null;
  }
}

/**
 * 讀出 JWT 的 payload。
 * 這不是驗證——前端驗自己拿到的 token 沒有意義，真正的驗證在 Apps Script 端。
 * 這裡只是想知道 exp，好在過期前先換一枚，少一次來回。
 */
export function decodeJwt(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(
      atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
        .split('')
        .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
        .join(''),
    );
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** 這枚 token 現在還能用嗎？解不開的一律當成不能用。 */
export function isFresh(token, now = Date.now()) {
  const payload = decodeJwt(token);
  if (!payload || !payload.exp) return false;
  return Number(payload.exp) - SKEW_SECONDS > now / 1000;
}

export function readToken() {
  const store = ss();
  if (!store) return '';
  const token = store.getItem(TOKEN_KEY) || '';
  if (token && isFresh(token)) return token;
  if (token) store.removeItem(TOKEN_KEY);
  return '';
}

export function clearToken() {
  const store = ss();
  if (store) store.removeItem(TOKEN_KEY);
}

function writeToken(token) {
  const store = ss();
  if (store) store.setItem(TOKEN_KEY, token);
}

/* ================= Google Identity Services ================= */

let gisLoading = null;

/** 把 GIS 的 script 載進來。重複呼叫共用同一個 Promise，不會載第二次。 */
function loadGis() {
  if (globalThis.google?.accounts?.id) return Promise.resolve();
  if (gisLoading) return gisLoading;
  gisLoading = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = GIS_SRC;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => {
      gisLoading = null;
      reject(new Error('載不到 Google 登入元件，請確認這台電腦連得上 accounts.google.com'));
    };
    document.head.appendChild(el);
  });
  return gisLoading;
}

/**
 * 蓋一層登入畫面，中間放 Google 官方的登入按鈕。
 *
 * 為什麼不用 One Tap（`prompt()`）就好：One Tap 會被瀏覽器的第三方 cookie 設定、
 * 無痕模式、以及使用者先前的「稍後再說」給無聲擋掉，擋掉的時候畫面上什麼都不會發生。
 * 老師只會看到一個永遠轉圈的頁面，而且完全不知道要點哪裡。
 * 官方按鈕是使用者主動點的，沒有這個問題。One Tap 只當加速用（有就省一次點擊）。
 */
function showSignIn(clientId) {
  return new Promise((resolve, reject) => {
    const mask = document.createElement('div');
    mask.className = 'gas-signin-mask';
    mask.setAttribute('role', 'dialog');
    mask.setAttribute('aria-modal', 'true');
    mask.setAttribute('aria-label', '登入班級積分堂');
    mask.innerHTML = `
      <div class="gas-signin-box">
        <h2>請先登入</h2>
        <p>這個班級積分堂的資料存在你自己的 Google 試算表裡，
           要先確認是你本人才打得開。</p>
        <div class="gas-signin-btn"></div>
        <p class="gas-signin-note">只會用到你的 Google 帳號來確認身分，不會讀取你的信件或雲端硬碟。</p>
      </div>`;
    document.body.appendChild(mask);

    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      mask.remove();
      fn(arg);
    };

    globalThis.google.accounts.id.initialize({
      client_id: clientId,
      callback: (res) => {
        if (res && res.credential) finish(resolve, res.credential);
        else finish(reject, new Error('Google 沒有回傳登入憑證，請再試一次。'));
      },
      auto_select: true,
      cancel_on_tap_outside: false,
    });
    globalThis.google.accounts.id.renderButton(mask.querySelector('.gas-signin-btn'), {
      theme: 'filled_blue',
      size: 'large',
      text: 'signin_with',
      locale: 'zh_TW',
    });
    // 有 One Tap 就省一次點擊；被擋掉也無所謂，上面那顆按鈕還在。
    try {
      globalThis.google.accounts.id.prompt();
    } catch {
      /* One Tap 不是必要路徑，失敗就當它不存在 */
    }
  });
}

/**
 * 同時間只跑一次登入流程。
 * 進站時常常好幾個 RPC 一起發（getClasses / getBehaviors / queryEvents），
 * 不共用的話會同時彈出三層登入框。
 */
let pending = null;

/**
 * 取得可用的 ID token。有快取就用快取，沒有就請老師登入。
 *
 * @param {string} clientId Google OAuth 用戶端 ID（config.js 的 GOOGLE_CLIENT_ID）
 */
export function getIdToken(clientId) {
  const cached = readToken();
  if (cached) return Promise.resolve(cached);
  if (!clientId) {
    return Promise.reject(
      new Error('尚未設定 GOOGLE_CLIENT_ID，Apps Script 版沒有這個就沒有辦法確認身分。'),
    );
  }
  if (pending) return pending;
  pending = loadGis()
    .then(() => showSignIn(clientId))
    .then((token) => {
      writeToken(token);
      return token;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}
