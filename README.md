# 班級積分堂 · 一鍵安裝範本

點座位表上的學生，一鍵記下行為與積分。積分、行為紀錄、告急提醒三合一，
**資料存在你自己的 Google 試算表裡**，不經過任何第三方伺服器。

這是可以直接拿去用的範本。按下 GitHub 的 **Use this template**，
跑一次 `npm run setup`，就會裝成「你的」班級積分堂。

---

## 這套東西長什麼樣

| 端 | 誰用 | 看得到什麼 |
|---|---|---|
| 老師端 | 只有你（用 Google 登入擋） | 座位表點名記分、名冊、行為卡、積分商店、期末文字工具 |
| 學生端 | 學生輸入個人代碼 | 自己的正向紀錄與點數；**看不到**待改進明細，也沒有排行榜 |
| 家長端 | 家長輸入家長代碼 | 只看得到孩子的正向紀錄 |

三端的界線在後端就切好了（`gas/Public.gs` 只回投影過的資料），不是靠前端藏起來。

### 設計主軸：事件流是唯一真相

系統不存「小明有 35 分」這個數字，只存一連串事件：

```
2026-09-01 10:23  七年三班  小明  主動發言  +2  第2節
2026-09-01 10:41  七年三班  小明  未帶用品  -1  第2節
```

分數、趨勢、告急提醒、期末評語草稿，全都是同一份事件流的不同投影。
撤銷是補一筆撤銷事件，不是把原紀錄擦掉——事後要查得回來。

### 姓名不進試算表

試算表裡只有座號，**學生姓名只存在你操作的那台裝置的瀏覽器**。
好處是雲端那份檔案外洩也不會直接對應到人；代價是換裝置會只看到座號，
要用「備份與還原」把名單帶過去。這個取捨在網站的「使用說明」第七段有寫給老師看的版本。

---

## 安裝

### 你需要準備

- 一個 Google 帳號（老師本人的）
- Node.js 18 以上
- 大約 20 分鐘

### 步驟

**1. 取得程式碼**

在 GitHub 按 **Use this template → Create a new repository**，再 clone 下來。

**2. 登入 clasp**（Google 官方的 Apps Script 命令列工具）

```bash
npx -y @google/clasp@3.3.0 login
```

**3. 跑安裝腳本**

```bash
npm run setup
```

它會問你三件事、然後把剩下的做完：

| 它會問 | 哪裡拿 |
|---|---|
| 你的 Google 信箱 | 老師本人的。只有這個帳號打得開管理端 |
| 試算表 ID | 開 https://sheets.new 建一份空白試算表，網址中間那一段 |
| OAuth Client ID | Google Cloud → API 和服務 → 憑證 → 建立 OAuth 用戶端（網頁應用程式） |

接著它會自動：建兩個 Apps Script 專案 → 上傳程式碼 → 部署 →
把兩個網址與 Client ID 寫回 `js/config.js`。

**4. 中途它會停下來，請你到瀏覽器裡按兩次「執行」**

這一步 Google 規定一定要人工：Apps Script 的授權同意畫面沒辦法用指令跳過。
腳本會把兩個編輯器網址印給你，照著做就好（會看到「進階 → 前往（不安全）」，
那是因為這是你自己寫的程式、沒送 Google 審核，不是有問題）。

**5. 部署網站**

純靜態站，沒有建置流程。整個資料夾丟上去即可：

```bash
# Cloudflare Pages
npx wrangler pages deploy . --project-name=你的專案名 --branch=main

# 或 Netlify
npx netlify deploy --prod --dir=.
```

**6. 回頭補一件事**

網站有正式網址之後，回 Google Cloud 的 OAuth 用戶端，
把那個網址加進「**已授權的 JavaScript 來源**」。
沒加的話，在手機上會登不進去，而且錯誤訊息不會告訴你原因。

### 重跑安全

`npm run setup` 可以重跑。已經建好的 Apps Script 專案不會重建，
部署也會沿用同一個 ID（網址不變），只是把程式碼重推一次。
第一次沒填 Client ID 的話，之後補跑一次就會補上。

---

## 只有兩件事一定要人工

其他全部自動化了。這兩件不行，因為 Google 就是不讓程式代勞：

1. **在 Google Cloud 建 OAuth 用戶端**（要在網頁上按幾個鈕）
2. **在 Apps Script 編輯器點一次「執行」走完授權**（要人親自同意授權）

任何說能繞過這兩步的做法，繞的是安全機制，不要用。

---

## 為什麼是兩個 Apps Script 專案

一個專案只有一組 `doPost`。老師端（要驗身分）跟家長學生端（匿名可存取）
如果放在同一支裡，匿名那份會把管理操作一起分派出去——這不是設定問題，是結構問題。
所以拆成兩個：

- **管理端** `gas/Code.gs` + `gas/Auth.gs`：所有寫入，每一筆都驗 Google ID token
- **家長學生端** `gas/Public.gs`：只讀，只回投影過的資料，用個人代碼認人

細節在 `docs/gas-deploy.md`。

---

## 測試

```bash
npm test
```

守的是界線不是畫面：家長端過濾、學生端權限、匯入、稽核、商店把關。
`gas/public-selftest.mjs` 另外用假的 Apps Script 沙盒驗公開端的紅線
（家長只拿得到正向、學生拿不到待改進明細、排行榜一律 410）。

---

## 檔案結構

```
index.html             老師主畫面：記錄／補登稽核／儀表板
roster.html            班級名冊與座位設定
behaviors.html         行為卡編輯
rewards.html           積分商店與兌換審核
codes.html             個人代碼發放與列印
student.html           學生端（輸入代碼）
parent.html            家長端（輸入代碼）
guide.html             給老師看的使用說明
privacy.html           隱私說明

gas/Store.gs           試算表存取層（兩個專案共用）
gas/Code.gs            管理端路由
gas/Auth.gs            ID token 驗證
gas/Public.gs          家長學生端投影（紅線在這裡）

js/config.js           setup 腳本會寫這一支
js/rules.js            投影層：分數、趨勢、告急、家長端過濾（純函式）
js/shop-core.js        商店純函式：餘額、核可把關

scripts/setup.mjs      安裝腳本
tests/*.test.mjs       node:test
```

## 本機執行

用了 ES module，要用 HTTP 開，不能雙擊 `index.html`：

```bash
npm run dev          # http://localhost:8899
```

要模擬正式站的無副檔名網址與安全標頭，改用 `npx wrangler pages dev .`。

## 授權

MIT。拿去改、拿去用，不用問。
