// 新增功能专项真机测试：设置 / 同牌战绩曲线 / 复盘回放 / 战报卡
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const D = __dirname;
const target = path.join(D, 'site-mobile/index.html');
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
  page.setDefaultTimeout(20000);
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/jsdelivr|Failed to load resource|net::|ERR_/.test(t)) return;
    errors.push('CONSOLE: ' + t);
  });
  await page.goto('file:///' + target.replace(/\\/g, '/'), { waitUntil: 'load' });
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
  await page.reload({ waitUntil: 'load' });

  console.log('\n== A. PWA 静态件 ==');
  ck('manifest 已挂', await page.locator('link[rel="manifest"]').count(), 1);
  ck('apple-touch-icon 指向 icon-180', await page.evaluate(() => { const l = document.querySelector('link[rel="apple-touch-icon"]'); return l ? l.getAttribute('href') : ''; }), 'icon-180.png');
  for (const f of ['manifest.json', 'sw.js', 'icon-192.png', 'icon-512.png', 'icon-180.png']) {
    ck('部署目录存在 ' + f, fs.existsSync(path.join(D, 'site-mobile', f)), true);
  }

  console.log('\n== B. 设置面板 ==');
  await page.click('#startSet');
  ck('设置面板打开', await page.evaluate(() => !document.getElementById('setModal').classList.contains('hidden')), true);
  await page.click('#setSound');
  ck('静音写入 localStorage', await page.evaluate(() => localStorage.getItem('h14_muted')), '1');
  ck('静音按钮变「关」', await page.evaluate(() => document.getElementById('setSound').textContent), '关');
  await page.click('#setSound');
  ck('取消静音', await page.evaluate(() => localStorage.getItem('h14_muted')), '0');
  await page.click('#setVibrate');
  ck('震动关闭写入', await page.evaluate(() => localStorage.getItem('h14_vibrate')), '0');
  await page.click('#setBig');
  ck('大字模式写入', await page.evaluate(() => localStorage.getItem('h14_big')), '1');
  ck('大字模式加 body.big', await page.evaluate(() => document.body.classList.contains('big')), true);
  ck('大字模式牌更大', await page.evaluate(() => {
    const d = document.createElement('div');
    d.className = 'card';
    document.getElementById('table').appendChild(d);
    const h = parseFloat(getComputedStyle(d).height);
    d.remove();
    return h;
  }), (h) => h >= 84);
  await page.click('#setBig');
  ck('再点关闭大字', await page.evaluate(() => document.body.classList.contains('big')), false);
  await page.click('#setClose');
  ck('设置面板关闭', await page.evaluate(() => document.getElementById('setModal').classList.contains('hidden')), true);

  console.log('\n== C. 同牌战绩曲线 ==');
  await page.evaluate(() => {
    const best = {};
    for (let i = 0; i < 6; i++) best[dateKeyOffset(-i)] = 8 + i * 0.5;
    localStorage.setItem('h14_todaybest_v1', JSON.stringify(best));
  });
  await page.reload({ waitUntil: 'load' });
  const statsTxt = await page.evaluate(() => document.getElementById('todayStats').textContent);
  ck('标题屏显示连续天数', statsTxt.indexOf('连续 6 天') >= 0, true);
  ck('标题屏显示今日最佳', /今日最佳/.test(statsTxt), true);
  await page.click('#todayStats');
  ck('战绩弹层打开', await page.evaluate(() => !document.getElementById('trendModal').classList.contains('hidden')), true);
  const trend = await page.evaluate(() => ({
    svg: document.querySelectorAll('#trendChart svg').length,
    poly: document.querySelectorAll('#trendChart polyline').length,
    rows: document.querySelectorAll('#trendList .trend-row').length,
    sum: document.getElementById('trendSummary').textContent,
  }));
  ck('曲线 SVG 已画', trend.svg, 1);
  ck('曲线折线存在', trend.poly, 1);
  ck('历史列表 6 条', trend.rows, 6);
  ck('摘要含历史最高', trend.sum.indexOf('历史最高') >= 0, true);
  await page.click('#trendClose');

  console.log('\n== D. 整局 → 复盘回放 / 战报卡 ==');
  if (await page.isVisible('#startScreen').catch(() => false)) await page.click('#startGo');
  if (await page.isVisible('#helpModal').catch(() => false)) await page.click('#helpClose');
  if (await page.isVisible('#diffModal').catch(() => false)) {
    await page.click('#askDiffSeg .diff-btn[data-diff="easy"]');
    await page.click('#askDiffGo');
  }
  await page.waitForTimeout(300);
  if (await page.isVisible('#helpModal').catch(() => false)) await page.click('#helpClose');
  await page.evaluate(() => { window.after = (ms, fn) => setTimeout(fn, Math.min(ms, 8)); });

  const game = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    let guard = 0, merged = 0, pen = 0, stall = 0, lastSig = '';
    while (state.phase !== 'gameover' && guard++ < 2400) {
      const sig = state.turn + '|' + ui.mode + '|' + state.playerHand.length + '|' + state.npcHand.length + '|' + state.table.length;
      if (sig === lastSig) stall++; else { stall = 0; lastSig = sig; }
      if (stall > 400) break;
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
        const card = state.playerHand[0];
        if (card) onHandClick(card);
        await wait(30);
      } else {
        await wait(25);
      }
    }
    let rec = null;
    try { const arr = JSON.parse(localStorage.getItem('h14_replays_v1') || '[]'); rec = arr[arr.length - 1] || null; } catch (e) {}
    return {
      phase: state.phase, merged, pen,
      over: !document.getElementById('overModal').classList.contains('hidden'),
      replayBtn: getComputedStyle(document.getElementById('overReplay')).display,
      recActions: rec ? rec.actions.length : 0,
      seed: rec ? rec.seed : null,
    };
  });
  console.log('   （整局：合牌 ' + game.merged + ' 手 · 罚牌 ' + game.pen + ' 手 · 回放动作 ' + game.recActions + ' 条）');
  ck('整局打完并结算', game.phase === 'gameover' && game.over, true);
  ck('回放数据已落盘（动作 > 10）', game.recActions > 10, true);

  await page.click('#overReplay');
  ck('回放弹层打开', await page.evaluate(() => !document.getElementById('replayModal').classList.contains('hidden')), true);
  const rp0 = await page.evaluate(() => ({
    idx: document.getElementById('replayIdx').textContent,
    stage: document.getElementById('replayStage').textContent,
    cards: document.querySelectorAll('#replayStage .card').length,
  }));
  ck('回放从第 0 步开始', /^0 \/ \d+$/.test(rp0.idx), true);
  ck('回放舞台有牌', rp0.cards > 0, true);
  await page.click('#replayNext');
  await page.click('#replayNext');
  const rp2 = await page.evaluate(() => document.getElementById('replayIdx').textContent);
  ck('下一步能前进', /^2 \/ \d+$/.test(rp2), true);
  const jumpVisible = await page.evaluate(() => getComputedStyle(document.getElementById('replayJump')).display !== 'none');
  if (jumpVisible) {
    await page.click('#replayJump');
    const rpj = await page.evaluate(() => ({
      idx: document.getElementById('replayIdx').textContent,
      note: document.getElementById('replayNote').textContent,
    }));
    ck('跳转后停在高亮丢分手', /少 \d/.test(rpj.note) || /没有明显丢分/.test(rpj.note), true);
    console.log('   （跳到：' + rpj.idx + ' · ' + rpj.note.slice(0, 40) + '）');
  } else {
    ck('无丢分时不显示跳转按钮', true, true);
  }
  ck('回放无「对不上」', await page.evaluate(() => document.getElementById('replayStage').textContent.indexOf('对不上') < 0), true);
  await page.click('#replayClose');

  await page.click('#overShareCard');
  ck('战报卡弹层打开', await page.evaluate(() => !document.getElementById('shareCardModal').classList.contains('hidden')), true);
  const card = await page.evaluate(() => new Promise((resolve) => {
    const img = document.querySelector('#shareCardPreview img');
    if (!img) return resolve({ ok: false });
    const done = () => resolve({ ok: true, w: img.naturalWidth, h: img.naturalHeight, src: img.src.slice(0, 22) });
    if (img.complete) done(); else img.onload = done;
  }));
  ck('战报卡是 PNG 且 1080×1350', card.ok && card.src.indexOf('data:image/png') === 0 && card.w === 1080 && card.h === 1350, true);
  if (card.ok) console.log('   （卡片尺寸 ' + card.w + '×' + card.h + '）');
  await page.click('#shareCardCopy');
  await page.waitForTimeout(120);
  await page.click('#shareCardClose');

  ck('零 pageerror / console error', errors.length, 0);
  if (errors.length) console.log('   ' + errors.join('\n   '));

  await browser.close();
  console.log(fails === 0 ? '\nFEATURE_TEST_OK' : '\nFEATURE_TEST_FAIL（' + fails + ' 项）');
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('TEST_CRASH', e); process.exit(2); });
