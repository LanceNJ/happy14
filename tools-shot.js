/*
 * 临时脚本（用完即删）：用本机 Chrome 无头模式做两件事
 *  1) 在多个窗口尺寸下截图，肉眼核对排版
 *  2) 生成一份带"溢出检测"的临时页，用 --dump-dom 把测量结果读回来
 *     —— 测试桩测不出"元素超出视口"，只能真渲染；dump-dom 比肉眼更硬。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DIR = __dirname;
const PROFILE = path.join(DIR, '_chromeprofile');
const PLAY = 'file:///' + path.join(DIR, 'play.html').replace(/\\/g, '/');

// ---------- 1. 生成带诊断脚本的临时页 ----------
const raw = fs.readFileSync(path.join(DIR, 'play.html'), 'utf8');
const DIAG = `
<script>
setTimeout(function () {
  var vw = window.innerWidth, vh = window.innerHeight;
  var out = [];
  out.push('VIEWPORT ' + vw + 'x' + vh);
  out.push('DOC scrollH=' + document.documentElement.scrollHeight + ' scrollW=' + document.documentElement.scrollWidth);

  function rect(sel) {
    var el = document.querySelector(sel);
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { sel: sel, top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) };
  }
  // 关键区块是否完整落在视口内
  var keys = ['.topbar', '.table-area', '.seat.player', '#playerHand', '#npcHand', '#table', '.sidebar', '.log-panel', '.score-panel', '.odds-panel'];
  keys.forEach(function (k) {
    var r = rect(k);
    if (!r) { out.push('BLOCK ' + k + ' = (不存在)'); return; }
    var below = r.bottom > vh + 1;
    var right = r.right > vw + 1;
    out.push('BLOCK ' + k + ' top=' + r.top + ' bottom=' + r.bottom + ' w=' + r.w + ' h=' + r.h +
      (below ? '  <-- 超出底部 ' + (r.bottom - vh) + 'px' : '') +
      (right ? '  <-- 超出右侧 ' + (r.right - vw) + 'px' : ''));
  });
  // 横向溢出检测：任何元素 scrollWidth 明显大于 clientWidth
  var over = [];
  document.querySelectorAll('.panel, .panel *, .table-area *, .seat *, .topbar *').forEach(function (el) {
    if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
      var t = (el.textContent || '').trim().slice(0, 26);
      over.push(el.className + ' [' + el.clientWidth + '<' + el.scrollWidth + '] "' + t + '"');
    }
  });
  out.push('H-OVERFLOW count=' + over.length);
  over.slice(0, 14).forEach(function (o) { out.push('  H! ' + o); });

  // 竖向裁切：内容比容器高且被 overflow:hidden 裁掉
  var clip = [];
  document.querySelectorAll('.panel, .log-panel, .sidebar').forEach(function (el) {
    if (el.scrollHeight > el.clientHeight + 2 && getComputedStyle(el).overflowY === 'hidden') {
      clip.push(el.className + ' [' + el.clientHeight + '<' + el.scrollHeight + ']');
    }
  });
  out.push('V-CLIP count=' + clip.length);
  clip.forEach(function (c) { out.push('  V! ' + c); });

  // 手牌数量（确认牌真的画出来了）
  out.push('CARDS table=' + document.querySelectorAll('#table .card').length +
    ' player=' + document.querySelectorAll('#playerHand .card').length +
    ' npc=' + document.querySelectorAll('#npcHand .card').length);
  out.push('DIAG-END');

  var pre = document.createElement('pre');
  pre.id = 'diag-out';
  pre.textContent = out.join('\\n');
  document.body.appendChild(pre);
}, 1200);
</script>
`;
fs.writeFileSync(path.join(DIR, '_diag.html'), raw.replace('</body>', DIAG + '</body>'), 'utf8');

// ---------- 2. 跑 Chrome ----------
function run(args) {
  try {
    return execFileSync(CHROME, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '');
  }
}

const SIZES = [[1080, 600], [1280, 720], [1440, 900], [900, 520], [1920, 1080]];
console.log('=== 截图 ===');
for (const [w, h] of SIZES) {
  const out = path.join(DIR, '_shot-' + w + 'x' + h + '.png');
  if (fs.existsSync(out)) fs.unlinkSync(out);
  run(['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-sandbox',
    '--user-data-dir=' + PROFILE, '--window-size=' + w + ',' + h,
    '--virtual-time-budget=6000', '--screenshot=' + out, PLAY]);
  console.log('  ' + w + 'x' + h + ' → ' + (fs.existsSync(out) ? Math.round(fs.statSync(out).size / 1024) + 'KB' : '失败'));
}

console.log('\n=== 布局诊断（关键的 1080x600，即用户窗口）===');
for (const [w, h] of [[1080, 600], [1440, 900], [900, 520]]) {
  const html = run(['--headless=new', '--disable-gpu', '--no-sandbox',
    '--user-data-dir=' + PROFILE, '--window-size=' + w + ',' + h,
    '--virtual-time-budget=6000', '--dump-dom',
    'file:///' + path.join(DIR, '_diag.html').replace(/\\/g, '/')]);
  const m = html.match(/<pre id="diag-out">([\s\S]*?)<\/pre>/);
  console.log('\n----- ' + w + 'x' + h + ' -----');
  console.log(m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : '（没拿到诊断输出）');
}
