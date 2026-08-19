import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { escapeHtml } from '../js/dom-safe.js';
import { DEFAULT_SETTINGS, DEMO_CLASSES } from '../js/data.js';

const text = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('escapeHtml：匯入的名冊與行為文字不能形成 DOM XSS', () => {
  assert.equal(
    escapeHtml(`<img src=x onerror="alert('x')">&`),
    '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;',
  );
});

test('主畫面所有可匯入文字都經過共同的 HTML escaping', async () => {
  const app = await text('js/app.js');
  assert.match(app, /import \{ escapeHtml as esc \}/);
  for (const guarded of ['esc(c.name)', 'esc(s.name)', 'esc(b.label)', 'esc(a.detail)', 'esc(e.period']) {
    assert.ok(app.includes(guarded), `缺少防護：${guarded}`);
  }
});

test('示範資料不使用像真實學生的姓名，也沒有固定家長通過碼', () => {
  const names = DEMO_CLASSES.flatMap((cls) => cls.students.map((student) => student.name));
  assert.equal(names.length, 36);
  assert.ok(names.every((name) => /^示範\d{2}$/.test(name)));
  assert.equal(DEFAULT_SETTINGS.parentCode, '');
});

test('本機模式的學生端與家長端在讀取資料前即停止', async () => {
  const [student, parent, bindings] = await Promise.all([
    text('js/student.js'), text('js/parent.js'), text('js/bindings.js'),
  ]);
  assert.match(student, /if \(STORE_BACKEND !== 'cloud'\)[\s\S]*return;[\s\S]*await store\.init/);
  assert.match(parent, /if \(!CLOUD_ENABLED\)[\s\S]*return;[\s\S]*if \(CLOUD_ENABLED\)/);
  assert.match(bindings, /if \(!CLOUD_ENABLED\)[\s\S]*return;[\s\S]*await store\.init/);
});

test('教師主畫面必須先通過裝置鎖，且密碼不以明文保存', async () => {
  const [app, lock] = await Promise.all([text('js/app.js'), text('js/teacher-lock.js')]);
  assert.match(app, /await requireTeacherUnlock\(\);[\s\S]*await store\.init/);
  assert.match(lock, /crypto\.subtle\.deriveBits/);
  assert.match(lock, /iterations: 120000/);
  assert.doesNotMatch(lock, /localStorage\.setItem\(LOCK_KEY, pin\.value\)/);
});

test('安全標頭與私密 API 快取規則已部署為靜態設定', async () => {
  const headers = await text('_headers');
  for (const header of [
    'Content-Security-Policy:', 'Strict-Transport-Security:', 'X-Frame-Options: DENY',
    'X-Content-Type-Options: nosniff', 'Permissions-Policy:', 'Cache-Control: no-store',
  ]) assert.ok(headers.includes(header), `缺少 ${header}`);
});

test('核心分頁具備 tab 狀態、tabpanel 關聯與 44px 觸控目標', async () => {
  const [html, css] = await Promise.all([text('index.html'), text('assets/style.css')]);
  assert.match(html, /aria-controls="view-record"/);
  assert.match(html, /role="tabpanel" aria-labelledby="tab-record"/);
  assert.match(html, /aria-labelledby="detailTitle"/);
  assert.match(css, /\.btn-sm \{[^}]*min-height: 44px/s);
  assert.match(css, /prefers-reduced-motion/);
});

test('更多工具下拉不會被導覽列的 overflow 裁切', async () => {
  const css = await text('assets/style.css');
  const tabsRule = css.match(/\.tabs \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(tabsRule, /overflow: visible/);
  assert.doesNotMatch(tabsRule, /overflow-x: auto/);
});
