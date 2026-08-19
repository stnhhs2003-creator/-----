/*
 * 前端登入狀態與登入／登出流程。
 *
 * 真正的認證全在後端（session 是 HttpOnly cookie，JS 讀不到也不該讀），
 * 這裡只做三件事：問後端「現在是誰」、把人送去 Google、叫後端清 cookie。
 *
 * 這支檔案在純靜態環境（npm run dev 的 http.server，沒有 Functions）也不能壞——
 * 那時候 /api/auth/* 會回 404 或 HTML，一律當成「未登入」處理。
 */

import { API, GOOGLE_CLIENT_ID } from './config.js';

/**
 * Google 登入是否已設定。
 * Client ID 還是空字串就直接判定沒設定，連後端都不用問——
 * 這是「尚未申請 OAuth Client」的預設狀態，不是錯誤。
 */
export function isConfigured() {
  return typeof GOOGLE_CLIENT_ID === 'string' && GOOGLE_CLIENT_ID.trim() !== '';
}

async function getJson(path) {
  try {
    const res = await fetch(path, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    const type = res.headers.get('Content-Type') || '';
    if (!type.includes('application/json')) return null; // 靜態伺服器回的 404 HTML
    return { status: res.status, body: await res.json() };
  } catch {
    return null; // 離線或沒有後端
  }
}

/**
 * 問後端設定是否齊全（client secret 與 SESSION_SECRET 只有後端知道）。
 * 後端問不到就回 null，呼叫端自己決定要不要當成沒設定。
 */
export async function fetchServerConfig() {
  const r = await getJson(`${API.auth}/config`);
  return r ? r.body : null;
}

/** 目前登入的老師 `{ teacherId, email }`，未登入或沒有後端則回 null。 */
export async function currentTeacher() {
  const r = await getJson(`${API.auth}/me`);
  if (!r || r.status !== 200 || !r.body?.signedIn) return null;
  return { teacherId: r.body.teacherId, email: r.body.email || '' };
}

/** 把瀏覽器整頁導去後端的 login，由後端組 Google 授權網址（client secret 不能經過前端）。 */
export function startLogin() {
  window.location.assign(`${API.auth}/login`);
}

/** 登出。後端負責覆寫 cookie，前端只要重新載入畫面。 */
export async function logout() {
  try {
    await fetch(`${API.auth}/logout`, { method: 'POST', credentials: 'same-origin' });
  } catch {
    // 後端連不上也照樣把人帶回登入頁，不要卡在一個「登不出去」的畫面。
  }
  window.location.assign('/login.html');
}
