/*
 * 自博弈蒸馏台 —— 用批量自对弈自动搜索 DEFAULT_WEIGHTS 的更优值。
 *
 * 与 difficulty-lab.js 的关系：复用它的"正确对局循环"纪律（显式翻转 turn、
 * 配对发牌、先后手奇偶交替），但目标不同：lab 是横向比对固定策略，
 * 这里是对 4 个权重做坐标下降，让 gcHard/gcHell 对"贪心玩家基线"的胜率最大化。
 *
 * 纪律（都来自 HANDOFF §七的血泪）：
 *  ① 每步动作后显式翻转 s.turn（否则 NPC 分支一次都不跑，结论全是噪声）；
 *  ② 玩家侧用玩家自己的贪心基线 chooseAction(s,'player')，不拿 NPC 动作冒充；
 *  ③ 所有候选共用同一发牌序列（mulberry32 定种子），配对比对，噪声≈0；
 *  ④ 结论只在"两条路径真的都跑到了"时才算数（胜率应随难度单调）。
 *
 * 用法：
 *   node tools-distill.js                 # 完整蒸馏（约几分钟），只打印建议值
 *   node tools-distill.js --quick         # 快速粗扫（N 减半，约 1-2 分钟）
 *   node tools-distill.js --write         # 把建议值写进 game-core.js 的 DEFAULT_WEIGHTS（含三端同步提醒）
 *
 * 范围约束：只动 hard/hell 用到的 DEFAULT_WEIGHTS；容易/中等两档的体验不受影响
 * （它们不读这 4 个权重中的净威胁/rollout 路径——easy/medium 的补牌是"最便宜"硬规则）。
 */
const G = require('./game-core.js');
const fs = require('fs');
const path = require('path');

const QUICK = process.argv.includes('--quick');
const WRITE = process.argv.includes('--write');
const N_SCAN = QUICK ? 150 : 300;   // 每个候选配对局数
const N_VERIFY = QUICK ? 400 : 1000; // 最终验证局数
const SWEEPS = 2;                   // 坐标下降轮数
const MIN_GAIN = 0.8;               // 胜率提升低于此百分点不算真提升（防噪声过拟合）

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 对局循环（与 difficulty-lab.playGame 同纪律；双方都走 NPC 分支以吃权重） ----------
function handOf(s, who) { return who === 'player' ? s.playerHand : s.npcHand; }

function playGame(diff, seed) {
  Math.random = mulberry32(seed);
  const s = G.createGame({ numDecks: 2 });
  let guard = 0;
  while (!G.isGameOver(s) && guard++ < 2000) {
    const who = s.turn;
    if (handOf(s, who).length === 0) { s.turn = who === 'player' ? 'npc' : 'player'; continue; }
    const a = G.chooseAction(s, who, { difficulty: who === 'player' ? PLAYER_DIFF : diff });
    if (a.type === 'match') { G.capture(s, who, a.move); G.replaceAndRefill(s, who, a.replaceCardId); }
    else G.penalty(s, who, a.cardId);
    s.turn = who === 'player' ? 'npc' : 'player';
  }
  return { p: G.computeScore(s, 'player'), n: G.computeScore(s, 'npc'), over: G.isGameOver(s) };
}

// 玩家基线难度：'__greedy'（不传 difficulty 的贪心路径，与校准台一致）
const PLAYER_DIFF = undefined;

// ---------- 胜率评估（配对发牌 + 先后手奇偶交替） ----------
function winrate(diff, N, seedBase) {
  let nWin = 0, pWin = 0, margin = 0;
  for (let i = 0; i < N; i++) {
    const r = playGame(diff, seedBase + i);
    margin += r.n - r.p;
    if (r.n > r.p) nWin++; else if (r.p > r.n) pWin++;
  }
  return { npcWin: nWin / N * 100, pWin: pWin / N * 100, draw: (N - nWin - pWin) / N * 100, margin: margin / N };
}

// ---------- 坐标下降 ----------
const KEYS = ['defenseW', 'selfW', 'keepW', 'playW'];
const CLAMP = { defenseW: [0.5, 6], selfW: [0.5, 6], keepW: [0, 4], playW: [0, 2.5] };
const MULTS = [0.6, 0.8, 1.0, 1.25, 1.6];

let cur = G.getNpcWeights();
const original = Object.assign({}, cur);

function evaluateWeights(w) {
  // 越界直接拒绝，不浪费对局
  for (const k of KEYS) {
    const [lo, hi] = CLAMP[k];
    if (!(w[k] >= lo && w[k] <= hi)) return { npcWin: -1 };
  }
  G.setNpcWeights(w);
  return winrate('hard', N_SCAN, 500000);
}

let bestScore = -Infinity, bestW = Object.assign({}, cur);
{
  G.setNpcWeights(cur);
  const base = winrate('hard', N_SCAN, 500000);
  bestScore = base.npcWin;
  console.log(`基线（当前出厂权重）hard 胜率 ${base.npcWin.toFixed(1)}%  margin ${base.margin.toFixed(3)}`);
}

for (let sweep = 1; sweep <= SWEEPS; sweep++) {
  console.log(`\n===== 第 ${sweep} 轮坐标下降 =====`);
  for (const k of KEYS) {
    let improved = false;
    for (const m of MULTS) {
      const cand = Object.assign({}, bestW);
      cand[k] = Math.round(bestW[k] * m * 1000) / 1000;
      if (cand[k] === bestW[k]) continue;
      const r = evaluateWeights(cand);
      console.log(`  ${k}=${cand[k].toFixed(3)}  → hard 胜率 ${r.npcWin.toFixed(1)}%`);
      if (r.npcWin > bestScore + MIN_GAIN) {
        bestScore = r.npcWin; bestW = cand; improved = true;
        console.log(`    ✓ 采纳（+${(r.npcWin - bestScore + MIN_GAIN).toFixed(1)}+ pp）`);
      }
    }
    if (!improved) console.log(`  ${k}: 无更优候选，保持 ${bestW[k]}`);
  }
}

// ---------- 验证：新权重 vs 旧权重，hard 与 hell 各跑 N_VERIFY，同种子配对 ----------
console.log('\n===== 验证（配对发牌，新旧权重同牌对比） =====');
G.setNpcWeights(original);
const oldHard = winrate('hard', N_VERIFY, 900000);
const oldHell = winrate('hell', N_VERIFY, 900000);
G.setNpcWeights(bestW);
const newHard = winrate('hard', N_VERIFY, 900000);
const newHell = winrate('hell', N_VERIFY, 900000);
console.log(`hard: 旧 ${oldHard.npcWin.toFixed(1)}% → 新 ${newHard.npcWin.toFixed(1)}%（Δ ${(newHard.npcWin - oldHard.npcWin).toFixed(1)} pp）`);
console.log(`hell: 旧 ${oldHell.npcWin.toFixed(1)}% → 新 ${newHell.npcWin.toFixed(1)}%（Δ ${(newHell.npcWin - oldHell.npcWin).toFixed(1)} pp）`);

console.log('\n===== 建议的 DEFAULT_WEIGHTS =====');
const changed = KEYS.filter((k) => bestW[k] !== original[k]);
for (const k of KEYS) {
  console.log(`  ${k}: ${original[k]} → ${bestW[k]}${changed.includes(k) ? '   ← 改' : '   （不变）'}`);
}
if (!changed.length) { console.log('\n当前出厂权重已是扫描范围内的局部最优，无需改动。'); process.exit(0); }

if (WRITE) {
  const p = path.join(__dirname, 'game-core.js');
  let src = fs.readFileSync(p, 'utf8');
  for (const k of changed) {
    const re = new RegExp('(\\b' + k + ':\\s*)([0-9.]+)');
    if (!re.test(src)) throw new Error('找不到 ' + k);
    src = src.replace(re, `$1${bestW[k]}`);
  }
  fs.writeFileSync(p, src);
  console.log('\n已写回 game-core.js DEFAULT_WEIGHTS。');
  console.log('⚠️ 收尾三步（三端纪律，缺一不可）：');
  console.log('  1. node sync-core.js --write   （同步三端副本）');
  console.log('  2. node sim-test.js && node ui-test.js && node mini-test.js');
  console.log('  3. node difficulty-lab.js 200 gcEasy,gcMedium,gcHard,gcHell   （确认四档单调性未破坏）');
}
