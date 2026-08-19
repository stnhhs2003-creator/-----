# `gas/` — Apps Script 後端

給未來的自己看的速查。**第一次部署請看 `docs/gas-deploy.md`**，那份才有完整說明
與每一條指令的查證來源。這一份只回答三件事：這裡有什麼、改完要跑什麼、壞了怎麼辦。

clasp 版本：**`@google/clasp` 3.3.0**（3.x 跟網路上 2.x 的教學指令不一樣）。

---

## 檔案

| 檔案 | 屬於誰 | 是什麼 |
|---|---|---|
| `Store.gs` | S1 | 儲存原語：`readDoc` / `allEvents` / `eventsOf` / `appendEventRow` / `withLock` / `nowISO` / `uid`。**兩份部署共用**，簽名固定在 `docs/gas-contract.md`，不得擅改 |
| `Code.gs` | S1 | 管理端：`OPS` 全部的業務規則 + `doGet`（health）/ `doPost`（RPC）。**只進管理端那份部署** |
| `Public.gs` | S2 | 家長／學生端：`rank` / `me` / `redeem-request`，全部投影過。**只進公開端那份部署** |
| `appsscript.json` | S1 | 管理端 manifest（`executeAs: USER_DEPLOYING`＋`access: MYSELF`） |
| `public-appsscript.json` | S2 | 公開端 manifest（`USER_DEPLOYING`＋`ANYONE_ANONYMOUS`） |
| `selftest.mjs` / `public-selftest.mjs` | S1 / S2 | 在 Node 上假造 Apps Script 全域跑 `.gs` 的自我測試。**不會被 `clasp push` 帶上去**（不在 `build/` 底下，而且 `.mjs` 不在 clasp 預設收的副檔名裡） |
| `.clasp.json.example` | S4 | clasp 設定檔範本，欄位說明寫在檔案裡 |
| `README.md` | S4 | 這一份 |

不進 git（`docs/gas-deploy.md` §4.3 有 `.gitignore` 該加什麼）：

| 檔案 | 是什麼 |
|---|---|
| `.clasp.admin.json` / `.clasp.public.json` | 你自己從 example 複製出來的，各含一個 scriptId |
| `build/admin/` `build/public/` | 組版產物，每次推之前重建 |

**這裡沒有金鑰。** `SHEET_ID`、`GOOGLE_CLIENT_ID`、`TEACHER_EMAIL` 存在 Apps Script 的
Script Properties（專案設定 → 指令碼屬性），兩個專案各設一份，值要一樣。

---

## 為什麼是兩個 Apps Script 專案

`Code.gs` 與 `Public.gs` 都需要自己的 `doGet` / `doPost`。Apps Script 同專案的
`.gs` 共用一個全域命名空間，兩支放一起會**無聲互相覆蓋**。

而且網頁應用程式的存取權寫在 manifest 裡，`clasp deploy` 沒有旗標可以指定
（推導過程在 `docs/gas-deploy.md` §3）。一個專案要生兩種權限只能反覆換 manifest，
弄錯一次就是把記分 API 開給全世界。

兩個專案 → 公開端的 Apps Script 裡**根本沒有 `Code.gs`**，`OPS` 不存在，
不是靠 if 擋掉。兩邊的 `SHEET_ID` 指向同一份試算表。

---

## 改完 `.gs` 之後要跑什麼

### 1. 語法檢查 + 測試（本機，秒級）

```bash
cd /Users/naichengchen/projects/class-points
for f in gas/*.gs; do node -e "new Function(require('fs').readFileSync('$f','utf8'))" && echo "$f OK"; done
npm test
```

`node --check` 對 `.gs` 不適用，所以用 `new Function`（契約規定的做法）。

### 2. 組版

```bash
rm -rf gas/build
mkdir -p gas/build/admin gas/build/public
cp gas/Store.gs gas/Code.gs   gas/build/admin/
cp gas/appsscript.json        gas/build/admin/appsscript.json
cp gas/Store.gs gas/Public.gs gas/build/public/
cp gas/public-appsscript.json gas/build/public/appsscript.json
```

`rm -rf` 不能省，否則刪掉的舊 `.gs` 會殘留在 build 裡一路推上去。
`public-appsscript.json` 必須改名成 `appsscript.json`——clasp 的 manifest 檔名
是寫死的 `<rootDir>/appsscript.json`。

### 3. 對清單（不用登入，離線可跑）

```bash
npx --yes @google/clasp@3.3.0 -P gas/.clasp.admin.json  show-file-status
npx --yes @google/clasp@3.3.0 -P gas/.clasp.public.json show-file-status
```

admin 那邊出現 `Public.gs`、或 public 那邊出現 `Code.gs` → **停，組版錯了。**

### 4. 推

```bash
npx --yes @google/clasp@3.3.0 -P gas/.clasp.admin.json  push -f
npx --yes @google/clasp@3.3.0 -P gas/.clasp.public.json push -f
```

### 5. 更新部署（**沒跑這一步，線上什麼都不會變**）

```bash
npx --yes @google/clasp@3.3.0 -P gas/.clasp.admin.json list-deployments   # 抄 deploymentId
npx --yes @google/clasp@3.3.0 -P gas/.clasp.admin.json deploy \
  -i <DEPLOYMENT_ID> -d "$(date +%Y-%m-%d) 改了什麼"
```

公開端同理，換 `-P gas/.clasp.public.json`。

`-i` = 更新既有部署（網址不變、權限沿用）。**不帶 `-i` 會生一個新網址**，
舊網址還活著還跑舊程式碼，家長手上的連結指的是舊的那個。
不帶 `-V` 時 clasp 會自動先建版本再部署，不必自己先 `create-version`。

### 6. 動到權限設定的話

`clasp` 改不了「執行身分」與「誰可以存取」。要改只能進編輯器：
**部署 → 管理部署作業 → 鉛筆圖示**。

---

## 常見錯誤

| 訊息／症狀 | 對策 |
|---|---|
| `npm error could not determine executable to run` | 你打了 `npx clasp`。沒有 scope 的 `clasp` 是空殼套件，要 `npx --yes @google/clasp@3.3.0` |
| `Project settings not found.` | 沒帶 `-P gas/.clasp.admin.json`，clasp 在當下目錄找不到 `.clasp.json` |
| `No credentials found.` | 沒登入。`npx --yes @google/clasp@3.3.0 login`，用 `show-authorized-user` 確認 |
| 登入了 `push` 還是失敗、訊息看起來跟權限無關 | 九成是 Apps Script API 沒開：<https://script.google.com/home/usersettings> |
| `Invalid container file type` | `create-script --type` 只認 `docs/forms/sheets/slides`，其餘用 `standalone` |
| `Project file already exists.` | 當下目錄已有 `.clasp.json`，`create-script` 拒絕覆蓋 |
| 改了程式碼線上沒變 | `push` ≠ 部署。跑上面第 5 步 |
| 家長端跑出管理端的回應（或反過來） | 組版放錯目錄，`doGet`／`doPost` 撞名互蓋。跑第 3 步對清單 |
| 前端噴 CORS | `text/plain;charset=utf-8` + `credentials:'omit'` + `redirect:'follow'`，見 `docs/gas-migration.md` §4 |
| 執行時找不到試算表／沒有授權 | ① Script Properties 的 `SHEET_ID` 沒設 ② manifest 的 `oauthScopes` 用了 `spreadsheets.currentonly`，但獨立指令碼走 `openById` 需要完整的 `.../auth/spreadsheets` |
| 換電腦後學生全變「13號」 | 設計如此。姓名只在本機 `localStorage` 的 `cp:names`，重貼名冊即可，事件分數都還在 |

看執行期錯誤：編輯器左側 **執行項目（Executions）**，或
`npx --yes @google/clasp@3.3.0 -P gas/.clasp.admin.json tail-logs`。

---

## 每次部署後必跑的驗收

完整版在 `docs/gas-deploy.md` §9。最低限度這兩條，一條都不能跳：

1. **無痕視窗開管理端 `/exec` → 必須被要求登入**，看不到 `{"ok":true,...}`。
   看得到就是把記分 API 開給全世界了，立刻改權限。
2. **試算表裡搜不到任何真實姓名**（`docs` 工作表的 `classes` 那一列，⌘F 搜學生名）。
