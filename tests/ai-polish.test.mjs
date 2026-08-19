/*
 * 潤稿 API 測試。
 *
 * 這裡真正要守的是一件事：**模型不能編東西**。
 * 提示詞寫得再好都只是拜託，能不能擋住要看數字白名單這道機器檢查——
 * 所以下面每一個「模型亂加數字」的情境都必須被退回骨架，不是被信任地放行。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleAi, numbersIn, fabricatedNumbers } from '../functions/api/ai/[[route]].js';

const ENV = { DEV_TEACHER_ID: 't-alice', AI_API_KEY: 'sk-test' };
const SKELETON = '陳映彤這學期有 12 次正向紀錄，其中主動發言 5 次。';
const FACTS = { totals: { positive: 12 }, positiveTop: [{ label: '主動發言', count: 5 }] };

function req(body, url = 'http://localhost/api/ai/polish', method = 'POST') {
  return new Request(url, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

const reply = (text) => async () => text;

// ---- 數字抽取 ----

test('全形數字也算數，否則模型輸出「１５次」就繞過檢查了', () => {
  const found = numbersIn('他有 １５ 次紀錄');
  assert.ok(found.has('15'));
});

test('前導零正規化，08 與 8 視為同一個數', () => {
  assert.deepEqual(fabricatedNumbers('第 8 週', numbersIn('第 08 週')), []);
});

test('事實包裡的數字也算合法來源，不只骨架', () => {
  const allowed = numbersIn({ skeleton: '他表現不錯', facts: { net: 47 } });
  assert.deepEqual(fabricatedNumbers('淨分 47 分', allowed), []);
});

// ---- 防虛構 ----

test('模型憑空多出一個數字就退回骨架，不會交給老師', async () => {
  const res = await handleAi(
    req({ skeleton: SKELETON, facts: FACTS }),
    ENV,
    reply('陳映彤這學期有 12 次正向紀錄，主動發言 5 次，並擔任小組長達 9 週。'),
  );
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.fallback, true);
  assert.match(body.error, /9/);
  assert.equal(body.text, undefined, '被判定虛構時絕不能還把文字送出去');
});

test('只改措辭、數字都對得上就放行', async () => {
  const res = await handleAi(
    req({ skeleton: SKELETON, facts: FACTS }),
    ENV,
    reply('這學期映彤累積了 12 次正向紀錄，其中有 5 次是主動發言。'),
  );
  assert.equal(res.status, 200);
  assert.match((await res.json()).text, /12/);
});

test('把數字換成全形也擋得住——這是最容易被繞過的一條路', async () => {
  const res = await handleAi(
    req({ skeleton: SKELETON, facts: FACTS }),
    ENV,
    reply('陳映彤有 12 次正向紀錄，遲到 ３ 次。'),
  );
  assert.equal(res.status, 422);
});

// ---- 閘門 ----

test('沒登入不能燒金鑰', async () => {
  const res = await handleAi(req({ skeleton: SKELETON }), { AI_API_KEY: 'sk-test' }, reply('x'));
  assert.equal(res.status, 401);
});

test('沒設金鑰時安靜地要前端用骨架，不是噴錯', async () => {
  const res = await handleAi(req({ skeleton: SKELETON }), { DEV_TEACHER_ID: 't-alice' }, reply('x'));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).fallback, true);
});

test('潤稿服務掛掉時回 fallback，不會讓畫面卡住', async () => {
  const boom = async () => { throw new Error('上游 500'); };
  const res = await handleAi(req({ skeleton: SKELETON, facts: FACTS }), ENV, boom);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).fallback, true);
});

test('空骨架直接擋掉，不浪費一次呼叫', async () => {
  const res = await handleAi(req({ skeleton: '   ' }), ENV, reply('x'));
  assert.equal(res.status, 400);
});

test('超長骨架擋掉，避免一次請求就吃掉大筆額度', async () => {
  const res = await handleAi(req({ skeleton: 'x'.repeat(5000) }), ENV, reply('x'));
  assert.equal(res.status, 400);
});

test('不認得的路徑回 404', async () => {
  const res = await handleAi(req({ skeleton: SKELETON }, 'http://localhost/api/ai/write'), ENV, reply('x'));
  assert.equal(res.status, 404);
});

test('額外要求會被截斷，不能靠它塞進一整套新指令', async () => {
  let seen = '';
  await handleAi(
    req({ skeleton: SKELETON, facts: FACTS, instruction: '好'.repeat(500) }),
    ENV,
    async (_env, content) => { seen = content; return SKELETON; },
  );
  assert.ok(seen.length < SKELETON.length + 300, '額外要求沒有被截斷');
});
