import test from 'node:test';
import assert from 'node:assert/strict';
import { stat, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { SEED } from '../js/data.js';
import {
  AVATAR_TOTAL,
  BEHAVIOR_ART,
  behaviorArtPath,
  studentAvatarPath,
} from '../js/visual-assets.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('36 位預設學生各自使用不同的 Q 版頭像', async () => {
  const students = SEED.classes.flatMap((cls) => cls.students);
  const paths = students.map((student) => studentAvatarPath(student.id, SEED.classes));

  assert.equal(students.length, AVATAR_TOTAL);
  assert.equal(new Set(paths).size, AVATAR_TOTAL);

  for (const assetPath of paths) {
    const info = await stat(path.join(root, assetPath));
    assert.ok(info.size > 0 && info.size < 25_000, `${assetPath} 應已壓縮且可讀`);
  }
});

test('12 張預設行為卡各自使用不同的 Q 版圖', async () => {
  const paths = Object.keys(BEHAVIOR_ART).map(behaviorArtPath);
  assert.equal(paths.length, 12);
  assert.equal(new Set(paths).size, 12);
  assert.equal(behaviorArtPath('custom-card'), '');

  for (const assetPath of paths) {
    const info = await stat(path.join(root, assetPath));
    assert.ok(info.size > 0 && info.size < 25_000, `${assetPath} 應已壓縮且可讀`);
  }
});

test('座位與行為圖使用裝飾性替代文字及固定尺寸', async () => {
  const [app, editor, css] = await Promise.all([
    readFile(path.join(root, 'js/app.js'), 'utf8'),
    readFile(path.join(root, 'js/behaviors-editor.js'), 'utf8'),
    readFile(path.join(root, 'assets/style.css'), 'utf8'),
  ]);

  assert.match(app, /class="seat-avatar"[^>]+alt=""[^>]+width="44" height="44"/);
  assert.match(app, /class="behavior-art"[^>]+alt=""[^>]+width="52" height="52"/);
  assert.match(editor, /class="behavior-art"[^>]+alt=""[^>]+width="52" height="52"/);
  assert.match(css, /\.seat-avatar \{[^}]*aspect-ratio: 1;[^}]*object-fit: cover;/s);
  assert.match(css, /\.behavior-art \{[^}]*aspect-ratio: 1;[^}]*object-fit: cover;/s);
});
