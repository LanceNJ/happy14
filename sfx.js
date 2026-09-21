/*
 * 欢乐十四分 —— 音效（全部用振荡器合成，不需要任何音频素材文件）
 *  · Electron / 浏览器：AudioContext
 *  · 微信小程序：wx.createWebAudioContext()（基础库 2.19.0+）
 *  · 环境不支持（例如 Node 测试）：所有函数静默 no-op，绝不抛异常
 */
(function () {
  let ctx = null;
  let ctxTried = false;
  let muted = false;

  function getCtx() {
    if (ctx || ctxTried) return ctx;
    ctxTried = true;
    try {
      if (typeof wx !== 'undefined' && typeof wx.createWebAudioContext === 'function') {
        ctx = wx.createWebAudioContext();
      } else if (typeof AudioContext !== 'undefined') {
        ctx = new AudioContext();
      } else if (typeof webkitAudioContext !== 'undefined') {
        ctx = new webkitAudioContext();
      }
    } catch (e) { ctx = null; }
    return ctx;
  }

  // 浏览器策略：必须由用户交互唤醒，第一次点击时调一次即可
  function unlock() {
    const c = getCtx();
    if (c && c.state === 'suspended' && typeof c.resume === 'function') {
      try { c.resume(); } catch (e) { /* 忽略 */ }
    }
  }

  function readMuted() {
    try {
      if (typeof wx !== 'undefined' && typeof wx.getStorageSync === 'function') {
        muted = !!wx.getStorageSync('h14_muted');
      } else if (typeof localStorage !== 'undefined') {
        muted = localStorage.getItem('h14_muted') === '1';
      }
    } catch (e) { muted = false; }
    return muted;
  }

  function writeMuted() {
    try {
      if (typeof wx !== 'undefined' && typeof wx.setStorageSync === 'function') {
        wx.setStorageSync('h14_muted', muted ? 1 : 0);
      } else if (typeof localStorage !== 'undefined') {
        localStorage.setItem('h14_muted', muted ? '1' : '0');
      }
    } catch (e) { /* 忽略 */ }
  }

  // 一个音：freq → to 的滑音，dur 秒
  function tone(o) {
    if (muted) return;
    const c = getCtx();
    if (!c || !c.createOscillator || !c.createGain) return;
    try {
      const t0 = c.currentTime + (o.at || 0);
      const dur = o.dur || 0.12;
      const osc = c.createOscillator();
      const gn = c.createGain();
      osc.type = o.type || 'sine';
      const f0 = o.freq;
      const f1 = o.to || o.freq;
      osc.frequency.setValueAtTime(f0, t0);
      if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
      const peak = (o.gain == null ? 0.16 : o.gain);
      gn.gain.setValueAtTime(0.0001, t0);
      gn.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
      gn.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gn);
      gn.connect(c.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    } catch (e) { /* 静默降级 */ }
  }

  // 一小段旋律：依次弹（可重叠）
  function melody(notes, opt) {
    opt = opt || {};
    notes.forEach((n, i) => {
      tone({
        freq: n,
        dur: opt.dur || 0.16,
        at: i * (opt.gap || 0.11),
        type: opt.type || 'triangle',
        gain: opt.gain == null ? 0.16 : opt.gain,
      });
    });
  }

  const SFX = {
    unlock: unlock,
    isMuted: () => muted,
    load() { readMuted(); return muted; },
    setMuted(v) { muted = !!v; writeMuted(); return muted; },
    toggleMuted() { muted = !muted; writeMuted(); return muted; },

    tap() { tone({ freq: 660, dur: 0.06, type: 'sine', gain: 0.10 }); },        // 点牌
    ring() { tone({ freq: 740, dur: 0.07, type: 'triangle', gain: 0.12 }); },   // 圈住桌面牌
    flip() { tone({ freq: 520, to: 900, dur: 0.09, type: 'triangle', gain: 0.13 }); }, // 翻牌/锁定
    match() { melody([784, 988, 1319], { dur: 0.15, gap: 0.085, gain: 0.15 }); },      // 匹配成功
    joker() { melody([880, 1175, 1568], { dur: 0.13, gap: 0.075, gain: 0.16 }); },     // 捞到王：得意三连
    draw() { tone({ freq: 900, to: 1500, dur: 0.10, type: 'sine', gain: 0.09 }); },    // 补牌
    penalty() { tone({ freq: 300, to: 150, dur: 0.24, type: 'sawtooth', gain: 0.11 }); }, // 罚牌
    npc() { tone({ freq: 430, to: 340, dur: 0.10, type: 'triangle', gain: 0.10 }); },  // NPC 出牌
    // 开局：三声"发牌唰" + 上行三音，像洗好牌亮个相（约 0.5 秒）
    deal() {
      [0, 0.09, 0.18].forEach((at) => {
        tone({ freq: 1500, to: 620, dur: 0.07, type: 'triangle', gain: 0.10, at: at });
      });
    },
    start() {
      SFX.deal();
      [523, 659, 784].forEach((f, i) => {                       // 上行三音：开局
        tone({ freq: f, dur: 0.18, type: 'triangle', gain: 0.15, at: 0.30 + i * 0.10 });
      });
    },
    // 赢：号角上行 + 高音三连击 + 长音铺底，约 1.6 秒
    win() {
      [523, 659, 784, 1047].forEach((f, i) => {                 // C-E-G-C 号角
        tone({ freq: f, dur: 0.20, type: 'triangle', gain: 0.17, at: i * 0.085 });
      });
      [1047, 1319, 1568].forEach((f, i) => {                    // 高音三连击
        tone({ freq: f, dur: 0.14, type: 'sine', gain: 0.15, at: 0.40 + i * 0.085 });
      });
      tone({ freq: 1568, dur: 0.55, type: 'triangle', gain: 0.14, at: 0.68 });  // 收尾余韵
      tone({ freq: 1047, dur: 0.60, type: 'sine', gain: 0.12, at: 0.68 });
      tone({ freq: 262, dur: 0.95, type: 'triangle', gain: 0.11, at: 0.68 });
    },
    // 输：下行叹息 + 尾巴泄气，约 1.6 秒
    lose() {
      [440, 392, 330, 262].forEach((f, i) => {                  // A-G-E-C 一步比一步低
        tone({ freq: f, dur: 0.26, type: 'sine', gain: 0.15, at: i * 0.20 });
      });
      tone({ freq: 262, to: 130, dur: 0.75, type: 'sine', gain: 0.13, at: 0.84 });  // 滑下去
      tone({ freq: 196, dur: 0.90, type: 'triangle', gain: 0.09, at: 0.84 });
    },
    drawEnd() {                                                  // 平局：两声同音，不喜不悲
      tone({ freq: 523, dur: 0.20, type: 'triangle', gain: 0.15 });
      tone({ freq: 523, dur: 0.34, type: 'triangle', gain: 0.13, at: 0.22 });
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = SFX;
  if (typeof window !== 'undefined') window.SFX = SFX;
})();
