/*
 * 匯入／匯出與備份（ROADMAP B.4）。
 *
 * 這一支分成兩半：
 *   上半是純函式（validateBackup / summarizeBackup / mergeBackup / planImport / backupFilename），
 *   不碰 DOM、不碰儲存，測試可以直接 import 來跑。
 *   下半才是頁面互動。
 *
 * 之所以要把驗證抽成純函式：匯入是不可逆動作，
 * 而「按下去之前就知道會發生什麼」只有在驗證能被自動測試時才站得住。
 */

import { store } from './store-select.js';
import { redactExport } from './optout.js';
import { SEED } from './data.js';

// ---------- 純函式：驗證 ----------

/** 事件的四種 kind，與 store.js 的契約一致。 */
export const EVENT_KINDS = ['positive', 'improve', 'redeem-request', 'redeem'];

/** 行為卡只會是正向或待改進兩種；兌換是事件而不是行為卡。 */
const BEHAVIOR_KINDS = ['positive', 'improve'];

const FIELD_LABEL = {
  classes: '班級 classes',
  behaviors: '行為卡 behaviors',
  rewards: '獎勵 rewards',
  events: '事件 events',
  settings: '設定 settings',
};

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * 錯誤訊息收集器。一份壞掉的檔案可能有上千個問題，
 * 全列出來老師只會關掉頁面——列前幾個，其餘只報數量。
 */
function collector(list, cap = 10) {
  let extra = 0;
  return {
    add(msg) {
      if (list.length < cap) list.push(msg);
      else extra++;
    },
    flush() {
      if (extra) list.push(`……另有 ${extra} 個同類問題未列出。`);
    },
  };
}

/**
 * 驗證一份備份資料能不能匯入。
 *
 * 回傳 { ok, errors, warnings, summary, orphanEvents }。
 * errors 不為空就不准匯入；warnings 只是提醒，不擋。
 *
 * strictRefs 的用意：
 * 這個站刻意允許「刪掉的學生／班級，事件仍留著當稽核軌跡」（見 roster.js 的刪除提示），
 * 所以一份合法的匯出檔本來就可能有指向不存在學生的事件。
 * 預設把這種情形當警告，不然老師刪過一個學生之後，自己的備份就再也匯不回來。
 * 要把參照完整性當硬性條件時（例如檢查外來檔案）才開 strictRefs。
 */
export function validateBackup(data, { strictRefs = false } = {}) {
  const errors = [];
  const warnings = [];
  const fail = (msgs) => ({ ok: false, errors: msgs, warnings, summary: null, orphanEvents: 0 });

  if (!isPlainObject(data)) {
    return fail(['檔案內容不是一個 JSON 物件，可能選錯檔案了。']);
  }

  // 去識別化檔案是單向的：姓名在匯出的當下就丟掉了，沒有任何對照表留著。
  // 讓它匯得進來只有一種結果——老師以為還原成功，實際上得到一份沒有姓名的名冊。
  // 所以這裡直接擋，而且要說清楚該去找哪一種檔。
  if (isDeidentified(data)) {
    return fail([
      '這是一份「去識別化匯出」檔，裡面沒有任何學生姓名，而且姓名已經回不來了，不能匯入。',
      '要還原資料請改用檔名帶「含姓名」的備份檔（例如 班級積分堂-備份-含姓名-20260815-1432.json）。',
    ]);
  }

  ['classes', 'behaviors', 'rewards', 'events'].forEach((key) => {
    if (!Array.isArray(data[key])) errors.push(`缺少「${FIELD_LABEL[key]}」欄位，或格式不是陣列。`);
  });
  if (!isPlainObject(data.settings)) errors.push(`缺少「${FIELD_LABEL.settings}」欄位，或格式不是物件。`);
  // 結構壞掉就沒必要往下逐筆檢查了，後面每一行都會爆
  if (errors.length) return fail(errors);

  // ---- 班級與學生 ----
  const classIds = new Set();
  const studentsOf = new Map(); // classId -> Set(studentId)
  const allStudentIds = new Set();
  const clsErr = collector(errors);

  data.classes.forEach((c, i) => {
    const at = `第 ${i + 1} 個班級`;
    if (!isPlainObject(c)) return clsErr.add(`${at}不是物件。`);
    if (!isNonEmptyString(c.id)) return clsErr.add(`${at}缺少 id。`);
    if (classIds.has(c.id)) clsErr.add(`班級 id「${c.id}」重複出現。`);
    classIds.add(c.id);
    if (!isNonEmptyString(c.name)) clsErr.add(`班級「${c.id}」缺少名稱。`);
    if (!Array.isArray(c.students)) {
      clsErr.add(`班級「${c.id}」的 students 不是陣列。`);
      return;
    }
    const set = new Set();
    c.students.forEach((s, j) => {
      const sat = `班級「${c.id}」第 ${j + 1} 位學生`;
      if (!isPlainObject(s)) return clsErr.add(`${sat}不是物件。`);
      if (!isNonEmptyString(s.id)) return clsErr.add(`${sat}缺少 id。`);
      if (set.has(s.id)) clsErr.add(`學生 id「${s.id}」在同一班重複出現。`);
      if (!isNonEmptyString(s.name)) clsErr.add(`學生「${s.id}」缺少姓名。`);
      set.add(s.id);
      allStudentIds.add(s.id);
    });
    studentsOf.set(c.id, set);
  });
  clsErr.flush();

  // ---- 行為卡 ----
  const behErr = collector(errors);
  const behaviorIds = new Set();
  data.behaviors.forEach((b, i) => {
    const at = `第 ${i + 1} 張行為卡`;
    if (!isPlainObject(b)) return behErr.add(`${at}不是物件。`);
    if (!isNonEmptyString(b.id)) return behErr.add(`${at}缺少 id。`);
    if (behaviorIds.has(b.id)) behErr.add(`行為卡 id「${b.id}」重複出現。`);
    behaviorIds.add(b.id);
    if (!Number.isFinite(b.delta)) behErr.add(`行為卡「${b.id}」的 delta 不是數字。`);
    if (!BEHAVIOR_KINDS.includes(b.kind)) {
      behErr.add(`行為卡「${b.id}」的 kind 是「${b.kind}」，只能是 ${BEHAVIOR_KINDS.join(' / ')}。`);
    }
  });
  behErr.flush();

  // ---- 獎勵 ----
  const rwErr = collector(errors);
  const rewardIds = new Set();
  data.rewards.forEach((r, i) => {
    const at = `第 ${i + 1} 項獎勵`;
    if (!isPlainObject(r)) return rwErr.add(`${at}不是物件。`);
    if (!isNonEmptyString(r.id)) return rwErr.add(`${at}缺少 id。`);
    if (rewardIds.has(r.id)) rwErr.add(`獎勵 id「${r.id}」重複出現。`);
    rewardIds.add(r.id);
    if (!Number.isFinite(r.cost)) rwErr.add(`獎勵「${r.id}」的所需點數不是數字。`);
  });
  rwErr.flush();

  // ---- 事件（最要緊的一段，它是唯一真相）----
  const evErr = collector(errors);
  const eventIds = new Set();
  let orphanClass = 0;
  let orphanStudent = 0;

  data.events.forEach((e, i) => {
    const at = `第 ${i + 1} 筆事件`;
    if (!isPlainObject(e)) return evErr.add(`${at}不是物件。`);
    if (!isNonEmptyString(e.id)) return evErr.add(`${at}缺少 id。`);
    const tag = `事件「${e.id}」`;
    if (eventIds.has(e.id)) evErr.add(`${tag}的 id 在同一份檔案裡重複出現。`);
    eventIds.add(e.id);

    if (!isNonEmptyString(e.ts) || Number.isNaN(Date.parse(e.ts))) {
      evErr.add(`${tag}的時間 ts 不是合法的時間字串。`);
    }
    if (!EVENT_KINDS.includes(e.kind)) {
      evErr.add(`${tag}的 kind 是「${e.kind}」，只能是 ${EVENT_KINDS.join(' / ')}。`);
    }
    if (!Number.isFinite(e.delta)) {
      evErr.add(`${tag}的 delta 不是數字（收到 ${JSON.stringify(e.delta)}）。`);
    }
    if (!isNonEmptyString(e.classId)) evErr.add(`${tag}缺少 classId。`);
    if (!isNonEmptyString(e.studentId)) evErr.add(`${tag}缺少 studentId。`);

    // 參照完整性
    if (isNonEmptyString(e.classId) && !classIds.has(e.classId)) {
      orphanClass++;
      if (strictRefs) evErr.add(`${tag}指向不存在的班級「${e.classId}」。`);
    } else if (isNonEmptyString(e.studentId) && isNonEmptyString(e.classId)
      && !(studentsOf.get(e.classId) || new Set()).has(e.studentId)) {
      orphanStudent++;
      if (strictRefs) evErr.add(`${tag}指向不存在的學生「${e.studentId}」。`);
    }
  });
  evErr.flush();

  if (!strictRefs) {
    if (orphanClass) warnings.push(`有 ${orphanClass} 筆事件屬於已被刪除的班級，會照原樣保留在稽核軌跡裡，主畫面不會顯示。`);
    if (orphanStudent) warnings.push(`有 ${orphanStudent} 筆事件屬於已被刪除的學生，會照原樣保留在稽核軌跡裡，主畫面不會顯示。`);
  }
  // 有人可能把去識別化檔的標記手動刪掉（或用文字編輯器改過），標記就擋不住了。
  // 姓名全部長得像「12號」是去識別化檔的指紋，這種情況要當面講，不能讓它默默蓋掉名冊。
  const names = data.classes.flatMap((c) => (Array.isArray(c?.students) ? c.students : []))
    .map((s) => (typeof s?.name === 'string' ? s.name : ''));
  if (names.length && names.every((n) => SEAT_LABEL_RE.test(n))) {
    warnings.push(`這份檔案裡 ${names.length} 位學生的「姓名」全都是座號（例如「${names[0]}」），`
      + '看起來是去識別化匯出的檔案。匯進來之後名冊上不會有真實姓名，而且沒辦法變回來。');
  }

  if (!data.classes.length) warnings.push('這份備份裡沒有任何班級。');
  if (!data.events.length) warnings.push('這份備份裡沒有任何紀錄事件。');
  if (!isNonEmptyString(data.exportedAt)) warnings.push('這份檔案沒有記錄匯出時間，可能不是由本站匯出的。');

  const ok = errors.length === 0;
  return {
    ok,
    errors,
    warnings,
    summary: ok ? summarizeBackup(data) : null,
    orphanEvents: orphanClass + orphanStudent,
  };
}

/** 一份資料的概況：幾班、幾人、幾筆、時間範圍。給預覽用。 */
export function summarizeBackup(data) {
  const classes = Array.isArray(data?.classes) ? data.classes : [];
  const events = Array.isArray(data?.events) ? data.events : [];
  const stamps = events.map((e) => e?.ts).filter((t) => typeof t === 'string' && t).sort();
  const byKind = {};
  EVENT_KINDS.forEach((k) => { byKind[k] = 0; });
  events.forEach((e) => { if (e && e.kind in byKind) byKind[e.kind]++; });

  return {
    exportedAt: typeof data?.exportedAt === 'string' ? data.exportedAt : '',
    classCount: classes.length,
    studentCount: classes.reduce((n, c) => n + (Array.isArray(c?.students) ? c.students.length : 0), 0),
    behaviorCount: Array.isArray(data?.behaviors) ? data.behaviors.length : 0,
    rewardCount: Array.isArray(data?.rewards) ? data.rewards.length : 0,
    eventCount: events.length,
    voidedCount: events.filter((e) => e?.voided).length,
    byKind,
    firstTs: stamps[0] || '',
    lastTs: stamps[stamps.length - 1] || '',
  };
}

// ---------- 純函式：合併 ----------

const indexById = (list) => new Map((Array.isArray(list) ? list : []).map((x) => [x?.id, x]));

/**
 * 合併兩份資料。現況優先，備份只補現況沒有的東西。
 *
 * 事件流是唯一真相，同一個 id 不能被記兩次，所以事件用 id 去重。
 * 唯一的例外是撤銷：任何一邊標成 voided 就以「已撤銷」為準——
 * 撤銷是不可逆的動作，合併不該把它救回來。
 */
export function mergeBackup(current, incoming) {
  const curClasses = Array.isArray(current?.classes) ? current.classes : [];
  const incClasses = Array.isArray(incoming?.classes) ? incoming.classes : [];
  const incClassMap = indexById(incClasses);

  const classes = curClasses.map((c) => {
    const inc = incClassMap.get(c.id);
    if (!inc || !Array.isArray(inc.students)) return c;
    const have = new Set((c.students || []).map((s) => s.id));
    const added = inc.students.filter((s) => !have.has(s.id));
    return added.length ? { ...c, students: [...(c.students || []), ...added] } : c;
  });
  const curClassIds = new Set(curClasses.map((c) => c.id));
  incClasses.forEach((c) => { if (!curClassIds.has(c.id)) classes.push(c); });

  const unionById = (cur, inc) => {
    const out = [...(Array.isArray(cur) ? cur : [])];
    const have = new Set(out.map((x) => x?.id));
    (Array.isArray(inc) ? inc : []).forEach((x) => { if (!have.has(x?.id)) out.push(x); });
    return out;
  };

  const events = [...(Array.isArray(current?.events) ? current.events : [])];
  const byId = new Map(events.map((e, i) => [e?.id, i]));
  (Array.isArray(incoming?.events) ? incoming.events : []).forEach((e) => {
    if (!byId.has(e?.id)) {
      byId.set(e?.id, events.length);
      events.push(e);
      return;
    }
    const idx = byId.get(e.id);
    if (e.voided && !events[idx].voided) {
      events[idx] = { ...events[idx], voided: true, voidedAt: e.voidedAt || events[idx].voidedAt };
    }
  });
  events.sort((a, b) => String(a?.ts).localeCompare(String(b?.ts)));

  return {
    exportedAt: new Date().toISOString(),
    classes,
    behaviors: unionById(current?.behaviors, incoming?.behaviors),
    rewards: unionById(current?.rewards, incoming?.rewards),
    events,
    // 現有設定優先，備份只補現況沒有的鍵
    settings: { ...(incoming?.settings || {}), ...(current?.settings || {}) },
  };
}

/** 按下去之前先算清楚會發生什麼：新增幾筆、跳過幾筆、覆蓋掉什麼。 */
export function planImport(current, incoming, mode) {
  const curEventIds = new Set((current?.events || []).map((e) => e?.id));
  const incEvents = incoming?.events || [];
  const duplicateEvents = incEvents.filter((e) => curEventIds.has(e?.id)).length;
  const curClassIds = new Set((current?.classes || []).map((c) => c?.id));
  const newClasses = (incoming?.classes || []).filter((c) => !curClassIds.has(c?.id)).length;

  const before = summarizeBackup(current);
  const after = summarizeBackup(mode === 'replace' ? incoming : mergeBackup(current, incoming));

  // 覆蓋才會弄丟東西：現況有、備份沒有的那些事件，按下去就再也回不來
  const incEventIds = new Set(incEvents.map((e) => e?.id));
  const droppedEvents = mode === 'replace'
    ? (current?.events || []).filter((e) => !incEventIds.has(e?.id)).length
    : 0;

  return {
    mode,
    before,
    after,
    newClasses,
    newEvents: incEvents.length - duplicateEvents,
    duplicateEvents,
    droppedEvents,
  };
}

// ---------- 純函式：去識別化匯出 ----------

const pad = (n) => String(n).padStart(2, '0');


/*
 * 個資盤點 7.4：匯出檔是全班姓名的明文，會躺在下載資料夾、被同步到雲端硬碟、
 * 被 email 出去。對策之一是提供一種「拿去分享也不會害到學生」的匯出。
 *
 * 這裡先把三個判斷寫死，因為它們決定了這個功能到底是什麼：
 *
 * 一、去識別化到什麼程度？
 *     只把 name 換掉是不夠的。班內任何一個「唯一值」都能把人指回來：
 *       - `studentId` 是 `{classId}-s{n}`，n 就是名冊順序，通常等於座號 → 重新編號。
 *       - 事件 `id` 是 `Date.now().toString(36) + 亂數`，前半段可以還原成毫秒級時間戳 → 重新編號。
 *       - `row`／`col` 是座位表上的位置，班內唯一，而且教室座位是公開資訊 → 整個拿掉。
 *       - `class.name`（「七年三班」）＋座號＝指到特定學校的特定一個人 → 換成「班級1」。
 *       - `note` 可能寫著人名、家庭狀況、情緒描述，沒有任何可靠的方法洗乾淨 → 一律清空，
 *         但把清掉幾筆告訴老師，讓他知道這份檔跟原檔差在哪。
 *       - `settings.parentCode` 是家長綁定的通過碼，本來就不該出現在分享檔裡 → 只留白名單裡的設定。
 *     欄位一律用白名單複製，不用展開運算子：以後誰在學生物件上加一個「個人代碼」欄位，
 *     也不會自動漏進這份檔案。
 *
 * 二、座號夠不夠？不夠，所以不叫「匿名化」。
 *     手上有那班座位表的人（同班同學、任課老師、學校行政）看到「12號」就知道是誰。
 *     這是**假名化**：把外流的傷害從「全世界都讀得懂」降到「本來就認識這個班的人才讀得懂」。
 *     介面上必須照這個程度講，不能講成「已匿名，可以隨便傳」。
 *
 * 三、還原得回來嗎？不行，而且是刻意的。
 *     要能還原就得留一份「座號→姓名」對照表，那張表要嘛跟著檔案走（等於沒去識別化），
 *     要嘛存在別的地方（等於多生一份個資檔）。兩條路都讓這個功能失去意義。
 *     所以：**去識別化檔＝分享／存查用的死檔，不是備份檔。**
 *     它帶著 `deidentified: true` 標記，匯入端看到就直接擋（見 validateBackup 開頭）。
 *     老師要換裝置、要還原，永遠只能用含姓名的那一份。
 */

/** 去識別化檔的標記版本。改變去識別化規則時要跟著進版，匯入端才分得出來。 */
export const DEID_MARKER = 'deidentified-v1';

/** 「12號」這種座號代稱。用來反向偵測被拔掉標記的去識別化檔。 */
const SEAT_LABEL_RE = /^\d+號$/;

/** 判斷一份資料是不是去識別化匯出檔。 */
export function isDeidentified(data) {
  return isPlainObject(data) && (data.deidentified === true || data.deidentifiedFormat === DEID_MARKER);
}

/** 去識別化檔要保留的設定鍵。白名單制——沒列進來的（例如家長通過碼）一律不出現。 */
const SAFE_SETTING_KEYS = [
  'alertConsecutiveImprove',
  'alertConsecutiveWindowDays',
  'alertClassImprovePerPeriod',
  'retentionMonths',
  'periods',
];

/** 事件時間只留到「哪一天」。毫秒級時間戳可以還原孩子每天在校的活動時間點。 */
const dayOf = (ts) => (typeof ts === 'string' && ts.length >= 10 ? ts.slice(0, 10) : '');

/**
 * 把一份備份資料轉成去識別化版本。
 *
 * 不會改動傳進來的物件。回傳 { data, stats }：
 *   data  —— 可以直接寫成檔案的去識別化資料
 *   stats —— 拿掉了什麼，給介面照實顯示（幾個姓名、幾則備註、幾個班名）
 *
 * 事件筆數、分數、kind 分布、撤銷狀態都必須與原檔一模一樣：
 * 這份檔案的用途是拿來討論班級狀況，統計一旦變了就沒有意義。
 */
export function deidentify(data, { now = new Date() } = {}) {
  const src = isPlainObject(data) ? data : {};
  const classes = Array.isArray(src.classes) ? src.classes : [];
  const events = Array.isArray(src.events) ? src.events : [];

  const classIdMap = new Map();   // 原 classId -> 代號
  const studentIdMap = new Map(); // 原 studentId -> 代號
  let namesRemoved = 0;

  const outClasses = classes.map((c, ci) => {
    const cid = `k${ci + 1}`;
    if (isNonEmptyString(c?.id)) classIdMap.set(c.id, cid);
    const students = Array.isArray(c?.students) ? c.students : [];
    return {
      id: cid,
      name: `班級${ci + 1}`,
      cols: Number.isFinite(c?.cols) ? c.cols : 6,
      students: students.map((s, si) => {
        const sid = `${cid}-p${pad(si + 1)}`;
        if (isNonEmptyString(s?.id)) studentIdMap.set(s.id, sid);
        if (isNonEmptyString(s?.name)) namesRemoved++;
        const no = Number.isFinite(s?.no) ? s.no : si + 1;
        // 只留 id / 座號 / 代稱三個欄位，其餘（row、col 與任何未來新增的欄位）一律不帶
        return { id: sid, no, name: `${no}號` };
      }),
    };
  });

  // 指向已刪除班級／學生的事件（稽核軌跡）也要有代號，不然筆數會對不上
  let ghostClass = 0;
  let ghostStudent = 0;
  const mapClassId = (id) => {
    if (!isNonEmptyString(id)) return '';
    if (!classIdMap.has(id)) classIdMap.set(id, `k-已刪除${++ghostClass}`);
    return classIdMap.get(id);
  };
  const mapStudentId = (id) => {
    if (!isNonEmptyString(id)) return '';
    if (!studentIdMap.has(id)) studentIdMap.set(id, `p-已刪除${++ghostStudent}`);
    return studentIdMap.get(id);
  };

  let notesRemoved = 0;
  const outEvents = events.map((e, i) => {
    if (isNonEmptyString(e?.note)) notesRemoved++;
    return {
      id: `e${i + 1}`,
      ts: dayOf(e?.ts),
      classId: mapClassId(e?.classId),
      studentId: mapStudentId(e?.studentId),
      behaviorId: typeof e?.behaviorId === 'string' ? e.behaviorId : '',
      delta: Number.isFinite(e?.delta) ? e.delta : 0,
      kind: typeof e?.kind === 'string' ? e.kind : '',
      period: typeof e?.period === 'string' ? e.period : '',
      note: '',
      voided: Boolean(e?.voided),
      voidedAt: dayOf(e?.voidedAt),
    };
  });

  const settings = {};
  SAFE_SETTING_KEYS.forEach((k) => {
    if (isPlainObject(src.settings) && k in src.settings) settings[k] = src.settings[k];
  });

  const stamp = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();

  return {
    data: {
      deidentified: true,
      deidentifiedFormat: DEID_MARKER,
      deidentifiedAt: stamp.toISOString(),
      restorable: false,
      readme: '這份檔案已移除全部學生姓名、座位與備註，姓名無法還原，不能匯回班級積分堂。'
        + '學生以班內座號代稱——拿得到該班座位表的人仍然認得出是誰，請當成班級資料保管，不要公開張貼。',
      exportedAt: stamp.toISOString(),
      classes: outClasses,
      behaviors: (Array.isArray(src.behaviors) ? src.behaviors : []).map((b) => ({
        id: b?.id, label: b?.label, delta: b?.delta, kind: b?.kind, icon: b?.icon,
      })),
      rewards: (Array.isArray(src.rewards) ? src.rewards : []).map((r) => ({
        id: r?.id, name: r?.name, cost: r?.cost, stock: r?.stock ?? null, active: r?.active !== false,
      })),
      events: outEvents,
      settings,
    },
    stats: {
      namesRemoved,
      notesRemoved,
      classNamesRemoved: outClasses.length,
      seatsRemoved: outClasses.reduce((n, c) => n + c.students.length, 0),
      eventCount: outEvents.length,
    },
  };
}

// ---------- 純函式：檔名 ----------

/**
 * 匯出檔名。
 *
 * 兩種匯出的檔名刻意差很多個字：三個月後在下載資料夾裡看到這兩個檔，
 * 要能不打開就知道哪一個有姓名。只差一個字的檔名等於沒有標示。
 *   含姓名：班級積分堂-備份-含姓名-20260815-1432.json
 *   去識別：班級積分堂-去識別-無姓名-20260815-1432.json
 */
export function backupFilename(date = new Date(), { kind = 'plain', site = '班級積分堂' } = {}) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const tag = kind === 'deid' ? '去識別-無姓名' : '備份-含姓名';
  return `${site}-${tag}-${stamp}.json`;
}

// ---------- 頁面 ----------

const $ = (sel) => document.querySelector(sel);

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const state = {
  current: null,   // 目前站上的資料
  incoming: null,  // 待匯入的資料
  sourceName: '',  // 來源檔名，只為了讓老師確認選對檔
  report: null,    // validateBackup 的結果
  exportedThisVisit: false,
  pendingExport: null, // 'plain' | 'deid' | null：正在確認中的匯出
};

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

let toastTimer = null;
function toast(msg) {
  const box = $('#toast');
  $('#toastText').textContent = msg;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 2800);
}

function statList(s) {
  return `
    <div class="bk-stats">
      <div class="bk-stat"><span class="bk-num">${s.classCount}</span><span class="bk-lab">班級</span></div>
      <div class="bk-stat"><span class="bk-num">${s.studentCount}</span><span class="bk-lab">學生</span></div>
      <div class="bk-stat"><span class="bk-num">${s.eventCount}</span><span class="bk-lab">紀錄事件</span></div>
      <div class="bk-stat"><span class="bk-num">${s.behaviorCount}</span><span class="bk-lab">行為卡</span></div>
      <div class="bk-stat"><span class="bk-num">${s.rewardCount}</span><span class="bk-lab">獎勵品項</span></div>
    </div>
    <p class="hint">紀錄時間範圍：${fmtTime(s.firstTs)} — ${fmtTime(s.lastTs)}（其中 ${s.voidedCount} 筆已撤銷）</p>`;
}

function renderCurrent() {
  $('#currentBox').innerHTML = statList(summarizeBackup(state.current));
}

// ---------- 匯出 ----------

/*
 * 警語為什麼不是一段固定的紅字：
 * 每次匯出都看到同一句話，第三次就自動跳過了。這裡改成兩件會變的事——
 *   1. 確認框裡的數字是這一次匯出的真實內容（幾個姓名、幾則備註），資料變它就變。
 *   2. 上一份含姓名檔的「未處理」提醒會一直掛在頁面最上面，
 *      直到老師按下「我已經刪掉了」為止。它是一個待辦，不是一句提醒。
 */

const LAST_PLAIN_KEY = 'cp:backup:lastPlainExport';

function readLastPlain() {
  try {
    const raw = localStorage.getItem(LAST_PLAIN_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v.name === 'string' ? v : null;
  } catch { return null; }
}

function writeLastPlain(v) {
  try {
    if (v) localStorage.setItem(LAST_PLAIN_KEY, JSON.stringify(v));
    else localStorage.removeItem(LAST_PLAIN_KEY);
  } catch { /* 隱私模式下寫不進去就算了，不該因此擋掉匯出 */ }
}

function download(payload, name) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立刻 revoke 在部分瀏覽器會讓下載中斷，等一下再收
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** 頁首那則「上一份含姓名檔還沒處理」的待辦。 */
function renderPending() {
  const box = $('#pendingBox');
  if (!box) return;
  const last = readLastPlain();
  if (!last) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = `
    <p><strong>上一份含姓名的檔案還在嗎？</strong></p>
    <p class="bk-file-name">${esc(last.name)}</p>
    <p class="hint">${fmtTime(last.at)} 匯出。這個檔案裡有 ${last.names} 位學生的真實姓名。
      如果它還躺在下載資料夾、雲端硬碟或學校公用電腦上，現在就去刪掉；已經處理好了再按下面的按鈕。</p>
    <button id="clearPending" class="btn btn-ghost btn-sm" type="button">我已經刪掉／收好了</button>`;
}

/** 匯出前的確認：數字都是這一次的真實內容，不是罐頭文案。 */
function renderExportConfirm() {
  const box = $('#exportConfirm');
  if (!state.pendingExport) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;

  const s = summarizeBackup(state.current);
  const classNames = (state.current?.classes || []).map((c) => c?.name).filter(Boolean);
  const noteCount = (state.current?.events || []).filter((e) => isNonEmptyString(e?.note)).length;

  if (state.pendingExport === 'plain') {
    box.innerHTML = `
      <h3 class="bk-bad">這個檔案是一份學生個資</h3>
      <p>按下去會產生一個檔案，裡面有
        <strong>${s.studentCount} 位學生的真實姓名</strong>、
        ${classNames.length} 個班級名稱（${esc(classNames.join('、'))}）、
        ${s.eventCount} 筆行為紀錄${noteCount ? `，以及你寫的 ${noteCount} 則備註` : ''}。</p>
      <p class="hint">它跟一份成績單同等級：存到只有你進得去的位置，不要放桌面、不要用通訊軟體傳、
        用完就刪。學校公用電腦上匯出的檔案，離開前一定要清掉。</p>
      <div class="view-actions">
        <button id="doPlain" class="btn btn-primary" type="button">我知道，匯出含姓名的檔案</button>
        <button id="switchDeid" class="btn btn-ghost" type="button">只是要分享／存查，改匯出沒有姓名的版本</button>
        <button id="cancelExport" class="btn btn-ghost" type="button">取消</button>
      </div>`;
    return;
  }

  const { stats } = deidentify(state.current);
  box.innerHTML = `
    <h3>去識別化匯出：拿掉姓名，換成座號</h3>
    <p>會從檔案裡移除
      <strong>${stats.namesRemoved} 個學生姓名</strong>（改成「7號」這樣的座號代稱）、
      ${stats.classNamesRemoved} 個班級名稱、${stats.seatsRemoved} 筆座位位置${stats.notesRemoved ? `、${stats.notesRemoved} 則備註` : ''}，
      事件時間只留到日期。${stats.eventCount} 筆紀錄與所有分數<strong>一筆都不會少</strong>。</p>
    <p class="bk-warn"><strong>這份檔案不能匯回系統，姓名也還不回來。</strong>
      它是給「拿出去看」用的：跟輔導室討論班級狀況、期末統計、交研習作業。
      要換裝置或還原，請用含姓名的備份檔。</p>
    <p class="hint">注意：這是「假名化」不是「匿名化」。拿得到這班座位表的人，看到座號還是知道是誰。
      可以拿去討論，不要公開張貼。</p>
    <div class="view-actions">
      <button id="doDeid" class="btn btn-primary" type="button">匯出去識別化檔案</button>
      <button id="cancelExport" class="btn btn-ghost" type="button">取消</button>
    </div>`;
}

function askExport(kind) {
  state.pendingExport = kind;
  renderExportConfirm();
  $('#exportConfirm').scrollIntoView({ block: 'nearest' });
}

async function doExport(kind = 'plain') {
  const data = redactExport(await store.exportAll());
  const now = new Date();

  if (kind === 'deid') {
    const { data: out, stats } = deidentify(data, { now });
    const name = backupFilename(now, { kind: 'deid' });
    download(out, name);
    state.current = data;
    state.pendingExport = null;
    renderCurrent();
    renderExportConfirm();
    toast(`已匯出 ${name}（移除 ${stats.namesRemoved} 個姓名）`);
    return;
  }

  const name = backupFilename(now, { kind: 'plain' });
  download(data, name);

  const names = summarizeBackup(data).studentCount;
  writeLastPlain({ name, at: now.toISOString(), names });

  state.current = data;
  state.exportedThisVisit = true;
  state.pendingExport = null;
  renderCurrent();
  renderExportConfirm();
  renderPending();
  renderPreview();
  toast(`已匯出 ${name}——含姓名，用畢請刪除`);
}

// ---------- 匯入 ----------

function loadText(text, sourceName) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    state.incoming = null;
    state.report = { ok: false, errors: [`檔案不是合法的 JSON：${err.message}`], warnings: [], summary: null, orphanEvents: 0 };
    state.sourceName = sourceName;
    renderPreview();
    return;
  }
  state.incoming = parsed;
  state.sourceName = sourceName;
  state.report = validateBackup(parsed);
  renderPreview();
}

function currentMode() {
  const el = document.querySelector('input[name="mode"]:checked');
  return el ? el.value : 'merge';
}

function renderPreview() {
  const box = $('#preview');
  if (!state.report) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;

  const src = state.sourceName ? `<p class="hint">來源：${esc(state.sourceName)}</p>` : '';

  if (!state.report.ok) {
    box.innerHTML = `
      <h3 class="bk-bad">這份檔案不能匯入</h3>
      ${src}
      <ul class="bk-msgs">${state.report.errors.map((e) => `<li class="bk-err">${esc(e)}</li>`).join('')}</ul>
      <p class="hint">沒有任何資料被改動。請確認選的是本站匯出的備份檔。</p>`;
    return;
  }

  const mode = currentMode();
  const plan = planImport(state.current, state.incoming, mode);
  const s = state.report.summary;

  const effect = mode === 'replace'
    ? `<p class="bk-warn">覆蓋：目前裝置上的 ${plan.before.eventCount} 筆紀錄會被<strong>整份丟棄</strong>，
        換成備份檔裡的 ${s.eventCount} 筆。其中有 ${plan.droppedEvents} 筆是備份檔裡沒有的，會永遠消失。</p>`
    : `<p>合併：備份檔的 ${s.eventCount} 筆事件中，<strong>${plan.newEvents} 筆是新的</strong>會加進來，
        ${plan.duplicateEvents} 筆已經存在會自動跳過（同一筆不會被記兩次）。
        新增 ${plan.newClasses} 個班級。目前的資料不會被刪除。</p>`;

  box.innerHTML = `
    <h3>按下去會發生這些事</h3>
    ${src}
    <p class="hint">備份檔匯出於 ${fmtTime(s.exportedAt)}</p>
    ${statList(s)}
    ${state.report.warnings.length
      ? `<ul class="bk-msgs">${state.report.warnings.map((w) => `<li class="bk-warnline">${esc(w)}</li>`).join('')}</ul>`
      : ''}
    <div class="bk-diff">
      <div><span class="bk-lab">匯入前</span><strong>${plan.before.eventCount}</strong> 筆事件 / ${plan.before.studentCount} 位學生</div>
      <div class="bk-arrow">→</div>
      <div><span class="bk-lab">匯入後</span><strong>${plan.after.eventCount}</strong> 筆事件 / ${plan.after.studentCount} 位學生</div>
    </div>
    ${effect}
    <label class="bk-check">
      <input type="checkbox" id="ackBackup"${state.exportedThisVisit ? ' checked' : ''}>
      我已經把目前的資料匯出存好了（匯入不可復原）
    </label>
    <div class="view-actions">
      <button id="exportFirst" class="btn btn-ghost" type="button">先匯出現況</button>
      <button id="confirmImport" class="btn btn-primary" type="button">確認${mode === 'replace' ? '覆蓋' : '合併'}匯入</button>
      <button id="cancelImport" class="btn btn-ghost" type="button">取消</button>
    </div>`;

  $('#confirmImport').disabled = !$('#ackBackup').checked;
}

/**
 * 真的寫回去。
 *
 * 一定要走 store.importAll()——appendEvent 會自己產生 id 與 ts，
 * 拿它還原歷史等於偽造一份新的事件流。沒有這個方法就直接停手，
 * 不要繞過儲存層去寫 localStorage：雲端開起來以後那樣寫是寫到錯的地方，
 * 而且老師會以為還原成功了。
 */
async function writeAll(payload) {
  if (typeof store.importAll !== 'function') {
    throw new Error('這個儲存層不支援整份還原，請回報給開發者。');
  }
  await store.importAll(payload);
}

async function doImport() {
  if (!state.report?.ok || !state.incoming) return;
  const mode = currentMode();
  const plan = planImport(state.current, state.incoming, mode);

  const msg = mode === 'replace'
    ? `確定要「覆蓋」嗎？\n\n目前裝置上的 ${plan.before.eventCount} 筆紀錄會被丟棄，其中 ${plan.droppedEvents} 筆備份檔裡沒有，救不回來。\n\n匯入後：${plan.after.eventCount} 筆事件、${plan.after.studentCount} 位學生。`
    : `確定要「合併」嗎？\n\n會新增 ${plan.newEvents} 筆事件、跳過 ${plan.duplicateEvents} 筆重複。\n\n匯入後：${plan.after.eventCount} 筆事件、${plan.after.studentCount} 位學生。`;
  if (!confirm(msg)) return;

  const payload = mode === 'replace'
    ? {
      exportedAt: new Date().toISOString(),
      classes: state.incoming.classes,
      behaviors: state.incoming.behaviors,
      rewards: state.incoming.rewards,
      events: state.incoming.events,
      settings: state.incoming.settings,
    }
    : mergeBackup(state.current, state.incoming);

  await writeAll(payload);

  state.current = redactExport(await store.exportAll());
  state.incoming = null;
  state.report = null;
  state.sourceName = '';
  $('#pasteBox').value = '';
  $('#fileInput').value = '';
  renderCurrent();
  renderPreview();
  toast(mode === 'replace' ? '已覆蓋匯入，回主畫面看看。' : `已合併匯入，新增 ${plan.newEvents} 筆。`);
}

// ---------- 綁定 ----------

function bind() {
  $('#exportPlainBtn').addEventListener('click', () => askExport('plain'));
  $('#exportDeidBtn').addEventListener('click', () => askExport('deid'));

  $('#exportConfirm').addEventListener('click', (e) => {
    if (e.target.id === 'doPlain') doExport('plain');
    if (e.target.id === 'doDeid') doExport('deid');
    if (e.target.id === 'switchDeid') askExport('deid');
    if (e.target.id === 'cancelExport') { state.pendingExport = null; renderExportConfirm(); }
  });

  $('#pendingBox').addEventListener('click', (e) => {
    if (e.target.id === 'clearPending') { writeLastPlain(null); renderPending(); }
  });

  $('#fileInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    loadText(await file.text(), file.name);
  });

  $('#parseBtn').addEventListener('click', () => {
    const text = $('#pasteBox').value.trim();
    if (!text) { toast('先貼上備份檔的內容，或直接選檔案。'); return; }
    loadText(text, '貼上的內容');
  });

  $('#clearPaste').addEventListener('click', () => {
    $('#pasteBox').value = '';
    state.incoming = null;
    state.report = null;
    renderPreview();
  });

  document.querySelectorAll('input[name="mode"]').forEach((el) => {
    el.addEventListener('change', renderPreview);
  });

  $('#preview').addEventListener('click', (e) => {
    if (e.target.id === 'confirmImport') doImport();
    if (e.target.id === 'exportFirst') askExport('plain');
    if (e.target.id === 'cancelImport') {
      state.incoming = null;
      state.report = null;
      renderPreview();
    }
  });

  $('#preview').addEventListener('change', (e) => {
    if (e.target.id === 'ackBackup') $('#confirmImport').disabled = !e.target.checked;
  });
}

async function init() {
  await store.init(SEED);
  state.current = redactExport(await store.exportAll());
  bind();
  renderCurrent();
  renderPending();
}

if (typeof document !== 'undefined') init();
