/*
 * 積分商店與學生端共用的純函式層（第二期 2.1 / 2.2）。
 * 這一層不碰 DOM，只碰資料，方便直接用 node 跑驗證。
 *
 * 兌換不新增儲存結構，全部走既有事件流：
 *   redeem-request  delta 0   學生送出申請
 *   redeem          delta -cost  老師核可後真正扣點
 * rules.js 的 isBehaviorEvent() 已經把這兩種排除在行為統計之外，
 * 但 scoreByStudent() 會把 redeem 的負 delta 算進餘額——這正是我們要的。
 */

import { scoreByStudent, isBehaviorEvent, startOfDay } from './rules.js';
import { participating } from './optout.js';

/*
 * 第一次進入商店時的預設品項。
 * 定價要對得上實際賺點速度：一張正向卡 2–4 點，一週大約 5–10 點。
 * 入門品項壓在 8–12 點，讓學生兩週內兌換得到第一樣東西——
 * 門檻訂太高商店就形同虛設，學生不會有動機，老師也就不會持續記錄。
 */
export const DEFAULT_REWARDS = [
  { id: 'r-lunch', name: '午餐優先排隊券', cost: 8, stock: 20, active: true },
  { id: 'r-song', name: '班級點歌', cost: 12, stock: null, active: true },
  { id: 'r-nohw', name: '免作業券', cost: 20, stock: 10, active: true },
  { id: 'r-teacher', name: '和老師約談十分鐘', cost: 25, stock: null, active: true },
  { id: 'r-seat', name: '自選座位一週', cost: 35, stock: 4, active: true },
];

export function newRewardId() {
  return 'r-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** 獎勵清單是空的就補上預設品項。回傳最終清單。 */
export async function ensureRewards(store) {
  const rewards = await store.getRewards();
  if (rewards && rewards.length) return rewards;
  const seeded = DEFAULT_REWARDS.map((r) => ({ ...r }));
  await store.saveRewards(seeded);
  return seeded;
}

/** 餘額一律由事件流投影，不另外累加。 */
export function balanceOf(events, studentId) {
  return scoreByStudent(events.filter((e) => e.studentId === studentId)).get(studentId) || 0;
}

/** 某位學生尚未處理的兌換申請。 */
export function pendingRequests(events, studentId) {
  return events.filter(
    (e) => !e.voided && e.kind === 'redeem-request' && (!studentId || e.studentId === studentId)
  );
}

/**
 * 學生端可動用的點數 = 餘額 − 已送出但還沒處理的申請所需點數。
 * 申請事件 delta 是 0，不先扣起來的話學生可以無限連按送申請。
 */
export function availableOf(events, studentId, rewards) {
  const costOf = (id) => (rewards.find((r) => r.id === id) || {}).cost || 0;
  const held = pendingRequests(events, studentId).reduce((s, e) => s + costOf(e.behaviorId), 0);
  return balanceOf(events, studentId) - held;
}

/**
 * 核可前的最後把關：學生申請後到老師核可之間可能又被扣分，這裡用當下餘額重算。
 * 回傳 { ok, reason }。
 */
export function canApprove(events, studentId, reward) {
  if (!reward) return { ok: false, reason: '這項獎勵已經被刪掉了，請退回這筆申請。' };
  const balance = balanceOf(events, studentId);
  if (balance < reward.cost) {
    return { ok: false, reason: `餘額只剩 ${balance} 點，還差 ${reward.cost - balance} 點，先擋下來。` };
  }
  if (reward.stock !== null && reward.stock !== undefined && reward.stock <= 0) {
    return { ok: false, reason: '這項獎勵庫存已經是 0，無法核可。' };
  }
  return { ok: true, reason: '' };
}

/** 核可後的庫存變化：有設定才遞減，扣到 0 自動下架。 */
export function afterStockDecrement(reward) {
  if (reward.stock === null || reward.stock === undefined) return { ...reward };
  const stock = Math.max(0, reward.stock - 1);
  return { ...reward, stock, active: stock > 0 ? reward.active : false };
}

/** 近 n 天的起點（含今天），回傳 ISO 字串。 */
function daysBackISO(n) {
  const d = startOfDay();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

/**
 * 進步幅度：本週淨分 − 上週淨分。
 * 只看行為事件，兌換花掉的點數不該被讀成「退步」。
 */
export function weeklyDelta(events, studentId) {
  const thisStart = daysBackISO(6);
  const lastStart = daysBackISO(13);
  const mine = events.filter((e) => e.studentId === studentId && isBehaviorEvent(e));
  const sum = (from, to) =>
    mine.filter((e) => e.ts >= from && (!to || e.ts < to)).reduce((s, e) => s + e.delta, 0);
  return sum(thisStart, null) - sum(lastStart, thisStart);
}

/**
 * 班級榜資料列。淨分即可用點數（含兌換扣點），排名由高到低。
 *
 * 不參與記錄的學生在這裡就被濾掉——班級榜是會投影出來的東西，
 * 一個名字出現在榜上而分數永遠是 0，比不出現還顯眼。
 */
export function rankRows(events, students) {
  return participating(students)
    .map((s) => ({
      student: s,
      net: balanceOf(events, s.id),
      delta: weeklyDelta(events, s.id),
    }))
    .sort((a, b) => b.net - a.net || a.student.no - b.student.no)
    .map((row, i, arr) => {
      // 同分同名次。名次要自己往下傳——map 的 arr 參數是「還沒編號」的原陣列，
      // 回頭讀 arr[i-1].rank 只會拿到 undefined，班級榜上就會出現「undefined 謝欣妤 +7」。
      const rank = i > 0 && arr[i - 1].net === row.net ? arr[i - 1].rank : i + 1;
      arr[i].rank = rank;
      return { ...row, rank };
    });
}

/**
 * 每週正向分數，畫成長長條圖用。只取 kind === 'positive'，
 * 學生端不得出現任何負向資料。
 */
export function weeklyPositive(events, studentId, weeks = 6) {
  const buckets = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const from = daysBackISO(i * 7 + 6);
    const to = i === 0 ? null : daysBackISO(i * 7 - 1);
    buckets.push({ label: i === 0 ? '本週' : `${i} 週前`, from, to, value: 0 });
  }
  events
    .filter((e) => e.studentId === studentId && e.kind === 'positive')
    .forEach((e) => {
      const b = buckets.find((x) => e.ts >= x.from && (!x.to || e.ts < x.to));
      if (b) b.value += e.delta;
    });
  return buckets;
}

/** 學生端只看得到正向紀錄——這是這一頁的紅線。 */
export function positiveRecords(events, studentId, limit = 12) {
  return events
    .filter((e) => e.studentId === studentId && e.kind === 'positive')
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, limit);
}
