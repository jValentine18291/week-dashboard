'use strict';
/**
 * Animated hex-cube emblem — vanilla port of the supplied EmblemAnimation.jsx.
 *
 * Same timeline, geometry and tokens as the handoff component; React removed
 * because this project has no build step (see CLAUDE.md). React was only
 * driving the clock — every visual is already a pure function of T — so the
 * port builds the SVG once and mutates attributes per frame rather than
 * re-rendering, which is cheaper than the original anyway.
 *
 *   Emblem.create(hostElement, { size: 112, mode: 'idle', transparentBg: true })
 *
 * Options: size, mode ('full'|'idle'), speed, playing, transparentBg, onLoop.
 * Returns { destroy, setPlaying, el }.
 */
window.Emblem = (function () {
  var NS = 'http://www.w3.org/2000/svg';
  var uid = 0;

  // ── timeline ──────────────────────────────────────────────────────────────
  var SCENES = [['Ignition', 2.2], ['Frame', 2.6], ['Core', 3], ['Idle', 3.6], ['Pulse', 2.2], ['Fade', 1.4]];
  var CUES = {}, TOTAL = 0;
  SCENES.forEach(function (s) { CUES[s[0]] = TOTAL; TOTAL += s[1]; });

  // ── easing ────────────────────────────────────────────────────────────────
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function easeInOutQuart(t) { return t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2; }
  function easeOutBack(t) { var c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); }
  function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function anim(from, to, start, end, ease) {
    return function (T) {
      var p = clamp01((T - start) / (end - start || 1e-6));
      return from + (to - from) * (ease ? ease(p) : p);
    };
  }
  var MOTION = {
    enter: function (s, e) { return anim(0, 1, s, e, easeOutCubic); },
    draw: function (s, e) { return anim(0, 1, s, e, easeInOutQuart); },
    pop: function (s, e) { return anim(0, 1, s, e, easeOutBack); }
  };
  function gate(T, at) { return T >= at ? 1 : 0; }
  function flare(T, at, up, down) { return anim(0, 1, at, at + up)(T) * anim(1, 0, at + up, at + up + down)(T); }

  // ── geometry ──────────────────────────────────────────────────────────────
  var TAU = Math.PI * 2, CX = 540, CY = 540;
  function pt(r, aDeg) { var a = (Math.PI / 180) * aDeg; return [CX + r * Math.cos(a), CY + r * Math.sin(a)]; }
  function hexPts(r) {
    var out = [];
    for (var k = 0; k < 6; k++) { var p = pt(r, 60 * k - 90); out.push(p[0].toFixed(1) + ',' + p[1].toFixed(1)); }
    return out.join(' ');
  }
  var ACCENTS = [];
  for (var k = 0; k < 6; k++) {
    var a1 = pt(452, 60 * k - 90), a2 = pt(452, 60 * (k + 1) - 90);
    var mx = (a1[0] + a2[0]) / 2, my = (a1[1] + a2[1]) / 2;
    var dx = a2[0] - a1[0], dy = a2[1] - a1[1], len = Math.hypot(dx, dy);
    ACCENTS.push({ x1: mx - dx / len * 38, y1: my - dy / len * 38, x2: mx + dx / len * 38, y2: my + dy / len * 38 });
  }
  var VERTS = [];
  for (var v = 0; v < 6; v++) VERTS.push(pt(462, 60 * v - 90));
  var STARS = (function () {
    var seed = 5, out = [];
    function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
    for (var i = 0; i < 16; i++) out.push({ x: rnd() * 1080, y: rnd() * 1080, r: 1 + rnd() * 2, ph: rnd() * TAU, sp: 0.6 + rnd() * 1.2 });
    return out;
  })();
  var FACES = [
    { pts: '0,-128 110,-64 0,0 -110,-64', fill: 'rgba(238,250,255,.96)', from: [0, -110] },
    { pts: '-110,-64 0,0 0,128 -110,64', fill: 'rgba(125,208,255,.78)', from: [-100, 70] },
    { pts: '110,-64 0,0 0,128 110,64', fill: 'rgba(62,152,232,.8)', from: [100, 70] }
  ];

  function el(name, attrs) {
    var n = document.createElementNS(NS, name);
    if (attrs) for (var key in attrs) n.setAttribute(key, attrs[key]);
    return n;
  }

  function create(host, opts) {
    opts = opts || {};
    var size = opts.size == null ? '100%' : opts.size;
    var mode = opts.mode === 'idle' ? 'idle' : 'full';
    var speed = opts.speed || 1;
    var playing = opts.playing !== false;
    var idle = mode === 'idle';
    var ns = 'emb' + (++uid);

    var svg = el('svg', { viewBox: '0 0 1080 1080' });
    svg.style.width = typeof size === 'number' ? size + 'px' : size;
    svg.style.height = typeof size === 'number' ? size + 'px' : size;
    svg.style.display = 'block';
    if (!opts.transparentBg) svg.style.background = 'radial-gradient(60% 60% at 50% 50%, #051022 0%, #02040c 70%)';

    var defs = el('defs');
    var grad = el('linearGradient', { id: ns + '-ring', x1: '0', y1: '0', x2: '1', y2: '1' });
    [['0', '#9fe8ff'], ['.45', '#4cc3ff'], ['1', '#1f7ae0']].forEach(function (s) {
      grad.appendChild(el('stop', { offset: s[0], 'stop-color': s[1] }));
    });
    var filt = el('filter', { id: ns + '-soft', x: '-40%', y: '-40%', width: '180%', height: '180%' });
    filt.appendChild(el('feGaussianBlur', { stdDeviation: '9' }));
    defs.appendChild(grad); defs.appendChild(filt); svg.appendChild(defs);

    var G = el('g'); svg.appendChild(G);
    var R = {};   // mutable refs

    R.stars = STARS.map(function (s) {
      var c = el('circle', { cx: s.x, cy: s.y, r: s.r, fill: '#7fd4ff' });
      G.appendChild(c); return c;
    });
    R.igRing = el('circle', { cx: CX, cy: CY, r: 12, stroke: '#8fdcff', 'stroke-width': '2.5', fill: 'none' });
    R.spark = el('circle', { cx: CX, cy: CY, r: 16, fill: '#cfeeff', filter: 'url(#' + ns + '-soft)' });
    R.sparkCore = el('circle', { cx: CX, cy: CY, r: 5, fill: '#ffffff' });
    G.appendChild(R.igRing); G.appendChild(R.spark); G.appendChild(R.sparkCore);

    R.rotDots = el('g');
    R.dots = el('circle', { cx: CX, cy: CY, r: '398', stroke: 'rgba(76,195,255,.3)', 'stroke-width': '1.6', fill: 'none', 'stroke-dasharray': '3 15' });
    R.rotDots.appendChild(R.dots); G.appendChild(R.rotDots);

    R.rotHex = el('g');
    R.outerHex = el('polygon', { points: hexPts(505), stroke: 'rgba(76,195,255,.14)', 'stroke-width': '1.4', fill: 'none', 'stroke-dasharray': '26 20' });
    R.rotHex.appendChild(R.outerHex); G.appendChild(R.rotHex);

    R.frame1 = el('polygon', { points: hexPts(462), stroke: 'rgba(140,215,255,.6)', 'stroke-width': '3', fill: 'none', pathLength: '100', 'stroke-dasharray': '100', 'stroke-linecap': 'round' });
    R.frame2 = el('polygon', { points: hexPts(440), stroke: 'rgba(76,195,255,.28)', 'stroke-width': '1.6', fill: 'none', pathLength: '100', 'stroke-dasharray': '100' });
    R.frameGlint = el('polygon', { points: hexPts(462), stroke: '#eaf9ff', 'stroke-width': '4', fill: 'none', pathLength: '100', 'stroke-dasharray': '7 93', 'stroke-linecap': 'round' });
    G.appendChild(R.frame1); G.appendChild(R.frame2); G.appendChild(R.frameGlint);

    R.accents = ACCENTS.map(function (a) {
      var l = el('line', { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, stroke: '#4cc3ff', 'stroke-width': '5', 'stroke-linecap': 'round' });
      G.appendChild(l); return l;
    });
    R.verts = VERTS.map(function (p) {
      var c = el('circle', { cx: p[0], cy: p[1], r: '5', fill: '#8fdcff' });
      G.appendChild(c); return c;
    });

    R.huds = [{ x: 92, d: 1 }, { x: 988, d: -1 }].map(function (s) {
      var g = el('g');
      [-3, -2, -1, 1, 2, 3].forEach(function (kk) {
        g.appendChild(el('circle', { cx: s.x, cy: 540 + kk * 26, r: '2.6', fill: 'rgba(120,200,255,.6)' }));
      });
      var core = el('circle', { cx: s.x, cy: '540', r: '7', fill: '#4cc3ff' });
      g.appendChild(core);
      g.appendChild(el('rect', { x: s.x - 4 + s.d * 22, y: '532', width: '8', height: '16', fill: 'rgba(76,195,255,.7)' }));
      g.appendChild(el('line', { x1: s.x + s.d * 44, y1: '470', x2: s.x + s.d * 44, y2: '610', stroke: 'rgba(76,195,255,.25)', 'stroke-width': '1.5' }));
      G.appendChild(g);
      return { g: g, core: core, d: s.d };
    });

    R.waves = [0, 1].map(function (i) {
      var p = el('polygon', { points: hexPts(340), stroke: '#8fdcff', 'stroke-width': String(5 - i * 2), fill: 'none' });
      G.appendChild(p); return p;
    });

    R.ringGlow = el('polygon', { points: hexPts(330), stroke: 'url(#' + ns + '-ring)', 'stroke-width': '38', fill: 'none', filter: 'url(#' + ns + '-soft)', 'stroke-linejoin': 'round' });
    R.ringMain = el('polygon', { points: hexPts(330), stroke: 'url(#' + ns + '-ring)', 'stroke-width': '24', fill: 'none', 'stroke-linejoin': 'round', pathLength: '100', 'stroke-dasharray': '100' });
    R.ringGlint = el('polygon', { points: hexPts(330), stroke: '#ffffff', 'stroke-width': '10', fill: 'none', 'stroke-linejoin': 'round', 'stroke-linecap': 'round', pathLength: '100', 'stroke-dasharray': '12 88' });
    G.appendChild(R.ringGlow); G.appendChild(R.ringMain); G.appendChild(R.ringGlint);

    R.facet = el('g');
    R.facet.appendChild(el('polygon', { points: hexPts(258), fill: 'rgba(7,16,32,.94)', stroke: 'rgba(120,200,255,.4)', 'stroke-width': '2.5' }));
    R.facet.appendChild(el('polygon', { points: hexPts(216), fill: 'none', stroke: 'rgba(120,200,255,.16)', 'stroke-width': '1.5' }));
    G.appendChild(R.facet);

    R.cube = el('g');
    R.faces = FACES.map(function (f) {
      var g = el('g');
      g.appendChild(el('polygon', { points: f.pts, fill: f.fill, stroke: '#eefaff', 'stroke-width': '4.5', 'stroke-linejoin': 'round' }));
      R.cube.appendChild(g); return g;
    });
    R.topHi = el('polygon', { points: '0,-128 110,-64 0,0 -110,-64', transform: 'translate(' + CX + ' ' + CY + ')', fill: '#ffffff' });
    R.cube.appendChild(R.topHi); G.appendChild(R.cube);

    R.flash = el('rect', { x: '0', y: '0', width: '1080', height: '1080', fill: '#dff4ff' });
    G.appendChild(R.flash);

    host.appendChild(svg);

    // ── frame ───────────────────────────────────────────────────────────────
    function draw(T) {
      var breathe = 0.5 + 0.5 * Math.sin(T * TAU / 3);
      var gOp = idle ? 1 : anim(1, 0, CUES.Fade + 0.15, TOTAL - 0.05)(T);
      var punch = idle ? 0 : flare(T, CUES.Pulse, 0.12, 0.9);
      var gScale = idle ? 1 : 1 - 0.05 * anim(0, 1, CUES.Fade, TOTAL, easeInOutCubic)(T) + 0.05 * punch;
      G.setAttribute('opacity', gOp);
      G.setAttribute('transform', 'translate(' + CX + ' ' + CY + ') scale(' + gScale + ') translate(' + (-CX) + ' ' + (-CY) + ')');

      var starsOp = idle ? 1 : MOTION.enter(CUES.Frame + 0.8, CUES.Frame + 2)(T);
      for (var i = 0; i < R.stars.length; i++) {
        var s = STARS[i];
        R.stars[i].setAttribute('opacity', starsOp * (0.15 + 0.4 * (0.5 + 0.5 * Math.sin(T * s.sp * TAU / 4 + s.ph))));
      }

      var sparkOp = idle ? 0 : gate(T, 0.15) * MOTION.enter(0.15, 0.7)(T) * anim(1, 0, CUES.Frame - 0.4, CUES.Frame + 0.5)(T);
      R.igRing.setAttribute('r', anim(12, 470, 0.5, CUES.Frame + 0.4, easeOutCubic)(T));
      R.igRing.setAttribute('opacity', idle ? 0 : gate(T, 0.5) * anim(0.9, 0, 0.7, CUES.Frame + 0.4)(T));
      R.spark.setAttribute('r', 16 + 26 * sparkOp);
      R.spark.setAttribute('opacity', sparkOp);
      R.sparkCore.setAttribute('opacity', sparkOp);

      var accentsOp = idle ? 1 : MOTION.enter(CUES.Frame + 1.3, CUES.Frame + 2.2)(T);
      R.rotDots.setAttribute('transform', 'rotate(' + (T * 8) + ' ' + CX + ' ' + CY + ')');
      R.dots.setAttribute('opacity', accentsOp * 0.9);
      R.rotHex.setAttribute('transform', 'rotate(' + (-T * 5) + ' ' + CX + ' ' + CY + ')');
      R.outerHex.setAttribute('opacity', accentsOp);

      var frameDraw = idle ? 1 : MOTION.draw(CUES.Frame, CUES.Frame + 1.7)(T);
      var frame2Draw = idle ? 1 : MOTION.draw(CUES.Frame + 0.3, CUES.Frame + 2)(T);
      R.frame1.setAttribute('stroke-dashoffset', 100 - frameDraw * 100);
      R.frame2.setAttribute('stroke-dashoffset', -(100 - frame2Draw * 100));
      R.frameGlint.setAttribute('stroke-dashoffset', -((T * 6) % 100));
      R.frameGlint.setAttribute('opacity', accentsOp * (0.35 + 0.6 * breathe));

      for (var a = 0; a < R.accents.length; a++) R.accents[a].setAttribute('opacity', accentsOp * (a % 2 ? 0.5 : 0.85));
      for (var vv = 0; vv < R.verts.length; vv++) {
        var on = idle ? 1 : MOTION.enter(CUES.Frame + 1.2 + vv * 0.1, CUES.Frame + 1.5 + vv * 0.1)(T);
        R.verts[vv].setAttribute('opacity', on * (0.5 + 0.5 * Math.sin(T * 2 + vv)));
      }

      var hudP = idle ? 1 : MOTION.enter(CUES.Frame + 1.1, CUES.Frame + 2.2)(T);
      R.huds.forEach(function (h) {
        h.g.setAttribute('opacity', hudP);
        h.g.setAttribute('transform', 'translate(' + ((1 - hudP) * -34 * h.d) + ' 0)');
        h.core.setAttribute('opacity', 0.5 + 0.5 * breathe);
      });

      R.waves.forEach(function (w, i) {
        var st = CUES.Pulse + i * 0.35;
        var kk = idle ? 1 : 1 + 0.85 * anim(0, 1, st, st + 1.3, easeOutCubic)(T);
        var op = idle ? 0 : gate(T, st) * anim(0.75, 0, st, st + 1.3)(T);
        w.setAttribute('opacity', op);
        w.setAttribute('transform', 'translate(' + CX + ' ' + CY + ') scale(' + kk + ') translate(' + (-CX) + ' ' + (-CY) + ')');
      });

      var ringDraw = idle ? 1 : MOTION.draw(CUES.Core, CUES.Core + 1.5)(T);
      var ringGlow = (idle ? 1 : MOTION.enter(CUES.Core + 0.9, CUES.Core + 1.8)(T)) * (0.55 + 0.45 * breathe);
      R.ringGlow.setAttribute('opacity', ringGlow * 0.6);
      R.ringMain.setAttribute('stroke-dashoffset', 100 - ringDraw * 100);
      R.ringMain.setAttribute('opacity', 0.55 + 0.45 * ringGlow);
      R.ringGlint.setAttribute('stroke-dashoffset', -((T * 16) % 100));
      R.ringGlint.setAttribute('opacity', ringGlow * 0.8);

      var facetP = idle ? 1 : MOTION.pop(CUES.Core + 0.5, CUES.Core + 1.3)(T);
      R.facet.setAttribute('opacity', Math.min(1, facetP * 1.4));
      R.facet.setAttribute('transform', 'translate(' + CX + ' ' + CY + ') scale(' + (0.8 + 0.2 * facetP) + ') translate(' + (-CX) + ' ' + (-CY) + ')');

      var assembled = idle ? 1 : MOTION.enter(CUES.Core + 1.8, CUES.Core + 2.2)(T);
      var float = Math.sin(T * 1.4) * 7 * assembled;
      var cubeGlow = (8 + 16 * breathe) * assembled + 26 * punch;
      R.cube.setAttribute('transform', 'translate(0 ' + float + ')');
      R.cube.style.filter = 'drop-shadow(0 0 ' + cubeGlow + 'px rgba(110,200,255,.9))';
      R.faces.forEach(function (g, i) {
        var st = CUES.Core + 0.9 + i * 0.18;
        var p = idle ? 1 : MOTION.pop(st, st + 0.75)(T);
        var op = idle ? 1 : MOTION.enter(st, st + 0.4)(T);
        var f = FACES[i];
        g.setAttribute('transform', 'translate(' + (CX + f.from[0] * (1 - p)) + ' ' + (CY + f.from[1] * (1 - p)) + ')');
        g.setAttribute('opacity', op);
      });
      R.topHi.setAttribute('opacity', assembled * (0.12 + 0.3 * breathe));

      R.flash.setAttribute('opacity', idle ? 0 : flare(T, CUES.Pulse, 0.1, 0.55) * 0.55);
    }

    // ── clock ───────────────────────────────────────────────────────────────
    var t = idle ? CUES.Idle : 0, last = null, raf = null, killed = false;
    function step(now) {
      if (killed) return;
      if (last == null) last = now;
      t += ((now - last) / 1000) * speed;
      last = now;
      if (idle) {
        if (t >= CUES.Pulse) t = CUES.Idle + ((t - CUES.Idle) % (CUES.Pulse - CUES.Idle));
      } else if (t >= TOTAL) {
        t = t % TOTAL;
        // onLoop is allowed to destroy this instance. Re-check before doing
        // anything else, or the frame we schedule below outlives the teardown
        // and animates a detached SVG forever.
        if (opts.onLoop) opts.onLoop();
        if (killed) return;
      }
      draw(t);
      if (!killed) raf = requestAnimationFrame(step);
    }
    function start() { if (!killed && raf == null) { last = null; raf = requestAnimationFrame(step); } }
    function stop() { if (raf != null) { cancelAnimationFrame(raf); raf = null; } }

    draw(t);

    // Honour the OS setting, and stop burning frames on a hidden tab.
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (playing && !reduced) start();
    function onVis() { if (document.hidden) stop(); else if (playing && !reduced) start(); }
    document.addEventListener('visibilitychange', onVis);

    return {
      el: svg,
      setPlaying: function (v) { playing = v; if (v && !reduced) start(); else stop(); },
      destroy: function () {
        killed = true;
        stop();
        document.removeEventListener('visibilitychange', onVis);
        if (svg.parentNode) svg.parentNode.removeChild(svg);
      }
    };
  }

  return { create: create, TOTAL: TOTAL, CUES: CUES };
})();
