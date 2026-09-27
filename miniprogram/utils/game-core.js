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
      if (!t) continue;
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

// 只把手牌补满到 4（不往桌面放牌）：给"假设我少放一张牌"的评估场面用
function refillHandTo4(st, who) {
  const hk = handKey(who);
  while (st[hk].length < 4) {
    const d = drawOne(st);
    if (!d) break;
    st[hk].push(d);
  }
  return st[hk];
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
  state.lastCaptureTableIdx = tIdx;   // 记下列被收走的位置；桌面留一个空位(null)，补牌时直接填空位，其余桌牌纹丝不动
  if (tIdx >= 0) state.table[tIdx] = null;  // 留空位：被凑掉的牌位置先空着，补牌时填空位
  state[hk] = state[hk].filter((c) => !capIds.has(c.id));
  state[lk] = state[lk].concat(move.captured);
  state.log.push((who === 'player' ? '玩家' : 'NPC') + ' 匹配成功，收获 ' + move.captured.length + ' 张战利品');
  return move.captured;
}

// 从手牌挑 1 张补到桌面（手牌空则从补牌堆拿 1 张），再把守牌补到 4
function replaceAndRefill(state, who, replaceCardId) {
  const hk = handKey(who);
  // 新牌（补回桌面的那张）填回「被收走的桌面位置」，其余桌牌不动；无记录则兜底追加到末尾
  const at = (typeof state.lastCaptureTableIdx === 'number' && state.lastCaptureTableIdx >= 0 && state.lastCaptureTableIdx <= state.table.length) ? state.lastCaptureTableIdx : null;
  const putTable = (c) => { if (at === null) state.table.push(c); else state.table[at] = c; };  // 填空位而非插入：其余牌绝不动
  if (state[hk].length === 0) {
    const d = drawOne(state);
    if (d) putTable(d);
  } else {
    let idx = state[hk].findIndex((c) => c.id === replaceCardId);
    if (idx < 0) idx = 0;
    const r = state[hk].splice(idx, 1)[0];
    putTable(r);
  }
  while (state[hk].length < 4) {
    const d = drawOne(state);
    if (!d) break;
    state[hk].push(d);
  }
  // 残局兜底：手牌空且补牌堆也空时，空位永远补不上——把空位收掉，桌面合法变少一张，保持牌数守恒
  if (at !== null && state.table[at] === null) state.table.splice(at, 1);
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

// 同点数支配分组（NPC 专用；玩家侧 UI 需要完整候选列表 → 不动 findMoves）：
// 两个候选若 handCards 完全相同，桌面那张必然同点数（否则凑不到 14），而"能走的路线集合"
// 只由点数决定、花色只决定分值 → 取分更高的那条通常更好：自己多得 Δ，且留在桌面的那张
// 便宜牌对双方都只值 Δ 少（真实价值上弱优于"拿便宜那张"）。
// ⚠️ 但它**不是严格支配**（2026-09-23 实测改正）：花色分值是平的（♠1/♥0.75/♣0.5/♦0.25，
//    不乘点数），同点数最多差 0.75；而 evalMoveRollout 是确定性贪心推演（不连续估计器）——
//    0.25 的扰动会让某一手的 rankMoves 排序翻转、整条推演线分叉。实测"同补牌下 rep >= alt"
//    只占 95.64%，4.36% 反例（119/2731 配对样本，最大 −35 分，见 _probe_dom.js）。
//    所以这是"实测更优"而非"可证不差"：校准台配对 N=500，hell 91.8% → 94.0%（对照组 gcHard 不变）。
// 返回 {rep, alts}：rep = 组内分值最高的代表，alts = 组内全部候选（含 rep）。
// 调用方用 alts 里各张牌算出的补牌去评 rep：选桌面牌与选补牌本来是两个决策，分开评会让 0.25 的
// 差值被补牌差异淹没；合并评可让组内这些选项仍被完整考察，且成本与逐张评相同。
// 传入的表须已按分值降序排好（rankMoves 的输出）；分组顺序即代表的分值顺序。
function dominanceGroups(moves) {
  const byKey = new Map();
  for (const mv of moves) {
    const key = mv.handCards.map((c) => c.id).sort().join('|');
    if (!byKey.has(key)) byKey.set(key, { rep: mv, alts: [] });
    byKey.get(key).alts.push(mv);
  }
  return Array.from(byKey.values());
}

// 只要每组的代表（同点数支配剪枝的简写形式；供探针/校准台与外部调用）
function pruneDominatedMoves(moves) {
  return dominanceGroups(moves).map((g) => g.rep);
}
// ---------- NPC 难度档位（仅对 NPC 生效；玩家永远是"人"） ----------
// 强度由 difficulty-lab.js 实测校准（配对发牌、先后手交替、玩家基线=贪心）：
//   easy   ≈35%  多数时候乱出（偶尔正常），罚牌还可能扔掉高分牌
//   medium ≈52%  一步贪心（原行为）：出当前这一手最大分、补到桌面那张挑分值最低的
//   hard   ≈76%  出牌同 medium，补牌换成"净威胁最小"：对手下一手收益 − 2×我下一手收益
//   hell   ≈95%  在前 4 高分手牌候选里 rollout（双方贪心走到底）估终局净分差，取最高
//   (2026-09-22 自适应已移除：四档固定，高层难度由学习系统个性化接管，见 DEFAULT_WEIGHTS/NPC_WEIGHTS)
//
// 四条用血换来的经验，改这段代码前先读：
//  ① 真正的杠杆是"补到桌面那一张"，不是"出哪一手"——只靠出牌贪心永远卡在 52%；
//  ② 补牌不能只算"别资敌"，还要算"给自己留机会"（净威胁的前后两项）。
//     只最小化"对手能捞多少"会选出谁都配不上的废牌：对手是没得捞，但我也没了抓手。
//     实测加这一项 67.1% → 76.2%（N=1500）；
//  ③ 不许直接读对手手牌来算这些：那是上帝视角 AI，表现为"永远不喂你牌"，玩家能明显感觉到被针对。
//     只用合法可见信息（未见池 = 对手手牌∪对手罚牌∪补牌堆，三者对 NPC 不可区分）抽样估计；
//  ④ 校准必须用能真正轮流行动的沙盒（见 difficulty-lab.js 顶部注释里的踩坑记录）。
const DIFFICULTIES = ['easy', 'medium', 'hard', 'hell'];
// 2026-09-22 自适应档已移除：合法档位仅剩四档，学习系统通过 setNpcWeights 个性化 hard/hell
const BASE_DIFFICULTIES = ['easy', 'medium', 'hard', 'hell']; // 2026-09-22 自适应已移除，声明保留供离线工具/移动端引用
// hard 档补牌的"给自己留机会"权重（校准台实测峰值，N=1500：w=0→67.1%，w=0.5→73.9%，w=2→76.2%，w=3→74.3%）
// ---------- NPC 决策权重（可学习；学习系统会改写 NPC_WEIGHTS 让高层难度个性化） ----------
// 四个旋钮，对应四条原则：
//   defenseW  防守：补牌别把对手能凑14的牌喂到桌上（别资敌）
//   selfW     自保：补牌后我下一手能不能捞（留对我有用的牌）
//   keepW     甩负担：补牌时把"对我没用/留着要重罚"的牌推上桌（优先推大牌、推黑桃，避免自己罚重分）
//   playW     记牌：用"未见点数的精确多重集"算可玩性，决定罚牌/留牌（K 只剩 A 能配时先罚）
// 出牌的"优先用王"是排序硬规则（见 rankMoves），不进权重；罚牌不再硬护王（原 cost=99 已删）。
const DEFAULT_WEIGHTS = {
  defenseW: 2.0,   // 别资敌（原 HARD_REPLACE_W 校准峰值）
  selfW: 2.0,     // 留对我有用的牌（原 rollout 的"给我下一手"项）
  keepW: 1.0,      // 甩负担/推大牌
  playW: 0.8,     // 记牌：罚牌可玩性权重（可玩=贵→少罚；K 只剩 A 时最便宜→先罚）
};
let NPC_WEIGHTS = Object.assign({}, DEFAULT_WEIGHTS);
// 学习系统调用：合并默认与已学权重（缺字段回退默认）
function setNpcWeights(w) {
  if (w && typeof w === 'object') {
    NPC_WEIGHTS = Object.assign({}, DEFAULT_WEIGHTS, w);
  }
}
function getNpcWeights() { return Object.assign({}, NPC_WEIGHTS); }

// 记牌：某点数还剩几张没露面（全副 2 副 -> 普通点数 8 张，王各 4 张）
function unseenOfRank(state, rank) {
  const total = (rank >= 14) ? 4 : 8;
  let seen = 0;
  for (const c of visiblePool(state)) if (c.rank === rank) seen++;
  return Math.max(0, total - seen);
}

// ---------- 可玩性：穷尽"这张牌还能不能用上" ----------
// 原则（玩家洞见 2026-09-22）：不能只看"单张搭档(14 - 点数)还剩几张"。
//   反例：4 的搭档 10 只剩 2 张（看着快死），但我手上正好有 2、桌面正好有 8，
//        4+2+8=14 —— 现在就走的通。所以先穷尽"现在"的路线，再谈概率。
// 找到这张牌属于哪只手（只读推断；模拟脚本只传 npcHand 时也能工作）
function handOfCard(state, card) {
  const ph = state.playerHand || [];
  const nh = state.npcHand || [];
  if (ph.some((c) => c.id === card.id)) return ph;
  if (nh.some((c) => c.id === card.id)) return nh;
  return null;
}
// 穷尽现在的全部合法路线：card + 其余手牌任意子集(=s) + 桌面恰好 1 张(=t)，
// 判据与 findMoves 完全一致（card.matchValue + s + t.matchValue === 14），所以是精确枚举、不是概率代理。
function useRoutes(state, card) {
  const hand = handOfCard(state, card) || [card];
  const others = hand.filter((c) => c.id !== card.id);
  const table = state.table || [];
  const routes = [];
  const n = others.length;
  for (let mask = 0; mask < (1 << n); mask++) {
    let s = 0;
    const sel = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) { s += others[i].matchValue; sel.push(others[i]); }
    const need = 14 - card.matchValue - s;
    for (const t of table) { if (!t) continue; if (t.matchValue === need) routes.push({ handCards: [card].concat(sel), tableCard: t }); }
  }
  return routes;
}
// 单张搭档（14 - 点数）还剩几张没露面：旧代理，现在只作为"差一张"的一路证据
function complementLeft(state, card) {
  const need = 14 - card.matchValue;
  if (need <= 0 || need > 13) return 0;
  // 搭档与自己同点（如 7 的搭档就是 7）时，"自己这张"不算还能再来的牌
  const self = (need === card.rank) ? 1 : 0;
  return Math.max(0, unseenOfRank(state, need) - self);
}
// "还差一张"：补到/抽到一张 r 就能配桌面现成的那张（打对折：得靠运气，且桌面那张还得留着）
function oneAwayStrength(state, card) {
  const table = state.table || [];
  let best = 0;
  for (let r = 1; r <= 13; r++) {
    const u = unseenOfRank(state, r) - ((r === card.rank) ? 1 : 0);
    if (u <= 0) continue;
    const need = 14 - card.matchValue - r;
    if (need < 0 || need > 13) continue;
    if (!table.some((t) => t && t.matchValue === need)) continue;
    best = Math.max(best, u / 8);
  }
  if (unseenOfRank(state, 14) + unseenOfRank(state, 15) > 0) {
    const need = 14 - card.matchValue;
    if (need >= 0 && need <= 13 && table.some((t) => t && t.matchValue === need)) best = Math.max(best, 0.5);
  }
  return best;
}
// 可玩性 0~1：现在就有路线 -> 1（王百搭也是 1）；否则取"差一张"里最强的那一路，上限 0.5。
// 0 表示两跳以上：留着就是等重罚 -> 罚牌先罚它、补牌优先把它推上桌。
function playability(state, card) {
  if (useRoutes(state, card).length > 0) return 1;
  if (card.matchValue === 0) return 1;
  const base = Math.min(1, complementLeft(state, card) / 8);
  const away = oneAwayStrength(state, card);
  return Math.max(base, away * 0.5);
}
// 留牌价值（正=值得留，负=是负担该甩）：score*(2*可玩性-1)
//   - 可玩性高（搭档还多）-> 正，留着能凑/能捞
//   - 可玩性低（搭档快没了，如 K 只剩 A）-> 负，留着只能重罚，该甩
// 罚牌代价 = -留牌价值（负担最便宜先罚）；补牌推力 = +留牌价值（负担最该推上桌）
function keepValue(card, state) { return card.score * (2 * playability(state, card) - 1); }

const HARD_REPLACE_W = 2; // 已并入 NPC_WEIGHTS.defenseW（2026-09-22）
// NPC 罚牌的点数倾斜：总代价 = 价格 − 0.06×点数。玩家洞见（2026-09-19）：别只赔眼前最便宜的，
// 大点数的牌凑14伙伴少（K 只能配 3），留着不如小牌值钱。校准台实测（配对发牌、先后手交替）：
//   medium 基座 N=1000：现状 51.7% → k=0.04 55.8% / k=0.06 56.4%（峰值）/ k=0.08 54.9% / k=0.30 48.5%（过头反害）。
//   hard   基座 N=1500：76.8% → k=0.04 77.1% / k=0.08 77.6%，持平略升。
// k=0.06 起正好复现玩家举的例子：方片4(0.25) 与 红桃K(0.75) 二选一时罚 K 留 4。
// 只对 NPC 生效；玩家侧基线（用于校准对比）保持"罚最便宜"不动。
const PENALTY_RANK_W = 0.06; // 已并入 NPC_WEIGHTS.playW（记牌可玩性替代点数代理，2026-09-22）

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
  const defenseW = (typeof w === 'number') ? w : (NPC_WEIGHTS ? NPC_WEIGHTS.defenseW : 2);
  const selfW = (NPC_WEIGHTS ? NPC_WEIGHTS.selfW : 2);
  const keepW = (NPC_WEIGHTS ? NPC_WEIGHTS.keepW : 1);
  const hk = handKey(who);
  const capIds = new Set(move.handCards.map((c) => c.id));
  const rest = state[hk].filter((c) => !capIds.has(c.id));
  if (!rest.length) return null;
  // 留牌价值的评估场面：先把出牌落地（桌面少一张、手牌 = rest），再把补牌位补满
  // （抽牌堆顺序确定），得到一个所有候选共享的场面。不用"出牌前"的旧场面：
  // 那时即将被拿走的手牌还在，会虚报出根本不成立的路线。
  const sceneBase = cloneState(state);
  capture(sceneBase, who, move);
  refillHandTo4(sceneBase, who);
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
      if (selfW > 0) {
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
      sum += oppGain - selfW * myGain;
    }
    const oppThreat = sum / K;
    const throwDesire = keepValue(c, sceneBase);
    const net = defenseW * oppThreat + keepW * throwDesire;
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
      // NPC 罚牌：代价 = 花色分 + playW×可玩性（可玩=贵、少罚；越"死"越便宜 → 先罚）。
      // 保留低花色分能立刻省分；但"还能不能再用上"（记牌）常常更重要：K 只剩 A 能配就先罚 K，别罚还能用的方片。
      let best = hand[0], bestC = Infinity;
      for (const c of hand) {
        const cost = c.score + NPC_WEIGHTS.playW * playability(state, c);
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
    replaceCardId = netReplaceId(state, who, chosen);
  } else if (diff === 'hell' && full) {
    // 地狱：高分候选各 rollout 到终局，挑终局净分差最高的。
    // 候选先按"同点数支配组"合并（只差花色的同点数走法等价，只留分值最高的"代表"），
    // 再把组内每张牌各自算出的补牌都拿给代表评一遍 —— 理由与实测边界见 dominanceGroups。
    // 好处：剪掉组内重复后，rollout 名额留给真正不同的路线（实测 38.7% 的决策里
    // top-4 有重复占位、平均浪费 0.53 个名额；定向探针里 hell 拿便宜同点数牌 20/400 → 0/400）。
    const groups = dominanceGroups(rankMoves(moves)).slice(0, 4);
    let best = null, bestV = -Infinity;
    for (const grp of groups) {
      for (const mv of grp.alts) {
        const rid = netReplaceId(state, who, mv);
        const v = evalMoveRollout(state, who, grp.rep, rid);
        if (v > bestV) { bestV = v; best = { mv: grp.rep, rid: rid }; }
      }
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

// 牌数守恒检查（调试用）。桌面可能临时留空位(null)，按真实牌数计，不把空槽算进去
function totalCards(state) {
  return (
    state.table.filter(Boolean).length + state.playerHand.length + state.npcHand.length +
    state.drawPile.length + state.playerLoot.length + state.npcLoot.length +
    state.playerPenalty.length + state.npcPenalty.length
  );
}

// ---------- 信息划分：哪些牌是"看得见的"，哪些是"未知的" ----------
// 评价"把牌补到桌面会不会被对手吃走"必须站在玩家的真实信息上算，不能偷看对手手牌。
//   可见（明牌）：桌面 6 张、我的手牌、我的战利品/罚牌、NPC 战利品（拿走时都是亮过的）
//   未知：NPC 手牌、NPC 罚牌（隐藏）、补牌堆
function visiblePool(state) {
  return state.table.filter(Boolean)
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
  validatePlayerSelection, rankMoves, pruneDominatedMoves, dominanceGroups, chooseAction, chooseNpcAction, totalCards,
  visiblePool, unknownPool, useRoutes, playability, keepValue, unseenOfRank, complementLeft,
  handKey, lootKey, penKey,
  DIFFICULTIES, BASE_DIFFICULTIES, HARD_REPLACE_W, PENALTY_RANK_W, DEFAULT_WEIGHTS, setNpcWeights, getNpcWeights, cloneState, opponentBestGain, netReplaceId, cheapestReplaceId,
  playOutGreedy, evalMoveRollout,
};
