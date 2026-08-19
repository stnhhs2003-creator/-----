/*
 * 儲存層：事件流是唯一真相，分數是投影出來的。
 * 這一層只有 append / query / void 三個動作，
 * 之後要換成 Turso + Google 登入，只需另寫一個同介面的實作。
 */

import { canRecord } from './optout.js';

const KEY = {
  events: 'cp:events',
  classes: 'cp:classes',
  behaviors: 'cp:behaviors',
  rewards: 'cp:rewards',
  settings: 'cp:settings',
};

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

export const LocalStore = {
  name: '本機儲存',

  async init(seed) {
    if (!localStorage.getItem(KEY.classes)) write(KEY.classes, seed.classes);
    if (!localStorage.getItem(KEY.behaviors)) write(KEY.behaviors, seed.behaviors);
    if (!localStorage.getItem(KEY.events)) write(KEY.events, seed.events || []);
    if (!localStorage.getItem(KEY.rewards)) write(KEY.rewards, seed.rewards || []);
    if (!localStorage.getItem(KEY.settings)) write(KEY.settings, seed.settings);
  },

  // ---- 事件 ----

  /** 記一筆行為。delta 由行為卡帶入，呼叫端不得自由填分數。 */
  async appendEvent({ classId, studentId, behaviorId, delta, kind, period, note }) {
    // 「不參與」要擋在這裡，不是擋在畫面上。只要有一條路繞過 UI——多選、補登、
    // 學生端兌換、還原備份後沒重新整理的舊分頁——顯示層的過濾就是假的。
    const gate = canRecord(read(KEY.classes, []), { classId, studentId });
    if (!gate.ok) throw new Error(gate.reason);

    const events = read(KEY.events, []);
    const evt = {
      id: uid(),
      ts: new Date().toISOString(),
      classId,
      studentId,
      behaviorId,
      delta,
      kind,
      period: period || '',
      note: note || '',
      voided: false,
    };
    events.push(evt);
    write(KEY.events, events);
    return evt;
  },

  /** 撤銷不刪除，保留稽核軌跡。 */
  async voidEvent(id) {
    const events = read(KEY.events, []);
    const evt = events.find((e) => e.id === id);
    if (evt) {
      evt.voided = true;
      evt.voidedAt = new Date().toISOString();
      write(KEY.events, events);
    }
    return evt;
  },

  async queryEvents({ classId, studentId, since, until, includeVoided = false } = {}) {
    return read(KEY.events, []).filter((e) => {
      if (!includeVoided && e.voided) return false;
      if (classId && e.classId !== classId) return false;
      if (studentId && e.studentId !== studentId) return false;
      if (since && e.ts < since) return false;
      if (until && e.ts > until) return false;
      return true;
    });
  },

  // ---- 設定 ----

  async getClasses() {
    return read(KEY.classes, []);
  },
  async saveClasses(classes) {
    write(KEY.classes, classes);
  },
  async getBehaviors() {
    return read(KEY.behaviors, []);
  },
  async saveBehaviors(behaviors) {
    write(KEY.behaviors, behaviors);
  },
  /** 積分商店的獎勵品項（第二期 2.2）。 */
  async getRewards() {
    return read(KEY.rewards, []);
  },
  async saveRewards(rewards) {
    write(KEY.rewards, rewards);
  },

  async getSettings() {
    return read(KEY.settings, {});
  },
  async saveSettings(settings) {
    write(KEY.settings, settings);
  },

  async exportAll() {
    return {
      exportedAt: new Date().toISOString(),
      classes: read(KEY.classes, []),
      behaviors: read(KEY.behaviors, []),
      rewards: read(KEY.rewards, []),
      events: read(KEY.events, []),
      settings: read(KEY.settings, {}),
    };
  },

  /*
   * ---- 刪除（個資法第 11 條第 3 項：特定目的消失應主動刪除）----
   *
   * 這跟 voidEvent 是兩件不同的事，別搞混：
   *   voidEvent 是「記錯了」——留著紀錄才有稽核軌跡，學生才不會被隨手改分數。
   *   purge     是「這位學生已經畢業／轉學了」——目的消失，資料就該真的消失。
   *
   * 所以 purge 是唯一會真正 DELETE 事件的路徑，而且一定要老師本人明確按下去。
   * 沒有這條路徑的話，一個學生的行為紀錄會跟著匯出檔一路留到永遠。
   */

  /** 刪掉某位學生的全部事件（含已撤銷的）。回傳刪了幾筆。 */
  async purgeStudent({ classId, studentId }) {
    const events = read(KEY.events, []);
    const keep = events.filter((e) => !(e.classId === classId && e.studentId === studentId));
    write(KEY.events, keep);
    return { deleted: events.length - keep.length };
  },

  /** 刪掉整個班級的全部事件（畢業班結案用）。回傳刪了幾筆。 */
  async purgeClass(classId) {
    const events = read(KEY.events, []);
    const keep = events.filter((e) => e.classId !== classId);
    write(KEY.events, keep);
    return { deleted: events.length - keep.length };
  },

  /**
   * 整份還原（B.4 匯入用）。
   * 事件照原樣寫回，不重新編號也不改時間——重編號等於偽造一份新的歷史，
   * 匯出的檔案就再也對不回原本那一份了。
   */
  async importAll({ classes, behaviors, rewards, events, settings }) {
    write(KEY.classes, classes || []);
    write(KEY.behaviors, behaviors || []);
    write(KEY.rewards, rewards || []);
    write(KEY.events, events || []);
    write(KEY.settings, settings || {});
    return { ok: true, events: (events || []).length };
  },

  async resetAll() {
    Object.values(KEY).forEach((k) => localStorage.removeItem(k));
  },
};
