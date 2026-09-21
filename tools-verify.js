/*
 * 一次性验证脚本：在真实浏览器里检查
 *  1) 矮窗（1080x600）下玩家手牌是否在视口内（不被挤出屏幕）
 *  2) NPC 亮牌浮层出现时，是否遮住桌面 6 张牌（应不遮）
 *  3) 侧栏内容是否溢出
 * 用 --dump-dom 把诊断结果从页面里读回来。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DIR = __dirname;
const PAGE = 'file:///' + path.resolve(DIR, 'play.html').replace(/\\/g, '/');

const PROBE = `
<script>
(function () {
  window.__probe = function () {
    var out = [];
    var vw = window.innerWidth, vh = window.innerHeight;
    out.push('viewport=' + vw + 'x' + vh);
    function rect(sel) {
      var el = document.querySelector(sel);
      if (!el) return null;
      var r = el.getBoundingClientRect();
      return { t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), r: Math.round(r.right), h: Math.round(r.height) };
    }
    function line(name, sel) {
      var g = rect(sel);
      out.push(name + '=' + (g ? ('top' + g.t + ' bottom' + g.b + ' h' + g.h + (g.b > vh ? '  **超出视口' + (g.b - vh) + 'px**' : '')) : 'null'));
      return g;
    }
    var ph = line('playerHand', '#playerHand');
    var ta = line('tableArea', '.table-area');
    line('npcHand', '#npcHand');
    line('sidebar', '.sidebar');
    line('controls', '#controls');

    // 强制把 NPC 浮层显示出来，量它和桌面牌的重叠
    var ns = document.getElementById('npcShow');
    if (ns) {
      ns.classList.remove('hidden');
      ns.classList.add('masked');
      var box = document.createElement('div');
      box.className = 'npc-show-box';
      box.innerHTML = '<div class="npc-show-head">探测用浮层</div>';
      ns.innerHTML = '';
      ns.appendChild(box);
      var nb = box.getBoundingClientRect();
      out.push('npcShowBox=top' + Math.round(nb.top) + ' bottom' + Math.round(nb.bottom));
      // 桌面每一张牌的位置
      var cards = document.querySelectorAll('#table .card');
      var covered = 0;
      for (var i = 0; i < cards.length; i++) {
        var c = cards[i].getBoundingClientRect();
        var overflow = !(c.bottom <= nb.top || c.top >= nb.bottom || c.right <= nb.left || c.left >= nb.right);
        if (overflow) covered++;
      }
      out.push('deck cards covered by npcShow=' + covered + ' / ' + cards.length);
    } else out.push('npcShow=null');

    // 横向溢出：全页 scrollWidth 超过 clientWidth
    out.push('hScroll=' + (document.documentElement.scrollWidth - document.documentElement.clientWidth));
    var old = document.getElementById('probe-out');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var pre = document.createElement('pre');
    pre.id = 'probe-out';
    pre.textContent = out.join('\\n');
    document.body.appendChild(pre);
  };
  window.__probe();
  if (document.readyState === 'complete') setTimeout(window.__probe, 300);
  else document.addEventListener('load', function () { setTimeout(window.__probe, 300); });
})();
</script>
`;

function run(size, label) {
  const [w, h] = size;
  const tmpHtml = path.join(DIR, '_probe-' + label + '.html');
  let html = fs.readFileSync(path.join(DIR, 'play.html'), 'utf8');
  html = html.replace('</body>', PROBE + '</body>');
  fs.writeFileSync(tmpHtml, html);

  const profile = path.join(os.tmpdir(), 'h14-probe-' + label);
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
    console.log('（探测输出未找到）domLength=' + dom.length + ' hasProbeOut=' + (dom.indexOf('probe-out') >= 0) + ' hasTable=' + (dom.indexOf('id="table"') >= 0));
  }
  console.log('');
  try { fs.unlinkSync(tmpHtml); } catch (e) {}
}

run([1080, 600], 'user');
run([1440, 900], 'desktop');
run([900, 520], 'tiny');
