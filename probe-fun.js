// 临时探针：验三个新功能（今日定牌/成就/NPC观战）在真浏览器里真能跑。
// 观战那条钩了 beginTurn/spectateOver 主循环，重点验它。稳定后可并入 mobile-test.js。
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const D = __dirname;
const target = path.join(D, 'site-mobile/index.html');
if (!fs.existsSync(target)) { console.error('先 node tools-standalone.js && cp "欢乐十四分-手机版.html" site-mobile/index.html'); process.exit(2); }

let fails = 0;
const ck = (n, got, want) => {
  const ok = typeof want === 'function' ? want(got) : got === want;
  console.log((ok ? '  ✓ ' : '  ✗ ') + n + (ok ? '' : '   实际=' + JSON.stringify(got) + ' 期望=' + JSON.stringify(String(want))));
  if (!ok) fails++;
};

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/jsdelivr|Failed to load resource|net::|ERR_/.test(m.text())) errors.push('CONSOLE: ' + m.text()); });
  await page.goto('file:///' + target.replace(/\\/g, '/'), { waitUntil: 'load' });
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
  // 演出拍子压到最短（after 是顶层函数=window.after；只改节奏不改规则）
  await page.evaluate(() => { window.after = (ms, fn) => setTimeout(fn, Math.min(ms, 8)); });

  const native = (id) => page.evaluate((i) => { const e = document.getElementById(i); if (e) e.click(); return !!e; }, id);
  const closeOverlays = () => page.evaluate(() => {
    ['helpModal', 'restartModal', 'overModal'].forEach((id) => { const e = document.getElementById(id); if (e) e.classList.add('hidden'); });
  });

  console.log('\n== ① 今日定牌 ==');
  ck('启动屏有「今日定牌」按钮', await page.locator('#startToday').count(), 1);
  await native('startToday');
  await page.waitForTimeout(150);
  await closeOverlays();
  // 难度询问层（askDiff 默认 true）：选「中」开打
  await page.evaluate(() => {
    const m = document.getElementById('diffModal');
    if (m && !m.classList.contains('hidden')) {
      document.querySelector('#askDiffSeg .diff-btn[data-diff="medium"]').click();
      document.getElementById('askDiffGo').click();
    }
  });
  await page.waitForTimeout(250);
  await closeOverlays();
  const st1 = await page.evaluate(() => ({ today: isTodayGame, seed: currentSeed, expect: todaySeed(), phase: state ? state.phase : null, msg: document.getElementById('message').textContent }));
  ck('当前局标记为今日定牌', st1.today, true);
  ck('种子 = 日期种子（同一天人人同副牌）', st1.seed, st1.expect);
  // 注：今日定牌只是"用今天日期当种子"开普通局，开场白会被"轮到你出牌/…"立刻盖掉，
  // 不拿瞬时 message 断言；证到 phase=playing（确实在打）即可。
  ck('今日局已进入正常对局', st1.phase, 'playing');
  await page.evaluate(() => { todayMode = false; });

  console.log('\n== ② 成就 ==');
  await closeOverlays();
  ck('顶栏有「成就」按钮', await page.locator('#achvBtn').count(), 1);
  await native('achvBtn');
  const ap = await page.evaluate(() => {
    const m = document.getElementById('achvModal');
    return { open: !m.classList.contains('hidden'), cnt: document.getElementById('achvCount').textContent, body: document.getElementById('achvBody').textContent };
  });
  ck('成就面板能打开', ap.open, true);
  ck('面板显示 0 / 4 起点', ap.cnt, '0 / 4');
  ck('四条成就文案都在', ap.body.indexOf('双王收集者') >= 0 && ap.body.indexOf('零罚大师') >= 0 && ap.body.indexOf('地狱屠龙') >= 0 && ap.body.indexOf('15分俱乐部') >= 0, true);
  // 造"四项全达成"结算局面，直接验 earnAchievements 判定
  const ej = await page.evaluate(() => {
    npcDifficulty = 'hell';
    state = { playerLoot: [{ isJoker: true, label: '大王' }, { isJoker: true, label: '小王' }, { score: 5 }], playerPenalty: [] };
    const got = earnAchievements(15.5, 3);
    return { got: got.slice().sort(), now: Object.keys(achv).length };
  });
  ck('造局面一次达成全部四项', ej.got.length === 4 && ['dualKings', 'hellKill', 'score15', 'zeroPen'].every((x) => ej.got.indexOf(x) >= 0), true);
  ck('达成已落 localStorage（4 项全亮）', ej.now, 4);
  await page.evaluate(() => { npcDifficulty = 'medium'; try { localStorage.removeItem('h14_achv_v1'); localStorage.removeItem('h14_todaybest_v1'); } catch (e) {} });
  await page.evaluate(() => { const m = document.getElementById('achvModal'); if (m) m.classList.add('hidden'); });

  console.log('\n== ③ NPC 观战（两条自动方打完一整局） ==');
  ck('启动屏有「看 NPC 对打」', await page.locator('#startSpectate').count(), 1);
  await native('startSpectate');
  await page.waitForTimeout(250);
  await closeOverlays();
  // startSpectate 直接 newGame（npcDifficulty 已被设为 hell），不弹难度询问层
  const sp = await page.evaluate(() => ({
    spectating, diff: npcDifficulty, banner: !document.getElementById('spectateBanner').classList.contains('hidden'),
    pair: document.getElementById('spectatePair').textContent,
  }));
  ck('进入观战态', sp.spectating, true);
  ck('NPC 侧坐地狱位', sp.diff, 'hell');
  ck('观战横幅亮起', sp.banner, true);
  ck('横幅标「贪心 vs 地狱」', sp.pair, '贪心 vs 地狱');
  // 自动跑一整局：等 #message 出现「观战一局终」（spectateOver 的播报）
  const g1 = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let g = 0; g < 12000; g++) {
      if (document.getElementById('message').textContent.indexOf('观战一局终') >= 0) return 'oneGameDone';
      await wait(10);
    }
    return 'timeout';
  });
  ck('观战局自动打完一整局', g1, 'oneGameDone');
  // 结束播报后自动续局（spectateOver 的 after(2000)，加速下几乎立刻）
  await page.waitForTimeout(150);
  const nx = await page.evaluate(() => ({ spectating, phase: state.phase, msg: document.getElementById('message').textContent }));
  ck('观战局后自动续局（仍在观战、已回到 playing）', nx.spectating === true && nx.phase === 'playing', true);
  await native('spectateStop');
  await page.waitForTimeout(100);
  const out = await page.evaluate(() => ({
    spectating, banner: document.getElementById('spectateBanner').classList.contains('hidden'),
    backStart: !document.getElementById('startScreen').classList.contains('hidden'),
  }));
  ck('停止观战：关观战态', out.spectating, false);
  ck('停止观战：横幅收起', out.banner, true);
  ck('停止观战：回启动屏', out.backStart, true);

  console.log('\n== 零 pageerror / console error ==');
  ck('全程无 JS 报错', errors.length, 0);
  if (errors.length) console.log('   ' + errors.slice(0, 8).join('\n   '));

  await browser.close();
  console.log('\n' + (fails ? 'PROBE_FAIL ' + fails + ' 项' : 'PROBE_OK 全过'));
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('probe crashed: ' + (e && e.message || e)); process.exit(3); });
