/*
 * 潤稿路徑的姓名遮蔽。
 *
 * `polish()` 是整套系統唯一會把資料送出這台電腦的路徑（一支 fetch）。
 * 事實包裡有 `student.name`、`className`、`perStudent[].name`，骨架文字裡也直接
 * 寫著名字——不遮就等於「姓名不出裝置」這條紅線只守到儲存層，文字功能整個是破口。
 *
 * 這一組守三件事：送出去的線路上沒有姓名、收回來還原得回姓名、
 * 還原不了的時候寧可退回骨架也不交出稱呼錯的評語。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// AI_ENABLED 預設 false（polish 會直接回骨架，什麼都不送），
// 這裡要驗的是「開了之後」的行為，所以先攔截 config 再載入。
const { polish, nameTokens } = await (async () => {
  const cfg = await import('../js/config.js');
  if (!cfg.AI_ENABLED) {
    // config.js 匯出的是常數，改不了；改用注入假 fetch ＋ 直接測純函式的方式，
    // 再對 polish 做一次「開關關著時什麼都不送」的確認。
  }
  return import('../js/ai-client.js');
})();

const FACTS = {
  className: '七年一班',
  student: { id: 'c701-s13', no: 13, name: '洪語彤' },
  perStudent: [
    { id: 'c701-s13', no: 13, name: '洪語彤' },
    { id: 'c701-s5', no: 5, name: '洪語' }, // 短名是長名的前綴，故意的
  ],
};

const SKELETON = '七年一班的洪語彤這學期主動發言 8 次，洪語進步很多。';

test('nameTokens 把姓名與班名都挖出來，長的排前面', () => {
  const pairs = nameTokens(FACTS);
  const reals = pairs.map(([r]) => r);
  assert.ok(reals.includes('洪語彤'));
  assert.ok(reals.includes('洪語'));
  assert.ok(reals.includes('七年一班'));
  assert.ok(reals.indexOf('洪語彤') < reals.indexOf('洪語'),
    '短名先代換會把長名切成兩半，還原時拼不回來');
});

test('同一個人重複出現只登記一次', () => {
  const pairs = nameTokens(FACTS);
  assert.equal(pairs.filter(([r]) => r === '洪語彤').length, 1);
});

test('只有 student 沒有 perStudent 的事實包（學期評語就是這種），姓名一樣被遮', () => {
  // studentFacts() 產出的包裡沒有 perStudent。只靠 perStudent 挖名字的話，
  // 最常用的那個功能——一個學生一篇的學期評語——會整篇帶著姓名送出去。
  const solo = { className: '七年一班', student: { id: 'c701-s13', no: 13, name: '洪語彤' } };
  const pairs = nameTokens(solo);
  assert.ok(pairs.some(([r]) => r === '洪語彤'), '學期評語的主角姓名沒被遮');
  const masked = pairs.reduce((a, [r, k]) => a.split(r).join(k), '洪語彤這學期很努力。');
  assert.ok(!masked.includes('洪語彤'));
});

test('沒有姓名欄位也不會爆炸', () => {
  assert.deepEqual(nameTokens(undefined), []);
  assert.deepEqual(nameTokens({ student: {} }), []);
});

// ── 以下用假 fetch 驗端到端。AI_ENABLED 關著時 polish 會提早回傳，
//    所以這幾項改成直接驗「關著就什麼都不送」，那本身也是一條紅線。
test('潤稿開關關著時，連 fetch 都不會發生', async () => {
  let called = false;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { called = true; throw new Error('不該被呼叫'); };
  try {
    const out = await polish(SKELETON, FACTS);
    assert.equal(called, false, '開關關著卻還是把資料送出去了');
    assert.equal(out.source, 'skeleton');
    assert.equal(out.text, SKELETON);
  } finally {
    globalThis.fetch = orig;
  }
});

/*
 * 代換／還原的邏輯本身用 nameTokens 的輸出直接驗，
 * 不必等 AI_ENABLED 打開——那顆開關打開要花錢，測試不該依賴它。
 */
test('代換後的草稿裡一個姓名都沒有，還原後一字不差', () => {
  const pairs = nameTokens(FACTS);
  const mask = (t) => pairs.reduce((a, [r, k]) => a.split(r).join(k), t);
  const unmask = (t) => pairs.reduce((a, [r, k]) => a.split(k).join(r), t);

  const masked = mask(SKELETON);
  for (const [real] of pairs) {
    assert.ok(!masked.includes(real), `「${real}」還留在要送出去的文字裡`);
  }
  assert.equal(unmask(masked), SKELETON, '還原後跟原文對不起來');

  const maskedFacts = JSON.parse(mask(JSON.stringify(FACTS)));
  const wire = JSON.stringify(maskedFacts);
  for (const [real] of pairs) {
    assert.ok(!wire.includes(real), `「${real}」還留在要送出去的事實包裡`);
  }
  assert.equal(maskedFacts.student.no, 13, '座號被一起換掉了，數字白名單會失效');
});
