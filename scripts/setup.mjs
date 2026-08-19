#!/usr/bin/env node
/*
 * 一鍵安裝：把班級積分堂裝到「你自己的」Google 帳號底下。
 *
 * 這支腳本做得掉的事：
 *   建兩個 Apps Script 專案、把程式碼推上去、部署、把網址寫回 js/config.js。
 *
 * 這支腳本做不掉的事（Google 規定一定要人在瀏覽器裡點）：
 *   1. 開一份空白試算表，把網址上的 ID 貼給它
 *   2. 在 Google Cloud 建一個 OAuth 用戶端，把 Client ID 貼給它
 *   3. 在 Apps Script 編輯器按一次「執行」，走完授權同意畫面
 * 腳本會在需要的時候停下來，把該開的網址印給你，等你按 Enter 再繼續。
 *
 * 為什麼是兩個專案而不是一個：一個 Apps Script 專案只有一組 doPost，
 * 老師端（要驗身分）與家長學生端（匿名可存取）混在同一支裡，
 * 匿名那份會連管理操作一起分派出去。理由寫在 docs/gas-deploy.md。
 *
 * 重跑安全：已經建好的專案不會重建（看得到 gas/.clasp.*.json 就跳過），
 * 只會重新推程式碼與重新部署。
 */

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { env, platform, stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLASP = ['-y', '@google/clasp@3.3.0'];
const NPX = platform === 'win32' ? 'npx.cmd' : 'npx';

function windowsCommand(args) {
  return args.map((arg, index) => index === 0
    ? String(arg)
    : `"${String(arg).replaceAll('"', '""')}"`).join(' ');
}

const ADMIN = {
  key: 'admin',
  title: '班級積分堂 · 管理端',
  clasp: 'gas/.clasp.admin.json',
  build: 'gas/build/admin',
  files: ['gas/Store.gs', 'gas/Code.gs', 'gas/Auth.gs'],
  manifest: 'gas/appsscript.json',
};

const PUBLIC = {
  key: 'public',
  title: '班級積分堂 · 家長學生端',
  clasp: 'gas/.clasp.public.json',
  build: 'gas/build/public',
  files: ['gas/Store.gs', 'gas/Public.gs'],
  manifest: 'gas/public-appsscript.json',
};

// ───────────────────────── 小工具 ─────────────────────────

const rl = createInterface({ input: stdin, output: stdout });

const say = (s = '') => console.log(s);
const step = (n, s) => say(`\n${'─'.repeat(4)} ${n}. ${s} ${'─'.repeat(4)}`);

async function ask(question, { required = true, hint = '' } = {}) {
  if (hint) say(hint);
  for (;;) {
    const v = (await rl.question(`${question} `)).trim();
    if (v || !required) return v;
    say('這一項不能留白。');
  }
}

async function pause(message) {
  await rl.question(`\n${message}\n做完之後按 Enter 繼續… `);
}

/** 跑 clasp，回傳 stdout。失敗就把 clasp 自己的訊息原樣印出來再結束。 */
function clasp(args, { cwd = ROOT, quiet = false } = {}) {
  try {
    const command = [NPX, ...CLASP, ...args];
    const options = {
      cwd,
      encoding: 'utf8',
      stdio: ['inherit', 'pipe', 'pipe'],
    };
    const out = platform === 'win32'
      ? execSync(windowsCommand(command), { ...options, shell: env.ComSpec || 'cmd.exe' })
      : execFileSync(NPX, command.slice(1), options);
    if (!quiet) process.stdout.write(out);
    return out;
  } catch (err) {
    say('\n✘ clasp 這一步失敗了：');
    say(String(err.stdout || '') + String(err.stderr || ''));
    say('修好上面那個問題之後，重跑 npm run setup 就好（已經建好的不會重建）。');
    process.exit(1);
  }
}

// ───────────────────────── 各步驟 ─────────────────────────

/** 沒登入就先擋下來，不然後面每一步都會用同一個理由失敗。 */
function requireClaspLogin() {
  const out = clasp(['show-authorized-user'], { quiet: true });
  // 登入成功時會印「You are logged in as <你的信箱>」。認這一句，
  // 比去猜「沒登入」會印出哪一種錯誤字串可靠。
  if (!/logged in as/i.test(out)) {
    say('看起來還沒登入 clasp。先跑這一行，用你自己的 Google 帳號登入：');
    say('\n  npx -y @google/clasp@3.3.0 login\n');
    process.exit(1);
  }
  say(out.trim());
}

/** 建專案。已經有 .clasp.*.json 就當作建過了，直接沿用。 */
function ensureProject(target) {
  const claspPath = join(ROOT, target.clasp);
  if (existsSync(claspPath)) {
    const { scriptId } = JSON.parse(readFileSync(claspPath, 'utf8'));
    say(`已經有${target.title}了（${scriptId}），沿用。`);
    return scriptId;
  }

  mkdirSync(join(ROOT, target.build), { recursive: true });
  // create-script 會把 .clasp.json 寫在 cwd，所以先讓它寫，再改名成我們要的檔名。
  const generic = join(ROOT, '.clasp.json');
  if (existsSync(generic)) rmSync(generic);
  clasp(['create-script', '--type', 'standalone', '--title', target.title, '--rootDir', target.build]);

  if (!existsSync(generic)) {
    say('✘ clasp 說建好了，但沒看到 .clasp.json。請把上面的訊息貼給我。');
    process.exit(1);
  }
  const conf = JSON.parse(readFileSync(generic, 'utf8'));
  writeFileSync(claspPath, JSON.stringify(conf, null, 2) + '\n');
  rmSync(generic);
  say(`建好了：${target.title}`);
  return conf.scriptId;
}

/** 把要上傳的 .gs 與 manifest 複製到該專案的 build 目錄。 */
function assemble(target, extraFiles = []) {
  const dir = join(ROOT, target.build);
  mkdirSync(dir, { recursive: true });
  for (const f of target.files) copyFileSync(join(ROOT, f), join(dir, f.split('/').pop()));
  copyFileSync(join(ROOT, target.manifest), join(dir, 'appsscript.json'));
  for (const [name, content] of extraFiles) writeFileSync(join(dir, name), content);
}

/*
 * 一次性設定用的臨時檔。
 *
 * 三個設定值走「指令碼屬性」而不是寫死在 .gs 裡：寫進 .gs 就等於寫進 git。
 * 但 clasp 沒有設定屬性的指令，所以只能推一支函式上去、請老師按一次執行。
 * 那一次執行同時做兩件事：寫入屬性，以及觸發 Google 的授權同意畫面
 * （Apps Script 的授權是「真的呼叫到那個 API 才會問」，光在 manifest 宣告沒有用）。
 * 跑完就會被乾淨版覆蓋掉，不會留在專案裡。
 */
function setupShim({ email, sheetId, clientId }, { needsClientId }) {
  const props = [
    `  p.setProperty('TEACHER_EMAIL', ${JSON.stringify(email)});`,
    `  p.setProperty('SHEET_ID', ${JSON.stringify(sheetId)});`,
    needsClientId ? `  p.setProperty('GOOGLE_CLIENT_ID', ${JSON.stringify(clientId)});` : null,
  ].filter(Boolean).join('\n');

  const touchExternal = needsClientId
    ? `  UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=x', { muteHttpExceptions: true });\n`
    : '';

  return `/*
 * 這是安裝腳本推上來的臨時檔，執行過一次就可以了。
 * 它會寫入設定值，並且順便碰一下試算表${needsClientId ? '與外部連線' : ''}，
 * 好讓 Google 跳出授權畫面（Apps Script 只有真的呼叫到 API 才會問你要不要授權）。
 */
function 一次性設定() {
  var p = PropertiesService.getScriptProperties();
${props}
  SpreadsheetApp.openById(p.getProperty('SHEET_ID')).getName();
${touchExternal}  return '設定完成';
}
`;
}

/** 部署並回傳 /exec 網址。已經部署過就沿用同一個部署（網址不會變）。 */
function deploy(target, description) {
  const claspArgs = ['-P', target.clasp];
  const listed = clasp([...claspArgs, 'list-deployments'], { quiet: true });
  // 「@HEAD」那一筆是編輯器自己的測試部署，不是我們要的正式版本。
  const existing = [...listed.matchAll(/(AKfycb[\w-]+)/g)]
    .map((m) => m[1])
    .filter((id) => !new RegExp(`${id}[^\\n]*@HEAD`).test(listed));

  /*
   * 重跑時要沿用同一個部署 ID（`-i`），不是再開一個新的——
   * 部署 ID 就是網址，換了 ID 等於換網址，前端 config 與已經發出去的連結全部作廢。
   */
  const out = existing.length
    ? clasp([...claspArgs, 'create-deployment', '-i', existing[0], '-d', description])
    : clasp([...claspArgs, 'create-deployment', '-d', description]);

  const id = out.match(/AKfycb[\w-]+/)?.[0] || existing[0];
  if (!id) {
    say('✘ 部署了但抓不到部署 ID，請把上面的訊息貼給我。');
    process.exit(1);
  }
  return `https://script.google.com/macros/s/${id}/exec`;
}

/** 把三個值寫回 js/config.js。用逐行取代，不動檔案裡的任何註解。 */
function writeConfig({ adminUrl, publicUrl, clientId }) {
  const p = join(ROOT, 'js/config.js');
  let s = readFileSync(p, 'utf8');
  s = s.replace(/(\n\s*admin:\s*)'[^']*'/, `$1'${adminUrl}'`);
  s = s.replace(/(\n\s*public:\s*)'[^']*'/, `$1'${publicUrl}'`);
  s = s.replace(/(export const GOOGLE_CLIENT_ID\s*=\s*)'[^']*'/, `$1'${clientId}'`);
  writeFileSync(p, s);

  const back = readFileSync(p, 'utf8');
  for (const [what, value] of [['管理端網址', adminUrl], ['公開端網址', publicUrl], ['Client ID', clientId]]) {
    if (value && !back.includes(value)) {
      say(`⚠️ ${what}沒寫進 js/config.js，請自己貼一下：${value}`);
    }
  }
}

// ───────────────────────── 主流程 ─────────────────────────

say('班級積分堂 · 安裝');
say('這會把整套裝到你自己的 Google 帳號底下。中途會停下來請你做幾件事。');

step(1, '檢查 clasp 有沒有登入');
requireClaspLogin();

step(2, '你的資料');
const email = await ask('你的 Google 信箱（老師本人的，只有這個帳號打得開管理端）：');

say('\n開一份空白試算表：https://sheets.new');
say('網址長這樣 https://docs.google.com/spreadsheets/d/【這一段就是 ID】/edit');
const sheetId = await ask('把那段 ID 貼上來：');

say('\n再來是 Google 登入用的 Client ID。還沒建的話：');
say('  1. 開 https://console.cloud.google.com/auth/clients');
say('  2. 建立「OAuth 用戶端 ID」→ 類型選「網頁應用程式」');
say('  3. 「已授權的 JavaScript 來源」先加 http://localhost:8000');
say('     （網站部署好之後，再回來把正式網址也加進去，不然登入會被擋）');
const clientId = await ask('把 Client ID 貼上來（還沒有就直接按 Enter，之後再跑一次這支腳本）：', { required: false });

step(3, '建立兩個 Apps Script 專案');
const adminId = ensureProject(ADMIN);
const publicId = ensureProject(PUBLIC);

step(4, '上傳程式碼（含一次性設定用的臨時檔）');
assemble(ADMIN, [['Setup.gs', setupShim({ email, sheetId, clientId }, { needsClientId: true })]]);
assemble(PUBLIC, [['Setup.gs', setupShim({ email, sheetId, clientId }, { needsClientId: false })]]);
clasp(['-P', ADMIN.clasp, 'push', '-f']);
clasp(['-P', PUBLIC.clasp, 'push', '-f']);

step(5, '請你在瀏覽器裡按兩次「執行」');
say('這一步 Google 規定一定要人工，腳本代勞不了。兩個專案各做一次：');
say(`\n  管理端　　https://script.google.com/home/projects/${adminId}/edit`);
say(`  家長學生端 https://script.google.com/home/projects/${publicId}/edit`);
say('\n在每個編輯器裡：上方函式選單選「一次性設定」→ 按「執行」→');
say('第一次會跳出授權畫面，選你的帳號 →「進階」→「前往（不安全）」→「繼續」。');
say('（那個「不安全」是因為這是你自己寫的程式、沒有送 Google 審核，不是有問題。）');
await pause('兩個專案都執行過、都看到「設定完成」之後：');

step(6, '部署');
const adminUrl = deploy(ADMIN, '管理端');
const publicUrl = deploy(PUBLIC, '家長學生端');
say(`\n管理端　　${adminUrl}`);
say(`家長學生端 ${publicUrl}`);

step(7, '把臨時檔清掉、推乾淨版上去');
rmSync(join(ROOT, ADMIN.build, 'Setup.gs'), { force: true });
rmSync(join(ROOT, PUBLIC.build, 'Setup.gs'), { force: true });
assemble(ADMIN);
assemble(PUBLIC);
clasp(['-P', ADMIN.clasp, 'push', '-f']);
clasp(['-P', PUBLIC.clasp, 'push', '-f']);

step(8, '寫回 js/config.js');
writeConfig({ adminUrl, publicUrl, clientId });
say('寫好了。');

say('\n裝好了。接下來：');
say('  1. 本機看看：npx serve . 或 python3 -m http.server 8000，開 http://localhost:8000');
say('  2. 要放到網路上：把整個資料夾丟到 Cloudflare Pages 或 Netlify（README 有指令）');
say('  3. 網站有正式網址之後，回 Google Cloud 的 OAuth 用戶端，');
say('     把那個網址加進「已授權的 JavaScript 來源」，不然在手機上會登不進去。');
if (!clientId) {
  say('\n⚠️ 你剛才沒填 Client ID，老師端還不能登入。建好之後再跑一次 npm run setup。');
}

rl.close();
