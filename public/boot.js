'use strict';
/**
 * Boot sequence — Productivity OS loading screen.
 *
 * Driven by the app's REAL loading state, not a timer. The handoff allows a
 * simulated run; we don't use it, because showing five modules "syncing" after
 * the data has already arrived would be theatre. What the app can actually
 * observe is: session resolved -> dashboard fetch in flight -> payload back,
 * with per-panel success or failure inside it. That is what drives progress.
 *
 * Market Feed and News Stream are rendered in a STANDBY state rather than
 * spinning. They are phase 2 and do not exist; a spinner that never resolves
 * would be a lie, and the handoff explicitly says not to leave one stuck.
 *
 * Runs on first paint only. The dashboard reloads itself every five minutes
 * and must never boot again.
 *
 *   var b = Boot.start();
 *   b.progress(40); b.module('calendar','done'); b.finish().then(...)
 *   b.abort();   // e.g. 401 -> straight to the login gate
 */
window.Boot = (function () {
  var MIN_VISIBLE_MS = 1800;   // handoff + brief both sanction a short floor
  // Was 900. That was 900ms in which nothing moved but the words, and it sat
  // between a finished boot and a dashboard nobody could see yet. Shortening
  // the hold is not the same as shortening MIN_VISIBLE_MS, which stays put.
  var READY_HOLD_MS = 400;
  var SEGMENTS = 26;
  var BLOCKS = 6;

  var MODULES = [
    { id: 'calendar', col: 'l', name: 'CALENDAR SYNC', desc: 'Google Calendar feed', colour: '#4cc3ff',
      icon: 'M3 5h18v16H3zM3 10h18M8 3v4M16 3v4' },
    { id: 'tasks', col: 'l', name: 'TASK ENGINE', desc: 'Weekly tasks & priorities', colour: '#4cc3ff',
      icon: 'M3.5 7.5l2 2 3.5-3.5M3.5 17.5l2 2 3.5-3.5M13 7h7.5M13 18h7.5' },
    { id: 'news', col: 'l', name: 'NEWS STREAM', desc: 'RSS intelligence feeds', colour: '#4cc3ff',
      icon: 'M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3a15 15 0 010 18a15 15 0 010-18' },
    { id: 'market', col: 'r', name: 'MARKET FEED', desc: 'Not provisioned', colour: '#a78bfa',
      icon: 'M3 17l5-6 4 4 5-8 4 5', standby: true },
    // Notes moved to standby when its panel was replaced by News. The Notion
    // reader still exists; only the panel is gone.
    { id: 'notes', col: 'r', name: 'NOTES CACHE', desc: 'Panel deferred', colour: '#a78bfa',
      icon: 'M5 3h8l6 6v12H5zM13 3v6h6M8 13.5h7M8 17.5h4.5', standby: true }
  ];

  var CIRCUIT = [
    ['M40 12 L26 12 L12 26 L12 60 M1620 12 L1634 12 L1648 26 L1648 60 M40 908 L26 908 L12 894 L12 860 M1620 908 L1634 908 L1648 894 L1648 860', '#4cc3ff', 2.5, .8],
    ['M12 26 L12 894 M1648 26 L1648 894 M26 12 L1634 12 M26 908 L1634 908', 'rgba(76,195,255,.18)', 1, 1],
    ['M380 12 l34 30 h190 M560 12 h120 l26 24 M1280 12 l-34 30 h-190 M1100 12 h-120 l-26 24', 'rgba(76,195,255,.4)', 1.2, 1],
    ['M150 12 v22 h90 M1510 12 v22 h-90', 'rgba(76,195,255,.3)', 1, 1],
    ['M12 250 h22 v90 M12 620 h22 v-90 M1648 250 h-22 v90 M1648 620 h-22 v-90', 'rgba(76,195,255,.3)', 1, 1],
    ['M280 908 h170 l24 -18 h140 M1380 908 h-170 l-24 -18 h-140', 'rgba(76,195,255,.35)', 1.2, 1],
    ['M560 852 h190 l26 22 h108 l26 -22 h190', 'rgba(76,195,255,.22)', 1, 1],
    ['M470 60 h60 M1130 60 h60 M820 66 v18', 'rgba(76,195,255,.3)', 1, 1]
  ];
  var NODES = [[604,42,3,.8],[1056,42,3,.8],[706,36,2.5,.6],[954,36,2.5,.6],
               [240,34,2.5,.5],[1420,34,2.5,.5],[34,340,2.5,.5],[1626,340,2.5,.5],
               [614,890,3,.7],[1046,890,3,.7]];

  function h(tag, cls, css) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (css) n.setAttribute('style', css);
    return n;
  }
  function svgEl(tag, attrs) {
    var n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  function icon(d, colour, size) {
    var s = svgEl('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
      stroke: colour, 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    s.style.flexShrink = '0';
    s.appendChild(svgEl('path', { d: d }));
    return s;
  }

  // opts.onLeave fires on the frame the screen starts to leave, so the caller
  // can begin the dashboard's own entrance against the same moment. Without it
  // the two motions can only be queued, and the handoff reads as a cut.
  function start(opts) {
    opts = opts || {};
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var root = h('div', null); root.id = 'boot';
    var stage = h('div', 'bt-stage');
    root.appendChild(stage);

    // ── background ────────────────────────────────────────────────────────
    ['bt-grid', 'bt-scan', 'bt-floorglow'].forEach(function (c) { stage.appendChild(h('div', c)); });
    ['bt-r1', 'bt-r2', 'bt-r3', 'bt-r4'].forEach(function (c) { stage.appendChild(h('div', 'bt-radar ' + c)); });

    var seed = 7;
    function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
    for (var b = 0; b < 8; b++) {
      var left = (b < 4 ? 6 + rnd() * 16 : 77 + rnd() * 17).toFixed(1);
      stage.appendChild(h('div', 'bt-beam', 'left:' + left + '%;height:' + (70 + rnd() * 70).toFixed(0) +
        'px;animation:bt-beam ' + (3.2 + rnd() * 1.4).toFixed(1) + 's ease-out ' + (rnd() * 3).toFixed(1) + 's infinite'));
    }
    stage.appendChild(h('div', 'bt-floor'));
    stage.appendChild(h('div', 'bt-violet'));
    stage.appendChild(h('div', 'bt-map bt-map-l'));
    stage.appendChild(h('div', 'bt-map bt-map-r'));

    var colours = ['rgba(140,220,255,.9)', 'rgba(76,195,255,.8)', 'rgba(167,139,250,.7)'];
    for (var p = 0; p < 34; p++) {
      var drift = p % 3 !== 0, sz = 1.5 + rnd() * 2.5, col = colours[p % 3];
      var dur = (6 + rnd() * 9).toFixed(1), delay = (rnd() * 9).toFixed(1);
      stage.appendChild(h('div', 'bt-particle',
        'left:' + (rnd() * 97 + 1).toFixed(1) + '%;top:' + (rnd() * 88 + 4).toFixed(1) + '%;' +
        'width:' + sz.toFixed(1) + 'px;height:' + sz.toFixed(1) + 'px;background:' + col + ';' +
        'box-shadow:0 0 ' + (sz * 2.5).toFixed(0) + 'px ' + col + ';animation:' +
        (drift ? 'bt-particle ' + dur + 's linear ' + delay + 's infinite'
               : 'bt-twinkle ' + (2 + rnd() * 4).toFixed(1) + 's ease-in-out ' + delay + 's infinite')));
    }

    var circuit = svgEl('svg', { viewBox: '0 0 1660 920', fill: 'none', preserveAspectRatio: 'none' });
    circuit.setAttribute('class', 'bt-circuit');
    CIRCUIT.forEach(function (c) {
      circuit.appendChild(svgEl('path', { d: c[0], stroke: c[1], 'stroke-width': c[2], opacity: c[3] }));
    });
    NODES.forEach(function (n) {
      circuit.appendChild(svgEl('circle', { cx: n[0], cy: n[1], r: n[2], fill: '#4cc3ff', opacity: n[3] }));
    });
    stage.appendChild(circuit);

    // ── header ────────────────────────────────────────────────────────────
    var head = h('div', 'bt-head');
    var brand = h('div', 'bt-brand');
    var hex = h('div', 'bt-hex'), hexIn = h('div', 'bt-hex-in');
    var hexSvg = svgEl('svg', { width: '26', height: '26', viewBox: '0 0 24 24', fill: 'none',
      stroke: '#8fdcff', 'stroke-width': '1.6', 'stroke-linejoin': 'round' });
    hexSvg.appendChild(svgEl('path', { d: 'M12 3l8 4.6v8.8L12 21l-8-4.6V7.6z' }));
    hexSvg.appendChild(svgEl('path', { d: 'M4 7.6l8 4.6 8-4.6M12 12.2V21' }));
    hexIn.appendChild(hexSvg); hex.appendChild(hexIn); brand.appendChild(hex);
    var brandTxt = h('div');
    var t1 = h('div', 'bt-title'); t1.textContent = 'PRODUCTIVITY OS';
    var t2 = h('div', 'bt-tag'); t2.textContent = 'CONTROL • FOCUS • EXECUTE';
    brandTxt.appendChild(t1); brandTxt.appendChild(t2); brand.appendChild(brandTxt);
    head.appendChild(brand);

    var st = h('div', 'bt-status');
    var stl = h('div', 'bt-status-lbl'); stl.textContent = 'SYSTEM STATUS'; st.appendChild(stl);
    var beat = svgEl('svg', { width: '54', height: '22', viewBox: '0 0 54 22', fill: 'none' });
    var poly = svgEl('polyline', { points: '0,11 12,11 17,3 23,19 28,11 54,11', stroke: '#4cc3ff',
      'stroke-width': '1.6', 'stroke-dasharray': '70 70' });
    poly.style.animation = 'bt-dash 1.6s linear infinite';
    beat.appendChild(poly); st.appendChild(beat);
    var blocks = h('div', 'bt-blocks'), blockEls = [];
    for (var i = 0; i < BLOCKS; i++) { var bl = h('div', 'bt-block'); blocks.appendChild(bl); blockEls.push(bl); }
    st.appendChild(blocks); head.appendChild(st);
    stage.appendChild(head);

    // ── main ──────────────────────────────────────────────────────────────
    var main = h('div', 'bt-main');
    var colL = h('div', 'bt-col'), colR = h('div', 'bt-col');
    var cards = {};
    MODULES.forEach(function (m) {
      var card = h('div', 'bt-card' + (m.col === 'r' ? ' violet' : ''));
      var inner = h('div', 'bt-card-in');
      inner.appendChild(icon(m.icon, m.colour, 30));
      var body = h('div', 'bt-card-body');
      var nm = h('div', 'bt-card-name'); nm.textContent = m.name; nm.style.color = m.colour;
      var de = h('div', 'bt-card-desc'); de.textContent = m.desc;
      var dots = h('div', 'bt-dots'), dotEls = [];
      for (var d = 0; d < 5; d++) { var dot = h('div', 'bt-dot'); dots.appendChild(dot); dotEls.push(dot); }
      body.appendChild(nm); body.appendChild(de); body.appendChild(dots);
      inner.appendChild(body);

      var status;
      if (m.standby) {
        status = h('div', 'bt-standby'); status.textContent = '–';
        card.classList.add('lit'); card.style.opacity = '.4';
      } else {
        status = h('div', 'bt-spinner');
        status.style.borderTopColor = m.colour;
        status.style.borderRightColor = m.colour;
      }
      inner.appendChild(status);
      card.appendChild(inner);
      (m.col === 'l' ? colL : colR).appendChild(card);
      cards[m.id] = { card: card, dots: dotEls, status: status, desc: de, mod: m, state: 'pending' };
    });

    var centre = h('div', 'bt-centre');
    var badge = h('div', 'bt-badge');
    var ring = h('div', 'bt-badge-ring'); ring.appendChild(h('div'));
    badge.appendChild(ring);
    badge.appendChild(h('div', 'bt-conn bt-conn-l'));
    badge.appendChild(h('div', 'bt-conn bt-conn-r'));
    badge.appendChild(h('div', 'bt-node bt-node-l'));
    badge.appendChild(h('div', 'bt-node bt-node-r'));
    var core = h('div', 'bt-core'), coreIn = h('div', 'bt-core-in');
    core.appendChild(coreIn); badge.appendChild(core); centre.appendChild(badge);

    var wrap = h('div', 'bt-panel-wrap');
    ['bt-acc bt-acc-tl','bt-acc bt-acc-tr','bt-acc bt-acc-bl','bt-acc bt-acc-br',
     'bt-edge bt-edge-tl','bt-edge bt-edge-tr','bt-edge bt-edge-bl','bt-edge bt-edge-br']
      .forEach(function (c) { wrap.appendChild(h('div', c)); });

    var panel = h('div', 'bt-panel'), pin = h('div', 'bt-panel-in');
    var eyebrow = h('div', 'bt-eyebrow'); eyebrow.textContent = 'SYSTEM BOOT SEQUENCE';
    var h1 = h('div', 'bt-h1'); h1.textContent = 'INITIALIZING';
    var h2 = h('div', 'bt-h2'); h2.textContent = 'PRODUCTIVITY DASHBOARD';
    var blink = h('div', 'bt-blink'); blink.appendChild(h('div')); blink.appendChild(h('div')); blink.appendChild(h('div'));
    var line = h('div', 'bt-line'); line.textContent = 'Establishing secure connection…';
    var prog = h('div', 'bt-prog');
    var ringEl = h('div', 'bt-ring'), ringCore = h('div', 'bt-ring-core');
    var pct = h('div', 'bt-pct'); pct.textContent = '0%';
    ringCore.appendChild(pct); ringEl.appendChild(ringCore); prog.appendChild(ringEl);
    var barWrap = h('div', 'bt-bar-wrap'), bar = h('div', 'bt-bar'), segEls = [];
    for (var s = 0; s < SEGMENTS; s++) { var sg = h('div', 'bt-seg'); bar.appendChild(sg); segEls.push(sg); }
    var mono = h('div', 'bt-mono'); mono.textContent = '> INITIALIZING_';
    barWrap.appendChild(bar); barWrap.appendChild(mono); prog.appendChild(barWrap);
    var footLbl = h('div', 'bt-foot-lbl'); footLbl.textContent = 'PLEASE WAIT WHILE WE PREPARE YOUR COMMAND CENTER';
    [eyebrow, h1, h2, blink, line, prog, footLbl].forEach(function (n) { pin.appendChild(n); });
    panel.appendChild(pin); wrap.appendChild(panel); centre.appendChild(wrap);

    main.appendChild(colL); main.appendChild(centre); main.appendChild(colR);
    stage.appendChild(main);

    // ── footer ────────────────────────────────────────────────────────────
    var foot = h('div', 'bt-foot');
    var fl = h('div');
    var lock = svgEl('svg', { width: '15', height: '15', viewBox: '0 0 24 24', fill: 'none', stroke: '#7f9cc4', 'stroke-width': '2' });
    lock.appendChild(svgEl('path', { d: 'M6 11V8a6 6 0 0112 0v3M5 11h14v10H5z' }));
    fl.appendChild(lock);
    ['SECURE CONNECTION', '|', '256-BIT ENCRYPTION'].forEach(function (txt, k) {
      var sp = h('span', k === 1 ? 'bt-div' : (k === 2 ? 'bt-cy' : 'bt-mute'));
      sp.textContent = txt; fl.appendChild(sp);
    });
    var fr = h('div');
    var bv = h('span', 'bt-mute'); bv.textContent = 'BUILD 2.5.7';
    var dv = h('span', 'bt-div'); dv.textContent = '|';
    var so = h('span', 'bt-mute'); so.innerHTML = 'STATUS: <span class="bt-ok">ONLINE</span>';
    fr.appendChild(bv); fr.appendChild(dv); fr.appendChild(so); fr.appendChild(h('div', 'bt-live'));
    foot.appendChild(fl); foot.appendChild(fr);
    stage.appendChild(foot);

    document.body.appendChild(root);

    // The same emblem the rail uses — one system, not two.
    var emblem = null;
    if (window.Emblem) emblem = window.Emblem.create(coreIn, { size: 70, mode: 'full', transparentBg: true });

    // ── scale-to-fit (handoff scaling model) ──────────────────────────────
    function fit() {
      var s = Math.min(window.innerWidth / 1660, window.innerHeight / 920);
      stage.style.transform = 'scale(' + s + ')';
    }
    fit();
    window.addEventListener('resize', fit);

    // ── progress ──────────────────────────────────────────────────────────
    var shown = 0, target = 0, born = Date.now(), done = false, timer = null;
    var LINES = {
      12: 'Establishing secure connection…',
      30: 'Synchronizing Google Calendar…',
      55: 'Loading weekly tasks and priorities…',
      75: 'Preparing notes workspace…',
      92: 'Finalizing command center…'
    };

    function paint() {
      var p = Math.round(shown);
      pct.textContent = p + '%';
      ringEl.style.background = 'conic-gradient(#4cc3ff ' + (shown * 3.6) + 'deg, rgba(76,195,255,.12) 0deg)';
      var lit = Math.round(shown / 100 * SEGMENTS);
      for (var i = 0; i < SEGMENTS; i++) segEls[i].classList.toggle('on', i < lit);
      for (var b2 = 0; b2 < BLOCKS; b2++) blockEls[b2].classList.toggle('on', shown >= (b2 + 1) * 100 / BLOCKS - 1);
      core.style.filter = 'drop-shadow(0 0 ' + (6 + shown / 100 * 22) + 'px rgba(76,195,255,' + (0.45 + shown / 100 * 0.55) + '))';
      var msg = null;
      for (var k in LINES) if (shown >= +k) msg = LINES[k];
      if (msg && line.textContent !== msg) line.textContent = msg;
    }

    function activeName() {
      for (var i = 0; i < MODULES.length; i++) {
        var c = cards[MODULES[i].id];
        if (!c.mod.standby && c.state !== 'done') return c.mod.name;
      }
      return null;
    }

    function tick() {
      if (shown < target) shown = Math.min(target, shown + Math.max(0.4, (target - shown) * 0.12));
      paint();
      var a = activeName();
      var want = a ? '> LOADING MODULE: ' + a + '_' : '> ALL MODULES ONLINE_';
      if (mono.textContent !== want) mono.textContent = want;
      // Partially fill the active module's dots so it reads as working.
      MODULES.forEach(function (m) {
        var c = cards[m.id];
        if (m.standby || c.state === 'done') return;
        var frac = Math.min(1, shown / 100 * 1.2);
        c.dots.forEach(function (d, di) {
          var on = di < Math.round(frac * 5);
          d.style.background = on ? m.colour : 'rgba(120,160,220,.22)';
          d.style.boxShadow = on ? '0 0 6px ' + m.colour : 'none';
        });
        if (shown > 6) c.card.classList.add('lit');
      });
    }
    timer = setInterval(tick, 80);
    tick();

    function moduleDone(id, ok) {
      var c = cards[id];
      if (!c || c.state === 'done') return;
      c.state = 'done';
      c.card.classList.add('lit');
      c.dots.forEach(function (d) {
        d.style.background = ok ? '#34d399' : '#ff6b8a';
        d.style.boxShadow = '0 0 6px ' + (ok ? '#34d399' : '#ff6b8a');
      });
      var mark = h('div', 'bt-check');
      if (!ok) { mark.style.borderColor = '#ff6b8a'; mark.style.color = '#ff6b8a'; mark.style.boxShadow = '0 0 14px rgba(255,107,138,.5)'; }
      mark.textContent = ok ? '✓' : '!';
      c.status.replaceWith(mark); c.status = mark;
      if (!ok) c.desc.textContent = 'Unavailable — panel will show the error';
    }

    function teardown() {
      clearInterval(timer);
      window.removeEventListener('resize', fit);
      if (emblem) emblem.destroy();
      // Before the class, not after: the dashboard's entrance and this fade have
      // to start on the same frame or they queue instead of overlapping.
      if (opts.onLeave) opts.onLeave();
      root.classList.add('is-leaving');
      setTimeout(function () { if (root.parentNode) root.parentNode.removeChild(root); }, 400);
    }

    return {
      el: root,
      progress: function (v) { if (v > target) target = Math.min(99, v); },
      module: moduleDone,
      abort: function () { if (done) return; done = true; clearInterval(timer); window.removeEventListener('resize', fit);
        if (emblem) emblem.destroy(); if (root.parentNode) root.parentNode.removeChild(root); },
      finish: function () {
        if (done) return Promise.resolve();
        done = true;
        target = 100;
        var wait = Math.max(0, MIN_VISIBLE_MS - (Date.now() - born));
        return new Promise(function (res) {
          setTimeout(function () {
            shown = 100; paint();
            mono.textContent = '> ALL MODULES ONLINE_';
            line.textContent = 'All subsystems synchronized.';
            h1.textContent = 'SYSTEM READY';
            h2.textContent = 'LAUNCHING DASHBOARD';
            root.classList.add('is-ready');
            setTimeout(function () { teardown(); res(); }, reduced ? 200 : READY_HOLD_MS);
          }, reduced ? 0 : wait);
        });
      }
    };
  }

  return { start: start };
})();
