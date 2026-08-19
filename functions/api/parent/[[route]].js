/*
 * 家長綁定 API。
 *
 * 這支存在的理由，是修掉家長端原本那個洞：連結是 ?s=c701-s5 這種連號，
 * 家長把 s5 改成 s6 就看得到隔壁同學。存在瀏覽器裡的時候無害，
 * 上雲端之後那個網址就是一支無認證的全班資料 API。
 *
 * 現在改成三道關卡，缺一不可：
 *   1. 家長要用 Google 登入（認出是「誰」，不是「誰知道網址」）
 *   2. 要輸入老師發的通過碼，並指名孩子的座號與姓名
 *   3. 老師在後台按過核可
 *
 * 通過碼外流的後果因此只是「多幾筆待核可的申請」，不是資料外洩。
 *
 * 還有一件事比上面三道更重要：**投影在後端做**。
 * /view 回傳的事件是 SQL 就篩掉非正向與已撤銷的結果，
 * 不是撈回前端再過濾——前端過濾的東西，改一下網址就繞過去了。
 */

import { requireTeacher, Unauthorized } from '../../_lib/session.js';
import { json, readDoc, tursoClient } from '../data/[[route]].js';
import { isOptedOut } from '../../../js/optout.js';

const STATUS = ['pending', 'approved', 'rejected', 'revoked'];

function randomId(len = 10) {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => abc[b % abc.length]).join('');
}

/*
 * 通過碼比對。
 * 前後空白與全形數字都先正規化——家長是從 LINE 複製貼上的，
 * 為了一個看不見的空白把人擋在門外，只會讓老師的電話響個不停。
 */
function normalizeCode(v) {
  return String(v ?? '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s/g, '');
}

export function codeMatches(input, expected) {
  const a = normalizeCode(input);
  const b = normalizeCode(expected);
  return !!b && a === b;
}

/**
 * 從座號與姓名找學生。兩個都要對——只憑座號等於讓人一號一號試過去，
 * 姓名是家長本來就知道、外人不見得知道的那一半。
 */
export function findStudent(classes, { classId, no, name }) {
  const wanted = String(name ?? '').trim();
  for (const cls of classes || []) {
    if (classId && cls.id !== classId) continue;
    for (const s of cls.students || []) {
      // 不參與記錄的孩子連綁定都不該綁得起來——綁定是取得查看權的入口。
      if (isOptedOut(s)) continue;
      if (String(s.no) === String(no).trim() && String(s.name).trim() === wanted) {
        return { cls, student: s };
      }
    }
  }
  return null;
}

async function teacherOfPublicId(db, publicId) {
  if (!publicId) return null;
  const rows = await db.execute('SELECT teacher_id FROM teacher_public WHERE public_id = ?', [
    publicId,
  ]);
  return rows.length ? rows[0].teacher_id : null;
}

/** 老師的公開代號：沒有就發一組。這組只用來認班，不是通行證。 */
async function ensurePublicId(db, teacherId) {
  const rows = await db.execute('SELECT public_id FROM teacher_public WHERE teacher_id = ?', [
    teacherId,
  ]);
  if (rows.length) return rows[0].public_id;
  const publicId = randomId();
  await db.execute(
    'INSERT INTO teacher_public (public_id, teacher_id, created_at) VALUES (?, ?, ?)',
    [publicId, teacherId, new Date().toISOString()],
  );
  return publicId;
}

async function bindingsOf(db, teacherId, parentSub) {
  return db.execute(
    'SELECT parent_sub AS parentSub, student_id AS studentId, class_id AS classId,' +
      ' email, status, created_at AS createdAt, decided_at AS decidedAt' +
      ' FROM parent_bindings WHERE teacher_id = ? AND parent_sub = ?',
    [teacherId, parentSub],
  );
}

async function approvedBinding(db, teacherId, parentSub, studentId) {
  const rows = await db.execute(
    'SELECT student_id AS studentId, class_id AS classId FROM parent_bindings' +
      " WHERE teacher_id = ? AND parent_sub = ? AND student_id = ? AND status = 'approved'",
    [teacherId, parentSub, studentId],
  );
  return rows.length ? rows[0] : null;
}

/**
 * 家長看得到的事件。正向、未撤銷——條件寫在 SQL 裡，
 * 這一層之後沒有任何地方能把非正向的資料放進回應。
 */
async function positiveEvents(db, teacherId, studentId) {
  return db.execute(
    'SELECT id, ts, behavior_id AS behaviorId, delta, period' +
      " FROM events WHERE teacher_id = ? AND student_id = ? AND kind = 'positive' AND voided = 0" +
      ' ORDER BY ts ASC, id ASC',
    [teacherId, studentId],
  );
}

// ---- 路由分派 ----

export async function handleParent(request, env, db) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/parent/, '').replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();

  try {
    // ---- 老師端後台：這幾條要老師本人的 session ----
    if (path.startsWith('/admin')) {
      let teacherId;
      try {
        ({ teacherId } = await requireTeacher(request, env));
      } catch (err) {
        if (err instanceof Unauthorized || err.status === 401) {
          return json({ error: err.message }, 401);
        }
        throw err;
      }

      if (method === 'GET' && path === '/admin/bindings') {
        const rows = await db.execute(
          'SELECT parent_sub AS parentSub, student_id AS studentId, class_id AS classId,' +
            ' email, status, created_at AS createdAt, decided_at AS decidedAt' +
            ' FROM parent_bindings WHERE teacher_id = ? ORDER BY created_at DESC',
          [teacherId],
        );
        return json({ publicId: await ensurePublicId(db, teacherId), bindings: rows });
      }

      if (method === 'POST' && path === '/admin/decide') {
        const body = await request.json();
        if (!STATUS.includes(body.status) || body.status === 'pending') {
          return json({ error: '不認得的處理結果' }, 400);
        }
        await db.execute(
          'UPDATE parent_bindings SET status = ?, decided_at = ?' +
            ' WHERE teacher_id = ? AND parent_sub = ? AND student_id = ?',
          [body.status, new Date().toISOString(), teacherId, body.parentSub, body.studentId],
        );
        return json({ ok: true });
      }

      return json({ error: `不認得的路徑：${method} ${path}` }, 404);
    }

    // ---- 家長端：登入的是家長自己的 Google 帳號 ----
    //
    // requireTeacher() 在這裡只被當成「取出目前登入的 Google 使用者」用。
    // 它回傳的 sub 對家長來說就是 parentSub，不代表任何老師權限——
    // 底下每一條都要再查 parent_bindings 才拿得到資料。
    let me;
    try {
      const session = await requireTeacher(request, env);
      me = { sub: session.teacherId, email: session.email };
    } catch (err) {
      if (err instanceof Unauthorized || err.status === 401) {
        return json({ signedIn: false, error: '請先用 Google 登入' }, 401);
      }
      throw err;
    }

    const publicId = url.searchParams.get('t') || '';
    const teacherId = await teacherOfPublicId(db, publicId);

    if (method === 'GET' && path === '/me') {
      if (!teacherId) return json({ signedIn: true, email: me.email, known: false, bindings: [] });
      return json({
        signedIn: true,
        email: me.email,
        known: true,
        bindings: await bindingsOf(db, teacherId, me.sub),
      });
    }

    if (method === 'POST' && path === '/request') {
      const body = await request.json();
      const tid = teacherId || (await teacherOfPublicId(db, body.t));
      if (!tid) return json({ error: '這個連結認不出是哪一班，請跟老師要一次新的連結。' }, 404);

      const settings = await readDoc(db, tid, 'settings');
      if (!codeMatches(body.code, settings.parentCode)) {
        return json({ error: '通過碼不正確，請再確認一次老師給的號碼。' }, 403);
      }

      const classes = await readDoc(db, tid, 'classes');
      const hit = findStudent(classes, { classId: body.classId, no: body.no, name: body.name });
      if (!hit) {
        return json({ error: '座號與姓名對不起來，請再確認一次。' }, 404);
      }

      const now = new Date().toISOString();
      await db.execute(
        'INSERT INTO parent_bindings (teacher_id, parent_sub, student_id, class_id, email, status, created_at)' +
          " VALUES (?, ?, ?, ?, ?, 'pending', ?)" +
          // 重送申請不該把已核可的那筆打回 pending，也不該冒出第二筆。
          ' ON CONFLICT (teacher_id, parent_sub, student_id) DO NOTHING',
        [tid, me.sub, hit.student.id, hit.cls.id, me.email, now],
      );

      const rows = await bindingsOf(db, tid, me.sub);
      return json({ ok: true, bindings: rows });
    }

    if (method === 'GET' && path === '/view') {
      if (!teacherId) return json({ error: '這個連結認不出是哪一班。' }, 404);
      const studentId = url.searchParams.get('s') || '';
      const binding = await approvedBinding(db, teacherId, me.sub, studentId);
      // 沒核可就是沒核可。這裡不透露「有這個學生但你沒權限」還是「根本沒這個人」。
      if (!binding) return json({ error: '這個帳號還沒有被老師核可查看這位學生。' }, 403);

      const [classes, behaviors] = await Promise.all([
        readDoc(db, teacherId, 'classes'),
        readDoc(db, teacherId, 'behaviors'),
      ]);
      const cls = (classes || []).find((c) => c.id === binding.classId);
      const student = (cls?.students || []).find((s) => s.id === studentId);
      // 綁定成立之後家長才要求不參與，是最常見的順序。訊息與「還沒核可」
      // 完全一致，不透露差別——差別本身也是一則關於這個孩子的資訊。
      if (isOptedOut(student)) {
        return json({ error: '這個帳號還沒有被老師核可查看這位學生。' }, 403);
      }
      const events = await positiveEvents(db, teacherId, studentId);

      return json({
        cls: { id: cls?.id || '', name: cls?.name || '' },
        student: { id: studentId, name: student?.name || '', no: student?.no ?? '' },
        behaviors,
        events: events.map((e) => ({
          id: e.id,
          ts: e.ts,
          behaviorId: e.behaviorId,
          delta: Number(e.delta) || 0,
          period: e.period || '',
          // 後端已經只送正向、未撤銷的資料，補上這兩個欄位是為了讓
          // 前端可以照樣把整包丟給 parentView()，維持「只有一個投影閘門」。
          kind: 'positive',
          studentId,
          voided: false,
        })),
      });
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
  return handleParent(request, env, db);
}
