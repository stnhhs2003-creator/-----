import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';

const rootFile = (path) => new URL(`../${path}`, import.meta.url);

test('更多工具的每個入口都有配圖與文字說明', async () => {
  const html = await readFile(rootFile('index.html'), 'utf8');
  const images = [...html.matchAll(/<img class="tool-illustration" src="([^"]+)" alt="" width="56" height="56" loading="lazy" decoding="async">/g)];
  assert.equal(images.length, 11);
  /*
   * 「使用說明」暫時借用隱私說明那張圖，所以圖片會少一張——
   * 不同入口配同一張圖是可接受的過渡，但別讓它擴散：這裡盯住只有一組重複。
   */
  assert.equal(new Set(images.map((match) => match[1])).size, 10);
  assert.equal((html.match(/<small>/g) || []).length >= 11, true);

  for (const [, src] of images) {
    const info = await stat(rootFile(src.replace(/^\//, '')));
    assert.ok(info.size > 0, `${src} 不可為空檔`);
    assert.ok(info.size < 60 * 1024, `${src} 應小於 60 KB`);
  }
});

test('工具圖卡在手機可內部捲動，字級走 rem 才跟得上總開關', async () => {
  const css = await readFile(rootFile('assets/style.css'), 'utf8');
  const menuRule = css.match(/\.tab-links \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(menuRule, /max-height:/);
  assert.match(menuRule, /overflow-y: auto/);
  assert.match(menuRule, /overscroll-behavior: contain/);
  assert.match(css, /\.tool-illustration \{[^}]*aspect-ratio: 1[^}]*object-fit: cover/s);
  assert.match(css, /@media \(max-width: 390px\)[\s\S]*\.tool-grid \{ grid-template-columns: 1fr; \}/);
  assert.match(css, /@media \(max-width: 360px\)[\s\S]*\.tab \{ padding-inline: 8px; font-size: 0\.875rem; \}/);
  // 全站字級的總開關。改這一個值就整站一起縮放。
  assert.match(css, /:root \{[\s\S]*?font-size: 18px;/);
});

/*
 * 老師多半是拿手機在教室裡點，字級由 :root 那一個 font-size 統一放大。
 * 只要有人在任何一支 CSS 把 font-size 寫回 px，那個開關就對它失效，
 * 而且畫面上只會小一塊、不容易發現。所以這裡掃的是全部 CSS，不只 style.css。
 */
test('沒有任何一支 CSS 用 px 寫字級（:root 的總開關除外）', async () => {
  const dir = new URL('../assets/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.css'));
  assert.ok(files.length >= 10, `assets 裡應該有十幾支 CSS，實際 ${files.length}`);

  for (const f of files) {
    const css = await readFile(new URL(f, dir), 'utf8');
    const body = css.replace(/:root \{[\s\S]*?\n\}/, '');
    const px = body.match(/font-size:\s*[\d.]+px/g) || [];
    assert.deepEqual(px, [], `${f} 還有 px 字級：${px.join('、')}`);
  }
});
