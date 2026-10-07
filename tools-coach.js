#!/usr/bin/env node
/*
 * 复盘教练 · 离线弱点报告 —— 读手机版导出的复盘 JSON，聚合成"你最近常在哪几步丢分"。
 *
 * 用法：
 *   1. 手机/网页版结算层点「导出复盘记录」→ 复制 JSON，存成 game.json
 *   2. node tools-coach.js game.json            （可传多个文件，自动合并）
 *      node tools-coach.js a.json b.json --out 弱点报告.md   （额外落盘 markdown）
 *
 * 设计边界（刻意选的）：
 *   · 逐点判定已在浏览器端算好并存进 JSON（gap = 最优走法比你这步高多少分），
 *     本脚本纯聚合、不 import 引擎、不重放棋面 → 任何机器、没装依赖都能跑。
 *   · 代价：离线端不能重算验证某条 gap。要交叉验证，把导出的 handIds/tableId 喂给
 *     difficulty-lab 的重放管线（那是 distill 工具的活）。
 *
 * 口径：
 *   · 每条 miss 的 gap≥0.5 才算"明显丢分"（浏览器端已过滤，这里再兜底一次）；
 *   · 难度越高（hell）同一手丢分越"值钱"——趋势图按难度分桶，别把 easy 的局和 hell 混着算改善。
 */
const fs = require('fs');
const path = require('path');

const MIN_GAP = 0.5;
const AXIS = { play: '出牌', replace: '补牌', penalty: '罚牌' };

// ---------- 收集：顶层可以是对象（取 .games）或数组；多文件合并 ----------
function collect(files) {
  const games = [];
  for (const f of files) {
    let raw;
    try { raw = fs.readFileSync(f, 'utf8'); } catch (e) { console.error('读不到 ' + f + '：' + e.message); continue; }
    let o;
    try { o = JSON.parse(raw); } catch (e) { console.error('解析 ' + f + ' 失败：' + e.message); continue; }
    let arr = Array.isArray(o) ? o : (Array.isArray(o.games) ? o.games : []);
    if (!arr.length) { console.warn('  ' + f + ' 里没有复盘记录'); continue; }
    for (const g of arr) if (g && g.misses) games.push(g);
  }
  return games;
}

// ---------- 聚合 ----------
function analyze(games) {
  const byAxis = { play: { n: 0, gapSum: 0 }, replace: { n: 0, gapSum: 0 }, penalty: { n: 0, gapSum: 0 } };
  const cause = { fed: 0, routed: 0, none: 0 };
  const byDiff = {};   // diff -> { games, win, loss, draw, missTotal }
  const byDay = {};    // YYYY-MM-DD -> { missTotal, gapSum }
  let totalMiss = 0, totalGap = 0, worst = null;
  for (const g of games) {
    const d = g.result === 'win' ? 'win' : g.result === 'loss' ? 'loss' : 'draw';
    const dd = byDiff[g.diff] || (byDiff[g.diff] = { games: 0, win: 0, loss: 0, draw: 0, missTotal: 0 });
    dd.games++; dd[d]++;
    const day = (g.ts || '').slice(0, 10);
    const dd2 = byDay[day] || (byDay[day] = { missTotal: 0, gapSum: 0 });
    for (const m of (g.misses || [])) {
      if (typeof m.gap !== 'number' || m.gap < MIN_GAP) continue;
      totalMiss++; totalGap += m.gap;
      dd.missTotal++; dd2.missTotal++; dd2.gapSum += m.gap;
      const ax = byAxis[m.axis] || (byAxis[m.axis] = { n: 0, gapSum: 0 });
      ax.n++; ax.gapSum += m.gap;
      if (m.axis === 'replace') {
        if (m.cause === 'fed') cause.fed++; else if (m.cause === 'routed') cause.routed++; else cause.none++;
      }
      if (!worst || m.gap > worst.gap) worst = { diff: g.diff, gap: m.gap, axis: m.axis, ts: g.ts };
    }
  }
  return { games, totalMiss, totalGap, byAxis, cause, byDiff, byDay, worst, avgGap: totalMiss ? totalGap / totalMiss : 0 };
}

// ---------- 报告 ----------
function render(r) {
  const L = [];
  const pct = (a, b) => (b ? Math.round(a / b * 100) + '%' : '—');
  L.push('# 欢乐十四分 · 复盘教练弱点报告');
  L.push('');
  L.push('共 **' + r.games.length + '** 局 · 明显丢分 **' + r.totalMiss + '** 处 · 平均单步丢 **' + r.avgGap.toFixed(2) + ' 分**');
  L.push('');
  // 难度分布
  L.push('## 各难度战绩');
  L.push('');
  L.push('| 难度 | 局数 | 胜/负/平 | 明显丢分数 |');
  L.push('| --- | --- | --- | --- |');
  for (const d of ['easy', 'medium', 'hard', 'hell']) {
    if (!r.byDiff[d]) continue;
    const x = r.byDiff[d];
    L.push('| ' + d + ' | ' + x.games + ' | ' + x.win + '/' + x.loss + '/' + x.draw + ' | ' + x.missTotal + ' |');
  }
  L.push('');
  // 轴（在哪类动作上丢分最多）
  L.push('## 哪类动作最常丢分');
  L.push('');
  const axisSorted = Object.entries(r.byAxis).filter(([, v]) => v.n).sort((a, b) => b[1].n - a[1].n);
  for (const [k, v] of axisSorted) {
    L.push('- **' + AXIS[k] + '（' + k + '）**：' + v.n + ' 处，占 ' + pct(v.n, r.totalMiss) + '，单步平均丢 ' + (v.gapSum / v.n).toFixed(2) + ' 分');
  }
  L.push('');
  // 补牌败因
  if (r.cause.fed + r.cause.routed) {
    L.push('## 补牌失误的败因');
    L.push('');
    L.push('- **资敌**（补的牌喂对手凑 14）：' + r.cause.fed + ' 处 · ' + pct(r.cause.fed, r.cause.fed + r.cause.routed));
    L.push('- **失后路**（没给自己留抓手）：' + r.cause.routed + ' 处 · ' + pct(r.cause.routed, r.cause.fed + r.cause.routed));
    L.push('');
  }
  // 时间趋势
  const days = Object.keys(r.byDay).sort();
  if (days.length > 1) {
    L.push('## 丢分趋势（按天）');
    L.push('');
    L.push('| 日期 | 明显丢分数 | 平均单步丢分 |');
    L.push('| --- | --- | --- |');
    for (const day of days) {
      const v = r.byDay[day];
      L.push('| ' + day + ' | ' + v.missTotal + ' | ' + (v.missTotal ? (v.gapSum / v.missTotal).toFixed(2) : '0') + ' |');
    }
    L.push('');
  }
  // 最大单步
  if (r.worst) {
    L.push('## 最大单步丢分');
    L.push('');
    L.push('- **' + r.worst.gap.toFixed(2) + ' 分**（' + (AXIS[r.worst.axis] || r.worst.axis) + '，难度 ' + r.worst.diff + '，' + (r.worst.ts || '').slice(0, 16) + '）');
    L.push('');
  }
  return L.join('\n');
}

// ---------- 主流程 ----------
const args = process.argv.slice(2);
const outFlag = args.indexOf('--out');
const outFile = outFlag >= 0 ? args[outFlag + 1] : null;
const files = args.filter((a) => !a.startsWith('--') && a !== outFile);
if (!files.length) {
  console.log('用法：node tools-coach.js <复盘json> [更多json …] [--out 报告.md]');
  console.log('先在手机/网页结算层点「导出复盘记录」，把 JSON 存成文件再喂进来。');
  process.exit(1);
}
const games = collect(files);
if (!games.length) { console.error('没有可用的复盘记录'); process.exit(1); }
const report = render(analyze(games));
console.log(report);
if (outFile) { fs.writeFileSync(path.resolve(outFile), report + '\n'); console.log('\n已写入 ' + path.resolve(outFile)); }
