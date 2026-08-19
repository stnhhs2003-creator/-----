/*
 * 投影層：把事件流算成分數、趨勢、告急。
 * 這裡不碰儲存，也不碰 DOM——純函式，好測也好搬。
 */

/**
 * 事件屬於哪一天——用本地時區算，不要用 ts.slice(0, 10)。
 *
 * 台灣是 UTC+8，早自習 08:00 前發生的事，ISO 字串的前十碼會是「前一天」。
 * 導師眼中「昨天早自習很吵」會被算成前天，日期一錯，老師就對不上自己的記憶。
 */
export function localDay(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function daysAgoISO(n, now = new Date()) {
  const d = startOfDay(now);
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

/**
 * 行為事件才算行為統計。積分商店的兌換（kind: 'redeem'）會扣分，
 * 但它不是「表現變差」，所以只進餘額、不進行為統計與告急判斷。
 */
export const isBehaviorEvent = (e) => e.kind === 'positive' || e.kind === 'improve';

/** 每位學生的可用餘額。兌換也算進來，因為點數花掉就是花掉了。 */
export function scoreByStudent(events) {
  const map = new Map();
  events.forEach((e) => map.set(e.studentId, (map.get(e.studentId) || 0) + e.delta));
  return map;
}

/** 每位學生的正向／待改進次數。 */
export function countsByStudent(events) {
  const map = new Map();
  events.filter(isBehaviorEvent).forEach((e) => {
    const c = map.get(e.studentId) || { positive: 0, improve: 0 };
    c[e.kind === 'positive' ? 'positive' : 'improve']++;
    map.set(e.studentId, c);
  });
  return map;
}

/** 逐日淨分，用來畫趨勢。 */
export function dailyTotals(events, days = 7) {
  const buckets = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = startOfDay();
    d.setDate(d.getDate() - i);
    buckets.push({ date: d, label: `${d.getMonth() + 1}/${d.getDate()}`, positive: 0, improve: 0, net: 0 });
  }
  events.filter(isBehaviorEvent).forEach((e) => {
    const t = startOfDay(new Date(e.ts)).getTime();
    const b = buckets.find((x) => x.date.getTime() === t);
    if (!b) return;
    if (e.kind === 'positive') b.positive += e.delta;
    else b.improve += Math.abs(e.delta);
    b.net += e.delta;
  });
  return buckets;
}

/**
 * 告急規則。回傳給老師端看的提示，不外流到家長端。
 * 規則一：某生在觀察窗內連續 N 次待改進（中間沒有正向紀錄打斷）。
 * 規則二：同一天同一節課，全班待改進達 M 次。
 */
export function detectAlerts(events, students, settings, now = new Date()) {
  const alerts = [];
  const nameOf = (id) => (students.find((s) => s.id === id) || {}).name || id;

  // now 讓呼叫端指定「站在哪一天回頭看」。預設就是此刻，所以現有呼叫不用改。
  // 週報要回顧上一週時，觀察窗必須跟著移過去，否則事件全落在窗外、名單永遠是空的。
  const windowStart = daysAgoISO(settings.alertConsecutiveWindowDays - 1, now);
  const recent = events.filter((e) => e.ts >= windowStart && isBehaviorEvent(e));

  // 規則一
  const byStudent = new Map();
  recent.forEach((e) => {
    if (!byStudent.has(e.studentId)) byStudent.set(e.studentId, []);
    byStudent.get(e.studentId).push(e);
  });
  byStudent.forEach((list, studentId) => {
    list.sort((a, b) => a.ts.localeCompare(b.ts));
    let streak = 0;
    let last = null;
    list.forEach((e) => {
      if (e.kind === 'improve') {
        streak++;
        last = e;
      } else {
        streak = 0;
      }
    });
    // last 為 null 代表這位學生在觀察窗內一次待改進都沒有。
    // 門檻若被設成 0（還原一份手改過的備份就可能發生），streak >= 0 會成立，
    // 接著讀 last.period 就整頁炸掉——座位表的告急區一炸，整個畫面都不會 render。
    if (last && streak >= settings.alertConsecutiveImprove) {
      alerts.push({
        level: 'student',
        studentId,
        title: `${nameOf(studentId)} 連續 ${streak} 次待改進`,
        detail: `最近 ${settings.alertConsecutiveWindowDays} 天內未被正向紀錄打斷，最後一次是「${last.period || '未註明節次'}」。`,
        ts: last.ts,
      });
    }
  });

  // 規則二
  const byPeriod = new Map();
  recent.filter((e) => e.kind === 'improve').forEach((e) => {
    const day = localDay(e.ts);
    const key = `${day}|${e.period || '未註明'}`;
    byPeriod.set(key, (byPeriod.get(key) || 0) + 1);
  });
  byPeriod.forEach((count, key) => {
    if (count >= settings.alertClassImprovePerPeriod) {
      const [day, period] = key.split('|');
      alerts.push({
        level: 'class',
        title: `${day} ${period} 全班待改進 ${count} 次`,
        detail: '整節課的秩序可能出了狀況，值得回想當時發生什麼事。',
        ts: `${day}T23:59:59.000Z`,
      });
    }
  });

  return alerts.sort((a, b) => b.ts.localeCompare(a.ts));
}

/**
 * 超過保存期限的班級。
 *
 * 個資法第 11 條第 3 項要求「特定目的消失應主動刪除」——重點在「主動」。
 * 老師不會記得去翻三年前的班級，所以要由系統把逾期的班級撈出來提醒。
 *
 * 判準是「這個班最後一筆紀錄距今多久」，不是建立日期：
 * 一個班只要還在記錄就代表目的還在，停止記錄才是目的消失的訊號。
 * 完全沒有紀錄的班級不算逾期——那只是還沒開始用。
 */
export function expiredClasses(classes, events, retentionMonths, now = new Date()) {
  if (!retentionMonths || retentionMonths <= 0) return [];
  // 回推月份不能直接 setMonth——3/31 減一個月會做出「2 月 31 日」，
  // JS 自動溢位成 3/3，界線整整跑掉三天，老師會被提早叫去刪學生紀錄。
  // 先把日期壓到 1 號再退月，最後夾回該月實際的最後一天。
  const cutoff = new Date(now);
  const day = cutoff.getDate();
  cutoff.setDate(1);
  cutoff.setMonth(cutoff.getMonth() - retentionMonths);
  const lastDayOfMonth = new Date(cutoff.getFullYear(), cutoff.getMonth() + 1, 0).getDate();
  cutoff.setDate(Math.min(day, lastDayOfMonth));
  const cutoffISO = cutoff.toISOString();

  return (classes || [])
    .map((cls) => {
      const mine = events.filter((e) => e.classId === cls.id);
      if (!mine.length) return null;
      const lastTs = mine.reduce((m, e) => (e.ts > m ? e.ts : m), '');
      return lastTs < cutoffISO
        ? { classId: cls.id, name: cls.name, lastTs, count: mine.length }
        : null;
    })
    .filter(Boolean);
}

/**
 * 家長端投影：只取正向事件與進步曲線。
 * 這是設計紅線——負向紀錄永遠不進這個函式的輸出。
 */
export function parentView(events, studentId) {
  // 已撤銷的紀錄一律不算。呼叫端若不小心餵進 includeVoided 的事件，
  // 撤銷掉的稱讚也不該再出現在家長眼前。
  const mine = events.filter((e) => e.studentId === studentId && !e.voided);
  const positives = mine.filter((e) => e.kind === 'positive');
  const byBehavior = new Map();
  positives.forEach((e) => byBehavior.set(e.behaviorId, (byBehavior.get(e.behaviorId) || 0) + 1));
  return {
    totalPositive: positives.reduce((s, e) => s + e.delta, 0),
    count: positives.length,
    highlights: [...byBehavior.entries()].sort((a, b) => b[1] - a[1]),
    recent: positives.slice(-10).reverse(),
  };
}
