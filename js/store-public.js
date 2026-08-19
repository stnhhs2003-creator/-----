/*
 * 公開端（家長／學生）的 Apps Script client。對接 gas/Public.gs。
 *
 * ---- 為什麼這支跟 js/store-gas.js 是兩支，不能合併 ----
 *
 * 兩邊講的是「兩個不同的 Apps Script 部署」，而且「認人的方式」根本不同：
 *
 *   store-gas.js  → GAS_ENDPOINT.admin。老師端，掛滿管理操作（記分、改名冊、匯出、
 *                   清空）。認人靠 Google ID token（js/gas-auth.js 取、gas/Auth.gs 驗
 *                   aud 與 TEACHER_EMAIL），每一次 RPC 都要附一枚，401 還要換一枚重試。
 *   store-public.js → GAS_ENDPOINT.public。家長／學生端，部署權限是「任何人」，
 *                   只有投影過的唯讀路由 ＋ 一條 redeem-request。認人靠個人代碼
 *                   （學生 code／家長 parentCode），呼叫者根本沒有 Google 帳號，
 *                   拿不出也不該拿出 ID token。
 *
 * 合成一支的話，這台瀏覽器就同時握有「管理端的網址與操作清單」與「匿名可打的入口」，
 * 而家長頁面載入的那份 JS 裡會出現一整排管理 op 的名字。兩份部署、兩種鎖、兩支 client，
 * 是這條線的前提（見 gas/Public.gs 檔頭與 docs/gas-deploy.md），不是重複程式碼。
 *
 * 傳輸層的慣例（text/plain 避開 CORS 預檢、credentials: 'omit'、redirect: 'follow'、
 * 錯誤信封轉例外）照 store-gas.js 抄，不另立一套。
 *
 * ---- 這一層不做投影 ----
 *
 * 過濾、加總、判讀 kind 一律是後端的事（gas/Public.gs 的三條紅線）。這裡只負責
 * 「送出去」與「把 { ok:false } 轉成例外」，後端回什麼就原樣交給呼叫端。
 * 在這裡多寫一個 filter，等於把後端唯一的閘門複製成兩個，之後改了一邊就會分岔。
 */

import { GAS_ENDPOINT } from './config.js';

/** 傳輸或伺服器出問題時丟這個。status 沿用 GasStoreError 的語意：0 = 連不上。 */
export class PublicStoreError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'PublicStoreError';
    this.status = status;
  }
}

/**
 * GAS 一律以 HTTP 200 回應（ContentService 設不了狀態碼），
 * 成敗只能看 body 的 ok，錯誤碼在 status。這一層把它翻回「丟例外」。
 */
function unwrap(data) {
  if (!data || typeof data !== 'object') throw new PublicStoreError('Apps Script 回應格式不對', 0);
  if (data.ok === false) {
    throw new PublicStoreError(data.error || 'Apps Script 錯誤', data.status || 500);
  }
  return data.result;
}

/**
 * 預設傳輸層：fetch 到 /exec，回傳解析後的信封（不解信封，那是 unwrap 的事）。
 *
 * req 是 { method, url, body }：body 只有 POST 有。GET 的參數已經在 url 裡，
 * 而「代碼絕不進 url」這件事由 createPublicClient 決定，不在這一層。
 */
export function fetchTransport() {
  return async ({ method, url, body }) => {
    let res;
    try {
      res = await fetch(url, {
        method,
        // 這一行不可以改成 application/json，改了就會觸發 CORS 預檢而全盤失敗。
        headers: method === 'POST' ? { 'content-type': 'text/plain;charset=utf-8' } : undefined,
        body: method === 'POST' ? JSON.stringify(body) : undefined,
        credentials: 'omit',
        // GAS 的 /exec 會 302 到 script.googleusercontent.com 才吐內容，一定要跟。
        redirect: 'follow',
      });
    } catch (err) {
      throw new PublicStoreError(`連不上 Apps Script：${err.message}`, 0);
    }

    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        // GAS 出錯時吐的是一整頁 HTML（登入頁或錯誤頁）：多半是部署權限不是「任何人」，
        // 或者網址複製到 /dev 而不是 /exec。
        throw new PublicStoreError(
          `Apps Script 回的不是 JSON（HTTP ${res.status}）——多半是部署權限或網址不對`,
          res.status,
        );
      }
    }
    if (!res.ok) throw new PublicStoreError(`Apps Script 錯誤（HTTP ${res.status}）`, res.status);
    return data;
  };
}

/**
 * 家長端／學生端的 client。
 *
 * transport 是給測試注入用的；沒給就走 fetch。
 */
export function createPublicClient({ endpoint = GAS_ENDPOINT.public, transport } = {}) {
  const send = transport || fetchTransport();

  /** 不帶代碼的讀取走 GET，參數放 query string。 */
  const get = async (op) => {
    if (!endpoint) throw new PublicStoreError('尚未設定 Apps Script 端點網址', 0);
    const url = `${endpoint}?op=${encodeURIComponent(op)}`;
    return unwrap(await send({ method: 'GET', url }));
  };

  /*
   * 帶代碼的一律 POST，代碼只在 body 裡。
   *
   * 理由寫在 gas/Public.gs 檔頭：GET 的 query string 會留在瀏覽器歷史、家長轉貼的
   * 截圖、Apps Script 的執行紀錄裡。個人代碼進了那裡就等於印出來貼在走廊上。
   * 這裡的 url 永遠是乾淨的 endpoint，一個參數都不接。
   */
  const post = async (op, payload) => {
    if (!endpoint) throw new PublicStoreError('尚未設定 Apps Script 端點網址', 0);
    return unwrap(await send({ method: 'POST', url: endpoint, body: { op, payload } }));
  };

  return {
    /** 班級清單（只有 id 與 name，一個學生都不帶）。 */
    async classes() {
      return get('classes');
    },

    /** 學生個人頁。要學生個人代碼。 */
    async me({ classId, no, code }) {
      return post('me', { classId, no, code });
    },

    /** 家長看自己孩子。要家長個人代碼（跟學生代碼是不同的兩組）。 */
    async parentView({ classId, no, code }) {
      return post('parent-view', { classId, no, code });
    },

    /** 送出兌換申請。點數夠不夠是後端算的，前端算的版本關掉 JS 就繞過去了。 */
    async redeemRequest({ classId, no, code, rewardId }) {
      return post('redeem-request', { classId, no, code, rewardId });
    },
  };
}
