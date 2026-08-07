'use strict';

const $ = (id) => document.getElementById(id);

let TZ = 'Asia/Singapore';
let PAYLOAD = null;
let FILTER = 'all';

// Month is the default view. Remembered so a window left open on a second
// screen comes back the way it was left.
let VIEW = localStorage.getItem('cal-view') === 'week' ? 'week' : 'month';

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

const NOTE_COLOURS = [
  { bg: 'rgba(251, 191, 36, 0.10)',  fg: '#ffc94d' },
  { bg: 'rgba(56, 189, 248, 0.10)',  fg: '#4cc9f5' },
  { bg: 'rgba(52, 211, 153, 0.10)',  fg: '#45e0ab' },
  { bg: 'rgba(167, 139, 250, 0.10)', fg: '#b39bff' },
  { bg: 'rgba(251, 90, 118, 0.10)',  fg: '#ff8098' },
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

// The payload always carries the whole month grid, so each view narrows the
// same array to the days it draws rather than asking the server again. Matched
// on every day an event covers, so one that started before this window but runs
// into it is not dropped.
function eventsOn(days) {
  const keys = new Set(days.map(dayKey));
  return (PAYLOAD.calendar.data || []).filter((e) =>
    coveredDayKeys(e).some((k) => keys.has(k)));
}

function renderCalendar() {
  const month = VIEW === 'month';
  $('cal-month').hidden = !month;
  $('cal-week').hidden = month;
  // Covers both the card-header toggle and the rail, so the two never disagree.
  document.querySelectorAll('[data-view]').forEach((b) =>
    b.classList.toggle('is-active', b.dataset.view === VIEW));

  if (month) renderMonth();
  else renderWeekGrid();

  wireEventDetails();
  showError('calendar-error', PAYLOAD.calendar.error);
}

// ---------- month view ----------

const CHIP_H = 19;      // .mon-chip line box plus its 2px gap
const NUM_RESERVE = 23; // .mon-num plus the cell's own vertical padding

let LAST_CAPACITY = null;

// Derived from the real cell height rather than assumed, so the grid fills a
// large window and still refuses to overflow a small one.
function chipCapacity() {
  const grid = $('mon-grid');
  const rows = (PAYLOAD.month.days.length / 7) || 6;
  const cellH = (grid.clientHeight || 540) / rows;
  return Math.max(1, Math.floor((cellH - NUM_RESERVE) / CHIP_H));
}

function renderMonth() {
  const days = PAYLOAD.month.days;
  const events = eventsOn(days);
  const todayKey = dayKey(PAYLOAD.week.today);
  const thisMonth = monthKey(PAYLOAD.month.start);
  const rows = days.length / 7;

  $('cal-range').textContent =
    fmt(new Date(PAYLOAD.month.start), { month: 'long', year: 'numeric' });

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

      // With room for only one line, a bare "+6 more" would show the day as
      // busy without naming anything. A plain count is more use than that.
      let shown = list;
      let overflow = '';
      if (list.length > capacity) {
        if (capacity === 1) {
          shown = [];
          overflow = `<span class="mon-more">${list.length} events</span>`;
        } else {
          shown = list.slice(0, capacity - 1);
          overflow = `<span class="mon-more">+${list.length - shown.length} more</span>`;
        }
      }

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
        <span class="mon-num">${fmt(new Date(iso), { day: 'numeric' })}</span>
        <div class="mon-events">${chips}${overflow}</div>
      </div>`;
    })
    .join('');
}

// ---------- week view ----------

function renderWeekGrid() {
  const days = PAYLOAD.week.days;
  const events = eventsOn(days);
  const todayKey = dayKey(PAYLOAD.week.today);

  $('tz-label').textContent = fmt(new Date(), { timeZoneName: 'shortOffset' }).split(', ').pop() || '';
  $('cal-range').textContent =
    `${fmt(new Date(PAYLOAD.week.start), { day: 'numeric', month: 'short' })} – ` +
    `${fmt(new Date(PAYLOAD.week.end), { day: 'numeric', month: 'short', year: 'numeric' })}`;

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
      const ev = (PAYLOAD.calendar.data || []).find((e) => e.id === btn.dataset.id);
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

// ---------- this week ----------

function weekItems() {
  const tasks = (PAYLOAD.tasks.data || []).map((t) => ({
    kind: 'task',
    id: t.id,
    title: t.title,
    when: t.due,
    done: t.done,
    priority: t.priority,
    status: t.status,
    areas: t.areas,
    url: t.url,
  }));

  // Narrowed to the current week even when the calendar is showing the month:
  // this panel and its progress bar are deliberately weekly.
  const events = eventsOn(PAYLOAD.week.days).map((e) => ({
    kind: 'event',
    id: e.id,
    title: e.title,
    when: e.start,
    done: false,
    allDay: e.allDay,
    location: e.location,
  }));

  return [...tasks, ...events].sort((a, b) => new Date(a.when) - new Date(b.when));
}

// Events carry no pill: the round marker already distinguishes them from tasks,
// and the right-hand column is more useful showing when the thing happens.
function pillFor(item) {
  if (item.kind === 'event') return '';
  if (item.done) return '<span class="pill pill-done">Done</span>';
  const p = (item.priority || '').toLowerCase();
  if (p.startsWith('high')) return '<span class="pill pill-high">High</span>';
  if (p.startsWith('med')) return '<span class="pill pill-medium">Medium</span>';
  if (p.startsWith('low')) return '<span class="pill pill-low">Low</span>';
  return '';
}

function renderThisWeek() {
  const all = weekItems();
  const tasks = all.filter((i) => i.kind === 'task');
  const events = all.filter((i) => i.kind === 'event');

  $('n-all').textContent = all.length;
  $('n-task').textContent = tasks.length;
  $('n-event').textContent = events.length;

  const doneCount = tasks.filter((t) => t.done).length;
  const pct = tasks.length ? Math.round((doneCount / tasks.length) * 100) : 0;
  $('progress-fill').style.width = `${pct}%`;
  $('progress-pct').textContent = `${pct}%`;

  const shown = FILTER === 'all' ? all : all.filter((i) => i.kind === FILTER);
  const el = $('week-list');
  const todayKey = dayKey(PAYLOAD.week.today);

  if (!shown.length) {
    el.innerHTML = '<p class="empty">Nothing here this week.</p>';
    showError('tasks-error', PAYLOAD.tasks.error);
    return;
  }

  el.innerHTML = shown
    .map((item) => {
      const d = new Date(item.when);
      const overdue = item.kind === 'task' && !item.done && dayKey(item.when) < todayKey;
      const date = fmt(d, { weekday: 'short', day: 'numeric', month: 'short' });

      // Second line qualifies the date rather than repeating it: a time for a
      // timed event, why the date matters for a task. Blank once a task is
      // done, since its pill already says so.
      const note = overdue ? 'Overdue'
        : item.kind === 'event' ? (item.allDay ? 'All day' : clockOf(item.when))
        : item.done ? ''
        : 'Due';

      return `<button class="wk-item ${item.done ? 'is-done' : ''}" type="button"
                data-kind="${item.kind}" data-id="${escapeHtml(item.id)}" aria-expanded="false">
        <span class="box ${item.kind === 'event' ? 'is-event' : ''}"></span>
        <span class="wk-main">
          <span class="wk-title">${escapeHtml(item.title)}</span>
        </span>
        ${pillFor(item)}
        <span class="wk-when ${overdue ? 'is-overdue' : ''}">
          <span class="wk-date">${escapeHtml(date)}</span>
          ${note ? `<span class="wk-note">${escapeHtml(note)}</span>` : ''}
        </span>
      </button>`;
    })
    .join('');

  wireWeekDetails(shown);
  showError('tasks-error', PAYLOAD.tasks.error);
}

function wireWeekDetails(items) {
  document.querySelectorAll('.wk-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const open = btn.getAttribute('aria-expanded') === 'true';
      const next = btn.nextElementSibling;
      if (open && next && next.classList.contains('wk-detail')) {
        next.remove();
        btn.setAttribute('aria-expanded', 'false');
        return;
      }
      const item = items.find((i) => i.id === btn.dataset.id && i.kind === btn.dataset.kind);
      if (!item) return;

      const lines = [];
      if (item.kind === 'task') {
        if (item.status) lines.push(`<p>Status: ${escapeHtml(item.status)}</p>`);
        if (item.areas && item.areas.length) lines.push(`<p>Area: ${escapeHtml(item.areas.join(', '))}</p>`);
        if (item.url) lines.push(`<p><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">Open in Notion</a></p>`);
      } else {
        if (item.location) lines.push(`<p>${escapeHtml(item.location)}</p>`);
        lines.push(`<p>${escapeHtml(item.allDay ? 'All day' : clockOf(item.when))}</p>`);
      }

      const div = document.createElement('div');
      div.className = 'wk-detail';
      div.innerHTML = lines.join('') || '<p>No further details.</p>';
      btn.after(div);
      btn.setAttribute('aria-expanded', 'true');
    });
  });
}

// ---------- notes ----------

function renderNotes() {
  const notes = PAYLOAD.notes.data || [];
  const el = $('notes');
  $('notes-meta').textContent = notes.length ? `${notes.length} most recent` : '';

  if (!notes.length) {
    el.innerHTML = '<p class="empty">No notes yet.</p>';
    showError('notes-error', PAYLOAD.notes.error);
    return;
  }

  el.innerHTML = notes
    .map((n) => {
      const c = colourFor(n.title, NOTE_COLOURS);
      const tags = n.areas && n.areas.length ? escapeHtml(n.areas.join(' · ')) : '';
      return `<a class="note" href="${escapeHtml(n.url || '#')}" target="_blank" rel="noopener"
                style="background:${c.bg};color:${c.fg};border-color:${c.fg}44">
        <div class="note-title">${escapeHtml(n.title)}</div>
        ${tags ? `<div class="note-tags">${tags}</div>` : ''}
        <div class="note-date">${fmt(new Date(n.created), { day: 'numeric', month: 'short', year: 'numeric' })}</div>
      </a>`;
    })
    .join('');

  showError('notes-error', PAYLOAD.notes.error);
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
  const boot = !BOOTED && window.Boot ? Boot.start() : null;
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
    boot.module('tasks', !PAYLOAD.tasks.error);
    boot.module('notes', !PAYLOAD.notes.error);
    boot.progress(95);
  }

  $('gate').hidden = true;
  $('app').hidden = false;

  renderHeader();
  renderThisWeek();
  renderNotes();
  // Last on purpose. The month grid measures its own box to decide how many
  // chips fit in a day cell, so the panels that share the layout have to claim
  // their height first or it measures a box it is about to lose.
  renderCalendar();

  BOOTED = true;
  if (boot) await boot.finish();
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

// Delegated, so the card-header toggle and the rail share one path.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-view]');
  if (!btn || btn.dataset.view === VIEW) return;
  VIEW = btn.dataset.view;
  localStorage.setItem('cal-view', VIEW);
  renderCalendar();
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
  if (chipCapacity() !== LAST_CAPACITY) renderCalendar();
}).observe($('mon-grid'));

$('filters').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  FILTER = chip.dataset.filter;
  document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', c === chip));
  renderThisWeek();
});

// Keep a window left open on a second screen current.
setInterval(() => load(true), 5 * 60 * 1000);

load();
