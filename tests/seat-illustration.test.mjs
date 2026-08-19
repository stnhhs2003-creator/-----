import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

const rootFile = (path) => new URL(`../${path}`, import.meta.url);

test('座位表標題有裝飾性方形配圖，圖片失敗時仍保留文字標題', async () => {
  const [html, css, image] = await Promise.all([
    readFile(rootFile('index.html'), 'utf8'),
    readFile(rootFile('assets/style.css'), 'utf8'),
    stat(rootFile('assets/seat-map-ink.webp')),
  ]);

  assert.match(html, /<img class="seat-heading-art" src="\/assets\/seat-map-ink\.webp" alt="" width="84" height="84" decoding="async">/);
  assert.match(html, /<div class="seat-heading">[\s\S]*<h2>座位表<\/h2>/);
  assert.match(css, /\.seat-heading-art \{[^}]*aspect-ratio: 1[^}]*object-fit: cover/s);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.seat-heading-art \{ width: 64px; height: 64px;/);
  assert.ok(image.size > 0 && image.size < 30 * 1024);
});
