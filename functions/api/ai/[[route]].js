/*
 * 潤稿 API（第三期）。
 *
 * 這支不是「請 AI 寫評語」，是「請 AI 把老師的資料潤成人話」——差別很大。
 * 事實骨架由前端用 summarize.js 的事實包產生，這裡只做語氣加工；
 * 模型不會拿到原始事件流，也沒有任何空間去發揮它沒看過的東西。
 *
 * 三道閘門，缺一不可：
 * 1. requireTeacher()：只有登入的老師能燒金鑰。沒有這道，網址一外流就是別人在花你的錢。
 * 2. 系統提示詞寫死在伺服器：前端送什麼都不能改寫規則。
 * 3. 數字白名單：潤完的文字裡只要出現骨架與事實包都沒有的數字，就判定虛構、退回骨架。
 *    第三道才是真的防線——前兩道都只是「拜託模型自律」，這一道是機器檢查。
 */

import { requireTeacher, Unauthorized } from '../../_lib/session.js';

const DEFAULT_MODEL = 'claude-sonnet-5';
const MAX_SKELETON = 4000;
const MAX_OUTPUT_TOKENS = 1024;

const SYSTEM_PROMPT = `你是台灣國中導師的文字助手，把老師提供的「事實骨架」潤飾成通順的繁體中文（台灣用語）。

絕對規則：
1. 只能改寫措辭與語氣，不得新增任何事實、數字、事件、日期或人名。
2. 骨架裡沒有的具體事例，一個字都不能編。寧可句子平淡，也不准補細節。
3. 不下標籤式評斷（例如「個性內向」「態度不佳」），只描述行為與觀察。
4. 不使用條列符號與 Markdown，輸出純文字段落。
5. 直接輸出潤飾後的文字本身，不要任何前言、說明或引號。`;

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/**
 * 抽出一段文字裡出現的所有數字。
 * 全形數字先轉半形，否則模型輸出「３次」就繞過檢查了。
 */
export function numbersIn(value) {
  const out = new Set();
  const scan = (text) => {
    const half = String(text).replace(/[０-９]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    (half.match(/\d+/g) || []).forEach((n) => out.add(String(Number(n))));
  };
  const walk = (v) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v === 'object') return Object.values(v).forEach(walk);
    scan(v);
  };
  walk(value);
  return out;
}

/**
 * 潤完的文字裡有沒有憑空冒出來的數字？
 * 中文數字不檢查——「三次」這種寫法模型本來就會用，而且它改寫的是骨架裡的阿拉伯數字，
 * 真正危險的是「多了一個誰都沒看過的數量」，那一定以阿拉伯數字出現。
 */
export function fabricatedNumbers(text, allowed) {
  return [...numbersIn(text)].filter((n) => !allowed.has(n));
}

async function callClaude(env, userContent) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.AI_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: env.AI_MODEL || DEFAULT_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`潤稿服務回應 ${res.status}：${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.content || []).map((c) => c.text || '').join('').trim();
}

/**
 * @param {Function} llm  注入點：測試時換成假的，才不用打網路也不用金鑰。
 */
export async function handleAi(request, env, llm = callClaude) {
  try {
    await requireTeacher(request, env);
  } catch (err) {
    if (err instanceof Unauthorized) return json({ error: '請先登入。' }, 401);
    throw err;
  }

  const path = new URL(request.url).pathname.replace(/^\/api\/ai/, '') || '/';
  if (request.method !== 'POST' || path !== '/polish') {
    return json({ error: `不認得的路徑：${request.method} ${path}` }, 404);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '請求格式不對。' }, 400);
  }

  const skeleton = String(body.skeleton || '').trim();
  if (!skeleton) return json({ error: '沒有骨架就沒有東西可以潤。' }, 400);
  if (skeleton.length > MAX_SKELETON) return json({ error: '骨架太長了。' }, 400);

  if (!env || !env.AI_API_KEY) {
    // 沒設金鑰不是錯誤，是還沒開通。前端收到這個會安靜地用骨架，不會壞掉。
    return json({ error: '尚未設定潤稿服務，先用原始草稿。', fallback: true }, 503);
  }

  const allowed = numbersIn({ skeleton, facts: body.facts || {} });
  const instruction = body.instruction ? `\n\n額外要求：${String(body.instruction).slice(0, 200)}` : '';

  let text;
  try {
    text = await llm(env, `以下是事實骨架，請潤飾成通順的段落：\n\n${skeleton}${instruction}`);
  } catch (err) {
    return json({ error: err.message || '潤稿失敗。', fallback: true }, 502);
  }

  if (!text) return json({ error: '潤稿服務沒有回傳內容。', fallback: true }, 502);

  const bad = fabricatedNumbers(text, allowed);
  if (bad.length) {
    return json({
      error: `潤稿結果出現原始資料沒有的數字（${bad.join('、')}），已退回原始草稿。`,
      fallback: true,
    }, 422);
  }

  return json({ text });
}

export async function onRequest(context) {
  return handleAi(context.request, context.env);
}
