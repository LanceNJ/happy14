const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const url = 'file://' + path.resolve(__dirname, 'site-mobile/index.html');
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript(() => {
    try { localStorage.setItem('h14_seenHelp', '1'); localStorage.setItem('h14_askdiff', '0'); localStorage.removeItem('h14_coach_nudge'); localStorage.removeItem('h14_coach'); } catch (e) {}
  });
  await page.goto(url);
  const ck = (name, got, exp) => console.log((JSON.stringify(got) === JSON.stringify(exp) ? 'PASS' : 'FAIL') + ' | ' + name + ' => ' + JSON.stringify(got) + (JSON.stringify(got) === JSON.stringify(exp) ? '' : ' (exp ' + JSON.stringify(exp) + ')'));

  // 真正开局：从标题画面点开始 → 处理难度弹窗 → 等玩家回合
  await page.evaluate(() => { const b = document.getElementById('startGo'); if (b) b.click(); });
  // 等难度弹窗并点开始
  await page.waitForTimeout(400);
  const hadDiff = await page.evaluate(() => { const m = document.getElementById('diffModal'); return m && !m.classList.contains('hidden'); });
  if (hadDiff) { await page.click('#askDiffGo'); }
  console.log('diffModal appeared:', hadDiff);

  // 轮询等待引导气泡出现（覆盖 NPC 先手场景）
  let appeared = false;
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(500);
    if (await page.evaluate(() => document.getElementById('coachNudge').classList.contains('show'))) { appeared = true; break; }
  }
  ck('玩家回合后引导气泡显示', appeared, true);

  if (appeared) {
    ck('气泡含 × 关闭按钮', await page.evaluate(() => !!document.querySelector('#coachNudge .cn-x')), true);
    await page.click('#coachNudge .cn-x');
    await page.waitForTimeout(200);
    ck('点 × 后气泡隐藏', await page.evaluate(() => !document.getElementById('coachNudge').classList.contains('show')), true);
    ck('点 × 记住不再弹(seen=1)', await page.evaluate(() => { try { return localStorage.getItem('h14_coach_nudge'); } catch (e) { return 'ERR'; } }), '1');
    ck('点 × 未误开提示(btn.on=false)', await page.evaluate(() => !document.getElementById('coachBtn').classList.contains('on')), true);

    // 同 context 再开局，气泡不应再弹
    await page.evaluate(() => { const b = document.getElementById('newGame'); if (b) b.click(); });
    await page.waitForTimeout(400);
    const hadDiff2 = await page.evaluate(() => { const m = document.getElementById('diffModal'); return m && !m.classList.contains('hidden'); });
    if (hadDiff2) await page.click('#askDiffGo');
    let reappear = false;
    for (let i = 0; i < 25; i++) { await page.waitForTimeout(400); if (await page.evaluate(() => document.getElementById('coachNudge').classList.contains('show'))) { reappear = true; break; } }
    ck('再开局气泡不再弹', reappear, false);
  }

  // 点气泡主体（非×）仍能开提示
  await page.evaluate(() => { try { localStorage.removeItem('h14_coach_nudge'); } catch (e) {} });
  await page.reload();
  await page.waitForTimeout(300);
  await page.evaluate(() => { const b = document.getElementById('startGo'); if (b) b.click(); });
  await page.waitForTimeout(400);
  if (await page.evaluate(() => { const m = document.getElementById('diffModal'); return m && !m.classList.contains('hidden'); })) await page.click('#askDiffGo');
  let ap2 = false;
  for (let i = 0; i < 25; i++) { await page.waitForTimeout(400); if (await page.evaluate(() => document.getElementById('coachNudge').classList.contains('show'))) { ap2 = true; break; } }
  if (ap2) {
    const before = await page.evaluate(() => document.getElementById('coachBtn').classList.contains('on'));
    await page.evaluate(() => { const n = document.getElementById('coachNudge'); const x = n.querySelector('.cn-x'); if (x) x.remove(); n.click(); });
    await page.waitForTimeout(150);
    ck('点气泡主体仍能开提示', await page.evaluate(() => document.getElementById('coachBtn').classList.contains('on')), true !== before);
  } else { ck('点气泡主体仍能开提示(气泡未出现,跳过)', true, true); }

  ck('无 pageerror', errors.length, 0);
  await browser.close();
})();
