// 打"单文件分享版"：把源 HTML 引用的样式 + JS 全部内联成一个自包含 HTML。
// 用法：node tools-standalone.js            （生成桌面版 + 手机版两个文件）
//       node tools-standalone.js --check    （生成后顺带核对无残留外部引用）
//
// 产出：
//   欢乐十四分-单机版.html  —— 桌面版，源 = play.html（控制器 electron/src/app.js）
//   欢乐十四分-手机版.html  —— 独立手机前端，源 = mobile/index.html（控制器 mobile/mobile.js）
//
// 设计要点：两变体各自有【独立源 HTML + 各自要内联的文件清单】，互不干扰。
//   桌面版 = play.html（含 app.js 控制器），保留桌面侧栏/胜率/日志等完整信息。
//   手机版 = mobile/index.html（含 mobile.js 控制器），单行竖向布局、信息大幅精简。
//   两变体分别内联同一份内核 electron/src/{game-core,advisor,sfx}.js，保证三端副本一致。
//   手机版整体降一档的标记 window.H14_EASY_SHIFT 已内嵌在 mobile/index.html（在 mobile.js 之前），
//   因此本工具无需再为手机版注入任何东西——差异全部收敛到各自源文件，一目了然。

const fs = require('fs');
const path = require('path');
const B = __dirname;

// 内联前安全检查：内容里若出现 </script 会提前截断脚本，必须拦下
function load(f) {
  const t = fs.readFileSync(path.join(B, f), 'utf8');
  if (/<\/script/i.test(t)) throw new Error(f + ' 内含 </script>，不能直接内联（需先转义）');
  return t;
}

// 变体定义。每个变体自带 src / linkRe / 要内联的文件(按顺序) / 脚本顺序。
const VARIANTS = [
  {
    name: '桌面单机版',
    out: '欢乐十四分-单机版.html',
    src: 'play.html',
    linkRe: /<link rel="stylesheet" href="electron\/src\/style\.css" \/>/,
    files: {
      'electron/src/style.css': null,
      'electron/src/game-core.js': null,
      'electron/src/advisor.js': null,
      'electron/src/sfx.js': null,
      'electron/src/app.js': null,
    },
    scripts: ['electron/src/game-core.js', 'electron/src/advisor.js', 'electron/src/sfx.js', 'electron/src/app.js'],
    subs: [],
  },
  {
    name: '手机版',
    out: '欢乐十四分-手机版.html',
    src: 'mobile/index.html',
    linkRe: /<link rel="stylesheet" href="mobile\/mobile\.css" \/>/,
    files: {
      'mobile/mobile.css': null,
      'electron/src/game-core.js': null,
      'electron/src/advisor.js': null,
      'electron/src/sfx.js': null,
      'mobile/mobile.js': null,
    },
    scripts: ['electron/src/game-core.js', 'electron/src/advisor.js', 'electron/src/sfx.js', 'mobile/mobile.js'],
    subs: [],
  },
];

// 预读并做 </script 安全检查
for (const v of VARIANTS) {
  for (const f of Object.keys(v.files)) v.files[f] = load(f);
}

const checkOnly = process.argv.includes('--check');

for (const v of VARIANTS) {
  let html = fs.readFileSync(path.join(B, v.src), 'utf8');

  // <link rel="stylesheet" href="..." /> → <style>…</style>（取 files 第一项为样式）
  const cssFile = Object.keys(v.files)[0];
  html = html.replace(v.linkRe, '<style>\n' + v.files[cssFile] + '\n</style>');

  // <script src="X"></script> → <script>…</script>（逐个替换，保序）
  for (const f of v.scripts) {
    const tag = '<script src="' + f.replace(/\//g, '\\/') + '"></script>';
    html = html.replace(new RegExp(tag), '<script>\n' + v.files[f] + '\n</script>');
  }

  // 变体专属文案替换（如有）
  for (const [a, b] of v.subs) {
    if (html.indexOf(a) < 0) throw new Error(v.name + '：要替换的文案没找到 → ' + a);
    html = html.split(a).join(b);
  }

  // 收尾校验：不应再有未内联的外部引用（仅检查本变体涉及的 link / script）
  const leftover = [];
  if (html.match(v.linkRe)) leftover.push('link(' + cssFile + ')');
  for (const f of v.scripts) {
    if (html.indexOf('<script src="' + f + '"></script>') >= 0) leftover.push(f);
  }
  if (leftover.length) throw new Error(v.name + ' 仍有未内联的外部引用：' + leftover.join(', '));

  const banner = '<!-- ' + v.name + '：由 tools-standalone.js 自动生成，改代码请改源 HTML + electron/src + mobile/ 后重新生成，勿直接改本文件 -->\n';
  html = html.replace(/<!DOCTYPE html>/i, '<!DOCTYPE html>\n' + banner);

  const OUT = path.join(B, v.out);
  fs.writeFileSync(OUT, html);
  console.log('已生成 ' + v.out + '  ' + (fs.statSync(OUT).size / 1024).toFixed(1) + ' KB');
}

if (checkOnly) {
  console.log('✓ --check 通过：两变体均无外部引用残留');
}
