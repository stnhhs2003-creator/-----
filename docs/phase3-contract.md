# 跨期基礎建設：四條線的分工契約

這一輪要做的是 `ROADMAP.md` 的 B.3 → B.1 → B.2 → B.4，讓資料能離開單一台裝置。
四條線平行開發，靠這份契約避免互踩。

## 鐵則

1. **只新增自己名下的檔案。** 需要改別人的檔案或共用檔案，寫在回報裡，由主線統一改。
2. **`CLOUD_ENABLED` 維持 `false`。** 雲端程式碼可以寫、可以測，但不准打開開關，
   也不准部署到會真的存學生姓名的地方——那要等 B.3 的盤點結論與老師點頭。
3. **金鑰只進環境變數**，不進程式碼、不進 git、不貼進對話。
4. 完成後回報要能被驗證：實際指令輸出、實際頁面行為。自我宣稱不算數。

## 已經鋪好的整合點（不要改，直接用）

| 檔案 | 用途 |
|---|---|
| `js/config.js` | `CLOUD_ENABLED`、`GOOGLE_CLIENT_ID`、API 路徑前綴 |
| `js/store-select.js` | 六個頁面都只 import 這裡的 `store`；雲端開了才會動態載入 `js/store-cloud.js` |
| `functions/_lib/session.js` | `requireTeacher(request, env)` 的 stub，B.2 負責換成真的 |

## 儲存層介面（`js/store.js` 的 `LocalStore` 就是參考實作）

```
init(seed)
appendEvent({classId, studentId, behaviorId, delta, kind, period, note}) -> event
voidEvent(id) -> event
queryEvents({classId, studentId, since, until, includeVoided}) -> event[]
getClasses/saveClasses, getBehaviors/saveBehaviors,
getRewards/saveRewards, getSettings/saveSettings
exportAll() -> {exportedAt, classes, behaviors, rewards, events, settings}
resetAll()
```

事件物件的欄位：`id, ts, classId, studentId, behaviorId, delta, kind, period, note, voided, voidedAt?`
`kind` 有四種：`positive` / `improve` / `redeem-request` / `redeem`。

## 四條線

| 線 | 範圍 | 名下檔案 |
|---|---|---|
| B.3 個資盤點 | 盤點蒐集了哪些個資、法源、保存期限、家長告知、風險與對策 | `docs/privacy-review.md`、`privacy.html` |
| B.1 Turso 儲存層 | 同介面的雲端實作 + 資料 API | `js/store-cloud.js`、`functions/api/data/[[route]].js`、`db/schema.sql` |
| B.2 Google 登入 | 登入流程與 session | `login.html`、`js/auth.js`、`functions/api/auth/[[route]].js`、正式版 `functions/_lib/session.js` |
| B.4 匯入／匯出 | 整份資料匯出與匯回、備援 | `backup.html`、`js/backup.js`、`tests/backup.test.mjs` |

## API 命名空間

- `/api/auth/*` 屬於 B.2
- `/api/data/*` 屬於 B.1

兩邊都用 `requireTeacher()` 取得 `teacherId`，資料一律以 `teacherId` 隔離。

## 環境變數名稱（先講好，之後才不用改程式）

```
TURSO_DATABASE_URL
TURSO_AUTH_TOKEN
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
SESSION_SECRET
DEV_TEACHER_ID     # 只在本機開發用，正式環境不得設定
```
