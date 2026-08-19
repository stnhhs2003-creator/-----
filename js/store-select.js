/*
 * 選儲存層。所有頁面只 import 這裡的 store，不直接碰 LocalStore，
 * 這樣要換雲端時不用動六個頁面。
 *
 * 雲端沒開就走本機，而且是靜態 import 走不到雲端那支檔案——
 * 沒設定的情況下連載入都不會發生。
 */

import { LocalStore } from './store.js';
import { STORE_BACKEND, GAS_ENDPOINT, GOOGLE_CLIENT_ID } from './config.js';

async function pick() {
  if (STORE_BACKEND === 'cloud') {
    try {
      const mod = await import('./store-cloud.js');
      return mod.CloudStore;
    } catch (err) {
      // 雲端載不起來就退回本機，不能讓老師在課堂上開不了畫面。
      console.error('[store] 雲端儲存載入失敗，改用本機儲存', err);
      return LocalStore;
    }
  }

  if (STORE_BACKEND === 'gas') {
    // 端點沒填就退回本機。空字串打過去只會拿到一頁 HTML，
    // 錯誤訊息長得像網路問題，老師會查錯方向。
    if (!GAS_ENDPOINT.admin) {
      console.error('[store] STORE_BACKEND 是 gas，但 config.js 的 GAS_ENDPOINT.admin 是空的，改用本機儲存');
      return LocalStore;
    }
    try {
      const [mod, auth] = await Promise.all([import('./store-gas.js'), import('./gas-auth.js')]);
      /*
       * 登入是「用到才問」，不是進站就擋。
       * store-gas.js 是所有管理操作的唯一出口，把登入掛在這一個地方，
       * 12 個老師端頁面一行都不用改，也不會有哪一頁忘了加。
       */
      return mod.createGasStore({
        endpoint: GAS_ENDPOINT.admin,
        getToken: () => (GOOGLE_CLIENT_ID ? auth.getIdToken(GOOGLE_CLIENT_ID) : Promise.resolve('')),
        onAuthFail: () => auth.clearToken(),
      });
    } catch (err) {
      console.error('[store] Apps Script 儲存載入失敗，改用本機儲存', err);
      return LocalStore;
    }
  }

  return LocalStore;
}

export const store = await pick();
