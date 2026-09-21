// 欢乐十四分 · 微信小程序版界面与回合控制
const G = require('../../utils/game-core.js');
const A = require('../../utils/advisor.js');
const SFX = require('../../utils/sfx.js');

// 音效安全调用：环境不支持音频时静默跳过
function snd(name) { try { if (SFX && typeof SFX[name] === 'function') SFX[name](); } catch (e) { /* 忽略 */ } }

// 分步演出的节奏（毫秒）：改这几个数就能整体调快/调慢
const T_RING_LOCK = 320;   // 圈选锁定 → 手牌开始飞
const T_MERGE = 640;       // 手牌飞到桌面牌上合拢
const T_PENALTY_OUT = 420; // 罚牌：被弃的牌飞走
// NPC 出牌拆成三拍，每拍之间都"停一停"，让玩家看得清：
// NPC 出牌拆成六拍，每一拍都单独停住，让玩家一眼一步跟得上：
const T_NPC_THINK = 700;    // ① 思考
const T_NPC_POINT = 1500;   // ② 卡通箭头指向它看中的桌面牌（其余桌面牌压暗）
const T_NPC_LIFT = 700;     // ③ 那张牌"抬起来"，表示我要的就是它
const T_NPC_FLIP = 620;     // ④ 逐张翻手上的牌，每张之间隔这么久
const T_NPC_READ = 2000;    // ⑤ 全部翻完、等式亮出后停一拍，够你读完
const T_NPC_MERGE = 900;    // ⑥ 合牌收走
const T_HAND_OFF = 460;    // 一拍后交给对方
// 台词停留：按字数动态算，短句也要够看清，长句留得更久（上限防卡场）
const T_SAY_MIN = 2800;
const T_SAY_MAX = 12000;
const sayDur = (text) => {
  const s = String(text || '');
  let chars = 0;
  for (let i = 0; i < s.length; i++) chars += /[\u4e00-\u9fff]/.test(s[i]) ? 1 : 0.5;
  return Math.max(T_SAY_MIN, Math.min(T_SAY_MAX, Math.round(1500 + chars * 300)));
};

// 胜率模拟：每批多少局、总共多少局（手机比桌面慢，所以分批算，不卡界面）
const SIM_CHUNK = 100;
const SIM_TOTAL = 240;

let game = null; // 完整对局（不进 data，避免大对象）
let ui = {
  selHand: [], selTable: null,
  noMoves: false, mergePlan: null, penPlan: null,
  mode: 'idle', valid: false,
};
let decisions = { total: 0, optimal: 0 };
let odds = { win: 0, lose: 0, draw: 0, n: 0, done: 0, target: 0 };
let oddsGen = 0;
let simEnabled = true;
// 先手随机：生产默认 true（按用户要求，不一直是玩家先手）；测试可关掉保确定性
let firstMoveRandom = true;
let npcDifficulty = 'medium';   // 难度（仅影响 NPC 强度）；wx storage 持久化
const DIFF_DESC = {
  easy:   '容易：NPC 大半随缘出牌，还常把高分牌送给你。',
  medium: '中等：NPC 一步贪心，盯着当下最赚的走。',
  hard:   '难：NPC 出牌照贪心，但补到桌面那张专挑"最不喂你"的。',
  hell:   '地狱：NPC 每种打法都推演到终局再挑，几乎算死你。',
  adaptive: '自适应：跟着你的战绩自动升降档，目标是一直把你卡在五五开。',
};
const diffLabel = (d) => ({ easy: '容易', medium: '中等', hard: '难', hell: '地狱', adaptive: '自适应' }[d] || d);

// ---------- 自适应难度（第 5 档） ----------
// 只看结果、不猜水平：把最近几局胜负记下来，赢太多升档、输太多降档，目标是把玩家卡在五五开。
// 纯本地统计，不用模型。窗口 W=4：赢≥3 升一档、输≥3 降一档，夹在 easy…hell 之间（不越界）。
const ADAPT_W = 4;
let adaptLevel = 1;   // 0..3 → G.BASE_DIFFICULTIES 下标，默认 medium
let adaptHist = [];   // 最近 W 局结果：'w' | 'l' | 'd'
function loadAdapt() {
  try {
    if (typeof wx === 'undefined' || typeof wx.getStorageSync !== 'function') return;
    const lv = parseInt(wx.getStorageSync('h14_adapt_lv'), 10);
    if (lv >= 0 && lv <= 3) adaptLevel = lv;
    const h = wx.getStorageSync('h14_adapt_hist');
    if (Array.isArray(h)) adaptHist = h.filter((x) => x === 'w' || x === 'l' || x === 'd').slice(-ADAPT_W);
  } catch (e) {}
}
function saveAdapt() {
  try {
    if (typeof wx === 'undefined' || typeof wx.setStorageSync !== 'function') return;
    wx.setStorageSync('h14_adapt_lv', adaptLevel);
    wx.setStorageSync('h14_adapt_hist', adaptHist.slice());
  } catch (e) {}
}
// 每局结束喂一个结果；返回 +1 升档 / -1 降档 / 0 不动
function adaptFeed(result) {
  adaptHist.push(result);
  if (adaptHist.length > ADAPT_W) adaptHist = adaptHist.slice(-ADAPT_W);
  let moved = 0;
  if (adaptHist.length >= ADAPT_W) {
    const w = adaptHist.filter((x) => x === 'w').length;
    const l = adaptHist.filter((x) => x === 'l').length;
    if (w >= 3 && adaptLevel < 3) { adaptLevel++; moved = 1; }
    else if (l >= 3 && adaptLevel > 0) { adaptLevel--; moved = -1; }
  }
  saveAdapt();
  return moved;
}
// 自适应档此刻真正用的档位（传给内核的那个）；其它档原样返回
function effectiveDifficulty() {
  if (npcDifficulty !== 'adaptive') return npcDifficulty;
  return (G && G.BASE_DIFFICULTIES && G.BASE_DIFFICULTIES[adaptLevel]) || 'medium';
}
function adaptSummary() {
  const n = adaptHist.length;
  if (!n) return '还没打够，先按中等';
  const w = adaptHist.filter((x) => x === 'w').length;
  const l = adaptHist.filter((x) => x === 'l').length;
  return '近 ' + n + ' 局 ' + w + ' 胜 ' + l + ' 负';
}
// 侧栏说明文案：自适应档必须写出"现在实际按哪一档打"
function diffDescText() {
  if (npcDifficulty === 'adaptive') {
    return '自适应：' + adaptSummary() + ' · 当前按「' + diffLabel(effectiveDifficulty()) + '」打（赢多了自动升、输多了自动降）';
  }
  return DIFF_DESC[npcDifficulty] || '';
}

// ---------- 开局难度询问（用户要求：新开局先问一句） ----------
let askDiff = true;        // 是否在开局前询问
let pendingDiff = null;    // 询问层里选中的档位（没点开始前不动 npcDifficulty）
let firstRunPending = false;  // 首玩：先开局，再把玩法说明盖上来
function loadAskDiff() {
  try {
    if (typeof wx === 'undefined' || typeof wx.getStorageSync !== 'function') return;
    // 只在"确实存过"时才覆盖：存储里没有 = 用默认值（否则测试里先设的开关会被悄悄改回去）
    const v = wx.getStorageSync('h14_askdiff');
    if (v === 0 || v === '0') askDiff = false;
    else if (v === 1 || v === '1') askDiff = true;
  } catch (e) {}
}
function setAskDiff(v) {
  askDiff = !!v;
  try { if (typeof wx !== 'undefined' && typeof wx.setStorageSync === 'function') wx.setStorageSync('h14_askdiff', askDiff ? 1 : 0); } catch (e) {}
}

function cardView(c, opt) {
  opt = opt || {};
  return {
    id: c.id,
    label: c.label,
    short: c.short,
    suitSymbol: c.suitSymbol,
    red: c.red,
    isJoker: c.isJoker,
    selected: !!opt.selected,
    isNew: !!opt.isNew,           // 首次出现 → 播入场动画（补牌要有"动作"）
    ringed: !!opt.ringed,         // 被圈框圈住（选定/合牌目标）
    ringBad: !!opt.ringBad,       // 圈住了但和≠14 → 警告色
    ringLock: !!opt.ringLock,     // 圈选锁定（手牌即将飞过来）
    mergeTarget: !!opt.mergeTarget, // 手牌合上来时的膨胀
    mergeTo: !!opt.mergeTo,       // 这张手牌要飞向被圈的桌面牌
    penOut: !!opt.penOut,         // 罚牌：飞走（隐藏）
    npcPoint: !!opt.npcPoint,     // NPC 回合第 1/2 拍：箭头指着这张桌面牌
    lifted: !!opt.lifted,         // 第 2 拍：这张桌面牌被"抬起来"（我要的就是它）
    dimmed: !!opt.dimmed,         // NPC 回合：不是目标的那几张压暗，视线只跟着箭头走
    revealed: !!opt.revealed,     // 浮层里"已经翻出"的牌（静止，不重复播翻面）
    flipIn: !!opt.flipIn,         // 浮层里"刚刚翻出"的那一张（播翻面动画）
    isTarget: !!opt.isTarget,     // 浮层里桌面那张（最后翻出，单独标出）
    delay: opt.delay || 0,
  };
}

// 亮牌浮层的数据：upto = 已经翻出几张（含），只有最新那张播翻面动画
function npcShowData(head, cards, upto, eq) {
  const k = Math.max(1, Math.min(upto || 1, cards.length));
  const shown = cards.slice(0, k).map((c, i) => cardView(c, {
    revealed: i !== k - 1,
    flipIn: i === k - 1,
    isTarget: i === cards.length - 1,
  }));
  return { head: head, masked: true, clearing: false, cards: shown, eq: eq || '' };
}

// 轻提示：匹配得分 / 补牌到账 / 罚牌
function toast(title) {
  if (typeof wx !== 'undefined' && wx.showToast) {
    wx.showToast({ title: title, icon: 'none', duration: 1200 });
  }
}

// 牌面等式文案：2♦ + 10♣ + 2♦
function eqText(cards) {
  return cards.map((c) => (c.short ? c.short + c.suitSymbol : c.label + c.suitSymbol)).join(' + ');
}
function cardName(c) { return c.short + c.suitSymbol; }
const r2 = (v) => Math.round(v * 100) / 100;

// 结算明细的一侧：战利品/罚牌按花色+王的"张数×单价=得分"，最后给出"战利品−罚牌=得分"
function scoreSection(title, cls, loot, pen, score) {
  const d = G.scoreDetail(loot);
  const dp = G.scoreDetail(pen);
  const rows = (detail) => {
    const out = [];
    Object.keys(detail.bySuit).forEach((k) => {
      const s = detail.bySuit[k];
      out.push({ k: 's' + k, name: s.symbol + ' ' + s.name, calc: s.count + ' 张 ×' + s.unit, points: s.points.toFixed(2), zero: !s.count });
    });
    [detail.joker.big, detail.joker.small].forEach((j, i) => {
      out.push({ k: 'j' + i, name: j.symbol + ' ' + j.name, calc: j.count + ' 张 ×' + j.unit, points: j.points.toFixed(2), zero: !j.count });
    });
    return out;
  };
  return {
    title: title, cls: cls,
    lootRows: rows(d), lootTotal: d.total.toFixed(2), lootCount: d.count,
    penRows: rows(dp), penTotal: dp.total.toFixed(2), penCount: dp.count,
    calc: d.total.toFixed(2) + ' − ' + dp.total.toFixed(2),
    score: score.toFixed(2),
  };
}

Page({
  data: {
    table: [], playerHand: [], npcHand: [],
    drawCount: 0, playerCount: 0, npcCount: 0,
    pLoot: 0, nLoot: 0, pPen: 0, nPen: 0,
    message: '', showOver: false, over: {}, logText: '',
    drawPulse: false, npcShow: null,
    showConfirm: false,      // 「确认匹配」（选牌阶段常显）
    penLabel: '🚫 罚掉选中的 1 张',
    confirmLabel: '✅ 确认匹配',
    confirmDisabled: true,     // wxml 里要用：首帧就得有值，别等 render
    penDisabled: true,         // 没选中恰好 1 张手牌时置灰
    lootPulse: '',           // 战利品/罚牌计数跳动标记
    scoreMe: '0.00',         // 实时比分（罚牌已计入）
    scoreNpc: '0.00',
    scoreLead: '暂时打平',    // 实时领先提示
    scoreLeadCls: 'even',
    scorePulse: '',          // 比分跳动标记：'me' | 'npc'
    npcMood: 'idle',         // NPC 表情
    npcSay: '',              // NPC 碎嘴小气泡（座位内）
    npcSpeak: null,          // NPC 大娃娃说话 { mood, text }
    soundLabel: '🔊 音效开',
    oddsMeW: '0%', oddsDrawW: '0%', oddsNpcW: '0%',
    oddsWin: '—', oddsLose: '—', oddsDraw: '—', oddsN: '—',
    decisionRate: '—',
    showHelp: false,        // 首玩引导：首次启动自动弹，之后顶栏「❓ 玩法」随时看
    firstBanner: '',        // 开局先手宣告（'' = 隐藏；announceFirst 1.6 秒后清空）
    npcDifficulty: 'medium', // 难度（仅影响 NPC 强度；玩家永远是"人"），持久化
    diffDesc: '',            // 当前难度的一句话说明（侧栏难度条下方）
    showDiffAsk: false,      // 开局难度询问层（用户要求：新开局先问一句）
    askDiffPending: 'medium',// 询问层里当前高亮的档位
    askDiffDesc: '',         // 询问层的档位说明
    askDiffGo: '开 始',      // 询问层开始按钮文案（带档位名）
    askNever: false,         // "以后开局别再问我"的勾选态
  },

  onLoad() {
    if (SFX && SFX.load) SFX.load();
    this.setData({ soundLabel: (SFX && SFX.isMuted && SFX.isMuted()) ? '🔇 音效关' : '🔊 音效开' });
    loadAdapt();     // 恢复自适应档位 + 近期战绩
    loadAskDiff();   // 恢复"开局是否还问难度"
    // 读持久化难度（首次用默认 medium）
    try {
      if (typeof wx !== 'undefined' && typeof wx.getStorageSync === 'function') {
        const d = wx.getStorageSync('h14_diff');
        if (d && G.DIFFICULTIES && G.DIFFICULTIES.indexOf(d) >= 0) npcDifficulty = d;
      }
    } catch (e) {}
    firstRunPending = !this.getSeenHelp();   // 首玩：本局开好后再把玩法说明盖上来
    this._applyDifficulty(npcDifficulty, true); // 同步 UI 高亮 + 说明（不重复写存储）
    this.requestNewGame();   // 开局前先问一句难度（勾了"别再问"就直接开）
  },

  newGame() {
    game = G.createGame({ numDecks: 2, firstRandom: firstMoveRandom });
    this._ep = (this._ep || 0) + 1; // 作废所有在途动画回调
    ui = { selHand: [], selTable: null, noMoves: false, mergePlan: null, penPlan: null, mode: 'idle', valid: false };
    decisions = { total: 0, optimal: 0 };
    oddsGen++;
    odds = { win: 0, lose: 0, draw: 0, n: 0, done: 0, target: 0 };
    this._msg = '';
    this._snap = null; // 清空快照：新一局发牌全部播入场动画
    this._busy = false;
    this._sayGen = (this._sayGen || 0) + 1;
    this.setData({ showOver: false, over: {}, npcShow: null, npcMood: 'idle', npcSay: '', npcSpeak: null, oddsMeW: '0%', oddsDrawW: '0%', oddsNpcW: '0%', oddsWin: '—', oddsLose: '—', oddsDraw: '—', oddsN: '—', decisionRate: '—', scoreMe: '0.00', scoreNpc: '0.00', scoreLead: '暂时打平', scoreLeadCls: 'even', scorePulse: '' });
    const dlText = (npcDifficulty === 'adaptive')
      ? ('自适应·' + diffLabel(effectiveDifficulty()))
      : diffLabel(npcDifficulty);
    this.log('🎴 新一局开始！' + (game.turn === 'player' ? '你先手' : 'NPC 先手') + '（难度：' + dlText + '）。');
    this.announceFirst();   // 大字亮一下谁先手，1.6 秒自动淡出
    snd('deal');     // 发牌音效：开局哗啦一下
    snd('start');   // 开局号角（首次进页面音频上下文可能还没就绪，静默跳过不算 bug）
    this.beginTurn();
    this.render();
    this.npcSay('start');   // NPC 开局先打个招呼
  },

  toggleSound() {
    if (!SFX || !SFX.toggleMuted) return;
    SFX.setMuted(!SFX.isMuted());
    this.setData({ soundLabel: SFX.isMuted() ? '🔇 音效关' : '🔊 音效开' });
    if (!SFX.isMuted()) snd('tap');
  },

  // 玩法说明（首玩引导）：顶栏「❓ 玩法」随时看；看过一次不再自动弹
  getSeenHelp() {
    try { if (typeof wx !== 'undefined' && typeof wx.getStorageSync === 'function') return !!wx.getStorageSync('h14_seenHelp'); } catch (e) {}
    return false;
  },
  setSeenHelp() {
    try { if (typeof wx !== 'undefined' && typeof wx.setStorageSync === 'function') wx.setStorageSync('h14_seenHelp', 1); } catch (e) {}
  },
  showHelp() { this.setData({ showHelp: true }); },
  hideHelp() { this.setData({ showHelp: false }); this.setSeenHelp(); },

  // 难度（仅影响 NPC 强度）：点五档之一，立即切换并持久化（下一局按新难度开局）
  setDifficulty(e) {
    const d = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.diff : null;
    if (!d) return;
    this._applyDifficulty(d, false);
  },
  // 同步 UI 高亮 + 说明；writeStore=false 时不重复写存储（onLoad 已读过）
  _applyDifficulty(d, writeStore) {
    if (!G.DIFFICULTIES || G.DIFFICULTIES.indexOf(d) < 0) return;
    npcDifficulty = d;
    if (writeStore) {
      try { if (typeof wx !== 'undefined' && typeof wx.setStorageSync === 'function') wx.setStorageSync('h14_diff', d); } catch (e) {}
    }
    this.setData({
      npcDifficulty: d,
      diffDesc: diffDescText(),   // 自适应档要带上"当前实际按哪一档打"
    });
  },

  // ---------- 开局难度询问：只有两个出口，选一档开始 / 直接开始 ----------
  requestNewGame() {
    if (!askDiff) { this.newGame(); this.maybeFirstHelp(); return; }
    this.openDiffAsk();
  },
  openDiffAsk() {
    pendingDiff = npcDifficulty;   // 默认停在当前档，不改就等于"沿用"
    // showOver:false —— 结算层和询问层同为 .modal，不关结算层会叠在底下（Web 端实测踩中过）
    this.setData({
      showOver: false,
      showDiffAsk: true,
      askDiffPending: pendingDiff,
      askDiffDesc: DIFF_DESC[pendingDiff] || '',
      askDiffGo: '开 始（' + diffLabel(pendingDiff) + '）',
      askNever: !askDiff,
    });
  },
  pickAskDiff(e) {
    const d = e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.diff : null;
    if (!d || !G.DIFFICULTIES || G.DIFFICULTIES.indexOf(d) < 0) return;
    pendingDiff = d;   // 只是选中，还没生效
    this.setData({
      askDiffPending: d,
      askDiffDesc: DIFF_DESC[d] || '',
      askDiffGo: '开 始（' + diffLabel(d) + '）',
    });
  },
  toggleAskNever() {
    const v = !this.data.askNever;
    this.setData({ askNever: v });
    setAskDiff(!v);
  },
  confirmDiffAsk() {
    if (pendingDiff) this._applyDifficulty(pendingDiff, true);   // 写存储 + 刷新侧栏
    this.setData({ showDiffAsk: false });
    this.newGame();
    this.maybeFirstHelp();
  },
  // 首玩：局先开好，再把玩法说明盖上来（两层不叠在一起），关掉就能直接玩
  maybeFirstHelp() {
    if (!firstRunPending) return;
    firstRunPending = false;
    this.setData({ showHelp: true });
  },

  // 延时执行且绑定当前局次：中途开了新一局，这一步自动作废（否则旧回调会改到新牌局）
  // 参数顺序与 setTimeout 一致：(fn, ms)
  _after(fn, ms) {
    const ep = this._ep;
    setTimeout(() => { if (ep === this._ep) fn(); }, ms);
  },

  // 先手宣告：横幅大字亮 1.6 秒（绑局次，中途重开自动作废）
  announceFirst() {
    const txt = game.turn === 'player' ? '你先手' : 'NPC 先手';
    this.setData({ firstBanner: txt });
    this._after(() => { this.setData({ firstBanner: '' }); }, 1600);
  },

  log(msg) {
    game.log.push(msg);
    this.render();
  },

  setMessage(msg) {
    this._msg = msg;
  },

  // ---------- NPC 表情与台词：重要台词弹"大娃娃"，碎嘴只走座位小气泡 ----------
  // 这句台词要停留多久：按字数算（没有语音，只看文字要读多久）
  playSay(text) {
    return sayDur(text);
  },
  npcSay(event, chance) {
    if (!game || game.phase === 'gameover') return;
    const line = A.npcSay(event, { chance: chance });
    if (!line) return;
    const patch = { npcMood: line.mood };
    if (line.big) patch.npcSpeak = { mood: line.mood, text: line.text };  // 大娃娃
    else {
      patch.npcSay = line.text;   // 碎嘴
      patch.npcSpeak = null;      // 新台词顶掉上一条大娃娃，别让它在旁边说旧话
    }
    this.setData(patch);
    const gen = (this._sayGen = (this._sayGen || 0) + 1);
    this._after(() => {
      if (gen !== this._sayGen) return;
      this.setData(line.big ? { npcSpeak: null } : { npcSay: '' });
    }, this.playSay(line.text));
  },
  hideSpeak() {
    this._sayGen = (this._sayGen || 0) + 1;
    this.setData({ npcSpeak: null, npcSay: '' });
  },
  setMood(mood) { this.setData({ npcMood: mood }); },
  // 按局势说句场面话（领先/落后/残局）
  npcSituationLine() {
    if (!game || game.phase === 'gameover') return;
    const diff = G.computeScore(game, 'npc') - G.computeScore(game, 'player');
    if (game.drawPile.length <= 8) { this.npcSay('lowDraw'); return; }
    if (diff >= 3) { this.npcSay('ahead', 0.5); return; }
    if (diff <= -3) { this.npcSay('behind', 0.5); }
  },

  // ---------- 胜率估计（蒙特卡洛，分批算） ----------
  refreshOdds() {
    if (!simEnabled || !game || game.phase === 'gameover') return;
    oddsGen++;
    odds = { win: 0, lose: 0, draw: 0, n: 0, done: 0, target: SIM_TOTAL };
    const job = { gen: oddsGen, ep: this._ep };
    this._after(() => this.stepOdds(job), 260);
  },
  stepOdds(job) {
    if (!job || job.gen !== oddsGen || job.ep !== this._ep) return; // 中途开新局 / 已重算 → 作废
    for (let i = 0; i < SIM_CHUNK && odds.done < odds.target; i++) {
      const r = A.simulateOne(game, undefined, effectiveDifficulty());   // NPC 按当前实际档位模拟
      if (r > 0) odds.win++; else if (r < 0) odds.lose++; else odds.draw++;
      odds.done++;
    }
    odds.n = odds.done;
    this.renderOdds();
    if (odds.done < odds.target) this._after(() => this.stepOdds(job), 16);
  },
  renderOdds() {
    const n = odds.n || 0;
    const rd = A.rateDecisions(decisions);
    this.setData({
      oddsWin: n ? Math.round((odds.win / n) * 100) + '%' : '—',
      oddsLose: n ? Math.round((odds.lose / n) * 100) + '%' : '—',
      oddsDraw: n ? Math.round((odds.draw / n) * 100) + '%' : '—',
      oddsN: n ? n + ' 局' : '计算中…',
      oddsMeW: n ? ((odds.win / n) * 100).toFixed(1) + '%' : '0%',
      oddsNpcW: n ? ((odds.lose / n) * 100).toFixed(1) + '%' : '0%',
      oddsDrawW: n ? ((odds.draw / n) * 100).toFixed(1) + '%' : '0%',
      decisionRate: rd.total ? (rd.optimal + '/' + rd.total + ' 最优 · ' + rd.rate + '%') : '—',
    });
  },
  // 记一次决策是否最优，并给即时反馈
  recordDecision(judge, kind, detail) {
    decisions.total++;
    if (judge && judge.optimal) decisions.optimal++;
    this.renderOdds();
    if (judge && judge.optimal) this.log('📈 最优判断：' + kind + ' ✅ 这是本回合最赚的一手。');
    else if (judge) this.log('📈 最优判断：' + kind + ' ⚠️ 不是最优 —— ' + (detail || '还有更赚的一手。'));
  },

  beginTurn() {
    if (G.isGameOver(game)) { this.showOver(); return; }
    if (game.turn === 'player') {
      if (game.playerHand.length === 0) { game.turn = 'npc'; this.beginTurn(); return; }
      this.playerTurnStart();
    } else {
      if (game.npcHand.length === 0) { game.turn = 'player'; this.beginTurn(); return; }
      this.npcTurn();
    }
  },

  playerTurnStart() {
    const moves = G.findMoves(game.playerHand, game.table);
    ui.selHand = []; ui.selTable = null; ui.valid = false;
    ui.mergePlan = null; ui.penPlan = null;
    ui.mode = 'select';            // 永远进"选牌模式"：即使无解也让玩家自己按罚牌
    ui.noMoves = moves.length === 0;
    this.setMessage(ui.noMoves
      ? '⚠️ 系统检测：这手牌和桌面 6 张凑不出 14。点 1 张手牌，再点「🚫 罚掉这张」放弃本回合。'
      : '点手牌 + 点桌面 1 张，凑「= 14」；想放弃就只点 1 张手牌，再点「🚫 罚掉这张」。');
    this.render();
    this.refreshOdds();   // 轮到玩家 → 后台更新胜率
  },

  // 罚牌（玩家自己决定的一次放弃）：选中恰好 1 张手牌 → 点罚牌按钮即可，不再有"模式切换"
  doPenalty() {
    if (game.turn !== 'player' || ui.mode !== 'select' || this._busy || ui.penPlan) return;
    if (ui.selHand.length !== 1) return;
    const card = game.playerHand.find((c) => c.id === ui.selHand[0]);
    if (!card) { ui.selHand = []; this.render(); return; }
    // 罚牌是否最优：本来无解 → 唯一选择；明明有解却罚牌 → 白丢一次收益
    const judge = A.judgePenalty(game.playerHand, game.table);
    this.recordDecision(judge, '罚牌',
      judge.hasMove ? ('你明明能出：' + eqText(judge.best.captured) + ' = 14（+' + judge.bestGain + ' 分）') : '');
    if (judge.hasMove) toast('💡 其实能出：' + eqText(judge.best.captured) + ' = 14');
    snd('penalty');
    ui.mode = 'penalizing';
    ui.penPlan = card.id;
    this._busy = true;
    this.setMessage('🚫 已扣下 ' + cardName(card) + '（隐藏），正在补牌…');
    this.render();
    this._after(() => {
      ui.penPlan = null;
      const before = game.playerHand.map((c) => c.id);
      G.penalty(game, 'player', card.id);
      const r = this.refillInfo('player', before);
      ui.selHand = []; ui.selTable = null;
      this.log('🚫 你罚牌 1 张（' + cardName(card) + '，隐藏）。');
      if (r.got > 0) this.log('补牌堆自动补 ' + r.got + ' 张到手牌（手牌 ' + r.total + ' 张）。');
      toast(r.got > 0 ? '罚牌 −1，补牌 +' + r.got : '罚牌 −1（补牌堆已空，不再补）');
      this.setData({ lootPulse: 'pPen' });
      this._after(() => this.setData({ lootPulse: '' }), 700);
      if (r.got > 0) snd('draw');
      ui.mode = 'idle';
      this.render();
      this.npcSay('playerPenalty', 0.5);
      this._after(() => { this._busy = false; this.endPlayerTurn(); }, T_HAND_OFF);
    }, T_PENALTY_OUT);
  },

  // 从补牌堆补了几张到手牌（who 指定谁），用于日志与提示
  refillInfo(who, beforeIds) {
    const hand = who === 'player' ? game.playerHand : game.npcHand;
    const got = hand.filter((c) => beforeIds.indexOf(c.id) < 0).length;
    return { got: got, total: hand.length };
  },

  onHandTap(e) {
    if (game.turn !== 'player' || game.phase === 'gameover' || this._busy) return;
    const id = e.currentTarget.dataset.id;
    const card = game.playerHand.find((c) => c.id === id);
    if (!card) return;
    if (ui.mode === 'select') {
      // 统一"选中/取消"语义：选中的牌既可以匹配，也可以罚掉，由下面两个按钮决定
      const i = ui.selHand.indexOf(id);
      if (i >= 0) ui.selHand.splice(i, 1); else ui.selHand.push(id);
      snd('tap');
      this.updateSelectSum();
      this.render();
    } else if (ui.mode === 'replace') {
      // 补到桌面的牌 = 送给对手的牌，但要两头看：
      //   ① 送出去亏多少 → 期望送分 = 分值 × 预计被吃走的概率（未知牌池 + 精确枚举算，不偷看对手手牌）
      //   ② 留在手上还值多少 → 这张牌以后能不能帮我凑 14（"留后路"）
      // 两者相减得净收益，取最高的那手。只看①会让人把好牌早早扔掉。
      const judge = A.judgeReplace(game.playerHand, game.table, [], id, {
        unknown: G.unknownPool(game),
        oppHandSize: game.npcHand.length,
      });
      if (judge && judge.chosen) {
        const mine = judge.chosen, alt = judge.suggest;
        const desc = (x) => '「' + cardName(x.card) + '」值 ' + x.score.toFixed(2) + ' 分、估计 ' + x.riskPct +
          '% 会被对手吃走 → 期望送 ' + x.cost.toFixed(2) + ' 分' +
          (x.path > 0 ? '，留手上还能再赚 ' + x.path.toFixed(2) + ' 分' : '（留手上也没用）');
        const tip = (judge.optimal || !alt) ? null : (desc(mine) + '；' + desc(alt) + '，更划算。');
        this.recordDecision(judge, '补牌到桌面', tip);
        if (judge.optimal) {
          toast(mine.path > 0
            ? '补牌合理 ✅ 送 ' + mine.cost.toFixed(2) + ' 分，' + cardName(mine.card) + ' 留着还能赚 ' + mine.path.toFixed(2) + ' 分'
            : '补牌合理 ✅ 期望送 ' + mine.cost.toFixed(2) + ' 分');
        } else {
          toast('💡 换个思路：「' + cardName(alt.card) + '」净收益 ' + alt.net.toFixed(2) +
            ' 分，你这张 ' + mine.net.toFixed(2) + ' 分');
        }
      }
      const before = game.playerHand.map((c) => c.id);
      G.replaceAndRefill(game, 'player', id);
      const r = this.refillInfo('player', before);
      this.log('你把 1 张手牌补到桌面。');
      if (r.got > 0) this.log('补牌堆自动补 ' + r.got + ' 张到手牌（手牌 ' + r.total + ' 张）。');
      toast(r.got > 0 ? '补牌 +' + r.got + ' → 手牌 ' + r.total + ' 张' : '补牌堆已空，不再补牌');
      if (r.got > 0) snd('draw');
      ui.mode = 'idle';
      this._busy = true;
      this.render();
      this._after(() => { this._busy = false; this.endPlayerTurn(); }, T_HAND_OFF);
    }
  },

  onTableTap(e) {
    if (game.turn !== 'player' || ui.mode !== 'select') return;
    const id = e.currentTarget.dataset.id;
    ui.selTable = ui.selTable === id ? null : id;
    snd('ring');
    this.updateSelectSum();
    this.render();
  },

  updateSelectSum() {
    const handCards = game.playerHand.filter((c) => ui.selHand.includes(c.id));
    const tableCard = game.table.find((c) => c.id === ui.selTable);
    const sum = G.sumMatchValue(handCards) + (tableCard ? tableCard.matchValue : 0);
    const ok = ui.selHand.length > 0 && !!tableCard && sum === 14;
    ui.valid = ok;
    let msg = '当前和：' + sum + (ok ? ' ✅ 可以匹配！' : ' ❌');
    if (!ok && ui.selHand.length === 1) msg += '　（只想放弃？点「🚫 罚掉」）';
    if (!ok && ui.selHand.length > 1) msg += '　（罚牌只能罚 1 张：点掉多余的手牌）';
    this.setMessage(msg);
    this.render();
  },

  // 匹配：分三步走完（圈住 → 手牌飞过去合拢 → 收进战利品），每一步都看得见
  confirmMatch() {
    if (!ui.valid || ui.mode !== 'select' || this._busy) return;
    const handCards = game.playerHand.filter((c) => ui.selHand.includes(c.id));
    const tableCard = game.table.find((c) => c.id === ui.selTable);
    const move = { handCards, tableCard, captured: handCards.concat([tableCard]) };
    const gain = Math.round(G.sumScore(move.captured) * 100) / 100;
    const sum = G.sumMatchValue(handCards) + tableCard.matchValue;

    // 出牌是否最优：和本回合最赚的那手比
    const judge = A.judgeMatch(game.playerHand, game.table, ui.selHand, ui.selTable);
    const detail = judge.best
      ? ('还有一手能多拿 +' + r2(judge.bestGain - judge.gain) + ' 分：' + eqText(judge.best.captured) + ' = 14')
      : '';
    this.recordDecision(judge, '出牌 +' + gain + ' 分', detail);
    if (!judge.optimal) toast('💡 非最优：' + detail);
    snd('flip');

    ui.mode = 'merging';
    ui.mergePlan = { tableId: tableCard.id, handIds: handCards.map((c) => c.id), stage: 'lock' };
    this._busy = true;
    this.log('🔗 你圈定 ' + eqText(move.captured) + ' = ' + sum + '。');
    this.setMessage('🔗 已圈住桌面的 ' + cardName(tableCard) + '：' + eqText(handCards) + ' = ' + sum + '，合牌中…');
    toast('圈定 ' + eqText(move.captured) + ' = ' + sum);
    this.render();

    // 第 1 拍：圈选锁定，手牌朝桌面那张牌飞过去
    this._after(() => {
      if (!ui.mergePlan) return;
      ui.mergePlan.stage = 'merge';
      this.render();
      // 第 2 拍：合拢完成，收进战利品
      this._after(() => {
        ui.mergePlan = null;
        this.finishPlayerMerge(move, gain);
      }, T_MERGE);
    }, T_RING_LOCK);
  },

  finishPlayerMerge(move, gain) {
    G.capture(game, 'player', move);
    ui.selHand = []; ui.selTable = null; ui.valid = false;
    const gotJoker = move.captured.some((c) => c.isJoker);
    snd(gotJoker ? 'joker' : 'match');
    this.log('✅ 合牌完成，你收获 ' + move.captured.length + ' 张 · +' + gain + ' 分。');
    toast('收获 ' + move.captured.length + ' 张 · +' + gain + ' 分');
    this.setData({ lootPulse: 'pLoot' });
    this._after(() => this.setData({ lootPulse: '' }), 700);
    this.render();
    // NPC 对玩家的战果有反应：被捞走王最心疼
    if (gotJoker) { toast('👑 连王一起捞走！'); this.npcSay('playerJoker'); }
    else if (gain >= 1.5) this.npcSay('playerBigLoot', 0.6);
    if (game.playerHand.length === 0) {
      // 手牌空了：从补牌堆拿 1 张补到桌面，再自动补满手牌
      const before = [];
      G.replaceAndRefill(game, 'player', null);
      const r = this.refillInfo('player', before);
      this.log('你手牌已空，从补牌堆补 1 张到桌面。');
      if (r.got > 0) this.log('补牌堆自动补 ' + r.got + ' 张到手牌（手牌 ' + r.total + ' 张）。');
      toast('手牌已空，自动补 ' + r.got + ' 张');
      snd('draw');
      ui.mode = 'idle';
      this.setMessage('✅ 匹配成功！手牌已空，已自动从补牌堆补 1 张到桌面。');
      this.render();
      this._after(() => { this._busy = false; this.endPlayerTurn(); }, T_HAND_OFF);
    } else {
      ui.mode = 'replace';
      this._busy = false;
      this.setMessage('✅ 匹配成功！点 1 张手牌补到桌面，之后自动从补牌堆补满手牌。');
      this.render();
    }
  },

  endPlayerTurn() {
    game.turn = 'npc';
    this.render();
    this.refreshOdds();   // 玩家这一回合定了 → 用最新局面重算胜率
    this.beginTurn();
  },

  // 供离线冒烟测试（mini-test.js）读取内部状态；页面自身不调用
  _peek() {
    return {
      game: game, ui: ui, odds: odds, decisions: decisions,
      busy: !!this._busy,   // 演出是否还在进行（测试用它精确推进"这一拍跑完好收手"）
      T: {
        RING_LOCK: T_RING_LOCK, MERGE: T_MERGE, PENALTY_OUT: T_PENALTY_OUT,
        NPC_THINK: T_NPC_THINK, NPC_POINT: T_NPC_POINT, NPC_LIFT: T_NPC_LIFT,
        NPC_FLIP: T_NPC_FLIP, NPC_READ: T_NPC_READ, NPC_MERGE: T_NPC_MERGE,
        HAND_OFF: T_HAND_OFF, SAY_MIN: T_SAY_MIN, SAY_MAX: T_SAY_MAX,
      },
    };
  },

  npcTurn() {
    ui.mode = 'idle'; ui.valid = false; ui.selHand = []; ui.selTable = null;
    ui.mergePlan = null; ui.penPlan = null;
    this.setMood('think');                     // 先摆出"思考"的表情
    this.setMessage('🤖 NPC 思考中…');
    this.setData({ npcShow: null, npcSpeak: null });
    this.render();
    this.npcSituationLine();                   // 有余力的轮次说句场面话

    // 第 ① 拍：思考完决定出哪手
    this._after(() => {
      const action = G.chooseNpcAction(game, effectiveDifficulty());
      if (action.type === 'match') {
        const captured = action.move.captured;   // 手牌在前，桌面那张在最后
        const n = captured.length;
        const sum = G.sumMatchValue(action.move.handCards) + action.move.tableCard.matchValue;
        const gain = Math.round(G.sumScore(captured) * 100) / 100;
        const gotJoker = captured.some((c) => c.isJoker);
        const eqParts = eqText(captured);

        // 第 ② 拍：卡通箭头指着它看中的那张桌面牌，其余桌面牌全部压暗
        ui.mode = 'merging';
        ui.mergePlan = { tableId: action.move.tableCard.id, handIds: [], stage: 'point', npc: true };
        this.setMood('think');
        this.setMessage('🤖 NPC 看中了桌面的 ' + cardName(action.move.tableCard) + '（箭头指着它，其余牌已压暗）');
        this.log('👀 NPC 看中了桌面的 ' + cardName(action.move.tableCard) + '（箭头指着它）。');
        snd('ring');
        this.render();

        // 第 ③ 拍：那张牌"抬起来"——我要的就是它
        this._after(() => {
          if (!ui.mergePlan || ui.mergePlan.stage !== 'point') return;
          ui.mergePlan.stage = 'lift';
          this.setMessage('☝️ NPC 把桌面的 ' + cardName(action.move.tableCard) + ' 抬了起来…');
          this.log('☝️ NPC 抬手要了桌面的 ' + cardName(action.move.tableCard) + '。');
          snd('tap');
          this.render();

          // 第 ④ 拍：浮层弹出（整屏压暗），把手上的牌一张一张翻过来
          this._after(() => {
            if (!ui.mergePlan || ui.mergePlan.stage !== 'lift') return;
            ui.mergePlan.stage = 'flip';
            this.setMood(gotJoker ? 'greedy' : 'happy');
            // 逐张揭示：每翻一张重建一次浮层内容并响一声，翻完最后一张再亮等式
            const reveal = (k) => {
              if (!ui.mergePlan || ui.mergePlan.stage !== 'flip') return;
              snd('flip');
              this.setData({ npcShow: npcShowData('🤖 NPC 一张张翻牌（' + k + '/' + n + '）', captured, k, '') });
              this.render();
              if (k < n) { this._after(() => reveal(k + 1), T_NPC_FLIP); return; }
              // 第 ⑤ 拍：全翻完了 → 等式和得分亮出来，停够你读完
              this._after(() => {
                if (!ui.mergePlan || ui.mergePlan.stage !== 'flip') return;
                ui.mergePlan.stage = 'read';
                this.setData({ npcShow: npcShowData('🤖 NPC 这手牌凑成了 14', captured, n,
                  eqParts + ' = ' + sum + ' ✅  收获 ' + n + ' 张 · +' + gain + ' 分') });
                this.log('🤖 NPC 亮牌：' + eqParts + ' = ' + sum + '，收获 ' + n + ' 张 · +' + gain + ' 分。');
                this.setMessage('🤖 NPC 这一手：' + eqParts + ' = ' + sum + '，收走 ' + n + ' 张（+' + gain + ' 分）。');
                snd(gotJoker ? 'joker' : 'npc');
                this.render();

                // 第 ⑥ 拍：才真正"匹配"——浮层收拢 → 入账 + 自动补牌
                this._after(() => {
                  if (!ui.mergePlan) return;
                  ui.mergePlan.stage = 'merge';
                  const show = this.data.npcShow;
                  this.setData({ npcShow: show ? Object.assign({}, show, { clearing: true }) : null });
                  this.setMessage('🔗 NPC 合牌：' + eqParts + ' = ' + sum + '，收走 ' + n + ' 张。');
                  this.log('🔗 NPC 合牌收走 ' + n + ' 张。');
                  this.render();

                  this._after(() => {
                    G.capture(game, 'npc', action.move);
                    const before = game.npcHand.map((c) => c.id);
                    G.replaceAndRefill(game, 'npc', action.replaceCardId);
                    const r = this.refillInfo('npc', before);
                    if (r.got > 0) this.log('NPC 自动补 ' + r.got + ' 张（手牌 ' + r.total + ' 张）。');
                    if (r.got > 0) snd('draw');
                    this.setData({ lootPulse: 'nLoot' });
                    this._after(() => this.setData({ lootPulse: '' }), 700);
                    toast('NPC 收获 ' + n + ' 张 · +' + gain + ' 分');
                    this.render();
                    this._after(() => {
                      ui.mergePlan = null;
                      ui.mode = 'idle';
                      this.setData({ npcShow: null, npcMood: 'idle' });
                      // 台词等亮牌浮层收掉之后再说，免得大娃娃和浮层挤在一起
                      if (gotJoker) this.npcSay('npcJoker');
                      else if (gain >= 2 || n >= 3) this.npcSay('npcBigLoot', 0.85);
                      else this.npcSay('npcMatch', 0.3);
                      this.finishNpcTurn();
                    }, 700);
                  }, T_NPC_MERGE);
                }, T_NPC_READ);
              }, 420);
            };
            reveal(1);
          }, T_NPC_LIFT);
        }, T_NPC_POINT);
      } else {
        // 罚牌：按规则隐藏，但把"无法匹配要罚牌"演清楚
        this.setMood('sad');
        snd('penalty');
        this.setData({ npcShow: { head: '🤖 NPC 无法匹配', masked: true, clearing: false, cards: [], eq: '罚牌 1 张（隐藏）' } });
        this.log('🤖 NPC 无法匹配，罚牌 1 张（隐藏）。');
        toast('NPC 罚牌 1 张（隐藏）');
        this._after(() => {
          this.setData({ npcShow: null });
          const before = game.npcHand.map((c) => c.id);
          G.penalty(game, 'npc', action.cardId); // 罚牌隐藏
          const r = this.refillInfo('npc', before);
          if (r.got > 0) this.log('NPC 罚牌后自动补 ' + r.got + ' 张（手牌 ' + r.total + ' 张）。');
          if (r.got > 0) snd('draw');
          this.setData({ lootPulse: 'nPen' });
          this._after(() => this.setData({ lootPulse: '' }), 700);
          this.render();
          this._after(() => {
            this.setData({ npcMood: 'idle' });
            this.npcSay('npcPenalty');
            this.finishNpcTurn();
          }, 900);
        }, 1300);
      }
    }, T_NPC_THINK);
  },

  finishNpcTurn() {
    game.turn = 'player';
    this.beginTurn();
  },

  showOver() {
    game.phase = 'gameover';
    const ps = G.computeScore(game, 'player');
    const ns = G.computeScore(game, 'npc');
    const winner = ps > ns ? '🎉 你赢了！' : ns > ps ? '🤖 NPC 赢了' : '🤝 平局！';
    const rd = A.rateDecisions(decisions);
    const sayEvent = ps < ns ? 'overWin' : ps > ns ? 'overLose' : 'overDraw';
    // 自适应档：把这局结果喂进去，可能升降档。本局已结算完毕，只影响下一局。
    let adaptMoved = 0;
    if (npcDifficulty === 'adaptive') adaptMoved = adaptFeed(ps > ns ? 'w' : ps < ns ? 'l' : 'd');
    const line = A.npcSay(sayEvent);
    const fmt = (arr) => arr.length ? arr.map((c) => c.label).join('、') : '（无）';
    this._sayGen = (this._sayGen || 0) + 1;   // 结算弹窗是主角，大娃娃让位
    this.setData({
      showOver: true,
      npcMood: ps < ns ? 'greedy' : ps > ns ? 'sad' : 'shock',
      npcSay: '',
      npcSpeak: null,
      diffDesc: diffDescText(),   // 自适应档可能刚升降过，侧栏说明跟着刷新
      over: {
        p: '你的得分：' + ps.toFixed(2),
        n: 'NPC 得分：' + ns.toFixed(2),
        winner: winner,
        say: line ? ('🤖 NPC：「' + line.text + '」') : '',
        rate: rd.total ? ('本局决策质量：' + rd.optimal + '/' + rd.total + ' 手最优 · 正确率 ' + rd.rate + '%') : '',
        adapt: npcDifficulty === 'adaptive'
          ? ('🎚 自适应：' + adaptSummary() + ' · 当前按「' + diffLabel(effectiveDifficulty()) + '」打'
             + (adaptMoved > 0 ? '（升档了）' : adaptMoved < 0 ? '（降档了）' : ''))
          : '',
        sections: [
          scoreSection('🧑 你的算分过程', 'me', game.playerLoot, game.playerPenalty, ps),
          scoreSection('🤖 NPC 的算分过程', 'npc', game.npcLoot, game.npcPenalty, ns),
        ],
        allCards: '你的战利品：' + fmt(game.playerLoot) + '\n你的罚牌：' + fmt(game.playerPenalty) +
          '\nNPC 战利品：' + fmt(game.npcLoot) + '\nNPC 罚牌：' + fmt(game.npcPenalty),
      },
    });
    snd(ps > ns ? 'win' : ps < ns ? 'lose' : 'drawEnd');
    this.log('本局结束。你 ' + ps + ' : NPC ' + ns + '。');
  },

  render() {
    if (!game) return;
    const g = game;
    // 对比上一帧，找出"新出现的牌"，让它们播入场动画
    const prev = this._snap;
    const freshList = (list, key) => (prev ? list.filter((id) => prev[key].indexOf(id) < 0) : list);
    const nT = freshList(g.table.map((c) => c.id), 'table');
    const nP = freshList(g.playerHand.map((c) => c.id), 'playerHand');
    const nN = freshList(g.npcHand.map((c) => c.id), 'npcHand');

    // 实时比分（罚牌是负分，已经从得分里扣掉了）
    const ps = G.computeScore(g, 'player');
    const ns = G.computeScore(g, 'npc');
    const diff = Math.round((ps - ns) * 100) / 100;

    const plan = ui.mergePlan;
    const isSel = g.turn === 'player' && ui.mode === 'select';

    // 桌面：被圈的牌（NPC 三拍演出 / 合牌目标）优先于普通选中
    const table = g.table.map((c) => {
      const isPlan = !!(plan && plan.tableId === c.id);
      const sel = isSel && ui.selTable === c.id;
      const st = isPlan ? plan.stage : '';
      return cardView(c, {
        isNew: nT.indexOf(c.id) >= 0,
        ringed: isPlan || sel,
        ringBad: sel && !ui.valid,
        // NPC 分拍演出：② 箭头指着它 → ③ 抬起来 → ④/⑤ 亮牌期间保持圈住 → ⑥ 合牌爆金光
        npcPoint: isPlan && (st === 'point' || st === 'lift' || st === 'flip' || st === 'read'),
        lifted: isPlan && st === 'lift',
        ringLock: isPlan && st === 'lock',
        mergeTarget: isPlan && st === 'merge',
        // NPC 回合：不是它要的那张就压暗 —— 视线只跟着箭头走，一眼看出它盯的是哪张
        dimmed: !!(plan && plan.npc && !isPlan),
        selected: sel && !isPlan,
      });
    });
    // 手牌：飞向桌面牌 / 罚牌飞走 / 普通选中
    const playerHand = g.playerHand.map((c) => {
      const flying = !!(plan && plan.stage === 'merge' && plan.handIds.indexOf(c.id) >= 0);
      const penOut = ui.penPlan === c.id;
      return cardView(c, {
        isNew: nP.indexOf(c.id) >= 0,
        mergeTo: flying,
        penOut: penOut,
        selected: (ui.mode === 'select' || ui.mode === 'replace') && ui.selHand.includes(c.id),
      });
    });
    const npcHand = g.npcHand.map((c, i) => ({ idx: i, isNew: nN.indexOf(c.id) >= 0 }));
    const logText = g.log.slice(-30).map((l) => '· ' + l).join('\n');
    const mine = g.turn === 'player';
    // 只有两个出口，且都不跳转模式：选好牌就匹配；只选 1 张就罚掉。没有"罚牌模式""返回"这些来回。
    const oneSel = ui.selHand.length === 1 ? g.playerHand.find((x) => x.id === ui.selHand[0]) : null;

    this.setData({
      table, playerHand, npcHand,
      drawCount: g.drawPile.length,
      playerCount: g.playerHand.length,
      npcCount: g.npcHand.length,
      pLoot: g.playerLoot.length,
      nLoot: g.npcLoot.length,
      pPen: g.playerPenalty.length,
      nPen: g.npcPenalty.length,
      // 实时比分：不用等结算就能看出现在谁领先、差多少（罚牌已经算进去了）
      scoreMe: ps.toFixed(2),
      scoreNpc: ns.toFixed(2),
      scoreLead: diff > 0 ? ('你领先 ' + diff.toFixed(2)) : diff < 0 ? ('NPC 领先 ' + (-diff).toFixed(2)) : '暂时打平',
      scoreLeadCls: diff > 0 ? 'me' : diff < 0 ? 'npc' : 'even',
      message: this._msg || '',
      showConfirm: !!(mine && ui.mode === 'select'),
      confirmLabel: ui.noMoves ? '✅ 确认匹配（当前凑不出）' : '✅ 确认匹配',
      confirmDisabled: !ui.valid,
      penLabel: oneSel ? ('🚫 罚掉 ' + cardName(oneSel)) : '🚫 罚掉选中的 1 张',
      penDisabled: !oneSel,
      logText,
    });

    // 补牌堆数字跳一下
    if (prev && prev.draw !== g.drawPile.length) {
      this.setData({ drawPulse: true });
      this._after(() => this.setData({ drawPulse: false }), 800);
    }

    // 比分变化时数字跳一下（一眼看到"刚才这一手值多少分"）
    if (prev && prev.ps !== undefined) {
      if (Math.abs(prev.ps - ps) > 1e-9) {
        this.setData({ scorePulse: 'me' });
        this._after(() => this.setData({ scorePulse: '' }), 780);
      } else if (Math.abs(prev.ns - ns) > 1e-9) {
        this.setData({ scorePulse: 'npc' });
        this._after(() => this.setData({ scorePulse: '' }), 780);
      }
    }

    this._snap = {
      table: g.table.map((c) => c.id),
      playerHand: g.playerHand.map((c) => c.id),
      npcHand: g.npcHand.map((c) => c.id),
      draw: g.drawPile.length,
      ps: ps,
      ns: ns,
    };
  },

  // 供测试开关模拟（不影响正常使用）
  _setSimEnabled(v) { simEnabled = !!v; },
  // 供测试关闭先手随机（保确定性，避免 NPC 先手的在途回调污染用例）
  _setFirstMoveRandom(v) { firstMoveRandom = !!v; },
  // 供测试：开局询问开关 + 自适应档位读写
  _setAskDiff(v) { setAskDiff(v); this.setData({ askNever: !askDiff }); },
  _getAskDiff() { return askDiff; },
  _setFirstRunPending(v) { firstRunPending = !!v; },
  _getPendingDiff() { return pendingDiff; },
  _effectiveDifficulty() { return effectiveDifficulty(); },
  _getAdapt() { return { level: adaptLevel, hist: adaptHist.slice(), effective: effectiveDifficulty(), summary: adaptSummary() }; },
  _setAdapt(lv, hist) {
    if (typeof lv === 'number' && lv >= 0 && lv <= 3) adaptLevel = lv;
    if (Array.isArray(hist)) adaptHist = hist.slice(-ADAPT_W);
    saveAdapt();
  },
  _adaptFeed(r) { return adaptFeed(r); },
});
