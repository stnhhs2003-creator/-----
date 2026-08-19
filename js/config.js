/*
 * 全站設定。這裡不放任何金鑰——雲端的金鑰只存在 Cloudflare Pages 的環境變數，
 * 前端拿得到的東西一律當成公開資訊看待。
 */

/*
 * 儲存層三選一。
 *
 *   'local'  只在這台瀏覽器裡（預設）
 *   'cloud'  Cloudflare Pages ＋ Turso，Google 登入
 *   'gas'    Google 試算表（Apps Script），部署在老師自己的 Google 帳號底下
 *
 * 預設 'local'，而且在「個資盤點」（ROADMAP B.3）完成、學校端確認過保存期限之前
 * 不得改成 'cloud'。學生姓名一旦離開老師自己的瀏覽器就是另一回事，
 * 這個開關是那條線的實體閘門，不是設定選項。
 *
 * 'gas' 是例外，因為那條線的姓名根本不出這台電腦（拆在 js/store-gas.js），
 * 上雲的只有座號與事件流——但換裝置前一定要先匯出備份，見 docs/gas-deploy.md。
 */
export const STORE_BACKEND = 'gas';

/**
 * 舊名，保留給 parent.js／bindings.js 用。語意不變：只有 Cloudflare 那條線算「雲端」，
 * GAS 版走的是完全不同的驗證方式（家長代碼，不是 Google 登入），不能共用這個分支。
 */
export const CLOUD_ENABLED = STORE_BACKEND === 'cloud';

/*
 * 兩支 Apps Script 部署網址（`STORE_BACKEND = 'gas'` 才會用到）。
 *
 * 一定是兩個獨立的 Apps Script 專案，不是同一個專案的兩個部署——
 * 一個專案只有一組 doPost，匿名那份會連管理操作一起分派出去。理由見 docs/gas-deploy.md。
 *
 *   admin   老師端。權限「只有我自己」，掛滿所有管理操作。
 *   public  家長端與學生端。權限「任何人」，只有投影過的唯讀路由。
 *
 * 這兩個網址不是秘密（會出現在前端原始碼裡）；擋人的是部署權限與伺服器端投影，
 * 不是網址難猜。
 */
export const GAS_ENDPOINT = {
  // 這兩行由 `npm run setup` 自動填。自己填也可以，格式長這樣：
  //   https://script.google.com/macros/s/AKfycb.../exec
  admin: 'https://script.google.com/macros/s/AKfycbz-vRr_SPWt4atudnDBG2YzhZPUo0mgCOOdooyFaxRxwj2As1Wg3d5oLB-ci9uFgqCQ3Q/exec',
  public: 'https://script.google.com/macros/s/AKfycbwURbvcx4ABLfOSFrVLz--jUBD2IwUF6cqw1i0-PIyojhUoZimUjqKLs0a3MRaxiyTVDg/exec',
};

/*
 * Google 登入的 Client ID。這是公開值（會出現在前端原始碼裡），不是秘密。
 *
 * 兩條線都用它，但用法完全不同：
 *   'cloud' → Cloudflare 那條線的授權碼流程；對應的 client secret 只在 Pages 環境變數
 *   'gas'   → 前端直接拿一枚 ID token（js/gas-auth.js），完全不需要 secret
 *
 * ⚠️ GAS 版：這個值必須跟管理端 Apps Script 專案的 Script Property
 * `GOOGLE_CLIENT_ID` **一模一樣**。gas/Auth.gs 比對每一枚 token 的 aud 是不是它；
 * 兩邊對不上，老師會一直被擋在登入框外面而且看不出原因。
 *
 * 擋人的是「aud 等於它」＋「email 等於 TEACHER_EMAIL」的組合，不是這串字難猜。
 * 另外它只在「已授權的 JavaScript 來源」列出的網域上發得出 token，見 docs/gas-deploy.md §8.3。
 */
// 這一行由 `npm run setup` 自動填（你在 Google Cloud 建好用戶端後貼給它）。
export const GOOGLE_CLIENT_ID = '';

/*
 * 潤稿服務（第三期）的開關。
 *
 * 關著的時候，三個文字功能照樣完整運作——只是輸出的是資料組出來的骨架，
 * 語氣比較生硬而已。打開才會把骨架送去 LLM 潤飾，那一步要花錢。
 * 預設 false：不該有人在不知情的狀況下開始燒 API 額度。
 */
export const AI_ENABLED = false;

/** 後端 API 的路徑前綴。資料、登入、潤稿三個命名空間，各自獨立部署與除錯。 */
export const API = {
  data: '/api/data',
  auth: '/api/auth',
  ai: '/api/ai',
};
