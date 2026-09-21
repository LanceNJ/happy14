/*
 * 临时脚本（用完即删）：只做一件事 —— 沿布局层级逐块量高，找出"页面高于视口"的真凶。
 * 理由：测试桩测不出布局溢出，截图肉眼也只能看出症状；必须真渲染 + 把每块的
 * 高度/滚动高/overflow 值读回来，才能定位到具体哪条 CSS 在撑高。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DIR = __dirname;
const PROFILE = path.join(DIR, '_chromeprofile');

const raw = fs.readFileSync(path.join(DIR, 'play.html'), 'utf8');
const DIAG = `
<script>
setTimeout(function () {
  var vh = window.innerHeight, vw = window.innerWidth;
  var out = [];
  out.push('VIEWPORT ' + vw + 'x' + vh);
  var de = document.documentElement;
  out.push('DOC clientH=' + de.clientHeight + ' scrollH=' + de.scrollHeight +
           (de.scrollHeight > de.clientHeight + 1 ? '   <-- 页面可滚动（有内容在视口外）' : ''));
  out.push('BODY scrollH=' + document.body.scrollHeight + ' clientH=' + document.body.clientHeight);

  function info(el, label) {
    if (!el) { out.push('  ' + label + ' = (无)'); return; }
    var r = el.getBoundingClientRect();
    var cs = getComputedStyle(el);
    out.push('  ' + label +
      ' h=' + Math.round(r.height) +
      ' top=' + Math.round(r.top) + ' bot=' + Math.round(r.bottom) +
      ' scrollH=' + el.scrollHeight + ' clientH=' + el.clientHeight +
      ' ovfY=' + cs.overflowY +
      ' flex=[' + cs.flexGrow + ' ' + cs.flexShrink + ' ' + cs.flexBasis + ']' +
      ' minH=' + cs.minHeight +
      ' mt=' + cs.marginTop + ' mb=' + cs.marginBottom +
      ' pad=' + cs.paddingTop + '/' + cs.paddingBottom +
      (r.bottom > vh + 1 ? '  <-- 超出底部 ' + Math.round(r.bottom - vh) + 'px' : ''));
  }

  out.push('--- 布局链（从 #app 往下）---');
  var app = document.getElementById('app');
  info(app, '#app');
  var layout = document.querySelector('.layout');
  info(layout, '.layout');
  var board = document.querySelector('.board');
  info(board, '.board');
  var side = document.querySelector('.sidebar');
  info(side, '.sidebar');

  out.push('--- .board 的直接子块（按顺序）---');
  if (board) {
    var i = 0;
    Array.prototype.forEach.call(board.children, function (c) {
      info(c, (++i) + ' ' + (c.className || c.id));
    });
    out.push('  .board 子块高度合计=' + Math.round(Array.prototype.reduce.call(board.children, function (a, c) {
      return a + c.getBoundingClientRect().height;
    }, 0)) + '  gap=' + getComputedStyle(board).rowGap);
  }

  out.push('--- .sidebar 的直接子块 ---');
  if (side) {
    var j = 0;
    Array.prototype.forEach.call(side.children, function (c) {
      info(c, (++j) + ' ' + (c.className || c.id));
    });
    out.push('  .sidebar 子块高度合计=' + Math.round(Array.prototype.reduce.call(side.children, function (a, c) {
      return a + c.getBoundingClientRect().height;
    }, 0)) + '  gap=' + getComputedStyle(side).rowGap +
      '  子块合计 + 侧栏可用高对比：' + side.clientHeight);
  }

  // 真正决定"手牌是否可见"的那一项
  var ph = document.getElementById('playerHand');
  info(ph, '#playerHand（玩家手牌，必须完整可见）');

  out.push('DIAG-END');
  var pre = document.createElement('pre');
  pre.id = 'diag-out';
  pre.textContent = out.join('\\n');
  document.body.appendChild(pre);
}, 1200);
</script>
`;
fs.writeFileSync(path.join(DIR, '_diag.html'), raw.replace('</body>', DIAG + '</body>'), 'utf8');

function run(args) {
  try {
    return execFileSync(CHROME, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '');
  }
}

const diagUrl = 'file:///' + path.join(DIR, '_diag.html').replace(/\\/g, '/');
for (const [w, h] of [[1080, 600], [1440, 900], [900, 520]]) {
  const html = run(['--headless=new', '--disable-gpu', '--no-sandbox',
    '--user-data-dir=' + PROFILE, '--window-size=' + w + ',' + h,
    '--virtual-time-budget=6000', '--dump-dom', diagUrl]);
  const m = html.match(/<pre id="diag-out">([\s\S]*?)<\/pre>/);
  console.log('\n========== ' + w + 'x' + h + ' ==========');
  console.log(m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : '（没拿到诊断输出）');
}
