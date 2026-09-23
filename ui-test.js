// UI 冒烟测试（常驻）：用最小 DOM 桩真实执行 electron/src/app.js，端到端驱动一整局。
// 覆盖两条真实路径：① Node/Electron 模式（require 内核）② 浏览器模式（play.html：无 require、走 window.G/ADVISOR/SFX）
// 背景：这套界面过去出过"手牌区完全不渲染"的坑（cardEl(null,true) 先读 card.red 抛异常），
//       后来陆续加了补牌动画 / 匹配分步演出 / 罚牌出口 / NPC 亮牌 / 最优判断 / 胜率 / 音效 / NPC 台词。
//       这类"UI 从未真正执行过"的问题，靠本测试兜住。
// 定时器策略：手动队列（flushUntil 按条件推进）——分步演出必须能"一拍一拍"验，才能锁住线性过程；
//             端到端整局则切成同步定时器一次跑完。
// 改动 app.js / advisor.js / sfx.js / style.css / index.html / play.html 后请跑一次： node ui-test.js
const path = require('path');
const fs = require('fs');
const vm = require('vm');

// ---------- 1. 最小 DOM 桩（可批量造环境） ----------
class El {
  constructor(id, rec) {
    this.id = id; this._rec = rec; this._children = []; this._html = ''; this.textContent0 = '';
    this.scrollTop = 0; this.scrollHeight = 0; this.disabled = false; this.onclick = null;
    this.parentNode = null; this.style = {}; this.dataset = {};
    let _tc = '';
    Object.defineProperty(this, 'textContent', {
      get: () => _tc,
      set: (v) => {
        _tc = v;
        if (this._rec) {
          if (this.id === 'npcSay' && v) this._rec.sayHistory.push(v);         // NPC 碎嘴小气泡
          if (this.id === 'npcSpeakText' && v) this._rec.speakHistory.push(v); // NPC 大娃娃台词
          if (this.id === 'message' && v) this._rec.msgHistory.push(v);        // 提示语
        }
      },
    });
    const s = new Set();
    this.classList = {
      add: (...a) => a.forEach((x) => { if (rec) rec.classAdds.push(x); s.add(x); }),
      // 大娃娃浮层用 hidden 控制显隐：remove('hidden') 就是"弹出来了"
      remove: (...a) => a.forEach((x) => {
        s.delete(x);
        if (this.id === 'npcSpeak' && x === 'hidden') rec.speakShown = (rec.speakShown || 0) + 1;
      }),
      contains: (x) => s.has(x),
    };
    let _cn = '';
    Object.defineProperty(this, 'className', {
      // 忠实还原真实 DOM：classList.add 加进去的类也会出现在 class 属性里。
      // 否则 outerHTML 会漏掉动画类（如 flip-in / is-target），让"牌真的翻了"这类断言变成假阴性。
      get: () => {
        const cur = String(_cn || '').split(/\s+/).filter(Boolean);
        const extra = Array.from(s).filter((x) => x && cur.indexOf(x) < 0);
        return extra.length ? (cur.concat(extra).join(' ')) : _cn;
      },
      set: (v) => { _cn = v; if (v) String(v).split(/\s+/).forEach((x) => s.add(x)); },
    });
  }
  set innerHTML(v) {
    this._html = v; this._children = [];
    if (this._rec) {
      if (this.id === 'npcShow') this._rec.npcShowHistory.push(v);   // 亮牌浮层内容
      if (this.id === 'npcAvatar') this._rec.avatarHistory.push(v);  // NPC 表情 SVG（座位小头像）
      if (this.id === 'npcSpeakFace') this._rec.speakFaceHistory.push(v); // NPC 大娃娃的头像
      if (this.id === 'overBody') this._rec.overBodyHistory.push(v); // 结算明细
      if (this.id === 'log') this._rec.logHistory.push(v);
    }
  }
  get innerHTML() { return this._html; }
  get outerHTML() { return '<div class="' + this.className + '">' + this._html + '</div>'; }
  appendChild(c) {
    this._children.push(c); c.parentNode = this;
    if (this._rec) this._rec.appended.push(c.className || '');
    return c;
  }
  removeChild(c) { const i = this._children.indexOf(c); if (i >= 0) this._children.splice(i, 1); c.parentNode = null; return c; }
  // 事件要能"点下去"：只记不触发的话，靠 addEventListener 挂的交互（难度按钮、开始按钮）永远测不到。
  addEventListener(ev, cb) { (this._ev = this._ev || {})[ev] = (this._ev[ev] || []).concat([cb]); }
  _fire(ev, arg) {
    if (this.onclick && ev === 'click') this.onclick(arg || {});
    const hs = (this._ev || {})[ev] || [];
    hs.forEach((f) => f(arg || {}));
    return hs.length;
  }
  // 桩里没有布局，于是 centerOf 走"固定方向飞"的兜底分支（正是浏览器外的合理退化）
}

function makeEnv() {
  const rec = {
    classAdds: [], appended: [], sayHistory: [], speakHistory: [], speakFaceHistory: [],
    speakShown: 0, avatarHistory: [],
    npcShowHistory: [], overBodyHistory: [], logHistory: [], msgHistory: [],
  };
  const reg = {};
  const doc = {
    body: new El('body', rec),
    getElementById: (id) => (reg[id] || (reg[id] = new El(id, rec))),
    createElement: () => new El(null, rec),
    addEventListener: (ev, cb) => { if (ev === 'DOMContentLoaded') doc._ready = cb; },
  };
  return { rec: rec, reg: reg, doc: doc };
}

// ---------- 2. 定时器：手动队列，精确推进"第几拍" ----------
const realSetTimeout = global.setTimeout;
let q = [];
const queueTimer = (fn) => { q.push(fn); return q.length; };
const noTimer = () => 0;
const inlineTimer = (fn) => { fn(); return 0; };  // app.js 里的回调都不需要参数
// 队列里混着 toast/脉冲/胜率分片的"后台任务"，所以按条件推进：一直跑到 pred 成立为止
const flushUntil = (pred, cap) => {
  let n = 0;
  while (q.length && !pred() && n++ < (cap || 30)) { const f = q.shift(); if (f) f(); }
  return pred();
};
const clearQ = () => { q.length = 0; };

let fails = 0;
const ck = (name, got, want) => {
  const ok = String(got) === String(want);
  if (!ok) fails++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + ' = ' + got + (ok ? '' : ' （期望 ' + want + '）'));
};
const hasClass = (list, cls) => list.some((el) => el.classList.contains(cls));

// ---------- 2b. 语音已整体移除（回归锁） ----------
// 曾经用系统 TTS（speechSynthesis）朗读台词，2026-09-19 按用户要求砍掉：机械音不如没有。
// 这里**故意装上**一个能记录朗读的假 TTS 桩——这样断言就从"环境本来没 TTS 所以没声"
// 升级成"**环境明明有 TTS，代码也不许调它**"，移除才算真锁住（光靠环境缺失证明不了什么）。
const spoken = [];
global.SpeechSynthesisUtterance = function (text) { this.text = text; this.lang = ''; this.rate = 1; this.pitch = 1; };
global.speechSynthesis = {
  speak(u) { spoken.push({ text: String(u.text || ''), lang: u.lang }); },
  cancel() { /* 记数已无用（语音已移除），留空实现即可 */ },
};

// ---------- 3. Node/Electron 模式：require 内核 ----------
global.setTimeout = queueTimer;
const env = makeEnv();
global.document = env.doc;
const reg = env.reg, rec = env.rec;

const app = require(path.resolve(__dirname, 'electron/src/app.js'));
const T = app.__test;
if (!T) throw new Error('app.js 未导出 __test 测试入口');
if (typeof global.document._ready !== 'function') throw new Error('app.js 未注册 DOMContentLoaded');
const G = T.G, A = T.A, SFX = T.SFX;
if (!A) throw new Error('app.js 未加载 advisor.js');
if (!SFX) throw new Error('app.js 未加载 sfx.js');

T.setSimEnabled(false); // 胜率模拟默认关掉（否则每回合 300 局会拖慢冒烟测试）；下面有专门用例开它
T.setFirstMoveRandom(false); // 主流程测试关掉先手随机：保证玩家先手，避免 NPC 先手的在途回调污染后续用例
T.setAskDiff(false); // 开局难度询问默认关掉：主流程要的是"启动即开局"，询问流程下面有专门用例
T.setFirstRunPending(false); // 首玩帮助同理（否则 helpModal 会在断言中途弹出来）

global.document._ready(); // 触发 requestNewGame() → newGame()
const st0 = T.getState();
ck('桌面牌数', reg.table._children.length, 6);
ck('玩家手牌数', reg.playerHand._children.length, 4);
ck('NPC 手牌背面数', reg.npcHand._children.length, 4);
ck('补牌堆显示', reg.drawCount.textContent, 94);
ck('玩家手牌计数显示', reg.playerCount.textContent, 4);
ck('NPC 手牌计数显示', reg.npcCount.textContent, 4);
ck('罚牌计数显示', reg.pPen.textContent, 0);
ck('未选牌时确认按钮为禁用态', reg.controls._children[0].disabled, true);
ck('音效按钮有文案', String(reg.soundBtn.textContent).indexOf('音效') >= 0, true);
ck('NPC 卡通形象已画出（SVG）', String(reg.npcAvatar.innerHTML).indexOf('<svg') >= 0, true);
ck('NPC 开局用"大娃娃"打招呼（浮层弹出）', rec.speakShown > 0, true);
ck('大娃娃台词有内容', rec.speakHistory.length > 0, true);
ck('大娃娃也画了放大的卡通头像（SVG）', rec.speakFaceHistory.some((h) => h.indexOf('<svg') >= 0), true);
ck('首屏胜率面板为占位', reg.oddsWin.textContent, '—');

// ---------- 首玩引导（玩法说明） ----------
ck('首屏未看过玩法 → 自动弹出玩法说明', reg.helpModal.classList.contains('hidden'), false);
ck('玩法说明关闭按钮存在', typeof reg.helpClose, 'object');
T.hideHelp();
ck('关闭玩法说明后弹窗隐藏', reg.helpModal.classList.contains('hidden'), true);
T.showHelp();
ck('顶栏「❓ 玩法」可再次打开', reg.helpModal.classList.contains('hidden'), false);
T.hideHelp();

// ---------- 3b. 引擎与顾问：最优判断 / 结算明细 ----------
{
  const t = G.createGame({ numDecks: 2 });
  t.table = [G.makeCard('S', 5), G.makeCard('H', 2), G.makeCard('C', 2), G.makeCard('D', 2), G.makeCard('H', 3), G.makeCard('C', 3)];
  t.playerHand = [G.makeCard('H', 9), G.makeCard('S', 9), G.makeCard('C', 4), G.makeCard('D', 7)];
  const best = A.judgeMatch(t.playerHand, t.table, [t.playerHand[1].id], t.table[0].id);   // 9♠ + 5♠
  ck('最优判断：选最赚的一手 → optimal', best.optimal, true);
  ck('最优判断：给出本手收益', best.gain, 2);
  const bad = A.judgeMatch(t.playerHand, t.table, [t.playerHand[0].id], t.table[0].id);    // 9♥ + 5♠
  ck('最优判断：选差一手 → 非最优', bad.optimal, false);
  ck('最优判断：给出最赚那手的收益', bad.bestGain, 2);
  ck('最优判断：指出的更优解就是 9♠+5♠', bad.best.handCards[0].id, t.playerHand[1].id);

  const pen = A.judgePenalty(t.playerHand, t.table);
  ck('罚牌判断：明明有解 → 非最优', pen.optimal, false);
  ck('罚牌判断：真的无解（单张 K，桌上无 A）→ 最优', A.judgePenalty([G.makeCard('S', 13)], t.table).optimal, true);

  // 补桌面的判据（本轮重做过）：期望送分 = 这张牌的分值 × 对手能凑走它的概率
  // 概率用"未知牌池 + 精确枚举"算（不偷看对手手牌），方向必须是：牌值越大 → 对手要凑的目标越小 → 越难被吃走
  const fullCounts = A.poolCounts(A.defaultUnknownPool([], []));
  const pK = A.riskProbability(1, fullCounts, 4);    // 桌面放 K(13)，对手只需凑 1 → 只有"单张 A"一条路
  const pA = A.riskProbability(13, fullCounts, 4);   // 桌面放 A(1)，对手要凑 13 → K 单张、6+7、5+8… 路很多
  ck('风险概率方向：K 比 A 难被吃走', pK < pA, true);
  ck('风险概率：放 K 约 27%', Math.abs(pK - 0.268) < 0.02, true);
  ck('风险概率：放 A 约 62%', Math.abs(pA - 0.623) < 0.02, true);
  ck('风险概率：同一局面重复算结果一致（精确枚举，非抽样）', A.riskProbability(1, fullCounts, 4), pK);
  ck('风险概率：目标 ≤ 0（不可能凑出 0）时判 0', A.riskProbability(0, fullCounts, 4), 0);

  const t2 = G.createGame({ numDecks: 2 });
  t2.table = [G.makeCard('S', 5), G.makeCard('H', 2), G.makeCard('C', 9), G.makeCard('D', 3), G.makeCard('H', 6)];
  const hand = [G.makeCard('S', 9), G.makeCard('D', 2)];
  const ctx2 = { unknown: A.defaultUnknownPool(hand, t2.table), oppHandSize: 4 };
  const rj = A.judgeReplace(hand, t2.table, [], hand[0].id, ctx2);
  ck('补桌面判断：丢高分 9♠（1.00 分）→ 非最优', rj.optimal, false);
  ck('补桌面判断：建议的就是低分 2♦', rj.suggest.cardId, hand[1].id);
  ck('补桌面判断：给出可解释的两个数（自己的期望送分更大）', rj.chosen.cost > rj.suggest.cost, true);
  ck('补桌面判断：候选带上"预计被吃走百分比"', typeof rj.suggest.riskPct, 'number');
  ck('补桌面判断：选低分 2♦ → 最优', A.judgeReplace(hand, t2.table, [], hand[1].id, ctx2).optimal, true);

  // 结算明细：按花色/王统计张数与得分
  const det = G.scoreDetail([G.makeCard('S', 1), G.makeCard('S', 13), G.makeCard('H', 5), G.makeCard('D', 2), G.makeJoker(true), G.makeJoker(false)]);
  ck('明细：黑桃 2 张 = 2.00', det.bySuit.S.points, 2);
  ck('明细：红桃 1 张 = 0.75', det.bySuit.H.points, 0.75);
  ck('明细：方片 1 张 = 0.25', det.bySuit.D.points, 0.25);
  ck('明细：草花 0 张 = 0', det.bySuit.C.points, 0);
  ck('明细：大王 1 张 = 1.00', det.joker.big.points, 1);
  ck('明细：小王 1 张 = 0.75', det.joker.small.points, 0.75);
  ck('明细：合计张数', det.count, 6);
  ck('明细：合计得分', det.total, 4.75);
}

// ---------- 4. 罚牌（已简化）：选中恰好 1 张 → 一个按钮直接罚，没有模式跳转、也没有"返回" ----------
{
  clearQ();
  // 造一个必然无法匹配的局面：桌面全 K(13)，手牌全 Q(12)——12+13=25…凑不出 14
  st0.table = [G.makeCard('S', 13), G.makeCard('H', 13), G.makeCard('C', 13), G.makeCard('D', 13), G.makeCard('S', 13), G.makeCard('H', 13)];
  st0.playerHand = [G.makeCard('S', 12), G.makeCard('H', 12), G.makeCard('C', 12), G.makeCard('D', 12)];
  const drawBefore = st0.drawPile.length;
  T.playerTurnStart();
  ck('无解时仍停在选牌模式（不替玩家决定）', T.ui.mode, 'select');
  ck('无解标记已置位', T.ui.noMoves, true);
  ck('永远只有两个按钮（匹配 / 罚掉）', reg.controls._children.length, 2);
  ck('匹配按钮点明"当前凑不出"', reg.controls._children[0].textContent.indexOf('凑不出') >= 0, true);
  ck('提示语只警告、让玩家自己按', String(reg.message.textContent).indexOf('罚掉这张') >= 0, true);
  ck('无解时"确认匹配"为禁用态（点不动）', reg.controls._children[0].disabled, true);
  ck('没选牌时"罚掉"也是禁用态（必须先选 1 张）', reg.controls._children[1].disabled, true);
  ck('未选牌时罚牌按钮是通用文案', reg.controls._children[1].textContent.indexOf('选中的 1 张') >= 0, true);

  // 选 2 张 → 罚牌只能罚 1 张，按钮保持禁用
  T.onHandClick(st0.playerHand[0]);
  T.onHandClick(st0.playerHand[1]);
  ck('选 2 张时罚牌按钮禁用（只能罚 1 张）', reg.controls._children[1].disabled, true);
  ck('提示语说明罚牌只能罚 1 张', String(reg.message.textContent).indexOf('只能罚 1 张') >= 0, true);

  // 点掉一张 → 恰好 1 张，罚牌按钮启用，且写明罚的是哪张
  T.onHandClick(st0.playerHand[1]);
  ck('恰好选 1 张时罚牌按钮启用', reg.controls._children[1].disabled, false);
  ck('罚牌按钮写明了具体是哪张牌', reg.controls._children[1].textContent.indexOf('Q') >= 0, true);
  ck('选中后仍无"返回"按钮（不需要，再点一下就是取消）', reg.controls._children.length, 2);
  ck('罚牌全程不切换模式', T.ui.mode, 'select');

  T.doPenalty();
  ck('点罚牌直接进入飞牌动作（无中间模式）', T.ui.mode, 'penalizing');
  ck('罚牌飞走动画 penalty-out 已下发', hasClass(reg.playerHand._children, 'penalty-out'), true);
  ck('飞牌期间手牌还没被扣（先演后扣）', st0.playerHand.length, 4);

  flushUntil(() => st0.playerPenalty.length === 1);   // 跑完罚牌这一拍
  ck('罚牌后手牌自动补满 4 张', st0.playerHand.length, 4);
  ck('罚牌计数 +1', st0.playerPenalty.length, 1);
  ck('补牌堆相应减少 1 张', st0.drawPile.length, drawBefore - 1);
  ck('罚牌后渲染的手牌数一致', reg.playerHand._children.length, 4);
  ck('罚牌后选中已清空', T.ui.selHand.length, 0);
  ck('牌数守恒', G.totalCards(st0), 108);
  ck('无解罚牌记入决策且判为最优', T.getDecisions().optimal >= 1, true);

  // 有解时主动罚牌：同一个按钮照样能罚，日志会点出"其实能出"
  clearQ();
  st0.table = [G.makeCard('S', 5), G.makeCard('H', 5), G.makeCard('C', 5), G.makeCard('D', 5), G.makeCard('S', 9), G.makeCard('H', 9)];
  st0.playerHand = [G.makeCard('S', 9), G.makeCard('H', 9), G.makeCard('C', 9), G.makeCard('D', 9)];
  T.playerTurnStart();
  ck('有解时进入选牌模式', T.ui.mode, 'select');
  ck('有解时无解标记为假', T.ui.noMoves, false);
  T.onHandClick(st0.playerHand[0]);
  ck('有解也能选中 1 张准备罚掉', T.ui.selHand.length, 1);
  T.doPenalty();
  ck('有解罚牌被记一次决策', T.getDecisions().total > 0, true);
  ck('日志点出"其实能出"（不拦你，只提醒）', st0.log.some((l) => l.indexOf('不是最优') >= 0), true);
  flushUntil(() => T.ui.mode === 'idle', 8);
  ck('有解罚牌也先演后扣', T.ui.mode, 'idle');
}

// ---------- 4b. NPC 出牌六拍：指牌（压暗其余）→ 抬起 → 逐张翻牌 → 亮等式 → 合牌（手动队列逐拍验） ----------
{
  clearQ();
  global.document._ready();
  const st = T.getState();
  // 确定性局面：NPC 手上 S9/H3/C7/D10，桌面 C2/S5/H9/D3/H6/C8
  //   唯一两手：(S9+S5)=14 收 2 张；(S9+H3+C2)=14 收 3 张 → 贪心必选后者 → N=3，翻牌要走 3 拍
  st.table = [G.makeCard('C', 2), G.makeCard('S', 5), G.makeCard('H', 9), G.makeCard('D', 3), G.makeCard('H', 6), G.makeCard('C', 8)];
  st.npcHand = [G.makeCard('S', 9), G.makeCard('H', 3), G.makeCard('C', 7), G.makeCard('D', 10)];
  st.turn = 'npc';
  clearQ();
  T.npcTurn();
  ck('NPC 第 0 拍：先思考（还没指牌）', T.ui.mergePlan, null);
  ck('NPC 第 0 拍：思考表情已摆出', rec.avatarHistory.length > 0, true);

  // 第 ② 拍：箭头指着它看中的那张桌面牌，其余桌面牌全部压暗
  flushUntil(() => !!(T.ui.mergePlan && T.ui.mergePlan.stage === 'point'));
  ck('NPC 第 1 拍：进入"指着桌面牌"阶段', T.ui.mergePlan && T.ui.mergePlan.stage, 'point');
  ck('NPC 第 1 拍：目标牌被圈框圈住', hasClass(reg.table._children, 'ringed'), true);
  ck('NPC 第 1 拍：箭头元素已挂到牌上', rec.appended.indexOf('npc-arrow') >= 0, true);
  ck('NPC 第 1 拍：其余 5 张桌面牌被压暗', reg.table._children.filter((el) => el.classList.contains('dimmed')).length, 5);
  ck('NPC 第 1 拍：目标牌没被压暗', reg.table._children.filter((el) => el.classList.contains('dimmed') && el.classList.contains('ringed')).length, 0);
  ck('NPC 第 1 拍：提示语说明它看中了哪张', String(reg.message.textContent).indexOf('看中了桌面的') >= 0, true);
  ck('NPC 第 1 拍：还没抬起（stage 仍是 point）', T.ui.mergePlan.stage, 'point');
  ck('NPC 第 1 拍：还没亮牌浮层', String(reg.npcShow.innerHTML || '').length, 0);
  ck('NPC 第 1 拍：还没收牌（先演后收）', st.npcLoot.length, 0);

  // 第 ③ 拍：那张牌"抬起来"
  flushUntil(() => !!(T.ui.mergePlan && T.ui.mergePlan.stage === 'lift'));
  ck('NPC 第 2 拍：进入"抬起"阶段', T.ui.mergePlan.stage, 'lift');
  ck('NPC 第 2 拍：目标牌抬起 lifted 已下发', hasClass(reg.table._children, 'lifted'), true);
  ck('NPC 第 2 拍：其余牌仍然压暗', reg.table._children.filter((el) => el.classList.contains('dimmed')).length, 5);
  ck('NPC 第 2 拍：日志记下"抬手要了哪张"', st.log.some((l) => l.indexOf('抬手要了桌面的') >= 0), true);
  ck('NPC 第 2 拍：仍然没收牌', st.npcLoot.length, 0);

  // 第 ④ 拍：弹模态浮层，逐张翻牌（每翻一张重建一次浮层内容）
  const cardsIn = (html) => (String(html).match(/class="card/g) || []).length;
  const snapAt = (k) => rec.npcShowHistory.filter((h) => String(h).indexOf('（' + k + '/3）') >= 0).pop();
  flushUntil(() => !!(T.ui.mergePlan && T.ui.mergePlan.stage === 'flip'));
  ck('NPC 第 3 拍：进入"逐张翻牌"阶段', T.ui.mergePlan.stage, 'flip');
  ck('NPC 第 3 拍：浮层已弹出（写明第 1/3 张）', String(reg.npcShow.innerHTML).indexOf('（1/3）') >= 0, true);
  ck('NPC 第 3 拍：翻牌动画 flip-in 已下发', rec.classAdds.indexOf('flip-in') >= 0, true);
  ck('NPC 第 3 拍：浮层整屏压暗（masked）', reg.npcShow.classList.contains('masked'), true);
  ck('NPC 第 3 拍：此刻只翻出 1 张', cardsIn(reg.npcShow.innerHTML), 1);
  ck('NPC 第 3 拍：等式还没出现（等你先看清牌）', String(reg.npcShow.innerHTML).indexOf('= 14'), -1);
  ck('NPC 第 3 拍：仍然没收牌', st.npcLoot.length, 0);

  flushUntil(() => !!snapAt(2));
  ck('NPC 第 4 拍：翻到第 2/3 张', cardsIn(snapAt(2)), 2);
  flushUntil(() => !!snapAt(3));
  ck('NPC 第 5 拍：翻到第 3/3 张', cardsIn(snapAt(3)), 3);
  ck('NPC 第 5 拍：桌面那张最后翻出并被标出 is-target', String(snapAt(3)).indexOf('is-target') >= 0, true);

  // 第 ⑤ 拍：等式与得分亮出，停够你读完
  flushUntil(() => !!(T.ui.mergePlan && T.ui.mergePlan.stage === 'read'));
  ck('NPC 第 6 拍：进入"亮等式"阶段', T.ui.mergePlan.stage, 'read');
  ck('NPC 第 6 拍：等式写进浮层', String(reg.npcShow.innerHTML).indexOf('= 14') >= 0, true);
  ck('NPC 第 6 拍：得分写进浮层', String(reg.npcShow.innerHTML).indexOf('收获 3 张') >= 0, true);
  ck('NPC 第 6 拍：仍然没收牌（等式读完才收）', st.npcLoot.length, 0);

  // 第 ⑥ 拍：合牌收走
  flushUntil(() => !!(T.ui.mergePlan && T.ui.mergePlan.stage === 'merge'));
  ck('NPC 第 7 拍：进入"合牌"阶段', T.ui.mergePlan.stage, 'merge');
  ck('NPC 第 7 拍：浮层进入收拢 merging', reg.npcShow.classList.contains('merging'), true);
  ck('NPC 第 7 拍：目标牌爆金光 merge-target 已下发', hasClass(reg.table._children, 'merge-target'), true);
  ck('NPC 第 7 拍：仍然没收牌（合牌演完才入账）', st.npcLoot.length, 0);
  ck('NPC 六拍日志齐全（指着→抬起→亮牌→合牌）',
    st.log.some((l) => l.indexOf('看中了桌面的') >= 0) &&
    st.log.some((l) => l.indexOf('抬手要了桌面的') >= 0) &&
    st.log.some((l) => l.indexOf('🤖 NPC 亮牌：') >= 0 && l.indexOf('= 14') >= 0) &&
    st.log.some((l) => l.indexOf('🔗 NPC 合牌收走') >= 0), true);

  // 跑完入账
  flushUntil(() => st.npcLoot.length > 0, 12);
  ck('NPC 最后：真正入账 3 张', st.npcLoot.length, 3);
  ck('NPC 六拍后牌数守恒', G.totalCards(st), 108);
  flushUntil(() => T.ui.mergePlan === null, 16);
  ck('NPC 回合结束后演出状态已清空', T.ui.mergePlan, null);
  ck('NPC 回合结束后压暗与浮层都已收掉',
    reg.table._children.filter((el) => el.classList.contains('dimmed')).length, 0);
}

// ---------- 5. 匹配分步演出：圈住 → 手牌飞过去合拢 → 收进战利品（含最优判断） ----------
{
  clearQ();
  global.document._ready(); // 重开一局
  const st = T.getState();
  // 构造确定性局面：桌面 5♠ 可配两手，9♠(1分) 比 9♥(0.75) 更赚 → 用来验"是否最优"
  st.table = [G.makeCard('S', 5), G.makeCard('H', 2), G.makeCard('C', 2), G.makeCard('D', 2), G.makeCard('H', 3), G.makeCard('C', 3)];
  st.playerHand = [G.makeCard('H', 9), G.makeCard('S', 9), G.makeCard('C', 4), G.makeCard('D', 7)];
  st.playerLoot = [];
  const decBefore = T.getDecisions().total;
  T.playerTurnStart();

  // 先选"次优"的那手（9♥+5♠），验证界面会当场指出
  const tableFive = st.table[0];
  T.ui.selHand = [st.playerHand[0].id];
  T.ui.selTable = tableFive.id;
  T.updateSelectSum();
  T.renderAll();
  ck('选定后确认按钮启用', reg.controls._children[0].disabled, false);
  ck('桌面牌被圈框圈住（ringed）', hasClass(reg.table._children, 'ringed'), true);
  ck('和 = 14 时圈框不是警告色', hasClass(reg.table._children, 'ring-bad'), false);
  T.confirmMatch();
  ck('次优出牌被记一次决策', T.getDecisions().total, decBefore + 1);
  ck('日志指出"不是最优"', st.log.some((l) => l.indexOf('⚠️ 不是最优') >= 0), true);
  ck('日志给出更赚的那手（9♠+5♠）', st.log.some((l) => l.indexOf('能多拿') >= 0 && l.indexOf('= 14') >= 0), true);
  ck('合牌第 1 拍：圈选锁定 ring-lock', hasClass(reg.table._children, 'ring-lock'), true);
  ck('合牌期间不漏出"死按钮"', reg.controls._children.length, 0);
  ck('第 1 拍还没收牌（先演后收）', st.playerLoot.length, 0);

  flushUntil(() => !!(T.ui.mergePlan && T.ui.mergePlan.stage === 'merge'));
  ck('第 2 拍：手牌朝桌面牌飞（merge-to）', hasClass(reg.playerHand._children, 'merge-to'), true);
  ck('第 2 拍：被圈的牌进入合牌膨胀（merge-target）', hasClass(reg.table._children, 'merge-target'), true);

  flushUntil(() => T.ui.mode === 'replace');
  ck('第 3 拍：战利品入账 2 张', st.playerLoot.length, 2);
  ck('第 3 拍：转入"选 1 张补桌面"', T.ui.mode, 'replace');
  ck('第 3 拍：合牌计划已清空', T.ui.mergePlan, null);
  ck('收牌后渲染与数据一致', reg.playerHand._children.length, st.playerHand.length);
  ck('手牌不残留飞牌动画类', hasClass(reg.playerHand._children, 'merge-to'), false);
  ck('牌数守恒', G.totalCards(st), 108);

  // 补桌面那一拍：故意丢最高分的 9♠（桌上 5♠ 一张牌就能吃走它）→ 应判非最优
  const decBefore2 = T.getDecisions().total;
  const bigCard = st.playerHand.find((c) => c.rank === 9);
  T.onHandClick(bigCard);
  ck('补桌面也记一次决策', T.getDecisions().total, decBefore2 + 1);
  ck('补桌面日志给出建议', st.log.some((l) => l.indexOf('补牌到桌面') >= 0), true);
  ck('补牌阶段无残留死按钮', reg.controls._children.length, 0);
  ck('补牌阶段手牌渲染一致', reg.playerHand._children.length, st.playerHand.length);
  ck('牌数守恒（补桌面后）', G.totalCards(st), 108);
}

// ---------- 6. Node 模式端到端：自动玩家 + 同步定时器跑完一整局 ----------
{
  clearQ();
  global.setTimeout = inlineTimer; // 让 NPC 的分步流程立即跑完，真正被覆盖到
  global.document._ready();        // 重新开局
  const st = T.getState();
  let guard = 0, worstHand = 0, renderMismatch = 0, turns = 0, penTurns = 0, sayTotal = 0;
  while (st.phase !== 'gameover' && guard++ < 500) {
    turns++;
    const moves = G.findMoves(st.playerHand, st.table);
    if (moves.length === 0) {
      penTurns++;
      T.ui.selHand = [st.playerHand[0].id];   // 无解 → 玩家自己选中 1 张
      T.doPenalty();                          // 再按罚牌（无需任何模式切换）
    } else {
      const m = moves[0];
      T.ui.selHand = m.handCards.map((c) => c.id);   // 等价于玩家点牌 + 点桌面牌
      T.ui.selTable = m.tableCard.id;
      T.updateSelectSum();
      T.confirmMatch();
      if (T.ui.mode === 'replace') T.onHandClick(st.playerHand[0]); // 补 1 张到桌面
    }
    if (reg.playerHand._children.length !== st.playerHand.length) renderMismatch++;
    if (reg.table._children.length !== st.table.length) renderMismatch++;
    if (reg.npcHand._children.length !== st.npcHand.length) renderMismatch++;
    if (G.totalCards(st) !== 108) renderMismatch++;
    if (st.playerHand.length > 4) worstHand = Math.max(worstHand, st.playerHand.length);
  }
  ck('整局跑完（终局）', st.phase, 'gameover');
  ck('双方手牌耗尽', st.playerHand.length + st.npcHand.length, 0);
  ck('终局牌数守恒', G.totalCards(st), 108);
  ck('每回合渲染与数据一致（0 处不符）', renderMismatch, 0);
  ck('手牌从不超过 4 张', worstHand, 0);
  ck('终局弹窗已弹出', reg.overModal.classList.contains('hidden'), false);
  console.log('       （本局共 ' + turns + ' 个玩家回合，其中罚牌 ' + penTurns + ' 次；玩家 ' +
    G.computeScore(st, 'player') + ' : NPC ' + G.computeScore(st, 'npc') + '）');
  ck('补牌入场动画 in-hand 已触发', rec.classAdds.indexOf('in-hand') >= 0, true);
  ck('落桌动画 in-table 已触发', rec.classAdds.indexOf('in-table') >= 0, true);
  ck('浮动提示已弹出', rec.appended.filter((x) => /(^|\s)toast(\s|$)/.test(x)).length > 0, true);
  ck('补牌堆数字跳动已触发', rec.classAdds.indexOf('pulse') >= 0, true);

  // NPC 演出三拍：指牌 → 逐张翻牌 → 合牌
  const npcPoints = st.log.filter((l) => l.indexOf('👀 NPC 看中了桌面的') >= 0).length;
  const npcPlays = st.log.filter((l) => l.indexOf('🤖 NPC 亮牌：') >= 0).length;
  ck('NPC 每轮匹配都先箭头指牌（指着日志 > 0）', npcPoints > 0, true);
  ck('NPC 每轮匹配都有亮牌演出（亮牌日志 > 0）', npcPlays > 0, true);
  ck('亮牌浮层展示了凑 14 的等式', st.log.some((l) => l.indexOf('🤖 NPC 亮牌：') >= 0 && l.indexOf(' = 14') >= 0), true);
  ck('亮牌浮层 DOM 已填充（出现过逐张翻牌）', rec.npcShowHistory.some((h) => h.indexOf('一张张翻牌') >= 0), true);
  ck('亮牌浮层里的牌真的带上了动画类（已翻的静止、最新翻的有 flip-in）',
    rec.npcShowHistory.some((h) => h.indexOf('flip-in') >= 0), true);
  ck('指牌日志与亮牌日志数量一致（每轮都完整走三拍）', npcPoints, npcPlays);
  ck('NPC 翻牌动画 flip-in 已下发', rec.classAdds.indexOf('flip-in') >= 0, true);
  ck('NPC 合牌阶段已标记 merging', rec.classAdds.indexOf('merging') >= 0, true);
  ck('NPC 合牌日志已记录', st.log.some((l) => l.indexOf('🔗 NPC 合牌收走') >= 0), true);

  // NPC 卡通形象 + 台词
  sayTotal = rec.sayHistory.length;
  ck('NPC 说过话（台词气泡有内容）', sayTotal > 0, true);
  ck('NPC 表情变过（不止一种 mood）', new Set(rec.avatarHistory).size >= 2, true);
  ck('NPC 会对局势放话（捞王/大赚/罚牌/场面话之一）',
    ['王归我', '赚到', '一网打尽', '认罚', '凑不出', '忍一手', '拿走不谢', '归我了', '正好凑够', '等好几轮', '没牌了', '残局', '见底', '牌堆', '领先', '别得意', '找找机会', '耐', '扎眼', '顺']
      .some((k) => rec.sayHistory.some((s) => s.indexOf(k) >= 0)), true);

  // 最优判断贯穿整局
  const dec = T.getDecisions();
  ck('整局每步决策都被记分', dec.total >= turns, true);
  ck('整局日志里有最优判断记录', st.log.some((l) => l.indexOf('📈 最优判断') >= 0), true);

  // 结算：算分过程明细
  const body = reg.overBody._html || '';
  ck('结算含"你的算分过程"', body.indexOf('你的算分过程') >= 0, true);
  ck('结算含"NPC 的算分过程"', body.indexOf('NPC 的算分过程') >= 0, true);
  ck('结算摊开花色明细（黑桃）', body.indexOf('黑桃') >= 0, true);
  ck('结算摊开王明细（大王/小王）', body.indexOf('大王') >= 0 && body.indexOf('小王') >= 0, true);
  ck('结算给出"战利品 − 罚牌 = 得分"', body.indexOf('战利品合计') >= 0 && body.indexOf('罚牌合计') >= 0 && body.indexOf('战利品 − 罚牌') >= 0, true);
  ck('结算给出决策正确率', body.indexOf('正确率') >= 0, true);
  ck('结算有明细历史记录', rec.overBodyHistory.some((h) => h.indexOf('战利品合计') >= 0), true);
}

// ---------- 7. 动画期间点"新游戏"：在途回调必须作废，不能污染新牌局 ----------
{
  clearQ();
  global.setTimeout = queueTimer;
  global.document._ready();
  const st = T.getState();
  st.table = [G.makeCard('S', 5), G.makeCard('H', 5), G.makeCard('C', 5), G.makeCard('D', 5), G.makeCard('S', 9), G.makeCard('H', 9)];
  st.playerHand = [G.makeCard('S', 9), G.makeCard('H', 9), G.makeCard('C', 9), G.makeCard('D', 9)];
  st.playerLoot = [];
  T.playerTurnStart();
  const mv2 = G.findMoves(st.playerHand, st.table)[0];
  T.ui.selHand = mv2.handCards.map((c) => c.id);
  T.ui.selTable = mv2.tableCard.id;
  T.updateSelectSum();
  T.confirmMatch();                       // 进入合牌，第 2/3 拍还排在队列里
  ck('合牌途中确实还有在途回调', q.length > 0, true);

  global.document._ready();               // 中途点"新游戏"
  const st2 = T.getState();
  flushUntil(() => false, 6);             // 把旧回调全部放出来跑
  ck('重开后旧合牌回调不污染新牌局（牌数守恒）', G.totalCards(st2), 108);
  ck('重开后手牌仍是 4 张', st2.playerHand.length, 4);
  ck('重开后回合状态合法（测试已关随机先手→玩家先手）', st2.turn, 'player');
  ck('重开后战利品为空', st2.playerLoot.length, 0);
  ck('重开后决策统计已归零', T.getDecisions().total, 0);
}

// ---------- 7b. 先手随机化（独立验证，不污染上面的确定性用例） ----------
{
  // 主流程把随机先手关了，这里单独验证内核真能随机：两种先手都该出现，且大致各半
  let npc = 0, player = 0;
  const N = 4000;
  for (let i = 0; i < N; i++) {
    const g = G.createGame({ numDecks: 2, firstRandom: true });
    if (g.turn === 'npc') npc++; else player++;
  }
  ck('随机先手：两种先手都出现过', (npc > 0 && player > 0), true);
  const ratio = npc / N;
  ck('随机先手：NPC 先手比例约 50%（实际 ' + (ratio * 100).toFixed(1) + '%）', Math.abs(ratio - 0.5) < 0.05, true);
}

// ---------- 8. 胜率估计：真的算得对（这里才打开模拟） ----------
{
  clearQ();
  global.setTimeout = queueTimer;
  global.document._ready();
  const st = T.getState();

  // 造一个"结果已经锁定"的领先局面：领先 11.75 分，而场上可再分配的牌最多只值 2 分，
  // 无论怎么重洗都不可能翻盘 → 胜率必须正好是 100%（用确定性局面断言，不靠概率过关）
  st.playerLoot = [];
  for (let i = 0; i < 12; i++) st.playerLoot.push(G.makeCard('S', 13));   // 12.00
  st.npcLoot = [G.makeCard('D', 2)];                                      // 0.25
  st.playerPenalty = []; st.npcPenalty = [];
  st.drawPile = [];                                                       // 残局：不再补牌
  st.table = [G.makeCard('S', 9), G.makeCard('H', 9)];                    // 场上全部剩余价值 ≤ 2
  st.playerHand = [G.makeCard('H', 2)];                                   // 2+9=11，谁也配不出 14
  st.npcHand = [G.makeCard('H', 2)];
  st.turn = 'player';
  // 模拟必须是只读的：跑之前把各区域的牌 id 与顺序记下来，跑完逐字比对
  const zoneIds = () => JSON.stringify([
    st.table.map((c) => c.id), st.playerHand.map((c) => c.id), st.npcHand.map((c) => c.id),
    st.drawPile.map((c) => c.id), st.playerLoot.map((c) => c.id), st.npcLoot.map((c) => c.id),
    st.playerPenalty.map((c) => c.id), st.npcPenalty.map((c) => c.id),
  ]);
  const snapBefore = zoneIds();
  const lead = A.simulateWinRate(st, 60);
  ck('结果已锁定的领先局面 → 胜率 100%', lead.winRate, 1);
  ck('锁定局面不会有负/平', lead.loseRate + lead.drawRate, 0);
  ck('模拟局数正确', lead.n, 60);
  ck('三种结果占比之和 = 1', Math.abs(lead.winRate + lead.loseRate + lead.drawRate - 1) < 1e-9, true);

  // 估计器本身的稳定性：固定同一副发牌重复估，结果必须收敛。
  // 注意别写成"对某一次随机发牌断言胜率落在窄区间"——发牌差异本身就有 30%~60% 的跨度
  // （实测 25 副牌各估一次：min 30.5% / max 59.8%），那样写必然是偶发失败。
  // 游戏整体的平衡性由 sim-test.js 的 2000 局统计来保证。
  // 阈值 18 个百分点：实测 400 局 × 4 次的极差最坏约 9.7pp（60 组采样），留了近 2 倍余量
  const fresh = G.createGame({ numDecks: 2 });
  const reps = [];
  for (let i = 0; i < 4; i++) reps.push(A.simulateWinRate(fresh, 400).winRate);
  const lo = Math.min.apply(null, reps), hi = Math.max.apply(null, reps);
  ck('同一副牌重复估计稳定（极差 < 18 个百分点）', (hi - lo) < 0.18, true);
  ck('重复估计都落在合理区间（20%~80%）', lo > 0.2 && hi < 0.8, true);
  console.log('       （固定一副牌 × 400 局 × 4 次：' +
    reps.map((r) => (r * 100).toFixed(1) + '%').join(' / ') + '）');
  ck('模拟是只读的（真局面的牌一张没动、顺序没变）', zoneIds() === snapBefore, true);

  // 胜率模拟必须跟着难度档走：同一副牌，NPC 按 hell 打时玩家胜率应明显低于按 medium 打。
  // （模拟是只读的，同一副牌各跑一遍；实测空场差距巨大：medium ≈53%，hell ≈8%，400 局足够区分）
  const sameDeal = G.createGame({ numDecks: 2 });
  const med = A.simulateWinRate(sameDeal, 400, undefined, 'medium').winRate;
  const hel = A.simulateWinRate(sameDeal, 400, undefined, 'hell').winRate;
  ck('模拟按难度走：同一副牌 hell 档玩家胜率低于 medium 档（' + (med * 100).toFixed(1) + '% → ' + (hel * 100).toFixed(1) + '%）',
    hel < med - 0.1, true);

  // 界面分片跑：打开开关 → 刷新 → 把分片任务放出来
  T.setSimEnabled(true);
  T.refreshOdds(true);
  flushUntil(() => T.getOdds().done >= 300, 12);
  ck('分片算完 300 局', T.getOdds().n, 300);
  ck('面板显示胜率百分比', /%$/.test(String(reg.oddsWin.textContent)), true);
  ck('面板显示模拟局数', reg.oddsN.textContent, '300 局');
  ck('胜率条已渲染三段', String(reg.oddsBar.innerHTML).indexOf('odds-me') >= 0 && String(reg.oddsBar.innerHTML).indexOf('odds-npc') >= 0, true);
  T.setSimEnabled(false);
}

// ---------- 9. 音效：环境无音频时必须静默降级（不抛异常） ----------
{
  let threw = null;
  try {
    ['tap', 'ring', 'flip', 'match', 'joker', 'draw', 'penalty', 'npc', 'win', 'lose', 'drawEnd', 'unlock']
      .forEach((k) => SFX[k] && SFX[k]());
    T.toggleSound();   // 静音开关
    T.toggleSound();
  } catch (e) { threw = e.message; }
  ck('无声卡环境下音效调用不抛异常', threw, null);
  ck('静音开关能往返', typeof SFX.isMuted(), 'boolean');
}

// ---------- 9b. 语音已移除：即使环境支持 TTS 也一个字不能读出来 ----------
{
  // 台词停留时长仍按字数动态算（这是"看得清"的保障，和语音无关）
  const shortT = T.sayDur('嘿嘿');
  const longT = T.sayDur('那两张王本来是我的，你怎么能这样嘛！');
  ck('台词停留按时长（长句留得比短句久）', longT > shortT, true);
  ck('短句停留有下限（不会一闪而过）', shortT >= 2800, true);
  ck('超长台词有上限（不会卡住牌桌）', T.sayDur('王'.repeat(300)) <= 12000, true);

  clearQ();
  global.setTimeout = queueTimer;

  // 核心断言：环境明明装了 TTS 桩（speechSynthesis 存在），代码也不许调用它
  const before = spoken.length;
  T.npcSay('npcJoker', 1);
  T.npcSay('npcPenalty', 1);
  T.npcSay('overWin', 1);
  ck('语音已移除：说话不触发任何 TTS 朗读', spoken.length, before);

  // 接口层面也得干净：sfx.js 不再导出语音相关方法
  ck('sfx.js 不再导出 say()', typeof SFX.say, 'undefined');
  ck('sfx.js 不再导出 voiceSupported()', typeof SFX.voiceSupported, 'undefined');
  ck('sfx.js 不再导出 toggleVoice()', typeof SFX.toggleVoice, 'undefined');
  ck('sfx.js 不再导出 cancelSay()', typeof SFX.cancelSay, 'undefined');
  ck('app.js 不再暴露 toggleVoice()', typeof T.toggleVoice, 'undefined');
  // 顶栏也不该再有语音按钮（两个 HTML 都查）
  const fs2 = require('fs');
  const path2 = require('path');
  const idxHtml = fs2.readFileSync(path2.resolve(__dirname, 'electron/src/index.html'), 'utf8');
  const playHtml = fs2.readFileSync(path2.resolve(__dirname, 'play.html'), 'utf8');
  ck('index.html 无语音按钮', idxHtml.indexOf('voiceBtn') < 0, true);
  ck('play.html 无语音按钮', playHtml.indexOf('voiceBtn') < 0, true);

  // 源码级兜底：光查"接口没导出"不够——只要有人在 app.js 里再写一句 speechSynthesis.speak()
  // 而不经过任何导出方法，接口断言就抓不到。所以直接扫全部产品文件的关键词。
  // 刻意**只放在这一处**（不往 mini-test 再复制一份）：扫描范围已经覆盖小程序文件，
  // 复制过去只会多一个"改一边忘另一边"的漂移点——正是我这轮反复踩的坑。
  const VOICE_RE = /speechSynthesis|SpeechSynthesisUtterance|voiceSupported|toggleVoice|voiceBtn|h14_voice/;
  const prodFiles = [
    'electron/src/app.js', 'electron/src/index.html', 'electron/src/style.css', 'play.html',
    'sfx.js', 'miniprogram/utils/sfx.js', 'miniprogram/pages/game/game.js',
    'miniprogram/pages/game/game.wxml', 'miniprogram/pages/game/game.wxss',
    'game-core.js', 'advisor.js',
  ];
  const dirty = prodFiles.filter((f) => VOICE_RE.test(fs2.readFileSync(path2.resolve(__dirname, f), 'utf8')));
  ck('产品代码里没有任何语音残留（源码级扫描 ' + prodFiles.length + ' 个文件）', dirty.join(', ') || '干净', '干净');

  // 台词照样显示（只是不出声）
  const bubbleBefore = rec.speakHistory.length + rec.sayHistory.length;
  T.npcSay('npcPenalty', 1);
  ck('没有语音，台词照常显示出来', rec.speakHistory.length + rec.sayHistory.length > bubbleBefore, true);
}

// ---------- 9c. NPC 卡通形象：一只歪戴棒球帽的小痞机器人，表情真的会变 ----------
{
  // 通过大娃娃浮层间接取各表情的 SVG（showNpcSpeak 会按 mood 画头像）
  const faceFor = (mood) => { T.showNpcSpeak('测试', mood); return String(rec.speakFaceHistory[rec.speakFaceHistory.length - 1] || ''); };
  const idle = faceFor('idle'), greedy = faceFor('greedy'), sad = faceFor('sad'),
        happy = faceFor('happy'), shock = faceFor('shock'), think = faceFor('think');

  ck('形象是矢量的（内联 SVG）', idle.indexOf('<svg') >= 0, true);
  ck('戴着棒球帽（帽体）', idle.indexOf('Q36 3 58 22') >= 0, true);
  ck('帽檐是翘起来的（旋转的椭圆）', idle.indexOf('rotate(-16 56 17)') >= 0, true);
  ck('有天线小灯泡', idle.indexOf('cx="36" cy="5"') >= 0, true);
  ck('戴着耳机（两侧圆）', idle.indexOf('cx="12.5" cy="38"') >= 0 && idle.indexOf('cx="59.5" cy="38"') >= 0, true);
  ck('大脑袋是圆角方块（不是普通圆脸）', idle.indexOf('<rect x="12" y="19"') >= 0, true);
  ck('叼着牙签（idle 特有的一根斜线）', idle.indexOf('#e0b74a') >= 0, true);
  ck('贪心时换成星星眼（金色四角星）', greedy.indexOf('#ffcf4d') >= 0 && greedy !== idle, true);
  ck('沮丧时掉眼泪', sad.indexOf('#8fd0ff') >= 0, true);
  ck('六种表情互不相同（不是同一张脸换个底色）',
    new Set([idle, greedy, sad, happy, shock, think]).size, 6);
  ck('座位头像画的就是同一套形象（含帽子）', String(reg.npcAvatar.innerHTML).indexOf('Q36 3 58 22') >= 0, true);
}

// ---------- 9d. 实时比分：不用等结算就能看到当前得分与领先方 ----------
{
  clearQ();
  global.setTimeout = queueTimer;
  global.document._ready();
  const st = T.getState();
  ck('开局比分显示 0.00', reg.scoreMe.textContent, '0.00');
  ck('开局领先提示为打平', String(reg.scoreLead.textContent).indexOf('打平') >= 0, true);

  // 给玩家塞一批黑桃（每张 1 分）→ 比分必须立刻反映出来
  st.playerLoot = [G.makeCard('S', 13), G.makeCard('S', 13), G.makeCard('S', 13)];   // 3.00
  st.npcLoot = [G.makeCard('D', 2)];                                                 // 0.25
  T.renderAll();
  ck('比分实时反映玩家得分', reg.scoreMe.textContent, '3.00');
  ck('比分实时反映 NPC 得分', reg.scoreNpc.textContent, '0.25');
  ck('领先提示写明领先多少', String(reg.scoreLead.textContent).indexOf('2.75') >= 0, true);
  ck('领先时样式标为 me', reg.scoreLead.classList.contains('me'), true);

  // NPC 反超
  st.playerLoot = [G.makeCard('D', 2)];
  st.npcLoot = [G.makeCard('S', 13), G.makeCard('S', 13)];
  T.renderAll();
  ck('NPC 反超时比分更新', reg.scoreNpc.textContent, '2.00');
  ck('NPC 领先时样式标为 npc', reg.scoreLead.classList.contains('npc'), true);
  ck('NPC 领先文案正确', String(reg.scoreLead.textContent).indexOf('NPC 领先') >= 0, true);

  // 罚牌要扣分（不是只数张数）
  st.playerLoot = [G.makeCard('S', 13)];   // 1.00
  st.playerPenalty = [G.makeCard('S', 13)]; // -1.00
  T.renderAll();
  ck('罚牌从比分里扣掉（1.00 − 1.00 = 0）', reg.scoreMe.textContent, '0.00');
}

// ---------- 9e. 布局与配色：两版必须同一套色板（防"改了 Web 忘了小程序"的漂移） ----------
// 判据实现在 style-check.js 里，mini-test.js 调的是同一份——避免断言在两处抄两遍、改一处漏一处
require(path.resolve(__dirname, 'style-check.js')).checkStyle(
  (p) => fs.readFileSync(p, 'utf8'), __dirname, ck);

// ---------- 10. 连开 30 局，确认渲染稳定 ----------
try {
  clearQ();
  for (let i = 0; i < 30; i++) global.document._ready();
  console.log('PASS  连开 30 局新游戏，渲染无异常');
} catch (e) {
  fails++;
  console.log('FAIL  连开新游戏抛异常: ' + e.message);
}

// ---------- 11. 开局难度询问（第五档「自适应」已移除，见 ③ 的回归锁） ----------
try {
  // ① 询问层：默认停在当前档；选档只是选中，点「开始」才真生效
  T.setDifficulty('medium');
  T.setAskDiff(true);
  clearQ();
  T.openDiffAsk();
  ck('开局询问层已弹出', T.isAskDiffOpen(), true);
  ck('询问层默认停在当前档', T.getPendingDiff(), 'medium');
  T.pickAskDiff('hell');
  ck('选档只是改选中，难度还没变', T.getDifficulty(), 'medium');
  ck('选中项已切到 hell', T.getPendingDiff(), 'hell');
  T.confirmDiffAsk();
  ck('点开始后难度才真改', T.getDifficulty(), 'hell');
  ck('点开始后询问层关闭', T.isAskDiffOpen(), false);
  ck('点开始后开了新局（牌数守恒）', G.totalCards(T.getState()), 108);
  ck('新局桌面 6 张', T.getState().table.length, 6);

  // ② 勾了「别再问」就不再弹：requestNewGame 直接开局
  T.setAskDiff(false);
  const before = T.getState();
  T.requestNewGame();
  ck('不再问时 requestNewGame 直接开局', T.getState() !== before, true);
  ck('不再问时不弹询问层', T.isAskDiffOpen(), false);
  T.setAskDiff(true);   // 复原

  // ③ 「自适应」第 5 档已移除：只剩四档，而且选到不存在的档必须被忽略（不能把界面打崩）
  ck('内核只剩四档（易/中/难/地狱）', G.DIFFICULTIES.length, 4);
  T.setDifficulty('medium');
  T.setDifficulty('adaptive');
  ck('选不存在的档位被忽略，难度不变', T.getDifficulty(), 'medium');
  T.renderDiff();
  ck('侧栏难度说明仍能正常渲染', String(reg.diffDesc.textContent).length > 0, true);

  // ⑥ HTML 静态检查：四档按钮要真的写进页面（侧栏一段 + 开局询问一段 = 2 处 × 4 个）
  // 桩没有 querySelectorAll（那是真实 DOM 的能力），所以这里直接查文件，反而更贴近"用户看得到什么"
  const countDiffBtns = (s) => (s.match(/data-diff="/g) || []).length;
  for (const f of ['electron/src/index.html', 'play.html']) {
    const html = fs.readFileSync(path.resolve(__dirname, f), 'utf8');
    ck(f + ' 里四档按钮齐全（侧栏 + 询问层）', countDiffBtns(html), 8);
    ck(f + ' 里已无自适应档按钮', html.indexOf('data-diff="adaptive"') < 0, true);
    ck(f + ' 里有开局询问层', html.indexOf('id="diffModal"') >= 0, true);
  }

  // ⑦ 「再来一局」卡死修复的回归锁：结算层开着时点新游戏，询问层必须弹出、结算层必须被关掉。
  //    （此前两层同为 .modal z-index 99，DOM 序在后的结算层把询问层压在底下 → 用户看到"点了没反应"）
  T.setAskDiff(true);
  T.setDifficulty('medium');
  T.newGame();
  T.showOver();   // 伪造"本局结束、结算层开着"的状态
  ck('前置：结算层已弹出', reg.overModal.classList.contains('hidden'), false);
  T.requestNewGame();
  ck('结算层开着点新游戏 → 询问层弹出', T.isAskDiffOpen(), true);
  ck('结算层开着点新游戏 → 结算层被关掉', reg.overModal.classList.contains('hidden'), true);
  T.confirmDiffAsk();   // 收尾：真开一局，别把弹层留给后面的用例
  ck('询问层点开始 → 正常开局（牌数守恒）', G.totalCards(T.getState()), 108);

  // ⑧ 先手宣告：开局大字亮一下谁先手（用户：确定谁先手后要显示，不然太突兀）
  clearQ();
  T.newGame();
  const fb = reg.firstBanner;
  ck('先手宣告已弹出', fb.classList.contains('hidden'), false);
  ck('先手宣告文字与实际先手一致', String(reg.firstBannerText.textContent), T.getState().turn === 'player' ? '你先手' : 'NPC 先手');
  flushUntil(() => fb.classList.contains('hidden'), 10);
  ck('先手宣告约 1.6 秒后自动淡出', fb.classList.contains('hidden'), true);

  // ⑨ NPC 罚牌的两条轴（记牌版回归锁，2026-09-23 重写；旧版"价格−0.06×点数"是点数代理，已废弃）。
  //    判据 = 花色分 + playW × 可玩性；可玩性 = 穷尽"这张牌现在还能不能凑成 14"，0 = 两跳以上（该先罚）。
  //    ① 两张都还活着 → 先罚便宜的；② 有一张已经死了（搭档全出完）→ 先罚死的，哪怕它更贵；
  //    ③ 手里有王时，宁可罚那张死牌、把王留住（王是搭车客，但罚出去就是白丢分）。
  const penBase = (hand, loot) => ({
    table: [G.makeCard('C', 5)], playerHand: [], npcHand: hand,
    playerLoot: loot, npcLoot: [], playerPenalty: [], npcPenalty: [],
    drawPile: [], turn: 'npc', phase: 'playing', numDecks: 2,
  });
  const aGone = [];   // 8 张 A 全部露面 → K 的搭档(A)彻底没了 → K 死
  for (let i = 0; i < 8; i++) aGone.push(G.makeCard('C', 1));
  const pickPen = (hand, loot) => {
    const act = G.chooseNpcAction(penBase(hand, loot), 'medium');
    return act.type === 'penalty' ? hand.find((c) => c.id === act.cardId) : null;
  };
  const h1 = [G.makeCard('D', 4), G.makeCard('H', 13)];     // ♦4(0.25, 活) vs ♥K(0.75, 活)
  const p1 = pickPen(h1, []);
  ck('罚牌①两张都活着 → 先罚便宜的（♦4 而不是 ♥K）', p1 && (p1.suit + p1.rank), 'D4');
  const h2 = [G.makeCard('D', 4), G.makeCard('H', 13)];     // 同上，但 A 全出完 → ♥K 已死
  const p2 = pickPen(h2, aGone);
  ck('罚牌②K 已死（A 全出完）→ 宁罚贵的 ♥K，留住还能用的 ♦4', p2 && (p2.suit + p2.rank), 'H13');
  const deck9 = G.buildDeck(2);
  const joker9 = deck9.filter((c) => c.isJoker)[0];
  const h3 = [joker9, G.makeCard('H', 13)];                 // 王 + 已死的 ♥K
  const p3 = pickPen(h3, aGone);
  ck('罚牌③手里有王 → 仍先罚那张死的 ♥K，王不拿去罚', p3 && (p3.suit + p3.rank), 'H13');
} catch (e) {
  fails++;
  console.log('FAIL  开局询问/难度档用例抛异常: ' + e.message);
}

// ---------- 12. 浏览器模式（play.html 的真实路径：没有 require，模块挂 window） ----------
try {
  const env2 = makeEnv();
  const store = { h14_seenHelp: '1' };   // 老用户：不再自动弹首玩说明，免得盖在难度询问上
  const sandbox = {
    window: {}, document: env2.doc, console: console, setTimeout: noTimer,
    module: { exports: {} },
    // 真实浏览器有 localStorage（难度/是否还问，都靠它持久化）
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
  };
  sandbox.window.document = env2.doc;
  vm.createContext(sandbox);
  const load = (f) => vm.runInContext(fs.readFileSync(path.resolve(__dirname, 'electron/src/' + f), 'utf8'), sandbox);
  load('game-core.js'); sandbox.window.G = sandbox.module.exports;
  sandbox.module = { exports: {} };
  load('advisor.js'); sandbox.window.ADVISOR = sandbox.module.exports;
  sandbox.module = { exports: {} };
  load('sfx.js'); sandbox.window.SFX = sandbox.module.exports;
  load('app.js');
  if (typeof env2.doc._ready !== 'function') throw new Error('浏览器模式下未注册 DOMContentLoaded');
  env2.doc._ready();
  // play.html 真实路径：启动先弹「这局打什么难度」，点「开始」才真开局
  ck('浏览器模式：启动先弹难度询问', env2.reg.diffModal.classList.contains('hidden'), false);
  ck('浏览器模式：询问层给出了当前档说明', String(env2.reg.askDiffDesc.textContent).length > 0, true);
  ck('浏览器模式：开始按钮写着当前档位', String(env2.reg.askDiffGo.textContent).indexOf('中等') >= 0, true);
  env2.reg.askDiffGo._fire('click');
  ck('浏览器模式：点开始后询问层关闭', env2.reg.diffModal.classList.contains('hidden'), true);
  const fbTxt = String(env2.reg.firstBannerText.textContent);
  ck('浏览器模式：先手宣告已弹出', env2.reg.firstBanner.classList.contains('hidden'), false);
  ck('浏览器模式：宣告文字是先手提示', (fbTxt === '你先手' || fbTxt === 'NPC 先手') ? fbTxt : '(空)', fbTxt);
  ck('浏览器模式：桌面牌数', env2.reg.table._children.length, 6);
  ck('浏览器模式：玩家手牌数', env2.reg.playerHand._children.length, 4);
  ck('浏览器模式：补牌堆显示', env2.reg.drawCount.textContent, 94);
  ck('浏览器模式：无 require 也能加载内核', typeof sandbox.window.G.findMoves, 'function');
  ck('浏览器模式：顾问模块可用（走 window.G）', typeof sandbox.window.ADVISOR.simulateWinRate, 'function');
  ck('浏览器模式：音效模块可用', typeof sandbox.window.SFX.toggleMuted, 'function');
  ck('浏览器模式：NPC 卡通形象已画出', String(env2.reg.npcAvatar.innerHTML).indexOf('<svg') >= 0, true);
  ck('桌面版：难度说明不含降档字样（H14_EASY_SHIFT 未注入时不得出现）',
    String(env2.reg.askDiffDesc.textContent).indexOf('降一档') < 0, true);
} catch (e) {
  fails++;
  console.log('FAIL  浏览器模式启动失败: ' + e.message);
}

// ---------- 13. 手机变体（window.H14_EASY_SHIFT=1：档位整体降一档，tools-standalone.js 手机版注入） ----------
// 只改档位强度映射与说明文案；发牌/规则/其余 UI 与桌面版共用同一份代码（基础一样由同源构建保证）。
// 桩环境里询问层的静态子按钮不存在 → 用真实持久化路径驱动：localStorage.h14_diff 预置档位再加载。
try {
  const mkMobile = (pre) => {
    const env = makeEnv();
    const store = Object.assign({ h14_seenHelp: '1' }, pre || {});
    const sb = {
      window: { H14_EASY_SHIFT: 1 }, document: env.doc, console: console, setTimeout: noTimer,
      module: { exports: {} },
      localStorage: {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: (k) => { delete store[k]; },
      },
    };
    sb.window.document = env.doc;
    vm.createContext(sb);
    const ld = (f) => vm.runInContext(fs.readFileSync(path.resolve(__dirname, 'electron/src/' + f), 'utf8'), sb);
    ld('game-core.js'); sb.window.G = sb.module.exports;
    sb.module = { exports: {} };
    ld('advisor.js'); sb.window.ADVISOR = sb.module.exports;
    sb.module = { exports: {} };
    ld('sfx.js'); sb.window.SFX = sb.module.exports;
    ld('app.js');
    env.doc._ready();
    return env;
  };
  // 默认档（中等）→ 实按容易
  const e3a = mkMobile();
  ck('手机版：默认中等档说明标注实按容易', String(e3a.reg.askDiffDesc.textContent).indexOf('实际按「容易」打') >= 0, true);
  ck('手机版：开始按钮标注实按档', String(e3a.reg.askDiffGo.textContent).indexOf('实按容易') >= 0, true);
  ck('手机版：原档描述保留（不是换成容易的描述）', String(e3a.reg.askDiffDesc.textContent).indexOf('一步贪心') >= 0, true);
  // 预置地狱 → 实按难
  const e3b = mkMobile({ h14_diff: 'hell' });
  ck('手机版：选地狱实按难', String(e3b.reg.askDiffDesc.textContent).indexOf('实际按「难」打') >= 0, true);
  ck('手机版：地狱档开始按钮标注实按难', String(e3b.reg.askDiffGo.textContent).indexOf('实按难') >= 0, true);
  // 预置容易 → 已是最低，不再降、不再标注
  const e3c = mkMobile({ h14_diff: 'easy' });
  ck('手机版：容易已到底不再降档标注', String(e3c.reg.askDiffDesc.textContent).indexOf('降一档') < 0, true);
  // 预置一个已不存在的档位（旧的自适应）→ 必须被忽略、回落默认，不能把界面打崩
  const e3d = mkMobile({ h14_diff: 'adaptive' });
  ck('手机版：不存在的档位被忽略、回落默认中等', String(e3d.reg.askDiffDesc.textContent).indexOf('一步贪心') >= 0, true);
  // 点开始真开局（中等→实按容易），游戏跑起来不炸
  e3a.reg.askDiffGo._fire('click');
  ck('手机版：点开始后询问层关闭', e3a.reg.diffModal.classList.contains('hidden'), true);
  ck('手机版：开局桌面 6 张牌', e3a.reg.table._children.length, 6);
} catch (e) {
  fails++;
  console.log('FAIL  手机变体测试失败: ' + e.message);
}

global.setTimeout = realSetTimeout;
console.log(fails === 0 ? '\n全部通过 ✅' : '\n有 ' + fails + ' 项失败 ❌');
process.exit(fails === 0 ? 0 : 1);
