const path = require('path');
const { chromium } = require('playwright');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="100%" height="100%">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1e5230"/><stop offset="0.6" stop-color="#14361f"/><stop offset="1" stop-color="#0a1d10"/>
    </linearGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f0dfae"/><stop offset="0.5" stop-color="#d9b45a"/><stop offset="1" stop-color="#b8913a"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  <text x="70" y="120" font-family="Georgia,serif" font-size="72" fill="#ffffff" opacity="0.07">&#9824;</text>
  <text x="380" y="470" font-family="Georgia,serif" font-size="92" fill="#ffffff" opacity="0.06">&#9829;</text>
  <rect x="142" y="82" width="228" height="348" rx="30" fill="#fbfaf4" stroke="url(#gold)" stroke-width="10"/>
  <rect x="158" y="98" width="196" height="316" rx="20" fill="none" stroke="#e7d9b4" stroke-width="3"/>
  <text x="256" y="304" text-anchor="middle" font-family="Georgia,'Times New Roman',serif" font-size="172" font-weight="700" fill="#16361f">14</text>
  <text x="256" y="372" text-anchor="middle" font-family="Georgia,serif" font-size="40" fill="#b3271e">&#9824; &#9829; &#9827; &#9830;</text>
  <text x="256" y="474" text-anchor="middle" font-family="'Microsoft YaHei',sans-serif" font-size="26" letter-spacing="4" fill="#d9b45a">欢乐十四分</text>
</svg>`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  for (const size of [512, 192, 180]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent('<!DOCTYPE html><html><head><style>html,body{margin:0;padding:0;overflow:hidden;background:#14361f}svg{display:block}</style></head><body>' + svg + '</body></html>');
    const out = path.join(__dirname, 'mobile', 'icon-' + size + '.png');
    await page.screenshot({ path: out, omitBackground: false });
    await page.close();
    console.log('icon-' + size + '.png done');
  }
  await browser.close();
})();
