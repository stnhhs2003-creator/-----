# 從 Cloudflare Pages + Turso 遷到 Google Apps Script

> 2026-08-15 · G1 線的評估文件
> 讀過的程式：`js/store.js`、`js/store-select.js`、`js/store-cloud.js`、
> `functions/api/data/[[route]].js`、`functions/api/auth/[[route]].js`、
> `functions/api/parent/[[route]].js`、`functions/api/student/[[route]].js`、`db/schema.sql`

---

## 0. 三句話結論

1. **現在不要再往 Turso 那條路投工。** 已經寫好的雲端程式碼有六成可以原封不動用在 GAS 上
   （純函式、UI、事實層、投影規則、測試），會丟掉的那四成（Pages Functions 三支路由、
   HMAC session、Turso HTTP client）**已經寫完了**——繼續加功能才是浪費，收手不是。
2. **執行身分選「以我（部署者）的身分執行」**，而且**拆成兩個 Apps Script 專案**：
   老師後台那份存取權設「只有我自己」，家長／學生那份設「任何人」但只掛投影過的路由。
   「以存取者的身分執行」在這個專案是死路，理由見第 3 節。
3. **個資盤點 C2（姓名要不要上雲端）在 GAS 模式下應該改判為「可以上」**，
   但有前提條件（第 6 節）。這是遷到 GAS 最大的實質收穫，比省下的雲端費用重要得多。

---

## 1. 儲存層介面怎麼在 GAS 上實作

`js/store.js` 的 `LocalStore` 是介面的參考實作，一共 `name` 加 17 個方法。
GAS 端的對應寫在 `gas/Code.gs`，前端那半在 `js/store-gas.js`。

| 介面 | Turso 版怎麼做 | GAS 版怎麼做 | 難度 |
|---|---|---|---|
| `init(seed)` | `INSERT ... ON CONFLICT DO NOTHING` | 讀 `docs` 工作表，缺哪包補哪包 | 一樣 |
| `appendEvent()` | 一句 INSERT | `events.appendRow()`，進 `LockService` | **更簡單** |
| `voidEvent(id)` | `UPDATE ... SET voided = 1` | 找到列號，改第 10、11 兩欄 | 稍麻煩（要先掃出列號） |
| `queryEvents()` | WHERE 下推到 SQL | `getDataRange().getValues()` 後在 GAS 端 filter | **這是最大的退步**，見下 |
| `getX()` / `saveX()` | `docs` 表一列一包 JSON | `docs` 工作表一列一包 JSON | 一模一樣 |
| `exportAll()` | 一次查詢 + 四包 doc | 同上 | 一樣 |
| `importAll()` | 先 DELETE 再逐筆 INSERT | `deleteRows` 後 `setValues()` 一次寫完 | **更快**（批次寫入） |
| `purgeStudent/Class()` | `DELETE ... WHERE` | 由後往前 `deleteRow()` | 較慢，但一學期用不到幾次 |
| `resetAll()` | 兩句 DELETE | 清掉兩張工作表的資料列 | 一樣 |

### 唯一真正的退步：`queryEvents` 沒有 WHERE

`functions/api/data/[[route]].js` 的 `eventsQuery()` 有一段註解寫得很清楚：
「不把整份事件撈回 Worker 再過濾——一個班一學期幾千筆，撈回來過濾遲早會炸」。
**在 GAS 上，我們就是被迫這樣做**：Sheets 沒有索引，`getValues()` 是全表拉取。

但這個「遲早會炸」的預期值要重算。實際量級是：

- 一位老師帶兩三個班，約 90 位學生
- 一位學生一週被記 3～5 筆，一學期 20 週 → 約 8,000～10,000 筆／學期
- 一列 11 欄 → 約 11 萬個儲存格。試算表上限是 **1,000 萬個儲存格**，用掉 1.1%

一次 `getDataRange().getValues()` 拉一萬列，實測量級是幾百毫秒（GAS 的成本在「往返次數」
不在「資料量」——真正的地獄是逐列 `getRange()`）。老師點一張行為卡是 `appendRow`，
那條路徑根本不讀全表。**所以量不是問題，至少到五萬列以前不是。**

守則寫進 `gas/Code.gs` 的 TODO：超過約五萬列（≒ 五個學年）就按學年拆工作表。
在那之前不要為了想像中的規模先拆分片，那只會換來一堆同步 bug。

### 事件流是 append-only，這對 Sheets 是好消息還是壞消息？

**是好消息，而且是這次遷移最幸運的一件事。**

Sheets 最弱的地方是「讀出來、改、寫回去」——兩個分頁同時做，後寫的整個蓋掉先寫的，
而且沒有交易可以回滾。而這個專案的**主要寫入路徑（記一筆行為）是純 append**：
`appendRow` 是原子的，兩筆同時進來只會變成兩列，先後順序不重要（事件流本來就靠 `ts` 排序），
**不可能少一筆**。這正好躲開 Sheets 最致命的弱點。

會踩到競態的是另外三種操作，而它們的共同特徵是「老師一個人、偶爾做一次」：

| 操作 | 競態風險 | 對策 |
|---|---|---|
| `voidEvent` | 兩人同時撤銷不同事件 → 列號位移 | `LockService.getDocumentLock()` |
| `saveDoc`（名冊／行為卡） | 兩個分頁同時存名冊 → 後者整包蓋掉前者 | 鎖 + **TODO：加 updatedAt 樂觀鎖** |
| `purge` / `importAll` | 刪列時有人在 append | 鎖 |

`gas/Code.gs` 的作法是：**所有會寫的 op 一律進鎖，讀不進鎖**，等待 15 秒。
老師在課堂上點卡不會排隊（append 只鎖幾十毫秒），purge 那種慢操作一學期跑不到三次。

還有一個 Turso 版有、GAS 版目前沒有的保護：`ON CONFLICT (teacher_id, id) DO NOTHING`
的**重送冪等**。網路重試時 Turso 不會變成兩筆分數，Sheets 會。
**這是必須補的一件事**——作法是前端產 id 後帶上來，GAS 端 append 前掃一次 id。
掃一萬列只為了防重複有點蠢，實務上改成「近 200 列裡有沒有同 id」就夠（重送都在幾秒內）。

---

## 2. 執行身分：這一題怎麼選

Apps Script 的網頁應用程式部署有兩個下拉，**要一起看才有意義**：

- **執行身分（Execute as）**：`以我（部署者）的身分執行` ／ `以存取這個網頁應用程式的使用者身分執行`
- **存取權（Who has access）**：`只有我自己` ／ `<學校網域>內的所有人` ／ `所有人` ／ `所有人（包含匿名使用者）`

### 選項 A：以存取者的身分執行

程式碼會用「打開網頁那個人」的 Google 權限去跑。聽起來安全，在這個專案卻是死路：

1. **家長與學生一定要有 Google 帳號**，而且要能登入。國中家長裡沒有 Google 帳號、
   或手機上登著小孩帳號的比例不低。這一條就把很多人擋在門外了。
2. **他們必須對那份試算表有讀取權**——因為程式碼是以他們的身分去 `SpreadsheetApp.openById()`。
   一旦給了讀取權，他們可以**直接打開試算表看全班的每一筆紀錄**，
   `functions/api/parent/[[route]].js` 那三道關卡與「投影在後端做」的紅線全部作廢。
   這不是「比較不安全」，這是**整個家長端紅線設計直接失效**。
3. 存取權沒有辦法設成「所有人（包含匿名）」——執行身分是使用者時，本來就要認人。

**選項 A 只在一種情境成立**：使用者全部是同一個學校 Workspace 網域內的**老師同事**，
每個人看自己的資料。這個專案的使用者是家長和學生，不是同事。**不選。**

### 選項 B：以我（部署者）的身分執行 ← 建議

程式碼永遠以老師本人的權限跑，`SpreadsheetApp` 永遠拿到老師那份試算表，
**跟瀏覽器前面是誰完全無關**。存取者不需要 Google 帳號、不需要對試算表有任何權限。

這代表：

- **資料持有人 = 部署那支腳本的 Google 帳號**。試算表在那個帳號的雲端硬碟裡。
- **teacherId 不是從請求讀出來的，是這份部署的常數。**
  `functions/api/data/[[route]].js` 的鐵則是「teacherId 一律由 `requireTeacher()` 決定，
  絕不從 body 或 query 讀」；在單租戶的 GAS 上，這條鐵則的實作方式是
  **根本沒有那個欄位**——連要防的東西都不存在。這是架構上的簡化，不是偷懶。
- 一位老師 = 一份 Apps Script 專案 + 一份試算表 + 一組 `/exec` 網址。要給第二位老師用，
  就複製一份，不是多一個租戶。

**代價要講清楚，這不是免費的：**

| 代價 | 實情 | 怎麼處理 |
|---|---|---|
| `/exec` 網址是公開端點，任何人打得到 | 網址本身不是秘密（家長的瀏覽器看得到） | 門鎖在程式裡：個人代碼、老師核可，跟現在 `student/[[route]].js` 的設計一模一樣 |
| 腳本有老師的完整權限，寫錯一行就是全表外洩 | 真的 | 存取權「任何人」那份部署**只掛投影過的唯讀路由**，不掛 `OPS` |
| 沒有辦法用 Google 認出呼叫者是誰 | 執行身分是部署者時，`Session.getActiveUser()` 對匿名／外部網域一律回空字串 | 見下面的「兩個 Apps Script 專案」 |
| 配額算在老師帳號頭上 | 個人 Gmail 與 Workspace 差五倍 | 見第 5 節 |

### 建議的具體形狀：兩個 Apps Script 專案（**修正，2026-08-15**）

> **原本這一節寫的是「兩個部署，一份程式碼」，那行不通。**
> GAS 一個專案只能有一組 `doGet`／`doPost`，`Code.gs` 與 `Public.gs` 兩邊都有，
> 同專案共用全域、後載入的會靜默覆蓋前者。而且權限只寫得進 manifest
> （`deployments.create` 的 body 只有 `versionNumber`／`manifestFileName`／`description`），
> 單專案要生出兩種權限只能「換 manifest → 建版本 → 部署」來回兩趟，
> 順序弄反就會把掛滿 `OPS` 的管理端部成「任何人」，而且外表看不出來。
>
> 正解是**兩個 Apps Script 專案共用一本試算表**（公開端用 `SHEET_ID` 指過去）。
> git 裡原始碼仍只有一份，組版時分推兩邊。作法見 `docs/gas-deploy.md`。
> 公開端的專案裡**根本沒有 `Code.gs`**——這是結構性防呆，不靠記得。

### 建議的具體形狀：兩邊各掛什麼

| 部署 | 執行身分 | 存取權 | 掛哪些路由 |
|---|---|---|---|
| **管理端** | 以我（老師）的身分執行 | **只有我自己** | `gas/Code.gs` 的全部 `OPS`（記分、名冊、匯出、刪除） |
| **家長／學生端** | 以我（老師）的身分執行 | 所有人（包含匿名） | 只有 `rank`／`me`／`redeem-request`，全部投影過 |

管理端設「只有我自己」，Google 就會替我們做掉整個 `functions/_lib/session.js`：
沒登入的人連進都進不來，登入了但不是老師本人也進不來。
**HMAC session、OAuth callback、state cookie、`DEV_TEACHER_ID` 後門——整包不用了。**
這是遷到 GAS 最大的一筆程式碼減法（`functions/_lib/session.js` 145 行
+ `functions/api/auth/[[route]].js` 200 行 + `tests/session.test.mjs`）。

**家長與學生怎麼進得來？** 完全不需要 Google 帳號，走現有那套：

- 學生：個人代碼（`js/codes.js` 的 `findStudentByCode`，前後端共用同一份實作，可原封不動搬）
- 家長：目前是「Google 登入 → 通過碼 → 老師核可」三道。第一道在 GAS 上沒了，
  剩下兩道。**這是一個真實的退步，要老師決定怎麼補**：
  - 方案一：家長也發個人代碼（跟學生同一套機制，一個孩子一組，可由老師撤銷重發）。
    少了「認出是哪一個 Google 帳號」的能力，也就是說代碼轉貼給別人就擋不住。
  - 方案二：家長端保留 Google 登入，但改用 GAS 的 `access: 網域內所有人` — 家長多半不在校內網域，不可行。
  - 方案三：家長端仍舊掛在 Cloudflare Pages（保留現有那支 `parent` API 與 Turso），
    只有老師端搬 GAS。**不建議**：兩套儲存要同步，最糟的組合。

  **我的建議是方案一**，並且把「代碼可撤銷重發」做進管理端。理由：家長端本來就只看得到
  正向投影（`parentView()`），代碼外流的損害是「別人看到某位學生被記了幾次主動發言」，
  跟老師端外流不是同一個量級。用一道會失效的鎖換掉「全體家長都要有 Google 帳號」的門檻，
  對一個要真的被用起來的工具來說划算。**但這一題需要老師拍板**，因為它是安全性的退讓。

### 需要老師決定的事（我判斷不了）

1. **部署帳號用學校 Workspace 帳號還是個人 Gmail？**
   這一題決定：資料的法定保管人是誰、學校有沒有管理權（老師離職時資料怎麼辦）、
   配額上限、以及第 6 節的個資判斷。我的建議是**學校 Workspace 帳號**，
   但這牽涉到學校資訊政策，不是技術問題。
2. **家長端要不要放棄 Google 登入**（上面的方案一）。

---

## 3. 逐檔清算：哪些搬得走、哪些丟掉

### 原封不動搬過去（不用改一個字）

| 檔案 | 為什麼安全 |
|---|---|
| `js/rules.js` | 純函式（`detectAlerts`／`parentView`／`scoreByStudent`／`expiredClasses`），不碰儲存 |
| `js/summarize.js` | 事實層，吃事件陣列吐事實包 |
| `js/shop-core.js` | 純函式，餘額與可動用點數 |
| `js/labels.js` | 標籤字典 |
| `js/codes.js` | 個人代碼比對，本來就設計成前後端共用（GAS 端要改成 `.gs` 或用 clasp 打包） |
| `js/comments.js`／`js/contact.js`／`js/weekly.js` | 三期的骨架產生器，只吃事實包 |
| `js/data.js` | 種子資料與預設值 |
| `js/backup.js` | 匯入匯出的驗證與檔名，只透過 store 介面講話 |
| `js/store.js` | **LocalStore 要留著**，它是介面定義，也是離線模式 |
| 六個 `*.html` + `assets/*.css` | 完全不受影響 |
| `tests/rules`／`parent-view`／`shop-core`／`comments`／`contact`／`weekly`／`backup` | 測的都是純函式 |

**這一欄就是「別再往 Turso 投工」的證據**：這些東西當初做對了（把邏輯放在純函式、
儲存只有一層薄介面），所以換後端不痛。

### 必然丟掉

| 檔案 | 行數 | 為什麼沒了 |
|---|---|---|
| `functions/api/data/[[route]].js` | 441 | Pages Functions 沒了；`tursoClient()` 沒了；`eventsQuery()` 的 SQL 沒了 |
| `functions/api/auth/[[route]].js` | 200 | Google OAuth 流程整包被 GAS 的部署權限取代 |
| `functions/_lib/session.js` | 145 | HMAC session cookie 不需要了 |
| `js/auth.js` | — | 前端的登入狀態顯示，管理端不需要 |
| `js/store-cloud.js` | 149 | 換成 `js/store-gas.js` |
| `db/schema.sql` | 77 | 換成兩張工作表（但**欄位設計照抄**，見 `gas/Code.gs`） |
| `tests/store-cloud.test.mjs`／`session.test.mjs` | — | 測的是上面那些 |
| `wrangler` / Pages 部署設定 | — | 換成 clasp |

### 要重寫但形狀照抄

| 檔案 | 怎麼處理 |
|---|---|
| `functions/api/parent/[[route]].js`（271 行） | 三道關卡剩兩道（見第 2 節）；`codeMatches`／`findStudent` 兩個純函式照搬；**「投影在後端做」的紅線一定要跟著搬** |
| `functions/api/student/[[route]].js`（255 行） | `rank`／`me`／`redeem-request` 三條路由整個形狀照抄，SQL 換成 Sheets 的 filter；**投影紅線同上** |
| `functions/api/ai/[[route]].js` | GAS 的 `UrlFetchApp` 可以打 LLM API，但金鑰要進 Script Properties；數字白名單的邏輯照搬 |
| `js/config.js` | `CLOUD_ENABLED` 之外要加 `GAS_ENDPOINT`（**共用檔，主線改**） |
| `js/store-select.js` | 要多一條 GAS 分支（**共用檔，主線改**） |

**帳面：丟掉約 1,010 行後端 + 兩份測試；原封不動搬走約 1,400 行前端與純函式。**

---

## 4. GAS 的實際限制會咬到哪裡

| 限制 | 咬到什麼 | 對策 |
|---|---|---|
| **沒有 REST 路徑**：只有 `doGet`／`doPost`，`/exec` 後面接不了 `/events/xxx/void` | `CloudStore` 那十幾條路由 | 收斂成一支 RPC：`POST { op, payload }`。已實作 |
| **CORS 不處理預檢** | `content-type: application/json` 直接死 | 用 `text/plain;charset=utf-8`（CORS 簡單請求），body 照樣是 JSON 字串。`credentials` 必須 `omit`。已實作並有測試守著 |
| **`/exec` 會 302 到 `script.googleusercontent.com`** | fetch 要 `redirect: 'follow'`；某些企業 proxy 會擋 | 已實作 |
| **`ContentService` 設不了 HTTP 狀態碼** | 前端沒辦法用 `res.status` 分辨錯誤 | 一律回 200，成敗寫在 body 的 `ok`／`status`，前端 `unwrap()` 翻回例外。已實作並有測試 |
| **`google.script.run` 不是 fetch**：callback 式、只能傳簡單型別、沒有狀態碼 | 若改成整站由 HtmlService 端出來，就得走這條 | `js/store-gas.js` 兩種傳輸層都實作了，同源時自動選 `google.script.run` |
| **iframe 沙箱**：HtmlService 的頁面跑在 `googleusercontent.com` 的 iframe 裡 | 網址列不會變、瀏覽器返回鍵行為怪、部分行動瀏覽器對第三方 cookie 的限制會影響 localStorage | **建議前端繼續放在 Cloudflare Pages（純靜態），只有資料走 GAS**。這樣網址、PWA、離線模式全部保留 |
| **執行時間上限**：個人 6 分鐘／Workspace 30 分鐘 | 只有 `importAll` 一萬列、或 `purgeClass` 逐列刪有機會逼近 | `importAll` 用 `setValues()` 一次寫完（不是一萬次 `appendRow`）；purge 若超時要分批 |
| **同時執行上限 30**、同一使用者的並行呼叫會排隊 | 全班 30 個學生同時開學生端 → 可能排隊 | 學生端是唯讀投影，可以加 `CacheService` 快取 30 秒 |
| **`LockService` 最長 5 分鐘、`tryLock` 逾時要處理** | 寫入衝突 | 15 秒等不到就回「請再試一次」，不要靜默失敗 |
| **每日配額**：`UrlFetchApp` 個人 20,000 次／日 | 只有 AI 潤稿會用到 | 潤稿本來就是老師手動觸發，一天不會到 100 次 |
| **沒有交易** | 見第 1 節 | 鎖 + append-only + TODO 樂觀鎖 |
| **沒有冪等鍵** | 網路重試會變兩筆分數 | **必補**，見第 1 節 |

---

## 5. 配額：個人 Gmail vs 學校 Workspace

| 項目 | 個人 Gmail | Workspace（含教育版） |
|---|---|---|
| 單次執行時間 | 6 分鐘 | 30 分鐘 |
| 觸發器每日總執行時間 | 90 分鐘 | 6 小時 |
| `UrlFetchApp` 每日 | 20,000 | 100,000 |
| 試算表儲存格上限 | 1,000 萬 | 1,000 萬 |

網頁應用程式的「被呼叫次數」本身沒有明確的每日上限，真正會先撞到的是同時執行數（30）
與單次執行時間。**以這個專案的量級，個人 Gmail 也夠用**——選 Workspace 的理由是治理與
法遵（第 6 節），不是配額。

---

## 6. 個資：Google Drive vs Turso，以及 C2 該怎麼判

### 差在哪

| | Turso（現況設計） | GAS + 老師的試算表 |
|---|---|---|
| 資料實際存在哪 | 第三方公司的資料庫，**境外**（`privacy-review.md` E3 至今沒填 region） | Google 的資料中心，境外，但**在老師（或學校）自己的帳號下** |
| 誰是資料保管人 | 老師個人用 email 註冊的一個 SaaS 帳號 | 老師的 Google 帳號；若是學校 Workspace，**保管人實質上是學校** |
| 有沒有資料處理契約 | **沒有**。老師個人點同意的服務條款 | 學校 Workspace 有教育版的資料處理條款；個人 Gmail 則同樣沒有 |
| 學校能不能管 | 不能。老師離職，資料在他個人帳號裡 | Workspace 可以。管理員能停用帳號、轉移雲端硬碟所有權 |
| 老師看不看得懂資料在哪 | 要開 Turso 主控台 | **打開雲端硬碟就是那份試算表** |
| 出事怎麼止血 | 撤銷 token、關 `CLOUD_ENABLED` | 把部署改成「只有我自己」，一鍵 |

最後那一列被低估了。`privacy-review.md` 9.1 誠實寫著「上述所有雲端程式碼從未在真實環境跑過」。
一個老師能自己看懂、自己備份、自己刪掉的儲存，出事時的處置速度跟一個他從沒登入過的
第三方資料庫不是同一件事。

### 我對 C2 的判斷

`privacy-review.md` 的 C2 是：「已評估姓名是否可以不上雲端」，9.3 的建議是
「姓名留在老師本機，雲端只存 studentId 與座號」。**那個建議是針對 Turso 寫的，前提變了。**

**判斷：在 GAS 模式下，C2 應改判為「姓名可以存在雲端（＝老師的試算表）」，條件有三個。**

理由：

1. 9.3 的邏輯是「36 個欄位裡能識別自然人的只有 `student.name`，拿掉它，
   即使整份外流也只是某班某座號的紀錄」。這個推論**在 Turso 上完全成立**，
   因為那份資料庫是一個老師從沒打開過、學校也管不到的境外服務。
2. 但在 GAS 上，那份試算表跟老師今天已經放在雲端硬碟裡的
   「座號姓名對照表.xlsx」、「幹部名單.xlsx」、「聯絡簿檢查紀錄.xlsx」
   **是同一個信任邊界裡的同一類東西**。要求這個工具把姓名留在瀏覽器裡，
   而隔壁資料夾就躺著一份完整名冊，這個限制**只換來不方便，換不到實質的隱私**。
3. 而且「姓名不上雲端」在 GAS 上的代價比 Turso 版更痛：老師端就是那份試算表，
   姓名不在裡面的話，老師打開試算表看到的是一堆 `s01`、`s02`——
   **他就沒有辦法自己查、自己核對、自己備份**，而那正是選 GAS 的主要好處。

**三個條件（缺一個就退回「姓名不上」）：**

1. **部署帳號必須是學校 Workspace 帳號，不是個人 Gmail。**
   個人 Gmail 沒有學校的資料處理契約，也沒有管理員可以在老師離職時接手，
   那就退回 Turso 版的處境（只是換一家外國公司），C2 的原判維持。
2. **那份試算表不得共用給任何人**（不加共用者、不設「知道連結的人可以檢視」）。
   一旦共用，第 2 節選項 A 的災難就會從側門進來。管理端部署設「只有我自己」是同一件事的另一半。
3. **`privacy-review.md` 的 E3（境外傳輸的事實）與家長告知照樣要寫。**
   Google 的伺服器一樣在境外。改判的是「風險等級」，不是「不用告知」。

**這一判斷需要老師確認條件 1 之後才定案**，並且要跟 A1～A3（向學校端問的三個問題）
一起帶去問。實際上，改成 GAS 之後那三個問題會好問很多：
從「我想把學生資料放到一家叫 Turso 的美國公司」變成
「我想用學校的 Google 帳號，把班級積分記在一份不共用的試算表裡」——
第二種問法，多數學校的資訊組長（也就是使用者本人）當場就能判。

同時要提醒：C1（`note` 欄位）與 C3（`init()` 不寫入示範資料）**不會因為換 GAS 而消失**，
那兩題跟後端是誰無關。`gas/Code.gs` 的 `init` 已經留了 C3 的 TODO。

---

## 7. 這一輪交付了什麼、還缺什麼

**已交付（G1 名下）**

- `docs/gas-migration.md`（本文件）
- `js/store-gas.js` — 與 LocalStore 同介面，傳輸層可注入，未接上 `store-select.js`
- `gas/Code.gs` + `gas/appsscript.json` — Apps Script 端骨架
- `tests/store-gas.test.mjs` — 12 項

**還缺（依優先順序）**

1. 冪等：前端產 id、GAS 端擋重送（第 1 節）
2. `saveDoc` 的樂觀鎖（`updatedAt` 比對），擋兩個分頁互相蓋掉名冊
3. 家長／學生端那份部署的路由（`functions/api/{parent,student}` 的形狀照抄）
4. `clasp` 的推送流程與 `gas/` 目錄的版控方式
5. **實際部署跑一次**。`privacy-review.md` 9.1 那句「從未在真實環境跑過」現在原封不動適用於 GAS 版

**需要主線改的共用檔**

| 檔案 | 要改什麼 |
|---|---|
| `js/config.js` | 新增 `export const GAS_ENDPOINT = ''`；`store-gas.js` 目前暫時從 `globalThis.CP_GAS_ENDPOINT` 讀 |
| `js/store-select.js` | 多一條 GAS 分支（建議：`STORE_BACKEND` 三選一，取代布林 `CLOUD_ENABLED`） |
| `ROADMAP.md` | 記下「雲端＝GAS」這個轉向，Turso 那條線停止投工 |
| `README.md` | 部署方式多一段 clasp |
| `docs/privacy-review.md` | C2 依第 6 節改判；E3 的境外描述改成 Google |
| `docs/term3-contract.md` | 鐵則第 2 條的 `CLOUD_ENABLED` 語意要跟著 backend 選擇調整 |
