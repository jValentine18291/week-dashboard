# Week Dashboard

Personal read-only dashboard for a single user in Singapore (Asia/Singapore).
Node + Express, no build step, deployed on Railway. Pulls Google Calendar via a
secret iCal feed and Notion via the REST API.

The calendar opens on a **month** grid, with a Month/Week toggle in the card
header; the choice is remembered in `localStorage`. Tasks and notes stay
weekly regardless of which calendar view is showing.

Longer background, rejected alternatives and phase 2 research: see `HANDOVER.md`.
User-facing setup steps: see `SETUP.txt`.

## Hard constraints — confirm before changing any of these

- **Read-only.** Never add write calls to Notion or Google Calendar. The user
  deliberately declined write access; he creates notes and events on his phone.
  This includes "helpful" additions like a working checkbox or a quick-add box.
- **Desktop only.** Mobile layout is explicitly out of scope. Do not spend
  effort on responsive work below ~1180px beyond the single fallback already there.
- **One screen, no page scroll.** At 1180px and up the whole dashboard fits the
  viewport: `body` is `overflow: hidden`, `#app` is a `100vh` grid, and every
  panel owns its overflow internally. A change that makes the page itself
  scroll is a regression, not a layout detail. Below 1180px the fallback
  deliberately gives up and restores normal page scrolling.
- **No build step.** Plain Express, vanilla JS, hand-written CSS. Do not
  introduce React, Vite, Tailwind, TypeScript or a bundler.
- **No search bar, notification bell or avatar.** These were in the reference
  mockup and were cut on purpose — single-user app, nothing to notify.
- **Auth fails closed.** With no `DASHBOARD_PASSWORD` set, `/api/dashboard` is
  served only to a loopback caller. Anything else gets a 503. Do not "simplify"
  this back to `if (!DASHBOARD_PASSWORD) return next()` — that shipped, and the
  first Railway deploy served the dashboard to the internet with no login while
  `/api/login` still returned 401 for a wrong password, so the gate looked
  fine. The guard must not key on `NODE_ENV` alone either: that deploy had
  `NODE_ENV` unset too, so a production-only check would have been disabled by
  the same missing configuration it exists to catch.
- **Phase 1 scope is calendar + tasks + notes.** Market Watch and News are
  phase 2 and should not be built until asked.

## Landmines

These are all load-bearing and all have cost real debugging time. Do not
"simplify" them away.

1. **rrule occurrences are not all the same kind of Date** —
   `occurrenceReader()` in `lib/calendar.js`. `correctFloatingTime()` re-reads a
   Date's UTC components as local time. Whether an occurrence needs that
   depends on how DTSTART was anchored, and **one Google feed mixes all three
   forms**. Measured against node-ical 0.18:

   | DTSTART | occurrence from `rrule` | needs correcting |
   |---|---|---|
   | `20260803T090000` (floating) | real instant | no |
   | `TZID=Asia/Singapore:20260803T190000` | real instant | no |
   | `20260803T110000Z` (UTC) | floating wall-clock | **yes** |

   Applying the correction to the wrong kind shifts the event by the UTC
   offset — 8 hours here. An earlier version of this file claimed *every*
   recurring event needs it; that was true only of the fixture it was written
   against, and it silently rendered the user's 19:00 classes at 11:00 in the
   first live run.

   `occurrenceReader()` therefore **detects** rather than assumes: it asks the
   rule for its first occurrence and keeps whichever reading lands on the same
   wall-clock time as the event's own DTSTART. This is version-specific
   behaviour of node-ical, so do not replace the detection with a hardcoded
   rule based on `ev.start.tz` or on the presence of a TZID.

   Guarded by `verify-calendar.js` — run it after touching this file.

   Related: an all-day DTSTART and DTEND can resolve against different
   midnights, leaving a one-day event 8 hours short. All-day spans are whole
   days by definition, so `durationMs` rounds rather than trusting the
   difference.

2. **`[hidden]` needs `!important`** — in `styles.css`. A class-level
   `display` rule (`.gate { display: grid }`) outranks the browser's UA rule for
   the `hidden` attribute, so the login screen renders behind the dashboard.
   The global `[hidden] { display: none !important; }` fixes it. Keep it.

3. **Notion API version is `2025-09-03`** — queries go to
   `/v1/data_sources/{id}/query`. The older `/v1/databases/{id}/query`
   endpoint belongs to the previous API version. Most tutorials online still
   show the old one. Do not "fix" it backwards.

4. **Timezone is pinned before any Date use** — `process.env.TZ` is set at the
   top of `server.js`, before other requires. All date maths in `lib/week.js`
   assumes local time equals the user's timezone. Do not add a timezone
   library; do not move that assignment.

5. **Only the date filter goes to the Notion API.** Status is interpreted in
   Node afterwards. This is deliberate: a renamed or differently-typed status
   column would otherwise 400 the whole request and blank the panel.

6. **The month grid measures its own box** — `chipCapacity()` in
   `public/app.js` divides the real grid height to decide how many event chips
   fit in a day cell, so the grid fills a large window without ever overflowing
   a small one. Two consequences, both load-bearing:
   `renderCalendar()` runs **last** in `load()`, after the other panels have
   claimed their height, or it measures a box it is about to lose; and
   `CHIP_H`/`NUM_RESERVE` must track the real `.mon-chip` and `.mon-num` sizes
   in `styles.css`. As measured: a chip is 17.2px plus a 2px gap, and the day
   number occupies 17.5px plus 4px of cell padding — so the constants (19 and
   23) each carry only a little headroom. Anything that grows the card header,
   the chip font or the day number costs a visible chip line per day; re-measure
   rather than guess, and confirm `clipped cells` is still 0. A `ResizeObserver` re-fits on later resizes, but the first
   paint deliberately does not depend on it — observer callbacks are delivered
   with the rendering lifecycle, which a non-compositing browser never runs.

7. **An event belongs to every day it covers** — `coveredDayKeys()` in
   `public/app.js`. Grouping by `dayKey(event.start)` is the obvious thing to
   write and it silently drops multi-day events onto their first day only.
   Two conventions collide and one step back handles both: iCal gives all-day
   events an **exclusive** end (10th–13th means the 10th, 11th and 12th), while
   a timed event ending at exactly midnight belongs to the day before. The last
   covered instant is therefore `end - 1ms`, never `end`.

   The week view depends on the same function twice over: the all-day strip
   filters on it, and timed events are cut into one segment per covered day.
   Those segments are measured off the event's **duration**, not its end time —
   read as a minute-of-day, the end of a 20:00–00:00 event is `0`, which
   collapses the block to a 15-minute sliver.

8. **The calendar fetch window is the month grid, not the month.** `server.js`
   fetches whole Monday–Sunday weeks either side of the month so the greyed
   leading and trailing cells still show their events. One fetch serves both
   views; the week view narrows the same array with `eventsOn()`. Toggling
   views must not hit the server.

## Conventions

- Notion column names are configurable through `NOTION_*_PROPERTY` env vars.
  Never hardcode a column name.
- Every property reader returns null rather than throwing, so one bad column
  cannot blank a panel.
- Data sources are fetched with `Promise.allSettled` so panels fail
  independently. Preserve this when adding a panel.
- Errors surface in the affected panel's UI, not just the console.
- Comments explain *why*, not what. Do not add comments that restate the code.
- `HOUR_H` in `public/app.js` must stay in sync with `--hour-h` in `styles.css`.
  This applies to the week view only; the month grid has no hour rows.
- Tasks and notes are scoped to the week even when the calendar shows a month.
  `weekItems()` narrows events with `eventsOn(PAYLOAD.week.days)` — the "This
  Week" progress bar is meant to measure a week.

## Verifying a change

Before reporting a change complete:

```bash
node --check server.js && node --check public/app.js && \
node --check lib/calendar.js && node --check lib/notion.js && node --check lib/week.js
```

For anything touching `lib/calendar.js`, run the fixture — it covers DTSTART
anchorings a live feed will not, and exits non-zero on any mismatch:

```bash
node verify-calendar.js
```

Checking against the real feed is **not** a substitute. The user's calendar
contains no recurring UTC events, so the bug that shipped in the first live run
was invisible to it. Equally, "the times look plausible" is not verification —
that is precisely how 19:00 classes were signed off as correct at 11:00.
Compare against the raw `.ics` text, which is the ground truth Google serves.

For calendar changes, exercise the overlap algorithm directly — it is pure and
easy to test in isolation:

```bash
node -e "
const src=require('fs').readFileSync('public/app.js','utf8');
eval(src.match(/function assignColumns[\s\S]*?\n}/)[0]);
const mk=(t,s,e)=>({title:t,startMin:s,endMin:e});
console.log(assignColumns([mk('A',540,660),mk('B',600,700),mk('C',900,960)])
  .map(e=>e.title+':col'+e.col+'/'+e.colCount).join(' '));
"
```

Expected: `A:col0/2 B:col1/2 C:col0/1` — a busy morning must not narrow a quiet
afternoon. Clusters are sized by their own overlap depth, not the day's. This
algorithm serves the week view only.

If a browser is available, render the page against mock data and look at it.
Two of the three real bugs in this project were only visible in a screenshot.

For layout changes, the one-screen constraint is checkable without eyes. In the
console, with the dashboard loaded:

```js
const d = document.scrollingElement;
console.log('page scrolls:', d.scrollHeight > d.clientHeight);          // must be false
console.log('clipped cells:', [...document.querySelectorAll('.mon-events')]
  .filter(e => e.scrollHeight > e.clientHeight + 1).length);            // must be 0
```

Check both at 1920×1080 and at a smaller window — a month cell that is too
short must fall back to a `"N events"` count, never to a bare `"+N more"` with
nothing named.

## Phase 2, when asked

Facts already researched — do not re-derive:

- **Market Watch (5 tickers).** Alpha Vantage free is now ~25 calls/day, too
  tight. Use Finnhub (~60/min) or Twelve Data (~800/day). Yahoo Finance is
  unreliable and IEX Cloud is deprecated. Free tiers give daily bars, so a
  sparkline is ~30 daily closes, not an intraday curve.
- **News.** Use RSS feeds, not a news API — NewsAPI's free tier is
  development-only. Many feeds carry no image, so a thumbnail fallback is
  required or the panel looks broken.
- **Layout space is already reserved.** `.layout` in `styles.css` uses
  `"cal week" / "notes week"`. Market Watch slots between `cal` and `notes`;
  News goes under `week`.
