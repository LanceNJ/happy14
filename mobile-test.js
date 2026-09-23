// 手机版真跑测试（Playwright 无头 Chromium，跑真实浏览器、真实构建产物）：
//  A. 难度只剩四档（无「自适应」按钮）；B. 学习系统：按档位分别注入权重、只学赢局、可导出/重置、面板可开；
//  C. 整局真打一遍（自动玩家直调控制器动作函数 + 把演出拍子压到最短），零 pageerror / 零 console error，结算层按难度给出学习说明。
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const D = __dirname;
const CAND = [path.join(D, 'site-mobile/index.html'), path.join(D, '欢乐十四分-手机版.html')];
const target = CAND.find((p) => fs.existsSync(p));
if (!target) { console.error('找不到构建产物：site-mobile/index.html 或 欢乐十四分-手机版.html'); process.exit(2); }

let fails = 0;
function ck(name, got, want) {
  const ok = (typeof want === 'function') ? want(got) : (got === want);
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok ? '' : '   实际=' + JSON.stringify(got) + ' 期望=' + JSON.stringify(String(want))));
  if (!ok) fails++;
}

(async () => {
  const errors = [];
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, permissions: ['clipboard-read', 'clipboard-write'] });
  page.setDefaultTimeout(20000);   // 不许 30s 静默等待：点不中就是错，不是慢
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/jsdelivr|Failed to load resource|net::|ERR_/.test(t)) return;   // 云计数/CDN 网络问题不算
    errors.push('CONSOLE: ' + t);
  });
  await page.goto('file:///' + target.replace(/\\/g, '/'), { waitUntil: 'load' });
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });

  console.log('\n== A. 难度只剩四档 ==');
  const btns = await page.evaluate(() => Array.from(document.querySelectorAll('.diff-btn')).map((b) => b.getAttribute('data-diff')));
  ck('页面里没有 adaptive 按钮', btns.indexOf('adaptive'), -1);
  const diffN = await page.evaluate(() => G.DIFFICULTIES.length);
  ck('内核 DIFFICULTIES = 4 档', diffN, 4);
  ck('🧠 学习入口按钮存在', await page.locator('#learnBtn').count(), 1);

  console.log('\n== B. 学习系统机制 ==');
  const mech = await page.evaluate(() => {
    const out = {};
    const def = Object.assign({}, G.DEFAULT_WEIGHTS);
    out.defKeep = def.keepW;
    learned.weights = { defenseW: 2, selfW: 2, keepW: def.keepW + 1.5, playW: 1.4 };
    applyLearnWeights('easy'); out.easy = G.getNpcWeights().keepW;
    applyLearnWeights('medium'); out.medium = G.getNpcWeights().keepW;
    applyLearnWeights('hard'); out.hard = G.getNpcWeights().keepW;
    applyLearnWeights('hell'); out.hell = G.getNpcWeights().keepW;
    out.iEasy = learnIntensity('easy'); out.iHard = learnIntensity('hard'); out.iHell = learnIntensity('hell');
    // 只学赢局：输局不得改权重
    learned = { v: 1, weights: null, stats: { hard: { w: 0, l: 0 }, hell: { w: 0, l: 0 } }, reviewed: 0, holes: { play: 0, rep: 0, pen: 0 }, drift: 0, log: [] };
    npcDifficulty = 'hell';
    decideLog = [];
    const noteLose = runLearn(1, 9);
    out.loseWeights = learned.weights;
    out.loseW = learned.stats.hell.l;
    const noteWinEmpty = runLearn(9, 1);
    out.winEmptyWeights = learned.weights;
    out.winW = learned.stats.hell.w;
    out.noteLose = noteLose; out.noteWinEmpty = noteWinEmpty;
    // 导出 / 重置
    learned.weights = { defenseW: 2, selfW: 2, keepW: 2.5, playW: 1.4 };
    const json = exportLearn();
    out.exportOK = (function () { try { const o = JSON.parse(json); return !!(o.weights && o.defaultWeights && o.stats); } catch (e) { return false; } })();
    resetLearn();
    out.afterResetWeights = learned.weights;
    out.afterResetKeep = G.getNpcWeights().keepW;
    npcDifficulty = 'medium'; applyLearnWeights('medium');
    return out;
  });
  ck('易/中 = 出厂权重（不学习）', mech.easy === mech.defKeep && mech.medium === mech.defKeep, true);
  ck('难 = 出厂与学习值的中点（吃一半）', Math.abs(mech.hard - (mech.defKeep + mech.defKeep + 1.5) / 2) < 1e-9, true);
  ck('地狱 = 全量学习值', Math.abs(mech.hell - (mech.defKeep + 1.5)) < 1e-9, true);
  ck('学习强度 易0 / 难0.5 / 地狱1', mech.iEasy === 0 && mech.iHard === 0.5 && mech.iHell === 1, true);
  ck('输局不改权重', mech.loseWeights, null);
  ck('输局记账（战绩 l+1）', mech.loseW, 1);
  ck('赢局但无决策可复盘 → 仍不改权重', mech.winEmptyWeights, null);
  ck('赢局记账（战绩 w+1）', mech.winW, 1);
  ck('输局提示"只学你赢的局"', mech.noteLose.indexOf('只学你赢的局') >= 0, true);
  ck('导出 JSON 结构完整', mech.exportOK, true);
  ck('重置后权重 = 空（回出厂）', mech.afterResetWeights === null && mech.afterResetKeep === mech.defKeep, true);

  console.log('\n== C. 面板可开 + 整局真打 ==');
  // 先离开开始画面（头部按钮被它盖着），再进难度询问层
  if (await page.isVisible('#startScreen').catch(() => false)) await page.click('#startGo');
  if (await page.isVisible('#helpModal').catch(() => false)) await page.click('#helpClose');
  if (await page.isVisible('#diffModal').catch(() => false)) {
    const askBtns = await page.evaluate(() => Array.from(document.querySelectorAll('#askDiffSeg .diff-btn')).map((b) => b.getAttribute('data-diff')));
    ck('询问层也是四档（无 adaptive）', askBtns.length === 4 && askBtns.indexOf('adaptive') < 0, true);
    await page.click('#askDiffSeg .diff-btn[data-diff="hell"]');
    await page.click('#askDiffGo');
  }
  const armed = await page.evaluate(() => npcDifficulty);
  ck('开局难度已设为地狱', armed, 'hell');

  // 首玩会自动弹玩法说明，先把挡在前面的浮层收掉
  const clearModals = async () => {
    for (const [sel, btn] of [['#helpModal', '#helpClose'], ['#restartModal', '#restartCancel']]) {
      if (await page.isVisible(sel).catch(() => false)) await page.click(btn).catch(() => {});
    }
  };
  await page.waitForTimeout(400);
  await clearModals();

  await page.click('#learnBtn');
  const panel = await page.evaluate(() => {
    const m = document.getElementById('learnModal');
    return { open: !m.classList.contains('hidden'), txt: document.getElementById('learnBody').textContent };
  });
  ck('学习面板能打开', panel.open, true);
  ck('面板写出战绩与权重来源', panel.txt.indexOf('战绩') >= 0 && panel.txt.indexOf('出厂') >= 0, true);
  await page.click('#learnExport');
  const exported = await page.evaluate(() => {
    const ta = document.getElementById('learnOut');
    return { shown: ta.classList.contains('show'), json: ta.value };
  });
  ck('导出按钮把 JSON 填进文本框', exported.shown && exported.json.indexOf('"weights"') >= 0, true);
  await page.click('#learnClose');

  // 把演出拍子压到最短：after 是顶层函数声明（等价于 window.after），只改节奏、不改规则与判据。
  // 不这么做的话，每回合的 NPC 五拍演出要 4 秒多，一整局光动画就要好几分钟。
  await page.evaluate(() => { window.after = (ms, fn) => setTimeout(fn, Math.min(ms, 8)); });

  // 自动玩家：直接走控制器自己的动作函数（confirmMatch / doPenalty / onHandClick），
  // 不用 Playwright 的 click —— 后者遇到 disabled 按钮会静默等 30 秒，一局能拖十几分钟。
  const game = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    let guard = 0, merged = 0, pen = 0, stall = 0, lastSig = '';
    while (state.phase !== 'gameover' && guard++ < 2400) {
      const sig = state.turn + '|' + ui.mode + '|' + state.playerHand.length + '|' + state.npcHand.length + '|' + state.table.length;
      if (sig === lastSig) stall++; else { stall = 0; lastSig = sig; }
      if (stall > 400) break;                                     // 真卡住了就退出，别把测试拖死
      if (state.turn === 'player' && ui.mode === 'select') {
        const moves = G.findMoves(state.playerHand, state.table);
        if (moves.length) {
          const mv = moves[0];
          ui.selHand = mv.handCards.map((c) => c.id);
          ui.selTable = mv.tableCard.id;
          ui.valid = true;
          confirmMatch(); merged++;
        } else if (state.playerHand.length) {
          ui.selHand = [state.playerHand[0].id];
          doPenalty(); pen++;
        }
        await wait(30);
      } else if (state.turn === 'player' && ui.mode === 'replace') {
        const j = A ? A.judgeReplace(state.playerHand, state.table, [], null, { unknown: G.unknownPool(state), oppHandSize: state.npcHand.length }) : null;
        const sug = (j && j.suggest) || null;
        const card = (sug && (sug.card || state.playerHand.find((c) => c.id === sug.cardId))) || state.playerHand[0];
        onHandClick(card);
        await wait(30);
      } else {
        await wait(25);
      }
    }
    return {
      phase: state.phase, guard, merged, pen, stall,
      over: !document.getElementById('overModal').classList.contains('hidden'),
      ps: G.computeScore(state, 'player'), ns: G.computeScore(state, 'npc'),
    };
  });
  const afterGame = await page.evaluate(() => ({
    hasLearnKey: !!localStorage.getItem('h14_learn_v1'),
    stored: (function () { try { return JSON.parse(localStorage.getItem('h14_learn_v1') || '{}'); } catch (e) { return {}; } })(),
    overTxt: document.getElementById('overBody').textContent,
  }));
  console.log('   （整局真打：合牌 ' + game.merged + ' 手 · 罚牌 ' + game.pen + ' 手 · 比分 ' + game.ps.toFixed(2) + ' : ' + game.ns.toFixed(2) + '）');
  ck('整局能打完（结算层出现）', game.phase === 'gameover' && game.over, true);
  ck('真打：玩家至少合过 1 手牌', game.merged > 0, true);
  ck('学习记录已落盘（localStorage）', afterGame.hasLearnKey, true);
  const rec = (afterGame.stored.stats && afterGame.stored.stats.hell) || { w: 0, l: 0 };
  const decisive = game.ps !== game.ns;
  ck('战绩与比分一致（胜/负计 1，平计 0）', rec.w + rec.l, decisive ? 1 : 0);
  ck('结算层按难度给出学习说明', afterGame.overTxt.indexOf('🧠') >= 0, true);
  ck('零 pageerror / console error', errors.length, 0);
  if (errors.length) console.log('   ' + errors.join('\n   '));

  await browser.close();
  console.log(fails === 0 ? '\nMOBILE_TEST_OK' : '\nMOBILE_TEST_FAIL（' + fails + ' 项）');
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('TEST_CRASH', e); process.exit(2); });
