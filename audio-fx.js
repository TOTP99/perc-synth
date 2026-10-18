/* audio-fx.js —— 钟鼓楼 · 声音解锁 + 音质增强
 *
 * 两个功能：
 * 1.  robustUnlock()：iOS  robust 解锁。iPhone 上 AudioContext 必须在用户
 *    手势内创建+resume，否则无声；切后台再回来也要 resume。
 * 2.  enhanceChain(ctx, masterGain)：在 masterGain 后插入音质链：
 *    masterGain → 高通(去低频浑浊) → presence(钟镲清晰度) → air(泛音光泽)
 *    → 干/湿 temple 混响 → 限幅 → destination
 *    混响 impulse 程序合成（2.2s 衰减，钟鼓楼殿堂感），湿比约 18%。
 *
 * 接入：在 index.html 里加 <script src="audio-fx.js">（主脚本之前），
 * 并在 initAudioGraph() 建完 masterGain/limiter 后调：
 *    PercFX.enhanceChain(audioCtx, masterGain);
 */
(function () {
  'use strict';

  var ctxRef = null;

  /* 程序合成 temple 混响 impulse：指数衰减噪声，立体声 */
  function makeImpulse(ctx, seconds, decay) {
    var rate = ctx.sampleRate;
    var len = Math.floor(rate * seconds);
    var buf = ctx.createBuffer(2, len, rate);
    for (var ch = 0; ch < 2; ch++) {
      var d = buf.getChannelData(ch);
      for (var i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  /* iOS 解锁补强：主脚本已在手势内建 ctx+resume，这里只补回前台 resume。
   * 不自己建 ctx，避免和主脚本的打架。 */
  function ensureResumed() {
    try {
      if (ctxRef && ctxRef.state === 'suspended') {
        var r = ctxRef.resume();
        if (r && r.catch) r.catch(function () {});
      }
      /* 强制解锁：静音缓冲走一遍，iOS 经典手法 */
      if (ctxRef && ctxRef.state === 'running') {
        try {
          var src = ctxRef.createBufferSource();
          src.buffer = ctxRef.createBuffer(1, 1, ctxRef.sampleRate || 44100);
          src.connect(ctxRef.destination);
          src.start(0);
        } catch (e) {}
      }
    } catch (e) {}
    refreshDot();
  }

  /* 让主脚本把它的 ctx 登记进来（initAudioGraph 里调） */
  function registerCtx(ctx) {
    if (ctx) ctxRef = ctx;
    refreshDot();
  }

  /* 在 masterGain 后插入音质链。调用后 masterGain 的输出走新链。 */
  function enhanceChain(ctx, masterGain) {
    if (!ctx || !masterGain) return false;
    try {
      registerCtx(ctx);
      // 断开 masterGain 原有连接（原：masterGain → limiter → destination）
      try { masterGain.disconnect(); } catch (e) {}

      // 1) 高通：切 25Hz 以下浑浊
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 25;

      // 2) presence：2.5kHz +2dB，钟/镲/磬的清晰度
      var presence = ctx.createBiquadFilter();
      presence.type = 'peaking';
      presence.frequency.value = 2500;
      presence.Q.value = 0.9;
      presence.gain.value = 2;

      // 3) air：10kHz 高架 +1.5dB，泛音光泽
      var air = ctx.createBiquadFilter();
      air.type = 'highshelf';
      air.frequency.value = 10000;
      air.gain.value = 1.5;

      // 4) temple 混响：干湿并行
      var dry = ctx.createGain();
      dry.gain.value = 0.82;
      var convolver = ctx.createConvolver();
      convolver.buffer = makeImpulse(ctx, 2.2, 2.8);
      var wet = ctx.createGain();
      wet.gain.value = 0.18;

      // 5) 限幅：多轨叠加防爆音（比原来稍紧）
      var limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -10;
      limiter.knee.value = 8;
      limiter.ratio.value = 8;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.12;

      // 接线
      masterGain.connect(hp);
      hp.connect(presence);
      presence.connect(air);
      air.connect(dry);
      air.connect(convolver);
      convolver.connect(wet);
      dry.connect(limiter);
      wet.connect(limiter);
      limiter.connect(ctx.destination);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* 手势内补 resume（主脚本 ensureAudio 已建 ctx，这里只确保 resume 到位） */
  ['pointerdown', 'touchstart', 'touchend', 'keydown'].forEach(function (evt) {
    document.addEventListener(evt, function () { ensureResumed(); }, { passive: true, capture: true });
  });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) ensureResumed();
  });

  window.PercFX = {
    unlock: ensureResumed,
    registerCtx: registerCtx,
    enhanceChain: enhanceChain,
    isUnlocked: function () { return !!ctxRef && ctxRef.state === 'running'; }
  };

  /* 右下角状态灯：灰=本文件未加载（由 index.html 兜底显示），
   * 橙=已加载但未解锁，绿=已解锁正常。手机上肉眼可见。 */
  function refreshDot() {
    try {
      var dot = document.getElementById('percFxDot');
      if (!dot) return;
      dot.style.background = (ctxRef && ctxRef.state === 'running') ? '#4caf50' : '#ff9800';
    } catch (e) {}
  }
  function mountDot() {
    try {
      if (document.getElementById('percFxDot')) { refreshDot(); return; }
      var dot = document.createElement('div');
      dot.id = 'percFxDot';
      dot.style.cssText = 'position:fixed;right:10px;bottom:10px;width:22px;height:22px;'
        + 'border-radius:50%;background:#ff9800;z-index:9999;opacity:.75;cursor:pointer;';
      dot.title = '点我强制解锁音频';
      /* 点圆点=强制解锁：真实手势内 resume+静音缓冲；
       * 事件冒泡到 document 还会触发主脚本的 ensureAudio() */
      dot.addEventListener('click', function () { ensureResumed(); }, { passive: true });
      var add = function () {
        try { document.body.appendChild(dot); } catch (e) {}
        refreshDot();
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', add);
      } else { add(); }
      setInterval(refreshDot, 2000);
    } catch (e) {}
  }
  mountDot();
})();
