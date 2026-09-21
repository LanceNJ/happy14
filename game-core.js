/*
 * 欢乐十四分 —— 共享游戏内核（纯逻辑，无 UI 依赖）
 * 规则基线：
 *  - 2 副标准牌（含大小王）= 108 张。
 *  - 点数：A=1, 2~10=面, J=11, Q=12, K=13。
 *  - 大王计分 1 分、小王 0.75 分；配 14 时大小王 matchValue=0（随便配）。
 *  - 花色计分：黑桃 1 / 红桃 0.75 / 草花 0.5 / 方片 0.25。
 *  - 一次匹配 = 手牌任意非空子集 + 桌面恰好 1 张，和 = 14，全部进战利品。
 *  - 桌面被拿走的牌，由出牌方从手牌挑 1 张补回（手牌空则从补牌堆拿 1 张），再补牌把手牌补到 4。
 *  - 无法匹配则挑 1 张手牌作罚牌（隐藏），手牌 -1，随后从补牌堆补满到 4 张（补牌堆不足则尽力补）。
 *  - 补牌堆抓完进入残局（补牌堆已空 = 不足）：继续用手牌匹配，手牌只减不增（不再补满 4 张），直到双方都无法匹配且手牌耗尽。
 *  - 终局：得分 = 战利品合计 − 罚牌合计，高者胜。
 */

// ---------- 牌堆与计分 ----------
const SUITS = {
  S: { key: 'S', name: '黑桃', symbol: '♠', score: 1 },
  H: { key: 'H', name: '红桃', symbol: '♥', score: 0.75 },
  C: { key: 'C', name: '草花', symbol: '♣', score: 0.5 },
  D: { key: 'D', name: '方片', symbol: '♦', score: 0.25 },
};

function buildRanks() {
  const list = [];
  const labels = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
  for (let r = 1; r <= 13; r++) {
    list.push({ rank: r, label: labels[r] || String(r) });
  }
  return list;
}
const RANKS = buildRanks();

let _seq = 0;
function nextId() { return 'c' + (_seq++); }

function makeCard(suit, rank) {
  const s = SUITS[suit];
  const r = RANKS.find((x) => x.rank === rank);
  return {
    id: nextId(),
    suit: suit,
    rank: rank,
    label: s.symbol + r.label,
    short: r.label,
    suitSymbol: s.symbol,
    red: suit === 'H' || suit === 'D',
    matchValue: rank,
    score: s.score,
    isJoker: false,
  };
}

function makeJoker(big) {
  return {
    id: nextId(),
    suit: null,
    rank: big ? 14 : 15,
    label: big ? '大王' : '小王',
    short: '王',
    suitSymbol: '★',
    red: true,
    matchValue: 0,
    score: big ? 1 : 0.75,
    isJoker: true,
    big: big,
  };
}

function buildDeck(numDecks) {
  numDecks = numDecks || 2;
  const deck = [];
  for (let d = 0; d < numDecks; d++) {
    for (const suit of Object.keys(SUITS)) {
      for (const r of RANKS) deck.push(makeCard(suit, r.rank));
    }
    deck.push(makeJoker(true));
    deck.push(makeJoker(false));
  }
  return deck;
}

function shuffle(arr, rng) {
  rng = rng || Math.random;
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function cardScore(card) { return card.score; }
function sumScore(cards) { return cards.reduce((s, c) => s + c.score, 0); }
function sumMatchValue(cards) { return cards.reduce((s, c) => s + c.matchValue, 0); }

// ---------- 匹配与对局 ----------
function findMoves(hand, table) {
  const moves = [];
  const n = hand.length;
  for (let mask = 1; mask < (1 << n); mask++) {
    const subset = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) subset.push(hand[i]);
    const handSum = sumMatchValue(subset);
    for (const t of table) {
      if (handSum + t.matchValue === 14) {
        const captured = subset.concat([t]);
        moves.push({
          handCards: subset,
          tableCard: t,
          captured: captured,
          score: sumScore(captured),
        });
      }
    }
  }
  return moves;
}

function hasMove(hand, table) { return findMoves(hand, table).length > 0; }

function createGame(opts) {
  opts = opts || {};
  const numDecks = opts.numDecks || 2;
  const deck = shuffle(buildDeck(numDecks), opts.rng);
  const table = deck.splice(0, 6);
  const playerHand = deck.splice(0, 4);
  const npcHand = deck.splice(0, 4);
  return {
    table: table,
    playerHand: playerHand,
    npcHand: npcHand,
    drawPile: deck, // 余牌，抽牌用 pop()
    playerLoot: [],
    npcLoot: [],
    playerPenalty: [],
    npcPenalty: [],
    // 先手随机：opts.firstRandom 开启后双方各 50% 先手（UI 默认开启）；
    // 不传则保持玩家先手，兼容既有测试与脚本
    turn: (opts.firstRandom && (opts.rng ? opts.rng() : Math.random()) < 0.5) ? 'npc' : 'player',
    phase: 'playing',
    log: [],
    numDecks: numDecks,
  };
}

function drawOne(state) {
  return state.drawPile.length ? state.drawPile.pop() : null;
}

function handKey(who) { return who === 'player' ? 'playerHand' : 'npcHand'; }
function lootKey(who) { return who === 'player' ? 'playerLoot' : 'npcLoot'; }
function penKey(who) { return who === 'player' ? 'playerPenalty' : 'npcPenalty'; }

// 移除被拿的手牌与桌面牌，移入战利品；返回 captured
function capture(state, who, move) {
  const hk = handKey(who);
  const lk = lootKey(who);
  const capIds = new Set(move.handCards.map((c) => c.id));
  const tIdx = state.table.findIndex((c) => c.id === move.tableCard.id);
  if (tIdx >= 0) state.table.splice(tIdx, 1);
  state[hk] = state[hk].filter((c) => !capIds.has(c.id));
  state[lk] = state[lk].concat(move.captured);
  state.log.push((who === 'player' ? '玩家' : 'NPC') + ' 匹配成功，收获 ' + move.captured.length + ' 张战利品');
  return move.captured;
}

// 从手牌挑 1 张补到桌面（手牌空则从补牌堆拿 1 张），再把守牌补到 4
function replaceAndRefill(state, who, replaceCardId) {
  const hk = handKey(who);
  if (state[hk].length === 0) {
    const d = drawOne(state);
    if (d) state.table.push(d);
  } else {
    let idx = state[hk].findIndex((c) => c.id === replaceCardId);
    if (idx < 0) idx = 0;
    const r = state[hk].splice(idx, 1)[0];
    state.table.push(r);
  }
  while (state[hk].length < 4) {
    const d = drawOne(state);
    if (!d) break;
    state[hk].push(d);
  }
}

function penalty(state, who, cardId) {
  const hk = handKey(who);
  const pk = penKey(who);
  let idx = state[hk].findIndex((c) => c.id === cardId);
  if (idx < 0) idx = 0;
  const c = state[hk].splice(idx, 1)[0];
  state[pk].push(c);
  state.log.push((who === 'player' ? '玩家' : 'NPC') + ' 无法匹配，罚牌 1 张');
  // 罚牌后从补牌堆补满到 4 张（补牌堆不足则尽力补；残局补牌堆已空则手牌只减不增）
  while (state[hk].length < 4) {
    const d = drawOne(state);
    if (!d) break;
    state[hk].push(d);
  }
}

function computeScore(state, who) {
  const loot = who === 'player' ? state.playerLoot : state.npcLoot;
  const pen = who === 'player' ? state.playerPenalty : state.npcPenalty;
  const v = sumScore(loot) - sumScore(pen);
  return Math.round(v * 100) / 100;
}

function round2(v) { return Math.round(v * 100) / 100; }

// 分值明细：按花色统计张数与得分，另计大小王。用于结算时把"算分过程"摊开给玩家看
function scoreDetail(cards) {
  const bySuit = {
    S: { key: 'S', name: '黑桃', symbol: '♠', red: false, count: 0, points: 0, unit: SUITS.S.score },
    H: { key: 'H', name: '红桃', symbol: '♥', red: true, count: 0, points: 0, unit: SUITS.H.score },
    C: { key: 'C', name: '草花', symbol: '♣', red: false, count: 0, points: 0, unit: SUITS.C.score },
    D: { key: 'D', name: '方片', symbol: '♦', red: true, count: 0, points: 0, unit: SUITS.D.score },
  };
  const joker = {
    big: { name: '大王', symbol: '👑', count: 0, points: 0, unit: 1 },
    small: { name: '小王', symbol: '🌟', count: 0, points: 0, unit: 0.75 },
  };
  let total = 0;
  (cards || []).forEach((c) => {
    total += c.score;
    if (c.isJoker) {
      const k = c.big ? 'big' : 'small';
      joker[k].count++; joker[k].points += c.score;
    } else if (bySuit[c.suit]) {
      bySuit[c.suit].count++; bySuit[c.suit].points += c.score;
    }
  });
  Object.keys(bySuit).forEach((k) => { bySuit[k].points = round2(bySuit[k].points); });
  joker.big.points = round2(joker.big.points);
  joker.small.points = round2(joker.small.points);
  return { bySuit: bySuit, joker: joker, count: (cards || []).length, total: round2(total) };
}

function isGameOver(state) {
  return state.playerHand.length === 0 && state.npcHand.length === 0;
}

// 校验一手玩家选择是否合法（手牌子集 + 1 桌面牌 = 14）
function validatePlayerSelection(hand, table, handIds, tableId) {
  if (!handIds || handIds.length === 0 || !tableId) return null;
  const handCards = hand.filter((c) => handIds.includes(c.id));
  const tableCard = table.find((c) => c.id === tableId);
  if (handCards.length !== handIds.length || !tableCard) return null;
  if (sumMatchValue(handCards) + tableCard.matchValue !== 14) return null;
  return { handCards: handCards, tableCard: tableCard, captured: handCards.concat([tableCard]) };
}

// ---------- 贪心最优（玩家/NPC 通用，供 NPC 出牌与胜率模拟共用） ----------
// 排序规则：先比这一手能收多少分 → 同分多捞王 → 再少用手牌（保留手牌厚度）
function rankMoves(moves) {
  return moves.slice().sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ja = a.captured.filter((c) => c.isJoker).length;
    const jb = b.captured.filter((c) => c.isJoker).length;
    if (jb !== ja) return jb - ja;
    return a.handCards.length - b.handCards.length;
  });
}

// ---------- NPC 难度档位（仅对 NPC 生效；玩家永远是"人"） ----------
// 强度由 difficulty-lab.js 实测校准（配对发牌、先后手交替、玩家基线=贪心）：
//   easy   ≈35%  多数时候乱出（偶尔正常），罚牌还可能扔掉高分牌
//   medium ≈52%  一步贪心（原行为）：出当前这一手最大分、补到桌面那张挑分值最低的
//   hard   ≈76%  出牌同 medium，补牌换成"净威胁最小"：对手下一手收益 − 2×我下一手收益
//   hell   ≈95%  在前 4 高分手牌候选里 rollout（双方贪心走到底）估终局净分差，取最高
//   adaptive     只存在于 UI 层：按玩家近期战绩在上面四档之间自动升降，再传实际档位进来
//
// 四条用血换来的经验，改这段代码前先读：
//  ① 真正的杠杆是"补到桌面那一张"，不是"出哪一手"——只靠出牌贪心永远卡在 52%；
//  ② 补牌不能只算"别资敌"，还要算"给自己留机会"（净威胁的前后两项）。
//     只最小化"对手能捞多少"会选出谁都配不上的废牌：对手是没得捞，但我也没了抓手。
//     实测加这一项 67.1% → 76.2%（N=1500）；
//  ③ 不许直接读对手手牌来算这些：那是上帝视角 AI，表现为"永远不喂你牌"，玩家能明显感觉到被针对。
//     只用合法可见信息（未见池 = 对手手牌∪对手罚牌∪补牌堆，三者对 NPC 不可区分）抽样估计；
//  ④ 校准必须用能真正轮流行动的沙盒（见 difficulty-lab.js 顶部注释里的踩坑记录）。
const DIFFICULTIES = ['easy', 'medium', 'hard', 'hell', 'adaptive'];
// 自适应档内部挑选用的"实际档位"（'adaptive' 是 UI 层概念，内核不参与它的升降逻辑）
const BASE_DIFFICULTIES = ['easy', 'medium', 'hard', 'hell'];
// hard 档补牌的"给自己留机会"权重（校准台实测峰值，N=1500：w=0→67.1%，w=0.5→73.9%，w=2→76.2%，w=3→74.3%）
const HARD_REPLACE_W = 2;
// NPC 罚牌的点数倾斜：总代价 = 价格 − 0.06×点数。玩家洞见（2026-09-19）：别只赔眼前最便宜的，
// 大点数的牌凑14伙伴少（K 只能配 3），留着不如小牌值钱。校准台实测（配对发牌、先后手交替）：
//   medium 基座 N=1000：现状 51.7% → k=0.04 55.8% / k=0.06 56.4%（峰值）/ k=0.08 54.9% / k=0.30 48.5%（过头反害）。
//   hard   基座 N=1500：76.8% → k=0.04 77.1% / k=0.08 77.6%，持平略升。
// k=0.06 起正好复现玩家举的例子：方片4(0.25) 与 红桃K(0.75) 二选一时罚 K 留 4。
// 只对 NPC 生效；玩家侧基线（用于校准对比）保持"罚最便宜"不动。
const PENALTY_RANK_W = 0.06;

// 浅拷贝局面（卡牌对象只读不改），供预判时安全试算
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

// 从 pool 里不放回地抽 n 张（当作一副"假想对手手牌"）
function sampleFrom(pool, n) {
  const picked = [];
  const used = new Set();
  const lim = Math.min(n, pool.length);
  while (picked.length < lim) {
    const j = Math.floor(Math.random() * pool.length);
    if (used.has(j)) continue;
    used.add(j);
    picked.push(pool[j]);
  }
  return picked;
}

// 对手对当前桌面的下一手最大收益（用真实手牌算，仅供离线模拟/诊断，NPC 决策不直接用它）
function opponentBestGain(st, who) {
  const ohk = handKey(who === 'player' ? 'npc' : 'player');
  const ms = findMoves(st[ohk], st.table);
  let best = 0;
  for (const m of ms) if (m.score > best) best = m.score;
  return best;
}

// 补牌决策（hard/hell 共用）：在出牌剩下的手牌里挑一张补到桌面。
// 判据 = 净威胁：E[对手下一手能捞的分] − w × E[我下一手能捞的分]
//   · 前项 = 防守：别把对手能凑 14 的牌喂到桌上；
//   · 后项 = 进攻：补上去那张若对手没拿走、还留在桌面，也是我下一轮的抓手。
//     只求"对手捞不到"会选出谁都配不上的废牌——对手是没得捞，但我也没了抓手。
//   校准台实测（N=1500，玩家基线=贪心）：w=0→67.1%，w=0.5→73.9%，w=2→76.2%（峰值），w=3→74.3%。
//   → hard 用 w=2；hell 本身 rollout 到终局，这个权衡已被整体评估吸收（实测 w=2 在噪声内），保持 w=0 更省。
// 只用合法可见信息（未见池 = 对手手牌∪对手罚牌∪补牌堆，三者对 NPC 不可区分）抽样估计，不读对手真实手牌（经验②）。
function netReplaceId(state, who, move, w) {
  const weight = w || 0;
  const hk = handKey(who);
  const capIds = new Set(move.handCards.map((c) => c.id));
  const rest = state[hk].filter((c) => !capIds.has(c.id));
  if (!rest.length) return null;
  const oppWho = who === 'player' ? 'npc' : 'player';
  const pool = state[handKey(oppWho)].concat(state[penKey(oppWho)], state.drawPile);
  const K = 12;
  let bestId = rest[0].id, bestNet = Infinity;
  for (const c of rest) {
    const st = cloneState(state);
    capture(st, who, move);
    replaceAndRefill(st, who, c.id);
    // 我下一轮的手牌此刻已经定了（replaceAndRefill 已补满），对手的动作碰不到它，
    // 会变的只有桌面 → 我方收益对着推演出的新桌面直接算，不必再抽样。
    const myHand = st[hk];
    let sum = 0;
    for (let k = 0; k < K; k++) {
      const h = sampleFrom(pool, 4);
      const ms = findMoves(h, st.table);
      let oppGain = 0, bestMv = null;
      for (const m of ms) if (m.score > oppGain) { oppGain = m.score; bestMv = m; }
      let myGain = 0;
      if (weight > 0) {
        // 推演对手走完这一手后的桌面：他拿走他的目标牌、再补一张最便宜的（手牌打光则不补）
        let table2 = st.table;
        if (bestMv) {
          const used = new Set(bestMv.handCards.map((x) => x.id));
          const left = h.filter((x) => !used.has(x.id));
          left.sort((a, b) => a.score - b.score);
          table2 = st.table.filter((tc) => tc.id !== bestMv.tableCard.id);
          if (left.length) table2.push(left[0]);
        }
        const myMs = findMoves(myHand, table2);
        for (const m of myMs) if (m.score > myGain) myGain = m.score;
      }
      sum += oppGain - weight * myGain;
    }
    const net = sum / K;
    if (net < bestNet) { bestNet = net; bestId = c.id; }
  }
  return bestId;
}

// 双方都按贪心走到底（确定性，无随机），返回 who 立场下的终局净分差。
// 注意 guard：正常一局约 57 回合，600 足够；超了说明有异常，宁可截断也别死循环。
function playOutGreedy(st, who) {
  let guard = 0;
  while (!isGameOver(st) && guard++ < 600) {
    const cur = st.turn;
    const hk = handKey(cur);
    if (st[hk].length === 0) { st.turn = cur === 'player' ? 'npc' : 'player'; continue; }
    const act = chooseAction(st, cur); // 不传 difficulty → 贪心基线
    if (act.type === 'match') { capture(st, cur, act.move); replaceAndRefill(st, cur, act.replaceCardId); }
    else penalty(st, cur, act.cardId);
    st.turn = cur === 'player' ? 'npc' : 'player';
  }
  return computeScore(st, who) - computeScore(st, who === 'player' ? 'npc' : 'player');
}

// 地狱级评估：走完这一手后 rollout 到终局，取 who 的净分差
function evalMoveRollout(state, who, move, replaceCardId) {
  const st = cloneState(state);
  capture(st, who, move);
  replaceAndRefill(st, who, replaceCardId);
  st.turn = who === 'player' ? 'npc' : 'player';
  return Math.round(playOutGreedy(st, who) * 100) / 100;
}

// 中/易档用的"补最便宜的一张"
function cheapestReplaceId(hand, move) {
  const capIds = new Set(move.handCards.map((c) => c.id));
  const rest = hand.filter((c) => !capIds.has(c.id));
  if (!rest.length) return null;
  rest.sort((a, b) => a.score - b.score);
  return rest[0].id;
}

function chooseAction(state, who, opts) {
  opts = opts || {};
  const hand = who === 'player' ? state.playerHand : state.npcHand;
  const moves = findMoves(hand, state.table);

  if (moves.length === 0) {
    // 罚牌；easy 的 NPC 有概率反过来扔掉高分牌（明显更菜）
    if (who === 'npc' && opts.difficulty === 'easy' && Math.random() < 0.5) {
      const hi = hand.slice().sort((a, b) => b.score - a.score);
      return { type: 'penalty', cardId: hi[0].id };
    }
    if (who === 'npc' && opts.difficulty) {
      // NPC：总代价 = 价格 − PENALTY_RANK_W×点数（留小牌，见常量处的实测记录）。
      // 王百搭永远不罚（在这里它最值钱也最灵活）。
      let best = hand[0], bestC = Infinity;
      for (const c of hand) {
        const cost = c.isJoker ? 99 : (c.score - PENALTY_RANK_W * c.matchValue);
        if (cost < bestC) { bestC = cost; best = c; }
      }
      return { type: 'penalty', cardId: best.id };
    }
    // 玩家侧（人类在 UI 自己选；这条路径供模拟/顾问用）保持"罚最便宜"基线不动
    const sorted = hand.slice().sort((a, b) => a.score - b.score);
    return { type: 'penalty', cardId: sorted[0].id };
  }

  const diff = (who === 'npc') ? (opts.difficulty || 'medium') : null;
  let chosen, replaceCardId = null;

  // 局面不全（例如模拟脚本只传了 npcHand/table）时，高档难度所需的完整信息拿不到 → 退化到贪心
  const full = !!(state.playerHand && state.npcHand && state.drawPile);

  if (diff === 'easy') {
    // 多数时候随机出一手（弱），偶尔正常出（给点希望）
    if (Math.random() < 0.55) chosen = moves[Math.floor(Math.random() * moves.length)];
    else chosen = rankMoves(moves)[0];
    replaceCardId = cheapestReplaceId(hand, chosen);
  } else if (diff === 'hard' && full) {
    // 难：出牌与中等一致（盯当前最大分），补牌换成"净威胁最小"（防守 + 给自己留机会，权重见常量）
    chosen = rankMoves(moves)[0];
    replaceCardId = netReplaceId(state, who, chosen, HARD_REPLACE_W);
  } else if (diff === 'hell' && full) {
    // 地狱：前几手高分候选各 rollout 到终局，挑终局净分差最高的。
    // 补牌这里用 w=0（纯防守）：rollout 已经整体评估了终局，权衡已被吸收，再加权重实测在噪声内。
    const ranked = rankMoves(moves);
    const breadth = Math.min(ranked.length, 4);
    let best = null, bestV = -Infinity;
    for (let mi = 0; mi < breadth; mi++) {
      const mv = ranked[mi];
      const rid = netReplaceId(state, who, mv, 0);
      const v = evalMoveRollout(state, who, mv, rid);
      if (v > bestV) { bestV = v; best = { mv: mv, rid: rid }; }
    }
    chosen = best.mv;
    replaceCardId = best.rid;
  } else {
    // medium（以及局面不全时的高级档）：一步贪心（原行为）
    chosen = rankMoves(moves)[0];
    replaceCardId = cheapestReplaceId(hand, chosen);
  }

  return { type: 'match', move: chosen, replaceCardId: replaceCardId };
}

function chooseNpcAction(state, difficulty) {
  return chooseAction(state, 'npc', { difficulty: difficulty });
}

// 牌数守恒检查（调试用）
function totalCards(state) {
  return (
    state.table.length + state.playerHand.length + state.npcHand.length +
    state.drawPile.length + state.playerLoot.length + state.npcLoot.length +
    state.playerPenalty.length + state.npcPenalty.length
  );
}

// ---------- 信息划分：哪些牌是"看得见的"，哪些是"未知的" ----------
// 评价"把牌补到桌面会不会被对手吃走"必须站在玩家的真实信息上算，不能偷看对手手牌。
//   可见（明牌）：桌面 6 张、我的手牌、我的战利品/罚牌、NPC 战利品（拿走时都是亮过的）
//   未知：NPC 手牌、NPC 罚牌（隐藏）、补牌堆
function visiblePool(state) {
  return state.table
    .concat(state.playerHand, state.playerLoot, state.playerPenalty, state.npcLoot);
}
function unknownPool(state) {
  return state.npcHand.concat(state.npcPenalty, state.drawPile);
}

module.exports = {
  SUITS, RANKS, buildDeck, shuffle, makeCard, makeJoker,
  cardScore, sumScore, sumMatchValue,
  findMoves, hasMove, createGame, drawOne,
  capture, replaceAndRefill, penalty, computeScore, scoreDetail, isGameOver,
  validatePlayerSelection, rankMoves, chooseAction, chooseNpcAction, totalCards,
  visiblePool, unknownPool,
  handKey, lootKey, penKey,
  DIFFICULTIES, BASE_DIFFICULTIES, HARD_REPLACE_W, PENALTY_RANK_W, cloneState, opponentBestGain, netReplaceId, cheapestReplaceId,
  playOutGreedy, evalMoveRollout,
};
