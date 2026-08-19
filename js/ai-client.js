/*
 * 潤稿的前端入口。第三期三個功能都只透過這裡碰 AI。
 *
 * 設計上只有一個承諾：**永遠不會讓畫面壞掉**。
 * 沒開通、沒網路、服務掛了、潤出來的東西被判定虛構——一律回傳原始骨架，
 * 並附上一句話說明為什麼。老師拿到的最差情況是「文字比較生硬」，
 * 不會是「按了沒反應」，更不會是「拿到一段編出來的評語」。
 */

import { AI_ENABLED, API } from './config.js';

/*
 * ── 姓名不出這台電腦 ──
 *
 * 事實包裡有 `student.name`、`className`、`perStudent[].name`，骨架文字裡也直接
 * 寫著學生的名字。這一支是整套系統唯一會把它們送出去的路徑（一支 fetch），
 * 所以遮蔽做在這裡，而不是叫三個呼叫端各自記得。
 *
 * 做法是**代換再還原**：送出去之前把姓名換成 `〔13號〕`、班名換成 `〔班級〕`，
 * 收回來再換回去。不用「送出去就不還原」是因為那樣老師拿到的評語通篇「這位同學」，
 * 還是得自己一個個改回來，等於這個功能白做。
 *
 * 全形括號的代號不會跟正文撞（正文不會出現 `〔`），而且潤稿端看到的就是
 * 一個明顯的佔位符，不會被當成需要潤飾的詞。**還原不了就整篇退回骨架**——
 * 寧可文字生硬，也不要交出一篇姓名被 AI 改掉或漏掉的評語。
 */

/** 從事實包裡挖出所有要遮的專有名詞，回傳 [真值, 代號] 的清單（長的排前面，先代換）。 */
export function nameTokens(facts) {
  const pairs = [];
  const push = (real, token) => {
    if (!real || typeof real !== 'string') return;
    if (pairs.some(([r]) => r === real)) return;
    pairs.push([real, token]);
  };

  push(facts?.className, '〔班級〕');
  push(facts?.student?.name, `〔${facts?.student?.no ?? '某'}號〕`);
  for (const s of facts?.perStudent || []) push(s.name, `〔${s.no ?? '某'}號〕`);

  // 長的先代換：短名字是長名字的一部分時（「陳語」與「陳語彤」），
  // 先換短的會把長的切成兩半，還原時就拼不回來了。
  return pairs.sort((a, b) => b[0].length - a[0].length);
}

const swap = (text, pairs, dir) =>
  pairs.reduce((acc, [real, token]) => acc.split(dir ? real : token).join(dir ? token : real), text);

/** 事實包裡的姓名欄位一律換成代號後才送出（不就地改呼叫端的物件）。 */
function maskFacts(facts, pairs) {
  return JSON.parse(swap(JSON.stringify(facts ?? {}), pairs, true));
}

/**
 * @param {string} skeleton 事實骨架（各功能自己組的純文字草稿）
 * @param {object} facts    summarize.js 產生的事實包，當作數字白名單送過去
 * @returns {Promise<{text: string, source: 'ai'|'skeleton', notice: string}>}
 */
export async function polish(skeleton, facts, { instruction = '' } = {}) {
  const raw = { text: skeleton, source: 'skeleton', notice: '' };
  if (!AI_ENABLED) return raw;

  const pairs = nameTokens(facts);
  const masked = swap(skeleton, pairs, true);
  // 只有真的出現在草稿裡的代號才要求還原。事實包裡有全班 30 個名字，
  // 但導師週報的草稿可能只點名其中三位——拿沒出現過的代號當判準，會永遠退回骨架。
  const inUse = pairs.filter(([, token]) => masked.includes(token));

  try {
    const res = await fetch(`${API.ai}/polish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        skeleton: masked,
        facts: maskFacts(facts, pairs),
        instruction,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.text) {
      // 代號被潤掉了就不還原——那代表 AI 動了姓名的位置，交出去會是錯的稱呼。
      const missing = inUse.filter(([, token]) => !data.text.includes(token));
      if (missing.length) {
        return { ...raw, notice: '潤稿回來的文字對不上原本的稱呼，先用原始草稿。' };
      }
      return { text: swap(data.text, pairs, false), source: 'ai', notice: '' };
    }
    return { ...raw, notice: data.error || `潤稿服務回應 ${res.status}，先用原始草稿。` };
  } catch (err) {
    return { ...raw, notice: `連不上潤稿服務（${err.message}），先用原始草稿。` };
  }
}
