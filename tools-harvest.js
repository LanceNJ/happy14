#!/usr/bin/env node
/*
 * 真人收割 tools-harvest.js —— 把玩家 🧠 面板导出的"学习权重"回流成出厂 DEFAULT_WEIGHTS 的候选。
 *
 * 单机版"NPC 持续变强"闭环的一环（离线闭环，零服务器）：
 *   玩家玩（难/地狱）→ 权重漂移 → 🧠 面板「导出权重」存 JSON（一人一个文件）
 *   → node tools-harvest.js p1.json p2.json p3.json …
 *   → 逐键中位数 → 与出厂权重做 hard+hell 配对验证
 *   → 通过才 --write 进根 game-core.js → 三端同步 + 全量回归 → 部署后所有用户起点抬升。
 *
 * 纪律（与 tools-distill.js 同源，别绕）：
 *   ① 候选必须过配对验证：hard/hell 各 N 局（默认 1000，--quick 300 仅冒烟），
 *      任一档比出厂差超 0.5pp 噪声带 = 拒写；两档都不差且至少一档好 ≥0.5pp 才算"真改进"。
 *   ② 聚合用中位数：单人导出是小样本在线学习，一个漂移过头的用户不能带偏全体。
 *   ③ 样本地板：贡献用户 ≥3，否则只出报告不出候选。
 *   ④ 写回只动根 game-core.js 的 DEFAULT_WEIGHTS；三端同步 + 回归是收尾三步，缺一不可。
 *   ⑤ 只读 4 权重（defenseW/selfW/keepW/playW），不碰结构参数（rollout 抽样/剪枝是另一轮的事）。
 */
const G = require('./game-core.js');
const fs = require('fs');
const path = require('path');

const QUICK = process.argv.includes('--quick');
const WRITE = process.argv.includes('--write');
const N = QUICK ? 300 : 1000;
const MIN_USERS = 3;
const SEED_BASE = 900000;                    // 与 distill 同种子带，结论可比
const KEYS = ['defenseW', 'selfW', 'keepW', 'playW'];
const CLAMP = { defenseW: [0.5, 6], selfW: [0.5, 6], keepW: [0, 4], playW: [0, 2.5] };

function userFiles() {
  return process.argv.slice(2).filter((a) => !a.startsWith('--'));
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function median(nums) {
  const s = nums.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---------- 读玩家导出（🧠 面板「导出权重」的 JSON；一人一个文件） ----------
function readUsers(files) {
  const users = [];
  for (const f of files) {
    let o;
    try { o = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { console.error('读/解析失败 ' + f + '：' + e.message); continue; }
    if (!o || o.v !== 1) { console.error(f + '：不是 v1 学习权重导出（v=' + (o && o.v) + '），跳过'); continue; }
    const w = o.weights && Object.keys(o.weights).length ? o.weights : null;
    const wins = o.stats ? (o.stats.hard ? o.stats.hard.w + (o.stats.hell ? o.stats.hell.w : 0) : 0) : 0;
    users.push({ file: f, weights: w, drift: o.drift || 0, reviewed: o.reviewed || 0, wins });
  }
  return users;
}

// ---------- 配对胜率（玩家侧固定贪心基线；同种子 = 同一副牌） ----------
function handOf(s, who) { return who === 'player' ? s.playerHand : s.npcHand; }
function winrate(weights, diff, n, seedBase) {
  G.setNpcWeights(weights);
  let win = 0;
  for (let i = 0; i < n; i++) {
    Math.random = mulberry32(seedBase + i);
    const s = G.createGame({ numDecks: 2 });
    let guard = 0;
    while (!G.isGameOver(s) && guard++ < 2000) {
      const who = s.turn;
      if (handOf(s, who).length === 0) { s.turn = who === 'player' ? 'npc' : 'player'; continue; }
      const a = G.chooseAction(s, who, { difficulty: who === 'player' ? undefined : diff });
      if (a.type === 'match') { G.capture(s, who, a.move); G.replaceAndRefill(s, who, a.replaceCardId); }
      else G.penalty(s, who, a.cardId);
      s.turn = who === 'player' ? 'npc' : 'player';
    }
    if (G.computeScore(s, 'npc') > G.computeScore(s, 'player')) win++;
  }
  return win / n * 100;
}

// ---------- 主流程 ----------
const files = userFiles();
if (!files.length) {
  console.log('用法：node tools-harvest.js 玩家1.json 玩家2.json … [--quick] [--write]');
  console.log('每个文件 = 一位玩家 🧠 面板「导出权重」的 JSON（一人一个文件）。');
  console.log('  --quick   验证降为 300 局/档（冒烟用；写盘结论必须默认 1000 局）');
  console.log('  --write   验证通过后写进根 game-core.js 的 DEFAULT_WEIGHTS');
  process.exit(1);
}

const users = readUsers(files);
console.log('=== 导出清单 ===');
users.forEach((u) => console.log('  ' + u.file + '  · 调参 ' + u.drift + ' 次 · 复盘 ' + u.reviewed + ' 局 · 累计赢 ' + u.wins + ' 局  ' + (u.weights ? JSON.stringify(u.weights) : '[weights=null：没调过参，只有战绩]')));

const contrib = users.filter((u) => u.weights && KEYS.some((k) => typeof u.weights[k] === 'number'));
console.log('\n贡献用户：' + contrib.length + (contrib.length < MIN_USERS ? '（< ' + MIN_USERS + '，样本不足——只出报告，不出候选）' : ''));
if (contrib.length < MIN_USERS) {
  console.log('等更多玩家导出攒够 ' + MIN_USERS + ' 份再跑一次。');
  process.exit(0);
}

// 逐键中位数（贡献该键的人里取中位；钳制防飞）
const base = G.getNpcWeights();
const candidate = Object.assign({}, base);
console.log('\n=== 候选权重（逐键中位数） ===');
let changed = false;
for (const k of KEYS) {
  const vals = users.filter((u) => typeof (u.weights || {})[k] === 'number').map((u) => u.weights[k]);
  if (!vals.length) { console.log('  ' + k + '：无人调过 → 保持出厂 ' + candidate[k]); continue; }
  const v = Math.round(Math.max(CLAMP[k][0], Math.min(CLAMP[k][1], median(vals))) * 1000) / 1000;
  console.log('  ' + k + '：出厂 ' + base[k] + ' → ' + v + '（' + vals.length + ' 人：' + vals.join(', ') + (vals.length === 1 ? ' · 仅 1 人，噪声风险高' : '') + '）');
  if (v !== candidate[k]) changed = true;
  candidate[k] = v;
}
if (!changed) { console.log('\n候选 = 出厂权重，无事可做。'); process.exit(0); }

// 配对验证
console.log('\n=== 配对验证（N=' + N + '/档，同种子；玩家侧=贪心基线）===');
const bh = winrate(base, 'hard', N, SEED_BASE);
const bl = winrate(base, 'hell', N, SEED_BASE);
const ch = winrate(candidate, 'hard', N, SEED_BASE);
const cl = winrate(candidate, 'hell', N, SEED_BASE);
const dh = ch - bh, dl = cl - bl;
const fmt = (d) => (d >= 0 ? '+' : '') + d.toFixed(1) + ' pp';
console.log('hard: 出厂 ' + bh.toFixed(1) + '% → 候选 ' + ch.toFixed(1) + '%（' + fmt(dh) + '）');
console.log('hell: 出厂 ' + bl.toFixed(1) + '% → 候选 ' + cl.toFixed(1) + '%（' + fmt(dl) + '）');
const noRegression = dh > -0.5 && dl > -0.5;
const improved = dh >= 0.5 || dl >= 0.5;
console.log(noRegression ? '无回归 ✓（两档都不差超 0.5pp 噪声带）' : '⚠️ 有回归（某档差超 0.5pp 噪声带）');
console.log(improved ? '有实质提升 ✓（至少一档好 ≥0.5pp）' : '无实质提升（都在 0.5pp 噪声带内）');

if (!noRegression || !improved) {
  console.log('\n结论：保持出厂，不写盘。' + (QUICK ? '（--quick 冒烟结果不算数，攒够样本用默认 1000 局重验）' : ''));
  process.exit(0);
}

console.log('\n建议写盘：' + JSON.stringify(candidate));
if (!WRITE) { console.log('确认无误后加 --write（默认 1000 局验证过才建议）。'); process.exit(0); }

// 写回根 game-core.js（只改 DEFAULT_WEIGHTS 字面量；三端副本靠 sync-core）
const p = path.join(__dirname, 'game-core.js');
let src = fs.readFileSync(p, 'utf8');
for (const k of KEYS) {
  const re = new RegExp('(\\b' + k + ':\\s*)([0-9.]+)');
  if (!re.test(src)) throw new Error('game-core.js 找不到 ' + k + ' 字面量');
  src = src.replace(re, '$1' + candidate[k]);
}
fs.writeFileSync(p, src);
console.log('\n✅ 已写回 game-core.js DEFAULT_WEIGHTS。');
console.log('收尾三步（三端纪律，缺一不可）：');
console.log('  1. node sync-core.js --write     （同步三端副本并复校 MD5）');
console.log('  2. node sim-test.js && node ui-test.js && node mini-test.js && node mobile-test.js');
console.log('  3. node difficulty-lab.js 200 gcEasy,gcMedium,gcHard,gcHell   （确认四档单调性未破坏）');
console.log('  4. node tools-standalone.js && 部署 site-mobile/index.html');
