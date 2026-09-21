/*
 * 两版配色/布局一致性检查（ui-test.js 与 mini-test.js 共用同一份实现）
 *
 * 为什么单独抽出来：这条约束天然是"跨两版"的，如果把它分别抄进两个测试文件，
 * 改一处漏一处就会变成假绿——本项目已经因为"改了 Web 忘了小程序"白跑过一轮。
 * 所以判据只写在这里一处，两个测试各自 require 它。
 *
 * 用法：checkStyle(fs.readFileSync, __dirname, ck)
 *   ck(name, got, want) 由调用方提供（两个测试的 ck 语义一致：console + 计失败数）
 */
function checkStyle(readFile, baseDir, ck) {
  const path = require('path');
  const R = (p) => readFile(path.resolve(baseDir, p), 'utf8');

  const webCss = R('electron/src/style.css');
  const miniWxss = R('miniprogram/pages/game/game.wxss');
  const idxHtml = R('electron/src/index.html');
  const playHtml = R('play.html');
  const miniWxml = R('miniprogram/pages/game/game.wxml');
  const miniLower = miniWxss.toLowerCase();

  // ---------- 色板：Web 用 CSS 变量定义，小程序不写 var()（渲染器支持不确定）直接写死同一套值 ----------
  const vars = [...webCss.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})/g)]
    .map((m) => [m[1], m[2].toLowerCase()]);

  ck('色板变量数量合理（>= 12）', vars.length >= 12, true);

  // 判据一：Web 定义的每个色值，都必须能在小程序样式里找到
  const missing = vars.filter(([, v]) => miniLower.indexOf(v) < 0).map(([k, v]) => '--' + k + '=' + v);
  ck('两版配色完全对齐（Web 每个色值小程序都有）', missing.join(', ') || '无', '无');

  // 判据二：死变量必须为 0——定义了却没人用，会让上面那条"对齐"约束逐渐变模糊
  const dead = vars.filter(([k]) => webCss.indexOf('var(--' + k + ')') < 0).map(([k]) => '--' + k);
  ck('Web 没有"定义了却没人用"的死色板变量', dead.join(', ') || '无', '无');

  // 判据三：三层色调骨架（深木外框 / 绿呢桌面 / 奶油纸面板）两版都要有
  ['wood', 'felt', 'paper'].forEach((tier) => {
    ck('Web 有 ' + tier + ' 色阶', new RegExp('--' + tier).test(webCss), true);
  });
  ck('小程序桌面是绿呢（felt-1 色值出现）', miniLower.indexOf('#2f7a52') >= 0, true);
  ck('小程序外框是深木（wood-2 色值出现）', miniLower.indexOf('#4a2d15') >= 0, true);

  // ---------- 布局：实时比分区两版都要有（否则拿不到当下的胜负感） ----------
  ['scoreMe', 'scoreNpc', 'scoreLead'].forEach((k) => {
    ck('Web 有实时比分区 ' + k, idxHtml.indexOf('id="' + k + '"') >= 0, true);
    ck('小程序有实时比分区 ' + k, miniWxml.indexOf(k) >= 0, true);
  });

  // ---------- index.html 与 play.html 必须同结构（play.html 只是多一段"内核挂 window"的脚本） ----------
  const shared = ['scoreMe', 'scoreNpc', 'scoreLead', 'oddsBar', 'npcAvatar', 'npcShow', 'npcSpeak', 'soundBtn', 'newGame'];
  const drift = shared.filter((k) => idxHtml.indexOf(k) < 0 || playHtml.indexOf(k) < 0);
  ck('index.html 与 play.html 结构一致（关键容器两边都全）', drift.join(', ') || '无', '无');
}

module.exports = { checkStyle };
