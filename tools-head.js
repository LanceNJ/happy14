// 把浏览器身份元信息（图标 / 主题色 / 分享卡）注入两个源 HTML 的标记之间。
// 一次性生成后即为字面内容；换图标时改 tools-assets.js 再跑本脚本即可（可重复执行）。
const fs = require('fs');
const path = require('path');

const B = __dirname;
const A = JSON.parse(fs.readFileSync(path.join(B, 'tools-assets.json'), 'utf8'));
const S = '<!--H14-BROWSER-IDENTITY-START-->';
const E = '<!--H14-BROWSER-IDENTITY-END-->';

const SHARE_URL = 'https://h14-mobile-98661.app.workbuddy.host/';
const DESC_SHORT = '一副牌、两个人、一局三分钟的小纸牌游戏。点开就能玩，不用下载。';
const DESC_LONG = '一副牌、两个人、一局三分钟的小纸牌游戏：手牌配桌面牌凑够 14 就把牌收走。点开就能玩，不用下载。';

const common = [
  '  <meta name="theme-color" content="#16361f" />',
  '  <link rel="icon" href="' + A.faviconDataUri + '" />',
  '  <link rel="apple-touch-icon" href="' + A.touchIconDataUri + '" />',
  '  <meta name="apple-mobile-web-app-capable" content="yes" />',
  '  <meta name="mobile-web-app-capable" content="yes" />',
  '  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />',
  '  <meta name="apple-mobile-web-app-title" content="欢乐十四分" />',
];

const mobileBlock = [
  '  <meta name="description" content="' + DESC_LONG + '" />',
  ...common,
  '  <meta property="og:type" content="website" />',
  '  <meta property="og:title" content="欢乐十四分 · 凑够十四就把牌收走" />',
  '  <meta property="og:description" content="' + DESC_SHORT + '" />',
  '  <meta property="og:url" content="' + SHARE_URL + '" />',
  '  <meta property="og:image" content="' + SHARE_URL + 'share.png" />',
  '  <meta name="twitter:card" content="summary_large_image" />',
].join('\n');

const desktopBlock = [
  '  <meta name="description" content="' + DESC_SHORT + '" />',
  ...common,
].join('\n');

const targets = [
  { file: 'mobile/index.html', block: mobileBlock },
  { file: 'play.html', block: desktopBlock },
];

for (const t of targets) {
  const p = path.join(B, t.file);
  let s = fs.readFileSync(p, 'utf8');
  const i = s.indexOf(S);
  const j = s.indexOf(E);
  if (i < 0 || j < 0) throw new Error(t.file + '：找不到注入标记');
  const before = s.slice(0, i + S.length);
  const after = s.slice(j);
  s = before + '\n' + t.block + '\n  ' + after;
  fs.writeFileSync(p, s, 'utf8');
  const hasIcon = s.includes('rel="icon"');
  const hasOg = s.includes('property="og:image"');
  console.log(t.file + '  注入 OK  bytes=' + s.length + '  icon=' + hasIcon + ' ogImage=' + hasOg);
}
console.log('DONE');
