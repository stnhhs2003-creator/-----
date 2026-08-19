/*
 * 「不參與記錄」——個資盤點 A5。
 *
 * 這是家長行使個資權利的結果，不是對學生的處分。整份檔案的用字都照這個前提寫，
 * 不要出現「停權」「停用」「封鎖」「排除」這類帶懲罰意味的詞。
 *
 * 跟既有兩條路的差別（三者不可混用）：
 *
 *   只移出名冊    學生從 students 陣列消失，事件留著。學期中換班用。
 *   永久刪除      學生消失、事件也刪光。畢業／轉學用。
 *   不參與記錄    ← 這一支：學生「還在班上、座位還在」，但不再有任何事件寫得進去。
 *
 * 三個設計決定，理由寫在這裡免得日後被當成 bug 改掉：
 *
 * 1. 座位不抽掉。座位表的用途是讓老師的手指對得上教室的實體位置；抽掉一格，
 *    後面所有人往前遞補，整張表就跟教室對不起來，老師會點錯人——那是把一個
 *    個資問題換成另一個（記錄記到別人身上）。所以位子留著，只是那一格
 *    不顯示姓名、不顯示分數、也點不下去。座號留著是對位所必需。
 *
 * 2. 擋在寫入端。canRecord() 是要接在 store.appendEvent() 開頭的，
 *    不是拿來決定畫面要不要畫。畫面藏起來只是看不見，資料照樣進得去。
 *
 * 3. 標記當下把既有紀錄刪掉（由呼叫端 purge，本檔只負責標記與過濾）。
 *    家長拒絕的是「蒐集這件事」，不是「從今天起才蒐集」；而且 A5 的驗證條件
 *    白紙黑字要求該生不出現在匯出檔中，留著紀錄就驗不過。
 *
 * 純函式：不碰 DOM、不碰 store、不讀時間（時間一律由呼叫端傳入）。
 */

/** 名冊上那顆中性標記的字。刻意不叫「已停用」。 */
export const OPT_OUT_LABEL = '未參與';

/** 座位表上那一格顯示的字。不顯示姓名。 */
export const OPT_OUT_SEAT_TEXT = '—';

/** 這位學生是不是已標記為不參與。 */
export function isOptedOut(student) {
  return !!(student && student.optOut && student.optOut.since);
}

/** 某班所有不參與學生的 id 集合。 */
export function optedOutIds(classes, classId) {
  const ids = new Set();
  (classes || []).forEach((c) => {
    if (classId && c.id !== classId) return;
    (c.students || []).forEach((s) => { if (isOptedOut(s)) ids.add(s.id); });
  });
  return ids;
}

/**
 * 標記不參與。回傳新的 classes 陣列，不就地改參數。
 * at 由呼叫端傳（純函式不讀時鐘）。
 */
export function markOptOut(classes, { classId, studentId, at }) {
  return (classes || []).map((c) => (c.id !== classId ? c : {
    ...c,
    students: (c.students || []).map((s) => (
      s.id !== studentId ? s : { ...s, optOut: { since: at } }
    )),
  }));
}

/** 取消不參與，恢復正常。已刪掉的紀錄不會回來——那是刪除，不是隱藏。 */
export function clearOptOut(classes, { classId, studentId }) {
  return (classes || []).map((c) => (c.id !== classId ? c : {
    ...c,
    students: (c.students || []).map((s) => {
      if (s.id !== studentId) return s;
      const { optOut, ...rest } = s;
      void optOut;
      return rest;
    }),
  }));
}

/**
 * 寫入閘門。**這一支是整個功能的本體**，要接在儲存層的 appendEvent 開頭。
 * 不分 kind：行為、兌換、任何未來新增的事件型別，一律擋。
 */
export function canRecord(classes, { classId, studentId }) {
  const cls = (classes || []).find((c) => c.id === classId);
  const stu = (cls?.students || []).find((s) => s.id === studentId);
  if (isOptedOut(stu)) {
    return { ok: false, reason: '這位學生已設定為不參與記錄，不會寫入任何紀錄。' };
  }
  return { ok: true, reason: '' };
}

/**
 * 給「會列出學生」的地方用：班級榜、學生端選單、家長端選單、
 * 學期評語、親師草稿、導師週報、需關心名單。不參與的人一律不在名單裡。
 */
export function participating(students) {
  return (students || []).filter((s) => !isOptedOut(s));
}

/**
 * 給座位表用：**不過濾**，位子照排，只是把不參與那一格換成不具名的佔位格。
 * 回傳的 placeholder 物件刻意不帶 name，讓呼叫端就算忘記判斷也印不出姓名。
 */
export function seatCells(students) {
  return (students || []).map((s) => (isOptedOut(s)
    ? { id: s.id, no: s.no, row: s.row, col: s.col, optedOut: true, name: '', label: OPT_OUT_SEAT_TEXT }
    : { id: s.id, no: s.no, row: s.row, col: s.col, optedOut: false, name: s.name, label: s.name }
  ));
}

/**
 * 匯出檔的去識別。A5 的驗證條件是「不出現在匯出檔中」。
 *
 * 兩件事：把不參與學生的姓名清掉（姓名是全份資料裡唯一能直接識別自然人的欄位），
 * 以及濾掉他名下的所有事件。標記當下就 purge 過了，這裡是安全網——
 * 匯入一份舊備份時，舊檔裡的事件會在這裡被攔下來。
 *
 * 座號與座位保留：座位配置是班級經營的資料，不是這位學生的行為紀錄，
 * 而且抽掉之後這份備份還原回來座位表就錯位了。
 */
export function redactExport(dump) {
  const classes = (dump?.classes || []).map((c) => ({
    ...c,
    students: (c.students || []).map((s) => (isOptedOut(s) ? { ...s, name: '' } : s)),
  }));
  const blocked = optedOutIds(dump?.classes || []);
  const events = (dump?.events || []).filter((e) => !blocked.has(e.studentId));
  return { ...dump, classes, events };
}
