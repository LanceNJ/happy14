// 一次性资源生成：游戏图标（favicon / 主屏图标）+ 分享卡图
// 跑法：NODE_PATH=<node_modules 所在目录> node tools-assets.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const B = __dirname;
const SITE = path.join(B, 'site-mobile');

// ---- 图标（几何简单，用 SVG；同一份缩放成 180 位图给 iOS 主屏） ----
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
  `<rect width="64" height="64" rx="14" fill="#16361f"/>` +
  `<rect x="15" y="10.5" width="34" height="43" rx="5" fill="#fbfaf4" stroke="#d9b45a" stroke-width="2"/>` +
  `<text x="32" y="40.5" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="23" font-weight="700" fill="#16361f">14</text>` +
  `</svg>`;

const iconHtml = `<!doctype html><html><head><meta charset="utf-8"></head>` +
  `<body style="margin:0;width:180px;height:180px">` +
  svg.replace('viewBox="0 0 64 64"', 'width="180" height="180" viewBox="0 0 64 64"') +
  `</body></html>`;

// ---- 分享卡（1200×630）：关键内容居中，被裁成方形也读得懂 ----
const SERIF = `'Songti SC','STSong',SimSun,'Noto Serif SC',Georgia,serif`;
const card = (txt, red) =>
  `<div style="width:92px;height:130px;border-radius:12px;background:#fbfaf4;display:flex;align-items:center;justify-content:center;` +
  `font-size:46px;font-weight:700;color:${red ? '#b3271e' : '#16361f'};box-shadow:0 6px 18px rgba(0,0,0,.35)">${txt}</div>`;

const shareHtml = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;width:1200px;height:630px;overflow:hidden">
<div style="width:1200px;height:630px;background:radial-gradient(120% 92% at 50% 0%,#1e5230 0%,#14361f 55%,#0a1d10 100%);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif">
  <div style="font-family:${SERIF};font-size:74px;font-weight:700;color:#f6efdc;letter-spacing:12px;text-shadow:0 2px 6px rgba(0,0,0,.45)">欢乐十四分</div>
  <div style="width:130px;height:1px;background:#d9b45a;margin:26px 0 22px"></div>
  <div style="font-size:29px;color:#c9c2a6;letter-spacing:7px">凑够十四，把牌收走</div>
  <div style="display:flex;align-items:center;gap:20px;margin:40px 0 36px">
    ${card('9', false)}
    <div style="font-size:42px;color:#d9b45a;font-weight:700">+</div>
    ${card('5', true)}
    <div style="font-size:42px;color:#d9b45a;font-weight:700">=</div>
    <div style="width:92px;height:130px;border-radius:12px;background:#d9b45a;border:2px solid #f0dfae;display:flex;align-items:center;justify-content:center;font-size:42px;font-weight:800;color:#16281a;box-shadow:0 6px 18px rgba(0,0,0,.35)">14</div>
  </div>
  <div style="font-size:22px;color:#8fa38c;letter-spacing:4px">点开就能玩 · 不用下载</div>
</div>
</body></html>`;

(async () => {
  if (!fs.existsSync(SITE)) fs.mkdirSync(SITE, { recursive: true });
  const browser = await chromium.launch();

  const p1 = await browser.newPage({ viewport: { width: 180, height: 180 }, deviceScaleFactor: 1 });
  await p1.setContent(iconHtml, { waitUntil: 'load' });
  const png180 = await p1.screenshot({ type: 'png' });
  fs.writeFileSync(path.join(B, 'tools-icon180.png'), png180);

  const p2 = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await p2.setContent(shareHtml, { waitUntil: 'load' });
  await p2.screenshot({ path: path.join(SITE, 'share.png') });

  await browser.close();

  const out = {
    faviconDataUri: 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64'),
    touchIconDataUri: 'data:image/png;base64,' + png180.toString('base64'),
    svg,
    png180Bytes: png180.length,
  };
  fs.writeFileSync(path.join(B, 'tools-assets.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log('favicon len=' + out.faviconDataUri.length);
  console.log('touchIcon len=' + out.touchIconDataUri.length + ' (png ' + png180.length + 'B)');
  console.log('share.png -> ' + path.join(SITE, 'share.png') + ' ' + (fs.statSync(path.join(SITE, 'share.png')).size / 1024).toFixed(0) + 'KB');
})();
