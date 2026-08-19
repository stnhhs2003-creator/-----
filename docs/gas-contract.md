# GAS 版開工契約（2026-08-15）

四條線平行開發。設計依據是 `docs/gas-migration.md`，這份只寫「已經拍板的決定」
與「四條線之間的交界」。有疑問先讀 migration 那份。

## 老師拍板的兩件事

| 決定 | 選擇 | 後果 |
|---|---|---|
| 家長端認人 | **發家長個人代碼** | 沒有 Google 登入。代碼轉貼給別人擋不住，這是已知且被接受的退讓 |
| 部署帳號 | **個人 Gmail** | **學生姓名不上雲端**（見下），資料保管人是老師個人 |

## 鐵則

1. **只動自己名下的檔案。** 要改共用檔，寫在回報裡由主線統一改。
2. **姓名絕對不進試算表。** 這是這一版最硬的一條，理由見下一節。
   任何路徑（`saveClasses`、`importAll`、`init`、公開端回應）都不得讓
   `student.name` 進到 Sheets 或離開老師的裝置。
3. **投影在後端做。** 家長端只拿得到正向、未撤銷的事件；學生端拿不到任何人的
   待改進明細。這條紅線從 Cloudflare 版整條搬過來，不得放寬。
4. **金鑰只進 Script Properties**，不寫在 `.gs` 檔裡，不進 git。
5. **回報要能被驗證**：實際指令輸出、實際頁面行為，不是「應該可以」。

## 姓名分離：這一版的核心設計

部署帳號是個人 Gmail，所以 `docs/privacy-review.md` 9.3 的捷徑方案生效：

> 36 個欄位裡能直接識別自然人的只有 `student.name` 一項。
> 雲端只存 `studentId`、座號、事件流，姓名對照表留在老師本機。
> 即使整份試算表外流，外流的也只是「某班某座號在某天被記了主動發言 +2」。

### 實作位置：`js/store-gas.js`，不是 GAS 端

GAS 端**根本不知道有姓名這個欄位**——不是收到之後刪掉，是從來沒收到過。
分離做在 `store-gas.js` 這一層：

```
上層（app.js / roster.js / comments.js …）
    ↕  看到的永遠是「有姓名」的完整 classes，跟 LocalStore 一模一樣
js/store-gas.js
    ├─ 寫：把 name 拆出來存進 localStorage 的 cp:names，其餘送上雲
    └─ 讀：把雲上的 classes 跟 cp:names 合起來還原
    ↕  這條線上的 JSON 一個姓名都沒有
gas/Code.gs（Sheets）
```

`cp:names` 的形狀：`{ "c701-s13": "洪語彤", ... }`，只有這一個 key，不分班。

### 沒有姓名的裝置會看到什麼

換一台電腦、或家長學生的手機，`cp:names` 是空的。這時候上層拿到的
`student.name` 是空字串。**各頁面要能撐住這件事**，做法是統一 fallback 成
`{no}號`——這件事集中在 `store-gas.js` 做，上層不需要各自判斷。

老師換裝置後要重新貼一次名冊才會看到名字（事件、分數、代碼、設定都還在）。
這是選個人 Gmail 換來的代價，要在部署指南與 `privacy.html` 都寫清楚。

### 公開端（家長／學生）永遠沒有姓名

那份部署跑在別人的手機上，`cp:names` 必然是空的，所以：

- **班級榜只顯示座號**（「13號 +7」）。這不是缺陷，是這個設計的直接結果，
  而且班級榜本來就是會投影出來的東西，只有座號反而更好。
- **家長端顯示「您的孩子（13號）」**。家長本來就知道自己孩子叫什麼。
- 家長綁定**不再比對姓名**（原本是座號＋姓名），改為比對家長個人代碼。

## 交界：`gas/Store.gs`（S1 名下，S2 唯讀使用）

S2 的公開端要讀資料，但不能自己寫一套讀法。S1 在 `gas/Store.gs` 提供這些，
**簽名固定，S1 不得擅自更動**：

| 函式 | 回傳 | 說明 |
|---|---|---|
| `readDoc(name)` | 物件／陣列 | name ∈ classes / behaviors / rewards / settings |
| `allEvents()` | 事件物件陣列 | 全部事件，含已撤銷；呼叫端自己濾 |
| `eventsOf(studentId)` | 事件物件陣列 | 單一學生，含已撤銷 |
| `appendEventRow(evt)` | evt | 已帶 id/ts 的事件直接落盤，走 `withLock` |
| `withLock(fn)` | fn 的回傳 | `LockService` 包起來 |
| `nowISO()` | ISO 字串 | 統一時間來源 |
| `uid()` | 字串 | 事件 id |

事件物件的欄位（跟前端完全一致，不做轉名）：
`{ id, ts, classId, studentId, behaviorId, delta, kind, period, note, voided }`

## 檔案歸屬

| 線 | 名下檔案 |
|---|---|
| **S1** 管理端與儲存核心 | `gas/Code.gs`、`gas/Store.gs`、`gas/appsscript.json` |
| **S2** 公開端（家長／學生） | `gas/Public.gs`、`gas/public-appsscript.json` |
| **S3** 姓名分離與前端接線 | `js/store-gas.js`、`tests/store-gas.test.mjs`、`tests/name-split.test.mjs` |
| **S4** 部署與文件 | `docs/gas-deploy.md`、`gas/.clasp.json.example`、`gas/README.md` |

**主線保留**：`js/config.js`、`js/store-select.js`、`js/codes.js`、`privacy.html`、
`docs/privacy-review.md`、`docs/gas-migration.md`、`README.md`、`ROADMAP.md`、
以及 `js/` 底下其餘所有檔案。

## 修正紀錄（2026-08-15，開工後）

1. **兩個 Apps Script 專案，不是一個專案兩個部署。** 一個專案只有一組 `doPost`，
   匿名那份會連 `OPS` 一起分派出去。公開端＝`Public.gs`＋`Store.gs`＋`public-appsscript.json`，
   管理端＝`Code.gs`＋`Store.gs`＋`appsscript.json`，共用一本試算表。
2. **兩邊的 scope 都改成完整 `.../auth/spreadsheets`。** `Store.gs` 的 `book()` 走
   `SpreadsheetApp.openById(SHEET_ID)`，`spreadsheets.currentonly` 只准碰容器綁定的當前檔，
   對不上。`SHEET_ID` 因此是必填，不是選填。
3. **事件 id 由前端產**（`js/store-gas.js` 的 `uid()`），當冪等鍵送上去；
   `ts` 仍由 GAS 的 `nowISO()` 決定。S1 的 `appendEventRow` 掃最後 200 列擋重送。
4. **家長代碼另立一套**（`js/codes.js` 的 `randomParentCode`）：8 碼、
   字元集 `abcdefghjkmnpqrstuvwxyz23456789`。學生的 4 位數在公開的 `/exec` 上
   只有一萬組，掃得完。
5. **潤稿路徑的姓名遮蔽做在 `js/ai-client.js`**：送出前換成 `〔13號〕`，
   收回來再換回去；還原不了就整篇退回骨架。

## 環境變數（Script Properties）

| key | 用途 | 誰用 |
|---|---|---|
| `SHEET_ID` | 資料試算表 id。**必填**：`Store.gs` 的 `book()` 走 `openById` | S1／S2 |
| `AI_API_KEY` | 潤稿用，未設時所有文字功能仍完全可用 | 之後 |

## 驗收共通條件

- `npm test` 全綠（開工當下 331 項）。新測試要先確認會紅：把實作改壞跑一次，
  把實際輸出貼進回報，再改回來。
- `.gs` 檔要能通過 V8 語法檢查（`node --check` 對 `.gs` 不適用，
  改用 `node -e "new Function(require('fs').readFileSync('gas/X.gs','utf8'))"`）。
- 回報要寫「還缺什麼」，不要只寫做了什麼。
