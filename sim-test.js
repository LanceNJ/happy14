// 临时验证脚本：双方贪心跑完整一局，校验内核
const G = require('./game-core.js');

function playOne(showLog) {
  const state = G.createGame({ numDecks: 2 });
  if (state.table.length !== 6) throw new Error('桌面不是6张: ' + state.table.length);
  if (state.playerHand.length !== 4 || state.npcHand.length !== 4) throw new Error('手牌不是4张');
  if (state.drawPile.length !== 108 - 14) throw new Error('补牌堆数量错: ' + state.drawPile.length);

  let guard = 0;
  while (!G.isGameOver(state)) {
    guard++;
    if (guard > 10000) throw new Error('疑似死循环');
    if (state.turn === 'player') {
      if (state.playerHand.length === 0) { state.turn = 'npc'; continue; }
      const action = G.chooseNpcAction({ npcHand: state.playerHand, table: state.table }); // 复用贪心当"玩家"
      if (action.type === 'match') {
        G.capture(state, 'player', action.move);
        G.replaceAndRefill(state, 'player', action.replaceCardId);
      } else {
        G.penalty(state, 'player', action.cardId);
      }
      state.turn = 'npc';
    } else {
      if (state.npcHand.length === 0) { state.turn = 'player'; continue; }
      const action = G.chooseNpcAction(state);
      if (action.type === 'match') {
        G.capture(state, 'npc', action.move);
        G.replaceAndRefill(state, 'npc', action.replaceCardId);
      } else {
        G.penalty(state, 'npc', action.cardId);
      }
      state.turn = 'player';
    }
    // 守恒检查
    if (G.totalCards(state) !== 108) throw new Error('牌数不守恒: ' + G.totalCards(state));
  }

  const ps = G.computeScore(state, 'player');
  const ns = G.computeScore(state, 'npc');
  if (showLog) {
    console.log('— 日志(末10条) —');
    console.log(state.log.slice(-10).join('\n'));
  }
  return { ps, ns, turns: guard };
}

let games = 0, pWins = 0, nWins = 0, ties = 0, totalTurns = 0;
const N = 2000;
for (let i = 0; i < N; i++) {
  const r = playOne(false);
  games++;
  totalTurns += r.turns;
  if (r.ps > r.ns) pWins++; else if (r.ns > r.ps) nWins++; else ties++;
}
console.log(`跑 ${N} 局全部通过（无异常、牌数守恒、均能终局）。`);
console.log(`平均回合数: ${(totalTurns / games).toFixed(1)}`);
console.log(`玩家(贪心)胜 ${pWins} / NPC胜 ${nWins} / 平 ${ties}`);

// 抽样展示一局
console.log('\n=== 抽样一局 ===');
playOne(true);
