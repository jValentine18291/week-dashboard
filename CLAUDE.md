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
  mockups and were cut on purpose — single-user app, nothing to notify.
- **The rail contains only controls that work.** It holds the Month and Week
  switches and Ask, and nothing else. Refresh was removed at the user's
  request; the topbar button and the five-minute auto-reload both remain, so
  nothing was lost. The reference mockup showed ten nav
  items — Dashboard, Calendar, Tasks, Notes, Markets, News, Goals, Files,
  Settings, Log out — for pages that do not exist in a single-page app, two of
  which (Goals, Files) are not features in any phase. Do not add nav entries
  for destinations that are not real; a dead link reads as a bug.
  `POST /api/logout` still exists and works; the user asked for the button to
  be removed because he will never use it. Keep the endpoint, leave it
  unsurfaced.
- **Auth fails closed.** With no `DASHBOARD_PASSWORD` set, `/api/dashboard` is
  served only to a loopback caller. Anything else gets a 503. Do not "simplify"
  this back to `if (!DASHBOARD_PASSWORD) return next()` — that shipped, and the
  first Railway deploy served the dashboard to the internet with no login while
  `/api/login` still returned 401 for a wrong password, so the gate looked
  fine. The guard must not key on `NODE_ENV` alone either: that deploy had
  `NODE_ENV` unset too, so a production-only check would have been disabled by
  the same missing configuration it exists to catch.
- **Scope is calendar + tasks + news.** News was built at the user's request
  and **replaced the Notes panel** — he asked for the swap and said he would
  consider re-adding Notes later. Market Watch is still unbuilt and should not
  be started until asked.

  Bringing Notes back is three steps, all still in place: `fetchNotes` in
  `lib/notion.js` is untouched, add it back to the `Promise.allSettled` in
  `buildPayload`, and give it a panel. The layout would need a third area —
  the bottom row currently holds News alone.

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

## Files

```
server.js            express, auth, /api/dashboard
lib/                 calendar.js, notion.js, week.js
public/index.html    single page: boot host, gate, rail, topbar, three panels
public/styles.css    dashboard
public/boot.css      boot sequence only
public/app.js        rendering + boot wiring
public/boot.js       boot sequence (vanilla port of the handoff)
public/emblem.js     animated hex-cube emblem (vanilla port of the handoff)
verify-calendar.js   DTSTART-anchoring fixture
```

## HUD geometry

Panels are **chamfered, not rounded** — that is the defining difference from a
generic card. A `border` cannot follow a `clip-path`, so each panel is a pair:
`.card` is the 1px gradient border clipped to the silhouette, `.card-in` is the
dark fill clipped to the same silhouette one pixel smaller. `.rail`/`.rail-in`
work identically. This is the design handoff's own technique; do not try to
collapse it back into one element with a `border`.

`.card-in::before` is the dim inset frame, `.card-in::after` the corner
brackets. Both pseudo-elements are taken — anything else needs real markup.

Type: **Orbitron** for headings and system labels only, **Rajdhani** for body
and data. Do not set Orbitron on small text; it is unreadable below ~12px.

## Boot sequence

`boot.js` + `boot.css`, ported from the supplied handoff. Runs **once**, on the
first successful load, from `load()` in `app.js`.

- Progress is driven by real state, never simulated: fetch in flight, then
  per-module status read from the payload the server actually returned. A panel
  that errored shows `!`, not a tick.
- **Market Feed and News Stream render as STANDBY**, not spinners. They are
  phase 2 and do not exist; the handoff explicitly says never to leave a
  spinner that cannot resolve.
- A 401 aborts the boot immediately and shows the login gate — there is no
  point booting a dashboard the user cannot see.
- `MIN_VISIBLE_MS` is 1800. Both the handoff and the brief sanction a short
  floor for visual continuity. Do not raise it to buy spectacle.
- It must never run on the five-minute auto-refresh. `BOOTED` guards this.

The centre badge hosts the same emblem as the rail, in `full` mode. The handoff
offers a three.js cube; we do not take it — a WebGL dependency for a 64px
decoration is not worth it, and reusing the emblem makes the boot screen and
the dashboard visibly the same system.

**The rail loops `full` continuously** — ignition, frame draw, cube assembly,
pulse, fade, repeat. This is the user's explicit choice, made after seeing both
alternatives: `idle` (which skips the ignition and assembly entirely) and
once-then-settle. He wants the whole sequence playing all the time. The
trade-off — the logo fades out and re-ignites every 15 seconds beside the
calendar — was raised and accepted. Do not quietly revert it.

`emblem.js` carries a `killed` flag regardless. `onLoop` fires from inside the
rAF step and the step schedules its next frame *after* calling it, so any
`onLoop` that destroys the instance would leave a detached SVG animating
forever. The rail no longer uses `onLoop`, but `destroy()` is still called on
boot teardown, so the guard stays.

## News

`lib/news.js` — RSS, not a news API (NewsAPI's free tier is development-only;
see HANDOVER phase 2 research). Parsed by hand rather than with an XML
dependency, matching how Notion and chat are done. Feeds are configurable via
`NEWS_FEEDS` (comma-separated); the default pair is CNA Singapore and BBC World.

Things that are load-bearing, all measured against the live feeds:

- **`&amp;` is decoded last** in `decode()`. Decode it first and `&amp;lt;`
  becomes a real `<`, letting feed content inject markup.
- **`media:thumbnail` attribute order differs by feed** — CNA puts `url` first,
  BBC puts it last. Match the attribute, never a position.
- **Many feeds carry no image at all.** Straits Times has none. The blank
  thumbnail fallback is not decoration; without it rows lose their alignment.
- **Source names come from `sourceName()`, not the channel title.** CNA titles
  its channel "Latest News", which is useless once two feeds are interleaved.
- One dead feed must not blank the panel: feeds are settled independently, and
  only an all-feeds failure throws.

`.card-news` has a **`max-height: 176px`**. Its grid row is `auto`, so without
a ceiling the feed grows with its content and eats the calendar. Measured at
1920×950: 176px keeps the month grid at 4 chips per day, 190px drops it to 3.

## Assistant

A chat drawer, `lib/chat.js` + `POST /api/chat` + `public/chat.{js,css}`. Added
at the user's request as a scratchpad for general questions.

- **It is never given dashboard data.** Not calendar, not tasks, not notes. The
  user asked for a general assistant, explicitly not one that reads his data,
  and that is the whole reason the privacy question does not arise. `sanitise()`
  strips every field except `role` and `content`, so nothing can ride along on a
  message object. If context is ever wanted, that is a decision for him, not a
  refactor to slip in.
- **The read-only constraint is untouched** — the relay cannot reach Notion or
  Google, and could not write to them if it tried.
- **The key never leaves the server.** It lives in `OPENAI_API_KEY` and is used
  only in the route. Upstream error text can contain key material, so the route
  returns a generic message rather than relaying it.
- **Rate limited** to 30 messages per 10 minutes, process-wide. The dashboard is
  internet-facing behind one password; without this, anyone through the gate has
  a metered relay on the owner's bill.
- **Optional.** With no `OPENAI_API_KEY` the route returns 503 and the rest of
  the app is unaffected.
- **Provider-agnostic.** `OPENAI_BASE_URL` points the relay at any
  OpenAI-compatible endpoint; the env vars keep their `OPENAI_` names because
  the *protocol* is OpenAI's, whoever serves it. Google's Gemini speaks it
  natively at `https://generativelanguage.googleapis.com/v1beta/openai` —
  same path, same Bearer auth, same streaming deltas — so switching providers
  is three variables and no code. That is also what makes the path testable
  against a mock upstream without a real key or a real bill.
- Base URLs are normalised for a trailing slash: Google documents theirs with
  one and OpenAI without, and `//chat/completions` is not the same path.
- The default model is provider-aware. A Gemini base URL with no
  `OPENAI_MODEL` would otherwise send an OpenAI model name to Google.

The drawer is an **overlay**, not a fourth panel. Three panels already fill the
viewport; a column would squeeze the calendar and break the one-screen rule.

## Theme

Dark HUD. All colour lives in the `:root` tokens at the top of `styles.css`,
plus two palettes in `public/app.js` — `PALETTE` for calendar blocks and
`NOTE_COLOURS` for notes. Those two are written as `rgba()` washes rather than
solid fills on purpose: a pale fill reads as a hole punched in a dark panel,
whereas a tinted wash reads as a lit surface.

Panels carry HUD corner brackets: eight `linear-gradient` layers painted into a
single `::after`, two arms per corner, inset 7px so the square arms sit inside
the rounded corner rather than fighting the curve. No extra DOM. `::before` is
the animated top seam and is absolutely positioned — it must not go back to
being a flex item, or it steals a row of the card's height and takes `::after`
with it.

If the arms grow (`--bracket-arm`, `--bracket-w`) or the inset shrinks, re-check
that they do not cross any text. That is measurable: build the eight arm
rectangles per panel and test them against the bounding boxes of `.mon-what`,
`.wk-title`, `.note-title` and friends. Currently zero overlap with a
deliberately overfilled month.

Check contrast after any colour change; it is measurable, so measure it rather
than eyeballing. In the console with the dashboard loaded, walk the text nodes
and compare each against its composited background — and composite translucent
ancestors properly. Blending a translucent layer as though it were opaque
produces confident nonsense: it reported the event blocks at 1.03:1 when they
were actually fine.

## Motion

Ambient, but the dashboard re-renders itself every five minutes.

**Entrance animations attach only to elements that survive a render** — the
rail, the topbar, the three cards, the gate card. Anything animated *inside* a
panel (day cells, event blocks, task rows, note cards) is rebuilt by that
render and would replay its entrance every five minutes, flashing the screen
while the user is reading it. This is the reason `.card` carries the animation
and `.mon-cell` does not.

Ambient loops (`breathe`, `shimmer`, `seamSweep`, `nowPulse`) are on persistent
elements for the same reason, so they run continuously instead of restarting.

`prefers-reduced-motion: reduce` disables every animation and transition
globally. None of the motion is load-bearing, so there is nothing to preserve.

To check a change has not reintroduced the replay, re-render and confirm the
entrance animations did not restart:

```js
const t = () => document.getAnimations().filter(a => a.animationName === 'riseIn')
  .map(a => Math.round(a.currentTime));
const before = t(); renderThisWeek(); renderNotes(); renderCalendar();
console.log(before, t());   // must not reset to 0
```

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
