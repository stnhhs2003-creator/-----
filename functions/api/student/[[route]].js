/*
 * 學生端 API（雲端模式才會被打到；CLOUD_ENABLED 目前是 false）。
 *
 * 這支存在的理由跟 parent/[[route]].js 一模一樣，而且是同一個教訓：
 * 學生端原本靠一個下拉選單決定「我是誰」，選誰就看得到誰。
 * 在瀏覽器裡那是「同學順手點開」的問題；一旦資料上了雲端，
 * 那個下拉就等於一支無認證的全班資料 API。
 *
 * 所以這裡照家長那支的形狀做，兩件事寫死在後端：
 *
 *   1. **驗證在伺服器端**。個人代碼跟著名冊（classes doc）走，
 *      前端送什麼身分都不算數，一律拿 code 去比對名冊。
 *   2. **投影在伺服器端**。/me 回傳的事件是 SQL 就篩掉非正向與已撤銷的，
 *      不是撈回前端再過濾——前端過濾的東西，改一下前端就繞過去了；SQL WHERE 不行。
 *
 * 個人代碼不是密碼，這件事也要寫在這裡免得後人誤會：
 * 它擋的是「隔壁同學順手點開」，所以不雜湊、不鎖定重試、不發 session。
 * 每次呼叫都把碼帶上、每次都重驗，簡單而且沒有「session 被偷」這種狀態要管。
 * 真正該當機密的東西（老師後台、全班資料）走的是 Google 登入那條線，不是這條。
 *
 * 公開／不公開的分界跟前端一致：
 *   GET  /rank            已停用，固定回 410。
 *   POST /me              要代碼。個人成長、點數餘額。
 *   POST /redeem-request  要代碼。用別人的名義送申請等於替別人花掉點數。
 */

import { json, readDoc, tursoClient } from '../data/[[route]].js';
// 代碼比對只有一份實作，前端後端共用——兩份遲早會有一邊改了另一邊沒改。
// 這個檔案的上半段是純函式，沒有 import、不碰 DOM，在 Worker 裡載得動。
import { findStudentByCode } from '../../../js/codes.js';
import { isOptedOut } from '../../../js/optout.js';

/** 老師的公開代號 → teacher_id。這組代號只用來認班，本身不是通行證。 */
async function teacherOfPublicId(db, publicId) {
  if (!publicId) return null;
  const rows = await db.execute('SELECT teacher_id FROM teacher_public WHERE public_id = ?', [
    publicId,
  ]);
  return rows.length ? rows[0].teacher_id : null;
}

/**
 * 認人。認不出來一律回同一句話、同一個狀態碼——
 * 「沒這個座號」跟「碼打錯」分開講，等於送同學一支代碼探測器。
 */
async function verify(db, teacherId, body) {
  const classes = await readDoc(db, teacherId, 'classes');
  const hit = findStudentByCode(classes, {
    classId: body.classId,
    studentId: body.studentId,
    no: body.no,
    code: body.code,
  });
  // 不參與記錄的學生一律認不出來，回的是跟「碼打錯」同一句話。
  // 分開講就等於送同學一支探測器——「這個人存在但不參與」本身也是資訊。
  if (hit && isOptedOut(hit.student)) return null;
  return hit;
}

/**
 * 這位學生的正向事件。正向、未撤銷——條件寫在 SQL 裡，
 * 這一層之後沒有任何地方能把待改進的紀錄放進回應。
 */
async function positiveEvents(db, teacherId, studentId) {
  return db.execute(
    'SELECT id, ts, behavior_id AS behaviorId, delta, period' +
      " FROM events WHERE teacher_id = ? AND student_id = ? AND kind = 'positive' AND voided = 0" +
      ' ORDER BY ts ASC, id ASC',
    [teacherId, studentId],
  );
}

/**
 * 餘額。用 SUM 在資料庫裡算完，只把一個數字送出去——
 * 把逐筆事件撈回前端再加總，等於把待改進的明細一起送出去了。
 */
async function balanceOf(db, teacherId, studentId) {
  const rows = await db.execute(
    'SELECT COALESCE(SUM(delta), 0) AS net FROM events' +
      ' WHERE teacher_id = ? AND student_id = ? AND voided = 0',
    [teacherId, studentId],
  );
  return Number(rows[0]?.net) || 0;
}

/** 尚未處理的兌換申請（delta 為 0，核可時才真的扣點）。 */
async function pendingRequests(db, teacherId, studentId) {
  return db.execute(
    'SELECT id, ts, behavior_id AS behaviorId, note FROM events' +
      " WHERE teacher_id = ? AND student_id = ? AND kind = 'redeem-request' AND voided = 0" +
      ' ORDER BY ts ASC, id ASC',
    [teacherId, studentId],
  );
}

function eventId() {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return Date.now().toString(36) + [...buf].map((b) => b.toString(36)).join('').slice(0, 8);
}

// ---- 路由分派 ----

export async function handleStudent(request, env, db) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/student/, '').replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();

  try {
    const body = method === 'POST' ? await request.json().catch(() => ({})) : {};
    const publicId = url.searchParams.get('t') || body.t || '';
    const teacherId = await teacherOfPublicId(db, publicId);
    if (!teacherId) {
      return json({ error: '這個連結認不出是哪一班，請跟老師要一次新的連結。' }, 404);
    }

    // 公開姓名排行會揭露學生表現與負分，永久關閉舊端點。
    if (method === 'GET' && path === '/rank') {
      return json({ error: '公開班級排行已停用，以保護學生姓名與表現資料。' }, 410);
    }

    // ---- 以下都要代碼 ----

    if (method === 'POST' && path === '/me') {
      const hit = await verify(db, teacherId, body);
      if (!hit) return json({ error: '座號跟代碼對不起來，再確認一次。' }, 403);

      const [events, balance, pending, behaviors] = await Promise.all([
        positiveEvents(db, teacherId, hit.student.id),
        balanceOf(db, teacherId, hit.student.id),
        pendingRequests(db, teacherId, hit.student.id),
        readDoc(db, teacherId, 'behaviors'),
      ]);

      return json({
        cls: { id: hit.cls.id, name: hit.cls.name },
        student: { id: hit.student.id, no: hit.student.no, name: hit.student.name },
        balance,
        // 只送正向卡的字。連行為卡清單都先篩過，前端就沒有東西可以「不小心」顯示出來。
        behaviors: (behaviors || []).filter((b) => b.kind === 'positive'),
        pending: pending.map((p) => ({ id: p.id, ts: p.ts, name: p.note || '獎勵' })),
        events: events.map((e) => ({
          id: e.id,
          ts: e.ts,
          behaviorId: e.behaviorId,
          delta: Number(e.delta) || 0,
          period: e.period || '',
          // 後端已經只送正向、未撤銷的資料；補這兩個欄位是為了讓前端可以
          // 照樣把整包丟給 shop-core.js 的純函式，維持「只有一個投影閘門」。
          kind: 'positive',
          studentId: hit.student.id,
          voided: false,
        })),
      });
    }

    if (method === 'POST' && path === '/redeem-request') {
      const hit = await verify(db, teacherId, body);
      if (!hit) return json({ error: '座號跟代碼對不起來，再確認一次。' }, 403);

      const rewards = await readDoc(db, teacherId, 'rewards');
      const reward = (rewards || []).find((r) => r.id === body.rewardId && r.active);
      if (!reward) return json({ error: '這項獎勵已經下架了。' }, 404);
      if (reward.stock !== null && reward.stock !== undefined && reward.stock <= 0) {
        return json({ error: '這項獎勵已經被換完了。' }, 409);
      }

      /*
       * 可動用點數 = 餘額 − 已送出但還沒處理的申請所需點數。
       * 申請事件 delta 是 0，不先扣起來的話學生可以無限連按送申請——
       * 這一段一定要在後端算：前端算的版本，關掉 JS 就繞過去了。
       */
      const balance = await balanceOf(db, teacherId, hit.student.id);
      const pending = await pendingRequests(db, teacherId, hit.student.id);
      const held = pending.reduce(
        (s, p) => s + ((rewards || []).find((r) => r.id === p.behaviorId)?.cost || 0),
        0,
      );
      const avail = balance - held;
      if (avail < reward.cost) {
        return json({ error: `點數不夠，還差 ${reward.cost - avail} 點。` }, 409);
      }

      await db.execute(
        'INSERT INTO events (teacher_id, id, ts, class_id, student_id, behavior_id, delta, kind, period, note, voided)' +
          " VALUES (?, ?, ?, ?, ?, ?, 0, 'redeem-request', '', ?, 0)",
        [
          teacherId,
          eventId(),
          new Date().toISOString(),
          hit.cls.id,
          hit.student.id,
          reward.id,
          reward.name,
        ],
      );
      return json({ ok: true, name: reward.name });
    }

    return json({ error: `不認得的路徑：${method} ${path}` }, 404);
  } catch (err) {
    return json({ error: err.message || '伺服器錯誤' }, 500);
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
  return handleStudent(request, env, db);
}
