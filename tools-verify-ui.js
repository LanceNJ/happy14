// 无头真跑校验：把单文件当真实网页加载，走完"标题画面 → 开始 → 选难度 → 玩法 → 对局"，逐态截图
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const B = __dirname;
const FILE = path.join(B, '欢乐十四分-手机版.html');
const OUT = path.join(B, '_shots');
const url = 'file:///' + FILE.replace(/\\/g, '/');

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const log = [];
  const browser = await chromium.launch();

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => log.push('PAGE_ERR ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') log.push('CONSOLE_ERR ' + m.text().slice(0, 160)); });

  await p.goto(url, { waitUntil: 'load' });
  await p.waitForTimeout(700);
  log.push('[load]      startScreen=' + (await p.isVisible('#startScreen')) + '  diffModal=' + (await p.isVisible('#diffModal')) + '  helpModal=' + (await p.isVisible('#helpModal')));
  await p.screenshot({ path: path.join(OUT, '01-start-phone.png') });

  await p.click('#startGo');
  await p.waitForTimeout(600);
  log.push('[开始游戏]  startScreen=' + (await p.isVisible('#startScreen')) + '  diffModal=' + (await p.isVisible('#diffModal')));
  await p.screenshot({ path: path.join(OUT, '02-diff-phone.png') });

  await p.click('#askDiffGo');
  await p.waitForTimeout(800);
  log.push('[选难度]    helpModal=' + (await p.isVisible('#helpModal')));
  await p.screenshot({ path: path.join(OUT, '03-help-phone.png') });

  if (await p.isVisible('#helpModal')) { await p.click('#helpClose'); await p.waitForTimeout(600); }
  log.push('[对局中]    helpModal=' + (await p.isVisible('#helpModal')) + '  桌面牌=' + (await p.locator('#table .card').count()) + '  手牌=' + (await p.locator('#playerHand .card').count()));
  await p.screenshot({ path: path.join(OUT, '04-game-phone.png') });

  // 可玩性抽检：点 1 张手牌 + 1 张桌面牌，看确认按钮是否出现
  log.push('[操作区]    ' + (await p.locator('#controls').innerText()).replace(/\n/g, ' | '));
  await p.locator('#playerHand .card').first().click();
  await p.waitForTimeout(200);
  await p.locator('#table .card').first().click();
  await p.waitForTimeout(300);
  log.push('[点牌后]    ' + (await p.locator('#controls').innerText()).replace(/\n/g, ' | '));
  await p.screenshot({ path: path.join(OUT, '05-select-phone.png') });
  await ctx.close();

  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1 });
  const p2 = await ctx2.newPage();
  await p2.goto(url, { waitUntil: 'load' });
  await p2.waitForTimeout(700);
  await p2.screenshot({ path: path.join(OUT, '06-start-wide.png') });
  await ctx2.close();

  await browser.close();
  fs.writeFileSync(path.join(B, '_shots.log'), log.join('\n'), 'utf8');
  console.log(log.join('\n'));
})();
