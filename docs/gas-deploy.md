# 班級積分堂 · Apps Script 部署指南

從一台什麼都沒裝的 Mac，到兩個能用的 `/exec` 網址。照著做一次就會了。

寫給沒用過 clasp、也沒在 Apps Script 上部署過網頁應用程式的人。術語第一次出現時
都會解釋。設計上的「為什麼」在 `docs/gas-migration.md`，這一份只講「怎麼做」。

## 這份文件的驗證狀態

清楚分成兩類，請務必留意標記：

- **✅ 已驗證**：我在這台 Mac 上實際跑過，輸出貼在文件裡。
- **⚠️ 未驗證**：需要用老師的 Google 帳號登入才做得到的步驟。我照官方文件與
  clasp 3.3.0 的原始碼寫，但**沒有親手跑過**。跑的時候如果跟這裡寫的不一樣，
  以你看到的為準，並回報回來修文件。

驗證用的 clasp 版本：**`@google/clasp` 3.3.0**（`npx --yes @google/clasp@latest --version`
在 2026-08-15 回 `3.3.0`）。clasp 3.x 跟網路上絕大多數 2.x 的教學**指令不一樣**，
看到別人的文章請先確認版本。

---

## 0. 先看懂三個名詞

沒有這三個，後面每一步都會看不懂在幹嘛。

| 名詞 | 白話 |
|---|---|
| **Apps Script 專案（script）** | 一包 `.gs` 程式碼，住在你的 Google 帳號裡。改了程式碼，專案就變了，但**線上跑的東西不會跟著變**。 |
| **版本（version）** | 專案在某一刻的快照，不可修改。像 git 的 tag。 |
| **部署（deployment）** | 「把某一個版本掛到一個網址上對外服務」。一個專案可以有很多個部署，各自釘在不同版本、各自有各自的網址與權限設定。 |

**最常見的誤會**：改完程式碼按了儲存，以為線上就更新了。沒有。
`/exec` 網址服務的是**部署所釘住的那個版本**，你必須另外建版本、更新部署。
（`/dev` 網址才是永遠跑最新存檔，但它只有對這個專案有編輯權的人打得開——
也就是只有老師自己，不能拿給家長用。來源：
<https://developers.google.com/apps-script/guides/web>）

---

## 1. 前置：Node 與 clasp

### 1.1 Node

clasp 3.3.0 的 `package.json` 寫 `"engines": { "node": " >=20.0.0" }`（✅ 已驗證，
直接讀套件的 package.json）。

```bash
node --version
```

這台機器上的實際輸出（✅）：

```
v22.22.3
```

低於 v20 的話用 nvm 升級（全域規則：Node 走 nvm）。

### 1.2 不要 `npx clasp`，要 `npx @google/clasp`

**這是第零個坑，而且錯誤訊息完全看不出原因。** npm 上有一個沒有 scope 的
`clasp` 套件，它是 2019 年留下的空殼（`description: "Alias for @google/clasp"`，
2.2 KB，**沒有任何 bin**）。實測（✅）：

```bash
npx --yes clasp --version
```

```
npm error could not determine executable to run
```

正確的是有 scope 的 `@google/clasp`。本文一律把版本寫死，避免哪天 4.0 出來把
指令又換一輪：

```bash
npx --yes @google/clasp@3.3.0 --version
```

```
3.3.0
```

（✅ 已驗證。不想每次打這麼長可以 `npm install -g @google/clasp@3.3.0`，
之後直接 `clasp`。本文為了可重現一律寫完整形式。）

### 1.3 ⚠️ 先去開 Apps Script API，不然後面每一步都會失敗

**這是最常見的第一個坑。** clasp 是透過 Apps Script API 操作你的專案的，
而這個 API 對「個人帳號」**預設是關的**。沒開的話 `clasp push` 會噴一段
跟權限無關的錯誤訊息，看半天猜不到是這裡。

打開這一頁，把開關切成「開啟」：

**<https://script.google.com/home/usersettings>**

（來源：`@google/clasp` 3.3.0 README「Install」段，✅ 已驗證是套件內的原文：
> Then enable the Google Apps Script API: https://script.google.com/home/usersettings）

⚠️ 我沒有登入老師的帳號，所以**沒有實際確認過那一頁上開關的中文字樣**。
頁面上只有一個跟 Apps Script API 有關的開關，切開就對了。

> 這跟 `https://console.developers.google.com/start/api?id=script`（GCP 那一邊的
> API 啟用）不是同一件事。clasp 需要的是**使用者設定**這一頁。

### 1.4 ⚠️ 登入

```bash
npx --yes @google/clasp@3.3.0 login
```

會開瀏覽器要你授權。授權完憑證存在 `~/.clasprc.json`（全域，不在專案裡）。

**`~/.clasprc.json` 等同於一把可以改你所有 Apps Script 專案的鑰匙。**
不要放進 iCloud 共享、不要 commit、不要貼給任何人。

沒有瀏覽器可開（例如 ssh 進去）時用 `--no-localhost`，會改成叫你手動貼授權碼
（✅ 這個旗標存在，見下方 `login --help` 輸出）。

隨時可以確認登入狀態：

```bash
npx --yes @google/clasp@3.3.0 show-authorized-user
```

沒登入時的實際輸出（✅）：

```
Not logged in.
```

<details>
<summary>✅ <code>clasp help login</code> 完整輸出</summary>

```
Usage: clasp login [options]
Log in to script.google.com
Options:
  --no-localhost           Do not run a local server, manually enter code
                           instead
  --creds <file>           Relative path to OAuth client secret file (from GCP).
  --use-project-scopes     Use the scopes from the current project manifest.
                           Used only when authorizing access for the run
                           command.
  --include-clasp-scopes   Include default clasp scopes in addition to project
                           scopes. Can only be used with --use-project-scopes.
  --extra-scopes <scopes>  Include additional OAuth scopes as a comma-separated
                           list.
  --redirect-port <port>   Specify a custom port for the redirect URL.
  -h, --help               display help for command
```

</details>

---

## 2. 建專案：容器綁定還是獨立指令碼？

Apps Script 專案有兩種：

- **容器綁定（container-bound）**：程式碼附在某一份試算表／文件底下，
  跟著那份檔案走，在雲端硬碟裡看不到它。
- **獨立指令碼（standalone）**：程式碼是雲端硬碟裡一個獨立的檔案，
  自己開啟試算表要用 `SpreadsheetApp.openById(id)`。

### 這個專案：兩個都要選「獨立指令碼」

三個理由，第一個是決定性的：

1. **容器綁定的「不用給 id 就拿得到自己那份試算表」這個好處，在網頁應用程式裡
   根本不存在。** 官方文件原文（✅ 已核對 <https://developers.google.com/apps-script/guides/bound>）：

   > These methods are only available to bound scripts run from the script editor,
   > menu items, dialogs, sidebars, or triggers. **When a bound script is run as a
   > web app or using the Google Apps Script API, these methods aren't available.**

   我們整個後端就是網頁應用程式，`getActiveSpreadsheet()` 在 `doPost` 裡拿不到東西。
   容器綁定唯一的賣點直接歸零。

2. **我們需要兩個專案共用同一份試算表**（見下一節）。一份試算表容納不了兩個
   綁定指令碼，而且第二個專案本來就得靠 `SHEET_ID` 才找得到那份表。

3. 綁定的指令碼在雲端硬碟裡是隱形的，備份、搬家、交接都比較難講清楚。

**連帶的一件事，而且現在兩份 manifest 對不起來**：

`gas/Store.gs` 的 `book()`（✅ 讀檔確認，第 51–54 行）是
`SpreadsheetApp.openById(SHEET_ID)`。既然走 `openById`，`oauthScopes` 就必須是
完整的 `https://www.googleapis.com/auth/spreadsheets`，而**不能**是
`.../spreadsheets.currentonly`——`currentonly` 講的就是「只准碰目前這一份
（容器綁定的那一份）」。

實際狀況（✅ 讀檔）：

| manifest | `oauthScopes` | 對不對 |
|---|---|---|
| `gas/public-appsscript.json`（S2） | `.../auth/spreadsheets` | ✔ |
| `gas/appsscript.json`（S1） | `.../auth/spreadsheets.currentonly` | ✘ 跟 `openById` 不搭 |

⚠️ 我**沒有實際跑過**會不會噴 `Missing authorization`，但兩份 manifest 對同一支
`book()` 給不同 scope，至少有一份是錯的。manifest 屬於 S1 名下，**我沒有動它**，
只列進回報給主線。部署後如果管理端噴授權錯誤，第一個就查這裡。

### 2.1 ⚠️ 建立兩個獨立指令碼專案

`clasp create-script`（別名 `create`）的完整旗標（✅ 已驗證）：

```
Usage: clasp create-script|create [options]
Create a script
Options:
  --type <type>        Creates a new Apps Script project attached to a new
                       Document, Spreadsheet, Presentation, Form, or as a
                       standalone script, web app, or API. (default:
                       "standalone")
  --title <title>      The project title.
  --parentId <id>      A project parent Id.
  --rootDir <rootDir>  Local root directory in which clasp will store your
                       project files.
```

⚠️ **`--type` 的說明文字在 3.3.0 是過期的。** 讀原始碼
（`build/src/commands/create-script.js`，✅）可知實際只認四種容器型別
`docs / forms / sheets / slides`，其餘一律走 `standalone`；2.x 時代的
`webapp`、`api` 已經沒了。實測傳無效值（✅）：

```bash
npx --yes @google/clasp@3.3.0 create-script --type bogus --title x
```

```
Invalid container file type
```

我們兩個都要 standalone，所以連 `--type` 都不用帶。

**建議做法：在暫存目錄各建一次，只取回 scriptId。** 因為 `create` 會在當下目錄
寫一個 `.clasp.json`，而我們的專案要的是兩份自訂檔名的設定檔（下一節），
讓它寫進 repo 反而礙事。

```bash
mkdir -p /tmp/cp-create && cd /tmp/cp-create

rm -f .clasp.json
npx --yes @google/clasp@3.3.0 create-script --title "班級積分堂 · 管理端"
# 記下輸出裡的 https://script.google.com/d/<SCRIPT_ID>/edit

rm -f .clasp.json
npx --yes @google/clasp@3.3.0 create-script --title "班級積分堂 · 家長學生端"
# 記下第二個 SCRIPT_ID
```

⚠️ 如果目錄裡已經有 `.clasp.json`，`create` 會拒絕：原始碼裡的訊息是
`Project file already exists.`（✅ 讀原始碼確認，未實跑）。所以上面每次都先 `rm -f`。

**另外準備一份試算表**：在雲端硬碟新建一份空白 Google 試算表（就叫「班級積分堂資料」），
從網址 `https://docs.google.com/spreadsheets/d/<這一段>/edit` 抄下它的 id，
這就是 `SHEET_ID`。工作表（events／docs）不用手動建，`init` 這個 op 會建。

---

## 3. 為什麼是「兩個專案」，不是「一個專案兩個部署」

契約寫的是「兩個部署，一份程式碼」。**「一份程式碼」是指 git 裡的原始碼只有一份，
不是指 Apps Script 上只有一個專案。** 我的設計是：

> **一份原始碼 → 組成兩個內容不同的上傳目錄 → 推到兩個 Apps Script 專案
> → 各自一個部署 → 兩個 `/exec` 網址。兩邊的 `SHEET_ID` 指向同一份試算表。**

理由有兩個，都是硬的：

### 理由一：`doGet` / `doPost` 會撞名，而且是無聲的

Apps Script 沒有模組系統，同一個專案裡所有 `.gs` 共用一個全域命名空間。
**這已經不是假設，是現況**（✅ 讀檔確認）：`gas/Code.gs` 有 `doPost`（第 365 行）
與 `doGet`（第 382 行）；`gas/Public.gs` 也有 `doGet`（第 465 行）與
`doPost`（第 472 行）。**四個函式、兩組同名。** 兩個檔放進同一個專案，
**後載入的那個會蓋掉先載入的，不會有任何錯誤訊息**——你只會發現家長端打進來
跑的是管理端的程式碼，或反過來。這種 bug 在課堂上炸掉時你完全不知道要查哪裡。

### 理由二：兩份 manifest 沒辦法在同一個專案裡共存

網頁應用程式的「執行身分」與「存取權」不是部署參數，**是寫在 manifest 裡的**。
官方 webapp manifest 資源只有兩個欄位（✅ 已核對
<https://developers.google.com/apps-script/manifest/web-app-api-executable>）：

| 欄位 | 允許值 |
|---|---|
| `executeAs` | `USER_ACCESSING` / `USER_DEPLOYING` |
| `access` | `MYSELF` / `DOMAIN` / `ANYONE` / `ANYONE_ANONYMOUS` |

而 `projects.deployments.create` API 的 request body **只有** `versionNumber`、
`manifestFileName`、`description` 三個欄位（✅ 已核對
<https://developers.google.com/apps-script/api/reference/rest/v1/projects.deployments/create>）。
`clasp deploy` 的旗標也只有 `-V/--versionNumber`、`-d/--description`、
`-i/--deploymentId`（✅ 見 `--help` 輸出）——**沒有任何辦法在部署時指定權限**。

讀 clasp 3.3.0 的 `build/src/core/project.js`（✅）更明確：

```js
if (versionNumber === undefined) { versionNumber = await this.version(description); }
...
requestBody: { description, versionNumber, manifestFileName: 'appsscript' }
```

也就是說 **`clasp deploy` 拿的永遠是「建版本當下那份 `appsscript.json`」的權限設定**。

一個專案要生出兩種權限，就只能「推 manifest A → 建版本 → 部署甲 → 推 manifest B
→ 建版本 → 部署乙」。技術上可行（部署釘在版本上，版本裡有各自的 manifest），
但這條路的失敗模式是：**任何一次順序弄反、或忘了換 manifest，就會把掛滿 `OPS`
的管理端程式碼部署成 `ANYONE_ANONYMOUS`——記分 API 對全世界開放。**
而且從外表完全看不出來。

兩個專案就沒有這個問題：公開端那個 Apps Script 專案裡**根本沒有 `Code.gs`**，
連要外洩的程式碼都不在那台機器上。這跟契約鐵則第 3 條「投影在後端做」是同一種
思路——用結構讓錯誤不可能發生，而不是靠記得。

### 代價（要講清楚）

| 代價 | 實情 |
|---|---|
| 改一行程式碼要推兩次 | 是。所以 `gas/README.md` 把它寫成一組固定指令 |
| 兩個專案各要授權一次 | 是，第一次執行時各跳一次 OAuth 同意畫面 |
| `SHEET_ID` 要設兩份 | 是，兩邊都要設，而且要一樣 |
| 配額 | 不變。配額算在 Google 帳號頭上，不是專案 |

---

## 4. 目錄長相與 `.clasp.json`

### 4.1 git 裡的 `gas/`

```
gas/
├── Code.gs                  S1：管理端業務規則與 doGet/doPost
├── Store.gs                 S1：儲存原語（兩邊共用）
├── Public.gs                S2：家長／學生端
├── appsscript.json          S1：管理端 manifest（MYSELF）
├── public-appsscript.json   S2：公開端 manifest（ANYONE_ANONYMOUS）
├── .clasp.json.example      S4：設定檔範本（進 git）
├── README.md                S4：指令速查
│
├── .clasp.admin.json        ← 你自己複製出來的，不進 git
├── .clasp.public.json       ← 同上
└── build/                   ← 組版產物，不進 git
    ├── admin/   = Store.gs + Code.gs + appsscript.json
    └── public/  = Store.gs + Public.gs + appsscript.json（由 public-appsscript.json 改名）
```

`build/` 存在的唯一理由是：clasp 的 manifest 檔名**寫死**是
`<rootDir>/appsscript.json`（✅ 見套件內 `docs/config-files.md`：
「Apps Script project manifest | `<rootDir>/appsscript.json`」），
`public-appsscript.json` 不改名就不會被當成 manifest。

### 4.2 建立兩份設定檔

```bash
cd /Users/naichengchen/projects/class-points
cp gas/.clasp.json.example gas/.clasp.admin.json
cp gas/.clasp.json.example gas/.clasp.public.json
```

各自編輯，填 scriptId、改 rootDir：

| 檔案 | `scriptId` | `rootDir` |
|---|---|---|
| `gas/.clasp.admin.json` | 管理端專案的 id | `build/admin` |
| `gas/.clasp.public.json` | 公開端專案的 id | `build/public` |

**`rootDir` 是相對於 `.clasp.json` 檔案自己的位置，不是相對於你執行指令的目錄。**
README 原文（✅）：「file paths are relative to directory containing .clasp.json」。
我也實測過（✅）：`.clasp.admin.json` 在 `$S`、`rootDir` 寫 `build/admin`，
從 `$S/build/` 執行 `-P ../.clasp.admin.json`，clasp 找到的仍然是
`$S/build/admin/*`。所以填 `build/admin` 就會指到 `gas/build/admin`。

範本裡留了 `"//"` 開頭的註解鍵。**clasp 3.3.0 會忽略它們**（✅ 實測：帶著整包
註解鍵跑 `show-file-status`，正常列出 `build/admin/appsscript.json` 與
`build/admin/Code.gs`）。留著當說明沒問題，想刪也可以。

### 4.3 `.gitignore` 已經擋掉這些檔案（2026-08-15 主線補上）

```
gas/.clasp*.json
!gas/.clasp.json.example
gas/build/
.clasprc.json
```

`.clasp.json` 裡是 scriptId（拿到就能把程式碼推進那個專案），
`.clasprc.json` 直接是 OAuth token。兩個都不可以進 git。
`.example` 那份用 `!` 明確放行，已用 `git check-ignore -v` 驗過兩條規則都生效。

---

## 5. 推程式碼

### 5.1 組版

```bash
cd /Users/naichengchen/projects/class-points

rm -rf gas/build
mkdir -p gas/build/admin gas/build/public

cp gas/Store.gs gas/Code.gs gas/Auth.gs gas/build/admin/
cp gas/appsscript.json        gas/build/admin/appsscript.json

cp gas/Store.gs gas/Public.gs gas/build/public/
cp gas/public-appsscript.json gas/build/public/appsscript.json
```

`rm -rf` 那一行不能省：改名或刪掉一支 `.gs` 之後，殘留的舊檔會被一路推上去。

### 5.2 推之前先看清單（不需要登入，可離線做）

```bash
npx --yes @google/clasp@3.3.0 -P gas/.clasp.admin.json  show-file-status
npx --yes @google/clasp@3.3.0 -P gas/.clasp.public.json show-file-status
```

**這一整套（組版 → 兩份設定檔 → `show-file-status`）我在這個 repo 裡拿真實的
`Code.gs`／`Store.gs`／`Public.gs` 實跑過**（scriptId 填假值，不需要登入），
實際輸出（✅）：

```
=== admin ===
Tracked files:
└─ gas/build/admin/appsscript.json
└─ gas/build/admin/Code.gs
└─ gas/build/admin/Store.gs
└─ gas/build/admin/Auth.gs   ← 身分驗證，管理端才有
Untracked files:
=== public ===
Tracked files:
└─ gas/build/public/appsscript.json
└─ gas/build/public/Public.gs
└─ gas/build/public/Store.gs
Untracked files:
```

（跑完之後我把 `gas/build/`、`gas/.clasp.admin.json`、`gas/.clasp.public.json`
都刪掉了，repo 裡不會留下這些東西。）

**這一步是整份指南裡最便宜的保險。** 看到 `admin` 那邊出現 `Public.gs`、
或 `public` 那邊出現 `Code.gs`，立刻停下來——組版錯了。

（`-P` 是全域旗標，✅ 見 `clasp --help`：
`-P, --project <file>  path to a project file or to a folder with a '.clasp.json' file.`
也可以改用環境變數 `clasp_config_project`，✅ 實測有效。
官方文件說設定檔名必須以 `.` 開頭；實測 3.3.0 用不以 `.` 開頭的檔名也能跑，
但既然文件這樣寫，就照 `.clasp.*.json` 的命名，別去賭。）

### 5.3 ⚠️ 推

```bash
npx --yes @google/clasp@3.3.0 -P gas/.clasp.admin.json  push -f
npx --yes @google/clasp@3.3.0 -P gas/.clasp.public.json push -f
```

`push` 只有三個旗標（✅）：`-f/--force`（強制覆寫遠端 manifest）、
`-w/--watch`（監看變更自動推）、`-h`。

`-f` 是需要的：不帶的話，遠端 manifest 跟本地不一樣時 clasp 會停下來問。
我們每次都以本地為準。

⚠️ **`push` 只是更新專案裡的程式碼，線上服務的網址不會有任何變化。**
要讓改動生效，一定要做第 7 節的「更新部署」。

---

## 6. ⚠️ 兩個部署：在編輯器裡點哪裡

**這一節請用 Apps Script 編輯器的 UI 做第一次部署，不要用 `clasp deploy`。**
理由在 §3 理由二已經算清楚了：clasp 沒有任何旗標可以設定執行身分與存取權，
它只會沿用 manifest；而 UI 上那兩個下拉是所見即所得，設完當場看得到，
第一次部署的驗證成本低太多。之後的例行更新才走 clasp（第 7 節）。

以下 UI 步驟依 <https://developers.google.com/apps-script/guides/web>
（✅ 已核對「Deploy > New deployment → 齒輪 → Web app」這條路徑存在）。
⚠️ 但**中文介面的實際字樣我沒有親眼看過**，下拉選項的用詞可能跟這裡略有出入。

### 6.1 管理端

1. 打開管理端專案：`https://script.google.com/d/<管理端 SCRIPT_ID>/edit`
2. 右上角 **部署（Deploy）→ 新增部署作業（New deployment）**
3. 左邊「選取類型」旁邊的 **齒輪圖示** → 選 **網頁應用程式（Web app）**
4. 填：

   | 欄位 | 填什麼 |
   |---|---|
   | 說明 | `管理端 v1` |
   | 執行身分（Execute as） | **我（你的 Gmail）** ← 對應 `USER_DEPLOYING` |
   | 誰可以存取（Who has access） | **任何人** ← 對應 `ANYONE_ANONYMOUS`。**先讀下面那段再設** |

   > ### ⚠️ 為什麼管理端也是「任何人」（2026-08-15 修正，實測逼出來的）
   >
   > 這一格原本寫「只有我自己」，想法是讓 Google 的登入牆當門鎖。
   > **那個想法在瀏覽器裡完全走不通**，實測結果：
   >
   > 從 `https://YOUR-SITE.pages.dev` 對管理端 `/exec` 發 `fetch`，
   > 帶 cookie（`credentials:'include'`）與不帶（`'omit'`）**都是 `Failed to fetch`**；
   > 同一個頁面、同一段程式碼改打公開端就正常回 200。所以不是 CSP、不是網路，
   > 是「只有我自己」這個權限本身：
   >
   > - 未登入 → 302 到 `accounts.google.com`，那個回應沒有 CORS 標頭，瀏覽器直接擋掉
   > - `credentials:'include'` → 跟 Google 回的 `Access-Control-Allow-Origin: *` 互斥，也擋掉
   >
   > **結論：只要前端不是同源，「只有我自己」就用不了。**
   > 門鎖因此搬進程式碼——`gas/Auth.gs` 要求每一個 op 都附一枚 Google ID token，
   > 驗它是 Google 簽的、aud 是我們的 Client ID、email 是 `TEACHER_EMAIL` 本人。
   > 三個條件缺一不可，`gas/selftest.mjs` 第 9 節逐項擋過。
   >
   > 所以 §8 的 `GOOGLE_CLIENT_ID` 與 `TEACHER_EMAIL` 兩個屬性**不是選配**：
   > 沒設，管理端對每一個請求都回「還沒設定」；設錯，就等於門沒鎖。

5. **部署** → 第一次會跳 OAuth 同意畫面，按「授權存取權」，
   選自己的帳號，走完「進階 → 前往（不安全）」那條（自己寫的腳本沒有經過
   Google 審查，這個警告是正常的）。
6. 複製「網頁應用程式」下面那個 **`/exec` 網址**。這是**管理端網址**。

### 6.2 家長／學生端

同樣流程，但打開的是**公開端專案**，而且第 4 步填：

| 欄位 | 填什麼 |
|---|---|
| 說明 | `家長學生端 v1` |
| 執行身分 | **我（你的 Gmail）** ← 一樣是 `USER_DEPLOYING` |
| 誰可以存取 | **所有人（Anyone）** ← 對應 `ANYONE_ANONYMOUS` |

⚠️ 「誰可以存取」的中文選項在不同時期出現過「所有人」「所有人（包括匿名使用者）」
兩種字樣。**要選的是不需要 Google 帳號就能開的那一個。**
判準不要看字面，看行為：部署完照 §9.3 用無痕視窗實測，開得起來才算對。

複製它的 `/exec` 網址，這是**公開端網址**。

### 6.3 兩個都設「以我的身分執行」，不是筆誤

家長端也是老師的身分在跑。家長不需要 Google 帳號、不需要對試算表有任何權限。
門鎖是程式裡的家長個人代碼，不是 Google 的登入牆。理由整段在
`docs/gas-migration.md` §2。

---

## 7. ⚠️ 之後改了程式碼怎麼更新

**不要每次都「新增部署作業」**——那會生出一個新網址，舊網址還活著、還跑舊程式碼，
而且家長手上的連結指的是舊的那個。要**更新既有的部署**。

`clasp` 可以做這件事，而且比 UI 好用（權限設定沿用該部署原本的，不會被動到）：

```bash
# 1) 列出部署，抄下 deploymentId
npx --yes @google/clasp@3.3.0 -P gas/.clasp.admin.json list-deployments

# 2) 建新版本並更新到那個部署（-i 就是「更新這一個」）
npx --yes @google/clasp@3.3.0 -P gas/.clasp.admin.json deploy \
  -i <DEPLOYMENT_ID> -d "$(date +%Y-%m-%d) 修 xxx"
```

（✅ 旗標來自 `clasp help create-deployment`：
`-V, --versionNumber <version>` / `-d, --description <description>` /
`-i, --deploymentId <id>`。別名 `deploy` 也是 ✅ 從 `--help` 確認的。）

不帶 `-V` 時 clasp 會**自動先建一個新版本再部署**（✅ 讀
`build/src/core/project.js` 的 `async deploy()`：`if (versionNumber === undefined)
{ versionNumber = await this.version(description); }`）。所以不必自己先跑
`create-version`。

公開端同理，把 `-P` 換成 `gas/.clasp.public.json`。

**⚠️ 只有這一件事一定要回 UI 做**：想改「誰可以存取」或「執行身分」。
clasp 改不了（§3 理由二），只能在編輯器裡 **部署 → 管理部署作業 → 鉛筆圖示**。

---

## 8. ⚠️ Script Properties（`SHEET_ID`、`GOOGLE_CLIENT_ID`、`TEACHER_EMAIL`）

### 8.1 為什麼金鑰不能寫在 `.gs` 裡

契約鐵則第 4 條。三個具體理由，不是原則問題：

1. **`.gs` 進 git。** 這個 repo 就算現在是私有的，也已經有過「全作品 repo 轉私密」
   的前科。金鑰一旦進過 git 歷史，改私有沒有用，要清歷史才算清掉。
2. **`TEACHER_EMAIL` 是管理端唯一的門鎖。** 寫進 `.gs` 就等於把門鎖的規格
   一起推上 GitHub；而且改一次要重新部署，出事的時候差的是分鐘與小時。
3. **改設定不用改程式碼、不用重新部署。** 在 UI 改一個值就生效。

Script Properties 存在 Apps Script 專案裡，**不會出現在任何 `clasp push` 或
`clasp pull` 的檔案裡**，也不會被 `git status` 看到。

### 8.2 怎麼設

在**每一個**專案（管理端、公開端各做一次）：

1. 打開專案 → 左側 **專案設定（齒輪圖示）**
2. 拉到最下面 **指令碼屬性（Script properties）** → **新增指令碼屬性**

| 屬性 | 值 | 管理端 | 公開端 |
|---|---|:--:|:--:|
| `SHEET_ID` | §2.1 抄下來的試算表 id | ✔ | ✔ |
| `GOOGLE_CLIENT_ID` | §8.3 建出來的 OAuth 用戶端 ID（`....apps.googleusercontent.com`） | ✔ | — |
| `TEACHER_EMAIL` | 老師本人的 Gmail，全小寫 | ✔ | — |

兩個專案的 `SHEET_ID` 必須**完全一樣**（同一份試算表）。

`GOOGLE_CLIENT_ID` 與 `TEACHER_EMAIL` 只有管理端要設，而且**兩個都是門鎖的一部分**：
`gas/Auth.gs` 拿它們比對每一枚 ID token 的 `aud` 與 `email`。少設一個，
管理端會對所有請求回「這份部署還沒設定…」；`TEACHER_EMAIL` 打錯一個字母，
老師自己也進不去（這是刻意的：寧可鎖住自己，不要放錯人進來）。

`GOOGLE_CLIENT_ID` 不是秘密——它會出現在前端的 `js/config.js` 裡，本來就公開。
擋人的是「aud 必須等於它」＋「email 必須等於 `TEACHER_EMAIL`」這個組合，
不是這串字難猜。

> 舊版這裡還有一個 `PARENT_CODE_SALT`，已經刪掉：整份程式碼沒有任何一行讀它
> （`grep -rn PARENT_CODE_SALT gas/ js/` 是空的），留著只會讓人以為家長代碼
> 有做雜湊。家長代碼目前是明文比對，長度 8 碼是它唯一的防線，見 `js/codes.js`。

### 8.3 建立 OAuth 用戶端 ID（管理端專用）

在 <https://console.cloud.google.com/auth/clients> 建一個 **網頁應用程式** 用戶端。
「已授權的 JavaScript 來源」要把每一個會開老師端的網域都列進去，少一個那個網域就登不了：

| 來源 | 用途 |
|---|---|
| `https://YOUR-SITE.pages.dev` | Cloudflare Pages 正式站 |
| `https://<netlify 站名>.netlify.app` | Netlify 鏡像 |
| `http://localhost:8000` | `npm run dev` 本機 |

「已授權的重新導向 URI」不用填——GIS 拿 ID token 走的不是授權碼流程，沒有重新導向。

建好之後：用戶端 ID 貼兩個地方，**兩邊必須一模一樣**：
1. 管理端專案的 Script Property `GOOGLE_CLIENT_ID`
2. `js/config.js` 的 `GOOGLE_CLIENT_ID`

**產出來的值只貼進那兩個 Script Properties 欄位。不要貼進聊天視窗、
不要寫進任何 `.md`、不要存進 vault。**

⚠️「專案設定」「指令碼屬性」這幾個中文字樣我沒有實際看過，
只確認過這個功能在專案設定頁面。

---

## 9. 拿到兩個 `/exec` 網址之後

### 9.1 填進前端

`js/config.js` 會加上 `GAS_ENDPOINT`（**共用檔，主線改，不是 S4**）。
拿到網址之後填在那裡，大致是這個形狀：

```js
export const GAS_ENDPOINT = {
  admin:  'https://script.google.com/macros/s/<管理端 DEPLOYMENT_ID>/exec',
  public: 'https://script.google.com/macros/s/<公開端 DEPLOYMENT_ID>/exec',
};
```

⚠️ 實際的鍵名與形狀以主線寫進 `js/config.js` 的為準；這裡只負責告訴你
「兩個網址填這裡」。

**注意網址裡的 id 是 deployment id，不是 script id。** 兩者長得很像但不同：
編輯器網址裡的是 script id（`/d/xxx/edit`），要填的是部署對話框給你的
`/macros/s/xxx/exec`。

### 9.2 驗收一：健康檢查（管理端，登入狀態）

在**已經登入老師 Google 帳號**的瀏覽器，直接開管理端 `/exec` 網址。
`gas/Code.gs` 的 `doGet` 預設路由就是 health（✅ 讀檔確認，第 382–388 行）。

應該看到：

```json
{"ok":true,"result":{"name":"班級積分堂 GAS 後端（管理端）"}}
```

⚠️ 這裡**不會**、也不該出現你的 Gmail。存取權是「任何人」之後這支 GET 誰都打得到，
回 email 等於把它掛在一個公開網址上給人抓，所以 `doGet` 已經拿掉那個欄位。

### 9.3 驗收二：管理端「讀得到 health、但做不了事」 ⭐ 這一條最重要

**設錯就是把記分 API 開給全世界。這一條沒過，其他全部不算數。**

⚠️ **判準跟舊版相反了，別照舊版驗。** 管理端的存取權現在是「任何人」
（理由見 §6.1 的修正框），所以匿名開 `/exec` 看到 health JSON 是**正確**的，
不是出事。真正該擋的是「匿名做得了事嗎」——門鎖在 `gas/Auth.gs`，不在部署權限。

無痕視窗（＝完全沒有憑證的陌生人）逐項試：

| 試什麼 | 應該發生 |
|---|---|
| GET `/exec` | 回 health JSON，**且不含任何 email** |
| GET `/exec?op=exportAll` | 404（GET 只有 health 一條路） |
| POST `{"op":"exportAll"}`（不帶 idToken） | `{"ok":false,...,"status":401}` |
| POST 帶一串亂打的 `idToken` | 同上，**錯誤訊息一字不差** |
| 用別的 Google 帳號登入拿到的 `idToken` | 同上，**錯誤訊息一字不差** |

留存證據用（不要加 `-X POST`——302 之後 curl 會繼續用 POST 打
`script.googleusercontent.com`，那邊只收 GET，你會拿到 405 加一頁 HTML。
用 `--data` 讓 curl 自己在轉址時改成 GET）：

```bash
curl -sSL '<管理端 /exec 網址>' \
  -H 'content-type: text/plain;charset=utf-8' \
  --data '{"op":"exportAll","payload":{}}'
```

看到 `"status":401` ＝正確。看到 `"ok":true` 加一整包資料 ＝**立刻停止**，
八成是 `TEACHER_EMAIL` 或 `GOOGLE_CLIENT_ID` 沒設（`gas/Auth.gs` 沒設定時會丟
「還沒設定」而不是放行，但仍要當場確認訊息內容）。

三種失敗訊息必須**完全一樣**。不一樣就是有人可以靠訊息差異推敲設定，
`gas/selftest.mjs` 第 9 節有一條專門在守這件事。

### 9.4 驗收三：公開端匿名進得去

同樣用無痕視窗開公開端 `/exec`。

- ✅ 正確：**不要求登入**，直接回應（health 或 S2 定義的預設路由）。
- ❌ 要求 Google 登入 → 存取權沒設成匿名可用，家長會全部被擋在外面。

### 9.5 驗收四：公開端只吐得出投影過的資料

契約鐵則第 3 條。無痕視窗（＝沒有任何憑證的陌生人）對公開端逐項試：

| 試什麼 | 應該發生 |
|---|---|
| 班級榜 | 回得來，而且**只有座號沒有姓名**（`13號 +7`）。出現任何一個中文姓名就是紅線破了 |
| 不帶代碼要個人資料 | 拒絕 |
| 用 A 學生的代碼要 B 學生的資料 | 拒絕 |
| 家長端的事件列表 | **只有正向、未撤銷**的事件。看得到任何 `delta < 0` 或 `voided` 的項目就是投影沒做好 |
| 用 `{"op":"appendEvent",...}` POST 打公開端 | 打不通。公開端專案裡根本沒有 `Code.gs`，`OPS` 不存在 |

最後一列是這個「兩個專案」設計最直接的好處：不是靠 if 擋掉，是那段程式碼
不在那台機器上。

### 9.6 驗收五：試算表裡一個姓名都沒有

契約鐵則第 2 條，用眼睛看最準：

1. 從管理端貼一次名冊（含真實姓名）
2. 打開那份 Google 試算表 → `docs` 工作表 → 找 `classes` 那一列
3. 用 ⌘F 搜一個真實學生的姓名

**搜不到才算過。** 搜得到就停止部署，回報 S1／S3。

---

## 10. 常見錯誤與對策

前四條的錯誤訊息我在本機實測過（✅），後面幾條是 ⚠️ 依文件與原始碼整理。

| 症狀 | 訊息 | 原因與對策 |
|---|---|---|
| ✅ `npx clasp` 直接掛 | `npm error could not determine executable to run` | 裝到沒有 scope 的空殼套件。改用 `npx --yes @google/clasp@3.3.0` |
| ✅ 任何指令 | `Project settings not found.` | 當下目錄找不到 `.clasp.json`。用 `-P gas/.clasp.admin.json` 明確指定 |
| ✅ `push` / `deploy` | `No credentials found.` | 還沒 `clasp login`。先 `show-authorized-user` 確認（沒登入回 `Not logged in.`） |
| ✅ `create-script` | `Invalid container file type` | `--type` 只認 `docs/forms/sheets/slides`，其餘要用 `standalone`（或整個別帶） |
| ⚠️ `push` 登入了還是失敗，訊息看起來跟權限無關 | 各種 | **九成是 §1.3 的 Apps Script API 沒開。** 先去 <https://script.google.com/home/usersettings> 開啟 |
| ⚠️ `create-script` 拒絕建立 | `Project file already exists.` | 當下目錄已經有 `.clasp.json`。換目錄或先刪掉 |
| ⚠️ 改了程式碼但線上沒變 | 沒有錯誤訊息 | `push` 不等於部署。要跑 §7 的 `deploy -i <DEPLOYMENT_ID>` |
| ⚠️ 家長端跑出管理端的回應（或反過來） | 沒有錯誤訊息 | 組版時檔案放錯目錄，`doGet`／`doPost` 互相覆蓋。跑 §5.2 的 `show-file-status` 對清單 |
| ⚠️ 前端 fetch 噴 CORS | 瀏覽器 console | `content-type` 一定要 `text/plain;charset=utf-8`、`credentials: 'omit'`、`redirect: 'follow'`。見 `docs/gas-migration.md` §4，已有測試守著 |
| ⚠️ 執行時噴找不到試算表 / 沒有授權 | Apps Script 執行紀錄 | 兩件事各查一次：① `SHEET_ID` 有沒有設（§8）② manifest 的 `oauthScopes` 是不是完整的 `.../auth/spreadsheets`。**`gas/appsscript.json` 目前是 `.../spreadsheets.currentonly`，跟 `Store.gs` 的 `openById` 不搭，很可能就是這裡**（§2） |
| ⚠️ 換一台電腦後學生都變成「13號」 | 沒有錯誤訊息 | **這是設計，不是 bug。** 姓名只存在本機 `localStorage` 的 `cp:names`，重貼一次名冊就回來，事件與分數都還在。見 `docs/gas-contract.md` |

查執行期的錯誤：Apps Script 編輯器左側 **執行項目（Executions）**，
或 `npx --yes @google/clasp@3.3.0 -P gas/.clasp.admin.json tail-logs`
（✅ 指令存在，別名 `logs`；⚠️ 未實跑，可能需要先 `setup-logs` 關聯 GCP 專案）。

---

## 11. 完整流程速查

第一次（⚠️ 全部未實跑）：

```
1. node --version ≥ 20
2. 開 https://script.google.com/home/usersettings 的 Apps Script API
3. npx --yes @google/clasp@3.3.0 login
4. 建兩個 standalone 專案，記下兩個 SCRIPT_ID
5. 建一份空白試算表，記下 SHEET_ID
6. cp gas/.clasp.json.example → .clasp.admin.json / .clasp.public.json，填 scriptId + rootDir
7. 組版（§5.1）→ show-file-status 對清單（§5.2）→ push -f（§5.3）
8. 兩個專案都設 SHEET_ID；管理端再加 GOOGLE_CLIENT_ID + TEACHER_EMAIL（§8）
9. 在 UI 各建一個網頁應用程式部署（§6），記下兩個 /exec
10. 網址填進 js/config.js 的 GAS_ENDPOINT（主線改）
11. 跑完 §9.2–9.6 五項驗收，尤其是 9.3
```

之後每次改程式碼：見 `gas/README.md`。
