/*
 * 預設行為卡與示範班級。
 * 行為卡把分數綁死在卡片上——老師只能選卡，不能自由填分數，
 * 這是問卷「怕學生鑽漏洞」那一項的設計對策。
 */

export const DEFAULT_BEHAVIORS = [
  // 正向
  { id: 'b-speak', label: '主動發言', delta: 2, kind: 'positive', icon: '🙋' },
  { id: 'b-help', label: '幫助同學', delta: 3, kind: 'positive', icon: '🤝' },
  { id: 'b-focus', label: '專注投入', delta: 2, kind: 'positive', icon: '🎯' },
  { id: 'b-homework', label: '作業用心', delta: 2, kind: 'positive', icon: '📓' },
  { id: 'b-duty', label: '主動服務', delta: 3, kind: 'positive', icon: '🧹' },
  { id: 'b-progress', label: '明顯進步', delta: 4, kind: 'positive', icon: '📈' },
  // 待改進
  { id: 'b-talk', label: '課堂講話', delta: -1, kind: 'improve', icon: '💬' },
  { id: 'b-late', label: '遲到', delta: -1, kind: 'improve', icon: '⏰' },
  { id: 'b-nobook', label: '未帶用品', delta: -1, kind: 'improve', icon: '🎒' },
  { id: 'b-phone', label: '違規使用3C', delta: -2, kind: 'improve', icon: '📱' },
  { id: 'b-nohw', label: '未交作業', delta: -2, kind: 'improve', icon: '📄' },
  { id: 'b-conflict', label: '與人衝突', delta: -3, kind: 'improve', icon: '⚡' },
];

export const DEFAULT_SETTINGS = {
  // 告急規則：對應問卷第 3 名需求「即時狀態／告急提醒」
  alertConsecutiveImprove: 3, // 同一學生近期連續 N 次待改進
  alertConsecutiveWindowDays: 7,
  alertClassImprovePerPeriod: 5, // 同一節課全班待改進達 M 次
  periods: ['第1節', '第2節', '第3節', '第4節', '第5節', '第6節', '第7節', '早自習', '午休', '放學'],
  // 家長綁定的通過碼。家長輸入這組碼才送得出申請，送出後仍要老師逐筆核可。
  // 隨時可在「家長綁定」後台換一組；換了之後舊碼立刻失效，已核可的不受影響。
  parentCode: '',
  /*
   * 保存期限（月）。超過這段時間沒有新紀錄的班級，系統會主動提醒該刪了。
   * 預設 12 個月＝一個學年：班級經營的目的隨著學年結束而消失。
   * 學校端如果另有規定，以學校規定為準。
   */
  retentionMonths: 12,
};

const NAMES_A = [
  '示範01', '示範02', '示範03', '示範04', '示範05', '示範06',
  '示範07', '示範08', '示範09', '示範10', '示範11', '示範12',
  '示範13', '示範14', '示範15', '示範16', '示範17', '示範18',
];

const NAMES_B = [
  '示範19', '示範20', '示範21', '示範22', '示範23', '示範24',
  '示範25', '示範26', '示範27', '示範28', '示範29', '示範30',
  '示範31', '示範32', '示範33', '示範34', '示範35', '示範36',
];

function buildClass(id, name, names, cols = 6) {
  return {
    id,
    name,
    cols,
    students: names.map((n, i) => ({
      id: `${id}-s${i + 1}`,
      no: i + 1,
      name: n,
      row: Math.floor(i / cols),
      col: i % cols,
    })),
  };
}

export const DEMO_CLASSES = [
  buildClass('c701', '七年一班', NAMES_A),
  buildClass('c703', '七年三班', NAMES_B),
];

/** 產生前七天的示範事件，讓儀表板與告急提醒一打開就有東西看。 */
export function buildDemoEvents() {
  const events = [];
  const behaviors = DEFAULT_BEHAVIORS;
  const periods = DEFAULT_SETTINGS.periods.slice(0, 7);
  let counter = 0;

  // 固定亂數，讓每次示範資料一致
  let seed = 20260815;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  DEMO_CLASSES.forEach((cls) => {
    for (let dayAgo = 6; dayAgo >= 0; dayAgo--) {
      const count = 6 + Math.floor(rnd() * 6);
      for (let i = 0; i < count; i++) {
        const stu = cls.students[Math.floor(rnd() * cls.students.length)];
        // 七成正向，符合實務上該多記正向的期待
        const pool = rnd() < 0.7
          ? behaviors.filter((b) => b.kind === 'positive')
          : behaviors.filter((b) => b.kind === 'improve');
        const beh = pool[Math.floor(rnd() * pool.length)];
        const d = new Date();
        d.setDate(d.getDate() - dayAgo);
        d.setHours(8 + Math.floor(rnd() * 8), Math.floor(rnd() * 60), 0, 0);
        events.push({
          id: `demo-${counter++}`,
          ts: d.toISOString(),
          classId: cls.id,
          studentId: stu.id,
          behaviorId: beh.id,
          delta: beh.delta,
          kind: beh.kind,
          period: periods[Math.floor(rnd() * periods.length)],
          note: '',
          voided: false,
        });
      }
    }
  });

  const cls0 = DEMO_CLASSES[0];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 2);
  cutoff.setHours(0, 0, 0, 0);

  // 情境一：一位學生連續三次待改進，觸發個人告急。
  // 先清掉這位學生近三天的隨機事件，免得正向紀錄插進來把連續打斷。
  const target = cls0.students[4];
  const cleaned = events.filter(
    (e) => !(e.studentId === target.id && new Date(e.ts) >= cutoff)
  );

  ['b-talk', 'b-nobook', 'b-nohw'].forEach((behaviorId, i) => {
    const beh = behaviors.find((b) => b.id === behaviorId);
    const d = new Date();
    d.setDate(d.getDate() - (2 - i));
    d.setHours(10 + i, 15, 0, 0);
    cleaned.push({
      id: `demo-alert-${i}`,
      ts: d.toISOString(),
      classId: cls0.id,
      studentId: target.id,
      behaviorId: beh.id,
      delta: beh.delta,
      kind: beh.kind,
      period: periods[i % periods.length],
      note: '',
      voided: false,
    });
  });

  // 情境二：同一節課全班待改進達標，觸發班級告急。
  const noisyPeriod = periods[4];
  const noisyDay = new Date();
  noisyDay.setDate(noisyDay.getDate() - 1);
  cls0.students.slice(6, 12).forEach((stu, i) => {
    const beh = behaviors.find((b) => b.id === 'b-talk');
    const d = new Date(noisyDay);
    d.setHours(13, 5 + i * 3, 0, 0);
    cleaned.push({
      id: `demo-noisy-${i}`,
      ts: d.toISOString(),
      classId: cls0.id,
      studentId: stu.id,
      behaviorId: beh.id,
      delta: beh.delta,
      kind: beh.kind,
      period: noisyPeriod,
      note: '',
      voided: false,
    });
  });

  /*
   * 幾則老師的隨手備註。
   *
   * 這不是裝飾。學期評語與親師溝通草稿最有價值的素材就是這一欄——
   * 「段考數學從 48 進步到 71」比「學業有所進步」有用一百倍。
   * 示範資料如果 note 全是空字串，那兩個功能一打開就只生得出乾巴巴的統計，
   * 老師會以為功能沒用，其實是沒東西可用。
   *
   * 最後一則故意寫成結論式的標籤（「就是懶」「講不聽」）：
   * 那是老師寫給自己看的真實口吻，而親師溝通草稿必須把這種句子攔下來，
   * 不能原樣送到家長面前。示範資料要照得出這道濾網才有意義。
   */
  const NOTES = [
    ['positive', 'b-progress', '段考數學從 48 進步到 71，他自己跑來說「原來我背得起來」。'],
    ['positive', 'b-duty', '午餐時間主動留下來擦桌子，沒人叫他。'],
    ['positive', 'b-help', '主動去教隔壁組不會的同學，講到下課還在講。'],
    ['positive', 'b-speak', '討論時第一個舉手，講的角度全班都沒想到。'],
    ['improve', 'b-talk', '和鄰座聊天，提醒後有停下來。'],
    ['improve', 'b-nobook', '又忘了帶課本。他就是懶，講不聽。'],
  ];
  NOTES.forEach(([kind, behaviorId, note]) => {
    const hit = cleaned.find((e) => e.kind === kind && e.behaviorId === behaviorId && !e.note);
    if (hit) hit.note = note;
  });

  return cleaned.sort((a, b) => a.ts.localeCompare(b.ts));
}

export const SEED = {
  classes: DEMO_CLASSES,
  behaviors: DEFAULT_BEHAVIORS,
  settings: DEFAULT_SETTINGS,
  events: buildDemoEvents(),
};
