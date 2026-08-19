/*
 * 雲端儲存層：與 js/store.js 的 LocalStore 完全同介面，資料放 Turso。
 *
 * 六個頁面都只認 store-select.js 給的那個物件，所以這裡唯一的責任就是
 * 「長得跟 LocalStore 一模一樣」——多一個方法、少一個方法、簽名不同，都算沒做完。
 *
 * 錯誤一律往外丟，不吞。老師在課堂上點了學生、畫面沒紅字、事實上沒記到，
 * 比當場噴錯還糟：噴錯至少他會重點一次。
 */

import { API } from './config.js';

/** 網路或伺服器出問題時丟這個，呼叫端可以用 status 分辨「沒登入」和「真的壞了」。 */
export class CloudStoreError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'CloudStoreError';
    this.status = status;
  }
}

async function call(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`${API.data}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      // 認證走 session cookie，跨分頁共用同一份登入狀態。
      credentials: 'same-origin',
    });
  } catch (err) {
    // fetch 只有在連不上時才 reject，這種情況沒有 status 可用。
    throw new CloudStoreError(`連不上雲端儲存：${err.message}`, 0);
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new CloudStoreError(`伺服器回應不是 JSON（HTTP ${res.status}）`, res.status);
    }
  }

  if (!res.ok) {
    throw new CloudStoreError(
      (data && data.error) || `雲端儲存錯誤（HTTP ${res.status}）`,
      res.status,
    );
  }
  return data;
}

function qs(params) {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '' && v !== false) q.set(k, v === true ? '1' : v);
  });
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const CloudStore = {
  name: '雲端儲存',

  async init(seed) {
    await call('/init', { method: 'POST', body: { seed } });
  },

  // ---- 事件 ----

  /** 記一筆行為。delta 由行為卡帶入，呼叫端不得自由填分數。 */
  async appendEvent({ classId, studentId, behaviorId, delta, kind, period, note }) {
    return call('/events', {
      method: 'POST',
      body: { classId, studentId, behaviorId, delta, kind, period, note },
    });
  },

  /** 撤銷不刪除，保留稽核軌跡。後端只把 voided 標起來，不會少一列。 */
  async voidEvent(id) {
    return call(`/events/${encodeURIComponent(id)}/void`, { method: 'POST' });
  },

  async queryEvents({ classId, studentId, since, until, includeVoided = false } = {}) {
    // 篩選條件原樣送上去，由 SQL 做掉；這裡不做任何本地過濾。
    return call(`/events${qs({ classId, studentId, since, until, includeVoided })}`);
  },

  // ---- 設定 ----

  async getClasses() {
    return call('/doc/classes');
  },
  async saveClasses(classes) {
    await call('/doc/classes', { method: 'PUT', body: classes });
  },
  async getBehaviors() {
    return call('/doc/behaviors');
  },
  async saveBehaviors(behaviors) {
    await call('/doc/behaviors', { method: 'PUT', body: behaviors });
  },
  /** 積分商店的獎勵品項（第二期 2.2）。 */
  async getRewards() {
    return call('/doc/rewards');
  },
  async saveRewards(rewards) {
    await call('/doc/rewards', { method: 'PUT', body: rewards });
  },

  async getSettings() {
    return call('/doc/settings');
  },
  async saveSettings(settings) {
    await call('/doc/settings', { method: 'PUT', body: settings });
  },

  async exportAll() {
    return call('/export');
  },

  /*
   * ---- 刪除 ----
   * 跟 voidEvent 是兩件事：void 是「記錯了」要留稽核軌跡，
   * purge 是「畢業／轉學了，目的消失」要真的刪掉（個資法第 11 條第 3 項）。
   */

  /** 刪掉某位學生的全部事件（含已撤銷的）。回傳刪了幾筆。 */
  async purgeStudent({ classId, studentId }) {
    return call('/purge/student', { method: 'POST', body: { classId, studentId } });
  },

  /** 刪掉整個班級的全部事件。回傳刪了幾筆。 */
  async purgeClass(classId) {
    return call('/purge/class', { method: 'POST', body: { classId } });
  },

  /** 整份還原（B.4 匯入用）。事件照原樣寫回，id 與 ts 都不重編。 */
  async importAll(payload) {
    return call('/import', { method: 'POST', body: payload });
  },

  async resetAll() {
    await call('/reset', { method: 'POST' });
  },
};
