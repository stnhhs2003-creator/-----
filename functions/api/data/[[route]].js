/*
 * 資料 API（B.1）。前端的 CloudStore 只跟這裡講話。
 *
 * 兩個刻意的設計：
 * 1. 資料庫存取抽成 `db.execute(sql, args) -> rows[]` 這個窄介面，
 *    handleData 完全不知道對面是 Turso 還是別的東西——測試才能不打網路就驗 SQL。
 * 2. teacherId 一律由 requireTeacher() 決定，絕不從 body 或 query 讀。
 *    只要有一條路徑讓呼叫端自己指定 teacherId，隔離就等於沒做。
 */

import { requireTeacher, Unauthorized } from '../../_lib/session.js';
import { canRecord } from '../../../js/optout.js';

const DOC_NAMES = ['classes', 'behaviors', 'rewards', 'settings'];

/** 設定類資料的預設值：settings 是物件，其餘是陣列。 */
function docFallback(name) {
  return name === 'settings' ? {} : [];
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // 這是老師的個人資料，任何一層快取都不該留下副本。
      'cache-control': 'no-store',
    },
  });
}

// ---- Turso（libSQL）HTTP 客戶端 ----

/** libSQL 的參數要標型別；整數必須以字串傳，否則大整數會在 JSON 裡失真。 */
function toArg(value) {
  if (value === null || value === undefined) return { type: 'null', value: null };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { type: 'integer', value: String(value) }
      : { type: 'float', value };
  }
  if (typeof value === 'boolean') return { type: 'integer', value: value ? '1' : '0' };
  return { type: 'text', value: String(value) };
}

function fromCell(cell) {
  if (!cell || cell.type === 'null') return null;
  if (cell.type === 'integer') return Number(cell.value);
  if (cell.type === 'float') return Number(cell.value);
  return cell.value;
}

export function tursoClient(env) {
  const url = env && env.TURSO_DATABASE_URL;
  const token = env && env.TURSO_AUTH_TOKEN;
  if (!url || !token) {
    throw new Error('雲端儲存尚未完成設定，請由網站管理者檢查服務狀態。');
  }
  // Turso 給的連線字串是 libsql://，HTTP API 要走 https://。
  const endpoint = url.replace(/^libsql:\/\//, 'https://').replace(/\/+$/, '') + '/v2/pipeline';

  return {
    async execute(sql, args = []) {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          requests: [
            { type: 'execute', stmt: { sql, args: args.map(toArg) } },
            { type: 'close' },
          ],
        }),
      });
      if (!res.ok) {
        throw new Error(`Turso HTTP ${res.status}：${await res.text()}`);
      }
      const body = await res.json();
      const first = (body.results || [])[0];
      if (!first || first.type === 'error') {
        throw new Error(`Turso 執行失敗：${(first && first.error && first.error.message) || '未知錯誤'}`);
      }
      const result = first.response.result;
      const cols = (result.cols || []).map((c) => c.name);
      return (result.rows || []).map((row) => {
        const obj = {};
        row.forEach((cell, i) => {
          obj[cols[i]] = fromCell(cell);
        });
        return obj;
      });
    },
  };
}

// ---- 查詢組裝 ----

/**
 * queryEvents 的 SQL。篩選條件全部下推到 WHERE，
 * 不把整份事件撈回 Worker 再過濾——一個班一學期幾千筆，撈回來過濾遲早會炸。
 */
export function eventsQuery(teacherId, opts = {}) {
  const { classId, studentId, since, until, includeVoided = false } = opts;
  const where = ['teacher_id = ?'];
  const args = [teacherId];

  if (!includeVoided) where.push('voided = 0');
  if (classId) {
    where.push('class_id = ?');
    args.push(classId);
  }
  if (studentId) {
    where.push('student_id = ?');
    args.push(studentId);
  }
  if (since) {
    where.push('ts >= ?');
    args.push(since);
  }
  if (until) {
    where.push('ts <= ?');
    args.push(until);
  }

  const sql =
    'SELECT id, ts, class_id AS classId, student_id AS studentId,' +
    ' behavior_id AS behaviorId, delta, kind, period, note,' +
    ' voided, voided_at AS voidedAt' +
    ' FROM events WHERE ' +
    where.join(' AND ') +
    // ts 相同時（同一秒批次記錄多人）用 id 收斂，避免同一組資料每次順序不同。
    ' ORDER BY ts ASC, id ASC';

  return { sql, args };
}

/** SQLite 沒有布林型別，出了資料庫就要還原成介面講好的樣子。 */
export function rowToEvent(row) {
  const evt = {
    id: row.id,
    ts: row.ts,
    classId: row.classId || '',
    studentId: row.studentId || '',
    behaviorId: row.behaviorId || '',
    delta: Number(row.delta) || 0,
    kind: row.kind,
    period: row.period || '',
    note: row.note || '',
    voided: !!row.voided,
  };
  if (row.voidedAt) evt.voidedAt = row.voidedAt;
  return evt;
}

// ---- 各路由 ----

export async function readDoc(db, teacherId, name) {
  const rows = await db.execute('SELECT json FROM docs WHERE teacher_id = ? AND name = ?', [
    teacherId,
    name,
  ]);
  if (!rows.length) return docFallback(name);
  try {
    return JSON.parse(rows[0].json);
  } catch {
    return docFallback(name);
  }
}

export async function writeDoc(db, teacherId, name, value) {
  await db.execute(
    'INSERT INTO docs (teacher_id, name, json, updated_at) VALUES (?, ?, ?, ?)' +
      ' ON CONFLICT (teacher_id, name) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at',
    [teacherId, name, JSON.stringify(value ?? docFallback(name)), new Date().toISOString()],
  );
}

/**
 * 首次進站鋪示範資料。用 INSERT ... ON CONFLICT DO NOTHING，
 * 因為老師可能同時開兩個分頁，init 必須是「已有就不動」而不是「覆蓋」。
 */
async function initSeed(db, teacherId, seed = {}) {
  const now = new Date().toISOString();
  for (const name of DOC_NAMES) {
    const value = seed[name] ?? docFallback(name);
    await db.execute(
      'INSERT INTO docs (teacher_id, name, json, updated_at) VALUES (?, ?, ?, ?)' +
        ' ON CONFLICT (teacher_id, name) DO NOTHING',
      [teacherId, name, JSON.stringify(value), now],
    );
  }
  for (const evt of seed.events || []) {
    await insertEvent(db, teacherId, evt, evt.id, evt.ts);
  }
  return { ok: true };
}

async function insertEvent(db, teacherId, input, id, ts) {
  const evt = {
    id: id || uid(),
    ts: ts || new Date().toISOString(),
    classId: input.classId || '',
    studentId: input.studentId || '',
    behaviorId: input.behaviorId || '',
    delta: Number(input.delta) || 0,
    kind: input.kind,
    period: input.period || '',
    note: input.note || '',
    voided: false,
  };
  await db.execute(
    'INSERT INTO events (teacher_id, id, ts, class_id, student_id, behavior_id, delta, kind, period, note, voided)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)' +
      // 重送同一筆（網路重試）不該變成兩筆分數。
      ' ON CONFLICT (teacher_id, id) DO NOTHING',
    [
      teacherId,
      evt.id,
      evt.ts,
      evt.classId,
      evt.studentId,
      evt.behaviorId,
      evt.delta,
      evt.kind,
      evt.period,
      evt.note,
    ],
  );
  return evt;
}

async function voidEvent(db, teacherId, id) {
  // 只改旗標，不 DELETE：撤銷本身也是要留下來的事實。
  await db.execute(
    'UPDATE events SET voided = 1, voided_at = ? WHERE teacher_id = ? AND id = ? AND voided = 0',
    [new Date().toISOString(), teacherId, id],
  );
  const rows = await db.execute(
    'SELECT id, ts, class_id AS classId, student_id AS studentId,' +
      ' behavior_id AS behaviorId, delta, kind, period, note,' +
      ' voided, voided_at AS voidedAt' +
      ' FROM events WHERE teacher_id = ? AND id = ?',
    [teacherId, id],
  );
  return rows.length ? rowToEvent(rows[0]) : null;
}

async function exportAll(db, teacherId) {
  const { sql, args } = eventsQuery(teacherId, { includeVoided: true });
  const rows = await db.execute(sql, args);
  const [classes, behaviors, rewards, settings] = await Promise.all(
    DOC_NAMES.map((n) => readDoc(db, teacherId, n)),
  );
  return {
    exportedAt: new Date().toISOString(),
    classes,
    behaviors,
    rewards,
    events: rows.map(rowToEvent),
    settings,
  };
}

/**
 * 整份還原。事件的 id、ts、voided 全部照備份檔原樣寫回——
 * 重編號等於偽造一份新的歷史，匯出的檔案就再也對不回原本那一份。
 * 先清空自己的資料再寫，避免半新半舊。
 */
async function importAll(db, teacherId, payload) {
  const events = Array.isArray(payload?.events) ? payload.events : [];
  await db.execute('DELETE FROM events WHERE teacher_id = ?', [teacherId]);
  await db.execute('DELETE FROM docs WHERE teacher_id = ?', [teacherId]);

  for (const e of events) {
    await db.execute(
      'INSERT INTO events (teacher_id, id, ts, class_id, student_id, behavior_id, delta, kind, period, note, voided, voided_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)' +
        ' ON CONFLICT (teacher_id, id) DO NOTHING',
      [
        teacherId,
        e.id,
        e.ts,
        e.classId || '',
        e.studentId || '',
        e.behaviorId || '',
        Number(e.delta) || 0,
        e.kind,
        e.period || '',
        e.note || '',
        e.voided ? 1 : 0,
        e.voidedAt || null,
      ],
    );
  }

  await Promise.all(DOC_NAMES.map((n) => writeDoc(db, teacherId, n, payload?.[n] ?? (n === 'settings' ? {} : []))));
  return { ok: true, events: events.length };
}

// ---- 路由分派 ----

/**
 * 核心處理函式。db 由外面注入，正式環境是 tursoClient(env)，測試是記憶體資料庫。
 */
export async function handleData(request, env, db) {
  let teacherId;
  try {
    ({ teacherId } = await requireTeacher(request, env));
  } catch (err) {
    if (err instanceof Unauthorized || err.status === 401) {
      return json({ error: err.message }, 401);
    }
    throw err;
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/data/, '').replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();
  const seg = path.split('/').filter(Boolean);

  try {
    if (method === 'GET' && path === '/events') {
      const q = url.searchParams;
      const { sql, args } = eventsQuery(teacherId, {
        classId: q.get('classId') || undefined,
        studentId: q.get('studentId') || undefined,
        since: q.get('since') || undefined,
        until: q.get('until') || undefined,
        includeVoided: q.get('includeVoided') === '1',
      });
      const rows = await db.execute(sql, args);
      return json(rows.map(rowToEvent));
    }

    if (method === 'POST' && path === '/events') {
      const body = await request.json();
      // 不參與記錄的閘門在伺服器端也要有一份。前端那道對「繞過 UI 直接打
      // 這支 API」的請求無效，而個資權利不能靠對方乖乖用我們的畫面。
      const classes = await readDoc(db, teacherId, 'classes');
      const gate = canRecord(classes || [], {
        classId: body.classId,
        studentId: body.studentId,
      });
      if (!gate.ok) return json({ error: gate.reason }, 403);
      return json(await insertEvent(db, teacherId, body));
    }

    if (method === 'POST' && seg[0] === 'events' && seg[2] === 'void') {
      const evt = await voidEvent(db, teacherId, decodeURIComponent(seg[1]));
      return evt ? json(evt) : json({ error: '找不到這筆事件' }, 404);
    }

    if (seg[0] === 'doc' && DOC_NAMES.includes(seg[1])) {
      if (method === 'GET') return json(await readDoc(db, teacherId, seg[1]));
      if (method === 'PUT') {
        await writeDoc(db, teacherId, seg[1], await request.json());
        return json({ ok: true });
      }
    }

    if (method === 'POST' && path === '/init') {
      const body = await request.json().catch(() => ({}));
      return json(await initSeed(db, teacherId, body.seed || {}));
    }

    if (method === 'GET' && path === '/export') {
      return json(await exportAll(db, teacherId));
    }

    /*
     * 刪除。這是除了 /reset 之外，唯一會真的 DELETE 事件的地方。
     * 對應個資法第 11 條第 3 項「特定目的消失應主動刪除」——
     * 跟 voidEvent 的稽核語意無關，那個是「記錯了」，這個是「目的沒了」。
     * 範圍一律限在自己的 teacher_id。
     */
    if (method === 'POST' && path === '/purge/student') {
      const body = await request.json();
      if (!body.classId || !body.studentId) {
        return json({ error: '要刪哪一位學生沒講清楚，不動手。' }, 400);
      }
      const before = await db.execute(
        'SELECT COUNT(*) AS n FROM events WHERE teacher_id = ? AND class_id = ? AND student_id = ?',
        [teacherId, body.classId, body.studentId],
      );
      await db.execute(
        'DELETE FROM events WHERE teacher_id = ? AND class_id = ? AND student_id = ?',
        [teacherId, body.classId, body.studentId],
      );
      // 學生資料刪了，家長的查看權限也不該留著。
      await db.execute('DELETE FROM parent_bindings WHERE teacher_id = ? AND student_id = ?', [
        teacherId,
        body.studentId,
      ]);
      return json({ deleted: Number(before[0]?.n) || 0 });
    }

    if (method === 'POST' && path === '/purge/class') {
      const body = await request.json();
      if (!body.classId) return json({ error: '要刪哪一班沒講清楚，不動手。' }, 400);
      const before = await db.execute(
        'SELECT COUNT(*) AS n FROM events WHERE teacher_id = ? AND class_id = ?',
        [teacherId, body.classId],
      );
      await db.execute('DELETE FROM events WHERE teacher_id = ? AND class_id = ?', [
        teacherId,
        body.classId,
      ]);
      await db.execute('DELETE FROM parent_bindings WHERE teacher_id = ? AND class_id = ?', [
        teacherId,
        body.classId,
      ]);
      return json({ deleted: Number(before[0]?.n) || 0 });
    }

    if (method === 'POST' && path === '/import') {
      const body = await request.json();
      return json(await importAll(db, teacherId, body));
    }

    if (method === 'POST' && path === '/reset') {
      // 這是老師本人按下的「清空重來」，跟 voidEvent 的稽核語意無關，
      // 對應 LocalStore 的 resetAll；範圍嚴格限在自己的 teacher_id。
      await db.execute('DELETE FROM events WHERE teacher_id = ?', [teacherId]);
      await db.execute('DELETE FROM docs WHERE teacher_id = ?', [teacherId]);
      return json({ ok: true });
    }

    return json({ error: `不認得的路徑：${method} ${path}` }, 404);
  } catch (err) {
    // 課堂上點了學生卻沒記到，比噴錯還糟——錯誤一定要讓前端看得見。
    return json({ error: err.message || '資料庫錯誤' }, 500);
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  let db;
  try {
    db = tursoClient(env);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
  return handleData(request, env, db);
}
