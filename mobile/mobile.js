// 欢乐十四分 · 手机版控制器（独立前端，复用内核 game-core / advisor / sfx）
// 与桌面版 app.js 分道：布局/信息密度/演出都为手机重做，只共用同一套游戏内核。
const G = (typeof require !== 'undefined') ? require('./game-core.js') : window.G;
const A = (typeof require !== 'undefined') ? require('./advisor.js') : (window.ADVISOR || null);
const SFX = (typeof require !== 'undefined') ? require('./sfx.js') : (window.SFX || null);

// 音效安全调用（手机上无 UI 开关，靠系统音量控制；音效默认开）
const snd = (name) => { try { if (SFX && typeof SFX[name] === 'function') SFX[name](); } catch (e) {} };

// 节奏（毫秒），手机可稍快
const T_NPC_THINK = 650;
const T_NPC_POINT = 900;
const T_NPC_LIFT = 500;
const T_NPC_READ = 1500;   // 亮牌停留（够读完等式）
const T_NPC_MERGE = 600;
const T_HAND_OFF = 380;
const T_PENALTY_OUT = 380;
const T_SAY_MIN = 2200;
const T_SAY_MAX = 9000;
const T_PLAYER_LIFT = 360;   // 玩家合牌：圈定后抬起停留
const T_PLAYER_READ = 1100;  // 玩家合牌：亮出等式/得分停留（轻量，比 NPC 短）
const sayDur = (text) => {
  const s = String(text || '');
  let chars = 0;
  for (let i = 0; i < s.length; i++) chars += /[\u4e00-\u9fff]/.test(s[i]) ? 1 : 0.5;
  return Math.max(T_SAY_MIN, Math.min(T_SAY_MAX, Math.round(1500 + chars * 280)));
};

let state = null;
let ui = { selHand: [], selTable: null, noMoves: false, mergePlan: null, penPlan: null, mode: 'idle', valid: false };
let snap = null;
let episode = 0;

// ---------- 新手辅导（带练）状态 ----------
let coachOn = false;
let coachStepMode = false;
let coachStepIdx = 0;
let coachMoves = [];        // 当前玩家回合所有合法凑 14 组合（已按分排序，[0]=最优）
let coachLast = null;       // 上一次出牌的教练点评（{gain,bestGain,optimal}）
let coachHint = { hand: new Set(), table: new Set(), bestHand: new Set(), bestTable: new Set() };
function loadCoach() {
  try { if (typeof localStorage !== 'undefined' && localStorage.getItem('h14_coach') === '1') coachOn = true; } catch (e) {}
}
function updateCoachUI() {
  const t = $('coachToggleStart'); if (t) { t.textContent = coachOn ? '开' : '关'; t.classList.toggle('on', coachOn); }
  const b = $('coachBtn'); if (b) { b.classList.toggle('on', coachOn); b.setAttribute('aria-pressed', coachOn ? 'true' : 'false'); }
}
function setCoach(v) {
  coachOn = !!v;
  try { if (typeof localStorage !== 'undefined') localStorage.setItem('h14_coach', coachOn ? '1' : '0'); } catch (e) {}
  if (coachOn) { try { localStorage.setItem('h14_coach_nudge', '1'); } catch (e) {} }
  const n = $('coachNudge'); if (n) n.classList.remove('show');
  updateCoachUI();
  if (coachOn) recomputeCoach(); else { coachMoves = []; coachHint = { hand: new Set(), table: new Set(), bestHand: new Set(), bestTable: new Set() }; }
  renderCoach();
  renderAll();
}
function recomputeCoach() {
  coachHint = { hand: new Set(), table: new Set(), bestHand: new Set(), bestTable: new Set() };
  coachLast = null;
  if (!coachOn || !state || state.turn !== 'player' || state.phase !== 'playing' || ui.mode !== 'select') { coachMoves = []; renderCoach(); return; }
  const moves = G.findMoves(state.playerHand, state.table);
  if (moves.length === 0) {
    const cheapest = state.playerHand.slice().sort(function (a, b) { return a.score - b.score; })[0];
    if (cheapest) { coachHint.hand.add(cheapest.id); coachHint.bestHand.add(cheapest.id); }
    coachMoves = [];
  } else {
    coachMoves = (G.rankMoves ? G.rankMoves(moves) : moves.slice().sort(function (a, b) { return G.sumScore(b.captured) - G.sumScore(a.captured); }));
    coachStepIdx = 0;
    coachMoves.forEach(function (m) {
      m.handCards.forEach(function (c) { coachHint.hand.add(c.id); });
      coachHint.table.add(m.tableCard.id);
    });
    if (coachMoves[0]) {
      coachMoves[0].handCards.forEach(function (c) { coachHint.bestHand.add(c.id); });
      coachHint.bestTable.add(coachMoves[0].tableCard.id);
    }
  }
  renderCoach();
}
function applyCoachCombo(move) {
  if (!move || ui.mode !== 'select' || state.turn !== 'player') return;
  ui.selHand = move.handCards.map(function (c) { return c.id; });
  ui.selTable = move.tableCard.id;
  updateSelectSum();
  snd('tap');
  renderAll();
}

function updateCoachNudge() {
  const n = $('coachNudge'); if (!n) return;
  let seen = false;
  try { seen = localStorage.getItem('h14_coach_nudge') === '1'; } catch (e) {}
  const show = !coachOn && !seen && state && state.turn === 'player' && state.phase === 'playing' && ui.mode === 'select';
  n.classList.toggle('show', show);
  if (show) {
    n.textContent = '不会出牌？点我看推荐走法 →';
    const tb = $('topbar'), c = $('coachBtn');
    if (tb) n.style.top = (tb.getBoundingClientRect().height + 6) + 'px';
    if (c) {
      const r = c.getBoundingClientRect();
      const right = Math.max(20, window.innerWidth - r.left - r.width / 2);
      n.style.setProperty('--nudge-arrow-right', right + 'px');
    }
  } else {
    n.style.top = '';
    n.style.removeProperty('--nudge-arrow-right');
  }
}

function renderCoach() {
  updateCoachNudge();
  const panel = $('coachPanel');
  if (!panel) return;
  if (!coachOn || !state || state.turn !== 'player' || state.phase !== 'playing') { panel.classList.add('hidden'); panel.innerHTML = ''; return; }
  if (ui.mode !== 'select' && ui.mode !== 'replace') { panel.classList.add('hidden'); panel.innerHTML = ''; return; }
  panel.classList.remove('hidden');
  const stepBtn = '<button id="coachStepModeBtn" class="coach-stepmode' + (coachStepMode ? ' on' : '') + '">逐步讲解：' + (coachStepMode ? '开' : '关') + '</button>';
  if (ui.mode === 'select') {
    if (coachMoves.length === 0) {
      const cheapest = state.playerHand.slice().sort(function (a, b) { return a.score - b.score; })[0];
      panel.innerHTML = '<div class="coach-h">💡 提示 ' + stepBtn + '</div>' +
        '<div class="coach-b">这回合手牌 + 桌面真凑不出 14，只能罚牌。建议罚最便宜的 <b>' + cardName(cheapest) + '</b>（扣分最少）——点它，再点「🚫 罚掉」。</div>';
    } else if (coachStepMode) {
      const i = Math.max(0, Math.min(coachStepIdx, coachMoves.length - 1));
      const m = coachMoves[i];
      const best = i === 0;
      const txt = (coachMoves.length === 1) ? '就这么一种凑法' : ('第 ' + (i + 1) + ' / ' + coachMoves.length + ' 种');
      panel.innerHTML = '<div class="coach-h">💡 提示 · ' + txt + ' ' + stepBtn + '</div>' +
        '<div class="coach-b big">' + (best ? '<span class="rec">推荐</span> ' : '') + eqText(m.captured) + ' = 14，收走这组牌' + (best ? '（目前最划算）' : '') + '</div>' +
        '<div class="coach-stepnav"><button id="coachPrev" class="coach-step">‹ 上一步</button>' +
        '<button id="coachUse" class="coach-step use">就用这手出</button>' +
        '<button id="coachNext" class="coach-step">下一步 ›</button></div>';
    } else {
      const rows = coachMoves.map(function (m, idx) {
        const best = idx === 0;
        return '<div class="coach-row' + (best ? ' best' : '') + '" data-idx="' + idx + '">' +
          '<span class="coach-idx">' + (idx + 1) + '</span>' +
          '<span class="coach-eq">' + eqText(m.captured) + ' = 14</span>' +
          '<span class="coach-gain">' + (best ? '最划算' : '') + '</span>' +
          (best ? '<span class="rec">推荐</span>' : '') + '</div>';
      }).join('');
      panel.innerHTML = '<div class="coach-h">💡 提示 · 本回合 ' + coachMoves.length + ' 种凑法（点任一行直接选）' + stepBtn + '</div>' +
        '<div class="coach-rows">' + rows + '</div>';
    }
  } else if (ui.mode === 'replace') {
    let body = '';
    if (coachLast) {
      body += '<div class="coach-prev">上回合这手' +
        (coachLast.optimal ? '已经是最赚的 👍' : '不是最赚的——还有更赚的一手没选') + '</div>';
    }
    const judge = (A) ? A.judgeReplace(state.playerHand, state.table, [], null, { unknown: G.unknownPool(state), oppHandSize: state.npcHand.length }) : null;
    if (judge && judge.suggest) {
      const sc = judge.suggest;
      const riskTxt = sc.cost <= 0.3 ? '几乎送不出去（最安全）' : (sc.cost <= 0.6 ? '被吃到的风险中等' : '被吃到的风险偏高');
      const keepTxt = sc.path > 0 ? '留手上也还能凑牌' : '留手上基本没用';
      body += '<div class="coach-b">收完要补 1 张到桌面。建议补 <b>' + cardName(sc.card) + '</b>：放它上桌' + riskTxt + '，而且' + keepTxt + '。点它就补这张。</div>';
    }
    panel.innerHTML = '<div class="coach-h">💡 提示 ' + stepBtn + '</div>' + body;
  }
  const sb = $('coachStepModeBtn'); if (sb) sb.onclick = function () { coachStepMode = !coachStepMode; if (coachStepMode) coachStepIdx = 0; renderCoach(); };
  panel.querySelectorAll('.coach-row').forEach(function (r) { r.onclick = function () { const idx = parseInt(r.getAttribute('data-idx'), 10); if (!isNaN(idx)) applyCoachCombo(coachMoves[idx]); }; });
  const pv = $('coachPrev'); if (pv) pv.onclick = function () { coachStepIdx = Math.max(0, coachStepIdx - 1); renderCoach(); };
  const nx = $('coachNext'); if (nx) nx.onclick = function () { coachStepIdx = Math.min(coachMoves.length - 1, coachStepIdx + 1); renderCoach(); };
  const cu = $('coachUse'); if (cu) cu.onclick = function () { const i = Math.max(0, Math.min(coachStepIdx, coachMoves.length - 1)); applyCoachCombo(coachMoves[i]); };
}


// 难度（仅影响 NPC；含手机整体降一档；难/地狱的强度由「学习系统」个性化）
let npcDifficulty = 'medium';
let firstMoveRandom = true;
const DIFF_DESC = {
  easy: '容易：NPC 大半随缘出牌，还常把高分牌送给你。',
  medium: '中等：NPC 一步贪心，盯着当下最赚的走。',
  hard: '难：NPC 出牌照贪心，但补到桌面那张专挑"最不喂你"的。',
  hell: '地狱：NPC 每种打法都推演到终局再挑，几乎算死你。',
};
const diffLabel = (d) => ({ easy: '容易', medium: '中等', hard: '难', hell: '地狱' }[d] || d);

// ---------- NPC 学习系统（只学"你赢"的局；难/地狱个性化，易/中永不学） ----------
// 打法：赢局里你的每一手，都交给引擎自己的终局推演当裁判。只有"你那手推演出来比引擎当时那手
// 明显更赚"的才算一个洞，再按它落在哪条轴上给对应权重投一票，票数够了才动一点点。
// 所以学的是"引擎哪条轴判偏了、该往哪偏"，不是把具体牌面抄下来。
const LEARN_KEY = 'h14_learn_v1';
const LEARN_STEP = { hard: 0.03, hell: 0.06 };   // 难=轻调、地狱=重调（易/中为 0，永不学）
// 学习步长/钳制。注意：只自动调 keepW/playW（判据独立、干净）；
// defenseW/selfW 揉在 netReplaceId 的同一个净威胁项里（defenseW*oppThreat + keepW*throwDesire，
// 威胁项内部再叠 selfW），两者从同一信号学会耦合过拟合 → 只做只读败因归因（causes），不自动调。
const LEARN_CLAMP = { keepW: [0, 3], playW: [0.2, 1.6] };
const LEARN_MARGIN = 0.5;    // 一手要"明显更赚"（≥0.5 分）才算洞，避免噪声投票
const LEARN_MAX_DEC = 120;   // 每局最多留多少个决策点（防内存膨胀）
// 复盘教练（量"最优走法比你这步好多少"，与学习系统反方向；全难度都记，标尺=最强走法）
const GAMES_KEY = 'h14_games_v1';
const REVIEW_MARGIN = 0.5;   // 一步明显丢分(≥0.5)才记进复盘，过滤噪声
const REVIEW_TOP = 15;      // 每局最多存几条最大丢分决策（控 JSON 体积）
const GAMES_MAX = 60;       // localStorage 只留最近 N 局复盘
let learned = {
  v: 1,
  weights: null,                                 // 学习后的权重；null = 还没学到东西（等于出厂默认）
  stats: { hard: { w: 0, l: 0 }, hell: { w: 0, l: 0 } },
  reviewed: 0,                                   // 已复盘（赢局）数
  holes: { play: 0, rep: 0, pen: 0 },            // 累计"引擎被你反超"处数
  causes: { fed: 0, routed: 0 },                 // 补牌失误的只读归因：fed=资敌(喂对手凑14) routed=失后路(没留自己抓手)
  drift: 0,                                      // 累计调参次数
  log: [],                                       // 最近 5 条人类可读说明
};
let decideLog = [];       // 本局玩家决策快照（只在内存里，不落盘）
let pendingPlay = null;   // 上一次出牌的决策快照（补牌轴要跟它配对）

// ---------- 复盘教练记录（局后把"最大丢分点"存成紧凑 JSON；离线 tools-coach.js 聚合成弱点报告） ----------
// 与学习系统反方向：学习量"玩家反超引擎"（为让 NPC 变强），教练量"最优走法比你这步好多少"（为告诉你丢分在哪）。
// 逐点判定在浏览器端算好、只存结论（不存 state 克隆）→ JSON 小、可导出、可分享。
let gameLog = [];         // 最近 GAMES_MAX 局的复盘记录
function loadGames() {
  try {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem(GAMES_KEY);
    if (!raw) return;
    const a = JSON.parse(raw);
    if (Array.isArray(a)) gameLog = a.slice(-GAMES_MAX);
  } catch (e) {}
}
function saveGames() {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(GAMES_KEY, JSON.stringify(gameLog));
  } catch (e) {}
}
// 复盘本局（在 runLearn 之前调用——runLearn 结尾会清空 decideLog）。全难度都记，标尺=最强走法。
function recordGame(ps, ns) {
  if (!state || !G || !G.cloneState || !decideLog.length) return;
  const misses = [];
  for (const d of decideLog) {
    try {
      let mineV = null, engV = null, axis = null, cause = '';
      if (d.k === 'play') {
        const moves = G.findMoves(d.st.playerHand, d.st.table);
        if (!moves.length) continue;
        const mine = findMoveBy(moves, d.handIds, d.tableId);
        const eng = G.rankMoves(moves)[0];
        if (!mine || !eng) continue;
        mineV = G.evalMoveRollout(d.st, 'player', mine, null);
        engV = G.evalMoveRollout(d.st, 'player', eng, null);
        axis = 'play';
      } else if (d.k === 'rep') {
        const moves = G.findMoves(d.st.playerHand, d.st.table);
        const mv = findMoveBy(moves, d.handIds, d.tableId);
        if (!mv) continue;
        const engId = G.netReplaceId(d.st, 'player', mv);
        if (!engId || engId === d.cardId) continue;
        mineV = G.evalMoveRollout(d.st, 'player', mv, d.cardId);
        engV = G.evalMoveRollout(d.st, 'player', mv, engId);
        // 败因（只读）：玩家补的这张 vs 引擎最优补的这张，谁让对手下一手能捞更多 = 资敌(fed)
        const stM = G.cloneState(d.st); G.capture(stM, 'player', mv); G.replaceAndRefill(stM, 'player', d.cardId);
        const stE = G.cloneState(d.st); G.capture(stE, 'player', mv); G.replaceAndRefill(stE, 'player', engId);
        const oppM = G.opponentBestGain(stM, 'player'), oppE = G.opponentBestGain(stE, 'player');
        axis = 'replace';
        cause = (oppM - oppE >= REVIEW_MARGIN) ? 'fed' : 'routed';
      } else if (d.k === 'pen') {
        if (G.findMoves(d.st.playerHand, d.st.table).length) continue;   // 引擎这手会出牌 → 不是罚牌分支
        const eng = G.chooseAction(d.st, 'player', { difficulty: 'hell' });
        if (!eng || eng.type !== 'penalty' || eng.cardId === d.cardId) continue;
        mineV = penValue(d.st, d.cardId);
        engV = penValue(d.st, eng.cardId);
        axis = 'penalty';
      }
      if (mineV === null || engV === null) continue;
      const gap = Math.round((engV - mineV) * 100) / 100;
      if (gap >= REVIEW_MARGIN) {
        misses.push({
          axis, cause,
          mine: Math.round(mineV * 100) / 100,
          eng: Math.round(engV * 100) / 100,
          gap,
          handIds: d.handIds || null,
          cardId: d.cardId || null,
          tableId: d.tableId || null,
        });
      }
    } catch (e) { /* 单个决策点出错不影响整局复盘 */ }
  }
  misses.sort((a, b) => b.gap - a.gap);
  gameLog.push({
    v: 1,
    ts: new Date().toISOString(),
    diff: npcDifficulty,
    result: ps > ns ? 'win' : ns > ps ? 'loss' : 'draw',
    ps: Math.round(ps * 100) / 100,
    ns: Math.round(ns * 100) / 100,
    reviewed: decideLog.length,
    misses: misses.slice(0, REVIEW_TOP),
  });
  if (gameLog.length > GAMES_MAX) gameLog = gameLog.slice(-GAMES_MAX);
  saveGames();
}
// 把本局 + 累计丢分渲染成人类可读文本（结算层展开区）
function coachSummary() {
  const g = gameLog[gameLog.length - 1];
  if (!g) return '还没有复盘记录：打完整局后这里会显示。';
  const axisName = { play: '出牌', replace: '补牌', penalty: '罚牌' };
  const lines = ['本局（' + diffLabel(g.diff) + ' · ' + (g.result === 'win' ? '赢' : g.result === 'loss' ? '输' : '平') + ' ' + g.ps + ' : ' + g.ns + '）'];
  if (!g.misses.length) lines.push('  没有明显丢分，跟最优走法基本一致 👍');
  else {
    lines.push('  最大丢分 ' + g.misses.length + ' 处（前 ' + g.misses.length + ' 条）：');
    g.misses.slice(0, 3).forEach((m) => {
      lines.push('  · ' + (axisName[m.axis] || m.axis) + '：最优比你这步高 ' + m.gap.toFixed(2) + ' 分' + (m.cause ? '（' + (m.cause === 'fed' ? '资敌' : '失后路') + '）' : ''));
    });
  }
  // 累计弱点（最近所有局）
  const cnt = { play: 0, replace: 0, penalty: 0 }; let fed = 0, routed = 0;
  gameLog.forEach((gg) => gg.misses.forEach((m) => { if (cnt[m.axis] !== undefined) cnt[m.axis]++; if (m.cause === 'fed') fed++; else if (m.cause === 'routed') routed++; }));
  const total = cnt.play + cnt.replace + cnt.penalty;
  if (total) lines.push('累计（最近 ' + gameLog.length + ' 局）丢分：出牌 ' + cnt.play + ' · 补牌 ' + cnt.replace + ' · 罚牌 ' + cnt.penalty + (fed + routed ? '（补牌里 资敌 ' + fed + ' / 失后路 ' + routed + '）' : ''));
  return lines.join('\n');
}
// 导出全部复盘记录 → 喂给 node tools-coach.js 离线聚合成弱点报告
function exportGames() {
  const payload = {
    v: 1,
    note: '欢乐十四分·复盘教练导出：每局的最大丢分决策。离线分析：node tools-coach.js 文件1.json 文件2.json …',
    games: gameLog,
  };
  const txt = JSON.stringify(payload, null, 2);
  const ta = $('gameOut');
  if (ta && 'value' in ta) { ta.value = txt; if (ta.classList) ta.classList.add('show'); if (ta.select) ta.select(); }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      const p = navigator.clipboard.writeText(txt);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  } catch (e) {}
  return txt;
}

function loadLearn() {
  try {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem(LEARN_KEY);
    if (!raw) return;
    const o = JSON.parse(raw);
    if (!o || o.v !== 1) return;
    if (o.weights) learned.weights = o.weights;
    if (o.stats) learned.stats = o.stats;
    if (typeof o.reviewed === 'number') learned.reviewed = o.reviewed;
    if (o.holes) learned.holes = o.holes;
    if (o.causes) learned.causes = o.causes;
    if (typeof o.drift === 'number') learned.drift = o.drift;
    if (Array.isArray(o.log)) learned.log = o.log.slice(-5);
  } catch (e) {}
}
function saveLearn() {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(LEARN_KEY, JSON.stringify(learned));
  } catch (e) {}
}
// 学习强度：容易/中等 = 0（永不学、永远出厂强度）；难 = 0.5（只吃一半）；地狱 = 1（全量）
function learnIntensity(sel) { return sel === 'hell' ? 1 : sel === 'hard' ? 0.5 : 0; }
function learningArmed() { return learnIntensity(npcDifficulty) > 0; }
function applyLearnWeights(sel) {
  if (!G || !G.setNpcWeights || !G.DEFAULT_WEIGHTS) return;
  const t = learnIntensity(sel);
  if (!t || !learned.weights) { G.setNpcWeights(G.DEFAULT_WEIGHTS); return; }
  const out = {};
  Object.keys(G.DEFAULT_WEIGHTS).forEach((k) => {
    const d = G.DEFAULT_WEIGHTS[k];
    const v = (learned.weights[k] === undefined ? d : learned.weights[k]);
    out[k] = Math.round((d + (v - d) * t) * 1000) / 1000;
  });
  G.setNpcWeights(out);
}
function learnSnapshot() {
  const d = G.DEFAULT_WEIGHTS;
  const lt = learned.weights || d;
  const t = learnIntensity(npcDifficulty);
  const out = {};
  Object.keys(d).forEach((k) => { out[k] = Math.round((d[k] + (lt[k] - d[k]) * t) * 1000) / 1000; });
  return { base: d, learned: lt, applied: out, intensity: t };
}
function pushDecide(rec) { if (decideLog.length < LEARN_MAX_DEC) decideLog.push(rec); }
// 记录决策点：全难度都记（教练复盘要在任何一局都能指出"哪几步丢分"）。
// 只在内存里、每局封顶 LEARN_MAX_DEC、新局即清，成本可控。
// 学习系统仍只吃"难/地狱 且 你赢"的局（那 gate 在 runLearn 里，这里不管）。
function recordPlayDecision(move) {
  if (!G.cloneState) return;
  const rec = { k: 'play', st: G.cloneState(state), handIds: move.handCards.map((c) => c.id), tableId: move.tableCard.id };
  pushDecide(rec);
  pendingPlay = rec;
}
function recordReplaceDecision(cardId) {
  if (!pendingPlay) return;
  pushDecide({ k: 'rep', st: pendingPlay.st, handIds: pendingPlay.handIds, tableId: pendingPlay.tableId, cardId: cardId });
  pendingPlay = null;
}
function recordPenaltyDecision(cardId) {
  if (!G.cloneState) return;
  pushDecide({ k: 'pen', st: G.cloneState(state), cardId: cardId });
}
function findMoveBy(moves, handIds, tableId) {
  for (const mv of moves) {
    if (mv.tableCard.id !== tableId) continue;
    const ids = mv.handCards.map((c) => c.id);
    if (ids.length === handIds.length && ids.every((x) => handIds.indexOf(x) >= 0)) return mv;
  }
  return null;
}
// 罚牌没有 move，不能用 evalMoveRollout → 罚掉这张后贪心推演到终局，取"我"的净分差
function penValue(st, cardId) {
  const s2 = G.cloneState(st);
  G.penalty(s2, 'player', cardId);
  s2.turn = 'npc';
  return Math.round(G.playOutGreedy(s2, 'player') * 100) / 100;
}
// 复盘本局。返回到结算层显示的一行说明（无学习则为空串）
function runLearn(ps, ns) {
  const sel = npcDifficulty;
  const st = learned.stats[sel];
  if (!st) { decideLog = []; pendingPlay = null; return ''; }
  if (ps > ns) st.w++; else if (ns > ps) st.l++;
  const won = ps > ns;
  let note = '';
  if (learningArmed() && won && decideLog.length) {
    const votes = { keepUp: 0, keepDown: 0, deadUp: 0, deadDown: 0 };
    const holes = { play: 0, rep: 0, pen: 0 };
    let repFed = 0, repRouted = 0;   // 只读败因：补牌失误里"资敌" vs "失后路"（不自动调参，仅累计进 learned.causes）
    for (const d of decideLog) {
      try {
        if (d.k === 'play') {
          const moves = G.findMoves(d.st.playerHand, d.st.table);
          if (!moves.length) continue;
          const mine = findMoveBy(moves, d.handIds, d.tableId);
          const eng = G.rankMoves(moves)[0];
          if (!mine || !eng) continue;
          // 两臂都用 null（都交给自动补牌）：只让"出哪一手"这一个变量不同，才是配对比较
          // 同一手出牌：引擎用"最优补牌"的净分差 vs 玩家用"自己选的补牌"——
          // 差异全在补牌这一步（selfW/defenseW/keepW 三个权重揉在 netReplaceId 里），
          // 所以只记到 rep 洞（补牌失误），不拆出假的 self 洞（会过拟合）。
          if (G.evalMoveRollout(d.st, 'player', mine, null) > G.evalMoveRollout(d.st, 'player', eng, null) + LEARN_MARGIN) holes.play++;
        } else if (d.k === 'rep') {
          const moves = G.findMoves(d.st.playerHand, d.st.table);
          const mv = findMoveBy(moves, d.handIds, d.tableId);
          if (!mv) continue;
          const engId = G.netReplaceId(d.st, 'player', mv);
          if (!engId || engId === d.cardId) continue;
          if (G.evalMoveRollout(d.st, 'player', mv, d.cardId) > G.evalMoveRollout(d.st, 'player', mv, engId) + LEARN_MARGIN) {
            holes.rep++;
            const c1 = d.st.playerHand.find((x) => x.id === d.cardId);
            const c2 = d.st.playerHand.find((x) => x.id === engId);
            if (c1 && c2) {
              const k1 = G.keepValue(c1, d.st), k2 = G.keepValue(c2, d.st);
              if (k1 < k2) votes.keepUp++; else if (k1 > k2) votes.keepDown++;
            }
            // 只读败因归因（不反向调参，只累计进 causes 给你看）：
            // 玩家补的这张 vs 引擎最优补的那张，谁让"对手下一手可捞分"更高 = 资敌(feed)；
            // 威胁侧差不多但玩家留的牌对自己下一手价值更低 = 失后路(routed)。
            const stM = G.cloneState(d.st); G.capture(stM, 'player', mv); G.replaceAndRefill(stM, 'player', d.cardId);
            const stE = G.cloneState(d.st); G.capture(stE, 'player', mv); G.replaceAndRefill(stE, 'player', engId);
            const oppM = G.opponentBestGain(stM, 'player'), oppE = G.opponentBestGain(stE, 'player');
            if (oppM - oppE >= LEARN_MARGIN) repFed++;          // 你补的牌喂对手更多
            else repRouted++;                                    // 你补的牌没给自己留抓手
          }
        } else if (d.k === 'pen') {
          if (G.findMoves(d.st.playerHand, d.st.table).length) continue;   // 引擎这手会出牌 → 不是同一分支
          const eng = G.chooseAction(d.st, 'player', { difficulty: 'hell' });
          if (!eng || eng.type !== 'penalty' || eng.cardId === d.cardId) continue;
          if (penValue(d.st, d.cardId) > penValue(d.st, eng.cardId) + LEARN_MARGIN) {
            holes.pen++;
            const c1 = d.st.playerHand.find((x) => x.id === d.cardId);
            const c2 = d.st.playerHand.find((x) => x.id === eng.cardId);
            if (c1 && c2) {
              const p1 = G.playability(d.st, c1), p2 = G.playability(d.st, c2);
              if (p1 < p2) votes.deadUp++; else if (p1 > p2) votes.deadDown++;
            }
          }
        }
      } catch (e) { /* 单个决策点出错不影响整局复盘 */ }
    }
    learned.reviewed++;
    learned.holes.play += holes.play; learned.holes.rep += holes.rep; learned.holes.pen += holes.pen;
    learned.causes.fed += repFed; learned.causes.routed += repRouted;
    const step = LEARN_STEP[sel] || 0;
    const w = Object.assign({}, G.DEFAULT_WEIGHTS, learned.weights || {});
    const parts = [];
    const kd = votes.keepUp - votes.keepDown;
    if (kd) {
      const r = LEARN_CLAMP.keepW;
      w.keepW = Math.max(r[0], Math.min(r[1], Math.round((w.keepW + step * (kd > 0 ? 1 : -1)) * 1000) / 1000));
      parts.push(kd > 0 ? '补牌更敢甩负担' : '补牌别急着甩负担');
    }
    const pd = votes.deadUp - votes.deadDown;
    if (pd) {
      const r = LEARN_CLAMP.playW;
      w.playW = Math.max(r[0], Math.min(r[1], Math.round((w.playW + step * (pd > 0 ? 1 : -1)) * 1000) / 1000));
      parts.push(pd > 0 ? '罚牌更先扔死牌' : '罚牌别只看死没死');
    }
    if (parts.length) {
      learned.weights = w; learned.drift++;
      learned.log.push(new Date().toISOString().slice(0, 10) + ' 赢下' + diffLabel(sel) + '，调整：' + parts.join('、'));
      if (learned.log.length > 5) learned.log = learned.log.slice(-5);
    }
    saveLearn();
    note = '🧠 本局复盘：引擎被你反超 ' + (holes.play + holes.rep + holes.pen) + ' 处（出牌 ' + holes.play
      + ' · 补牌 ' + holes.rep + ' · 罚牌 ' + holes.pen + '）'
      + (parts.length ? '，已微调：' + parts.join('、') : '（没到调参门槛）');
  } else if (learningArmed()) {
    saveLearn();
    note = won ? '🧠 本局赢了，但可复盘的手太少' : '🧠 只学你赢的局：本局没赢 → 不记入权重（只记战绩）';
  }
  decideLog = []; pendingPlay = null;
  return note;
}
function learnSummaryText() {
  const s = learned.stats, w = learned.weights, sl = learnSnapshot();
  const f = (k, o) => k + ' ' + Number(o[k]).toFixed(2);
  const keys = Object.keys(G.DEFAULT_WEIGHTS);
  return '战绩：难 ' + s.hard.w + '胜' + s.hard.l + '负 · 地狱 ' + s.hell.w + '胜' + s.hell.l + '负 · 已复盘 ' + learned.reviewed + ' 局\n'
    + '引擎被反超：出牌 ' + learned.holes.play + ' 次（仅记录）· 补牌 ' + learned.holes.rep + ' · 罚牌 ' + learned.holes.pen + '\n'
    + (learned.causes && (learned.causes.fed || learned.causes.routed)
      ? '补牌失误败因（只读，不自动调参）：资敌 ' + learned.causes.fed + ' · 失后路 ' + learned.causes.routed + '\n'
      : '')
    + (w ? '学习后权重：' + keys.map((k) => f(k, w)).join(' / ') + '\n' : '还没学到东西：权重 = 出厂默认\n')
    + '本档实际生效（强度 ' + sl.intensity + '）：' + keys.map((k) => f(k, sl.applied)).join(' / ');
}
function renderLearn() {
  const body = $('learnBody');
  if (body) body.textContent = learnSummaryText() + (learned.log.length ? '\n\n最近调整：\n' + learned.log.join('\n') : '');
  const ta = $('learnOut');
  if (ta && 'value' in ta) { ta.value = ''; if (ta.classList) ta.classList.remove('show'); }
}
function openLearn() {
  const m2 = $('learnModal');
  if (m2 && m2.classList) m2.classList.remove('hidden');
  renderLearn();
}
function closeLearn() {
  const m2 = $('learnModal');
  if (m2 && m2.classList) m2.classList.add('hidden');
}
function exportLearn() {
  const payload = {
    v: 1, note: '学习系统导出：weights 即"被玩家教过一轮"的权重，可直接写进 game-core.js 的 DEFAULT_WEIGHTS',
    weights: learned.weights, defaultWeights: G.DEFAULT_WEIGHTS, stats: learned.stats,
    reviewed: learned.reviewed, holes: learned.holes, causes: learned.causes, drift: learned.drift, log: learned.log,
  };
  const txt = JSON.stringify(payload, null, 2);
  const ta = $('learnOut');
  if (ta && 'value' in ta) { ta.value = txt; if (ta.classList) ta.classList.add('show'); if (ta.select) ta.select(); }
  try {
    // writeText 返回 Promise：在非安全上下文/无权限时会被拒（未接 .catch 会变成未捕获异常）
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      const p = navigator.clipboard.writeText(txt);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  } catch (e) {}
  return txt;
}
function resetLearn() {
  learned = {
    v: 1, weights: null, stats: { hard: { w: 0, l: 0 }, hell: { w: 0, l: 0 } },
    reviewed: 0, holes: { play: 0, rep: 0, pen: 0 }, causes: { fed: 0, routed: 0 }, drift: 0, log: [],
  };
  saveLearn();
  applyLearnWeights(npcDifficulty);
  renderLearn();
}

// 手机版整体降一档：构建时注入 window.H14_EASY_SHIFT=1 才生效；桌面版/小程序无此标记，零变化
const H14_SHIFT = (typeof window !== 'undefined' && window.H14_EASY_SHIFT)
  ? { hell: 'hard', hard: 'medium', medium: 'easy', easy: 'easy' } : null;
function effectiveDifficulty() {
  const d = npcDifficulty;
  return (H14_SHIFT && H14_SHIFT[d]) || d;
}

// 开局是否还问难度
let askDiff = true;
let firstRunPending = false;   // 本次会话是否还欠一次"首次自动弹玩法"
function loadAskDiff() {
  try {
    if (typeof localStorage === 'undefined') return;
    const v = localStorage.getItem('h14_askdiff');
    if (v === '0') askDiff = false; else if (v === '1') askDiff = true;
  } catch (e) {}
}
function setAskDiff(v) {
  askDiff = !!v;
  try { if (typeof localStorage !== 'undefined') localStorage.setItem('h14_askdiff', askDiff ? '1' : '0'); } catch (e) {}
}

const $ = (id) => document.getElementById(id);
const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
function setMessage(msg) { set('message', msg); }
// 绑局次的延时：中途开新局，旧回调自动作废
function after(ms, fn) {
  if (typeof setTimeout !== 'function') return;
  const ep = episode;
  setTimeout(() => { if (ep === episode) fn(); }, ms);
}
function eqText(cards) { return cards.map((c) => (c.short ? c.short + c.suitSymbol : c.label + c.suitSymbol)).join(' + '); }
function cardName(c) { return c.short + c.suitSymbol; }

// ---------- NPC 卡通形象（圆滚滚小可爱，卡哇伊升级版：大圆眼 + 双高光 + 腮红 + 心形天线 + 闪粉） ----------
const NC = '#4a3b42';
const NPCH = '#ff9ec4';
// 大圆眼（带主/次双高光，萌点所在）
function eyeBig(kind) {
  const r = kind === 'shock' ? 8.2 : 7.6;
  const cy = kind === 'think' ? 35 : (kind === 'shock' ? 39 : 38);
  const px = kind === 'think' ? 27.6 : 27, py = kind === 'think' ? 32.4 : 35.6;
  const sx = kind === 'think' ? 29.2 : 29.4, sy = kind === 'think' ? 36 : 38.6;
  return '<circle cx="27" cy="' + cy + '" r="' + r + '" fill="' + NC + '"/><circle cx="45" cy="' + cy + '" r="' + r + '" fill="' + NC + '"/>' +
    '<circle cx="' + px + '" cy="' + py + '" r="2.7" fill="#fff"/><circle cx="' + (px + 18) + '" cy="' + py + '" r="2.7" fill="#fff"/>' +
    '<circle cx="' + sx + '" cy="' + sy + '" r="1.4" fill="#fff" opacity=".9"/><circle cx="' + (sx + 18) + '" cy="' + sy + '" r="1.4" fill="#fff" opacity=".9"/>';
}
// 弯弯笑眼 ^ ^（开心 / 难过下垂眼）
function eyeArc(kind) {
  if (kind === 'happy') {
    return '<path d="M20 39 q7 -8 14 0" stroke="' + NC + '" stroke-width="3.6" fill="none" stroke-linecap="round"/>' +
      '<path d="M38 39 q7 -8 14 0" stroke="' + NC + '" stroke-width="3.6" fill="none" stroke-linecap="round"/>';
  }
  return '<path d="M20 40 q7 7 14 0" stroke="' + NC + '" stroke-width="3.6" fill="none" stroke-linecap="round"/>' +
    '<path d="M38 40 q7 7 14 0" stroke="' + NC + '" stroke-width="3.6" fill="none" stroke-linecap="round"/>' +
    '<path d="M22 44 q1.7 5 0 8.4 q-1.7 -3.2 0 -8.4 z" fill="#8fd0ff" stroke="#5aa" stroke-width="0.7"/>';
}
// 星星眼（贪心：看到高分牌眼睛变星）
function eyeStar() {
  const star = (cx) => '<path d="M' + cx + ' 30 L' + (cx + 2) + ' 35 L' + (cx + 7) + ' 36 L' + (cx + 2) + ' 38 L' + cx + ' 43 L' + (cx - 2) + ' 38 L' + (cx - 7) + ' 36 L' + (cx - 2) + ' 35 Z" fill="#ffd43b" stroke="#e88" stroke-width="1.2" stroke-linejoin="round"/>';
  return star(27) + star(45);
}
const NPC_FACES = {
  idle: { halo: '#cdeede', eye: eyeBig('idle'),
    mouth: '<path d="M30 50 q6 5 12 0" stroke="' + NC + '" stroke-width="2.6" fill="none" stroke-linecap="round"/>' },
  think: { halo: '#ddd2ff', eye: eyeBig('think'),
    mouth: '<ellipse cx="36" cy="51" rx="2.8" ry="3.4" fill="' + NC + '"/>' },
  happy: { halo: '#ffe9a8', eye: eyeArc('happy'),
    mouth: '<path d="M28 48 q8 11 16 0 z" fill="' + NC + '"/><path d="M31 51 q5 4 10 0" stroke="#ff9ec4" stroke-width="2" fill="none"/>' },
  greedy: { halo: '#ffd9b0', eye: eyeStar(),
    mouth: '<path d="M27 49 q9 13 18 0 z" fill="' + NC + '"/><path d="M33 53 q3 4 6 0 z" fill="#ff9ec4"/>' },
  shock: { halo: '#ffc8db', eye: eyeBig('shock'),
    mouth: '<ellipse cx="36" cy="51" rx="3.8" ry="4.6" fill="' + NC + '"/>' },
  sad: { halo: '#dcd6cf', eye: eyeArc('sad'),
    mouth: '<path d="M30 52 q6 -5 12 0" stroke="' + NC + '" stroke-width="2.8" fill="none" stroke-linecap="round"/>' },
};
function npcFaceSvg(mood) {
  const f = NPC_FACES[mood] || NPC_FACES.idle;
  const face =
    '<circle cx="36" cy="36" r="32" fill="' + f.halo + '"/>' +
    // 心形天线
    '<path d="M36 10 v-5" stroke="#e58" stroke-width="2" stroke-linecap="round"/>' +
    '<path d="M36 2.4 c-2.4 -3 -7 -1.2 -7 2.2 c0 2.6 3.4 4.6 7 7.4 c3.6 -2.8 7 -4.8 7 -7.4 c0 -3.4 -4.6 -5.2 -7 -2.2 z" fill="#ff7aa8" stroke="#ff5d8f" stroke-width="0.8"/>' +
    // 闪粉星（左上 / 右下）
    '<path d="M13 24 l1.4 3 l3 1.4 l-3 1.4 l-1.4 3 l-1.4 -3 l-3 -1.4 l3 -1.4 z" fill="#fff" opacity=".75"/>' +
    '<path d="M58 50 l1 2.2 l2.2 1 l-2.2 1 l-1 2.2 l-1 -2.2 l-2.2 -1 l2.2 -1 z" fill="#fff" opacity=".6"/>' +
    // 圆脸
    '<circle cx="36" cy="41" r="25" fill="#fff7fb" stroke="' + NPCH + '" stroke-width="2.8"/>' +
    // 腮红
    '<ellipse cx="22" cy="47" rx="5.2" ry="3.6" fill="#ff9ec4" opacity=".7"/>' +
    '<ellipse cx="50" cy="47" rx="5.2" ry="3.6" fill="#ff9ec4" opacity=".7"/>' +
    f.eye + f.mouth;
  return '<svg viewBox="0 0 72 72" width="100%" height="100%" aria-hidden="true">' + face + '</svg>';
}

// NPC 说话：全部走顶部一行轻量气泡（砍掉桌面版大娃娃 + 座位小气泡两种）；气泡自带卡哇伊头像
let bubbleGen = 0;
let npcMood = 'idle';
function setNpcMood(mood) {
  npcMood = mood;
  const el = $('npcAvatar'); if (el) el.innerHTML = npcFaceSvg(mood);
  const ba = $('npcSayAvatar'); if (ba) ba.innerHTML = npcFaceSvg(mood);   // 气泡里的头像同步
}
function npcSay(event, chance) {
  if (!A || !A.npcSay || !state || state.phase === 'gameover') return;
  const line = A.npcSay(event, { chance: chance });
  if (!line) return;
  setNpcMood(line.mood);
  showNpcBubble(line.text);
}
// 气泡 = 卡哇伊头像 + 文字
function showNpcBubble(text) {
  const el = $('npcSay');
  if (!el) return;
  el.innerHTML = '<span id="npcSayAvatar" class="npc-say-avatar">' + npcFaceSvg(npcMood) + '</span><span class="npc-say-text">' + text + '</span>';
  if (el.classList) { el.classList.remove('hidden'); el.classList.add('show'); }
  const g = ++bubbleGen;
  after(sayDur(text), () => { if (g === bubbleGen && el.classList) { el.classList.remove('show'); el.classList.add('hidden'); } });
}
function hideNpcBubble() {
  bubbleGen++;
  const el = $('npcSay');
  if (el && el.classList) { el.classList.remove('show'); el.classList.add('hidden'); }
}
function npcSituationLine() {
  if (!state || state.phase === 'gameover') return;
  const diff = G.computeScore(state, 'npc') - G.computeScore(state, 'player');
  if (state.drawPile.length <= 8) { npcSay('lowDraw'); return; }
  if (diff >= 3) { npcSay('ahead', 0.5); return; }
  if (diff <= -3) { npcSay('behind', 0.5); }
}

// 先手宣告
function announceFirst() {
  const b = $('firstBanner');
  if (!b || !b.classList) return;
  const t = $('firstBannerText');
  if (t) t.textContent = (state.turn === 'player') ? '你先手' : 'NPC 先手';
  b.classList.remove('hidden');
  after(1600, () => b.classList.add('hidden'));
}

// 浮动提示
function fxHost() {
  let host = $('fx');
  if (host) return host;
  host = document.createElement('div');
  host.className = 'fx';
  if (document.body && document.body.appendChild) document.body.appendChild(host);
  return host;
}
function toast(text, kind) {
  const host = fxHost();
  if (!host || !host.appendChild) return;
  const d = document.createElement('div');
  d.className = 'toast' + (kind ? ' ' + kind : '');
  d.textContent = text;
  host.appendChild(d);
  if (typeof setTimeout === 'function') setTimeout(() => { if (host.removeChild) host.removeChild(d); }, 1500);
}
function pulseEl(id, cls) {
  const el = $(id);
  if (!el || !el.classList) return;
  const c = cls || 'pulse';
  el.classList.add(c);
  if (typeof setTimeout === 'function') setTimeout(() => el.classList.remove(c), 800);
}

// ---------- 同牌挑战（seed 发牌：同种子 = 同一副牌 + 同先手，链接发给朋友比分数） ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let currentSeed = 0;          // 本局发牌种子（结算分享时带出去）
let challenge = null;         // 从 URL 读到的挑战：{ s, d, score }
let challengeUsed = false;    // 挑战种子只在进局第一局使用

// ---------- ① 今日牌局：同一天 = 同一副牌（日期做种子的 FNV-1a），本地记同种子最佳 ----------
let todayMode = false;         // 「今日牌局」持续开关：本会话内再开一局仍是同一副牌（按日期种子刷分）
let isTodayGame = false;       // 当前这局是否今日牌局
const TODAY_KEY = 'h14_todaybest_v1';
let todayBest = {};           // { '2026-10-08': 12.5, ... } 本设备每个日期的最佳分
function todaySeedStr() {
  const d = new Date();
  const p = (x) => (x < 10 ? '0' + x : '' + x);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function todaySeed() {
  const s = todaySeedStr();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
function loadTodayBest() {
  try { const raw = localStorage.getItem(TODAY_KEY); if (raw) todayBest = JSON.parse(raw) || {}; } catch (e) { todayBest = {}; }
}
function saveTodayBest() {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(TODAY_KEY, JSON.stringify(todayBest)); } catch (e) {}
}
function todayBestLine() {
  const b = todayBest[todaySeedStr()];
  return b != null ? ' · 本机最佳 ' + b.toFixed(2) + ' 分' : '';
}

// ---------- ② 成就/称号：本局判定 + 本地累计（localStorage），结算闪现新得 ----------
const ACHV_KEY = 'h14_achv_v1';
const ACHV = {
  dualKings: { icon: '🃏', name: '双王收集者', desc: '一局内把大王和小王都收进战利品' },
  zeroPen:   { icon: '🧊', name: '零罚大师', desc: '整局没罚掉一张牌，还收进了战利品' },
  hellKill:  { icon: '🔥', name: '地狱屠龙', desc: '赢下一局「地狱」难度' },
  score15:   { icon: '💯', name: '15分俱乐部', desc: '一局收进 15 分以上的战利品' },
};
let achv = {};               // { id: true } 已达成
function loadAchv() {
  try { const raw = localStorage.getItem(ACHV_KEY); if (raw) achv = JSON.parse(raw) || {}; } catch (e) { achv = {}; }
}
function saveAchv() {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(ACHV_KEY, JSON.stringify(achv)); } catch (e) {}
}
// 返回本局新得的成就 id 列表（副作用：写进 achv 并落盘）
function earnAchievements(ps, ns) {
  const got = [];
  const jokers = state.playerLoot.filter((c) => c.isJoker);
  const hasBig = jokers.some((c) => c.label === '大王');
  const hasSmall = jokers.some((c) => c.label === '小王');
  if (hasBig && hasSmall && !achv.dualKings) { achv.dualKings = true; got.push('dualKings'); }
  if (state.playerPenalty.length === 0 && state.playerLoot.length > 0 && !achv.zeroPen) { achv.zeroPen = true; got.push('zeroPen'); }
  if (npcDifficulty === 'hell' && ps > ns && !achv.hellKill) { achv.hellKill = true; got.push('hellKill'); }
  if (ps >= 15 && !achv.score15) { achv.score15 = true; got.push('score15'); }
  if (got.length) saveAchv();
  return got;
}
function achvHtml() {
  return Object.keys(ACHV).map((id) => {
    const a = ACHV[id], on = !!achv[id];
    return '<div class="achv' + (on ? ' got' : '') + '"><span class="achv-ic">' + a.icon + '</span>' +
      '<span class="achv-name">' + a.name + '</span>' +
      '<span class="achv-desc">' + a.desc + '</span>' +
      '<span class="achv-state">' + (on ? '已达成' : '未达成') + '</span></div>';
  }).join('');
}
function openAchv() {
  const m = $('achvModal'); if (!m || !m.classList) return;
  const body = $('achvBody'); if (body) body.innerHTML = achvHtml();
  const got = Object.keys(ACHV).filter((id) => achv[id]).length;
  const cnt = $('achvCount'); if (cnt) cnt.textContent = got + ' / ' + Object.keys(ACHV).length;
  m.classList.remove('hidden');
  snd('tap');
}
function closeAchv() {
  const m = $('achvModal'); if (m && m.classList) m.classList.add('hidden');
}
(function parseChallenge() {
  try {
    const q = new URLSearchParams(location.search);
    const raw = q.get('s');
    if (raw === null || raw === '') return;
    const seed = parseInt(raw, 10);
    if (!isFinite(seed)) return;
    const d = q.get('d');
    challenge = {
      s: seed >>> 0,
      d: (d && DIFF_DESC[d]) ? d : 'medium',
      score: parseFloat(q.get('score')),
    };
  } catch (e) { /* file:// 等环境读不到 search 就当普通开局 */ }
})();

// ---------- 流程 ----------
function newGame() {
  if (challenge && !challengeUsed) { npcDifficulty = challenge.d; }   // 挑战局：按链接指定的难度打
  applyLearnWeights(npcDifficulty);   // 易/中=出厂权重；难吃一半、地狱全量（只有这两档会学）
  decideLog = []; pendingPlay = null;
  // 种子优先级：挑战链接 > 今日牌局（按日期，同一天人人同副牌）> 随机
  const useChallenge = challenge && !challengeUsed;
  if (useChallenge) challengeUsed = true;
  isTodayGame = !useChallenge && todayMode;
  currentSeed = useChallenge ? challenge.s : (isTodayGame ? todaySeed() : ((Math.random() * 0xffffffff) >>> 0));
  const rng = useChallenge ? mulberry32(challenge.s) : (isTodayGame ? mulberry32(currentSeed) : undefined);
  state = G.createGame({ numDecks: 2, firstRandom: firstMoveRandom, rng: rng });
  episode++;
  ui.selHand = []; ui.selTable = null; ui.noMoves = false; ui.mergePlan = null; ui.penPlan = null;
  ui.mode = 'idle'; ui.valid = false; snap = null;
  $('overModal').classList.add('hidden');
  hideNpcShow();
  hidePlayerShow();
  setNpcMood('idle');
  hideNpcBubble();
  const eSh = H14_SHIFT && H14_SHIFT[npcDifficulty];
  const dl = diffLabel(npcDifficulty) + (eSh && eSh !== npcDifficulty ? '·实按' + diffLabel(eSh) : '');
  setMessage('🎴 新一局开始！' + (state.turn === 'player' ? '你先手' : 'NPC 先手') + '（难度：' + dl + '）');
  if (useChallenge) {
    const cScore = isFinite(challenge.score) ? challenge.score.toFixed(2) : null;
    setMessage('⚔️ 朋友发来的同牌挑战！同一副牌' + (cScore ? '，他拿了 ' + cScore + ' 分' : '') + '，看你能拿多少。');
  } else if (isTodayGame) {
    setMessage('📅 今日牌局！同一天玩的人都是这副牌，试试把' + todaySeedStr() + '打到最高分。' + todayBestLine());
  }
  announceFirst();
  snd('deal'); snd('start');
  renderAll();
  npcSay('start');
  // 先手缓冲：NPC 先手时先亮横幅、留约 1.3 秒观战时间，避免"一开局就猛出牌"的突兀感
  if (state.turn === 'npc') {
    after(1300, () => {
      if (!state || state.phase === 'gameover') return;
      setMessage('🤖 NPC 先手，请观战…');
      beginTurn();
    });
  } else {
    beginTurn();
  }
}

function beginTurn() {
  if (G.isGameOver(state)) {
    if (spectating) { spectateOver(G.computeScore(state, 'player'), G.computeScore(state, 'npc')); }
    else { showOver(); }
    return;
  }
  if (state.turn === 'player') {
    if (state.playerHand.length === 0) { state.turn = 'npc'; beginTurn(); return; }
    if (spectating) { spectatePlayerTurn(); return; }   // 观战："你"那侧交给引擎按容易自动出
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
  ui.mode = 'select';
  ui.noMoves = moves.length === 0;
  setMessage('轮到你出牌：点手牌，凑成 14 就确认。');
  recomputeCoach();
  renderControls();
  renderAll();
}

function onHandClick(card) {
  if (state.turn !== 'player' || state.phase === 'gameover' || !state) return;
  if (ui.mode === 'select') {
    const i = ui.selHand.indexOf(card.id);
    if (i >= 0) ui.selHand.splice(i, 1); else ui.selHand.push(card.id);
    snd('tap');
    updateSelectSum();
    renderAll();
  } else if (ui.mode === 'replace') {
    const judge = A ? A.judgeReplace(state.playerHand, state.table, [], card.id, {
      unknown: G.unknownPool(state), oppHandSize: state.npcHand.length,
    }) : null;
    if (judge && state.turn === 'player' && judge.chosen) {
      const mine = judge.chosen, alt = judge.suggest;
      if (!judge.optimal && alt) {
        const riskTxt = (x) => x.cost <= 0.3 ? '几乎送不出去' : (x.cost <= 0.6 ? '有点风险' : '风险偏高');
        const keepTxt = (x) => x.path > 0 ? '留手上还能凑牌' : '留手上没用';
        toast('💡 换个思路：补「' + cardName(alt.card) + '」比你现在这张更稳——它' + riskTxt(alt) + '、' + keepTxt(alt) + '；你选的这张' + riskTxt(mine) + '、' + keepTxt(mine), 'warn');
      }
    }
    recordReplaceDecision(card.id);
    const before = state.playerHand.map((c) => c.id);
    G.replaceAndRefill(state, 'player', card.id);
    const r = refillInfo('player', before);
    setMessage(r.got > 0 ? '补牌 +' + r.got + ' → 手牌 ' + r.total + ' 张' : '补牌堆已空，不再补牌');
    if (r.got > 0) { snd('draw'); pulseEl('drawCount', 'pulse'); }
    toast(r.got > 0 ? '补牌 +' + r.got + ' 张' : '补牌堆已空', 'good');
    ui.mode = 'idle';
    renderAll();
    after(T_HAND_OFF, endPlayerTurn);
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
  let msg = '当前和：' + sum + (ok ? ' ✅ 可以匹配！' : '');
  setMessage(msg);
  renderControls();
}

function confirmMatch() {
  if (!ui.valid || ui.mode !== 'select') return;
  const handCards = state.playerHand.filter((c) => ui.selHand.includes(c.id));
  const tableCard = state.table.find((c) => c.id === ui.selTable);
  const move = { handCards, tableCard, captured: handCards.concat([tableCard]) };
  const captured = move.captured;
  const gain = Math.round(G.sumScore(move.captured) * 100) / 100;
  const sum = G.sumMatchValue(handCards) + tableCard.matchValue;
  const ep = episode;

  const judge = A ? A.judgeMatch(state.playerHand, state.table, ui.selHand, ui.selTable) : null;
  if (judge && !judge.optimal && judge.best) {
    toast('💡 还有更赚的：' + eqText(judge.best.captured) + ' = 14（+' + judge.bestGain.toFixed(2) + ' 分）', 'warn');
  }
  if (coachOn && judge) coachLast = { gain: judge.gain, bestGain: judge.bestGain, optimal: judge.optimal };
  if (coachOn) coachHint = { hand: new Set(), table: new Set(), bestHand: new Set(), bestTable: new Set() };
  snd('flip');

  // 玩家也走"圈定 → 抬起 → 亮出等式/得分 → 收牌"的过程，与 NPC 一致（只是更轻量）
  ui.mode = 'merging';
  ui.mergePlan = { tableId: tableCard.id, handIds: handCards.map((c) => c.id), stage: 'lock', player: true };
  setMessage('🔗 已圈住桌面的 ' + cardName(tableCard) + '：' + eqText(handCards) + ' = ' + sum + '，合牌中…');
  toast('圈定 ' + eqText(move.captured) + ' = ' + sum, 'good');
  renderControls();
  renderAll();

  after(T_PLAYER_LIFT, () => {
    if (ep !== episode || !ui.mergePlan) return;
    ui.mergePlan.stage = 'lift';
    renderAll();
    after(T_PLAYER_LIFT, () => {
      if (ep !== episode || !ui.mergePlan) return;
      ui.mergePlan.stage = 'reveal';
      setMessage('✅ 你凑成了：' + eqText(captured) + ' = ' + sum + '，收走 ' + captured.length + ' 张！');
      showPlayerShow(playerShowSimpleHtml(captured, sum, gain, captured.length, captured.some((c) => c.isJoker)));
      renderAll();
      after(T_PLAYER_READ, () => {
        if (ep !== episode || !ui.mergePlan) return;
        ui.mergePlan.stage = 'merge';
        markPlayerShowMerge();
        setMessage('🔗 合牌：' + eqText(captured) + ' = ' + sum + '，收走 ' + captured.length + ' 张。');
        renderAll();
        after(T_NPC_MERGE, () => {
          if (ep !== episode || !ui.mergePlan) return;
          ui.mergePlan = null;
          finishPlayerMerge(move, gain);
        });
      });
    });
  });
}

function finishPlayerMerge(move, gain) {
  hidePlayerShow();   // 收牌时收掉玩家亮牌浮层
  recordPlayDecision(move);
  G.capture(state, 'player', move);
  ui.selHand = []; ui.selTable = null; ui.valid = false;
  const gotJoker = move.captured.some((c) => c.isJoker);
  snd(gotJoker ? 'joker' : 'match');
  setMessage('✅ 合牌完成，你收获 ' + move.captured.length + ' 张 · +' + gain + ' 分。');
  toast('收获 ' + move.captured.length + ' 张 · +' + gain + ' 分', 'good');
  pulseEl('pLoot', 'pulse');
  renderAll();
  if (gotJoker) { toast('👑 连王一起捞走！', 'good'); npcSay('playerJoker'); }
  else if (gain >= 1.5) npcSay('playerBigLoot', 0.6);
  if (state.playerHand.length === 0) {
    const before = [];
    G.replaceAndRefill(state, 'player', null);
    const r = refillInfo('player', before);
    setMessage('✅ 匹配成功！手牌已空，自动从补牌堆补 1 张到桌面。');
    if (r.got > 0) pulseEl('drawCount', 'pulse');
    ui.mode = 'idle';
    renderAll(); renderControls();
    after(T_HAND_OFF, endPlayerTurn);
  } else {
    ui.mode = 'replace';
    setMessage('✅ 匹配成功！点 1 张手牌补到桌面，之后自动从补牌堆补满手牌。');
    renderCoach();
    renderAll(); renderControls();
  }
}

function doPenalty() {
  if (state.turn !== 'player' || ui.mode !== 'select' || ui.penPlan) return;
  if (ui.selHand.length !== 1) return;
  const card = state.playerHand.find((c) => c.id === ui.selHand[0]);
  if (!card) { ui.selHand = []; renderAll(); return; }
  const ep = episode;
  const judge = A ? A.judgePenalty(state.playerHand, state.table) : null;
  if (judge && judge.hasMove) {
    toast('💡 其实能出：' + eqText(judge.best.captured) + ' = 14（+' + judge.bestGain.toFixed(2) + ' 分）', 'warn');
  }
  snd('penalty');
  ui.mode = 'penalizing';
  ui.penPlan = card.id;
  setMessage('🚫 已扣下 ' + cardName(card) + '（隐藏），正在补牌…');
  renderAll(); renderControls();
  setTimeout(() => {
    if (ep !== episode) return;
    ui.penPlan = null;
    recordPenaltyDecision(card.id);
    const before = state.playerHand.map((c) => c.id);
    G.penalty(state, 'player', card.id);
    const r = refillInfo('player', before);
    ui.selHand = []; ui.selTable = null;
    setMessage(r.got > 0 ? '罚牌 −1，补牌 +' + r.got : '罚牌 −1（补牌堆已空，不再补）');
    toast(r.got > 0 ? '罚牌 −1，补牌 +' + r.got : '罚牌 −1（补牌堆已空）', 'warn');
    if (r.got > 0) { snd('draw'); pulseEl('drawCount', 'pulse'); }
    pulseEl('pLoot', 'pulse');
    ui.mode = 'idle';
    renderAll();
    npcSay('playerPenalty', 0.5);
    after(T_HAND_OFF, endPlayerTurn);
  }, T_PENALTY_OUT);
}

function refillInfo(who, beforeIds) {
  const hand = who === 'player' ? state.playerHand : state.npcHand;
  const got = hand.filter((c) => beforeIds.indexOf(c.id) < 0).length;
  return { got: got, total: hand.length };
}

function endPlayerTurn() {
  state.turn = 'npc';
  renderAll();
  beginTurn();
}

// ---------- NPC 亮牌浮层（轻量：牌面 + 等式 + 得分，不逐张翻） ----------
// 通用"亮牌"浮层构造：头部带卡哇伊头像 + 文字；谁在亮牌由 whoLabel/mood 决定；me=true 玩家绿主题
function showCardsHtml(captured, sum, gain, n, gotJoker, whoLabel, mood, me) {
  const cards = captured.map((c) => {
    const el = cardEl(c, false);
    el.classList.add('revealed');
    return el.outerHTML;
  }).join('<span class="plus"> + </span>');
  const eq = '<div class="npc-show-eq">' + eqText(captured) + ' = ' + sum +
    ' <span class="ok">✅</span><br><span class="gain">收获 ' + n + ' 张 · +' + gain + ' 分</span></div>';
  const avatar = '<span class="npc-show-avatar">' + npcFaceSvg(mood || 'happy') + '</span>';
  return '<div class="npc-show-box' + (me ? ' me' : '') + '"><div class="npc-show-head' + (me ? ' me' : '') + '">' +
    avatar + whoLabel + (gotJoker ? '（捞到王！）' : '') + '</div>' +
    '<div class="npc-show-cards">' + cards + '</div>' + eq + '</div>';
}
function npcShowSimpleHtml(captured, sum, gain, n, gotJoker) {
  return showCardsHtml(captured, sum, gain, n, gotJoker, 'NPC 亮牌', gotJoker ? 'greedy' : 'happy', false);
}
function playerShowSimpleHtml(captured, sum, gain, n, gotJoker) {
  return showCardsHtml(captured, sum, gain, n, gotJoker, '你凑成了', 'happy', true);
}
function showNpcShow(html) {
  const el = $('npcShow');
  if (!el) return;
  el.innerHTML = html;
  if (el.classList) el.classList.remove('hidden');
}
function showPlayerShow(html) {
  const el = $('playerShow');
  if (!el) return;
  el.innerHTML = html;
  if (el.classList) el.classList.remove('hidden');
}
function markNpcShowMerge() { const el = $('npcShow'); if (el && el.classList) el.classList.add('merging'); }
function markPlayerShowMerge() { const el = $('playerShow'); if (el && el.classList) el.classList.add('merging'); }
function hideNpcShow() {
  const el = $('npcShow');
  if (el && el.classList) { el.classList.add('hidden'); el.classList.remove('merging'); }
  if (el) el.innerHTML = '';
}
function hidePlayerShow() {
  const el = $('playerShow');
  if (el && el.classList) { el.classList.add('hidden'); el.classList.remove('merging'); }
  if (el) el.innerHTML = '';
}

// ---------- ③ NPC 观战：两个 NPC 自动打完一整局（"你"那侧也交给引擎出，看四档差距） ----------
// spectating=true 时：NPC 侧走现成 npcTurn（五拍演出照放），玩家侧走 spectatePlayerTurn（轻量 1 拍）。
// 结算不进结算弹窗，不记学习/复盘/成就（那不是真人打的），toast 播报后自动开下一局；顶栏横幅可停。
let spectating = false;
let spectatePrevDiff = 'medium';   // 进观战前的难度（"停止观战"恢复）
function startToday() {
  const ss = $('startScreen');
  if (ss && ss.classList) ss.classList.add('hidden');
  todayMode = true;
  spectating = false;
  snd('tap');
  requestNewGame();   // 走正常难度流程，但 todayMode 保证发的是"今日同副牌"
}
function startSpectate() {
  const ss = $('startScreen');
  if (ss && ss.classList) ss.classList.add('hidden');
  spectatePrevDiff = npcDifficulty;
  npcDifficulty = 'hell';           // NPC 侧坐"地狱"位（"容易 vs 地狱"直观看差距）
  todayMode = false;
  spectating = true;
  const b = $('spectateBanner'); if (b && b.classList) b.classList.remove('hidden');
  snd('tap');
  newGame();
}
function stopSpectate() {
  spectating = false;
  todayMode = false;
  npcDifficulty = spectatePrevDiff;
  const b = $('spectateBanner'); if (b && b.classList) b.classList.add('hidden');
  const ss = $('startScreen'); if (ss && ss.classList) ss.classList.remove('hidden');
  requestNewGame();
}
function spectateOver(ps, ns) {
  const verdict = ps > ns ? '贪心方赢了' : ns > ps ? '地狱方赢了' : '平手';
  setMessage('🎬 观战一局终：容易 ' + ps.toFixed(2) + ' vs 地狱 ' + ns.toFixed(2) + '（' + verdict + '），自动继续…');
  toast('🎬 ' + ps.toFixed(2) + ' vs ' + ns.toFixed(2) + '：' + verdict, 'npc');
  const ep = episode;
  after(2000, () => { if (ep !== episode || !spectating) return; newGame(); });
}
// 观战时"你"那侧：引擎按「容易」自动出，轻量演出（亮一下 → 入账 → 换边），五拍留给 NPC 侧
function spectatePlayerTurn() {
  ui.mode = 'idle'; ui.valid = false; ui.selHand = []; ui.selTable = null;
  ui.mergePlan = null; ui.penPlan = null;
  hideNpcShow(); hidePlayerShow();
  setMessage('🎬 贪心方出牌…');
  const ep = episode;
  after(600, () => {
    if (ep !== episode || !spectating) return;
    const action = G.chooseAction(state, 'player', { difficulty: 'easy' });
    if (action.type === 'match') {
      const captured = action.move.captured;
      const n = captured.length;
      const sum = G.sumMatchValue(action.move.handCards) + action.move.tableCard.matchValue;
      const gain = Math.round(G.sumScore(captured) * 100) / 100;
      showPlayerShow(showCardsHtml(captured, sum, gain, n, captured.some((c) => c.isJoker), '贪心方凑成', 'happy', true));
      snd('flip');
      renderAll();
      after(900, () => {
        if (ep !== episode || !spectating) return;
        hidePlayerShow();
        G.capture(state, 'player', action.move);
        const before = state.playerHand.map((c) => c.id);
        G.replaceAndRefill(state, 'player', action.replaceCardId);
        const r = refillInfo('player', before);
        if (r.got > 0) { snd('draw'); pulseEl('pLoot', 'pulse'); }
        toast('贪心方 收 ' + n + ' 张 · +' + gain + ' 分', 'npc');
        setMessage('🎬 贪心方：' + eqText(captured) + ' = ' + sum + '，收走 ' + n + ' 张');
        renderAll();
        after(700, () => { if (ep !== episode || !spectating) return; state.turn = 'npc'; beginTurn(); });
      });
    } else {
      const before = state.playerHand.map((c) => c.id);
      G.penalty(state, 'player', action.cardId);
      const r = refillInfo('player', before);
      if (r.got > 0) { snd('draw'); pulseEl('pLoot', 'pulse'); }
      showPlayerShow('<div class="npc-show-box me"><div class="npc-show-head">对手（容易档）凑不出</div><div class="npc-show-eq">罚牌 1 张（隐藏）</div></div>');
      toast('贪心方 罚牌 1 张（隐藏）', 'npc');
      setMessage('🎬 贪心方凑不出，罚牌 1 张（隐藏）');
      renderAll();
      after(900, () => { if (ep !== episode || !spectating) return; hidePlayerShow(); state.turn = 'npc'; beginTurn(); });
    }
  });
}

// ---------- NPC 回合（简化：指牌 → 亮牌浮层 → 入账） ----------
function npcTurn() {
  ui.mode = 'idle'; ui.valid = false; ui.selHand = []; ui.selTable = null;
  ui.mergePlan = null; ui.penPlan = null;
  hideNpcShow();
  hidePlayerShow();
  setNpcMood('think');
  setMessage('🤖 NPC 思考中…');
  renderControls();
  renderAll();
  npcSituationLine();

  after(T_NPC_THINK, () => {
    const action = G.chooseNpcAction(state, effectiveDifficulty());

    if (action.type === 'match') {
      const captured = action.move.captured;
      const n = captured.length;
      const sum = G.sumMatchValue(action.move.handCards) + action.move.tableCard.matchValue;
      const gain = Math.round(G.sumScore(captured) * 100) / 100;
      const gotJoker = captured.some((c) => c.isJoker);

      ui.mode = 'merging';
      ui.mergePlan = { tableId: action.move.tableCard.id, handIds: [], stage: 'point', npc: true };
      setNpcMood('think');
      setMessage('🤖 NPC 看中了桌面的 ' + cardName(action.move.tableCard) + '（箭头指着它）');
      snd('ring');
      renderAll();

      after(T_NPC_POINT, () => {
        if (!ui.mergePlan || ui.mergePlan.stage !== 'point') return;
        ui.mergePlan.stage = 'lift';
        renderAll();

        after(T_NPC_LIFT, () => {
          if (!ui.mergePlan || ui.mergePlan.stage !== 'lift') return;
          ui.mergePlan.stage = 'flip';
          setNpcMood(gotJoker ? 'greedy' : 'happy');
          showNpcShow(npcShowSimpleHtml(captured, sum, gain, n, gotJoker));
          snd('flip');
          renderAll();

          after(T_NPC_READ, () => {
            if (!ui.mergePlan) return;
            ui.mergePlan.stage = 'merge';
            markNpcShowMerge();
            setMessage('🔗 NPC 合牌：' + eqText(captured) + ' = ' + sum + '，收走 ' + n + ' 张。');
            renderAll();

            after(T_NPC_MERGE, () => {
              if (!ui.mergePlan) return;
              G.capture(state, 'npc', action.move);
              const before = state.npcHand.map((c) => c.id);
              G.replaceAndRefill(state, 'npc', action.replaceCardId);
              const r = refillInfo('npc', before);
              if (r.got > 0) { snd('draw'); pulseEl('nLoot', 'pulse'); }
              toast('NPC 收获 ' + n + ' 张 · +' + gain + ' 分', 'npc');
              renderAll();
              after(700, () => {
                ui.mergePlan = null;
                ui.mode = 'idle';
                hideNpcShow();
                setNpcMood('idle');
                if (gotJoker) npcSay('npcJoker');
                else if (gain >= 2 || n >= 3) npcSay('npcBigLoot', 0.85);
                else npcSay('npcMatch', 0.3);
                finishNpcTurn();
              });
            });
          });
        });
      });
    } else {
      ui.penPlan = null;
      setNpcMood('sad');
      snd('penalty');
      showNpcShow('<div class="npc-show-box"><div class="npc-show-head">🤖 NPC 无法匹配</div>' +
        '<div class="npc-show-eq">罚牌 1 张（隐藏）</div></div>');
      toast('NPC 罚牌 1 张（隐藏）', 'npc');
      after(1300, () => {
        const before = state.npcHand.map((c) => c.id);
        G.penalty(state, 'npc', action.cardId);
        const r = refillInfo('npc', before);
        if (r.got > 0) { snd('draw'); pulseEl('nLoot', 'pulse'); }
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

// ---------- 结算（简化：总分 + 胜负 + 王牌数，可展开明细） ----------
function scoreSummary(title, loot, pen, score) {
  const d = G.scoreDetail(loot);
  const dp = G.scoreDetail(pen);
  const jokers = d.joker.big.count + d.joker.small.count;
  const cls = title === '你' ? 'me' : 'npc';
  return '<div class="over-side"><b>' + title + '</b>：战利品 ' + d.count + ' 张（含王 ' + jokers +
    ' 张）· ' + d.total.toFixed(2) + ' 分；罚牌 ' + dp.count + ' 张 · ' + dp.total.toFixed(2) +
    ' 分 → <b>得分 ' + score.toFixed(2) + '</b></div>';
}
function showOver() {
  state.phase = 'gameover';
  const ps = G.computeScore(state, 'player');
  const ns = G.computeScore(state, 'npc');
  const winner = ps > ns ? '🎉 你赢了！' : ns > ps ? '🤖 NPC 赢了' : '🤝 平局！';
  const line = A ? A.npcSay(ps < ns ? 'overWin' : ps > ns ? 'overLose' : 'overDraw') : null;
  setNpcMood(ps < ns ? 'greedy' : ps > ns ? 'sad' : 'shock');
  const newAchv = earnAchievements(ps, ns);          // ② 判定本局新达成（副作用已落盘）
  // ① 今日牌局：记录本机同日期最佳分（仅当本局是今日牌局）
  let todayLine = '';
  if (isTodayGame) {
    const key = todaySeedStr();
    if (todayBest[key] == null || ps > todayBest[key]) { todayBest[key] = ps; todayLine = ' · 刷新本机最佳 ' + ps.toFixed(2) + ' 分'; }
    else { todayLine = ' · 本机最佳 ' + todayBest[key].toFixed(2) + ' 分（本局 ' + ps.toFixed(2) + '）'; }
    saveTodayBest();
  }
  recordGame(ps, ns);                    // 先复盘本局（runLearn 结尾会清空 decideLog）
  const learnNote = runLearn(ps, ns);   // 只学"你赢"的局；易/中不学

  const fmt = (arr) => arr.length ? arr.map((c) => c.label).join('、') : '（无）';

  hideNpcBubble();
  hidePlayerShow();
  $('overTitle').textContent = '本局结束';
  const gotCount = Object.keys(ACHV).filter((id) => achv[id]).length;
  const achvBar = newAchv.length ?
    '<div class="over-achv"><span class="over-achv-label">🏆 本局新达成</span>' +
    newAchv.map((id) => '<span class="o-achv">' + ACHV[id].icon + ' ' + ACHV[id].name + '</span>').join('') +
    '</div>' :
    '<div class="over-achv" style="border-style:solid;opacity:.6"><span class="over-achv-label">🏆 成就 ' + gotCount + ' / ' + Object.keys(ACHV).length + '</span>' +
    Object.keys(ACHV).filter((id) => achv[id]).map((id) => '<span class="o-achv" style="opacity:.75">' + ACHV[id].icon + ' ' + ACHV[id].name + '</span>').join('') +
    '</div>';
  $('overBody').innerHTML =
    '<div class="winner">' + winner + '</div>' +
    '<div class="over-score">你 <b>' + ps.toFixed(2) + '</b> ： <b>' + ns.toFixed(2) + '</b> NPC</div>' +
    (isTodayGame ? '<div class="over-score" style="font-size:14px;color:#ffd43b">📅 今日牌局 ' + todaySeedStr() + todayLine + '</div>' : '') +
    (line ? '<div class="over-say">🤖 NPC：「' + line.text + '」</div>' : '') +
    achvBar +
    scoreSummary('你', state.playerLoot, state.playerPenalty, ps) +
    scoreSummary('NPC', state.npcLoot, state.npcPenalty, ns) +
    (learnNote ? '<div class="over-rate">' + learnNote + '</div>' : '') +
    '<details class="coach-box"><summary>📋 教练复盘（你这局哪几步丢分）</summary>' +
    '<pre class="coach-body">' + coachSummary().replace(/</g, '&lt;') + '</pre>' +
    '<div class="coach-actions"><button id="overGameExport" class="go ghost">导出复盘记录</button></div>' +
    '</details>' +
    '<details><summary>查看双方全部牌面</summary>' +
    '<div>你的战利品：' + fmt(state.playerLoot) + '</div>' +
    '<div>你的罚牌：' + fmt(state.playerPenalty) + '</div>' +
    '<div>NPC 战利品：' + fmt(state.npcLoot) + '</div>' +
    '<div>NPC 罚牌：' + fmt(state.npcPenalty) + '</div>' +
    '</details>';
  $('overModal').classList.remove('hidden');
  snd(ps > ns ? 'win' : ps < ns ? 'lose' : 'drawEnd');
  if (newAchv.length) toast('🏆 新达成：' + newAchv.map((id) => ACHV[id].name).join('、'), 'ok');
}

// ---------- 结算分享：复制挑战链接（同一副牌 + 我的得分），发给朋友比一比 ----------
function buildChallengeLink() {
  const base = (location.origin && location.origin !== 'null' && /https?:/.test(location.origin))
    ? location.origin + location.pathname
    : 'https://h14-mobile-98661.app.workbuddy.host/';
  return base + '?s=' + currentSeed + '&d=' + npcDifficulty + '&score=' + G.computeScore(state, 'player').toFixed(2);
}
function shareChallenge() {
  const ps = G.computeScore(state, 'player');
  const ns = G.computeScore(state, 'npc');
  const verdict = ps > ns ? '赢了 NPC' : ps < ns ? '输给了 NPC' : '和 NPC 战平';
  const text = '⚔️ 欢乐十四分·同牌挑战：这副牌我 ' + ps.toFixed(2) + ' 分（' + verdict +
    '），敢不敢来比比？同一副牌、同一个 NPC 👉 ' + buildChallengeLink();
  const done = () => toast('挑战链接已复制，发给朋友吧！', 'ok');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else { fallbackCopy(text, done); }
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请手动复制链接'); }
  if (document.body.removeChild) document.body.removeChild(ta);
}

// ---------- 渲染 ----------
function cardEl(card, back) {
  const d = document.createElement('div');
  if (back) { d.className = 'card back'; d.innerHTML = '<span class="back-emoji">🂠</span>'; return d; }
  d.className = 'card' + (card.red ? ' red' : '') + (card.isJoker ? ' joker' : '');
  if (card.isJoker) {
    d.innerHTML = '<div class="center"><span class="jr">' + card.label + '</span></div>';
  } else {
    d.innerHTML = '<div class="center"><span class="r">' + card.short + '</span><span class="s">' + card.suitSymbol + '</span></div>';
  }
  return d;
}

function renderAll() {
  if (!state) return;
  const cur = {
    table: state.table.map((c) => c ? c.id : null),
    playerHand: state.playerHand.map((c) => c.id),
    draw: state.drawPile.length,
  };
  const prev = snap;
  const freshIds = (list, key) => new Set(prev ? list.filter((id) => prev[key].indexOf(id) < 0) : list);
  const isNewTable = freshIds(cur.table, 'table');
  const isNewHand = freshIds(cur.playerHand, 'playerHand');
  const plan = ui.mergePlan;

  // 桌面
  const t = $('table'); t.innerHTML = '';
  state.table.forEach((c) => {
    if (!c) {
      // 被凑掉的那张桌牌位置：留空槽，其余牌纹丝不动（与内核"留空位/填空位"对应）
      const gap = document.createElement('div');
      gap.className = 'card card-gap';
      t.appendChild(gap);
      return;
    }
    const el = cardEl(c);
    el.dataset.id = c.id;
    if (isNewTable.has(c.id)) el.classList.add('in-table');
    if (plan && plan.tableId === c.id) {
      el.classList.add('ringed');
      if (plan.stage === 'merge') el.classList.add('merge-target');
      else if (plan.player && (plan.stage === 'lift' || plan.stage === 'reveal')) {
        el.classList.add('lifted', 'ring-lock');   // 玩家：抬起 + 锁定（不带 NPC 橙箭头）
      } else if (plan.stage === 'point') {
        el.classList.add('npc-point');
      } else if (!plan.player && (plan.stage === 'lift')) {
        el.classList.add('npc-point', 'lifted');
        const ar = document.createElement('div'); ar.className = 'npc-arrow'; el.appendChild(ar);
      } else if (plan.stage === 'flip' || plan.stage === 'read') {
        el.classList.add('npc-point');
      } else el.classList.add('ring-lock');
    } else if (plan && plan.npc) {
      el.classList.add('dimmed');
    } else if (state.turn === 'player' && ui.mode === 'select' && ui.selTable === c.id) {
      el.classList.add('selected', 'ringed');
      if (!ui.valid) el.classList.add('ring-bad');
    } else if (coachOn && coachHint.table.has(c.id)) {
      el.classList.add('coach-hint');
      if (coachHint.bestTable.has(c.id)) el.classList.add('coach-hint-best');
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
    if (plan && plan.handIds.indexOf(c.id) >= 0 && (plan.stage === 'merge' || plan.stage === 'lift' || plan.stage === 'reveal')) {
      el.classList.add('merge-to');
      if (plan.stage === 'lift' || plan.stage === 'reveal') el.classList.add('lifted');
    }
    else if (ui.penPlan === c.id) el.classList.add('penalty-out');
    else if ((ui.mode === 'select' || ui.mode === 'replace') && ui.selHand.includes(c.id)) el.classList.add('selected');
    else if (coachOn && coachHint.hand.has(c.id)) { el.classList.add('coach-hint'); if (coachHint.bestHand.has(c.id)) el.classList.add('coach-hint-best'); }
    el.addEventListener('click', () => onHandClick(c));
    ph.appendChild(el);
  });

  // NPC 手牌背面：手机版不显示（仅顶部计数），此元素不存在即跳过
  const nh = $('npcHand');
  if (nh) {
    nh.innerHTML = '';
    state.npcHand.forEach((c) => { nh.appendChild(cardEl(null, true)); });
  }

  // 计数（元素不存在则跳过）
  set('drawCount', state.drawPile.length);
  set('playerCount', state.playerHand.length);
  set('npcCount', state.npcHand.length);
  set('pLoot', state.playerLoot.length);
  set('nLoot', state.npcLoot.length);
  set('pPen', state.playerPenalty.length);
  set('nPen', state.npcPenalty.length);

  // 实时比分
  const ps = G.computeScore(state, 'player');
  const ns = G.computeScore(state, 'npc');
  set('scoreMe', ps.toFixed(2));
  set('scoreNpc', ns.toFixed(2));
  const lead = $('scoreLead');
  if (lead) {
    const d = Math.round((ps - ns) * 100) / 100;
    lead.textContent = d > 0 ? ('你领先 ' + d.toFixed(2)) : d < 0 ? ('NPC 领先 ' + (-d).toFixed(2)) : '打平';
    lead.className = 'lead ' + (d > 0 ? 'me' : d < 0 ? 'npc' : 'even');
  }

  snap = cur;
}

function mkBtn(text, cls, onclick, disabled) {
  const b = document.createElement('button');
  b.className = cls; b.textContent = text;
  if (disabled) b.disabled = true;
  b.onclick = onclick;
  return b;
}
function renderControls() {
  const c = $('controls');
  c.innerHTML = '';
  if (!state || state.turn !== 'player') return;
  if (ui.mode === 'select') {
    const one = ui.selHand.length === 1 ? state.playerHand.find((x) => x.id === ui.selHand[0]) : null;
    c.appendChild(mkBtn('✅ 确认匹配', 'btn btn-go', confirmMatch, !ui.valid));
    c.appendChild(mkBtn(one ? ('🚫 罚掉 ' + cardName(one)) : '🚫 罚掉选中的 1 张', 'btn btn-warn', doPenalty, !one));
  }
}

// ---------- 难度 ----------
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
  const sh = H14_SHIFT && H14_SHIFT[npcDifficulty];
  el.textContent = (DIFF_DESC[npcDifficulty] || '')
    + (sh && sh !== npcDifficulty ? '（手机版整体降一档，实际按「' + diffLabel(sh) + '」打）' : '')
    + (learningArmed() ? '　🧠 这档跟着你的学习记录走（已调 ' + learned.drift + ' 次）' : '　🧠 这档固定，不参与学习');
}

// ---------- 开局难度询问 ----------
let pendingDiff = null;
function requestNewGame() {
  if (!askDiff) { newGame(); maybeFirstHelp(); return; }
  openDiffAsk();
}
function openDiffAsk() {
  pendingDiff = (challenge && !challengeUsed && challenge.d) ? challenge.d : npcDifficulty;   // 挑战局：默认锁链接指定的难度
  const m = $('diffModal');
  if (!m || !m.classList) { newGame(); maybeFirstHelp(); return; }
  const om = $('overModal'); if (om && om.classList) om.classList.add('hidden');
  const hm = $('helpModal'); if (hm && hm.classList) hm.classList.add('hidden');
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
  if (pendingDiff) applyDifficulty(pendingDiff);
  const cb = $('askDiffNever');
  if (cb && 'checked' in cb) setAskDiff(!cb.checked);
  closeDiffAsk();
  newGame();
  maybeFirstHelp();
}
function maybeFirstHelp() {
  if (!firstRunPending) return;
  firstRunPending = false;
  showHelp();
}

// ---------- 标题画面（游戏入场） ----------
// 打开先落在标题画面（"一看就是个游戏"）；点「开始游戏」才走 requestNewGame()，
// 后续难度询问 / 首次玩法说明的流程完全不变。
function enterStartScreen() {
  const ss = $('startScreen');
  if (!ss || !ss.classList) { requestNewGame(); return; }   // 兜底：没有标题页就直接开局
  ss.classList.remove('hidden');
}
function beginFromStart() {
  const ss = $('startScreen');
  if (ss && ss.classList) ss.classList.add('hidden');
  snd('tap');
  requestNewGame();
}

// ---------- 重开拦截（防对局中误触「↻」直接跳到选难度） ----------
// 结算后「再来一局」：沿用当前难度直接开新局，不再追问难度
function restartSame() {
  ['overModal', 'diffModal', 'helpModal', 'restartModal'].forEach((id) => {
    const e = $(id); if (e && e.classList) e.classList.add('hidden');
  });
  newGame();
}
// 顶栏「↻」：对局中点 → 先确认；已结算（或非对局态）→ 走正常流程（仍会问难度，便于换难度）
function onRestartClick() {
  if (state && state.phase === 'playing') { openRestartConfirm(); return; }
  requestNewGame();
}
function openRestartConfirm() {
  const m = $('restartModal');
  if (!m || !m.classList) { requestNewGame(); return; }
  ['overModal', 'diffModal', 'helpModal'].forEach((id) => {
    const e = $(id); if (e && e.classList) e.classList.add('hidden');
  });
  hideNpcBubble();
  m.classList.remove('hidden');
  snd('tap');
}
function closeRestartConfirm() {
  const m = $('restartModal');
  if (m && m.classList) m.classList.add('hidden');
}
function confirmRestart() {
  closeRestartConfirm();
  requestNewGame();
}

// ---------- 玩法说明 ----------
function getSeenHelp() {
  try {
    if (typeof localStorage !== 'undefined') return localStorage.getItem('h14_seenHelp') === '1';
  } catch (e) {}
  return false;
}
function setSeenHelp() {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem('h14_seenHelp', '1'); } catch (e) {}
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
  firstRunPending = false;   // 已经看过了（含从标题画面主动点开），开局别再自动弹一次
}

// ---- 访问统计（云服务计数；失败静默，绝不影响游戏）----
// 两处显示：标题画面 #visitStatStart（充当"有人玩过"的招牌）+ 对局页 #visitStat
function initVisitStat() {
  const els = [$('visitStat'), $('visitStatStart')].filter(Boolean);
  if (!els.length) return;
  const cfg = window.H14_CLOUD || {};
  const API = (typeof WorkBuddyCloud !== 'undefined') ? WorkBuddyCloud : null;
  if (!API || !cfg.endpoint || !cfg.publishableKey) return;
  try {
    const cloud = API.createWorkBuddyCloud({ endpoint: cfg.endpoint, publishableKey: cfg.publishableKey });
    cloud.database.rpc('bump_visit').then((res) => {
      const row = res && res.data && res.data[0];
      if (!row) return;
      const t = (row.total != null) ? row.total : 0;
      const d = (row.today != null) ? row.today : 0;
      const line = '累计 ' + t + ' 次访问 · 今日 ' + d + ' 次';
      els.forEach((e) => { e.textContent = line; });
    }).catch(function () {});
  } catch (e) { /* 统计失败不影响游戏 */ }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initVisitStat);
} else {
  initVisitStat();
}

document.addEventListener('DOMContentLoaded', () => {
  loadLearn();
  loadGames();
  loadPersistDiff();
  loadAskDiff();
  loadCoach();
  loadTodayBest();
  loadAchv();
  updateCoachUI();
  const hb = $('helpBtn'); if (hb && hb.addEventListener) hb.addEventListener('click', showHelp);
  const hc = $('helpClose'); if (hc && hc.addEventListener) hc.addEventListener('click', hideHelp);
  firstRunPending = !getSeenHelp();
  const ng = $('newGame'); if (ng && ng.addEventListener) ng.addEventListener('click', onRestartClick);
  const ct = $('coachToggleStart'); if (ct && ct.addEventListener) ct.addEventListener('click', function () { setCoach(!coachOn); });
  const cbtn = $('coachBtn'); if (cbtn && cbtn.addEventListener) cbtn.addEventListener('click', function () { setCoach(!coachOn); });
  const nd = $('coachNudge'); if (nd && nd.addEventListener) nd.addEventListener('click', function () { setCoach(true); });
  const on = $('overNew'); if (on && on.addEventListener) on.addEventListener('click', restartSame);
  const och = $('overChallenge'); if (och && och.addEventListener) och.addEventListener('click', shareChallenge);
  // 复盘导出按钮是 overBody 动态生成的 → 用事件委托绑在静态的 overBody 上
  const ob = $('overBody');
  if (ob && ob.addEventListener) ob.addEventListener('click', function (e) {
    const t = e.target;
    if (t && t.id === 'overGameExport') { exportGames(); toast('复盘记录已复制，存成 .json 喂给 node tools-coach.js', 'ok'); }
  });
  const rc = $('restartCancel'); if (rc && rc.addEventListener) rc.addEventListener('click', closeRestartConfirm);
  const ro = $('restartOk'); if (ro && ro.addEventListener) ro.addEventListener('click', confirmRestart);
  const ds = $('diffSeg');
  if (ds && typeof ds.querySelectorAll === 'function') {
    ds.querySelectorAll('.diff-btn').forEach((b) => {
      if (b.addEventListener) b.addEventListener('click', () => applyDifficulty(b.getAttribute('data-diff')));
    });
  }
  const as = $('askDiffSeg');
  if (as && typeof as.querySelectorAll === 'function') {
    as.querySelectorAll('.diff-btn').forEach((b) => {
      if (b.addEventListener) b.addEventListener('click', () => pickAskDiff(b.getAttribute('data-diff')));
    });
  }
  const ag = $('askDiffGo'); if (ag && ag.addEventListener) ag.addEventListener('click', confirmDiffAsk);
  const lb = $('learnBtn'); if (lb && lb.addEventListener) lb.addEventListener('click', openLearn);
  const lc = $('learnClose'); if (lc && lc.addEventListener) lc.addEventListener('click', closeLearn);
  const le = $('learnExport'); if (le && le.addEventListener) le.addEventListener('click', exportLearn);
  const lr = $('learnReset'); if (lr && lr.addEventListener) lr.addEventListener('click', resetLearn);
  const an = $('askDiffNever'); if (an && an.addEventListener) an.addEventListener('change', () => setAskDiff(!an.checked));
  const sg = $('startGo'); if (sg && sg.addEventListener) sg.addEventListener('click', beginFromStart);
  const sh = $('startHelp'); if (sh && sh.addEventListener) sh.addEventListener('click', showHelp);
  // ① ② ③ 新功能按钮
  const st = $('startToday'); if (st && st.addEventListener) st.addEventListener('click', startToday);
  const ss = $('startSpectate'); if (ss && ss.addEventListener) ss.addEventListener('click', startSpectate);
  const sp = $('spectateStop'); if (sp && sp.addEventListener) sp.addEventListener('click', stopSpectate);
  const ab = $('achvBtn'); if (ab && ab.addEventListener) ab.addEventListener('click', openAchv);
  const ac = $('achvClose'); if (ac && ac.addEventListener) ac.addEventListener('click', closeAchv);
  if (document.addEventListener) document.addEventListener('click', () => { if (SFX && SFX.unlock) SFX.unlock(); }, { once: true });
  // 进场先给标题画面，不直接开局（原来这里是 requestNewGame()）
  enterStartScreen();
});
