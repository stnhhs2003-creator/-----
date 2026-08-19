# 第三期 + 學生端驗證：四條線的分工契約

這一輪做 `ROADMAP.md` 的 3.1／3.2／3.3，外加個資盤點剩下的那一項
「學生端下拉選單就能冒充同學」。四條線平行開發，靠這份契約避免互踩。

## 鐵則

1. **只新增自己名下的檔案。** 需要改共用檔案，寫在回報裡，由主線統一改。
2. **`CLOUD_ENABLED` 與 `AI_ENABLED` 都維持 `false`。** 程式可以寫、可以測，
   但開關由老師決定什麼時候打開——`AI_ENABLED` 打開就開始花錢。
3. **金鑰只進環境變數**，不進程式碼、不進 git、不貼進對話。
4. **AI 不是拿來寫東西的，是拿來潤稿的。** 所有輸出都必須先由資料組成完整的
   骨架，AI 關掉時功能照樣完整可用，只是文字生硬一點。任何「沒有 AI 就做不出來」
   的設計都不符合驗收條件。
5. 完成後回報要能被驗證：實際指令輸出、實際頁面行為。自我宣稱不算數。

## 已經鋪好的整合點（不要改，直接用）

| 檔案 | 用途 |
|---|---|
| `js/summarize.js` | `studentFacts()` / `classFacts()`，把事件流整理成事實包 |
| `js/ai-client.js` | `polish(skeleton, facts)`，永不丟錯，失敗一律回骨架 |
| `functions/api/ai/[[route]].js` | 潤稿代理，含數字白名單防虛構 |
| `js/config.js` | `CLOUD_ENABLED`／`AI_ENABLED`／`API` |
| `js/store-select.js` | 所有頁面都只 import 這裡的 `store` |
| `js/rules.js` | `detectAlerts()`／`parentView()`／`expiredClasses()` 等純函式 |
| `functions/_lib/session.js` | `requireTeacher(request, env)` |
| `functions/api/parent/[[route]].js` | 家長綁定 API——**學生驗證那條線請照這個形狀做** |

### `polish()` 怎麼用

```js
import { polish } from './ai-client.js';
const { text, source, notice } = await polish(skeleton, facts);
// source: 'ai' | 'skeleton'；notice 有值就把它顯示給老師看，不要吞掉
```

`facts` 直接傳 `summarize.js` 產生的那包。它同時是**數字白名單**：
潤出來的文字只要出現骨架與事實包都沒有的阿拉伯數字，伺服器會判定虛構、
回 422，前端自動退回骨架。這就是「不得虛構」的機器保證。

## 四條線

| 線 | 範圍 | 名下檔案 |
|---|---|---|
| S1 學生端驗證 | 個人代碼取代下拉選單 | `js/student.js`、`student.html`、`codes.html`、`js/codes.js`、`assets/codes.css`、`functions/api/student/[[route]].js`、`tests/student-gate.test.mjs` |
| S2 學期評語（3.1） | 一位學生一份 150 字評語 | `comments.html`、`js/comments.js`、`assets/comments.css`、`tests/comments.test.mjs` |
| S3 親師溝通草稿（3.2） | 針對特定事件生成聯絡要點 | `contact.html`、`js/contact.js`、`assets/contact.css`、`tests/contact.test.mjs` |
| S4 導師手札週報（3.3） | 每週班級狀況與需關心名單 | `weekly.html`、`js/weekly.js`、`assets/weekly.css`、`tests/weekly.test.mjs` |

主線保留：`index.html`（分頁連結）、`js/summarize.js`、`js/ai-client.js`、
`js/config.js`、`functions/api/ai/*`、`db/schema.sql`、`ROADMAP.md`。

## 環境變數（沿用既有，新增兩個）

```
TURSO_DATABASE_URL / TURSO_AUTH_TOKEN
GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / SESSION_SECRET
DEV_TEACHER_ID     # 只在本機開發用
AI_API_KEY         # 新增：潤稿服務金鑰
AI_MODEL           # 新增：可選，預設 claude-sonnet-5
```

## 共同的驗收底線

- `npm test` 全綠，而且自己那條線的測試要**先確認會紅**（改壞實作驗一次）。
- 頁面在 390px 寬可用——老師很多時候是在手機上處理這些事。
- 任何顯示給家長或學生的文字，不得出現負向行為的明細。
- 產生的文字一律「可複製」而非「自動送出」：老師必須有機會改。
