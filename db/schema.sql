-- 班級積分堂 · Turso（libSQL）資料表
--
-- 兩張表就夠：events 是事件流（唯一真相），docs 放整包 JSON 的設定類資料。
-- 之所以不把 classes／behaviors／rewards 拆成關聯表，是因為上層只會整包讀寫，
-- 拆表只會在改一張行為卡時多出一堆同步問題，換不到任何查詢能力。
--
-- teacher_id 是所有表的第一段主鍵：一位老師一份資料，隔離靠主鍵而非靠程式記得加 WHERE。

CREATE TABLE IF NOT EXISTS events (
  teacher_id  TEXT    NOT NULL,
  id          TEXT    NOT NULL,
  ts          TEXT    NOT NULL,
  class_id    TEXT    NOT NULL DEFAULT '',
  student_id  TEXT    NOT NULL DEFAULT '',
  behavior_id TEXT    NOT NULL DEFAULT '',
  delta       INTEGER NOT NULL DEFAULT 0,
  -- positive / improve / redeem-request / redeem
  kind        TEXT    NOT NULL,
  period      TEXT    NOT NULL DEFAULT '',
  note        TEXT    NOT NULL DEFAULT '',
  -- 撤銷是標記，不是刪除：稽核頁要查得到「這筆被撤銷過」，
  -- 所以這張表只會 INSERT 與這一欄的 UPDATE，永遠不 DELETE 單筆事件。
  voided      INTEGER NOT NULL DEFAULT 0,
  voided_at   TEXT,
  PRIMARY KEY (teacher_id, id)
);

-- 稽核頁與儀表板一律「先限老師、再限班級或學生、再限時間區間」，
-- 索引順序照著這個查詢形狀排，篩選才進得了索引而不是全表掃。
CREATE INDEX IF NOT EXISTS idx_events_teacher_ts
  ON events (teacher_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_teacher_class_ts
  ON events (teacher_id, class_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_teacher_student_ts
  ON events (teacher_id, student_id, ts);

-- 家長綁定。
--
-- 家長端不再靠「知道網址就看得到」。家長要用 Google 登入、輸入老師發的通過碼、
-- 指名孩子的座號與姓名，產生一筆 pending，老師在後台按過核可才會生效。
-- 通過碼外流頂多多幾筆待核可的申請——沒有老師點頭，誰都看不到東西。
--
-- 主鍵是 (teacher_id, parent_sub, student_id)：同一個家長帳號可以綁多個孩子
-- （兄弟姊妹同校），但同一組不會重複。parent_sub 是 Google 帳號的 sub。
CREATE TABLE IF NOT EXISTS parent_bindings (
  teacher_id TEXT NOT NULL,
  parent_sub TEXT NOT NULL,
  student_id TEXT NOT NULL,
  class_id   TEXT NOT NULL DEFAULT '',
  email      TEXT NOT NULL DEFAULT '',
  -- pending / approved / rejected / revoked
  status     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  PRIMARY KEY (teacher_id, parent_sub, student_id)
);

-- 後台的待核可清單就是照這個形狀查的。
CREATE INDEX IF NOT EXISTS idx_bindings_teacher_status
  ON parent_bindings (teacher_id, status, created_at);

-- 家長連結裡不放老師的 Google sub，改放一組隨機的公開代號。
-- 這組代號只用來認出「這是哪位老師的班」，本身不是通行證。
CREATE TABLE IF NOT EXISTS teacher_public (
  public_id  TEXT NOT NULL PRIMARY KEY,
  teacher_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS docs (
  teacher_id TEXT NOT NULL,
  -- classes / behaviors / rewards / settings
  name       TEXT NOT NULL,
  json       TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (teacher_id, name)
);
