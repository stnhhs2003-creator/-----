/*
 * 家長個人代碼（GAS 版）。
 *
 * 跟學生代碼是兩件事，不能共用同一組：學生代碼 4 位數擋的是「隔壁同學順手點開」，
 * 而且要先坐在教室裡才用得到；家長端的 Apps Script `/exec` 是一個誰都打得到的
 * 公開網址，4 位數只有一萬組，一支腳本幾分鐘就掃完，掃到的是一個孩子完整的
 * 正向紀錄。這一組測試守的就是「別把家長端的門做成學生端那麼薄」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PARENT_CODE_LENGTH,
  normalizeParentCode,
  parentCodeMatches,
  randomParentCode,
  usedParentCodes,
  reissueParentOne,
  ensureParentCodes,
} from '../js/codes.js';

const cls = () => ({
  id: 'c701',
  students: [
    { id: 'c701-s1', no: 1, name: '甲' },
    { id: 'c701-s2', no: 2, name: '乙', parentCode: 'k7m2npqr' },
  ],
});

test('代碼夠長，而且不用容易看錯的字元', () => {
  assert.ok(PARENT_CODE_LENGTH >= 8, '短於 8 碼在公開端擋不住暴力嘗試');
  for (let i = 0; i < 200; i++) {
    const c = randomParentCode();
    assert.equal(c.length, PARENT_CODE_LENGTH);
    assert.ok(/^[a-hj-km-np-z2-9]+$/.test(c), `${c} 含有 i／l／o／0／1 或大寫，家長照打會打錯`);
  }
});

test('正規化吃得下大小寫、空白與連字號', () => {
  assert.equal(normalizeParentCode(' K7M2-NPQR '), 'k7m2npqr');
  assert.ok(parentCodeMatches('K7M2-NPQR', 'k7m2npqr'));
});

test('沒發家長代碼的人，一律進不去', () => {
  assert.equal(parentCodeMatches('', ''), false);
  assert.equal(parentCodeMatches('k7m2npqr', undefined), false, '沒發碼卻讓人進來了');
  assert.equal(parentCodeMatches('', 'k7m2npqr'), false);
});

test('同一班不會發出兩組一樣的碼', () => {
  const taken = new Set(['aaaaaaaa']);
  for (let i = 0; i < 50; i++) assert.notEqual(randomParentCode(taken), 'aaaaaaaa');
});

test('usedParentCodes 收得到已發的碼，也排得掉自己那一筆', () => {
  assert.deepEqual([...usedParentCodes(cls())], ['k7m2npqr']);
  assert.deepEqual([...usedParentCodes(cls(), 'c701-s2')], []);
});

test('補發只換那一位，別人的碼不動', () => {
  const next = reissueParentOne(cls(), 'c701-s2');
  assert.notEqual(next.students[1].parentCode, 'k7m2npqr');
  assert.equal(next.students[0].parentCode, undefined);
  assert.equal(cls().students[1].parentCode, 'k7m2npqr', '就地改到了呼叫端的物件');
});

test('ensureParentCodes 只補缺的，已經有碼的人不會被換掉', () => {
  const { classes, added } = ensureParentCodes([cls()]);
  assert.equal(added, 1);
  assert.equal(classes[0].students[1].parentCode, 'k7m2npqr', '把已經發出去的碼換掉了');
  assert.ok(classes[0].students[0].parentCode);

  const again = ensureParentCodes(classes);
  assert.equal(again.added, 0);
  assert.equal(again.classes, classes, '沒事做的時候不該回一份新陣列，會白存一次檔');
});

test('學生代碼與家長代碼是兩個欄位，互不覆蓋', () => {
  const withBoth = { ...cls(), students: [{ id: 'c701-s1', no: 1, code: '4821' }] };
  const { classes } = ensureParentCodes([withBoth]);
  assert.equal(classes[0].students[0].code, '4821', '家長代碼把學生代碼蓋掉了');
  assert.ok(classes[0].students[0].parentCode);
});
