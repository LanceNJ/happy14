// 小程序版冒烟测试（常驻）：用最小 Page/wx 桩真实执行 pages/game/game.js，端到端驱动一整局。
// 和小程序版"界面从没真正执行过"是同一类雷区，改动 game.js / game.wxml / game.wxss / utils 后请跑一次： node mini-test.js
// 定时器策略：手动队列（flushUntil 按条件推进）——分步演出必须能一拍拍验；端到端整局切成同步定时器一次跑完。
const path = require('path');

const toastTitles = [];
const tap = (id) => ({ currentTarget: { dataset: { id: id } } });

// 手动定时器队列
const realSetTimeout = global.setTimeout;
let q = [];
const queueTimer = (fn) => { q.push(fn); return q.length; };
const noTimer = () => 0;
const inlineTimer = (fn) => { fn(); return 0; };
const flushUntil = (pred, cap) => {
  let n = 0;
  while (q.length && !pred() && n++ < (cap || 30)) { const f = q.shift(); if (f) f(); }
  return pred();
};
const clearQ = () => { q.length = 0; };

let page = null;
global.Page = (obj) => {
  const inst = Object.assign({}, obj);
  inst.data = JSON.parse(JSON.stringify(obj.data || {}));
  // 累计记录：动画/表情标记只在某一帧为 true，只看最后一帧会漏
  inst._sawNew = { hand: false, table: false, npc: false };
  inst._anim = { ring: false, lock: false, mergeTo: false, mergeTarget: false, penTarget: false, penOut: false, flipIn: false, clearing: false, npcPoint: false, lifted: false, revealed: false, isTarget: false, masked: false };
  inst._sawNpcShowCards = false;
  inst._sayHistory = [];      // NPC 碎嘴小气泡
  inst._speakHistory = [];    // NPC 大娃娃台词（重要情境）
  inst._moodHistory = [];     // NPC 表情
  inst._over = null;          // 最后一次结算数据
  inst._npcShowHist = [];     // 每次浮层内容（用于验"逐张翻牌"）
  inst._lastDim = 0;          // 最近一帧被压暗的桌面牌数量
  inst.setData = (d) => {
    Object.assign(inst.data, d);
    if (d.playerHand && d.playerHand.some((c) => c.isNew)) inst._sawNew.hand = true;
    if (d.table && d.table.some((c) => c.isNew)) inst._sawNew.table = true;
    if (d.npcHand && d.npcHand.some((c) => c.isNew)) inst._sawNew.npc = true;
    if (typeof d.npcSay === 'string' && d.npcSay) inst._sayHistory.push(d.npcSay);
    if (d.npcSpeak && d.npcSpeak.text) inst._speakHistory.push(d.npcSpeak.text);
    if (d.npcMood) inst._moodHistory.push(d.npcMood);
    if (d.over && d.over.sections) inst._over = d.over;
    if (d.npcShow) {
      const cards = d.npcShow.cards || [];
      if (cards.length > 0) inst._sawNpcShowCards = true;
      if (d.npcShow.masked) inst._anim.masked = true;
      if (d.npcShow.clearing) inst._anim.clearing = true;
      inst._npcShowHist.push({ head: d.npcShow.head, eq: d.npcShow.eq, n: cards.length });
      if (cards.some((c) => c.flipIn)) inst._anim.flipIn = true;
      if (cards.some((c) => c.revealed)) inst._anim.revealed = true;
      if (cards.some((c) => c.isTarget)) inst._anim.isTarget = true;
    }
    if (d.table) {
      if (d.table.some((c) => c.ringed)) inst._anim.ring = true;
      if (d.table.some((c) => c.ringLock)) inst._anim.lock = true;
      if (d.table.some((c) => c.mergeTarget)) inst._anim.mergeTarget = true;
      if (d.table.some((c) => c.npcPoint)) inst._anim.npcPoint = true;
      if (d.table.some((c) => c.lifted)) inst._anim.lifted = true;
      inst._lastDim = d.table.filter((c) => c.dimmed).length;
    }
    if (d.playerHand) {
      if (d.playerHand.some((c) => c.mergeTo)) inst._anim.mergeTo = true;
      if (d.playerHand.some((c) => c.penTarget)) inst._anim.penTarget = true;
      if (d.playerHand.some((c) => c.penOut)) inst._anim.penOut = true;
    }
  };
  page = inst;
};
const storage = {};
global.wx = {
  showToast: (o) => toastTitles.push(o && o.title),
  setStorageSync: (k, v) => { storage[k] = v; },
  getStorageSync: (k) => storage[k],
  // 故意不提供 createWebAudioContext：验证"无音频环境必须静默降级"
};
global.setTimeout = queueTimer;

const G = require(path.resolve(__dirname, 'miniprogram/utils/game-core.js'));
const A = require(path.resolve(__dirname, 'miniprogram/utils/advisor.js'));
require(path.resolve(__dirname, 'miniprogram/pages/game/game.js')); // 内部会调 Page(...)
if (!page) throw new Error('game.js 未调用 Page()');

let fails = 0;
const ck = (name, got, want) => {
  const ok = String(got) === String(want);
  if (!ok) fails++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + ' = ' + got + (ok ? '' : ' （期望 ' + want + '）'));
};

// ---------- 1. 首屏 ----------
page._setSimEnabled(false);   // 胜率模拟默认关掉，避免每回合 240 局拖慢测试（第 8 段专门开）
page._setFirstMoveRandom(false); // 主流程测试关掉先手随机：保证玩家先手，避免 NPC 先手的在途回调污染后续用例
page._setAskDiff(false);         // 开局难度询问默认关掉：主流程要"启动即开局"，询问流程下面有专门用例
page.onLoad();
ck('桌面牌数', page.data.table.length, 6);
ck('玩家手牌数', page.data.playerHand.length, 4);
ck('NPC 手牌背面数', page.data.npcHand.length, 4);
ck('补牌堆显示', page.data.drawCount, 94);
ck('未选牌时"确认匹配"按钮置灰', page.data.confirmDisabled, true);
ck('选牌阶段同时给两个出口（确认匹配 + 罚牌）', page.data.showConfirm, true);
ck('罚牌按钮文案已生成', String(page.data.penLabel).indexOf('罚掉') >= 0, true);
ck('未选牌时罚牌按钮置灰（罚牌要求恰好 1 张）', page.data.penDisabled, true);
ck('音效按钮有文案', String(page.data.soundLabel).indexOf('音效') >= 0, true);
ck('NPC 开局打招呼', page._sayHistory.length + page._speakHistory.length > 0, true);
ck('NPC 开局有表情', page._moodHistory.length > 0, true);
ck('首屏胜率面板为占位', page.data.oddsWin, '—');

// ---------- 首玩引导（玩法说明） ----------
ck('首屏未看过玩法 → 自动弹出玩法说明', page.data.showHelp, true);
page.hideHelp();
ck('关闭玩法说明', page.data.showHelp, false);
ck('已看过玩法已落盘（wx storage）', storage.h14_seenHelp, 1);
page.showHelp();
ck('顶栏「❓ 玩法」可再次打开', page.data.showHelp, true);
page.hideHelp();

// ---------- 1b. 顾问：最优判断 / 补桌面 / 结算明细（纯逻辑） ----------
{
  const t = G.createGame({ numDecks: 2 });
  t.table = [G.makeCard('S', 5), G.makeCard('H', 2), G.makeCard('C', 2), G.makeCard('D', 2), G.makeCard('H', 3), G.makeCard('C', 3)];
  t.playerHand = [G.makeCard('H', 9), G.makeCard('S', 9), G.makeCard('C', 4), G.makeCard('D', 7)];
  ck('最优判断：9♠+5♠ 是本回合最赚', A.judgeMatch(t.playerHand, t.table, [t.playerHand[1].id], t.table[0].id).optimal, true);
  ck('最优判断：9♥+5♠ 非最优', A.judgeMatch(t.playerHand, t.table, [t.playerHand[0].id], t.table[0].id).optimal, false);
  ck('罚牌判断：有解却罚牌 → 非最优', A.judgePenalty(t.playerHand, t.table).optimal, false);
  ck('罚牌判断：真无解 → 最优', A.judgePenalty([G.makeCard('S', 13)], t.table).optimal, true);
  const t2 = G.createGame({ numDecks: 2 });
  t2.table = [G.makeCard('S', 5), G.makeCard('H', 2), G.makeCard('C', 9), G.makeCard('D', 3), G.makeCard('H', 6)];
  const hand = [G.makeCard('S', 9), G.makeCard('D', 2)];
  ck('补桌面判断：丢 9♠ 非最优', A.judgeReplace(hand, t2.table, [], hand[0].id).optimal, false);
  ck('补桌面判断：建议补 2♦', A.judgeReplace(hand, t2.table, [], hand[0].id).suggest.cardId, hand[1].id);
  const det = G.scoreDetail([G.makeCard('S', 1), G.makeCard('H', 5), G.makeJoker(true), G.makeJoker(false)]);
  ck('明细：黑桃 1 张 = 1.00', det.bySuit.S.points, 1);
  ck('明细：大王 1 张 = 1.00', det.joker.big.points, 1);
  ck('明细：小王 1 张 = 0.75', det.joker.small.points, 0.75);
  ck('明细：合计得分', det.total, 3.5);
}

// ---------- 2. 罚牌（已简化）：始终两个按钮由玩家决定；选中恰好 1 张 → 点罚牌即可，无模式/无返回 ----------
{
  clearQ();
  const t = page._peek();
  // 必然无解的局面：桌面全 K(13)，手牌全 Q(12)——12+13=25…凑不出 14
  t.game.table = [G.makeCard('S', 13), G.makeCard('H', 13), G.makeCard('C', 13), G.makeCard('D', 13), G.makeCard('S', 13), G.makeCard('H', 13)];
  t.game.playerHand = [G.makeCard('S', 12), G.makeCard('H', 12), G.makeCard('C', 12), G.makeCard('D', 12)];
  const drawBefore = t.game.drawPile.length;
  page.playerTurnStart();
  ck('无解时仍停在选牌模式（不替玩家决定）', t.ui.mode, 'select');
  ck('无解标记已置位', t.ui.noMoves, true);
  ck('无解时两个按钮都还在', page.data.showConfirm, true);
  ck('无解时罚牌按钮在位（尚未选牌故置灰）', page.data.penDisabled, true);
  ck('无解时按钮文案点明"当前凑不出"', page.data.confirmLabel.indexOf('凑不出') >= 0, true);
  ck('无解时提示语告诉玩家怎么罚（不替他按）', String(page.data.message).indexOf('凑不出 14') >= 0, true);
  ck('无解时"确认匹配"置灰（点不动）', page.data.confirmDisabled, true);

  // 简化后的罚牌：不需要"进入罚牌模式"，只要恰好选中 1 张手牌
  page.onHandTap(tap(t.game.playerHand[0].id));
  ck('选中 1 张后罚牌按钮可用', page.data.penDisabled, false);
  ck('罚牌按钮标明要罚哪张', String(page.data.penLabel).indexOf('罚掉') >= 0, true);
  ck('选 1 张同时"确认匹配"仍置灰（凑不出 14）', page.data.confirmDisabled, true);

  // 选 2 张时罚牌按钮应重新置灰（罚牌要求恰好 1 张）
  page.onHandTap(tap(t.game.playerHand[1].id));
  ck('选中 2 张时罚牌按钮置灰（只能罚 1 张）', page.data.penDisabled, true);
  page.onHandTap(tap(t.game.playerHand[1].id)); // 取消，回到 1 张

  page.doPenalty();
  ck('点罚牌后直接进入飞牌动作（无模式切换）', t.ui.mode, 'penalizing');
  ck('罚牌飞走标记 penOut 已下发', page._anim.penOut, true);
  ck('飞牌期间手牌还没被扣（先演后扣）', t.game.playerHand.length, 4);

  flushUntil(() => t.game.playerPenalty.length === 1);
  ck('罚牌后手牌自动补满 4 张', t.game.playerHand.length, 4);
  ck('罚牌计数 +1', t.game.playerPenalty.length, 1);
  ck('补牌堆相应减少 1 张', t.game.drawPile.length, drawBefore - 1);
  ck('罚牌后渲染的手牌数一致', page.data.playerHand.length, 4);
  ck('牌数守恒', G.totalCards(t.game), 108);
  ck('无解罚牌记入决策统计', t.decisions.total >= 1, true);
  ck('罚牌完成后没有残留的"罚牌模式"按钮', page.data.showConfirm, false);

  // 有解时也能主动罚牌（同一个按钮，不需要先"进入模式"）
  // 先把上一段罚牌的收尾跑完（_busy 复位才允许新操作，否则点击会被吞）
  flushUntil(() => !page._peek().busy, 10);
  clearQ();
  t.game.turn = 'player';
  t.game.table = [G.makeCard('S', 5), G.makeCard('H', 5), G.makeCard('C', 5), G.makeCard('D', 5), G.makeCard('S', 9), G.makeCard('H', 9)];
  t.game.playerHand = [G.makeCard('S', 9), G.makeCard('H', 9), G.makeCard('C', 9), G.makeCard('D', 9)];
  page.playerTurnStart();
  ck('有解时进入选牌模式', t.ui.mode, 'select');
  ck('有解时无解标记为假', t.ui.noMoves, false);
  ck('有解时同样给两个按钮', page.data.showConfirm, true);
  page.onHandTap(tap(t.game.playerHand[0].id));
  ck('有解时选中 1 张也能罚（玩家自己拿主意）', page.data.penDisabled, false);
  const decBeforePen = page._peek().decisions.total;
  page.doPenalty();
  ck('有解却罚牌被记一次决策', page._peek().decisions.total, decBeforePen + 1);
  ck('日志点出"其实能出"（不拦你，只提醒）', t.game.log.some((l) => l.indexOf('不是最优') >= 0), true);
  flushUntil(() => t.ui.mode === 'idle', 8);
  ck('有解罚牌也先演后扣', t.ui.mode, 'idle');
}

// ---------- 3. 匹配分步演出：圈住 → 手牌飞过去合拢 → 收进战利品（含最优判断） ----------
{
  clearQ();
  page.newGame();
  const t = page._peek();
  // 桌面 5♠ 可配两手：9♠(1分) 比 9♥(0.75) 更赚 → 用来验"是否最优"
  t.game.table = [G.makeCard('S', 5), G.makeCard('H', 2), G.makeCard('C', 2), G.makeCard('D', 2), G.makeCard('H', 3), G.makeCard('C', 3)];
  t.game.playerHand = [G.makeCard('H', 9), G.makeCard('S', 9), G.makeCard('C', 4), G.makeCard('D', 7)];
  t.game.playerLoot = [];
  page.playerTurnStart();
  const decBefore = page._peek().decisions.total;

  // 故意先选"次优"那手（9♥+5♠）：界面应当场指出
  t.ui.selHand = [t.game.playerHand[0].id];
  t.ui.selTable = t.game.table[0].id;
  page.updateSelectSum();
  ck('选定后"确认匹配"按钮可用', page.data.confirmDisabled, false);
  ck('桌面牌被圈框圈住（ringed）', page.data.table.some((c) => c.ringed), true);
  ck('和 = 14 时圈框不是警告色', page.data.table.some((c) => c.ringBad), false);

  page.confirmMatch();
  ck('次优出牌被记一次决策', page._peek().decisions.total, decBefore + 1);
  ck('日志指出"不是最优"', t.game.log.some((l) => l.indexOf('⚠️ 不是最优') >= 0), true);
  ck('日志给出更赚的那手', t.game.log.some((l) => l.indexOf('能多拿') >= 0 && l.indexOf('= 14') >= 0), true);
  ck('确认后进入合牌状态', t.ui.mode, 'merging');
  ck('第 1 拍：圈选锁定 ringLock 已下发', page._anim.lock, true);
  ck('合牌期间按钮全消失（不留死按钮）', page.data.showConfirm, false);
  ck('第 1 拍还没收牌（先演后收）', t.game.playerLoot.length, 0);

  flushUntil(() => !!(t.ui.mergePlan && t.ui.mergePlan.stage === 'merge'));
  ck('第 2 拍：手牌飞向桌面牌（mergeTo）', page.data.playerHand.some((c) => c.mergeTo), true);
  ck('第 2 拍：被圈的牌进入合牌膨胀（mergeTarget）', page.data.table.some((c) => c.mergeTarget), true);

  flushUntil(() => t.ui.mode === 'replace');
  ck('第 3 拍：战利品入账 2 张', t.game.playerLoot.length, 2);
  ck('第 3 拍：转入"选 1 张补桌面"', t.ui.mode, 'replace');
  ck('第 3 拍：合牌计划已清空', t.ui.mergePlan, null);
  ck('收牌后渲染与数据一致', page.data.playerHand.length, t.game.playerHand.length);
  ck('牌数守恒', G.totalCards(t.game), 108);

  // 补桌面：故意丢最高分的 9♠（桌上 5♠ 一张牌就能吃走它）→ 判非最优
  const decBefore2 = page._peek().decisions.total;
  const bigCard = t.game.playerHand.find((c) => c.rank === 9);
  page.onHandTap(tap(bigCard.id));
  ck('补桌面也记一次决策', page._peek().decisions.total, decBefore2 + 1);
  ck('补桌面日志给出建议', t.game.log.some((l) => l.indexOf('补牌到桌面') >= 0), true);
  ck('补牌阶段无残留死按钮', page.data.showConfirm, false);
  ck('牌数守恒（补桌面后）', G.totalCards(t.game), 108);
}

// ---------- 4. 端到端：自动玩家跑完整局 ----------
{
  clearQ();
  global.setTimeout = inlineTimer; // 让 NPC 的分步流程与"留一拍"立即跑完，真正被覆盖到
  page.newGame();
  const t = page._peek();
  let guard = 0, turns = 0, mismatch = 0, penTurns = 0;
  while (t.game.phase !== 'gameover' && guard++ < 500) {
    turns++;
    const moves = G.findMoves(t.game.playerHand, t.game.table);
    if (moves.length === 0) {
      penTurns++;
      // 无解 → 玩家自己点"罚牌"：走真实点击路径选中恰好 1 张，再点罚牌按钮
      page.onHandTap(tap(page.data.playerHand[0].id));
      page.doPenalty();
    } else {
      const m = moves[0];
      t.ui.selHand = m.handCards.map((c) => c.id);
      t.ui.selTable = m.tableCard.id;
      page.updateSelectSum();
      page.confirmMatch();
      if (t.ui.mode === 'replace') {
        page.onHandTap(tap(page.data.playerHand[0].id)); // 走真实点击路径补桌面
      }
    }
    if (page.data.playerHand.length !== t.game.playerHand.length) mismatch++;
    if (page.data.table.length !== t.game.table.length) mismatch++;
    if (page.data.npcHand.length !== t.game.npcHand.length) mismatch++;
    if (G.totalCards(t.game) !== 108) mismatch++;
  }
  ck('整局跑完（终局）', t.game.phase, 'gameover');
  ck('双方手牌耗尽', t.game.playerHand.length + t.game.npcHand.length, 0);
  ck('终局牌数守恒', G.totalCards(t.game), 108);
  ck('每回合渲染与数据一致（0 处不符）', mismatch, 0);
  ck('结算弹窗已弹出', page.data.showOver, true);
  ck('补牌动画标记 isNew 已下发（手牌）', page._sawNew.hand, true);
  ck('落桌动画标记 isNew 已下发（桌面）', page._sawNew.table, true);
  ck('NPC 背面动画标记 isNew 已下发', page._sawNew.npc, true);
  ck('圈的动画 ringed 已下发', page._anim.ring, true);
  ck('合牌动画 mergeTo / mergeTarget 已下发', page._anim.mergeTo && page._anim.mergeTarget, true);
  const nPoint = t.game.log.filter((l) => l.indexOf('👀 NPC 看中了桌面的') >= 0).length;
  const nPlay = t.game.log.filter((l) => l.indexOf('🤖 NPC 亮牌：') >= 0).length;
  ck('NPC 每轮匹配都先箭头指牌（指着日志 > 0）', nPoint > 0, true);
  ck('NPC 每轮匹配都有亮牌演出（亮牌日志 > 0）', nPlay > 0, true);
  ck('指牌与亮牌一一对应（每轮都完整三拍）', nPoint, nPlay);
  ck('NPC 箭头指向标记 npcPoint 已下发', page._anim.npcPoint, true);
  ck('NPC 亮牌浮层带出牌（npcShow.cards > 0）', page._sawNpcShowCards, true);
  ck('NPC 翻牌动画 flip-in 已下发', page._anim.flipIn, true);
  ck('NPC 合牌阶段已标记 clearing', page._anim.clearing, true);
  ck('NPC 合牌日志已记录', t.game.log.some((l) => l.indexOf('🔗 NPC 合牌收走') >= 0), true);
  ck('轻提示已弹出', toastTitles.length > 0, true);
  console.log('       （本局共 ' + turns + ' 个玩家回合，其中罚牌 ' + penTurns + ' 次；玩家 ' +
    G.computeScore(t.game, 'player') + ' : NPC ' + G.computeScore(t.game, 'npc') + '；提示 ' + toastTitles.length + ' 次）');

  // NPC 卡通形象 + 台词
  ck('NPC 说过话（台词气泡有内容）', page._sayHistory.length > 0, true);
  ck('NPC 表情变过（不止一种 mood）', new Set(page._moodHistory).size >= 2, true);
  ck('NPC 会对局势放话（捞王/大赚/罚牌/场面话之一）',
    ['王归我', '赚到', '一网打尽', '认罚', '凑不出', '忍一手', '拿走不谢', '归我了', '正好凑够', '等好几轮', '没牌了', '残局', '见底', '牌堆', '领先', '别得意', '找找机会', '扎眼', '顺']
      .some((k) => page._sayHistory.some((s) => s.indexOf(k) >= 0)), true);

  // 最优判断贯穿整局
  ck('整局每步决策都被记分', page._peek().decisions.total >= turns, true);
  ck('整局日志里有最优判断记录', t.game.log.some((l) => l.indexOf('📈 最优判断') >= 0), true);

  // 结算：算分过程明细
  const over = page._over || {};
  const secs = over.sections || [];
  ck('结算有两侧明细（你 / NPC）', secs.length, 2);
  ck('结算含"你的算分过程"', String(secs[0] && secs[0].title).indexOf('你的算分过程') >= 0, true);
  ck('结算含"NPC 的算分过程"', String(secs[1] && secs[1].title).indexOf('NPC 的算分过程') >= 0, true);
  ck('结算摊开花色明细（黑桃）', (secs[0].lootRows || []).some((r) => r.name.indexOf('黑桃') >= 0), true);
  ck('结算摊开王明细（大王/小王）', (secs[0].lootRows || []).some((r) => r.name.indexOf('大王') >= 0) && (secs[0].lootRows || []).some((r) => r.name.indexOf('小王') >= 0), true);
  ck('结算给出"战利品合计"', String(secs[0].lootTotal).length > 0, true);
  ck('结算给出"罚牌合计"', String(secs[0].penTotal).length > 0, true);
  ck('结算给出"战利品 − 罚牌"算式', String(secs[0].calc).indexOf(' − ') >= 0, true);
  ck('结算给出最终得分', String(secs[0].score).length > 0, true);
  ck('结算给出决策正确率', String(over.rate).indexOf('正确率') >= 0, true);
  ck('结算列了双方全部牌面', String(over.allCards).indexOf('你的战利品') >= 0, true);
}

// ---------- 4b. NPC 出牌六拍：指牌+压暗 → 抬起 → 逐张翻牌 → 亮等式 → 才合牌（逐拍验） ----------
{
  clearQ();
  global.setTimeout = queueTimer;
  page.newGame();
  const t = page._peek();
  // 确定性局面：给 NPC 一手明确的匹配（手牌 9♠+桌面 5♠=14，共 2 张）
  t.game.table = [G.makeCard('S', 5), G.makeCard('H', 9), G.makeCard('C', 2), G.makeCard('D', 3), G.makeCard('H', 6), G.makeCard('C', 8)];
  t.game.npcHand = [G.makeCard('S', 9), G.makeCard('H', 7), G.makeCard('C', 7), G.makeCard('D', 10)];
  t.game.turn = 'npc';
  t.game.npcLoot = [];
  clearQ();
  page.npcTurn();
  ck('NPC 第 0 拍：先思考（还没指牌）', t.ui.mergePlan, null);

  // ① 箭头指牌 + 其余桌面牌压暗
  flushUntil(() => !!(t.ui.mergePlan && t.ui.mergePlan.stage === 'point'));
  ck('NPC 第 1 拍：进入"箭头指牌"阶段', t.ui.mergePlan && t.ui.mergePlan.stage, 'point');
  ck('NPC 第 1 拍：被指的桌面牌带 npcPoint', page.data.table.some((c) => c.npcPoint), true);
  ck('NPC 第 1 拍：其余 5 张桌面牌被压暗', page._lastDim, 5);
  ck('NPC 第 1 拍：提示语说在看哪张', String(page.data.message).indexOf('看中了桌面的') >= 0, true);
  ck('NPC 第 1 拍：日志记下指牌这一拍', t.game.log.some((l) => l.indexOf('👀 NPC 看中了桌面的') >= 0), true);
  ck('NPC 第 1 拍：还没亮牌浮层', page.data.npcShow, null);
  ck('NPC 第 1 拍：还没收牌（先演后收）', t.game.npcLoot.length, 0);

  // ② 那张牌"抬起来"
  flushUntil(() => !!(t.ui.mergePlan && t.ui.mergePlan.stage === 'lift'));
  ck('NPC 第 2 拍：进入"抬起"阶段', t.ui.mergePlan && t.ui.mergePlan.stage, 'lift');
  ck('NPC 第 2 拍：目标牌 lifted 已下发', page.data.table.some((c) => c.lifted), true);
  ck('NPC 第 2 拍：其余牌仍压暗', page._lastDim, 5);
  ck('NPC 第 2 拍：日志记下抬手要牌', t.game.log.some((l) => l.indexOf('☝️ NPC 抬手要了桌面的') >= 0), true);
  ck('NPC 第 2 拍：仍然没收牌', t.game.npcLoot.length, 0);

  // ③ 浮层弹出（整屏压暗）+ 逐张翻牌
  flushUntil(() => !!(t.ui.mergePlan && t.ui.mergePlan.stage === 'flip'));
  ck('NPC 第 3 拍：进入"逐张翻牌"阶段', t.ui.mergePlan && t.ui.mergePlan.stage, 'flip');
  ck('NPC 第 3 拍：浮层整屏压暗（masked）', (page.data.npcShow || {}).masked, true);
  ck('NPC 第 3 拍：标题写明第几张（1/2）', String((page.data.npcShow || {}).head).indexOf('（1/2）') >= 0, true);
  ck('NPC 第 3 拍：此刻只翻出 1 张', ((page.data.npcShow || {}).cards || []).length, 1);
  ck('NPC 第 3 拍：最新那张带翻面标记 flipIn', ((page.data.npcShow || {}).cards || []).some((c) => c.flipIn), true);
  ck('NPC 第 3 拍：等式还没出现（先看清牌）', String((page.data.npcShow || {}).eq).length, 0);
  ck('NPC 第 3 拍：仍然没收牌', t.game.npcLoot.length, 0);

  flushUntil(() => ((page.data.npcShow || {}).cards || []).length === 2);
  ck('NPC 第 4 拍：翻到第 2/2 张', ((page.data.npcShow || {}).cards || []).length, 2);
  ck('NPC 第 4 拍：已翻出的牌用 revealed 标记（不重复播动画）', ((page.data.npcShow || {}).cards || []).some((c) => c.revealed), true);
  ck('NPC 第 4 拍：桌面那张单独标 isTarget', ((page.data.npcShow || {}).cards || []).some((c) => c.isTarget), true);

  // ④ 亮等式（停够读完）
  flushUntil(() => !!(t.ui.mergePlan && t.ui.mergePlan.stage === 'read'));
  ck('NPC 第 5 拍：进入"亮等式"阶段', t.ui.mergePlan && t.ui.mergePlan.stage, 'read');
  ck('NPC 第 5 拍：等式写进浮层', String((page.data.npcShow || {}).eq).indexOf('= 14') >= 0, true);
  ck('NPC 第 5 拍：得分写进浮层', String((page.data.npcShow || {}).eq).indexOf('收获') >= 0, true);
  ck('NPC 第 5 拍：张数没有增减（就是 2 张）', ((page.data.npcShow || {}).cards || []).length, 2);
  ck('NPC 第 5 拍：仍然没收牌（读完才收）', t.game.npcLoot.length, 0);

  // ⑤ 合牌
  flushUntil(() => !!(t.ui.mergePlan && t.ui.mergePlan.stage === 'merge'));
  ck('NPC 第 6 拍：进入"合牌"阶段', t.ui.mergePlan && t.ui.mergePlan.stage, 'merge');
  ck('NPC 第 6 拍：浮层进入收拢', (page.data.npcShow || {}).clearing, true);
  ck('NPC 第 6 拍：合牌那张胀一下（mergeTarget）', page.data.table.some((c) => c.mergeTarget), true);
  ck('NPC 第 6 拍：仍然没收牌（合牌演完才入账）', t.game.npcLoot.length, 0);

  flushUntil(() => t.game.npcLoot.length > 0, 14);
  ck('NPC 第 7 拍：真正入账', t.game.npcLoot.length > 0, true);
  ck('NPC 六拍日志齐全（指着→抬手→亮牌→合牌）',
    t.game.log.some((l) => l.indexOf('👀 NPC 看中了桌面的') >= 0) &&
    t.game.log.some((l) => l.indexOf('☝️ NPC 抬手要了桌面的') >= 0) &&
    t.game.log.some((l) => l.indexOf('🤖 NPC 亮牌：') >= 0 && l.indexOf('= 14') >= 0) &&
    t.game.log.some((l) => l.indexOf('🔗 NPC 合牌收走') >= 0), true);
  ck('NPC 六拍后牌数守恒', G.totalCards(t.game), 108);
  flushUntil(() => t.ui.mergePlan === null, 18);
  ck('NPC 回合结束后演出状态已清空', t.ui.mergePlan, null);
}

// ---------- 4c. NPC 大娃娃说话：重要情境弹大娃娃，碎嘴走小气泡 ----------
{
  clearQ();
  const big = A.npcSay('npcJoker');
  ck('顾问把"捞到王"标为大娃娃台词', big.big, true);
  const big2 = A.npcSay('npcPenalty');
  ck('顾问把"罚牌哀叹"标为大娃娃台词', big2.big, true);
  const small = A.npcSay('npcMatch');
  ck('顾问把"普通匹配"标为碎嘴小气泡', small.big, false);
  const over = A.npcSay('overWin');
  ck('顾问把"结算嘴炮"标为大娃娃台词', over.big, true);
  ck('大娃娃台词都有表情与文本', !!(big2.mood && big2.text), true);

  // 真喂给页面：捞到王 → 应弹大娃娃而非小气泡
  page.newGame();
  page.setData({ npcSpeak: null, npcSay: '' });
  page.npcSay('npcJoker');
  ck('捞到王时弹出大娃娃（npcSpeak 有文本）', !!(page.data.npcSpeak && page.data.npcSpeak.text), true);
  ck('大娃娃带表情', !!(page.data.npcSpeak && page.data.npcSpeak.mood), true);
  clearQ();
  page.npcSay('npcMatch');
  ck('普通匹配只走小气泡（npcSay 有字）', String(page.data.npcSay).length > 0, true);
  ck('普通匹配不弹大娃娃', page.data.npcSpeak, null);
}

// ---------- 5. 动画期间点"新游戏"：在途回调必须作废，不能污染新牌局 ----------
{
  clearQ();
  global.setTimeout = queueTimer;
  page.newGame();
  const t = page._peek();
  t.game.table = [G.makeCard('S', 5), G.makeCard('H', 5), G.makeCard('C', 5), G.makeCard('D', 5), G.makeCard('S', 9), G.makeCard('H', 9)];
  t.game.playerHand = [G.makeCard('S', 9), G.makeCard('H', 9), G.makeCard('C', 9), G.makeCard('D', 9)];
  t.game.playerLoot = [];
  page.playerTurnStart();
  const mv2 = G.findMoves(t.game.playerHand, t.game.table)[0];
  t.ui.selHand = mv2.handCards.map((c) => c.id);
  t.ui.selTable = mv2.tableCard.id;
  page.updateSelectSum();
  page.confirmMatch();                    // 进入合牌，第 2/3 拍还排在队列里
  ck('合牌途中确实还有在途回调', q.length > 0, true);

  page.newGame();                         // 中途点"新游戏"
  const t2 = page._peek();
  flushUntil(() => false, 6);             // 把旧回调全部放出来跑
  ck('重开后旧合牌回调不污染新牌局（牌数守恒）', G.totalCards(t2.game), 108);
  ck('重开后手牌仍是 4 张', t2.game.playerHand.length, 4);
  ck('重开后回合状态合法（测试已关随机先手→玩家先手）', t2.game.turn, 'player');
  ck('重开后战利品为空', t2.game.playerLoot.length, 0);
  ck('重开后决策统计已归零', t2.decisions.total, 0);
}

// ---------- 5b. 先手随机化（独立验证，不污染上面的确定性用例） ----------
{
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

// ---------- 5c. 开局难度询问（第五档「自适应」已移除，见 ③ 的回归锁） ----------
try {
  clearQ();
  global.setTimeout = queueTimer;   // newGame/showOver 里有队列定时器，用项目统一的队列接住

  // ① 询问层：默认停在当前档；选档只是选中，点「开始」才真生效
  page.setDifficulty({ currentTarget: { dataset: { diff: 'medium' } } });
  page._setAskDiff(true);
  page.openDiffAsk();
  ck('开局询问层已弹出', page.data.showDiffAsk, true);
  ck('询问层默认停在当前档', page.data.askDiffPending, 'medium');
  page.pickAskDiff({ currentTarget: { dataset: { diff: 'hell' } } });
  ck('选档只是改选中，难度还没变', page.data.npcDifficulty, 'medium');
  ck('选中项已切到 hell', page.data.askDiffPending, 'hell');
  ck('开始按钮文案带档位名', String(page.data.askDiffGo).indexOf('地狱') >= 0, true);
  page.confirmDiffAsk();
  ck('点开始后难度才真改', page.data.npcDifficulty, 'hell');
  ck('点开始后询问层关闭', page.data.showDiffAsk, false);
  ck('点开始后开了新局（牌数守恒）', G.totalCards(page._peek().game), 108);
  clearQ();   // 新局的 NPC 回调别泄到后面的用例

  // ② 勾了「别再问」：requestNewGame 直接开局，不弹询问层
  page._setAskDiff(false);
  const gBefore = page._peek().game;
  page.requestNewGame();
  ck('不再问时 requestNewGame 直接开局', page._peek().game !== gBefore, true);
  ck('不再问时不弹询问层', page.data.showDiffAsk, false);
  ck('「别再问」已落盘（wx storage，存 0）', storage.h14_askdiff, 0);
  page._setAskDiff(true);   // 复原

  // ②b 「再来一局」卡死修复的回归锁：结算层开着时点新游戏 → 询问层弹出、结算层被关掉
  page.newGame(); clearQ();
  page.setData({ showOver: true });   // 伪造"本局结束、结算层开着"
  page.requestNewGame();
  ck('结算层开着点新游戏 → 询问层弹出', page.data.showDiffAsk, true);
  ck('结算层开着点新游戏 → 结算层被关掉', page.data.showOver, false);
  page.confirmDiffAsk(); clearQ();   // 收尾：真开一局

  // ②c 先手宣告：开局大字亮一下谁先手，1.6 秒后自动淡出（与 ui-test §11⑧ 对称）
  //    注意别在 newGame 后 clearQ——那会把 1.6 秒的消隐回调一起清掉
  page.newGame();
  ck('先手宣告已弹出', !!page.data.firstBanner, true);
  ck('先手宣告文字与实际先手一致', page.data.firstBanner, page._peek().game.turn === 'player' ? '你先手' : 'NPC 先手');
  flushUntil(() => !page.data.firstBanner, 10);
  ck('先手宣告约 1.6 秒后自动淡出', page.data.firstBanner, '');
  clearQ();   // 队列里剩下的杂项回调别泄到后面的用例

  // ③ 「自适应」第 5 档已移除：只剩四档，选到不存在的档必须被忽略
  ck('小程序内核只剩四档（易/中/难/地狱）', G.DIFFICULTIES.length, 4);
  page.setDifficulty({ currentTarget: { dataset: { diff: 'medium' } } });
  page.setDifficulty({ currentTarget: { dataset: { diff: 'adaptive' } } });
  ck('选不存在的档位被忽略，难度不变', page.data.npcDifficulty, 'medium');
  ck('侧栏难度说明仍能正常渲染', String(page.data.diffDesc).length > 0, true);

  // ⑥ WXML 静态检查：四档按钮要真的写进页面（侧栏一段 + 开局询问一段 = 2 处 × 4 个）
  const wxml = require('fs').readFileSync(path.resolve(__dirname, 'miniprogram/pages/game/game.wxml'), 'utf8');
  ck('game.wxml 里四档按钮齐全（侧栏 + 询问层）', (wxml.match(/data-diff="/g) || []).length, 8);
  ck('game.wxml 里已无自适应档按钮', wxml.indexOf('data-diff="adaptive"') < 0, true);
  ck('game.wxml 里有开局询问层', wxml.indexOf('showDiffAsk') >= 0, true);
} catch (e) {
  fails++;
  console.log('FAIL  开局询问/难度档用例抛异常: ' + e.message);
}

// ---------- 6. 胜率估计：真的算得对（这里才打开模拟） ----------
{
  clearQ();
  global.setTimeout = queueTimer;
  page.newGame();
  const t = page._peek();

  // 造一个"结果已经锁定"的领先局面：领先 11.75 分，场上可再分配的牌最多值 2 分，
  // 怎么重洗都翻不了盘 → 胜率必须正好 100%（确定性局面，不靠概率过关）
  t.game.playerLoot = [];
  for (let i = 0; i < 12; i++) t.game.playerLoot.push(G.makeCard('S', 13));  // 12.00
  t.game.npcLoot = [G.makeCard('D', 2)];                                     // 0.25
  t.game.playerPenalty = []; t.game.npcPenalty = [];
  t.game.drawPile = [];                                                      // 残局：不再补牌
  t.game.table = [G.makeCard('S', 9), G.makeCard('H', 9)];
  t.game.playerHand = [G.makeCard('H', 2)];                                  // 2+9=11，谁也配不出 14
  t.game.npcHand = [G.makeCard('H', 2)];
  t.game.turn = 'player';
  const zoneIds = () => JSON.stringify([
    t.game.table.map((c) => c.id), t.game.playerHand.map((c) => c.id), t.game.npcHand.map((c) => c.id),
    t.game.drawPile.map((c) => c.id), t.game.playerLoot.map((c) => c.id), t.game.npcLoot.map((c) => c.id),
  ]);
  const snapBefore = zoneIds();
  const lead = A.simulateWinRate(t.game, 60);
  ck('结果已锁定的领先局面 → 胜率 100%', lead.winRate, 1);
  ck('锁定局面不会有负/平', lead.loseRate + lead.drawRate, 0);
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

  // 界面分片跑：打开开关 → 刷新 → 放行分片任务
  page._setSimEnabled(true);
  page.refreshOdds();
  // 注意：refreshOdds 会换掉整个 odds 对象，所以每次都要重新取，不能闭包持有旧引用
  flushUntil(() => page._peek().odds.done >= 240, 12);
  ck('分片算完 240 局', page._peek().odds.n, 240);
  ck('面板显示胜率百分比', /%$/.test(String(page.data.oddsWin)), true);
  ck('面板显示模拟局数', page.data.oddsN, '240 局');
  ck('胜率条三段宽度已下发', String(page.data.oddsMeW).indexOf('%') >= 0 && String(page.data.oddsNpcW).indexOf('%') >= 0, true);
  ck('面板显示决策质量', String(page.data.decisionRate).length > 0, true);
  page._setSimEnabled(false);
}

// ---------- 7. 音效与静音开关：无音频环境必须静默降级 ----------
{
  let threw = null;
  try {
    page.toggleSound();
    page.toggleSound();
  } catch (e) { threw = e.message; }
  ck('小程序无声卡环境下开关音效不抛异常', threw, null);
  ck('静音状态已落盘（wx storage，存 0/1）', typeof storage.h14_muted, 'number');
  ck('音效按钮文案随开关变化', String(page.data.soundLabel).indexOf('音效') >= 0, true);
}

// ---------- 7b. 语音朗读已按用户要求整体移除（回归锁：防止以后又被加回来） ----------
{
  const SFX = require(path.resolve(__dirname, 'miniprogram/utils/sfx.js'));
  const killed = ['say', 'cancelSay', 'voiceSupported', 'toggleVoice', 'setVoiceOn', 'isVoiceOn', 'estimateSpeechMs'];
  const alive = killed.filter((k) => typeof SFX[k] === 'function');
  ck('sfx 已不含任何语音接口（' + killed.length + ' 个）', alive.length, 0);

  // 说台词照常：只是没有声音，文字停留时间仍按字数算
  clearQ();
  global.setTimeout = queueTimer;
  page.newGame();                 // 确保不是"已结算"状态（那种状态下 NPC 不会再开口）
  const before = page._speakHistory.length + page._sayHistory.length;
  let threw = null;
  try { page.npcSay('npcJoker', 1); } catch (e) { threw = e.message; }
  ck('去掉语音后说台词不抛异常', threw, null);
  ck('去掉语音后台词照常显示', page._speakHistory.length + page._sayHistory.length > before, true);
  ck('台词停留仍按字数动态计算（长句留得更久）',
    page.playSay('那两张王本来是我的，你怎么能这样嘛！') > page.playSay('嘿嘿'), true);
  const T2 = page._peek().T;
  ck('短句停留有下限（不会一闪而过）', T2.SAY_MIN >= 2500, true);
  ck('超长台词有上限（不会卡住牌桌）', T2.SAY_MAX <= 15000, true);

  // 界面里不该再有语音开关的残留
  ck('页面 data 里没有语音开关字段', page.data.voiceLabel === undefined, true);
}

// ---------- 8. 连开 30 局，确认渲染稳定 ----------
try {
  clearQ();
  for (let i = 0; i < 30; i++) page.newGame();
  console.log('PASS  连开 30 局新游戏，渲染无异常');
} catch (e) {
  fails++;
  console.log('FAIL  连开新游戏抛异常: ' + e.message);
}

// ---------- 9. 布局与配色：与 Web 版同一套色板 ----------
// 判据实现在 style-check.js（ui-test.js 调的是同一份）——避免断言在两处抄两遍、改一处漏一处
require(path.resolve(__dirname, 'style-check.js')).checkStyle(
  (p) => require('fs').readFileSync(p, 'utf8'), __dirname, ck);

global.setTimeout = realSetTimeout;
console.log(fails === 0 ? '\n全部通过 ✅' : '\n有 ' + fails + ' 项失败 ❌');
process.exit(fails === 0 ? 0 : 1);
