/*
 * 难度校准台 —— 用"正确"的对局循环，横向比对不同 NPC 策略的强弱。
 *
 * 为什么需要它（血泪教训，勿删此注释）：
 *   之前的 _diffcheck.js 主循环从不翻转 s.turn，而 capture/penalty/replaceAndRefill 都不改 turn，
 *   createGame 默认 turn='player' → 永远只走玩家分支，NPC 分支一次都没跑。
 *   于是不同难度跑出的胜率差全是"发牌随机"造成的噪声，据此得出的"hard 比 medium 弱"是假结论。
 *   本脚本的纪律：① 每步动作后显式 s.turn 取反；② 玩家侧用玩家自己的动作；
 *   ③ 所有策略共用同一发牌序列（mulberry32 定种子），配对比对，噪声≈0。
 *
 * 用法： node difficulty-lab.js [N] [策略名,策略名...]
 *   例： node difficulty-lab.js 200 medium,hard,hell
 */
const G = require('./game-core.js');

// ---------- 定种子 RNG：同一局号 = 同一副牌，保证各策略可比 ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 基础工具 ----------
function handOf(s, who) { return who === 'player' ? s.playerHand : s.npcHand; }

function applyAction(s, who, a) {
  if (a.type === 'match') { G.capture(s, who, a.move); G.replaceAndRefill(s, who, a.replaceCardId); }
  else G.penalty(s, who, a.cardId);
}

// 一手价值：得分 + lambda × 收牌张数（张数本身有价值：进了战利品就不会再被罚掉）
function moveValue(mv, lambda) { return mv.score + lambda * mv.captured.length; }

function rankByValue(hand, table, lambda) {
  const ms = G.findMoves(hand, table);
  ms.sort((a, b) => {
    const va = moveValue(a, lambda), vb = moveValue(b, lambda);
    if (Math.abs(vb - va) > 1e-9) return vb - va;
    const ja = a.captured.filter((c) => c.isJoker).length;
    const jb = b.captured.filter((c) => c.isJoker).length;
    if (jb !== ja) return jb - ja;
    return b.captured.length - a.captured.length;
  });
  return ms;
}

function cheapestReplace(hand, capIds) {
  const rest = hand.filter((c) => !capIds.has(c.id));
  if (!rest.length) return null;
  rest.sort((a, b) => a.score - b.score);
  return rest[0].id;
}

// 我方补到桌面后，对手下一手最多能捞多少分（越小越"不资敌"）
function oppBestGainAfter(s, who, mv, rid) {
  const st = G.cloneState(s);
  const opp = who === 'player' ? 'npc' : 'player';
  G.capture(st, who, mv);
  G.replaceAndRefill(st, who, rid);
  const ms = G.findMoves(handOf(st, opp), st.table);
  let best = 0;
  for (const m of ms) if (m.score > best) best = m.score;
  return best;
}

function defensiveReplace(s, who, mv, hand) {
  const capIds = new Set(mv.handCards.map((c) => c.id));
  const rest = hand.filter((c) => !capIds.has(c.id));
  if (!rest.length) return null;
  let bestId = rest[0].id, bestG = Infinity;
  for (const c of rest) {
    const g = oppBestGainAfter(s, who, mv, c.id);
    if (g < bestG) { bestG = g; bestId = c.id; }
  }
  return bestId;
}

// 从 pool 里不放回地抽 n 张（假想对手手牌）
function sampleHand(pool, n) {
  const idx = [];
  const used = new Set();
  while (idx.length < n && used.size < pool.length) {
    const j = Math.floor(Math.random() * pool.length);
    if (used.has(j)) continue;
    used.add(j); idx.push(j);
  }
  return idx.map((j) => pool[j]);
}

// "诚实版"防守补牌：不偷看玩家真实手牌，只用 NPC 视角的"未见池"（= 玩家手牌 ∪ 玩家罚牌 ∪ 补牌堆，
// 三者对 NPC 不可区分；其构成可由"全牌 − 我已见的牌"合法推出）抽样 4 张当假想对手手牌，估平均最大收益。
function honestDefensiveReplace(s, who, mv, hand, K) {
  const opp = who === 'player' ? 'npc' : 'player';
  const pool = handOf(s, opp).concat(
    opp === 'player' ? s.playerPenalty : s.npcPenalty,
    s.drawPile
  );
  const capIds = new Set(mv.handCards.map((c) => c.id));
  const rest = hand.filter((c) => !capIds.has(c.id));
  if (!rest.length) return null;
  let bestId = rest[0].id, bestAvg = Infinity;
  for (const c of rest) {
    const st = G.cloneState(s);
    G.capture(st, who, mv);
    G.replaceAndRefill(st, who, c.id);
    let sum = 0;
    for (let k = 0; k < K; k++) {
      const h = sampleHand(pool, 4);
      const ms = G.findMoves(h, st.table);
      let best = 0;
      for (const m of ms) if (m.score > best) best = m.score;
      sum += best;
    }
    const avg = sum / K;
    if (avg < bestAvg) { bestAvg = avg; bestId = c.id; }
  }
  return bestId;
}

// "净威胁"补牌：不只算"补上去这张给对手多大机会"，还算"补完后我自己下一步有多大机会"。
//   net = E[对手下一手最大收益] − w × 我下一步最大收益
//   前项 = 防守（别资敌）；后项 = 进攻（给自己留机会）。w=0 退化成纯防守（现状 hard）。
// 为什么要往后推一手：补牌那一张不只是"喂不喂对手"，也决定了我下一轮桌面还剩什么。
// 只求"对手捞不到"会选出谁都用不上的废牌 —— 对手是没得捞，但我也没了抓手。
// 我方下一步机会不必抽样：此刻我的手牌已被 replaceAndRefill 补满，对手的动作碰不到它，
// 变的只有桌面（他拿走一张 + 补一张），所以对着推演出的新桌面直接算即可。
function netReplace(s, who, mv, hand, w, K) {
  const opp = who === 'player' ? 'npc' : 'player';
  const pool = handOf(s, opp).concat(
    opp === 'player' ? s.playerPenalty : s.npcPenalty,
    s.drawPile
  );
  const capIds = new Set(mv.handCards.map((c) => c.id));
  const rest = hand.filter((c) => !capIds.has(c.id));
  if (!rest.length) return null;
  let bestId = rest[0].id, bestNet = Infinity;
  for (const c of rest) {
    const st1 = G.cloneState(s);
    G.capture(st1, who, mv);
    G.replaceAndRefill(st1, who, c.id);
    let sum = 0;
    for (let k = 0; k < K; k++) {
      const h = sampleHand(pool, 4);
      const ms = G.findMoves(h, st1.table);
      let oppGain = 0, bestMv = null;
      for (const m of ms) if (m.score > oppGain) { oppGain = m.score; bestMv = m; }
      // 推演对手走完这一手之后的桌面（拿走他的目标牌、再补一张最便宜的）
      let table2 = st1.table;
      if (bestMv) {
        const used = new Set(bestMv.handCards.map((x) => x.id));
        const left = h.filter((x) => !used.has(x.id));
        left.sort((a, b) => a.score - b.score);
        table2 = st1.table.filter((tc) => tc.id !== bestMv.tableCard.id);
        if (left.length) table2 = table2.concat([left[0]]);
      }
      const myMs = G.findMoves(handOf(st1, who), table2);
      let myGain = 0;
      for (const m of myMs) if (m.score > myGain) myGain = m.score;
      sum += oppGain - w * myGain;
    }
    const net = sum / K;
    if (net < bestNet) { bestNet = net; bestId = c.id; }
  }
  return bestId;
}

// ---------- 罚牌策略（用户洞见 2026-09-19：罚牌别只看眼前的分值，要留"能凑14"的小牌） ----------
// 例：方片4(0.25) vs 红桃K(0.75)。罚 4 眼前损失小，但 4 能配 10（牌池里一大把），
// K 只能配 3（没几张）——留着 K 下一轮能吃的几率反而小。所以有时宁愿多赔 0.5 分也罚 K。
function unseenPool(s) {
  // NPC 视角的未知池 = 玩家手牌 ∪ 玩家罚牌 ∪ 补牌堆（对 NPC 不可区分），与 netReplace 同一套纪律：不偷看
  return s.playerHand.concat(s.playerPenalty, s.drawPile);
}
function partnerCount(pool, c) {
  if (c.isJoker) return 99;             // 王百搭，永远不当罚牌扔
  let n = 0;
  for (const p of pool) if (!p.isJoker && p.matchValue === 14 - c.matchValue) n++;
  return n;
}
// mode:
//   'low'  : 现状，分值最低（眼前损失最小）
//   'high' : 点数最大（同点数挑分值最便宜的）——用户的朴素版
//   'flex' : 凑14伙伴最少优先（同伙伴数挑分值最便宜的）
//   'cost' : 综合 = 价格 + 0.3×伙伴数×100（罚这张的总代价：眼前赔的分 + 放弃的未来机会）
//   {mode:'rank', k} : 价格 − k×点数（k=0 退化为 low，k 大了趋向 high；扫 k 找每档峰值）
function pickPenalty(s, hand, mode) {
  const m = typeof mode === 'object' ? mode.mode : mode;
  const k = typeof mode === 'object' ? mode.k : 0;
  const pool = unseenPool(s);
  let best = hand[0], bestC = Infinity;
  for (const c of hand) {
    let cost;
    if (m === 'high') cost = -(c.matchValue * 100) + c.score;      // 点数大者优先，同点数便宜者先
    else if (m === 'flex') cost = partnerCount(pool, c) * 100 + c.score;
    else if (m === 'cost') cost = c.score + 0.3 * partnerCount(pool, c) * 100;
    else if (m === 'rank') cost = c.score - k * c.matchValue;
    else cost = c.score;
    if (cost < bestC) { bestC = cost; best = c; }
  }
  return best.id;
}

// 双方都按"贪心(medium)"走到底；用于 rollout 评估。返回 (npc 分 − 玩家分)
function playOutGreedy(s0, budget) {
  const st = G.cloneState(s0);
  let guard = 0;
  while (!G.isGameOver(st) && guard++ < budget) {
    const who = st.turn;
    if (handOf(st, who).length === 0) { st.turn = who === 'player' ? 'npc' : 'player'; continue; }
    applyAction(st, who, G.chooseAction(st, who));
    st.turn = who === 'player' ? 'npc' : 'player';
  }
  return G.computeScore(st, 'npc') - G.computeScore(st, 'player');
}

// ---------- 策略工厂 ----------
// opts: { lambda, breadth, rollout, replace:'cheap'|'def'|'rand'|'both', easy, hardEval }
function makePolicy(name, opts) {
  opts = opts || {};
  const lambda = opts.lambda || 0;
  const breadth = opts.breadth || 1;

  const p = function (s) {
    const hand = s.npcHand;
    const ms = G.findMoves(hand, s.table);

    // 无牌可配 → 罚牌：丢分值最低的（easy 有概率反着丢，故意变菜）
    if (!ms.length) {
      if (opts.easy && Math.random() < 0.5) {
        const hi = hand.slice().sort((a, b) => b.score - a.score);
        return { type: 'penalty', cardId: hi[0].id };
      }
      if (opts.pen) return { type: 'penalty', cardId: pickPenalty(s, hand, opts.pen) };
      const lo = hand.slice().sort((a, b) => a.score - b.score);
      return { type: 'penalty', cardId: lo[0].id };
    }

    // easy：大概率随机出一手
    if (opts.easy && Math.random() < 0.55) {
      const pick = ms[Math.floor(Math.random() * ms.length)];
      const capIds = new Set(pick.handCards.map((c) => c.id));
      return { type: 'match', move: pick, replaceCardId: cheapestReplace(hand, capIds) };
    }

    const ranked = rankByValue(hand, s.table, lambda);
    const cands = ranked.slice(0, Math.min(breadth, ranked.length));

    let best = null, bestV = -Infinity;
    for (const mv of cands) {
      const capIds = new Set(mv.handCards.map((c) => c.id));
      let rids;
      if (opts.replace === 'def') rids = [defensiveReplace(s, 'npc', mv, hand)];
      else if (opts.replace === 'defHonest') rids = [honestDefensiveReplace(s, 'npc', mv, hand, opts.K || 12)];
      else if (opts.replace === 'net') rids = [netReplace(s, 'npc', mv, hand, opts.w || 0, opts.K || 12)];
      else if (opts.replace === 'rand') {
        const rest = hand.filter((c) => !capIds.has(c.id));
        rids = [rest.length ? rest[Math.floor(Math.random() * rest.length)].id : null];
      } else if (opts.replace === 'both') rids = [cheapestReplace(hand, capIds), defensiveReplace(s, 'npc', mv, hand)];
      else rids = [cheapestReplace(hand, capIds)];

      for (const rid of rids) {
        let v;
        if (opts.rollout) {
          const st = G.cloneState(s);
          G.capture(st, 'npc', mv);
          G.replaceAndRefill(st, 'npc', rid);
          st.turn = 'player';
          v = playOutGreedy(st, 400);
        } else if (opts.hardEval) {
          const st = G.cloneState(s);
          G.capture(st, 'npc', mv);
          G.replaceAndRefill(st, 'npc', rid);
          v = mv.score - oppBestGainAfter(s, 'npc', mv, rid);
        } else {
          v = moveValue(mv, lambda);
        }
        if (v > bestV) { bestV = v; best = { mv: mv, rid: rid }; }
      }
    }
    return { type: 'match', move: best.mv, replaceCardId: best.rid };
  };
  p.policyName = name;
  return p;
}

const POLICIES = {
  easy:    makePolicy('easy',    { easy: true }),
  medium:  makePolicy('medium',  { lambda: 0 }),
  // 只改"补到桌面那张"的选择
  medDef:  makePolicy('medDef',  { replace: 'def' }),          // 上帝视角版（偷看玩家手牌）
  defHon:  makePolicy('defHon',  { replace: 'defHonest' }),    // 诚实版（未见池抽样估计）
  medRand: makePolicy('medRand', { replace: 'rand' }),
  // 只改"出哪手"的价值函数：偏好一次多收牌
  many15:  makePolicy('many15',  { lambda: 0.15 }),
  many30:  makePolicy('many30',  { lambda: 0.30 }),
  // 旧 hard：贴脸反手（我这一手分 − 对手下一手最大分）
  hardOld: makePolicy('hardOld', { breadth: 6, hardEval: true, replace: 'both' }),
  // 旧 hell：每候选 rollout（双方贪心）6 次 —— 注意贪心是确定性的，6 次其实是同一场
  hellOld: makePolicy('hellOld', { breadth: 6, rollout: true, replace: 'both' }),
  // 新方案候选
  many30def: makePolicy('many30def', { lambda: 0.30, replace: 'def' }),
  defRoll:   makePolicy('defRoll',   { breadth: 4, rollout: true, replace: 'def' }),
  defHonRoll: makePolicy('defHonRoll', { breadth: 4, rollout: true, replace: 'defHonest' }),
  defHard6:  makePolicy('defHard6',  { breadth: 6, hardEval: true, replace: 'def' }),
  defHonHard: makePolicy('defHonHard', { breadth: 6, hardEval: true, replace: 'defHonest' }),
  // "净威胁"补牌：防守 + 给自己留机会 的权重扫描（w=0 即纯防守=现状）
  net00: makePolicy('net00', { replace: 'net', w: 0,    K: 12 }),
  net05: makePolicy('net05', { replace: 'net', w: 0.5,  K: 12 }),
  net10: makePolicy('net10', { replace: 'net', w: 1,    K: 12 }),
  net20: makePolicy('net20', { replace: 'net', w: 2,    K: 12 }),
  net30: makePolicy('net30', { replace: 'net', w: 3,    K: 12 }),
  net50: makePolicy('net50', { replace: 'net', w: 5,    K: 12 }),
  net80: makePolicy('net80', { replace: 'net', w: 8,    K: 12 }),
  net150: makePolicy('net150', { replace: 'net', w: 15,  K: 12 }),
  hellNet0: makePolicy('hellNet0', { breadth: 4, rollout: true, replace: 'net', w: 0, K: 12 }),
  hellNet2: makePolicy('hellNet2', { breadth: 4, rollout: true, replace: 'net', w: 2, K: 12 }),
  honestRoll: makePolicy('honestRoll', { breadth: 4, rollout: true, replace: 'defHonest' }),
  // 罚牌策略对比（medium 基座 = 出牌照贪心、补牌照最便宜）：
  penLowM:  makePolicy('penLowM',  { replace: 'cheap' }),            // 现状（对照）
  penHighM: makePolicy('penHighM', { replace: 'cheap', pen: 'high' }),
  penFlexM: makePolicy('penFlexM', { replace: 'cheap', pen: 'flex' }),
  penCostM: makePolicy('penCostM', { replace: 'cheap', pen: 'cost' }),
  // 罚牌策略对比（hard 基座 = 净威胁补牌 w=2，接近出厂 gcHard）：
  penLowH:  makePolicy('penLowH',  { replace: 'net', w: 2, K: 12 }),
  penHighH: makePolicy('penHighH', { replace: 'net', w: 2, K: 12, pen: 'high' }),
  penFlexH: makePolicy('penFlexH', { replace: 'net', w: 2, K: 12, pen: 'flex' }),
  penCostH: makePolicy('penCostH', { replace: 'net', w: 2, K: 12, pen: 'cost' }),
  // k 扫描：cost = 价格 − k×点数（k=0 现状，k→∞ 罚最大牌）
  penK04M: makePolicy('penK04M', { replace: 'cheap', pen: { mode: 'rank', k: 0.04 } }),
  penK06M: makePolicy('penK06M', { replace: 'cheap', pen: { mode: 'rank', k: 0.06 } }),
  penK08M: makePolicy('penK08M', { replace: 'cheap', pen: { mode: 'rank', k: 0.08 } }),
  penK15M: makePolicy('penK15M', { replace: 'cheap', pen: { mode: 'rank', k: 0.15 } }),
  penK30M: makePolicy('penK30M', { replace: 'cheap', pen: { mode: 'rank', k: 0.3 } }),
  penK04H: makePolicy('penK04H', { replace: 'net', w: 2, K: 12, pen: { mode: 'rank', k: 0.04 } }),
  penK08H: makePolicy('penK08H', { replace: 'net', w: 2, K: 12, pen: { mode: 'rank', k: 0.08 } }),
  penK15H: makePolicy('penK15H', { replace: 'net', w: 2, K: 12, pen: { mode: 'rank', k: 0.15 } }),
  penK30H: makePolicy('penK30H', { replace: 'net', w: 2, K: 12, pen: { mode: 'rank', k: 0.3 } }),
};

// 直接驱动 game-core 里"出厂"的四档难度——校准看这个，防止 lab 与正式实现漂移
function gcPolicy(name, diff) {
  const p = function (s) { return G.chooseNpcAction(s, diff); };
  p.policyName = name;
  return p;
}
POLICIES.gcEasy = gcPolicy('gcEasy', 'easy');
POLICIES.gcMedium = gcPolicy('gcMedium', 'medium');
POLICIES.gcHard = gcPolicy('gcHard', 'hard');
POLICIES.gcHell = gcPolicy('gcHell', 'hell');

// ---------- 对局 ----------
function playGame(npcPolicy, npcFirst, seed) {
  Math.random = mulberry32(seed);
  const s = G.createGame({ numDecks: 2 });
  s.turn = npcFirst ? 'npc' : 'player';
  let guard = 0;
  while (!G.isGameOver(s) && guard++ < 2000) {
    const who = s.turn;
    if (handOf(s, who).length === 0) { s.turn = who === 'player' ? 'npc' : 'player'; continue; }
    const a = who === 'player' ? G.chooseAction(s, 'player') : npcPolicy(s);
    applyAction(s, who, a);
    s.turn = who === 'player' ? 'npc' : 'player';
  }
  return {
    p: G.computeScore(s, 'player'),
    n: G.computeScore(s, 'npc'),
    over: G.isGameOver(s),
    turns: guard,
  };
}

function bench(name, N) {
  const pol = POLICIES[name];
  if (!pol) { console.log('未知策略: ' + name); return null; }
  let nWin = 0, pWin = 0, draw = 0, marginSum = 0, turnSum = 0, notOver = 0;
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    const r = playGame(pol, i % 2 === 1, 100000 + i); // 奇偶交替先后手，抵消先手优势
    marginSum += r.n - r.p;
    turnSum += r.turns;
    if (!r.over) notOver++;
    if (r.n > r.p) nWin++; else if (r.p > r.n) pWin++; else draw++;
  }
  const ms = Date.now() - t0;
  return {
    name: name, N: N,
    npcWin: nWin / N * 100,
    pWin: pWin / N * 100,
    draw: draw / N * 100,
    margin: marginSum / N,
    turns: turnSum / N,
    notOver: notOver,
    ms: ms,
  };
}

// ---------- 入口 ----------
const N = parseInt(process.argv[2] || '200', 10);
const names = (process.argv[3] || 'easy,medium,medDef,medRand,many15,many30').split(',');

console.log('N=' + N + '（每策略奇偶交替先后手，各策略共用同一发牌序列 → 配对比对）');
console.log('策略'.padEnd(11) + 'NPC胜率'.padEnd(10) + '玩家胜率'.padEnd(11) + '平'.padEnd(7) + 'NPC净分'.padEnd(10) + '均回合'.padEnd(9) + '耗时');
const rows = [];
for (const nm of names) {
  const r = bench(nm, N);
  if (!r) continue;
  rows.push(r);
  console.log(
    r.name.padEnd(11) +
    (r.npcWin.toFixed(1) + '%').padEnd(10) +
    (r.pWin.toFixed(1) + '%').padEnd(11) +
    (r.draw.toFixed(1) + '%').padEnd(7) +
    (r.margin >= 0 ? '+' : '') + r.margin.toFixed(2) + ''.padEnd(6) +
    r.turns.toFixed(1).padEnd(9) +
    (r.ms / 1000).toFixed(1) + 's' +
    (r.notOver ? '  ⚠未终局' + r.notOver : '')
  );
}
console.log('参考：玩家基线是同一套贪心策略 → medium 的 NPC 胜率即"同水平对抗"的基准值。');
