/*
 * 姓名分離（docs/gas-contract.md「姓名分離：這一版的核心設計」）。
 *
 * 這條線只有一個判準：**送上雲的 JSON 一個姓名都沒有，而上層完全感覺不到差別。**
 * 所以底下每一條測試都在問同一件事的其中一面：
 *
 *   1. 掃過示範資料的全部 36 個姓名，確認 payload 裡一個都找不到（逐一掃，不是抽樣）。
 *   2. 讀回來的 classes 跟餵進去的完全一致——上層各頁面因此一行都不用改。
 *   3. 沒有對照表的裝置（換電腦、家長學生的手機）fallback 成「13號」，不是空字串。
 *   4. purge 系列會把對照表裡對應的姓名一起清掉——漏清就是個資留在裝置上。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DEMO_CLASSES, SEED } from '../js/data.js';
import { createGasStore, NAMES_KEY, readNameMap, writeNameMap } from '../js/store-gas.js';

/** 最小可用的 localStorage 替身。真瀏覽器存的是字串，這裡也一律存字串，免得測試比實際寬鬆。 */
function fakeLocalStorage(initial = {}) {
  const data = new Map(Object.entries(initial).map(([k, v]) => [k, String(v)]));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    _data: data,
  };
}

/** 裝上假的 localStorage 跑一段，結束後還原（測試之間不互相污染）。 */
async function withLocalStorage(initial, fn) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const fake = fakeLocalStorage(initial);
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true, writable: true });
  try {
    return await fn(fake);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
}

/** 一個假的雲端：記下每一次 RPC，並且真的把 saveDoc 的內容留著給後續的 getDoc 讀。 */
function fakeCloud() {
  const calls = [];
  const docs = { classes: [], behaviors: [], rewards: [], settings: {} };
  const transport = async (req) => {
    calls.push(req);
    const p = req.payload || {};
    switch (req.op) {
      case 'init':
        docs.classes = (p.seed && p.seed.classes) || [];
        return {};
      case 'saveDoc':
        docs[p.name] = p.value;
        return {};
      case 'getDoc':
        return docs[p.name];
      case 'importAll':
        Object.assign(docs, p.payload || {});
        return { ok: true };
      case 'exportAll':
        return { exportedAt: '2026-08-15T00:00:00.000Z', ...docs, events: [] };
      case 'purgeStudent':
      case 'purgeClass':
        return { deleted: 3 };
      default:
        return {};
    }
  };
  return { calls, docs, transport, store: createGasStore({ transport }) };
}

/** 示範資料裡的全部 36 個姓名。 */
const ALL_NAMES = DEMO_CLASSES.flatMap((c) => c.students.map((s) => s.name));

/** 把整趟 RPC 序列化成一個字串，任何一個姓名只要漏出去就會被抓到。 */
function wireText(calls) {
  return JSON.stringify(calls);
}

test('示範資料剛好 36 個姓名，全部不重複（這是下面掃描的前提）', () => {
  assert.equal(ALL_NAMES.length, 36);
  assert.equal(new Set(ALL_NAMES).size, 36);
});

// ---- 1. 送上雲的 payload 一個姓名都沒有 ----

test('init／saveClasses／importAll 三條寫入路徑，36 個姓名逐一掃過都不在線路上', async () => {
  await withLocalStorage({}, async () => {
    const { calls, store } = fakeCloud();

    await store.init(SEED);
    await store.saveClasses(DEMO_CLASSES);
    await store.importAll({
      classes: DEMO_CLASSES,
      behaviors: SEED.behaviors,
      rewards: [],
      events: SEED.events || [],
      settings: SEED.settings,
    });

    const wire = wireText(calls);
    const leaked = ALL_NAMES.filter((n) => wire.includes(n));
    assert.deepEqual(leaked, [], `這些姓名跑到雲端去了：${leaked.join('、')}`);

    // 反面確認：掃描本身是有效的（同一批資料沒拆之前掃得到）。
    assert.ok(JSON.stringify(DEMO_CLASSES).includes(ALL_NAMES[0]));

    // 不只是「name 這個字串不見了」，而是 students 上根本沒有 name 這個鍵。
    for (const call of calls) {
      const classes =
        call.payload.value ||
        (call.payload.seed && call.payload.seed.classes) ||
        (call.payload.payload && call.payload.payload.classes) ||
        [];
      for (const cls of Array.isArray(classes) ? classes : []) {
        for (const stu of cls.students || []) {
          assert.equal('name' in stu, false, `${stu.id} 還帶著 name 欄位`);
        }
      }
    }
  });
});

test('拆姓名不會動到呼叫端手上的那份 classes（畫面還握著同一份參考）', async () => {
  await withLocalStorage({}, async () => {
    const { store } = fakeCloud();
    await store.saveClasses(DEMO_CLASSES);
    assert.equal(DEMO_CLASSES[0].students[0].name, '示範01');
  });
});

test('姓名確實落在 localStorage 的 cp:names，形狀是 { studentId: 姓名 }', async () => {
  await withLocalStorage({}, async (fake) => {
    const { store } = fakeCloud();
    await store.saveClasses(DEMO_CLASSES);

    const keys = [...fake._data.keys()];
    assert.deepEqual(keys, [NAMES_KEY], '對照表只能有 cp:names 這一個 key，不分班');

    const map = JSON.parse(fake._data.get(NAMES_KEY));
    assert.equal(Object.keys(map).length, 36);
    assert.equal(map['c701-s13'], '示範13');
  });
});

// ---- 2. 讀回來跟餵進去完全一致 ----

test('存進去再讀出來，上層拿到的 classes 跟原本的一模一樣', async () => {
  await withLocalStorage({}, async () => {
    const { store } = fakeCloud();
    await store.saveClasses(DEMO_CLASSES);
    assert.deepEqual(await store.getClasses(), DEMO_CLASSES);
  });
});

test('init 之後直接讀，也還原得回完整姓名', async () => {
  await withLocalStorage({}, async () => {
    const { store } = fakeCloud();
    await store.init(SEED);
    assert.deepEqual(await store.getClasses(), SEED.classes);
  });
});

test('exportAll 含姓名——備份檔是那份對照表唯一的離線副本', async () => {
  await withLocalStorage({}, async () => {
    const { store } = fakeCloud();
    await store.saveClasses(DEMO_CLASSES);
    const dump = await store.exportAll();
    assert.deepEqual(dump.classes, DEMO_CLASSES);
  });
});

test('exportAll → importAll 換一台電腦：studentId 與姓名全部接得回來', async () => {
  const dump = await withLocalStorage({}, async () => {
    const { store } = fakeCloud();
    await store.saveClasses(DEMO_CLASSES);
    return store.exportAll();
  });

  // 新機器：cp:names 空的，雲端資料照舊。
  await withLocalStorage({}, async () => {
    const { store, calls } = fakeCloud();
    await store.importAll(dump);
    assert.deepEqual(ALL_NAMES.filter((n) => wireText(calls).includes(n)), []);
    assert.deepEqual(await store.getClasses(), DEMO_CLASSES);
  });
});

test('importAll 整份換掉時，上一份資料的姓名不會殘留在對照表裡', async () => {
  await withLocalStorage({ [NAMES_KEY]: JSON.stringify({ 'cOld-s1': '舊班的孩子' }) }, async () => {
    const { store } = fakeCloud();
    await store.importAll({ classes: DEMO_CLASSES });
    const map = readNameMap();
    assert.equal(map['cOld-s1'], undefined);
    assert.equal(Object.keys(map).length, 36);
  });
});

// ---- 3. 沒有對照表的裝置 ----

test('沒有對照表時 fallback 成「13號」，不是空字串也不是 undefined', async () => {
  // 老師的機器先把資料推上雲。
  const { docs } = fakeCloud();
  await withLocalStorage({}, async () => {
    const teacher = createGasStore({ transport: fakeCloudSharing(docs) });
    await teacher.saveClasses(DEMO_CLASSES);
  });

  // 家長的手機：同一朵雲，但 cp:names 是空的。
  await withLocalStorage({}, async () => {
    const parent = createGasStore({ transport: fakeCloudSharing(docs) });
    const classes = await parent.getClasses();
    const stu = classes[0].students[12];
    assert.equal(stu.name, '13號');
    assert.equal(stu.id, 'c701-s13');
    assert.equal(stu.no, 13);
    // 座號、座位這些非個資欄位照樣完整，畫面不會缺東西。
    assert.deepEqual(
      classes[0].students.map((s) => s.name),
      DEMO_CLASSES[0].students.map((s) => `${s.no}號`),
    );
  });
});

test('連 localStorage 都沒有的環境（GAS 沙箱、Node）也只是拿到座號，不會爆炸', async () => {
  const { docs } = fakeCloud();
  await withLocalStorage({}, async () => {
    const teacher = createGasStore({ transport: fakeCloudSharing(docs) });
    await teacher.saveClasses(DEMO_CLASSES);
  });
  const store = createGasStore({ transport: fakeCloudSharing(docs) });
  const classes = await store.getClasses(); // 此時 globalThis.localStorage 不存在
  assert.equal(classes[0].students[0].name, '1號');
  await store.saveClasses(classes); // 寫入路徑也不能因為沒有 localStorage 就丟例外
});

test('fallback 的「13號」不會被當成真名寫回對照表', async () => {
  const { docs } = fakeCloud();
  await withLocalStorage({}, async () => {
    const teacher = createGasStore({ transport: fakeCloudSharing(docs) });
    await teacher.saveClasses(DEMO_CLASSES);
  });

  // 換裝置：讀到的是座號，改個座位又整包存回去——這是最容易把假名寫死的路徑。
  await withLocalStorage({}, async () => {
    const store = createGasStore({ transport: fakeCloudSharing(docs) });
    const classes = await store.getClasses();
    await store.saveClasses(classes);
    assert.deepEqual(readNameMap(), {}, '座號被當成姓名記進對照表了');
  });

  // 老師本人的機器（對照表還在）不受影響，仍然看得到真名。
  await withLocalStorage({ [NAMES_KEY]: JSON.stringify({ 'c701-s13': '洪語彤' }) }, async () => {
    const store = createGasStore({ transport: fakeCloudSharing(docs) });
    const classes = await store.getClasses();
    assert.equal(classes[0].students[12].name, '洪語彤');
    await store.saveClasses(classes);
    assert.equal(readNameMap()['c701-s13'], '洪語彤');
  });
});

/** 讓多個 store 共用同一份雲端 docs（模擬老師機器與家長手機打同一支端點）。 */
function fakeCloudSharing(docs) {
  return async (req) => {
    const p = req.payload || {};
    if (req.op === 'saveDoc') { docs[p.name] = p.value; return {}; }
    if (req.op === 'getDoc') return docs[p.name];
    return {};
  };
}

// ---- 4. 刪除要連對照表一起刪 ----

test('purgeStudent 會清掉那位學生在 cp:names 的姓名', async () => {
  await withLocalStorage({}, async () => {
    const { store } = fakeCloud();
    await store.saveClasses(DEMO_CLASSES);

    const res = await store.purgeStudent({ classId: 'c701', studentId: 'c701-s13' });
    assert.deepEqual(res, { deleted: 3 }, 'purge 的回傳值不能被姓名處理吃掉');

    const map = readNameMap();
    assert.equal(map['c701-s13'], undefined);
    assert.equal(Object.keys(map).length, 35, '只該清掉那一位');
    assert.equal(map['c701-s12'], '示範12');
  });
});

test('purgeClass 會清掉整班的姓名，別班的留著', async () => {
  await withLocalStorage({}, async () => {
    const { store } = fakeCloud();
    await store.saveClasses(DEMO_CLASSES);

    await store.purgeClass('c701');
    const map = readNameMap();
    assert.deepEqual(Object.keys(map).filter((k) => k.startsWith('c701-')), []);
    assert.equal(Object.keys(map).length, 18);
    assert.equal(map['c703-s1'], '示範19');
  });
});

test('resetAll 會把 cp:names 整個移除，不是留一個空物件', async () => {
  await withLocalStorage({}, async (fake) => {
    const { store } = fakeCloud();
    await store.saveClasses(DEMO_CLASSES);
    await store.resetAll();
    assert.equal(fake.getItem(NAMES_KEY), null);
    assert.deepEqual([...fake._data.keys()], []);
  });
});

test('學生被移出名冊（saveClasses 少了他）時，他的姓名當場從對照表消失', async () => {
  await withLocalStorage({}, async () => {
    const { store } = fakeCloud();
    await store.saveClasses(DEMO_CLASSES);

    const trimmed = DEMO_CLASSES.map((c) =>
      c.id === 'c701' ? { ...c, students: c.students.filter((s) => s.id !== 'c701-s13') } : c,
    );
    await store.saveClasses(trimmed);

    const map = readNameMap();
    assert.equal(map['c701-s13'], undefined, '被移出名冊的學生姓名還留在裝置上');
    assert.equal(Object.keys(map).length, 35);
  });
});

test('只存一個班時，不會連坐清掉其他班的姓名', async () => {
  await withLocalStorage({}, async () => {
    const { store } = fakeCloud();
    await store.saveClasses(DEMO_CLASSES);
    await store.saveClasses([DEMO_CLASSES[0]]);
    assert.equal(readNameMap()['c703-s1'], '示範19');
  });
});

// ---- 對照表本身的韌性 ----

test('cp:names 壞掉（手動改壞、被別的東西覆蓋）時當成空的，不讓整個畫面開不起來', async () => {
  await withLocalStorage({ [NAMES_KEY]: '{壞掉的 JSON' }, async () => {
    assert.deepEqual(readNameMap(), {});
    const { store } = fakeCloud();
    await store.init(SEED);
    const classes = await store.getClasses();
    assert.equal(classes[0].students[0].name, '示範01');
  });
});

test('writeNameMap／readNameMap 是同一份東西的兩面（給主線寫「換裝置補名冊」用）', async () => {
  await withLocalStorage({}, async () => {
    writeNameMap({ 'c701-s1': '王品睿' });
    assert.deepEqual(readNameMap(), { 'c701-s1': '王品睿' });
  });
});
