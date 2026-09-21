/*
 * 欢乐十四分 —— 决策顾问（Electron / 浏览器 / 小程序 三端共用）
 *  1) 最优判断：玩家这一步是否最优；不是最优就指出更赚的那手
 *  2) 胜率估计：蒙特卡洛模拟（隐藏未知牌后重洗，双方按贪心跑完，统计胜负平）
 *  3) NPC 人设台词：什么情境说什么话、配什么表情
 * 纯逻辑、无 UI 依赖；不修改传入的 state。
 *
 * 注意：整个模块包在 IIFE 里。浏览器里 <script> 共享同一个全局词法环境，
 *       若在顶层写 const G，会和 app.js 顶层的 const G 撞成"Identifier 'G' has already been declared"直接白屏。
 */
(function () {
const G = (typeof require !== 'undefined')
  ? require('./game-core.js')
  : ((typeof window !== 'undefined') ? window.G : null);

const r2 = (v) => Math.round(v * 100) / 100;

// ---------- 0. 局面克隆（只复制数组，卡牌对象本身只读不改） ----------
function cloneState(st) {
  return {
    table: st.table.slice(),
    playerHand: st.playerHand.slice(),
    npcHand: st.npcHand.slice(),
    drawPile: st.drawPile.slice(),
    playerLoot: st.playerLoot.slice(),
    npcLoot: st.npcLoot.slice(),
    playerPenalty: st.playerPenalty.slice(),
    npcPenalty: st.npcPenalty.slice(),
    turn: st.turn,
    phase: 'playing',
    log: [],
    numDecks: st.numDecks || 2,
  };
}

// ---------- 1. 出牌是否最优 ----------
function sameMove(m, handIds, tableId) {
  if (!m || !tableId || !handIds || !handIds.length) return false;
  if (m.tableCard.id !== tableId) return false;
  if (m.handCards.length !== handIds.length) return false;
  return m.handCards.every((c) => handIds.indexOf(c.id) >= 0);
}

// 玩家这一手 vs 本回合所有合法走法里最赚的那手
// 评价只比"这一手能收走多少分"，同分再比谁多捞王、谁更省手牌（与 rankMoves 一致）；
// 不做多步预判——所以"不是最优"的确切含义是"这一手比本回合最好的那一手少拿分"，
// 不等于"这局要输"（全局后果在胜率模拟里另算）。
function judgeMatch(hand, table, handIds, tableId) {
  const moves = G.findMoves(hand, table);
  if (!moves.length) return { ok: false, optimal: false, gain: 0, bestGain: 0, best: null, count: 0, why: '' };
  const ranked = G.rankMoves(moves);
  const best = ranked[0];
  const chosen = moves.find((m) => sameMove(m, handIds, tableId)) || null;
  const gain = chosen ? r2(G.sumScore(chosen.captured)) : 0;
  const bestGain = r2(G.sumScore(best.captured));
  // 和 rankMoves 同一套判优标准：分值 → 王数 → 用掉的手牌张数，三项都不差才算"最优"
  const jc = chosen ? chosen.captured.filter((c) => c.isJoker).length : 0;
  const jb = best.captured.filter((c) => c.isJoker).length;
  const optimal = !!chosen &&
    gain >= bestGain - 1e-9 && jc >= jb && chosen.handCards.length <= best.handCards.length;
  // 差在哪，用一句话说清（玩家能看到依据，而不是只被告知"不是最优"）
  let why = '';
  if (chosen && !optimal) {
    if (gain < bestGain - 1e-9) why = '能多拿 +' + r2(bestGain - gain) + ' 分';
    else if (jc < jb) why = '同样是 ' + bestGain + ' 分，但能多捞 ' + (jb - jc) + ' 张王';
    else why = '同样是 ' + bestGain + ' 分，但能少用 ' + (chosen.handCards.length - best.handCards.length) + ' 张手牌';
  }
  return {
    ok: !!chosen,
    optimal: optimal,
    gain: gain,
    bestGain: bestGain,
    jokers: jc,
    bestJokers: jb,
    best: best,
    count: moves.length,
    why: why,
  };
}

// ---------- 2. 补到桌面的牌是否合理 ----------
// 摊到桌面的牌 = 送给对手的牌。判断依据只有两条，都能算出来、也能向玩家讲清楚：
//   ① 分值：一旦被对手吃走，这张牌的分就记到对手头上 —— 分值越高越亏；
//   ② 被吃走的概率 P：对手手上那几张未知牌里，能不能凑出 (14 − 这张牌的值) 的非空子集。
// 注意规律方向：这张牌**值越大 → 需要凑的目标越小 → 凑法越少 → P 越低**。
//   例：桌面放 K(13) 需要对手凑 1 → 只有"单张 A"这一条路；
//       桌面放 2     需要对手凑 12 → Q 单张、3+9、4+8、5+7、6+6… 一大堆路。
// 所以 cost = 分值 × P，含义是"期望送出去多少分"，越小越好。
// P 用**精确枚举**（值多重集 + 组合数加权），不是随机抽样 —— 同一局面结论稳定、可复现、可断言。
function poolCounts(cards) {
  const c = {};
  (cards || []).forEach((x) => { const v = x.matchValue || 0; c[v] = (c[v] || 0) + 1; });
  return c;
}
// 没传未知牌池时的兜底：整副（2副=108张）减去已知的手牌和桌面
function defaultUnknownPool(hand, table) {
  const counts = { 0: 4 };                       // 大小王各 2 张
  for (let v = 1; v <= 13; v++) counts[v] = 8;   // 每点数 4 花色 × 2 副
  (hand || []).concat(table || []).forEach((c) => {
    const v = c.matchValue || 0;
    counts[v] = Math.max(0, (counts[v] || 0) - 1);
  });
  const out = [];
  Object.keys(counts).forEach((k) => { for (let i = 0; i < counts[k]; i++) out.push({ matchValue: Number(k) }); });
  return out;
}
function nCr(m, r) {
  if (r < 0 || r > m) return 0;
  let x = 1;
  for (let i = 0; i < r; i++) x = (x * (m - i)) / (i + 1);
  return Math.round(x);
}
// drawN 张（不放回）中存在非空子集和 = target 的概率
function riskProbability(target, counts, drawN) {
  if (!(target >= 1) || drawN < 1) return 0;
  const vals = Object.keys(counts).map(Number).filter((v) => counts[v] > 0).sort((a, b) => a - b);
  const poolSize = vals.reduce((s, v) => s + counts[v], 0);
  const k = Math.min(drawN, poolSize);
  if (!k) return 0;
  let totalW = 0, hitW = 0;
  const picked = [];
  const hit = (arr) => {
    for (let mask = 1; mask < (1 << arr.length); mask++) {
      let s = 0;
      for (let i = 0; i < arr.length; i++) if (mask & (1 << i)) s += arr[i];
      if (s === target) return true;
    }
    return false;
  };
  (function rec(start, left) {
    if (left === 0) {
      const cnt = {};
      picked.forEach((v) => { cnt[v] = (cnt[v] || 0) + 1; });
      let w = 1;
      Object.keys(cnt).forEach((v) => { w *= nCr(counts[v], cnt[v]); });
      totalW += w;
      if (hit(picked)) hitW += w;
      return;
    }
    for (let i = start; i < vals.length; i++) { picked.push(vals[i]); rec(i, left - 1); picked.pop(); }
  })(0, k);
  return totalW ? hitW / totalW : 0;
}

// 我下一手的收益：把 c 放上桌后，剩下的手牌能从那 6 张桌面里凑出多少分（0 = 凑不出）。
// 这就是玩家说的"留后路"——放牌不只是止损，也可能是在给自己铺下一手。
// 注意：下一手还会从补牌堆补满手牌，这里补进来的牌未知，所以只按现有手牌估，是**保守下限**。
function nextTurnGain(hand, table, c) {
  const rest = hand.filter((x) => x.id !== c.id);
  const newTable = table.concat([c]);
  const moves = G.findMoves(rest, newTable);
  let best = 0;
  moves.forEach((m) => { const g = G.sumScore(m.captured); if (g > best) best = g; });
  return r2(best);
}

// ctx.unknown：未知牌池（见 game-core.unknownPool）；ctx.oppHandSize：对手手牌张数
// 判据（两个维度，都能对玩家解释清楚）：
//   cost = 分值 × 被吃走概率   → 我送出去多少（越小越好）
//   path = 我下一手能凑多少分  → 我换回来多少（越大越好）
//   net  = path − cost         → 净账，越高越好。所有候选手牌都铺不出后路时，path 全为 0，
//                                判据自动退化成"只挑期望送分最低的"，与旧行为一致。
function replaceCandidates(hand, table, capturedIds, ctx) {
  const taken = capturedIds || [];
  const pool = (ctx && ctx.unknown) || defaultUnknownPool(hand, table);
  const counts = poolCounts(pool);
  const drawN = (ctx && ctx.oppHandSize != null) ? ctx.oppHandSize : 4;
  return hand
    .filter((c) => taken.indexOf(c.id) < 0)
    .map((c) => {
      const p = riskProbability(14 - (c.matchValue || 0), counts, drawN);
      const cost = r2(c.score * p);                // 期望送分
      const path = nextTurnGain(hand, table, c);   // 我下一手的收益
      return {
        cardId: c.id,
        card: c,
        score: c.score,
        p: p,
        riskPct: Math.round(p * 100),   // 展示用：预计被吃走的百分比
        cost: cost,
        path: path,
        net: r2(path - cost),           // 净账
      };
    })
    .sort((a, b) => (b.net - a.net) || (a.cost - b.cost) || (a.score - b.score));
}

function judgeReplace(hand, table, capturedIds, chosenId, ctx) {
  const cands = replaceCandidates(hand, table, capturedIds, ctx);
  if (!cands.length) return { ok: true, optimal: true, suggest: null, chosen: null, count: 0 };
  const chosen = cands.find((x) => x.cardId === chosenId) || null;
  const best = cands[0];
  const same = (x, y) => !!x && Math.abs(x.net - y.net) < 1e-9 && Math.abs(x.cost - y.cost) < 1e-9;
  // "好在哪"用一句话说清：是因为送得更少，还是因为给自己留了后路
  let why = '';
  if (chosen && !same(chosen, best)) {
    if (best.path > chosen.path + 1e-9 && best.cost <= chosen.cost + 1e-9) {
      why = '这张能给自己留后路（下一手可凑 ' + best.path + ' 分）';
    } else if (best.cost < chosen.cost - 1e-9 && best.path >= chosen.path - 1e-9) {
      why = '期望送分更低（' + best.cost + ' < ' + chosen.cost + '）';
    } else {
      why = '净账更高（留后路 ' + best.path + ' 分 − 期望送 ' + best.cost + ' 分）';
    }
  }
  return {
    ok: !!chosen,
    optimal: same(chosen, best),
    suggest: best,
    chosen: chosen,
    count: cands.length,
    why: why,
  };
}

// ---------- 3. 罚牌是否最优 ----------
function judgePenalty(hand, table) {
  const moves = G.findMoves(hand, table);
  const ranked = G.rankMoves(moves);
  const best = ranked.length ? ranked[0] : null;
  return {
    hasMove: moves.length > 0,
    optimal: moves.length === 0, // 本来就无解 → 罚牌是唯一选择
    bestGain: best ? r2(G.sumScore(best.captured)) : 0,
    best: best,
  };
}

function rateDecisions(stats) {
  const total = stats ? (stats.total || 0) : 0;
  const optimal = stats ? (stats.optimal || 0) : 0;
  return { total: total, optimal: optimal, rate: total ? Math.round((optimal / total) * 100) : null };
}

// ---------- 4. 胜率模拟 ----------
// 玩家看不到 NPC 手牌 / NPC 罚牌 / 补牌堆顺序：模拟时把这堆未知牌重洗后再发，
// 保证是"从玩家信息出发"的公平估计，而不是上帝视角。
function hideUnknown(st, rng) {
  const pool = st.npcHand.concat(st.npcPenalty, st.drawPile);
  const sh = G.shuffle(pool, rng);
  st.npcHand = sh.splice(0, st.npcHand.length);
  st.npcPenalty = sh.splice(0, st.npcPenalty.length);
  st.drawPile = sh;
}

function other(who) { return who === 'player' ? 'npc' : 'player'; }

// 走完这一局，返回 1=玩家胜 / -1=NPC胜 / 0=平。
// npcDiff：NPC 用的难度档（'easy'..'hell'，自适应档请在调用前解析成基础档）；缺省 medium 贪心。
function playOut(st, npcDiff) {
  let guard = 0;
  while (!G.isGameOver(st) && guard++ < 600) {
    const who = st.turn;
    const hand = who === 'player' ? st.playerHand : st.npcHand;
    if (hand.length === 0) { st.turn = other(who); continue; }
    const act = (who === 'npc' && npcDiff)
      ? G.chooseAction(st, who, { difficulty: npcDiff })
      : G.chooseAction(st, who);
    if (act.type === 'match') {
      G.capture(st, who, act.move);
      G.replaceAndRefill(st, who, act.replaceCardId);
    } else {
      G.penalty(st, who, act.cardId);
    }
    st.turn = other(who);
  }
  const ps = G.computeScore(st, 'player');
  const ns = G.computeScore(st, 'npc');
  return ps > ns ? 1 : (ps < ns ? -1 : 0);
}

function simulateOne(state, rng, npcDiff) {
  const st = cloneState(state);
  st.log = [];              // 日志在模拟里没意义，且会长到几十条 × 上百局
  hideUnknown(st, rng);
  return playOut(st, npcDiff);
}

// 跑 n 局，返回统计；chunk 用于分片调用（避免一次阻塞界面）
function simulateWinRate(state, n, rng, npcDiff) {
  const out = { win: 0, lose: 0, draw: 0, n: n || 0, winRate: 0, loseRate: 0, drawRate: 0 };
  for (let i = 0; i < out.n; i++) {
    const r = simulateOne(state, rng, npcDiff);
    if (r > 0) out.win++; else if (r < 0) out.lose++; else out.draw++;
  }
  const den = out.n || 1;
  out.winRate = out.win / den;
  out.loseRate = out.lose / den;
  out.drawRate = out.draw / den;
  return out;
}

// 把若干批统计合并（分片计算用）
function emptySim() { return { win: 0, lose: 0, draw: 0, n: 0 }; }
function mergeSim(acc, part) {
  acc.win += part.win; acc.lose += part.lose; acc.draw += part.draw; acc.n += part.n;
  return acc;
}
function finishSim(acc) {
  const den = acc.n || 1;
  acc.winRate = acc.win / den;
  acc.loseRate = acc.lose / den;
  acc.drawRate = acc.draw / den;
  return acc;
}

// ---------- 5. NPC 人设：情境 → 表情 + 台词 ----------
const LINES = {
  start: [
    ['happy', '来吧，看谁凑得多！'],
    ['idle', '开局先礼后兵，你先请。'],
    ['think', '我算算这桌牌……'],
  ],
  npcMatch: [
    ['idle', '这手归我了。'],
    ['happy', '嗯，正好凑够 14。'],
    ['idle', '拿走不谢～'],
    ['think', '这张我等好几轮了。'],
  ],
  npcJoker: [
    ['greedy', '嘿嘿，王归我了！'],
    ['greedy', '大王小王，我都想要～'],
    ['greedy', '这张王，我惦记很久了。'],
  ],
  npcBigLoot: [
    ['happy', '这波赚到了！'],
    ['greedy', '一网打尽，舒服。'],
    ['happy', '谢谢款待～'],
  ],
  npcPenalty: [
    ['sad', '哎，这手真凑不出…'],
    ['sad', '认罚，认罚。'],
    ['think', '先忍一手。'],
  ],
  playerJoker: [
    ['shock', '那两张王本来是我的！'],
    ['sad', '王都让你捞走了…'],
    ['shock', '哎哎哎，连王一起端？'],
  ],
  playerBigLoot: [
    ['shock', '这几张你别全拿走啊。'],
    ['sad', '手真快。'],
    ['think', '亏了这一手…'],
  ],
  playerPenalty: [
    ['happy', '罚吧罚吧，我不拦你。'],
    ['idle', '这张牌可惜了。'],
    ['greedy', '嘿嘿，少一张牌可不好打。'],
  ],
  ahead: [
    ['happy', '领先这么多，你还追得上吗？'],
    ['greedy', '稳了稳了。'],
    ['happy', '要不要认输？开玩笑的～'],
  ],
  behind: [
    ['sad', '别得意，还有牌呢。'],
    ['think', '我得找找机会…'],
    ['shock', '这分差有点扎眼。'],
  ],
  lowDraw: [
    ['think', '快没牌了，拼手速吧。'],
    ['idle', '牌堆见底，注意残局。'],
    ['greedy', '残局我最擅长。'],
  ],
  overWin: [
    ['greedy', '承让承让～ 再来一局？'],
    ['happy', '今天手气在我这边。'],
    ['greedy', '分是我的了，哈哈。'],
  ],
  overLose: [
    ['sad', '…下次一定。'],
    ['think', '复盘一下，我哪手亏了？'],
    ['shock', '你这也太顺了吧！'],
  ],
  overDraw: [
    ['shock', '居然平了？再来一局分胜负！'],
    ['think', '平局…有点不服。'],
  ],
};

const pick = (arr, rng) => arr[Math.floor((rng || Math.random)() * arr.length) % arr.length];

// 只有这两类是"碎嘴"（普通匹配、残局提醒，出现频率高）→ 走座位小气泡，不打扰；
// 其余都是有戏的情境（捞王得意、被抢王震惊、罚牌吃瘪、挑衅、结算嘴炮、开局）→ 弹大娃娃。
const SMALL_EVENTS = { npcMatch: 1, lowDraw: 1 };

// event: 见 LINES 的键；opts.chance<1 时按概率说话（普通回合别每轮都唠叨）
function npcSay(event, opts) {
  const pool = LINES[event];
  if (!pool || !pool.length) return null;
  opts = opts || {};
  const rng = opts.rng || Math.random;
  const chance = (opts.chance == null) ? 1 : opts.chance;
  if (chance < 1 && rng() > chance) return null;
  const line = pick(pool, rng);
  return { mood: line[0], text: line[1], big: !SMALL_EVENTS[event] };
}

module.exports = {
  cloneState, hideUnknown, playOut, simulateOne, simulateWinRate,
  emptySim, mergeSim, finishSim,
  judgeMatch, judgeReplace, judgePenalty, replaceCandidates, rateDecisions,
  riskProbability, poolCounts, defaultUnknownPool,
  npcSay, LINES, SMALL_EVENTS,
};
})();
