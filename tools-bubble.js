/*
 * 气泡遮挡探针 —— 用户投诉过"NPC 说话的泡泡挡住我的手牌"，这个脚本用真实浏览器量出重叠张数。
 * 做法：把 play.html 里的大娃娃（#npcSpeak）与小气泡（#npcSay）强制显示成"最长台词"的样子，
 *       再逐个比对它们与玩家手牌 / 桌面牌的矩形重叠，报告被盖住几张。
 * 判定标准：手牌被盖住 0 张才算过（桌面牌被盖可以接受，手牌不能）。
 * 用法： node tools-bubble.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DIR = __dirname;

const PROBE = `
<script>
(function () {
  function overlap(a, b) {
    return !(a.bottom <= b.top || a.top >= b.bottom || a.right <= b.left || a.left >= b.right);
  }
  function countCovered(box, sel) {
    var els = document.querySelectorAll(sel);
    var n = 0, idx = [];
    for (var i = 0; i < els.length; i++) {
      if (overlap(els[i].getBoundingClientRect(), box)) { n++; idx.push(i); }
    }
    return { n: n, idx: idx.join(',') };
  }
  function boxOf(el) {
    var r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), h: Math.round(r.height) };
  }
  function emit(lines) {
    var old = document.getElementById('probe-out');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var pre = document.createElement('pre');
    pre.id = 'probe-out';
    pre.textContent = lines.join('\\n');
    document.body.appendChild(pre);
  }

  window.__probe = function () {
    var out = [];
    out.push('viewport=' + window.innerWidth + 'x' + window.innerHeight);
    out.push('handCards=' + document.querySelectorAll('#playerHand .card').length +
             ' tableCards=' + document.querySelectorAll('#table .card').length);

    // ① 大娃娃：摆出最长台词的样子
    var sp = document.getElementById('npcSpeak');
    var spTxt = document.getElementById('npcSpeakText');
    if (sp && spTxt) {
      sp.classList.remove('hidden');
      spTxt.textContent = '嘿嘿，这把你的牌我可全看透了，那张 K 留着也救不了你！';
      var b = boxOf(sp);
      out.push('bigDoll  = top' + b.top + ' bottom' + b.bottom + ' h' + b.h);
      out.push('  cover playerHand -> ' + countCovered(sp.getBoundingClientRect(), '#playerHand .card').n + ' 张');
      out.push('  cover tableCards -> ' + countCovered(sp.getBoundingClientRect(), '#table .card').n + ' 张');
    } else out.push('bigDoll = 元素未找到');

    // ② 小气泡（座位区）
    var say = document.getElementById('npcSay');
    if (say) {
      say.classList.remove('hidden');
      say.textContent = '嘿，看好了';
      var c = boxOf(say);
      out.push('smallSay = top' + c.top + ' bottom' + c.bottom + ' h' + c.h);
      out.push('  cover playerHand -> ' + countCovered(say.getBoundingClientRect(), '#playerHand .card').n + ' 张');
      out.push('  cover tableCards -> ' + countCovered(say.getBoundingClientRect(), '#table .card').n + ' 张');
    } else out.push('smallSay = 元素未找到');

    var ph = document.getElementById('playerHand');
    if (ph) { var p = boxOf(ph); out.push('playerHand= top' + p.top + ' bottom' + p.bottom); }
    var tb = document.querySelector('.table-area');
    if (tb) { var t = boxOf(tb); out.push('tableArea = top' + t.top + ' bottom' + t.bottom); }
    emit(out);
  };

  // 先落一份 t0 快照：即使后面的轮询/定时器不跑，也能证明探针执行过、看到当时牌面
  var cards0 = document.querySelectorAll('#playerHand .card').length;
  emit(['t0: playerHandCards=' + cards0 + ' readyState=' + document.readyState]);

  // 轮询等游戏把手牌渲染出来（最多 80 次 × 50ms），再量真正的重叠
  var n = 0;
  (function poll() {
    n++;
    var c = document.querySelectorAll('#playerHand .card').length;
    if (c >= 4 || n > 80) { window.__probe(); return; }
    setTimeout(poll, 50);
  })();
})();
</script>
`;

function run(w, h, label) {
  const tmpHtml = path.join(DIR, '_bubble-' + label + '.html');
  let html = fs.readFileSync(path.join(DIR, 'play.html'), 'utf8');
  html = html.replace('</body>', PROBE + '</body>');
  fs.writeFileSync(tmpHtml, html);

  const profile = path.join(os.tmpdir(), 'h14-bubble-' + label);
  const url = 'file:///' + tmpHtml.replace(/\\/g, '/');
  let dom = '';
  try {
    dom = execFileSync(CHROME, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--user-data-dir=' + profile,
      '--window-size=' + w + ',' + h,
      '--virtual-time-budget=4000',
      '--dump-dom', url,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 40 * 1024 * 1024 });
  } catch (e) {
    dom = (e.stdout || '') + (e.stderr || '');
  }
  const m = dom.match(/<pre id="probe-out">([\s\S]*?)<\/pre>/);
  console.log('=== ' + label + ' (' + w + 'x' + h + ') ===');
  if (m) {
    console.log(m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim());
  } else {
    console.log('（探测输出未找到）domLength=' + dom.length +
      ' hasProbeOut=' + (dom.indexOf('probe-out') >= 0) +
      ' hasTable=' + (dom.indexOf('id="table"') >= 0) +
      ' hasPlayerHand=' + (dom.indexOf('id="playerHand"') >= 0));
  }
  console.log('');
  try { fs.unlinkSync(tmpHtml); } catch (e) {}
}

run(1080, 600, 'user');
run(1280, 720, 'mid');
run(1440, 900, 'desktop');
run(900, 520, 'tiny');
