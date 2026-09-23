// 欢乐十四分 · 界面与回合控制（Electron 与浏览器共用）
// Electron 下用 require；浏览器下（play.html）已把内核/顾问/音效挂到 window 上
const G = (typeof require !== 'undefined') ? require('./game-core.js') : window.G;
const A = (typeof require !== 'undefined') ? require('./advisor.js') : (window.ADVISOR || null);
const SFX = (typeof require !== 'undefined') ? require('./sfx.js') : (window.SFX || null);

// 音效安全调用：环境不支持音频（Node 测试）或没加载到模块时静默跳过
const snd = (name) => { try { if (SFX && typeof SFX[name] === 'function') SFX[name](); } catch (e) { /* 忽略 */ } };

// 分步演出的节奏（毫秒）。改这几个数就能整体调快/调慢。
const T_RING_LOCK = 320;   // 圈选锁定 → 手牌开始飞
const T_MERGE = 640;       // 手牌飞到桌面牌上合拢
const T_PENALTY_OUT = 420; // 罚牌：被弃的牌飞走
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

// 胜率模拟：每批多少局、总共多少局（单局约 0.2ms，分两批不阻塞界面）
const SIM_CHUNK = 150;
const SIM_TOTAL = 300;

let state = null;
let ui = {
  selHand: [],            // 已选手牌 id（选牌阶段唯一的"选中"语义：既用于匹配，也用于罚牌）
  selTable: null,         // 已选桌面牌 id
  noMoves: false,         // true = 系统检测这手牌确实凑不出（只影响提示语，不替玩家做决定）
  mergePlan: null,        // { tableId, handIds, stage:'point'|'lock'|'merge', npc:bool } 分步合牌
  penPlan: null,          // 正在飞走的罚牌 id
  mode: 'idle',           // idle | select | merging | penalizing | replace
  valid: false,
};
// 上一帧各区域的牌 id / 补牌堆数量：用来识别"新出现的牌"并播放入场动画
let snap = null;
// 局次令牌：动画是分拍的，若中途点了"新游戏"，旧回调必须作废，否则会拿过期牌去改新牌局
let episode = 0;
// 本局玩家的决策质量（是否最优）
let decisions = { total: 0, optimal: 0 };
// 胜率模拟：结果 + 在途任务（批次计数，避免过期结果覆盖新局）
let odds = { win: 0, lose: 0, draw: 0, n: 0, done: 0, target: 0, running: false, ep: -1 };
let simEnabled = true;   // 测试里关掉，避免几百局模拟拖慢冒烟测试

// 难度（仅影响 NPC 强度；玩家永远是"人"）；默认中等，localStorage 持久化
let npcDifficulty = 'medium';
// 先手随机：生产默认 true（按用户要求，不一直是玩家先手）；测试可关掉保确定性
let firstMoveRandom = true;
// 五档难度的一句话说明（侧栏难度条下方显示）
const DIFF_DESC = {
  easy:   '容易：NPC 大半随缘出牌，还常把高分牌送给你。',
  medium: '中等：NPC 一步贪心，盯着当下最赚的走。',
  hard:   '难：NPC 出牌照贪心，但补到桌面那张专挑"最不喂你"的。',
  hell:   '地狱：NPC 每种打法都推演到终局再挑，几乎算死你。',
};
const diffLabel = (d) => ({ easy: '容易', medium: '中等', hard: '难', hell: '地狱' }[d] || d);

// 手机版整体降一档：只有构建时注入 window.H14_EASY_SHIFT=1 才生效（tools-standalone.js 的手机变体）。
// 桌面单机版 / Electron / 小程序没有这个标记，走原值，行为零变化。
// 映射：地狱→难、难→中等、中等→容易、容易→容易（已是最低不再降）。
const H14_SHIFT = (typeof window !== 'undefined' && window.H14_EASY_SHIFT)
  ? { hell: 'hard', hard: 'medium', medium: 'easy', easy: 'easy' } : null;
// 真正传给内核的档位（桌面/小程序原样返回；手机版在此统一降一档）
function effectiveDifficulty() {
  const d = npcDifficulty;
  return (H14_SHIFT && H14_SHIFT[d]) || d;
}
// ---------- 开局难度询问（用户要求：新开局先问一句） ----------
// 每次开局前弹一下，5 档任选（默认停在当前档）；勾"不再问"就永久跳过，随时可在侧栏改。
let askDiff = true;
let firstRunPending = false;   // 首玩：先开局，再把玩法说明盖上来
function loadAskDiff() {
  try {
    if (typeof localStorage === 'undefined') return;
    // 只在"确实存过"时才覆盖：存储里没有 = 用默认值（否则测试里先设的开关会被悄悄改回去）
    const v = localStorage.getItem('h14_askdiff');
    if (v === '0') askDiff = false;
    else if (v === '1') askDiff = true;
  } catch (e) {}
}
function setAskDiff(v) {
  askDiff = !!v;
  try { if (typeof localStorage !== 'undefined') localStorage.setItem('h14_askdiff', askDiff ? '1' : '0'); } catch (e) {}
}


const $ = (id) => document.getElementById(id);

function log(msg) { state.log.push(msg); renderLog(); }

function setMessage(msg) { $('message').textContent = msg; }

// 延时执行且"绑定当前局次"：中途开了新游戏，这一步自动作废（否则旧回调会改到新牌局）
function after(ms, fn) {
  if (typeof setTimeout !== 'function') return;
  const ep = episode;
  setTimeout(() => { if (ep === episode) fn(); }, ms);
}

// ---------- 通用小工具 ----------
function queryChild(el, sel) {
  return (el && typeof el.querySelector === 'function') ? el.querySelector(sel) : null;
}
// 元素中心点（拿不到布局就返回 null，动画退回"固定方向飞"）
function centerOf(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return null;
  const r = el.getBoundingClientRect();
  if (!r || (!r.width && !r.height)) return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
// 牌面等式文案：2♦ + 10♣ + 2♦
function eqText(cards) {
  return cards.map((c) => (c.short ? c.short + c.suitSymbol : c.label + c.suitSymbol)).join(' + ');
}
function cardName(c) { return c.short + c.suitSymbol; }

// ---------- NPC 卡通形象：一只歪戴棒球帽、叼着牙签的小痞机器人 ----------
// 表情全靠"眉毛 / 眼睛 / 嘴"三个零件换，外加贪心的星星眼、沮丧的泪滴。
// 小尺寸（座位头像 50px）能看清主特征，大尺寸（大娃娃）能看清细节。
const NC = '#2b2b2b';   // 统一描边色
const NPC_FACES = {
  idle: {
    halo: '#8fb8ff', bulb: '#a9d8ff', cheek: true,
    brow: '<path d="M20 26.5 h10.5" stroke="' + NC + '" stroke-width="2.6" stroke-linecap="round"/>' +
          '<path d="M41.5 26.5 h10.5" stroke="' + NC + '" stroke-width="2.6" stroke-linecap="round"/>',
    eye: '<circle cx="26" cy="34" r="5.4" fill="' + NC + '"/><circle cx="46" cy="34" r="5.4" fill="' + NC + '"/>' +
         '<circle cx="27.9" cy="31.9" r="1.8" fill="#fff"/><circle cx="47.9" cy="31.9" r="1.8" fill="#fff"/>',
    mouth: '<path d="M30.5 45 q5.5 5 11 0" stroke="' + NC + '" stroke-width="3" fill="none" stroke-linecap="round"/>',
    extra: '<path d="M46 44.5 l8 -7" stroke="#e0b74a" stroke-width="2.4" stroke-linecap="round"/>',  // 牙签
  },
  think: {
    halo: '#c9a9ff', bulb: '#c9a9ff', cheek: false,
    brow: '<path d="M20 28 h10.5" stroke="' + NC + '" stroke-width="2.6" stroke-linecap="round"/>' +
          '<path d="M41.5 25.5 h10.5" stroke="' + NC + '" stroke-width="2.6" stroke-linecap="round"/>',  // 一高一低＝疑惑
    eye: '<circle cx="26" cy="34" r="6" fill="#fff" stroke="' + NC + '" stroke-width="2"/>' +
         '<circle cx="46" cy="34" r="6" fill="#fff" stroke="' + NC + '" stroke-width="2"/>' +
         '<circle cx="28.4" cy="33.2" r="2.8" fill="' + NC + '"/><circle cx="48.4" cy="33.2" r="2.8" fill="' + NC + '"/>',  // 眼珠瞟向一边
    mouth: '<circle cx="38" cy="46" r="2.7" fill="' + NC + '"/>',
  },
  happy: {
    halo: '#ffcf4d', bulb: '#ffcf4d', cheek: true,
    brow: '<path d="M20 25.5 q5.3 -4 10.5 0" stroke="' + NC + '" stroke-width="2.6" fill="none" stroke-linecap="round"/>' +
          '<path d="M41.5 25.5 q5.3 -4 10.5 0" stroke="' + NC + '" stroke-width="2.6" fill="none" stroke-linecap="round"/>',
    eye: '<path d="M20 35.5 q6 -8.5 12 0" stroke="' + NC + '" stroke-width="3.6" fill="none" stroke-linecap="round"/>' +
         '<path d="M40 35.5 q6 -8.5 12 0" stroke="' + NC + '" stroke-width="3.6" fill="none" stroke-linecap="round"/>',
    mouth: '<path d="M29 43 q7 12 14 0 z" fill="' + NC + '"/>' +
           '<path d="M32 47.5 q4 3.4 8 0" stroke="#ff9ec4" stroke-width="2.4" fill="none"/>',
    extra: '<path d="M46 44.5 l8 -7" stroke="#e0b74a" stroke-width="2.4" stroke-linecap="round"/>',
  },
  greedy: {
    halo: '#ffd86b', bulb: '#ffd86b', cheek: true,
    brow: '<path d="M20 25 q5.3 -5 10.5 -1.5" stroke="' + NC + '" stroke-width="2.6" fill="none" stroke-linecap="round"/>' +
          '<path d="M41.5 23.5 q5.3 -3.5 10.5 1.5" stroke="' + NC + '" stroke-width="2.6" fill="none" stroke-linecap="round"/>',
    // 星星眼（四角星）——看到好牌就变财迷
    eye: '<path d="M26 27 L28.1 31.9 L33 34 L28.1 36.1 L26 41 L23.9 36.1 L19 34 L23.9 31.9 Z" fill="#ffcf4d" stroke="' + NC + '" stroke-width="1.8" stroke-linejoin="round"/>' +
         '<path d="M46 27 L48.1 31.9 L53 34 L48.1 36.1 L46 41 L43.9 36.1 L39 34 L43.9 31.9 Z" fill="#ffcf4d" stroke="' + NC + '" stroke-width="1.8" stroke-linejoin="round"/>',
    mouth: '<path d="M28.5 43 q7.5 13 15 0 z" fill="' + NC + '"/>' +
           '<path d="M32 48 q4 3.6 8 0" stroke="#ff9ec4" stroke-width="2.6" fill="none"/>',
    extra: '<path d="M46.5 44 l8 -7" stroke="#e0b74a" stroke-width="2.4" stroke-linecap="round"/>' +
           '<ellipse cx="45" cy="53" rx="1.9" ry="2.8" fill="#8fd0ff" stroke="' + NC + '" stroke-width="1"/>',  // 馋出口水
  },
  shock: {
    halo: '#ffb3c6', bulb: '#ffb3c6', cheek: false,
    brow: '<path d="M20 24 q5.3 -5.5 10.5 -1.5" stroke="' + NC + '" stroke-width="2.6" fill="none" stroke-linecap="round"/>' +
          '<path d="M41.5 22.5 q5.3 -4 10.5 1.5" stroke="' + NC + '" stroke-width="2.6" fill="none" stroke-linecap="round"/>',
    eye: '<circle cx="26" cy="34" r="6.4" fill="#fff" stroke="' + NC + '" stroke-width="2"/>' +
         '<circle cx="46" cy="34" r="6.4" fill="#fff" stroke="' + NC + '" stroke-width="2"/>' +
         '<circle cx="26.4" cy="34" r="2.4" fill="' + NC + '"/><circle cx="46.4" cy="34" r="2.4" fill="' + NC + '"/>',  // 瞳孔缩成一点
    mouth: '<ellipse cx="36" cy="48" rx="5" ry="7" fill="' + NC + '"/>',  // 下巴掉了
  },
  sad: {
    halo: '#c9c1b4', bulb: '#c9c1b4', cheek: false,
    brow: '<path d="M20 28 l10.5 -3" stroke="' + NC + '" stroke-width="2.6" stroke-linecap="round"/>' +
          '<path d="M41.5 25 l10.5 3" stroke="' + NC + '" stroke-width="2.6" stroke-linecap="round"/>',  // 八字眉
    eye: '<path d="M20.4 34 a5.6 5.6 0 0 0 11.2 0 z" fill="' + NC + '"/>' +
         '<path d="M40.4 34 a5.6 5.6 0 0 0 11.2 0 z" fill="' + NC + '"/>',  // 眼皮耷拉
    mouth: '<path d="M30 49 q6 -6 12 0" stroke="' + NC + '" stroke-width="3" fill="none" stroke-linecap="round"/>',
    extra: '<path d="M21 40 q2.6 3.2 0 5 q-2.6 -1.8 0 -5 z" fill="#8fd0ff" stroke="' + NC + '" stroke-width="1"/>',  // 眼泪
  },
};

function npcFaceSvg(mood) {
  const f = NPC_FACES[mood] || NPC_FACES.idle;
  return '<svg viewBox="0 0 72 72" width="100%" height="100%" aria-hidden="true">' +
    '<circle cx="36" cy="38" r="31" fill="' + f.halo + '"/>' +
    // 天线小灯泡（颜色跟着表情走）
    '<path d="M36 11 v-5" stroke="' + NC + '" stroke-width="2.4" stroke-linecap="round"/>' +
    '<circle cx="36" cy="5" r="3.2" fill="' + f.bulb + '" stroke="' + NC + '" stroke-width="1.8"/>' +
    // 耳机（压在脑袋两侧下面）
    '<circle cx="12.5" cy="38" r="4.8" fill="#ffd9a0" stroke="' + NC + '" stroke-width="2.4"/>' +
    '<circle cx="59.5" cy="38" r="4.8" fill="#ffd9a0" stroke="' + NC + '" stroke-width="2.4"/>' +
    // 大脑袋
    '<rect x="12" y="19" width="48" height="42" rx="17" fill="#fdf6e6" stroke="' + NC + '" stroke-width="3"/>' +
    // 反扣的棒球帽 + 翘起来的帽檐
    '<path d="M14 22 Q36 3 58 22 Z" fill="#5b7fe0" stroke="' + NC + '" stroke-width="3" stroke-linejoin="round"/>' +
    '<ellipse cx="56" cy="17" rx="12" ry="4.8" transform="rotate(-16 56 17)" fill="#4361c0" stroke="' + NC + '" stroke-width="2.4"/>' +
    (f.cheek ? '<ellipse cx="19" cy="43" rx="5" ry="3.6" fill="#ff9ec4" opacity="0.8"/>' +
               '<ellipse cx="53" cy="43" rx="5" ry="3.6" fill="#ff9ec4" opacity="0.8"/>' : '') +
    (f.brow || '') + f.eye + f.mouth + (f.extra || '') +
    '</svg>';
}

// ---------- NPC 说话：重要台词弹"大娃娃"，碎嘴只走座位小气泡 ----------
let speakGen = 0;   // 说话代次：连续说话时只有最后一次的回调该关掉浮层
function npcSay(event, chance) {
  if (!A || !A.npcSay || !state || state.phase === 'gameover') return;
  const line = A.npcSay(event, { chance: chance });
  if (!line) return;
  setNpcMood(line.mood);
  if (line.big) showNpcSpeak(line.text, line.mood);  // 关键情境：跳出大卡通娃娃
  else {
    hideNpcSpeak();                                  // 新台词顶掉上一条大娃娃，别让它站旁边说旧话
    showNpcBubble(line.text);                        // 普通碎嘴：座位小气泡，不打扰
  }
}
function setNpcMood(mood) {
  const el = $('npcAvatar');
  if (el) el.innerHTML = npcFaceSvg(mood);
}
let bubbleGen = 0;  // 气泡代次：连续两次说话时，旧定时器不许提前关掉新气泡
function showNpcBubble(text) {
  const el = $('npcSay');
  if (!el) return;
  el.textContent = text;
  if (el.classList) { el.classList.remove('hidden'); el.classList.add('show'); }
  const g = ++bubbleGen;
  after(sayDur(text), () => {
    if (g === bubbleGen && el.classList) { el.classList.remove('show'); el.classList.add('hidden'); }
  });
}
function hideNpcBubble() {
  bubbleGen++;
  const el = $('npcSay');
  if (el && el.classList) { el.classList.remove('show'); el.classList.add('hidden'); }
}
// 大娃娃：蹦出一个放大的卡通头像 + 对话气泡，说完自己退场
function showNpcSpeak(text, mood) {
  const host = $('npcSpeak');
  if (!host) return;
  const face = $('npcSpeakFace');
  if (face) face.innerHTML = npcFaceSvg(mood || 'idle');
  const t = $('npcSpeakText');
  if (t) t.textContent = text;
  if (host.classList) host.classList.remove('hidden');
  speakGen++;
  const g = speakGen;
  after(sayDur(text), () => { if (g === speakGen && host.classList) host.classList.add('hidden'); });
}
function hideNpcSpeak() {
  speakGen++;
  const el = $('npcSpeak');
  if (el && el.classList) el.classList.add('hidden');
}
// 按当前局势挑一句"场面话"（领先/落后/残局）
function npcSituationLine() {
  if (!state || state.phase === 'gameover') return;
  const diff = G.computeScore(state, 'npc') - G.computeScore(state, 'player');
  if (state.drawPile.length <= 8) { npcSay('lowDraw'); return; }
  if (diff >= 3) { npcSay('ahead', 0.5); return; }
  if (diff <= -3) { npcSay('behind', 0.5); }
}

// ---------- 胜率估计（蒙特卡洛，分批跑不卡界面） ----------
let oddsGen = 0;
function resetOdds() {
  oddsGen++;
  odds = { win: 0, lose: 0, draw: 0, n: 0, done: 0, target: 0, running: false, ep: episode };
  renderOdds();
}
function refreshOdds(immediate) {
  if (!simEnabled || !A || !A.simulateOne || !state || state.phase === 'gameover') return;
  resetOdds();
  odds.running = true;
  odds.target = SIM_TOTAL;
  odds.ep = episode;
  const job = { gen: oddsGen, ep: episode };
  after(immediate ? 0 : 260, () => stepOdds(job)); // 等这一拍的动画先走完再算
}
function stepOdds(job) {
  if (!job || job.gen !== oddsGen || job.ep !== episode) return; // 中途开新局 / 已重算 → 作废
  for (let i = 0; i < SIM_CHUNK && odds.done < odds.target; i++) {
    const r = A.simulateOne(state, undefined, effectiveDifficulty());   // NPC 按当前实际档位模拟
    if (r > 0) odds.win++; else if (r < 0) odds.lose++; else odds.draw++;
    odds.done++;
  }
  odds.n = odds.done;
  renderOdds();
  if (odds.done < odds.target) after(16, () => stepOdds(job));
  else odds.running = false;
}
function renderOdds() {
  const n = odds.n || 0;
  const pc = (x) => (n ? Math.round((x / n) * 100) : null);
  const set = (id, v) => { const el = $(id); if (el) el.textContent = (v == null ? '—' : v); };
  set('oddsWin', n ? (pc(odds.win) + '%') : '—');
  set('oddsLose', n ? (pc(odds.lose) + '%') : '—');
  set('oddsDraw', n ? (pc(odds.draw) + '%') : '—');
  set('oddsN', n ? (n + ' 局') : '计算中…');
  const bar = $('oddsBar');
  if (bar) bar.innerHTML = n
    ? '<i class="odds-me" style="width:' + ((odds.win / n) * 100).toFixed(1) + '%"></i>' +
      '<i class="odds-draw" style="width:' + ((odds.draw / n) * 100).toFixed(1) + '%"></i>' +
      '<i class="odds-npc" style="width:' + ((odds.lose / n) * 100).toFixed(1) + '%"></i>'
    : '';
  const rd = A ? A.rateDecisions(decisions) : null;
  set('decisionRate', rd && rd.total ? (rd.optimal + '/' + rd.total + ' 最优 · ' + rd.rate + '%') : '—');
}
// 记一次决策是否最优，并给出即时反馈
function recordDecision(judge, kind, detail) {
  decisions.total++;
  if (judge && judge.optimal) decisions.optimal++;
  renderOdds();
  if (judge && judge.optimal) {
    log('📈 最优判断：' + kind + ' ✅ 这是本回合最赚的一手。');
  } else if (judge) {
    log('📈 最优判断：' + kind + ' ⚠️ 不是最优 —— ' + (detail || '还有更赚的一手。'));
  }
}

// ---------- 视觉动作（补牌/匹配要有"动作"，不能凭空冒出来） ----------
function fxHost() {
  let host = $('fx');
  if (host) return host;
  host = document.createElement('div');
  host.className = 'fx';
  if (document.body && typeof document.body.appendChild === 'function') document.body.appendChild(host);
  return host;
}

// 浮动提示：匹配得分、补牌到账等即时反馈
function toast(text, kind) {
  const host = fxHost();
  if (!host || typeof host.appendChild !== 'function') return;
  const d = document.createElement('div');
  d.className = 'toast' + (kind ? ' ' + kind : '');
  d.textContent = text;
  host.appendChild(d);
  if (typeof setTimeout === 'function') {
    setTimeout(() => { if (typeof host.removeChild === 'function') host.removeChild(d); }, 1500);
  }
}

// 数字跳一下：补牌堆 / 战利品 / 罚牌计数
function pulseEl(id, cls) {
  const el = $(id);
  if (!el || !el.classList) return;
  const c = cls || 'pulse';
  el.classList.add(c);
  if (typeof setTimeout === 'function') setTimeout(() => el.classList.remove(c), 800);
}
function pulseDrawPile() { pulseEl('drawCount', 'pulse'); }

// ---------- 先手宣告（开局先亮一下谁先出，免得"哗一下就开始"太突兀） ----------
function announceFirst() {
  const b = $('firstBanner');
  if (!b || !b.classList) return;   // 桩环境/旧页面没有这个元素 → 静默跳过
  const t = $('firstBannerText');
  if (t) t.textContent = (state.turn === 'player') ? '你先手' : 'NPC 先手';
  b.classList.remove('hidden');
  after(1600, () => b.classList.add('hidden'));   // 绑局次：中途重开自动作废
}

// ---------- 流程 ----------
function newGame() {
  state = G.createGame({ numDecks: 2, firstRandom: firstMoveRandom });
  episode++; // 作废所有在途动画回调
  // 就地重置 ui，保持对象引用稳定（测试入口持有它）
  ui.selHand = []; ui.selTable = null;
  ui.noMoves = false; ui.mergePlan = null; ui.penPlan = null;
  ui.mode = 'idle'; ui.valid = false;
  snap = null; // 清空快照：新一局发牌全部播入场动画
  decisions = { total: 0, optimal: 0 };
  resetOdds();
  $('overModal').classList.add('hidden');
  hideNpcShow();
  hideNpcSpeak();
  setNpcMood('idle');
  hideNpcBubble();
  const eSh = H14_SHIFT && H14_SHIFT[npcDifficulty];
  const dl = diffLabel(npcDifficulty) + (eSh && eSh !== npcDifficulty ? '·实按' + diffLabel(eSh) : '');
  log('🎴 新一局开始！' + (state.turn === 'player' ? '你先手' : 'NPC 先手') + '（难度：' + dl + '）。');
  announceFirst();   // 大字亮一下谁先手，1.6 秒自动淡出
  snd('deal');     // 发牌音效：开局哗啦一下
  snd('start');      // 开局号角（浏览器首次加载时音频还没解锁，静默跳过，不算 bug）
  beginTurn();
  renderAll();
  npcSay('start');   // NPC 开局先打个招呼
}

function beginTurn() {
  if (G.isGameOver(state)) { showOver(); return; }
  if (state.turn === 'player') {
    if (state.playerHand.length === 0) { state.turn = 'npc'; beginTurn(); return; }
    playerTurnStart();
  } else {
    if (state.npcHand.length === 0) { state.turn = 'player'; beginTurn(); return; }
    npcTurn();
  }
}

function playerTurnStart() {
  const moves = G.findMoves(state.playerHand, state.table);
  ui.selHand = []; ui.selTable = null; ui.valid = false;
  ui.mergePlan = null; ui.penPlan = null;
  ui.mode = 'select';           // 永远进"选牌模式"：即使系统判定无解，也由玩家自己按下罚牌
  ui.noMoves = moves.length === 0;
  if (ui.noMoves) {
    setMessage('⚠️ 系统检测：这手牌和桌面 6 张凑不出 14。点 1 张手牌，再点「🚫 罚掉这张」放弃本回合。');
  } else {
    setMessage('点手牌 + 点桌面 1 张，凑「= 14」；想放弃就只点 1 张手牌，再点「🚫 罚掉这张」。');
  }
  renderControls();
  renderAll();
  refreshOdds();   // 轮到玩家 → 后台更新胜率估计
}

// 罚牌（玩家自己决定的一次放弃）：选中恰好 1 张手牌 → 点罚牌按钮即可，不再有"模式切换"
function doPenalty() {
  if (state.turn !== 'player' || ui.mode !== 'select' || ui.penPlan) return;
  if (ui.selHand.length !== 1) return;
  const card = state.playerHand.find((c) => c.id === ui.selHand[0]);
  if (!card) { ui.selHand = []; renderAll(); return; }
  const ep = episode;
  // 罚牌是否最优：本来就无解 → 罚牌是唯一选择；明明有解却罚牌 → 白丢一次收益
  const judge = A ? A.judgePenalty(state.playerHand, state.table) : null;
  if (judge) {
    recordDecision(judge, '罚牌',
      judge.hasMove ? ('你明明能出：' + eqText(judge.best.captured) + ' = 14（+' + judge.bestGain + ' 分）') : '');
    if (judge.hasMove) toast('💡 其实能出：' + eqText(judge.best.captured) + ' = 14', 'warn');
  }
  snd('penalty');
  ui.mode = 'penalizing';
  ui.penPlan = card.id;
  setMessage('🚫 已扣下 ' + cardName(card) + '（隐藏），正在补牌…');
  renderAll();
  renderControls();
  setTimeout(() => {
    if (ep !== episode) return;
    ui.penPlan = null;
    const before = state.playerHand.map((c) => c.id);
    G.penalty(state, 'player', card.id);
    const r = refillInfo('player', before);
    ui.selHand = []; ui.selTable = null;
    log('🚫 你罚牌 1 张（' + cardName(card) + '，隐藏）。');
    if (r.got > 0) log('补牌堆自动补 ' + r.got + ' 张到手牌（手牌 ' + r.total + ' 张）。');
    toast(r.got > 0 ? '罚牌 −1，补牌 +' + r.got : '罚牌 −1（补牌堆已空，不再补）', 'warn');
    pulseEl('pPen', 'pulse');
    if (r.got > 0) { snd('draw'); pulseDrawPile(); }
    ui.mode = 'idle';
    renderAll();
    npcSay('playerPenalty', 0.5);
    after(T_HAND_OFF, endPlayerTurn);
  }, T_PENALTY_OUT);
}

// 从补牌堆补了几张到手牌（谁的手牌由 who 决定），用于日志与提示文案
function refillInfo(who, beforeIds) {
  const hand = who === 'player' ? state.playerHand : state.npcHand;
  const got = hand.filter((c) => beforeIds.indexOf(c.id) < 0).length;
  return { got: got, total: hand.length };
}

function onHandClick(card) {
  if (state.turn !== 'player' || state.phase === 'gameover' || !state) return;
  if (ui.mode === 'select') {
    // 统一"选中/取消"语义：选中的牌既可以拿去匹配，也可以拿去罚掉，由下面那个按钮决定
    const i = ui.selHand.indexOf(card.id);
    if (i >= 0) ui.selHand.splice(i, 1); else ui.selHand.push(card.id);
    snd('tap');
    updateSelectSum();
    renderAll();
  } else if (ui.mode === 'replace') {
    // 补到桌面的牌 = 送给对手的牌，但要两头看：
    //   ① 送出去亏多少 → 期望送分 = 分值 × 预计被吃走的概率（未知牌池 + 精确枚举算，不偷看对手手牌）
    //   ② 留在手上还值多少 → 这张牌以后能不能帮我凑 14（"留后路"）
    // 两者相减得净收益，取最高的那手。只看①会让人把好牌早早扔掉。
    const judge = A ? A.judgeReplace(state.playerHand, state.table, [], card.id, {
      unknown: G.unknownPool(state),
      oppHandSize: state.npcHand.length,
    }) : null;
    if (judge && state.turn === 'player' && judge.chosen) {
      const mine = judge.chosen, alt = judge.suggest;
      const desc = (x) => '「' + cardName(x.card) + '」值 ' + x.score.toFixed(2) + ' 分、估计 ' + x.riskPct +
        '% 会被对手吃走 → 期望送 ' + x.cost.toFixed(2) + ' 分' +
        (x.path > 0 ? '，留手上还能再赚 ' + x.path.toFixed(2) + ' 分' : '（留手上也没用）');
      const tip = (judge.optimal || !alt) ? null : (desc(mine) + '；' + desc(alt) + '，更划算。');
      recordDecision(judge, '补牌到桌面', tip);
      if (judge.optimal) {
        toast(mine.path > 0
          ? '补牌合理 ✅ 送 ' + mine.cost.toFixed(2) + ' 分，' + cardName(mine.card) + ' 留着还能赚 ' + mine.path.toFixed(2) + ' 分'
          : '补牌合理 ✅ 期望送 ' + mine.cost.toFixed(2) + ' 分', 'good');
      } else {
        toast('💡 换个思路：「' + cardName(alt.card) + '」净收益 ' + alt.net.toFixed(2) +
          ' 分，你这张 ' + mine.net.toFixed(2) + ' 分', 'warn');
      }
    }
    const before = state.playerHand.map((c) => c.id);
    G.replaceAndRefill(state, 'player', card.id);
    const r = refillInfo('player', before);
    log('你把 1 张手牌补到桌面。');
    if (r.got > 0) log('补牌堆自动补 ' + r.got + ' 张到手牌（手牌 ' + r.total + ' 张）。');
    toast(r.got > 0 ? '补牌 +' + r.got + ' → 手牌 ' + r.total + ' 张' : '补牌堆已空，不再补牌', 'good');
    if (r.got > 0) snd('draw');
    if (r.got > 0) pulseDrawPile();
    ui.mode = 'idle';
    renderAll();
    after(T_HAND_OFF, endPlayerTurn); // 留一拍，让补牌动画演完再轮到 NPC
  }
}

function onTableClick(card) {
  if (state.turn !== 'player' || ui.mode !== 'select') return;
  ui.selTable = ui.selTable === card.id ? null : card.id;
  snd('ring');
  updateSelectSum();
  renderAll();
}

function updateSelectSum() {
  const handCards = state.playerHand.filter((c) => ui.selHand.includes(c.id));
  const tableCard = state.table.find((c) => c.id === ui.selTable);
  const sum = G.sumMatchValue(handCards) + (tableCard ? tableCard.matchValue : 0);
  const ok = ui.selHand.length > 0 && !!tableCard && sum === 14;
  ui.valid = ok;
  let msg = '当前和：' + sum + (ok ? ' ✅ 可以匹配！' : ' ❌');
  if (!ok && ui.selHand.length === 1) msg += '　（只想放弃？点「🚫 罚掉」）';
  if (!ok && ui.selHand.length > 1) msg += '　（罚牌只能罚 1 张：点掉多余的手牌）';
  setMessage(msg);
  renderControls();
}

// 匹配：分三步走完（圈住 → 手牌飞过去合拢 → 收进战利品），每一步都看得见
function confirmMatch() {
  if (!ui.valid || ui.mode !== 'select') return;
  const handCards = state.playerHand.filter((c) => ui.selHand.includes(c.id));
  const tableCard = state.table.find((c) => c.id === ui.selTable);
  const move = { handCards, tableCard, captured: handCards.concat([tableCard]) };
  const gain = Math.round(G.sumScore(move.captured) * 100) / 100;
  const sum = G.sumMatchValue(handCards) + tableCard.matchValue;
  const ep = episode;

  // 出牌是否最优：和本回合所有合法走法里最赚的那手比（判优标准：分值 → 王数 → 用掉的手牌张数）
  const judge = A ? A.judgeMatch(state.playerHand, state.table, ui.selHand, ui.selTable) : null;
  if (judge) {
    const detail = judge.best
      ? ('还有一手' + (judge.why ? judge.why + '：' : '') + eqText(judge.best.captured) + ' = 14')
      : '';
    recordDecision(judge, '出牌 +' + gain + ' 分', detail);
    if (!judge.optimal) toast('💡 非最优：' + detail, 'warn');
  }
  snd('flip');

  ui.mode = 'merging';
  ui.mergePlan = { tableId: tableCard.id, handIds: handCards.map((c) => c.id), stage: 'lock' };
  log('🔗 你圈定 ' + eqText(move.captured) + ' = ' + sum + '。');
  setMessage('🔗 已圈住桌面的 ' + cardName(tableCard) + '：' + eqText(handCards) + ' = ' + sum + '，合牌中…');
  toast('圈定 ' + eqText(move.captured) + ' = ' + sum, 'good');
  renderControls();
  renderAll();

  // 第 1 拍：圈选锁定，手牌朝桌面那张牌飞过去
  setTimeout(() => {
    if (ep !== episode || !ui.mergePlan) return;
    ui.mergePlan.stage = 'merge';
    renderAll();
    // 第 2 拍：合拢完成，收进战利品
    setTimeout(() => {
      if (ep !== episode || !ui.mergePlan) return;
      ui.mergePlan = null;
      finishPlayerMerge(move, gain);
    }, T_MERGE);
  }, T_RING_LOCK);
}

function finishPlayerMerge(move, gain) {
  G.capture(state, 'player', move);
  ui.selHand = []; ui.selTable = null; ui.valid = false;
  const gotJoker = move.captured.some((c) => c.isJoker);
  snd(gotJoker ? 'joker' : 'match');
  log('✅ 合牌完成，你收获 ' + move.captured.length + ' 张 · +' + gain + ' 分。');
  toast('收获 ' + move.captured.length + ' 张 · +' + gain + ' 分', 'good');
  pulseEl('pLoot', 'pulse');
  renderAll();
  // NPC 对玩家的战果有反应：被捞走王最心疼
  if (gotJoker) { toast('👑 连王一起捞走！', 'good'); npcSay('playerJoker'); }
  else if (gain >= 1.5) npcSay('playerBigLoot', 0.6);
  if (state.playerHand.length === 0) {
    // 手牌空了：从补牌堆拿 1 张补到桌面，再自动补满手牌
    const before = [];
    G.replaceAndRefill(state, 'player', null);
    const r = refillInfo('player', before);
    log('你手牌已空，从补牌堆补 1 张到桌面。');
    if (r.got > 0) log('补牌堆自动补 ' + r.got + ' 张到手牌（手牌 ' + r.total + ' 张）。');
    toast('手牌已空，自动补 ' + r.got + ' 张', 'good');
    pulseDrawPile();
    ui.mode = 'idle';
    setMessage('✅ 匹配成功！手牌已空，已自动从补牌堆补 1 张到桌面。');
    renderAll(); renderControls();
    after(T_HAND_OFF, endPlayerTurn);
  } else {
    ui.mode = 'replace';
    setMessage('✅ 匹配成功！点 1 张手牌补到桌面，之后自动从补牌堆补满手牌。');
    renderAll();
    renderControls(); // 清掉上一轮的"确认匹配"按钮，避免留下一个点了没反应的死按钮
  }
}

function endPlayerTurn() {
  state.turn = 'npc';
  renderAll();
  refreshOdds();   // 玩家这一回合定了 → 用最新局面重算胜率
  beginTurn();
}

// ---------- NPC 亮牌浮层：让玩家看清每一轮 NPC 吃了哪些牌 ----------
// masked=true 时整屏压暗（模态），视线强制集中到浮层上，不会再来回瞟棋盘
function showNpcShow(html, masked) {
  const el = $('npcShow');
  if (!el) return;
  el.innerHTML = html;
  if (el.classList) {
    el.classList.remove('hidden');
    if (masked) el.classList.add('masked'); else el.classList.remove('masked');
  }
}
function markNpcShowMerge() {
  const el = $('npcShow');
  if (el && el.classList) el.classList.add('merging');
}
function hideNpcShow() {
  const el = $('npcShow');
  if (el && el.classList) { el.classList.add('hidden'); el.classList.remove('merging'); el.classList.remove('masked'); }
  if (el) el.innerHTML = '';   // 顺手清空：避免下一次读到上一轮的残留内容
}
// 亮牌浮层里的牌：一张一张往外翻。upto = 已经翻出几张（含）
// 只有最新翻出的那张播"翻面"动画，已翻出的保持静止，避免整块重绘时又翻一遍
function npcShowCardsHtml(cards, upto) {
  const k = Math.max(1, Math.min(upto || 1, cards.length));
  const shown = cards.slice(0, k);
  return shown.map((c, i) => {
    const el = cardEl(c, false);
    el.classList.add(i === k - 1 ? 'flip-in' : 'revealed');
    if (i === cards.length - 1) el.classList.add('is-target'); // 桌面那张最后翻出，单独标出来
    return el.outerHTML;
  }).join('<span class="plus"> + </span>');
}
function npcShowPanelHtml(head, cards, upto, eqHtml) {
  return '<div class="npc-show-box">' +
    '<div class="npc-show-head">' + head + '</div>' +
    '<div class="npc-show-cards">' + npcShowCardsHtml(cards, upto) + '</div>' +
    (eqHtml || '<div class="npc-show-eq pending">?</div>') +
    '</div>';
}

function npcTurn() {
  ui.mode = 'idle'; ui.valid = false; ui.selHand = []; ui.selTable = null;
  ui.mergePlan = null; ui.penPlan = null;
  hideNpcShow();
  hideNpcSpeak();
  setNpcMood('think');                       // 先摆出"思考"的表情
  setMessage('🤖 NPC 思考中…');
  renderControls();
  renderAll();
  npcSituationLine();                        // 有余力的轮次说句场面话（领先/落后/残局）

  // 第 ① 拍：思考完决定出哪手
  after(T_NPC_THINK, () => {
    const action = G.chooseNpcAction(state, effectiveDifficulty());

    if (action.type === 'match') {
      const captured = action.move.captured;   // 手牌在前，桌面那张在最后
      const n = captured.length;
      const sum = G.sumMatchValue(action.move.handCards) + action.move.tableCard.matchValue;
      const gain = Math.round(G.sumScore(captured) * 100) / 100;
      const gotJoker = captured.some((c) => c.isJoker);

      // 第 ② 拍：卡通箭头指着它看中的那张桌面牌，其余桌面牌全部压暗
      ui.mode = 'merging';
      ui.mergePlan = { tableId: action.move.tableCard.id, handIds: [], stage: 'point', npc: true };
      setNpcMood('think');
      setMessage('🤖 NPC 看中了桌面的 ' + cardName(action.move.tableCard) + '（箭头指着它，其余牌已压暗）');
      log('👀 NPC 看中了桌面的 ' + cardName(action.move.tableCard) + '（箭头指着它）。');
      snd('ring');
      renderAll();

      // 第 ③ 拍：那张牌"抬起来"——我要的就是它
      after(T_NPC_POINT, () => {
        if (!ui.mergePlan || ui.mergePlan.stage !== 'point') return;
        ui.mergePlan.stage = 'lift';
        setMessage('☝️ NPC 把桌面的 ' + cardName(action.move.tableCard) + ' 抬了起来…');
        log('☝️ NPC 抬手要了桌面的 ' + cardName(action.move.tableCard) + '。');
        snd('tap');
        renderAll();

        // 第 ④ 拍：弹浮层（整屏压暗），把手上的牌一张一张翻过来
        after(T_NPC_LIFT, () => {
          if (!ui.mergePlan || ui.mergePlan.stage !== 'lift') return;
          ui.mergePlan.stage = 'flip';
          setNpcMood(gotJoker ? 'greedy' : 'happy');
          // 逐张揭示：每翻一张重建一次浮层内容并响一声，翻完最后一张再亮等式
          const reveal = (k) => {
            if (!ui.mergePlan || ui.mergePlan.stage !== 'flip') return;
            showNpcShow(npcShowPanelHtml('🤖 NPC 一张张翻牌（' + k + '/' + n + '）', captured, k, null), true);
            snd('flip');
            renderAll();
            if (k < n) { after(T_NPC_FLIP, () => reveal(k + 1)); return; }
            // 第 ⑤ 拍：全翻完了 → 等式和得分亮出来，停够你读完
            after(420, () => {
              if (!ui.mergePlan || ui.mergePlan.stage !== 'flip') return;
              ui.mergePlan.stage = 'read';
              const eq = '<div class="npc-show-eq">' + eqText(captured) + ' = ' + sum +
                ' <span class="ok">✅</span><br><span class="gain">收获 ' + n + ' 张 · +' + gain + ' 分</span></div>';
              showNpcShow(npcShowPanelHtml('🤖 NPC 这手牌凑成了 14', captured, n, eq), true);
              log('🤖 NPC 亮牌：' + eqText(captured) + ' = ' + sum + '，收获 ' + n + ' 张 · +' + gain + ' 分。');
              setMessage('🤖 NPC 这一手：' + eqText(captured) + ' = ' + sum + '，收走 ' + n + ' 张（+' + gain + ' 分）。');
              snd(gotJoker ? 'joker' : 'npc');
              renderAll();

              // 第 ⑥ 拍：才真正"匹配"——浮层收拢、桌面那张爆金光 → 入账 + 自动补牌
              after(T_NPC_READ, () => {
                if (!ui.mergePlan) return;
                ui.mergePlan.stage = 'merge';
                markNpcShowMerge();
                setMessage('🔗 NPC 合牌：' + eqText(captured) + ' = ' + sum + '，收走 ' + n + ' 张。');
                log('🔗 NPC 合牌收走 ' + n + ' 张。');
                renderAll();

                after(T_NPC_MERGE, () => {
                  if (!ui.mergePlan) return;
                  G.capture(state, 'npc', action.move);
                  const before = state.npcHand.map((c) => c.id);
                  G.replaceAndRefill(state, 'npc', action.replaceCardId);
                  const r = refillInfo('npc', before);
                  if (r.got > 0) log('NPC 自动补 ' + r.got + ' 张（手牌 ' + r.total + ' 张）。');
                  if (r.got > 0) snd('draw');
                  pulseEl('nLoot', 'pulse');
                  toast('NPC 收获 ' + n + ' 张 · +' + gain + ' 分', 'npc');
                  renderAll();
                  after(700, () => {
                    ui.mergePlan = null;
                    ui.mode = 'idle';
                    hideNpcShow();
                    setNpcMood('idle');
                    // 台词等亮牌浮层收掉之后再说，免得大娃娃和浮层挤在一起
                    if (gotJoker) npcSay('npcJoker');
                    else if (gain >= 2 || n >= 3) npcSay('npcBigLoot', 0.85);
                    else npcSay('npcMatch', 0.3);
                    finishNpcTurn();
                  });
                });
              });
            });
          };
          reveal(1);
        });
      });
    } else {
      // 罚牌：按规则隐藏，但把"无法匹配、要罚牌"这件事演清楚
      ui.penPlan = null;
      setNpcMood('sad');
      snd('penalty');
      showNpcShow('<div class="npc-show-box"><div class="npc-show-head">🤖 NPC 无法匹配</div>' +
        '<div class="npc-show-eq">罚牌 1 张（隐藏）</div></div>', false);
      log('🤖 NPC 无法匹配，罚牌 1 张（隐藏）。');
      toast('NPC 罚牌 1 张（隐藏）', 'npc');
      after(1300, () => {
        const before = state.npcHand.map((c) => c.id);
        G.penalty(state, 'npc', action.cardId);
        const r = refillInfo('npc', before);
        if (r.got > 0) log('NPC 罚牌后自动补 ' + r.got + ' 张（手牌 ' + r.total + ' 张）。');
        if (r.got > 0) snd('draw');
        pulseEl('nPen', 'pulse');
        renderAll();
        after(900, () => {
          hideNpcShow();
          setNpcMood('idle');
          npcSay('npcPenalty');
          finishNpcTurn();
        });
      });
    }
  });
}

function finishNpcTurn() {
  state.turn = 'player';
  beginTurn();
}

// ---------- 结算：把"算分过程"摊开给玩家看 ----------
// 一侧明细：各花色/王的"张数 × 单价 = 得分"，最后 战利品合计 − 罚牌合计 = 得分
function sideScoreHtml(title, loot, pen, score, extraClass) {
  const d = G.scoreDetail(loot);
  const dp = G.scoreDetail(pen);
  const rows = (detail, cls) => {
    const out = [];
    Object.keys(detail.bySuit).forEach((k) => {
      const s = detail.bySuit[k];
      out.push(
        '<tr class="' + (s.count ? '' : 'zero') + '"><td class="' + (s.red ? 'red' : '') + '">' + s.symbol + ' ' + s.name + '</td>' +
        '<td>' + s.count + ' 张 ×' + s.unit + '</td><td class="' + cls + '">' + s.points.toFixed(2) + '</td></tr>'
      );
    });
    [detail.joker.big, detail.joker.small].forEach((j) => {
      out.push(
        '<tr class="' + (j.count ? '' : 'zero') + '"><td>' + j.symbol + ' ' + j.name + '</td>' +
        '<td>' + j.count + ' 张 ×' + j.unit + '</td><td class="' + cls + '">' + j.points.toFixed(2) + '</td></tr>'
      );
    });
    return out.join('');
  };
  return '' +
    '<div class="score-side ' + extraClass + '">' +
    '<div class="score-title">' + title + '</div>' +
    '<table class="score-table">' +
    '<tr class="head"><td>战利品（' + d.count + ' 张）</td><td>张数 × 单价</td><td>得分</td></tr>' +
    rows(d, 'plus') +
    '<tr class="sum"><td>战利品合计</td><td></td><td class="plus">' + d.total.toFixed(2) + '</td></tr>' +
    '<tr class="head"><td>罚牌（' + dp.count + ' 张）</td><td>张数 × 单价</td><td>得分</td></tr>' +
    rows(dp, 'minus') +
    '<tr class="sum"><td>罚牌合计</td><td></td><td class="minus">' + dp.total.toFixed(2) + '</td></tr>' +
    '<tr class="final"><td>得分 = 战利品 − 罚牌</td><td>' + d.total.toFixed(2) + ' − ' + dp.total.toFixed(2) + '</td><td class="score">' + score.toFixed(2) + '</td></tr>' +
    '</table></div>';
}

function showOver() {
  state.phase = 'gameover';
  const ps = G.computeScore(state, 'player');
  const ns = G.computeScore(state, 'npc');
  const winner = ps > ns ? '🎉 你赢了！' : ns > ps ? '🤖 NPC 赢了' : '🤝 平局！';
  const rd = A ? A.rateDecisions(decisions) : null;
  const sayEvent = ps < ns ? 'overWin' : ps > ns ? 'overLose' : 'overDraw';
  const line = A ? A.npcSay(sayEvent) : null;
  setNpcMood(ps < ns ? 'greedy' : ps > ns ? 'sad' : 'shock');

  const fmt = (arr) => arr.length
    ? arr.map((c) => c.label).join('、')
    : '（无）';

  hideNpcSpeak();   // 结算弹窗是主角，大娃娃让位
  $('overTitle').textContent = '本局结束';
  $('overBody').innerHTML =
    `<div class="winner">${winner}</div>` +
    `<div class="over-score">你 <b>${ps.toFixed(2)}</b> ： <b>${ns.toFixed(2)}</b> NPC</div>` +
    (line ? `<div class="over-say">🤖 NPC：「${line.text}」</div>` : '') +
    (rd && rd.total ? `<div class="over-rate">本局决策质量：${rd.optimal}/${rd.total} 手最优 · 正确率 ${rd.rate}%</div>` : '') +
    sideScoreHtml('🧑 你的算分过程', state.playerLoot, state.playerPenalty, ps, 'me') +
    sideScoreHtml('🤖 NPC 的算分过程', state.npcLoot, state.npcPenalty, ns, 'npc') +
    `<details><summary>查看双方全部牌面</summary>` +
    `<div>你的战利品：${fmt(state.playerLoot)}</div>` +
    `<div>你的罚牌：${fmt(state.playerPenalty)}</div>` +
    `<div>NPC 战利品：${fmt(state.npcLoot)}</div>` +
    `<div>NPC 罚牌：${fmt(state.npcPenalty)}</div>` +
    `</details>`;
  $('overModal').classList.remove('hidden');
  snd(ps > ns ? 'win' : ps < ns ? 'lose' : 'drawEnd');
  renderDiff();   // 侧栏难度说明跟着刷新
  log('本局结束。你 ' + ps + ' : NPC ' + ns + '。');
}

// ---------- 渲染 ----------
function cardEl(card, back) {
  const d = document.createElement('div');
  // 必须先判断背面：back=true 时 card 传的是 null，先读 card.red 会直接抛异常
  if (back) { d.className = 'card back'; d.innerHTML = '<span class="back-emoji">🂠</span>'; return d; }
  d.className = 'card' + (card.red ? ' red' : '') + (card.isJoker ? ' joker' : '');
  if (card.isJoker) {
    d.innerHTML = `<div class="corner">${card.label}</div><div class="center">${card.suitSymbol}</div>`;
  } else {
    d.innerHTML = `<div class="corner">${card.short}<br>${card.suitSymbol}</div><div class="center">${card.suitSymbol}</div>`;
  }
  return d;
}

function renderAll() {
  if (!state) return;

  // 对比上一帧，找出"新出现的牌"，给它们加入场动画（补牌 = 有动作）
  const cur = {
    table: state.table.map((c) => c.id),
    playerHand: state.playerHand.map((c) => c.id),
    npcHand: state.npcHand.map((c) => c.id),
    draw: state.drawPile.length,
  };
  const prev = snap;
  const freshIds = (list, key) => new Set(prev ? list.filter((id) => prev[key].indexOf(id) < 0) : list);
  const isNewTable = freshIds(cur.table, 'table');
  const isNewHand = freshIds(cur.playerHand, 'playerHand');
  const isNewNpc = freshIds(cur.npcHand, 'npcHand');

  const plan = ui.mergePlan;

  // 桌面（上下两行）
  const t = $('table'); t.innerHTML = '';
  state.table.forEach((c) => {
    const el = cardEl(c);
    el.dataset.id = c.id; // 供圈选/合牌定位与 NPC 回合高亮
    if (isNewTable.has(c.id)) el.classList.add('in-table');
    if (plan && plan.tableId === c.id) {
      // NPC 吃的那张桌面牌，分拍演出：② 箭头指着它 → ③ 抬起来 → ④/⑤ 亮牌期间保持圈住 → ⑥ 合牌爆金光
      el.classList.add('ringed');
      if (plan.stage === 'merge') {
        el.classList.add('merge-target');
      } else if (plan.stage === 'point' || plan.stage === 'lift') {
        el.classList.add('npc-point');
        if (plan.stage === 'lift') el.classList.add('lifted');
        const ar = document.createElement('div');   // 卡通箭头：指一指它要吃哪张
        ar.className = 'npc-arrow';
        el.appendChild(ar);
      } else if (plan.stage === 'flip' || plan.stage === 'read') {
        el.classList.add('npc-point');
      } else {
        el.classList.add('ring-lock');
      }
    } else if (plan && plan.npc) {
      // NPC 回合：不是它要的那张就压暗 —— 视线只跟着箭头走，一眼看出它盯的是哪张
      el.classList.add('dimmed');
    } else if (state.turn === 'player' && ui.mode === 'select' && ui.selTable === c.id) {
      el.classList.add('selected', 'ringed');
      if (!ui.valid) el.classList.add('ring-bad'); // 圈起来了但和还不等于 14
    }
    el.addEventListener('click', () => onTableClick(c));
    t.appendChild(el);
  });

  // 玩家手牌
  const ph = $('playerHand'); ph.innerHTML = '';
  state.playerHand.forEach((c) => {
    const el = cardEl(c);
    el.dataset.id = c.id;
    if (isNewHand.has(c.id)) el.classList.add('in-hand');
    if (plan && plan.stage === 'merge' && plan.handIds.indexOf(c.id) >= 0) {
      el.classList.add('merge-to');                       // 朝被圈的桌面牌飞过去合上
    } else if (ui.penPlan === c.id) {
      el.classList.add('penalty-out');                    // 罚牌：飞走（隐藏）
    } else if ((ui.mode === 'select' || ui.mode === 'replace') && ui.selHand.includes(c.id)) {
      el.classList.add('selected');
    }
    el.addEventListener('click', () => onHandClick(c));
    ph.appendChild(el);
  });

  // 手牌飞向桌面那张牌：量一次真实位置算位移，量不到就用默认"向上飞"
  if (plan && plan.stage === 'merge' && plan.handIds.length) {
    const dest = centerOf(queryChild(t, '[data-id="' + plan.tableId + '"]'));
    plan.handIds.forEach((id) => {
      const el = queryChild(ph, '[data-id="' + id + '"]');
      if (!el || !el.style || typeof el.style.setProperty !== 'function') return;
      const src = centerOf(el);
      const dx = (dest && src) ? Math.round(dest.x - src.x) : 0;
      const dy = (dest && src) ? Math.round(dest.y - src.y) : -90;
      el.style.setProperty('--dx', dx + 'px');
      el.style.setProperty('--dy', dy + 'px');
    });
  }

  // NPC 手牌（背面）
  const nh = $('npcHand'); nh.innerHTML = '';
  state.npcHand.forEach((c) => {
    const el = cardEl(null, true);
    if (isNewNpc.has(c.id)) el.classList.add('in-npc');
    nh.appendChild(el);
  });
  // 计数
  $('drawCount').textContent = state.drawPile.length;
  if (prev && prev.draw !== cur.draw) pulseDrawPile(); // 补牌堆数字跳一下
  $('playerCount').textContent = state.playerHand.length;
  $('npcCount').textContent = state.npcHand.length;
  $('pLoot').textContent = state.playerLoot.length;
  $('nLoot').textContent = state.npcLoot.length;
  $('pPen').textContent = state.playerPenalty.length;
  $('nPen').textContent = state.npcPenalty.length;

  // 实时比分：战利品已入账、罚牌已扣下，随时都能看到当前分数差（不用等结算）
  const ps = G.computeScore(state, 'player');
  const ns = G.computeScore(state, 'npc');
  const sm = $('scoreMe'), sn = $('scoreNpc');
  if (sm) {
    if (sm.textContent !== ps.toFixed(2)) { sm.textContent = ps.toFixed(2); pulseEl('scoreMe', 'pulse'); }
  }
  if (sn) {
    if (sn.textContent !== ns.toFixed(2)) { sn.textContent = ns.toFixed(2); pulseEl('scoreNpc', 'pulse'); }
  }
  const lead = $('scoreLead');
  if (lead) {
    const d = Math.round((ps - ns) * 100) / 100;
    lead.textContent = d > 0 ? ('你领先 ' + d.toFixed(2)) : d < 0 ? ('NPC 领先 ' + (-d).toFixed(2)) : '暂时打平';
    lead.className = 'score-lead ' + (d > 0 ? 'me' : d < 0 ? 'npc' : 'even');
  }

  snap = cur;
  renderLog(); // 内核直接写进 state.log 的行也要立刻显示
}

function mkBtn(text, cls, onclick, disabled) {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = text;
  if (disabled) b.disabled = true;
  b.onclick = onclick;
  return b;
}

function renderControls() {
  const c = $('controls');
  c.innerHTML = '';
  if (!state || state.turn !== 'player') return;
  if (ui.mode === 'select') {
    // 只有两个出口，且都不跳转模式：选好牌就匹配；只选 1 张就罚掉。没有"罚牌模式""返回"这些来回。
    const one = ui.selHand.length === 1 ? state.playerHand.find((x) => x.id === ui.selHand[0]) : null;
    c.appendChild(mkBtn(ui.noMoves ? '✅ 确认匹配（当前凑不出）' : '✅ 确认匹配', 'btn btn-go', confirmMatch, !ui.valid));
    c.appendChild(mkBtn(one ? ('🚫 罚掉 ' + cardName(one)) : '🚫 罚掉选中的 1 张', 'btn btn-warn', doPenalty, !one));
  }
}

function renderLog() {
  const el = $('log');
  if (!el || !state) return;
  el.innerHTML = state.log.slice(-40).map((l) => '<div>· ' + l + '</div>').join('');
  el.scrollTop = el.scrollHeight;
}

// ---------- 难度（仅影响 NPC 强度） ----------
// 读持久化难度（首次用默认 medium）。只在启动时调用一次：点按钮切难度时变量与存储同步更新，无需逐局重读。
function loadPersistDiff() {
  try {
    if (typeof localStorage !== 'undefined') {
      const d = localStorage.getItem('h14_diff');
      if (d && G.DIFFICULTIES && G.DIFFICULTIES.indexOf(d) >= 0) npcDifficulty = d;
    }
  } catch (e) {}
}
function applyDifficulty(d) {
  if (!G.DIFFICULTIES || G.DIFFICULTIES.indexOf(d) < 0) return;
  npcDifficulty = d;
  try { if (typeof localStorage !== 'undefined') localStorage.setItem('h14_diff', d); } catch (e) {}
  renderDiff();
}
function renderDiff() {
  const seg = $('diffSeg');
  if (seg && typeof seg.querySelectorAll === 'function') {
    seg.querySelectorAll('.diff-btn').forEach((b) => {
      const on = b.getAttribute('data-diff') === npcDifficulty;
      if (b.classList) { if (on) b.classList.add('on'); else b.classList.remove('on'); }
    });
  }
  const el = $('diffDesc');
  if (!el) return;
  {
    // 手机版降档后必须说明实际强度，否则"选中等按容易打"玩家会被蒙在鼓里。
    // 注意条件是"真降了一档"（easy→easy 不降不标），别只判键存在。
    const sh = H14_SHIFT && H14_SHIFT[npcDifficulty];
    el.textContent = (DIFF_DESC[npcDifficulty] || '')
      + (sh && sh !== npcDifficulty ? '（手机版整体降一档，实际按「' + diffLabel(sh) + '」打）' : '');
  }
}

// ---------- 开局难度询问 ----------
// 只有两个出口：选一档开始 / 直接开始（用当前档）。选档不算"确认"，点开始才生效。
let pendingDiff = null;    // 询问层里高亮的档位（没点开始前不动 npcDifficulty）
function requestNewGame() {
  if (!askDiff) { newGame(); maybeFirstHelp(); return; }
  openDiffAsk();
}
function openDiffAsk() {
  pendingDiff = npcDifficulty;   // 默认停在当前档，不改就等于"沿用"
  const m = $('diffModal');
  if (!m || !m.classList) { newGame(); maybeFirstHelp(); return; }   // 页面没有这个弹层 → 别卡住，直接开局
  // 先关掉其它弹层：结算/帮助层与询问层同为 .modal（z-index 99），不关会把询问层压在底下，
  // 表现就是"点了再来一局没反应"（2026-09-19 用户实测踩中）
  const om = $('overModal');
  if (om && om.classList) om.classList.add('hidden');
  const hm = $('helpModal');
  if (hm && hm.classList) hm.classList.add('hidden');
  hideNpcSpeak();   // 大娃娃 z-index 比弹层高，会盖住询问层（局中点"新一局"时会遇到）
  hideNpcBubble();
  renderDiffAsk();
  m.classList.remove('hidden');
  snd('tap');
}
function closeDiffAsk() {
  const m = $('diffModal');
  if (m && m.classList) m.classList.add('hidden');
}
function renderDiffAsk() {
  const seg = $('askDiffSeg');
  if (seg && typeof seg.querySelectorAll === 'function') {
    seg.querySelectorAll('.diff-btn').forEach((b) => {
      const on = b.getAttribute('data-diff') === pendingDiff;
      if (b.classList) { if (on) b.classList.add('on'); else b.classList.remove('on'); }
    });
  }
  const desc = $('askDiffDesc');
  const shAsk = H14_SHIFT && H14_SHIFT[pendingDiff];
  if (desc) desc.textContent = (DIFF_DESC[pendingDiff] || '')
    + (shAsk && shAsk !== pendingDiff ? '（手机版整体降一档，实际按「' + diffLabel(shAsk) + '」打）' : '');
  const go = $('askDiffGo');
  if (go) go.textContent = '开 始（' + diffLabel(pendingDiff) + (shAsk && shAsk !== pendingDiff ? '·实按' + diffLabel(shAsk) : '') + '）';
  const cb = $('askDiffNever');
  if (cb && 'checked' in cb) cb.checked = !askDiff;
}
function pickAskDiff(d) {
  if (!G.DIFFICULTIES || G.DIFFICULTIES.indexOf(d) < 0) return;
  pendingDiff = d;
  renderDiffAsk();
  snd('tap');
}
function confirmDiffAsk() {
  if (pendingDiff) applyDifficulty(pendingDiff);   // 写存储 + 刷新侧栏
  const cb = $('askDiffNever');
  if (cb && 'checked' in cb) setAskDiff(!cb.checked);
  closeDiffAsk();
  newGame();
  maybeFirstHelp();
}
// 首玩：局先开好，再把玩法说明盖上来（两个弹层不叠在一起），关掉就能直接玩
function maybeFirstHelp() {
  if (!firstRunPending) return;
  firstRunPending = false;
  showHelp();
}

// ---------- 绑定 ----------
function updateSoundBtn() {
  const b = $('soundBtn');
  if (b) b.textContent = (SFX && SFX.isMuted && SFX.isMuted()) ? '🔇 音效关' : '🔊 音效开';
}
function toggleSound() {
  if (!SFX || !SFX.toggleMuted) return;
  SFX.setMuted(!SFX.isMuted());
  updateSoundBtn();
  if (!SFX.isMuted()) snd('tap');
}

// 玩法说明（首玩引导）：首次启动自动弹，之后顶栏「❓ 玩法」随时看；看过一次不再自动弹
function getSeenHelp() {
  try {
    if (typeof wx !== 'undefined' && typeof wx.getStorageSync === 'function') return !!wx.getStorageSync('h14_seenHelp');
    if (typeof localStorage !== 'undefined') return localStorage.getItem('h14_seenHelp') === '1';
  } catch (e) {}
  return false;
}
function setSeenHelp() {
  try {
    if (typeof wx !== 'undefined' && typeof wx.getStorageSync === 'function') { wx.setStorageSync('h14_seenHelp', 1); return; }
    if (typeof localStorage !== 'undefined') localStorage.setItem('h14_seenHelp', '1');
  } catch (e) {}
}
function showHelp() {
  const m = $('helpModal');
  if (m && m.classList) m.classList.remove('hidden');
  snd('tap');
}
function hideHelp() {
  const m = $('helpModal');
  if (m && m.classList) m.classList.add('hidden');
  setSeenHelp();
}

document.addEventListener('DOMContentLoaded', () => {
  if (SFX && SFX.load) SFX.load();   // 恢复上次的静音选择
  updateSoundBtn();
  loadPersistDiff(); // 恢复持久化难度——必须在 renderDiff() 前，否则侧栏高亮停留在默认档
  loadAskDiff();   // 恢复"开局是否还问难度"
  const hb = $('helpBtn');
  if (hb && hb.addEventListener) hb.addEventListener('click', showHelp);
  const hc = $('helpClose');
  if (hc && hc.addEventListener) hc.addEventListener('click', hideHelp);
  firstRunPending = !getSeenHelp();   // 首玩：本局开好后再把玩法说明盖上来（两个弹层不叠一起）
  $('newGame').addEventListener('click', requestNewGame);
  $('overNew').addEventListener('click', requestNewGame);
  // 侧栏难度：点五档之一，立即切换并持久化（下一局按新难度开局）
  const ds = $('diffSeg');
  if (ds && typeof ds.querySelectorAll === 'function') {
    ds.querySelectorAll('.diff-btn').forEach((b) => {
      if (b.addEventListener) b.addEventListener('click', () => applyDifficulty(b.getAttribute('data-diff')));
    });
  }
  // 开局询问层：点档位只是选中，点「开始」才生效并开局
  const as = $('askDiffSeg');
  if (as && typeof as.querySelectorAll === 'function') {
    as.querySelectorAll('.diff-btn').forEach((b) => {
      if (b.addEventListener) b.addEventListener('click', () => pickAskDiff(b.getAttribute('data-diff')));
    });
  }
  const ag = $('askDiffGo');
  if (ag && ag.addEventListener) ag.addEventListener('click', confirmDiffAsk);
  const an = $('askDiffNever');
  if (an && an.addEventListener) an.addEventListener('change', () => setAskDiff(!an.checked));
  renderDiff();
  const sb = $('soundBtn');
  if (sb && sb.addEventListener) sb.addEventListener('click', toggleSound);
  // 浏览器策略要求用户交互后音频才能发声：第一次点击时唤醒一次
  if (document.addEventListener) document.addEventListener('click', () => { if (SFX && SFX.unlock) SFX.unlock(); }, { once: true });
  requestNewGame();   // 开局前先问一句难度（勾了"不再问"就直接开）
});

// ---------- 测试入口（仅 Node 冒烟测试使用；浏览器里不生效） ----------
if (typeof require !== 'undefined' && typeof module !== 'undefined' && module.exports) {
  module.exports.__test = {
    getState: () => state,
    ui: ui,
    G: G,
    A: A,
    SFX: SFX,
    renderAll: renderAll,
    renderControls: renderControls,
    playerTurnStart: playerTurnStart,
    updateSelectSum: updateSelectSum,
    confirmMatch: confirmMatch,
    doPenalty: doPenalty,
    onHandClick: onHandClick,
    onTableClick: onTableClick,
    newGame: newGame,
    showOver: showOver,
    toggleSound: toggleSound,
    npcSay: npcSay,
    showNpcSpeak: showNpcSpeak,
    hideNpcSpeak: hideNpcSpeak,
    npcTurn: npcTurn,
    sayDur: sayDur,
    // 演出节奏（测试里按拍推进时要用到真实数值）
    T: {
      RING_LOCK: T_RING_LOCK, MERGE: T_MERGE, PENALTY_OUT: T_PENALTY_OUT,
      NPC_THINK: T_NPC_THINK, NPC_POINT: T_NPC_POINT, NPC_LIFT: T_NPC_LIFT,
      NPC_FLIP: T_NPC_FLIP, NPC_READ: T_NPC_READ, NPC_MERGE: T_NPC_MERGE,
      HAND_OFF: T_HAND_OFF, SAY_MIN: T_SAY_MIN, SAY_MAX: T_SAY_MAX,
    },
    // 胜率模拟在冒烟测试里默认关掉（几百局会拖慢测试）；需要时用例里单独打开
    setSimEnabled: (v) => { simEnabled = !!v; },
    // 先手随机：测试里关掉以保确定性（避免 NPC 先手的在途回调污染用例）
    setFirstMoveRandom: (v) => { firstMoveRandom = !!v; },
    getDifficulty: () => npcDifficulty,
    setDifficulty: applyDifficulty,
    renderDiff: renderDiff,
    // 开局难度询问（测试要能关掉询问、要能直接读档位）
    requestNewGame: requestNewGame,
    confirmDiffAsk: confirmDiffAsk,
    pickAskDiff: pickAskDiff,
    openDiffAsk: openDiffAsk,
    isAskDiffOpen: () => {
      const m = $('diffModal');
      return !!(m && m.classList && !m.classList.contains('hidden'));
    },
    setAskDiff: setAskDiff,
    getAskDiff: () => askDiff,
    setFirstRunPending: (v) => { firstRunPending = !!v; },
    getPendingDiff: () => pendingDiff,
    effectiveDifficulty: effectiveDifficulty,
    getOdds: () => odds,
    refreshOdds: refreshOdds,
    stepOdds: stepOdds,
    getDecisions: () => decisions,
    sideScoreHtml: sideScoreHtml,
    showHelp: showHelp,
    hideHelp: hideHelp,
    getSeenHelp: getSeenHelp,
    setSeenHelp: setSeenHelp,
  };
}
