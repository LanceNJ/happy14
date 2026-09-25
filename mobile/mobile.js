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
const LEARN_CLAMP = { keepW: [0, 3], playW: [0.2, 1.6] };
const LEARN_MARGIN = 0.5;    // 一手要"明显更赚"（≥0.5 分）才算洞，避免噪声投票
const LEARN_MAX_DEC = 120;   // 每局最多留多少个决策点（防内存膨胀）
let learned = {
  v: 1,
  weights: null,                                 // 学习后的权重；null = 还没学到东西（等于出厂默认）
  stats: { hard: { w: 0, l: 0 }, hell: { w: 0, l: 0 } },
  reviewed: 0,                                   // 已复盘（赢局）数
  holes: { play: 0, rep: 0, pen: 0 },            // 累计"引擎被你反超"处数
  drift: 0,                                      // 累计调参次数
  log: [],                                       // 最近 5 条人类可读说明
};
let decideLog = [];       // 本局玩家决策快照（只在内存里，不落盘）
let pendingPlay = null;   // 上一次出牌的决策快照（补牌轴要跟它配对）

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
function recordPlayDecision(move) {
  if (!learningArmed() || !G.cloneState) return;
  const rec = { k: 'play', st: G.cloneState(state), handIds: move.handCards.map((c) => c.id), tableId: move.tableCard.id };
  pushDecide(rec);
  pendingPlay = rec;
}
function recordReplaceDecision(cardId) {
  if (!learningArmed() || !pendingPlay) return;
  pushDecide({ k: 'rep', st: pendingPlay.st, handIds: pendingPlay.handIds, tableId: pendingPlay.tableId, cardId: cardId });
  pendingPlay = null;
}
function recordPenaltyDecision(cardId) {
  if (!learningArmed() || !G.cloneState) return;
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
    for (const d of decideLog) {
      try {
        if (d.k === 'play') {
          const moves = G.findMoves(d.st.playerHand, d.st.table);
          if (!moves.length) continue;
          const mine = findMoveBy(moves, d.handIds, d.tableId);
          const eng = G.rankMoves(moves)[0];
          if (!mine || !eng) continue;
          // 两臂都用 null（都交给自动补牌）：只让"出哪一手"这一个变量不同，才是配对比较
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
    reviewed: learned.reviewed, holes: learned.holes, drift: learned.drift, log: learned.log,
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
    reviewed: 0, holes: { play: 0, rep: 0, pen: 0 }, drift: 0, log: [],
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

// ---------- NPC 卡通形象（圆滚滚小可爱机器人，卡哇伊） ----------
const NC = '#3a3a3a';
const NPC_FACES = {
  idle: {
    halo: '#bdeacb',
    eye: '<circle cx="27" cy="38" r="6.5" fill="' + NC + '"/><circle cx="45" cy="38" r="6.5" fill="' + NC + '"/>' +
         '<circle cx="29" cy="35.5" r="2.4" fill="#fff"/><circle cx="47" cy="35.5" r="2.4" fill="#fff"/>',
    mouth: '<path d="M31 49 q5 4.5 10 0" stroke="' + NC + '" stroke-width="2.6" fill="none" stroke-linecap="round"/>',
  },
  think: {
    halo: '#d9c8ff',
    eye: '<circle cx="27" cy="39" r="6.5" fill="#fff" stroke="' + NC + '" stroke-width="2"/>' +
         '<circle cx="45" cy="39" r="6.5" fill="#fff" stroke="' + NC + '" stroke-width="2"/>' +
         '<circle cx="27" cy="37" r="3" fill="' + NC + '"/><circle cx="45" cy="37" r="3" fill="' + NC + '"/>' +
         '<circle cx="28.2" cy="35.8" r="1.1" fill="#fff"/><circle cx="46.2" cy="35.8" r="1.1" fill="#fff"/>',
    mouth: '<ellipse cx="36" cy="50" rx="2.6" ry="3.2" fill="' + NC + '"/>',
  },
  happy: {
    halo: '#ffe6a0',
    eye: '<path d="M21 38 q6 -7 12 0" stroke="' + NC + '" stroke-width="3.2" fill="none" stroke-linecap="round"/>' +
         '<path d="M39 38 q6 -7 12 0" stroke="' + NC + '" stroke-width="3.2" fill="none" stroke-linecap="round"/>',
    mouth: '<path d="M29 47 q7 11 14 0 z" fill="' + NC + '"/>' +
           '<path d="M32 51 q4 3 8 0" stroke="#ff9ec4" stroke-width="2.2" fill="none"/>',
  },
  greedy: {
    halo: '#ffd2a8',
    eye: '<path d="M27 31 L29 36 L34 38 L29 40 L27 45 L25 40 L20 38 L25 36 Z" fill="#ffd43b" stroke="#e88" stroke-width="1.4" stroke-linejoin="round"/>' +
         '<path d="M45 31 L47 36 L52 38 L47 40 L45 45 L43 40 L38 38 L43 36 Z" fill="#ffd43b" stroke="#e88" stroke-width="1.4" stroke-linejoin="round"/>',
    mouth: '<path d="M28 47 q8 12 16 0 z" fill="' + NC + '"/>' +
           '<path d="M33 51 q3 4 6 0 z" fill="#ff9ec4"/>',
  },
  shock: {
    halo: '#ffc2d6',
    eye: '<circle cx="27" cy="38" r="7" fill="#fff" stroke="' + NC + '" stroke-width="2"/>' +
         '<circle cx="45" cy="38" r="7" fill="#fff" stroke="' + NC + '" stroke-width="2"/>' +
         '<circle cx="27" cy="38" r="3.2" fill="' + NC + '"/><circle cx="45" cy="38" r="3.2" fill="' + NC + '"/>',
    mouth: '<ellipse cx="36" cy="50" rx="3.6" ry="4.4" fill="' + NC + '"/>',
  },
  sad: {
    halo: '#d8d2cb',
    eye: '<path d="M21 40 q6 5 12 0" stroke="' + NC + '" stroke-width="3.2" fill="none" stroke-linecap="round"/>' +
         '<path d="M39 40 q6 5 12 0" stroke="' + NC + '" stroke-width="3.2" fill="none" stroke-linecap="round"/>' +
         '<path d="M22 44 q1.5 4 0 6 q-1.5 -2 0 -6 z" fill="#8fd0ff" stroke="#5aa" stroke-width="0.8"/>',
    mouth: '<path d="M30 51 q6 -5 12 0" stroke="' + NC + '" stroke-width="2.8" fill="none" stroke-linecap="round"/>',
  },
};
function npcFaceSvg(mood) {
  const f = NPC_FACES[mood] || NPC_FACES.idle;
  return '<svg viewBox="0 0 72 72" width="100%" height="100%" aria-hidden="true">' +
    '<circle cx="36" cy="38" r="32" fill="' + f.halo + '"/>' +
    '<path d="M36 9 v-4" stroke="#e58" stroke-width="2" stroke-linecap="round"/>' +
    '<path d="M36 3.5 l2.6 2.6 l-2.6 2.6 l-2.6 -2.6 z" fill="#ff7aa8" stroke="#ff5d8f" stroke-width="1"/>' +
    '<circle cx="9" cy="40" r="6" fill="#ffe0ec" stroke="#ff9ec4" stroke-width="2"/>' +
    '<circle cx="63" cy="40" r="6" fill="#ffe0ec" stroke="#ff9ec4" stroke-width="2"/>' +
    '<rect x="11" y="19" width="50" height="46" rx="23" fill="#fff7fb" stroke="#ff9ec4" stroke-width="2.6"/>' +
    '<ellipse cx="19" cy="47" rx="5.5" ry="3.8" fill="#ff9ec4" opacity="0.8"/>' +
    '<ellipse cx="53" cy="47" rx="5.5" ry="3.8" fill="#ff9ec4" opacity="0.8"/>' +
    f.eye + f.mouth +
    '</svg>';
}

// NPC 说话：全部走顶部一行轻量气泡（砍掉桌面版大娃娃 + 座位小气泡两种）
let bubbleGen = 0;
function setNpcMood(mood) { const el = $('npcAvatar'); if (el) el.innerHTML = npcFaceSvg(mood); }
function npcSay(event, chance) {
  if (!A || !A.npcSay || !state || state.phase === 'gameover') return;
  const line = A.npcSay(event, { chance: chance });
  if (!line) return;
  setNpcMood(line.mood);
  showNpcBubble(line.text);
}
function showNpcBubble(text) {
  const el = $('npcSay');
  if (!el) return;
  el.textContent = text;
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

// ---------- 流程 ----------
function newGame() {
  applyLearnWeights(npcDifficulty);   // 易/中=出厂权重；难吃一半、地狱全量（只有这两档会学）
  decideLog = []; pendingPlay = null;
  state = G.createGame({ numDecks: 2, firstRandom: firstMoveRandom });
  episode++;
  ui.selHand = []; ui.selTable = null; ui.noMoves = false; ui.mergePlan = null; ui.penPlan = null;
  ui.mode = 'idle'; ui.valid = false; snap = null;
  $('overModal').classList.add('hidden');
  hideNpcShow();
  setNpcMood('idle');
  hideNpcBubble();
  const eSh = H14_SHIFT && H14_SHIFT[npcDifficulty];
  const dl = diffLabel(npcDifficulty) + (eSh && eSh !== npcDifficulty ? '·实按' + diffLabel(eSh) : '');
  setMessage('🎴 新一局开始！' + (state.turn === 'player' ? '你先手' : 'NPC 先手') + '（难度：' + dl + '）');
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

  ui.mode = 'merging';
  ui.mergePlan = { tableId: tableCard.id, handIds: handCards.map((c) => c.id), stage: 'lock' };
  setMessage('🔗 已圈住桌面的 ' + cardName(tableCard) + '：' + eqText(handCards) + ' = ' + sum + '，合牌中…');
  toast('圈定 ' + eqText(move.captured) + ' = ' + sum, 'good');
  renderControls();
  renderAll();

  setTimeout(() => {
    if (ep !== episode || !ui.mergePlan) return;
    ui.mergePlan.stage = 'merge';
    renderAll();
    setTimeout(() => {
      if (ep !== episode || !ui.mergePlan) return;
      ui.mergePlan = null;
      finishPlayerMerge(move, gain);
    }, T_NPC_MERGE);
  }, T_NPC_LIFT);
}

function finishPlayerMerge(move, gain) {
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
function npcShowSimpleHtml(captured, sum, gain, n, gotJoker) {
  const cards = captured.map((c) => {
    const el = cardEl(c, false);
    el.classList.add('revealed');
    return el.outerHTML;
  }).join('<span class="plus"> + </span>');
  const eq = '<div class="npc-show-eq">' + eqText(captured) + ' = ' + sum +
    ' <span class="ok">✅</span><br><span class="gain">收获 ' + n + ' 张 · +' + gain + ' 分</span></div>';
  return '<div class="npc-show-box"><div class="npc-show-head">🤖 NPC 亮牌' + (gotJoker ? '（捞到王！）' : '') + '</div>' +
    '<div class="npc-show-cards">' + cards + '</div>' + eq + '</div>';
}
function showNpcShow(html) {
  const el = $('npcShow');
  if (!el) return;
  el.innerHTML = html;
  if (el.classList) el.classList.remove('hidden');
}
function markNpcShowMerge() { const el = $('npcShow'); if (el && el.classList) el.classList.add('merging'); }
function hideNpcShow() {
  const el = $('npcShow');
  if (el && el.classList) { el.classList.add('hidden'); el.classList.remove('merging'); }
  if (el) el.innerHTML = '';
}

// ---------- NPC 回合（简化：指牌 → 亮牌浮层 → 入账） ----------
function npcTurn() {
  ui.mode = 'idle'; ui.valid = false; ui.selHand = []; ui.selTable = null;
  ui.mergePlan = null; ui.penPlan = null;
  hideNpcShow();
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
  const learnNote = runLearn(ps, ns);   // 只学"你赢"的局；易/中不学

  const fmt = (arr) => arr.length ? arr.map((c) => c.label).join('、') : '（无）';

  hideNpcBubble();
  $('overTitle').textContent = '本局结束';
  $('overBody').innerHTML =
    '<div class="winner">' + winner + '</div>' +
    '<div class="over-score">你 <b>' + ps.toFixed(2) + '</b> ： <b>' + ns.toFixed(2) + '</b> NPC</div>' +
    (line ? '<div class="over-say">🤖 NPC：「' + line.text + '」</div>' : '') +
    scoreSummary('你', state.playerLoot, state.playerPenalty, ps) +
    scoreSummary('NPC', state.npcLoot, state.npcPenalty, ns) +
    (learnNote ? '<div class="over-rate">' + learnNote + '</div>' : '') +
    '<details><summary>查看双方全部牌面</summary>' +
    '<div>你的战利品：' + fmt(state.playerLoot) + '</div>' +
    '<div>你的罚牌：' + fmt(state.playerPenalty) + '</div>' +
    '<div>NPC 战利品：' + fmt(state.npcLoot) + '</div>' +
    '<div>NPC 罚牌：' + fmt(state.npcPenalty) + '</div>' +
    '</details>';
  $('overModal').classList.remove('hidden');
  snd(ps > ns ? 'win' : ps < ns ? 'lose' : 'drawEnd');
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
    table: state.table.map((c) => c.id),
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
    const el = cardEl(c);
    el.dataset.id = c.id;
    if (isNewTable.has(c.id)) el.classList.add('in-table');
    if (plan && plan.tableId === c.id) {
      el.classList.add('ringed');
      if (plan.stage === 'merge') el.classList.add('merge-target');
      else if (plan.stage === 'point' || plan.stage === 'lift') {
        el.classList.add('npc-point');
        if (plan.stage === 'lift') el.classList.add('lifted');
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
    if (plan && plan.stage === 'merge' && plan.handIds.indexOf(c.id) >= 0) el.classList.add('merge-to');
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
  pendingDiff = npcDifficulty;
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
  loadPersistDiff();
  loadAskDiff();
  loadCoach();
  updateCoachUI();
  const hb = $('helpBtn'); if (hb && hb.addEventListener) hb.addEventListener('click', showHelp);
  const hc = $('helpClose'); if (hc && hc.addEventListener) hc.addEventListener('click', hideHelp);
  firstRunPending = !getSeenHelp();
  const ng = $('newGame'); if (ng && ng.addEventListener) ng.addEventListener('click', onRestartClick);
  const ct = $('coachToggleStart'); if (ct && ct.addEventListener) ct.addEventListener('click', function () { setCoach(!coachOn); });
  const cbtn = $('coachBtn'); if (cbtn && cbtn.addEventListener) cbtn.addEventListener('click', function () { setCoach(!coachOn); });
  const nd = $('coachNudge'); if (nd && nd.addEventListener) nd.addEventListener('click', function () { setCoach(true); });
  const on = $('overNew'); if (on && on.addEventListener) on.addEventListener('click', restartSame);
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
  if (document.addEventListener) document.addEventListener('click', () => { if (SFX && SFX.unlock) SFX.unlock(); }, { once: true });
  // 进场先给标题画面，不直接开局（原来这里是 requestNewGame()）
  enterStartScreen();
});
