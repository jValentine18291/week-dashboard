'use strict';

const $ = (id) => document.getElementById(id);

let TZ = 'Asia/Singapore';
let PAYLOAD = null;

// Month is the default view. Remembered so a window left open on a second
// screen comes back the way it was left.
let VIEW = localStorage.getItem('cal-view') === 'week' ? 'week' : 'month';

// Which rail section is showing, remembered for the same reason as VIEW. Ask is
// not a page — it is a drawer, and opens over whichever page is up.
const PAGES = ['dashboard', 'calendar', 'news', 'mail'];
let PAGE = PAGES.indexOf(localStorage.getItem('page')) >= 0
  ? localStorage.getItem('page') : 'dashboard';

// The month the Calendar page is looking at, as YYYY-MM-DD. null means the one
// the dashboard payload was already built for, which costs no request. Only the
// Calendar page moves it: the dashboard's calendar card must always agree with
// the "This Week" panel beside it.
let ANCHOR = null;
let ANCHORED = null;
const ANCHOR_CACHE = new Map();
let CAL_BUSY = false;

// lib/news.js interleaves the feeds by recency so a prolific source cannot
// crowd out a quieter one. Grouping is offered alongside that, not instead.
let NEWS_SORT = localStorage.getItem('news-sort') === 'source' ? 'source' : 'latest';
const NEWS_ON_DASHBOARD = 8;

const HOUR_H = 52;          // must match --hour-h in styles.css
const DEFAULT_START = 8;    // grid opens at 8am unless events start earlier
const DEFAULT_END = 20;

// Event block colours. Dark translucent fill with a saturated rule and label:
// on the dark ground a pale fill reads as a hole punched in the panel, whereas
// a tinted wash reads as a lit surface.
const PALETTE = [
  { bg: 'rgba(56, 189, 248, 0.16)',  fg: '#4cc9f5' },
  { bg: 'rgba(52, 211, 153, 0.16)',  fg: '#45e0ab' },
  { bg: 'rgba(167, 139, 250, 0.16)', fg: '#b39bff' },
  { bg: 'rgba(251, 146, 60, 0.16)',  fg: '#ffab5e' },
  { bg: 'rgba(251, 90, 118, 0.16)',  fg: '#ff8098' },
  { bg: 'rgba(251, 191, 36, 0.16)',  fg: '#ffc94d' },
  { bg: 'rgba(45, 212, 191, 0.16)',  fg: '#3fdccd' },
];


// ---------- formatting ----------

const fmt = (d, opts) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, ...opts }).format(d);

function partsOf(iso) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const h = Number(p.find((x) => x.type === 'hour').value);
  const m = Number(p.find((x) => x.type === 'minute').value);
  return h * 60 + m;
}

const dayKey = (iso) =>
  fmt(new Date(iso), { year: 'numeric', month: '2-digit', day: '2-digit' });

// Compared in TZ, not browser-local, so the greyed-out trailing days of the
// month grid are decided the same way every other date on the page is.
const monthKey = (iso) => fmt(new Date(iso), { year: 'numeric', month: '2-digit' });

const DAY_MS = 24 * 60 * 60 * 1000;

// Every day an event touches, not just the one it starts on. Two conventions
// collide here and one step back handles both: iCal gives all-day events an
// EXCLUSIVE end date (10th-13th means the 10th, 11th and 12th), and a timed
// event ending at exactly midnight belongs to the day before, not to the one
// it merely touches. Taking the last covered instant as end-minus-1ms is
// correct for each.
function coveredDayKeys(ev) {
  const startMs = new Date(ev.start).getTime();
  if (!ev.end) return [dayKey(ev.start)];

  const lastMs = new Date(ev.end).getTime() - 1;
  if (lastMs <= startMs) return [dayKey(ev.start)];

  const keys = [];
  for (let t = startMs; t <= lastMs; t += DAY_MS) keys.push(dayKey(new Date(t)));
  const lastKey = dayKey(new Date(lastMs));
  if (keys[keys.length - 1] !== lastKey) keys.push(lastKey);
  return keys;
}

const clockOf = (iso) =>
  fmt(new Date(iso), { hour: 'numeric', minute: '2-digit', hour12: true }).replace(':00', ':00');

// Month chips have room for a time only if it is very short, but dropping the
// meridiem entirely makes 2pm read as 2am. "2pm" / "9:30am" keeps it unambiguous.
function compactTime(iso) {
  return fmt(new Date(iso), { hour: 'numeric', minute: '2-digit', hour12: true })
    .replace(/:00(?=\s)/, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function hourLabel(h) {
  const suffix = h < 12 ? 'AM' : 'PM';
  const base = h % 12 === 0 ? 12 : h % 12;
  return `${base} ${suffix}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function colourFor(text, palette) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length];
}

// ---------- calendar layout ----------

// Events that overlap in time are split into side-by-side columns. Events are
// grouped into clusters first so a busy morning doesn't narrow a quiet
// afternoon: each cluster is sized only by its own overlap depth.
function assignColumns(events) {
  const sorted = [...events].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
  const clusters = [];
  let current = [];
  let clusterEnd = -Infinity;

  for (const ev of sorted) {
    if (current.length && ev.startMin >= clusterEnd) {
      clusters.push(current);
      current = [];
      clusterEnd = -Infinity;
    }
    current.push(ev);
    clusterEnd = Math.max(clusterEnd, ev.endMin);
  }
  if (current.length) clusters.push(current);

  for (const cluster of clusters) {
    const columnEnds = [];
    for (const ev of cluster) {
      let col = columnEnds.findIndex((end) => end <= ev.startMin);
      if (col === -1) {
        col = columnEnds.length;
        columnEnds.push(ev.endMin);
      } else {
        columnEnds[col] = ev.endMin;
      }
      ev.col = col;
    }
    for (const ev of cluster) ev.colCount = columnEnds.length;
  }
  return sorted;
}

function gridBounds(timed) {
  if (!timed.length) return { startHour: DEFAULT_START, endHour: DEFAULT_END };
  let lo = DEFAULT_START;
  let hi = DEFAULT_END;
  for (const ev of timed) {
    lo = Math.min(lo, Math.floor(ev.startMin / 60));
    hi = Math.max(hi, Math.ceil(ev.endMin / 60));
  }
  return { startHour: Math.max(0, lo), endHour: Math.min(24, Math.max(hi, lo + 4)) };
}

// A frame carries the whole month grid, so each view narrows the same array to
// the days it draws rather than asking the server again. Matched on every day
// an event covers, so one that started before this window but runs into it is
// not dropped.
function eventsOn(days, events) {
  const keys = new Set(days.map(dayKey));
  return (events || []).filter((e) => coveredDayKeys(e).some((k) => keys.has(k)));
}

// The frame the calendar is drawing: the anchored month on the Calendar page,
// otherwise the dashboard payload's own. /api/calendar returns the same shape
// as the payload's week/month/calendar, so nothing below needs to know which
// one it was handed.
function calSource() {
  return PAGE === 'calendar' && ANCHORED ? ANCHORED : PAYLOAD;
}

function renderCalendar() {
  const month = VIEW === 'month';
  $('cal-month').hidden = !month;
  $('cal-week').hidden = month;
  // Covers both the card-header toggle and anything else carrying data-view.
  document.querySelectorAll('[data-view]').forEach((b) =>
    b.classList.toggle('is-active', b.dataset.view === VIEW));
  // Nothing to go back to when the anchor is already the real month.
  $('cal-today').disabled = !ANCHOR;

  if (month) renderMonth();
  else renderWeekGrid();

  wireEventDetails();
  showError('calendar-error', calSource().calendar.error);
}

// ---------- month view ----------

const CHIP_H = 14;      // .mon-chip line box plus its 1px gap
const NUM_RESERVE = 19; // .mon-top plus the cell's own vertical padding

let LAST_CAPACITY = null;

// Derived from the real cell height rather than assumed, so the grid fills a
// large window and still refuses to overflow a small one.
function chipCapacity() {
  const grid = $('mon-grid');
  const rows = (calSource().month.days.length / 7) || 6;
  const cellH = (grid.clientHeight || 540) / rows;
  return Math.max(1, Math.floor((cellH - NUM_RESERVE) / CHIP_H));
}

function renderMonth() {
  const src = calSource();
  const days = src.month.days;
  const events = eventsOn(days, src.calendar.data);
  const todayKey = dayKey(src.week.today);
  const thisMonth = monthKey(src.month.start);
  const rows = days.length / 7;

  $('cal-range').textContent =
    fmt(new Date(src.month.start), { month: 'long', year: 'numeric' });

  $('mon-daybar').innerHTML = days
    .slice(0, 7)
    .map((iso) => `<div class="mon-dayname">${fmt(new Date(iso), { weekday: 'short' })}</div>`)
    .join('');

  const byDay = {};
  for (const e of events) for (const k of coveredDayKeys(e)) (byDay[k] ||= []).push(e);
  for (const list of Object.values(byDay)) {
    list.sort((a, b) => (a.allDay === b.allDay ? new Date(a.start) - new Date(b.start) : a.allDay ? -1 : 1));
  }

  const grid = $('mon-grid');
  grid.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;

  const capacity = chipCapacity();
  LAST_CAPACITY = capacity;

  grid.innerHTML = days
    .map((iso) => {
      const k = dayKey(iso);
      const list = byDay[k] || [];

      // The count rides on the day-number row, so it costs no chip line and the
      // stack is free to name `capacity` events rather than `capacity - 1`.
      // It used to live in the stack, which is what produced the "2 events"
      // cells: at a capacity of one the indicator took the only line and the
      // day was described without a single event being named.
      const shown = list.slice(0, capacity);
      const overflow = list.length > capacity
        ? `<span class="mon-more" title="${list.length - capacity} more">+${list.length - capacity}</span>`
        : '';

      const chips = shown
        .map((e) => {
          const c = colourFor(e.title, PALETTE);
          // A continuation day repeats the title but must not repeat the start
          // time — that time belongs to the day the event began.
          const continues = dayKey(e.start) !== k;
          if (e.allDay) {
            return `<button class="mon-chip is-allday" type="button" data-id="${escapeHtml(e.id)}"
              style="background:${c.bg};color:${c.fg}">${continues ? '↳ ' : ''}${escapeHtml(e.title)}</button>`;
          }
          return `<button class="mon-chip" type="button" data-id="${escapeHtml(e.id)}" style="color:${c.fg}">
            <span class="mon-dot" style="background:${c.fg}"></span>
            <span class="mon-when">${continues ? '↳' : escapeHtml(compactTime(e.start))}</span>
            <span class="mon-what">${escapeHtml(e.title)}</span>
          </button>`;
        })
        .join('');

      return `<div class="mon-cell ${k === todayKey ? 'is-today' : ''} ${monthKey(iso) !== thisMonth ? 'is-outside' : ''}">
        <div class="mon-top">
          <span class="mon-num">${fmt(new Date(iso), { day: 'numeric' })}</span>
          ${overflow}
        </div>
        <div class="mon-events">${chips}</div>
      </div>`;
    })
    .join('');
}

// ---------- week view ----------

function renderWeekGrid() {
  const src = calSource();
  const days = src.week.days;
  const events = eventsOn(days, src.calendar.data);
  const todayKey = dayKey(src.week.today);

  $('tz-label').textContent = fmt(new Date(), { timeZoneName: 'shortOffset' }).split(', ').pop() || '';
  $('cal-range').textContent =
    `${fmt(new Date(src.week.start), { day: 'numeric', month: 'short' })} – ` +
    `${fmt(new Date(src.week.end), { day: 'numeric', month: 'short', year: 'numeric' })}`;

  // Day headings
  $('cal-days').innerHTML = days
    .map((iso) => {
      const isToday = dayKey(iso) === todayKey;
      return `<div class="cal-dayhead ${isToday ? 'is-today' : ''}">
        <span class="cal-dayname">${fmt(new Date(iso), { weekday: 'short' })}</span>
        <span class="cal-daynum">${fmt(new Date(iso), { day: 'numeric' })}</span>
      </div>`;
    })
    .join('');

  // Split all-day out of the grid, then cut each timed event into one segment
  // per day it covers, clamped to that day. Measuring the segments off the
  // duration rather than off the end time is what makes a 20:00-00:00 event
  // fill its evening: read as a minute-of-day, that end is 0, not 1440.
  const timed = [];
  const allDay = [];
  for (const ev of events) {
    if (ev.allDay) { allDay.push(ev); continue; }

    const keys = coveredDayKeys(ev);
    const startMin = partsOf(ev.start);
    const duration = ev.end
      ? Math.max(15, (new Date(ev.end).getTime() - new Date(ev.start).getTime()) / 60000)
      : 30;

    let remaining = duration;
    keys.forEach((k, i) => {
      const segStart = i === 0 ? startMin : 0;
      const segEnd = Math.min(1440, segStart + remaining);
      remaining -= segEnd - segStart;
      timed.push({
        ...ev, key: k, continues: i > 0,
        startMin: segStart, endMin: Math.max(segEnd, segStart + 15),
      });
    });
  }

  // All-day strip
  const allDayEl = $('cal-allday');
  if (allDay.length) {
    const cols = days
      .map((iso) => {
        const k = dayKey(iso);
        return `<div>${allDay
          .filter((e) => coveredDayKeys(e).includes(k))
          .map((e) => {
            const c = colourFor(e.title, PALETTE);
            return `<button class="ev-allday" type="button" data-id="${escapeHtml(e.id)}"
              style="background:${c.bg};border-left-color:${c.fg};color:${c.fg}">${escapeHtml(e.title)}</button>`;
          })
          .join('')}</div>`;
      })
      .join('');
    allDayEl.innerHTML =
      `<div class="cal-allday-label">all-day</div><div class="cal-allday-cols">${cols}</div>`;
    allDayEl.hidden = false;
  } else {
    allDayEl.hidden = true;
  }

  const { startHour, endHour } = gridBounds(timed);
  const gridTop = startHour * 60;
  const heightPx = (endHour - startHour) * HOUR_H;

  // Hour labels
  const labels = [];
  for (let h = startHour; h <= endHour; h++) {
    labels.push(
      `<span class="cal-hourlabel" style="top:${(h - startHour) * HOUR_H}px">${hourLabel(h % 24)}</span>`
    );
  }
  const gutter = $('cal-gutter');
  gutter.innerHTML = labels.join('');
  gutter.style.height = `${heightPx}px`;

  // Columns
  const grid = $('cal-grid');
  grid.style.height = `${heightPx}px`;

  const nowMin = partsOf(new Date().toISOString());

  grid.innerHTML = days
    .map((iso) => {
      const k = dayKey(iso);
      const isToday = k === todayKey;
      const dayEvents = assignColumns(timed.filter((e) => e.key === k));

      const blocks = dayEvents
        .map((e) => {
          const c = colourFor(e.title, PALETTE);
          const top = ((e.startMin - gridTop) / 60) * HOUR_H;
          const h = Math.max(22, ((e.endMin - e.startMin) / 60) * HOUR_H - 2);
          const width = 100 / e.colCount;
          const left = e.col * width;
          const tall = h >= 34;
          return `<button class="ev" type="button" data-id="${escapeHtml(e.id)}"
            style="top:${top}px;height:${h}px;left:calc(${left}% + 2px);width:calc(${width}% - 4px);
                   background:${c.bg};border-left-color:${c.fg};color:${c.fg}">
            ${tall ? `<span class="ev-time">${e.continues ? '↳' : escapeHtml(clockOf(e.start))}</span>` : ''}
            <span class="ev-title">${escapeHtml(e.title)}</span>
          </button>`;
        })
        .join('');

      const nowVisible = isToday && nowMin >= gridTop && nowMin <= endHour * 60;
      const nowline = nowVisible
        ? `<div class="nowline" style="top:${((nowMin - gridTop) / 60) * HOUR_H}px"></div>`
        : '';

      return `<div class="cal-col ${isToday ? 'is-today' : ''}">${blocks}${nowline}</div>`;
    })
    .join('');

  if (!events.length) {
    grid.innerHTML = '<div class="cal-empty">Nothing scheduled this week.</div>';
    grid.style.height = 'auto';
    gutter.innerHTML = '';
  }

  // Scroll so the working day is in view on load
  const body = document.querySelector('.cal-body');
  if (body && timed.length) body.scrollTop = Math.max(0, ((8 - startHour) * HOUR_H) - 8);
}

function wireEventDetails() {
  document.querySelectorAll('.ev, .ev-allday, .mon-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ev = (calSource().calendar.data || []).find((e) => e.id === btn.dataset.id);
      if (!ev) return;
      // A multi-day event says which days, not just "All day".
      const span = coveredDayKeys(ev).length > 1 && ev.end
        ? `${fmt(new Date(ev.start), { weekday: 'short', day: 'numeric', month: 'short' })} – ` +
          `${fmt(new Date(new Date(ev.end).getTime() - 1), { weekday: 'short', day: 'numeric', month: 'short' })}`
        : null;
      const when = ev.allDay
        ? (span ? `All day · ${span}` : 'All day')
        : `${clockOf(ev.start)}${ev.end ? ` – ${clockOf(ev.end)}` : ''}${span ? `\n${span}` : ''}`;
      alert(
        [ev.title, when, ev.location, ev.description].filter(Boolean).join('\n\n')
      );
    });
  });
}

// ---------- market watch ----------

// Sparkline geometry in viewBox units. The SVG scales to whatever box the row
// gives it, so these are proportions rather than pixels.
const SPARK_W = 100;
const SPARK_H = 30;

const MARKET_RANGES = ['1d', '1w', '1mo', '6mo', '1y'];
const MARKET_DEFAULT_RANGE = '1mo';

// Persisted like the calendar's month/week choice, and for the same reason: a
// view you picked should survive a reload.
let MARKET_RANGE = MARKET_RANGES.includes(localStorage.getItem('market-range'))
  ? localStorage.getItem('market-range')
  : MARKET_DEFAULT_RANGE;

// What is on screen right now. At the default range this is the dashboard
// payload; at any other it is whatever /api/markets returned. Keeping it
// separate is what stops the five-minute refresh from yanking the user back to
// 1M while they are reading the year.
let MARKET_VIEW = null;

// A price is not a count: 81893.13 wants thousands separators and no decimals,
// 295.78 wants two. One formatter for both would make Bitcoin unreadable or
// the ETFs falsely precise.
function priceText(value, currency) {
  if (!Number.isFinite(value)) return '—';
  const big = Math.abs(value) >= 1000;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: big ? 0 : 2,
      maximumFractionDigits: big ? 0 : 2,
    }).format(value);
  } catch (e) {
    return value.toFixed(big ? 0 : 2);
  }
}

function pctText(value) {
  if (!Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function trendClass(value) {
  if (!Number.isFinite(value) || value === 0) return 'is-flat';
  return value > 0 ? 'is-up' : 'is-down';
}

// The one place the value -> viewBox mapping is defined. The hover cursor reads
// these same bounds back out, so the dot lands on the line rather than near it.
function sparkBounds(series) {
  const vals = series.map((p) => p.c);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  return { min, max, span: max - min };
}

function sparkPoints(series) {
  if (!series || series.length < 2) return '';
  const { min, span } = sparkBounds(series);
  const step = SPARK_W / (series.length - 1);
  return series
    .map((p, i) => {
      // A flat series would divide by zero, so it is drawn down the middle —
      // a straight line is the honest picture of a price that has not moved.
      const y = span === 0 ? SPARK_H / 2 : SPARK_H - ((p.c - min) / span) * SPARK_H;
      return `${(i * step).toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
}

// Daily bars want a date, intraday bars want a clock, and a year of dates wants
// the year on it. The server says which shape the data is; the label follows.
function pointLabel(point, q) {
  const d = new Date(point.t);
  if (q.intraday) {
    return q.range === '1d'
      ? fmt(d, { hour: '2-digit', minute: '2-digit' })
      : fmt(d, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  }
  return q.range === '1y'
    ? fmt(d, { day: 'numeric', month: 'short', year: 'numeric' })
    : fmt(d, { day: 'numeric', month: 'short' });
}

function marketRow(q, index) {
  if (q.error) {
    return `<div class="mk-row is-error">
      <div class="mk-head"><span class="mk-sym">${escapeHtml(q.symbol)}</span></div>
      <p class="mk-note">No data for this symbol. Check MARKET_SYMBOLS.</p>
    </div>`;
  }

  // Two directions, because two different things are being described. The pill
  // is today's move; the chart is the selected range. Colouring the chart by
  // the day gave QQQM a green line that visibly fell — the month was -3.1%
  // while the day was +1.2% — so each is tinted by the number it depicts.
  const dayDir = trendClass(q.changePct);
  const trendDir = trendClass(q.periodChangePct);
  const points = sparkPoints(q.series);
  // Each row owns its gradient id: two <linearGradient> elements sharing an id
  // in one document means the second is ignored and both rows take the first
  // one's colour, which would show a falling symbol in green.
  const gid = `mkg-${q.symbol.replace(/[^A-Za-z0-9]/g, '')}`;

  const chart = points
    ? `<div class="mk-chart ${trendDir}" data-i="${index}">
         <svg class="mk-spark" viewBox="0 0 ${SPARK_W} ${SPARK_H}"
              preserveAspectRatio="none" aria-hidden="true">
           <defs>
             <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
               <stop offset="0%" stop-color="currentColor" stop-opacity=".28"/>
               <stop offset="100%" stop-color="currentColor" stop-opacity="0"/>
             </linearGradient>
           </defs>
           <polygon points="0,${SPARK_H} ${points} ${SPARK_W},${SPARK_H}" fill="url(#${gid})"/>
           <polyline points="${points}" fill="none" stroke="currentColor"
                     stroke-width="1.4" vector-effect="non-scaling-stroke"
                     stroke-linejoin="round" stroke-linecap="round"/>
         </svg>
         <span class="mk-cline" hidden></span>
         <span class="mk-cdot" hidden></span>
         <div class="mk-tip" hidden></div>
       </div>`
    : '<p class="mk-note">No history available.</p>';

  const span = Number.isFinite(q.low) && Number.isFinite(q.high)
    ? `${priceText(q.low, q.currency)} – ${priceText(q.high, q.currency)}`
    : '—';

  // US sessions close mid-afternoon Singapore time, so a quote hours old is
  // normal. Saying when it was taken is what stops a motionless number reading
  // as a broken feed.
  const asOf = q.quotedAt
    ? fmt(new Date(q.quotedAt), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '';

  return `<div class="mk-row">
    <div class="mk-head">
      <span class="mk-sym">${escapeHtml(q.symbol)}</span>
      <span class="mk-name">${escapeHtml(q.name || '')}</span>
      ${q.stale ? '<span class="mk-stale" title="Showing the last good quote">STALE</span>' : ''}
    </div>
    <div class="mk-quote">
      <span class="mk-price">${escapeHtml(priceText(q.price, q.currency))}</span>
      <span class="mk-chg ${dayDir}">${escapeHtml(pctText(q.changePct))}</span>
    </div>
    ${chart}
    <div class="mk-foot">
      <span class="mk-stat"><b>${escapeHtml(q.rangeLabel || '')}</b> <span class="${trendClass(q.periodChangePct)}">${escapeHtml(pctText(q.periodChangePct))}</span></span>
      <span class="mk-stat"><b>Range</b> ${escapeHtml(span)}</span>
      ${asOf ? `<span class="mk-asof">${escapeHtml(asOf)}</span>` : ''}
    </div>
  </div>`;
}

function markActiveRange() {
  document.querySelectorAll('#market-range .vt').forEach((b) =>
    b.classList.toggle('is-active', b.dataset.range === MARKET_RANGE));
}

function renderMarket() {
  const quotes = MARKET_VIEW || [];
  const el = $('market');

  const live = quotes.filter((q) => !q.error).length;
  $('market-meta').textContent = live ? `${live} tracked` : '';
  markActiveRange();

  el.innerHTML = quotes.length
    ? quotes.map(marketRow).join('')
    : '<p class="empty">No symbols configured.</p>';

  showError('market-error', PAYLOAD.markets.error);
}

// Called after every payload load. At the default range the payload already
// holds the data; at any other the user's choice is refetched, so a background
// refresh does not silently drop them back to 1M.
function syncMarket() {
  if (MARKET_RANGE === MARKET_DEFAULT_RANGE) {
    MARKET_VIEW = (PAYLOAD.markets && PAYLOAD.markets.data) || [];
    renderMarket();
    return;
  }
  loadMarketRange(MARKET_RANGE);
}

// Switching range refetches rather than reslicing: a year of daily bars is not
// contained in a month of them. Fetched on demand for the same reason mail
// bodies are — see the route in server.js.
async function loadMarketRange(range) {
  MARKET_RANGE = MARKET_RANGES.includes(range) ? range : MARKET_DEFAULT_RANGE;
  localStorage.setItem('market-range', MARKET_RANGE);
  markActiveRange();

  // The default range is already in the dashboard payload, so asking the
  // server for it again would be a round trip for data in hand.
  if (MARKET_RANGE === MARKET_DEFAULT_RANGE && PAYLOAD && PAYLOAD.markets) {
    MARKET_VIEW = PAYLOAD.markets.data || [];
    renderMarket();
    return;
  }

  $('market').classList.add('is-loading');
  try {
    const res = await fetch(`/api/markets?range=${encodeURIComponent(MARKET_RANGE)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    MARKET_VIEW = body.data || [];
    renderMarket();
  } catch (err) {
    console.error('Market range failed:', err.message);
    showError('market-error', 'Could not load that range.');
  } finally {
    $('market').classList.remove('is-loading');
  }
}

// --- hover readout -------------------------------------------------------

// The index comes from the pointer's position across the element's own box,
// never from viewBox units: preserveAspectRatio="none" stretches the two axes
// by different factors, so a coordinate that is correct in SVG space lands in
// the wrong place on screen.
function moveCursor(chart, clientX) {
  const q = (MARKET_VIEW || [])[Number(chart.dataset.i)];
  if (!q || !q.series || q.series.length < 2) return;

  const rect = chart.getBoundingClientRect();
  const n = q.series.length;
  const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  const i = Math.round(frac * (n - 1));
  const point = q.series[i];

  const { min, span } = sparkBounds(q.series);
  const x = (i / (n - 1)) * rect.width;
  const y = span === 0 ? rect.height / 2 : (1 - (point.c - min) / span) * rect.height;

  const line = chart.querySelector('.mk-cline');
  const dot = chart.querySelector('.mk-cdot');
  const tip = chart.querySelector('.mk-tip');

  line.style.left = `${x}px`;
  dot.style.left = `${x}px`;
  dot.style.top = `${y}px`;

  tip.innerHTML = `<b>${escapeHtml(priceText(point.c, q.currency))}</b>` +
                  `<span>${escapeHtml(pointLabel(point, q))}</span>`;

  // Unhidden before measuring: a hidden element has no offsetWidth, so
  // clamping against it would put every tooltip half a pixel from the left.
  line.hidden = false;
  dot.hidden = false;
  tip.hidden = false;

  const half = tip.offsetWidth / 2;
  tip.style.left = `${Math.min(rect.width - half, Math.max(half, x))}px`;

  // Above the dot by preference, below it when there is no room — never on
  // top of it. GAP clears the dot's 7px diameter and its glow.
  const GAP = 14;
  const above = y - tip.offsetHeight - GAP;
  tip.style.top = `${above >= 0 ? above : y + GAP}px`;
}

function hideCursor(root) {
  (root || document).querySelectorAll('.mk-cline, .mk-cdot, .mk-tip')
    .forEach((n) => { n.hidden = true; });
}

// ---------- news ----------

// Relative time, because "2h ago" is what you actually want from a feed.
function agoOf(iso) {
  if (!iso) return '';
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

// `full` adds the summary. Everything else is shared, so a story reads the same
// either side of the page switch — only the amount of it changes.
function newsItem(n, full) {
  // Many feeds carry no image (see HANDOVER phase 2 research), so the
  // fallback is a source-tinted initial rather than a broken frame.
  const c = colourFor(n.source || '', PALETTE);
  const thumb = n.image
    ? `<span class="news-thumb" style="background-image:url('${escapeHtml(n.image)}')"></span>`
    : `<span class="news-thumb is-blank" style="color:${c.fg};background:${c.bg}">${escapeHtml((n.source || '?').slice(0, 2).toUpperCase())}</span>`;

  return `<a class="news-item" href="${escapeHtml(n.link || '#')}" target="_blank" rel="noopener">
    ${thumb}
    <span class="news-body">
      <span class="news-title">${escapeHtml(n.title)}</span>
      ${full && n.summary ? `<span class="news-summary">${escapeHtml(n.summary)}</span>` : ''}
      <span class="news-meta">
        <span class="news-source" style="color:${c.fg}">${escapeHtml(n.source || '')}</span>
        <span class="news-dot"></span>
        <span class="news-ago">${escapeHtml(agoOf(n.published))}</span>
      </span>
    </span>
  </a>`;
}

// Insertion order of a Map is stable, so sources appear in the order their
// first story does — which keeps the freshest feed at the top.
function groupedNews(items) {
  const groups = new Map();
  for (const n of items) {
    const key = n.source || 'Other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }
  return [...groups]
    .map(([source, list]) => {
      const c = colourFor(source, PALETTE);
      return `<div class="news-group">
        <h3 class="news-grouphead" style="color:${c.fg}">
          ${escapeHtml(source)}<span class="news-groupn">${list.length}</span>
        </h3>
        ${list.map((n) => newsItem(n, true)).join('')}
      </div>`;
    })
    .join('');
}

function renderNews() {
  const all = PAYLOAD.news.data || [];
  const full = PAGE === 'news';
  // The server fetches the lot once; the dashboard card shows the newest few so
  // it keeps to the height the calendar needs it to keep to.
  const items = full ? all : all.slice(0, NEWS_ON_DASHBOARD);
  const el = $('news');

  el.classList.toggle('is-full', full);
  $('news-meta').textContent = items.length
    ? (full ? `${items.length} stories` : `${items.length} latest`)
    : '';
  document.querySelectorAll('[data-sort]').forEach((b) =>
    b.classList.toggle('is-active', b.dataset.sort === NEWS_SORT));

  if (!items.length) {
    el.innerHTML = '<p class="empty">No stories right now.</p>';
    showError('news-error', PAYLOAD.news.error);
    return;
  }

  el.innerHTML = full && NEWS_SORT === 'source'
    ? groupedNews(items)
    : items.map((n) => newsItem(n, full)).join('');

  showError('news-error', PAYLOAD.news.error);
}

// ---------- pages ----------

// There is one Calendar card and one News card in the document; a page switch
// moves the node rather than rendering a second copy. That keeps every id
// unique — the alternative was duplicate markup and a renderer that had to be
// told which copy it was drawing into.
//
// Only move when the parent actually changes: re-inserting a node restarts its
// entrance animation, and the five-minute auto-refresh calls through here.
function place(node, host, before) {
  if (node.parentNode === host) return;
  if (before && before.parentNode === host) host.insertBefore(node, before);
  else host.appendChild(node);
}

function renderMail() {
  const mail = (PAYLOAD.mail && PAYLOAD.mail.data) || { unread: 0, messages: [], configured: false };
  const badge = $('mail-badge');
  const list = $('mail-list');

  // The badge is the whole point of the glanceable half: the count is visible
  // from every page without a panel taking dashboard space.
  badge.hidden = !mail.unread;
  badge.textContent = mail.unread > 99 ? '99+' : String(mail.unread);

  $('mail-meta').textContent = mail.configured
    ? `${mail.unread} unread`
    : '';

  if (!mail.configured) {
    list.innerHTML = '<p class="empty">Mail is not connected. Set GMAIL_REFRESH_TOKEN to switch it on.</p>';
    showError('mail-error', PAYLOAD.mail && PAYLOAD.mail.error);
    return;
  }

  if (!mail.messages.length) {
    list.innerHTML = '<p class="empty">Nothing unread.</p>';
    showError('mail-error', PAYLOAD.mail.error);
    return;
  }

  list.innerHTML = mail.messages
    .map((m) => {
      const c = colourFor(m.from || '', PALETTE);
      return `<button class="mail-item" type="button" data-mail-id="${escapeHtml(m.id)}" aria-expanded="false">
        <span class="mail-dot" style="background:${c.fg};box-shadow:0 0 8px ${c.fg}"></span>
        <span class="mail-body">
          <span class="mail-from" style="color:${c.fg}">${escapeHtml(m.from)}</span>
          <span class="mail-subject">${escapeHtml(m.subject)}</span>
        </span>
        <span class="mail-ago">${escapeHtml(agoOf(m.received))}</span>
      </button>`;
    })
    .join('');

  showError('mail-error', PAYLOAD.mail.error);
}

// Bodies are fetched on click, one at a time, and cached for the life of the
// page so reopening a message costs nothing.
const MAIL_BODIES = new Map();

async function toggleMailBody(btn) {
  const open = btn.getAttribute('aria-expanded') === 'true';
  const next = btn.nextElementSibling;
  if (open && next && next.classList.contains('mail-open')) {
    next.remove();
    btn.setAttribute('aria-expanded', 'false');
    return;
  }

  const id = btn.dataset.mailId;
  const panel = document.createElement('div');
  panel.className = 'mail-open';
  panel.textContent = 'Loading…';
  btn.after(panel);
  btn.setAttribute('aria-expanded', 'true');

  try {
    let body = MAIL_BODIES.get(id);
    if (!body) {
      const res = await fetch('/api/mail/' + encodeURIComponent(id));
      if (!res.ok) {
        const msg = await res.json().catch(() => ({}));
        panel.textContent = msg.error || 'Could not load that message.';
        panel.classList.add('is-error');
        return;
      }
      body = await res.json();
      MAIL_BODIES.set(id, body);
    }

    panel.classList.remove('is-error');
    panel.textContent = '';

    const meta = document.createElement('div');
    meta.className = 'mail-open-meta';
    meta.textContent = body.source === 'text/html'
      ? 'Converted from HTML'
      : body.source === 'none' ? 'No readable text — attachment only' : 'Plain text';
    panel.appendChild(meta);

    // textContent, never innerHTML. The server strips markup, but the real
    // guarantee is that nothing here can ever be parsed as HTML.
    const pre = document.createElement('div');
    pre.className = 'mail-open-text';
    pre.textContent = body.text || '(no text content)';
    panel.appendChild(pre);

    if (body.truncated) {
      const cut = document.createElement('div');
      cut.className = 'mail-open-meta';
      cut.textContent = 'Truncated — open it in Gmail for the rest.';
      panel.appendChild(cut);
    }
  } catch (err) {
    panel.textContent = 'Could not reach the server.';
    panel.classList.add('is-error');
  }
}

function setPage(next) {
  PAGE = PAGES.indexOf(next) >= 0 ? next : 'dashboard';
  localStorage.setItem('page', PAGE);

  // Leaving the Calendar page drops the anchor. The dashboard card has to show
  // the real month, and coming back later to "some month in 2027" would read as
  // a bug rather than as a memory.
  if (PAGE !== 'calendar' && ANCHOR) { ANCHOR = null; ANCHORED = null; }

  const dash = $('page-dashboard');
  const cal = document.querySelector('.card-calendar');
  const news = document.querySelector('.card-news');
  const marketCard = document.querySelector('.card-market');

  dash.hidden = PAGE !== 'dashboard';
  $('page-calendar').hidden = PAGE !== 'calendar';
  $('page-news').hidden = PAGE !== 'news';
  // Mail lives only on its own page, so it needs no place() call — its card
  // never moves between hosts the way the calendar and news cards do.
  $('page-mail').hidden = PAGE !== 'mail';

  // Unhide before moving: the month grid measures its own box, so it has to be
  // in a laid-out container by the time renderCalendar runs below.
  place(cal, PAGE === 'calendar' ? $('page-calendar') : dash, marketCard);
  place(news, PAGE === 'news' ? $('page-news') : dash, null);

  cal.classList.toggle('is-full', PAGE === 'calendar');
  news.classList.toggle('is-full', PAGE === 'news');
  $('cal-nav').hidden = PAGE !== 'calendar';
  $('news-sort').hidden = PAGE !== 'news';

  document.querySelectorAll('[data-page]').forEach((b) =>
    b.classList.toggle('is-active', b.dataset.page === PAGE));

  if (!PAYLOAD) return;
  renderNews();
  renderMail();
  renderCalendar();   // last, for the reason given in load()
}

// Year and month arithmetic on the formatted parts rather than on a Date: the
// browser's zone is not necessarily TZ, so "add one month to this instant" can
// land in the wrong one. Days are stepped in milliseconds and then read back in
// TZ, which survives an offset change mid-step.
function tzParts(d) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const get = (t) => p.find((x) => x.type === t).value;
  return { y: Number(get('year')), m: Number(get('month')), d: Number(get('day')) };
}

const pad2 = (n) => String(n).padStart(2, '0');

function stepAnchor(delta) {
  const src = calSource();
  if (VIEW === 'month') {
    const p = tzParts(new Date(src.month.start));
    let y = p.y, m = p.m + delta;
    while (m < 1) { m += 12; y -= 1; }
    while (m > 12) { m -= 12; y += 1; }
    return `${y}-${pad2(m)}-01`;
  }
  const p = tzParts(new Date(new Date(src.week.start).getTime() + delta * 7 * DAY_MS));
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
}

// A month grid covers whole Monday-Sunday weeks, so the week containing the
// anchor is always inside the frame already fetched for it — stepping weeks
// only costs a request when it crosses into a month not yet seen.
async function goAnchor(anchor) {
  if (CAL_BUSY) return;

  if (!anchor) {
    ANCHOR = null;
    ANCHORED = null;
    renderCalendar();
    return;
  }

  const cached = ANCHOR_CACHE.get(anchor);
  if (cached) {
    ANCHOR = anchor;
    ANCHORED = cached;
    renderCalendar();
    return;
  }

  const card = document.querySelector('.card-calendar');
  CAL_BUSY = true;
  card.classList.add('is-busy');
  try {
    const res = await fetch(`/api/calendar?anchor=${encodeURIComponent(anchor)}`);
    if (res.status === 401) return showGate();
    if (!res.ok) throw new Error(String(res.status));
    const frame = await res.json();
    ANCHOR_CACHE.set(anchor, frame);
    ANCHOR = anchor;
    ANCHORED = frame;
    renderCalendar();
  } catch (err) {
    // Left on screen deliberately: renderCalendar is what clears this, and it
    // is not called on the path that failed.
    showError('calendar-error', 'Could not load that month.');
  } finally {
    CAL_BUSY = false;
    card.classList.remove('is-busy');
  }
}

// ---------- shell ----------

function showError(id, message) {
  const el = $(id);
  if (!message) { el.hidden = true; return; }
  el.textContent = `Could not load this panel. ${message}`;
  el.hidden = false;
}

function renderHeader() {
  const now = new Date();
  const hour = Number(fmt(now, { hour: '2-digit', hourCycle: 'h23' }));
  const part = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  $('greeting').textContent = `Good ${part}`;
  $('today-date').textContent = fmt(now, {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  $('stamp').textContent = `Updated ${fmt(new Date(PAYLOAD.generatedAt), {
    hour: 'numeric', minute: '2-digit', hour12: true,
  })}`;
  tickClock();
}

// Text-only update on a stable element — nothing reflows, nothing shifts.
function tickClock() {
  const c = $('clock');
  if (c) {
    c.textContent = fmt(new Date(), {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
  }
}

// The boot sequence runs once, on the first successful load. The dashboard
// reloads itself every five minutes; booting again each time would throw a
// full-screen splash over whatever the user is reading.
let BOOTED = false;

async function load(force = false) {
  // onLeave fires on the frame the boot screen starts to fade, which is when
  // the dashboard's own entrance is released — the two overlap rather than
  // queue. See the boot handoff section in styles.css.
  const boot = !BOOTED && window.Boot
    ? Boot.start({ onLeave: () => $('app').classList.remove('is-booting') })
    : null;
  if (boot) boot.progress(30);

  let res;
  try {
    res = await fetch(`/api/dashboard${force ? '?refresh=1' : ''}`);
  } catch (err) {
    if (boot) boot.abort();
    throw err;
  }

  if (res.status === 401) {
    // Not signed in: no point booting a dashboard the user cannot see yet.
    if (boot) boot.abort();
    return showGate();
  }

  PAYLOAD = await res.json();
  TZ = PAYLOAD.timezone || TZ;

  // Module status comes from the payload the server actually returned, so a
  // failed panel shows as failed rather than quietly reporting success.
  if (boot) {
    boot.progress(70);
    boot.module('calendar', !PAYLOAD.calendar.error);
    boot.module('market', !PAYLOAD.markets.error);
    boot.module('news', !PAYLOAD.news.error);
    // Only report mail if it is actually configured — a tick for a subsystem
    // that is switched off would be a lie. Unconfigured, it stays standby.
    if (PAYLOAD.mail && PAYLOAD.mail.data && PAYLOAD.mail.data.configured) {
      boot.module('mail', !PAYLOAD.mail.error);
    }
    boot.progress(95);
  }

  $('gate').hidden = true;
  // Laid out but not shown, so the month grid still measures a real box while
  // the boot screen is up. Only while a boot is actually running — a refresh
  // must never hide the dashboard it is refreshing.
  $('app').classList.toggle('is-booting', !!boot);
  $('app').hidden = false;

  renderHeader();
  syncMarket();
  // Places the cards for whichever page is showing, then renders News and —
  // last on purpose — the calendar. The month grid measures its own box to
  // decide how many chips fit in a day cell, so the panels that share the
  // layout have to claim their height first or it measures a box it is about
  // to lose.
  setPage(PAGE);

  BOOTED = true;
  if (boot) {
    // onLeave clears the class mid-finish. This is the backstop: if finish ever
    // throws, the dashboard must not be left invisible.
    try { await boot.finish(); }
    finally { $('app').classList.remove('is-booting'); }
  }
}

function showGate() {
  $('app').hidden = true;
  $('gate').hidden = false;
  $('password').focus();
}

async function signIn() {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: $('password').value }),
  });
  if (!res.ok) {
    $('gate-error').textContent = 'That password did not work. Try again.';
    return;
  }
  $('gate-error').textContent = '';
  $('password').value = '';
  load(true);
}

$('signin').addEventListener('click', signIn);
$('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') signIn(); });
$('refresh').addEventListener('click', () => load(true));

// Delegated, so anything carrying data-view shares one path.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-view]');
  if (!btn || btn.dataset.view === VIEW) return;
  VIEW = btn.dataset.view;
  localStorage.setItem('cal-view', VIEW);
  renderCalendar();
});

// Rail sections. Ask is not here — it is a drawer, wired in chat.js.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-page]');
  if (!btn || btn.dataset.page === PAGE) return;
  setPage(btn.dataset.page);
});

document.addEventListener('click', (e) => {
  const row = e.target.closest('[data-mail-id]');
  if (row) toggleMailBody(row);
});

$('cal-prev').addEventListener('click', () => goAnchor(stepAnchor(-1)));
$('cal-next').addEventListener('click', () => goAnchor(stepAnchor(1)));
$('cal-today').addEventListener('click', () => goAnchor(null));

$('news-sort').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-sort]');
  if (!btn || btn.dataset.sort === NEWS_SORT) return;
  NEWS_SORT = btn.dataset.sort;
  localStorage.setItem('news-sort', NEWS_SORT);
  renderNews();
});


// The rail loops the full 15s choreography continuously — ignition, frame draw,
// cube assembly, pulse, fade, repeat. The emblem's own `full` mode already
// wraps, so this needs no swap logic.
//
// This is the user's explicit preference. It does mean the logo fades out and
// re-ignites every 15 seconds; do not "fix" that back to idle or to a
// once-then-settle swap without asking him first.
if (window.Emblem) {
  Emblem.create($('rail-emblem'), { size: 96, mode: 'full', transparentBg: true });
}

setInterval(() => { if (PAYLOAD) tickClock(); }, 1000);

// Redraw when the grid's box changes, so a resized window re-fits its chips.
// Observing the element rather than the window also catches a scrollbar
// appearing next door. Re-rendering only on a capacity change keeps this from
// feeding itself: the grid is sized by the flex layout, not by its contents.
// The first paint does not rely on this — see the render order in load().
new ResizeObserver(() => {
  if (!PAYLOAD || VIEW !== 'month') return;
  // Zero height means the card is sitting on a hidden page. chipCapacity would
  // fall back to its default and re-render against a box that is not on screen;
  // setPage re-renders on the way back anyway.
  if (!$('mon-grid').clientHeight) return;
  if (chipCapacity() !== LAST_CAPACITY) renderCalendar();
}).observe($('mon-grid'));

// Delegated from elements that are never replaced. #market-range lives in the
// markup and #market only has its contents rewritten, so these bind once —
// per-row handlers would be rebound on every render and every range switch.
$('market-range').addEventListener('click', (e) => {
  const btn = e.target.closest('.vt');
  if (btn) loadMarketRange(btn.dataset.range);
});

$('market').addEventListener('pointermove', (e) => {
  const chart = e.target.closest('.mk-chart');
  if (chart) moveCursor(chart, e.clientX);
});

// pointerleave rather than pointerout: pointerout fires when the pointer
// crosses onto a child of the chart, which would blink the readout off every
// time it passed over its own cursor dot.
$('market').addEventListener('pointerleave', () => hideCursor($('market')));

// Keep a window left open on a second screen current.
setInterval(() => load(true), 5 * 60 * 1000);

load();
