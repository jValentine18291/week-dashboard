# Week Dashboard

Personal read-only dashboard for a single user in Singapore (Asia/Singapore).
Node + Express, no build step, deployed on Railway. Pulls Google Calendar via a
secret iCal feed and Notion via the REST API.

The calendar opens on a **month** grid, with a Month/Week toggle in the card
header; the choice is remembered in `localStorage`. Tasks and notes stay
weekly regardless of which calendar view is showing.

Longer background, rejected alternatives and phase 2 research: see `HANDOVER.md`.
User-facing setup steps: see `SETUP.txt`.
Picking the project up on a new development machine: see `WORKSTATION.md` —
tooling, pulling config from Railway rather than by hand, and current state.

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
- **The rail contains only entries that go somewhere real.** It holds
  Dashboard, Ask, Calendar and News. Three are pages; Ask is the chat drawer and
  opens over whichever page is up. This rule has not changed — what changed is
  that the destinations now exist. The user asked for the nav in August 2026 and
  the pages were built to match; adding an entry still means building the thing
  it points at, because a dead link reads as a bug. The reference mockup's ten
  items — Dashboard, Calendar, Tasks, Notes, Markets, News, Goals, Files,
  Settings, Log out — remain wrong for that reason: two of them (Goals, Files)
  are not features in any phase.

  **Tasks is deliberately not a section.** The user was explicit: This Week is
  a brief summary that belongs on the dashboard. Do not promote it to a page.

  The Month and Week switches moved out of the rail and into the calendar card
  header, where a duplicate pair already lived. Refresh was removed earlier at
  the user's request; the topbar button and the five-minute auto-reload both
  remain, so nothing was lost. `POST /api/logout` still exists and works; the
  user asked for the button to be removed because he will never use it. Keep the
  endpoint, leave it unsurfaced.
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
   `CHIP_H`/`NUM_RESERVE` must track the real `.mon-chip` and `.mon-top` sizes
   in `styles.css`. As measured: a chip is a 13px line box plus a 1px gap, and
   `.mon-top` is 14.5px plus 2px of cell padding, 1px of `.mon-events` padding
   and a 1px cell border — so the constants (14 and 19) carry about half a pixel
   of headroom each. Anything that grows the card header, the chip font or the
   day number costs a visible chip line per day; re-measure rather than guess,
   and confirm `clipped cells` is still 0. A `ResizeObserver` re-fits on later
   resizes, but the first paint deliberately does not depend on it — observer
   callbacks are delivered with the rendering lifecycle, which a non-compositing
   browser never runs.

   **Leading, not glyph size, is what buys capacity here.** The chips were
   10.5px type sitting in a 17.2px line box; they are now 10px type in a 13px
   box. Half a pixel came off the text and four came off the line. The same
   applies to everything else in the cell — the day-name bar, the cell padding,
   the inter-chip gap — so reach for those before shrinking type that has to
   stay readable at 10px.

   **The overflow count is not a chip.** It lives in `.mon-top` beside the day
   number, so it costs no vertical space. It used to be an item in the chip
   stack, which meant that at a capacity of 1 the indicator consumed the only
   line and the cell rendered as a bare `"3 events"` naming nothing — the
   failure the user actually reported. Putting it back in the stack reintroduces
   that, whatever the type sizes are.

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

   The Calendar page stretches this rather than breaking it. `/api/calendar`
   returns the same frame shape for any anchor date, and `monthCalendar()`
   caches by month grid, so stepping back to a month already seen is free. The
   load-bearing property is that **a month grid always contains the whole week
   containing its anchor** — that is what lets the page step weeks without
   refetching until it crosses into a new month. It holds because a grid is
   built from `startOfWeek(startOfMonth)` to `endOfWeek(endOfMonth)`; asserted
   for every day of 2025–2028 rather than assumed.

9. **Only the Calendar page may move off the real month.** `calSource()` returns
   the anchored frame there and the dashboard payload everywhere else, and
   `weekItems()` ignores it entirely — This Week reads `PAYLOAD.week` and
   `PAYLOAD.calendar.data` directly. Wiring it to `calSource()` would make the
   progress bar measure March because the calendar happened to be showing it.
   Leaving the page clears the anchor for the same reason.

10. **A grid area that does not exist fails silently.** The narrow fallback's
    `grid-template-areas` still read `"cal" "week" "notes"` for months after the
    Notes panel became News. `.card-news` matched no area, so it was
    auto-placed into an *implicit third column* and the "single column" stack
    was quietly three columns wide — the calendar got 404px of an available
    989px below 1180px. Nothing errored and nothing logged. Renaming a panel
    means grepping the stylesheet for its area name, and `grid-template-columns`
    in the inspector is what makes this visible.

## Files

```
server.js            express, auth, /api/dashboard, /api/calendar
lib/                 calendar.js, notion.js, week.js
public/index.html    single page: boot host, gate, rail, topbar, three panels
public/styles.css    dashboard
public/boot.css      boot sequence only
public/app.js        rendering + boot wiring
public/boot.js       boot sequence (vanilla port of the handoff)
public/emblem.js     animated hex-cube emblem (vanilla port of the handoff)
verify-calendar.js   DTSTART-anchoring fixture
verify-visual.html   file:// screenshot fixture for the news panel
```

## Pages

Three pages, one rail, no router. `setPage()` in `public/app.js` shows one of
`#page-dashboard` / `#page-calendar` / `#page-news` and **moves** the Calendar
and News cards between them.

- **Moving, not duplicating.** There is exactly one of each card in the
  document, so every id stays unique and every handler stays wired. Rendering a
  second copy would mean duplicate markup and a renderer that had to be told
  which copy it was drawing into.
- **`place()` only moves when the parent actually changes.** Re-inserting a node
  restarts its entrance animation, and `load()` calls `setPage()` on every
  five-minute refresh. Without the guard the screen would flash while the user
  was reading it — the same failure the Motion section describes.
- **`setPage()` renders the calendar last**, for the reason `load()` does: the
  month grid measures its own box, so it must be in a laid-out, visible
  container by then. That is also why the pages are unhidden before the cards
  are moved into them.
- **The `ResizeObserver` bails on a zero-height grid.** A card sitting on a
  hidden page measures nothing, `chipCapacity()` falls back to its default, and
  it would re-render against a box that is not on screen.
- The dashboard's `.card-news` cap lives on `.layout > .card-news`, so it
  applies in the grid and not on the News page. `.card.is-full` undoes anything
  a card caps on itself.

## HUD geometry

Panels are **chamfered, not rounded** — that is the defining difference from a
generic card. A `border` cannot follow a `clip-path`, so each panel is a pair:
`.card` is the 1px gradient border clipped to the silhouette, `.card-in` is the
dark fill clipped to the same silhouette one pixel smaller. `.rail`/`.rail-in`
work identically. This is the design handoff's own technique; do not try to
collapse it back into one element with a `border`.

`.card-in::before` is the dim inset frame, `.card-in::after` the corner
brackets. Both pseudo-elements are taken — anything else needs real markup.

**Both pseudo-elements paint over panel content, so scrollers have to stop
short of them.** The frame sits at `inset: 5px` with a 1px border (5–6px in),
the brackets at `inset: 7px`, both above the content. A scroll container
filling `.card-in` runs past both on three sides, and it shows up twice over:
whichever row lands at the bottom is guillotined mid-height with the cut
outside the frame — measured on News, 25.6px of a 50.8px story — and the
scrollbar, which lives at the scroller's right edge, puts a 9px bright thumb on
top of the corner bracket.

`.news-list`, `.week-list` and `.mail-list` share one rule. Three parts, all
load-bearing:

- `margin: 0 var(--frame-inset) var(--frame-inset)` pulls the scroll *viewport*
  inside the furniture. Padding cannot do this — padding does not move a
  scroller's viewport, so it only helps once you have scrolled to the end. Top
  stays flush because the card head sits directly above with its own border.
- A bottom `mask-image` dissolves a partly-scrolled row instead of slicing it,
  which doubles as the signal that there is more below. It does **not** dim the
  scrollbar; Chrome leaves that outside the element mask, checked in a capture.
- `padding-bottom` must stay equal to `--list-fade`. At full scroll that
  padding is what occupies the fade zone, so the last row stays crisp instead
  of dimming for no reason.

`--frame-inset` is 8px because it clears the brackets at 7px, not just the
frame at 6px. It is derived from those two insets — move either and it moves.

The rule is grouped across all three lists because the overshoot is structural
to the card construction, not a News bug; News is only the panel with enough
rows to make it visible. Verified by measuring each list's edges against
`.card-in`'s box inset by 7 — all three must be `<= 0`, and the bottom was `+5`
before. The change costs the calendar nothing: chips per day and
`.card-calendar .card-in` height are identical with the rule applied and forced
off, which is the A/B worth repeating rather than assuming.

**The scrollbar-on-bracket half of this measured perfectly fine.** Every number
was inside its own box; it was only wrong to look at. See `verify-visual.html`
for how to get a picture — it is a file:// fixture of the news panel at scroll
top and scroll end, screenshotted with headless Chrome, and it needs no server
and no credentials.

Type: **Orbitron** for headings and system labels only, **Rajdhani** for body
and data. Do not set Orbitron on small text; it is unreadable below ~12px.

The calendar card is the one panel whose head is a **grid**, not a flex row:
`minmax(0, 1fr) minmax(0, auto) minmax(0, 1fr)`, so the month sits centred on
the card rather than being pushed sideways by whatever controls sit beside it —
the stepper exists only on the Calendar page, so a flex row would move the month
between the two. The month is Orbitron at 15px (13px in the narrow fallback),
which is the intended exception to the rule above: it is a heading, and both
sizes clear the ~12px floor. It carries a two-layer glow — a tight filament and
a wide dim bloom — because one shadow alone reads as a blur rather than as neon.

That heading is bigger than what it replaced, which is exactly what landmine 6
warns about. Measured at the time: chips per day unchanged, no clipped cells,
no page scroll, contrast 16.3:1. Re-measure if it grows again. The absolute
counts have since risen — six on the dashboard, seven on the Calendar page —
because the cell type was tightened later; what this paragraph records is that
the heading cost nothing, not the number itself.

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
- `READY_HOLD_MS` is 400, down from 900. The old value was nine hundred
  milliseconds in which nothing moved but the words. Shortening the hold is not
  the same as shortening `MIN_VISIBLE_MS`, which is the rule above and stays.
- It must never run on the five-minute auto-refresh. `BOOTED` guards this.

### The handoff to the dashboard

The dashboard used to finish its entrance about 1.3 seconds *before* the boot
screen lifted, so the whole choreography played behind an opaque panel and the
handoff read as a cut between two still frames. Three pieces fix that and they
only work together:

- **`Boot.start({ onLeave })`** fires on the frame `.is-leaving` is added, so the
  dashboard's entrance is released against the same moment the overlay starts to
  fade. It is called *before* the class is added — after, and the two motions
  queue instead of overlapping.
- **`#app.is-booting` holds appearance with `opacity`, never `[hidden]`.** The
  month grid measures its own box (landmine 6), so the dashboard has to be laid
  out while the boot screen is still up; `display: none` has no layout and the
  measurement would be taken against nothing. Verified: with the class applied,
  `#mon-grid` still measures its full height and all 42 cells.
- **The entrance animations are `none` for that window.** Left on they run
  behind the panel and are finished before anyone sees them, which is the whole
  problem. Removing the class starts them, because an animation property going
  from `none` to a name begins the animation — confirmed by a `currentTime` of 0
  on release rather than a resumed clock.

`app.js` also clears the class in a `finally`, not only in `onLeave`: if
`finish()` ever threw, an invisible dashboard would be the worst failure
available.

The refresh is safe because `is-booting` is only applied when a boot object
exists, and `BOOTED` makes that null on every later load. Checked structurally
rather than by clock — same nodes, class never re-applied, no second boot —
because a non-compositing browser never advances `currentTime` and any
timing-based check there reads 0 and looks like a replay.

**`busCharge`** is the visual treatment: charge enters at the rail and travels
outward, each panel's rim igniting as it arrives — rail 40ms, calendar 200,
week 300, news 430. It uses `drop-shadow`, not `box-shadow`: the panels are
clipped to their chamfer and a box-shadow is discarded with everything else
outside the silhouette, whereas a filter is applied after the clip and follows
it. It was chosen over flashier candidates (a discharge flash, forked arcs, a
relay flicker) on two grounds — it is the only one where the dashboard reads as
*activating* rather than being uncovered, per the Motion section, and the only
one with no photosensitivity cost.

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
the dim inset frame. Both of `.card-in`'s pseudo-elements are therefore taken,
which is why the top seam is real markup — a `.card-seam` span at the top of
each `.card-in`, absolutely positioned so it costs no layout. It must not
become a flex item, or it steals a row of the card's height.

If the arms grow (`--bracket-arm`, `--bracket-w`) or the inset shrinks, re-check
that they do not cross any text. That is measurable: build the eight arm
rectangles per panel and test them against the bounding boxes of `.mon-what`,
`.wk-title`, `.note-title` and friends. Currently zero overlap with a
deliberately overfilled month.

Scrollbars are themed once, globally, for all six scrolling surfaces — the week
grid, This Week, Mail, the message reader, News and the chat log. A themed bar
beside a default one looks worse than either, which is why the rule is `*` and
not a selector list that a new panel would quietly fall outside of.

**The two scrollbar syntaxes are mutually exclusive, not complementary.** Chrome
treats any `scrollbar-width`/`scrollbar-color` on an element as opting that
scroller into standard rendering, which switches `::-webkit-scrollbar` off for
it — and `scrollbar-color` *inherits*, so a single declaration on `:root` kills
the pseudo-elements document-wide. That is not a hypothetical: the first version
of this shipped both, and every surface rendered a 15px Windows default with all
eight webkit rules parsed and ignored. The standard properties are therefore
fenced inside `@supports not selector(::-webkit-scrollbar)`, which is false in
Chrome and true in Firefox. Do not "add Firefox support" by hoisting them out.

Only gradients can carry the theme, and only the pseudo-elements do gradients,
so Chrome — what this actually runs on — must keep them. The thumb is square on
purpose: everything else here is chamfered, and a rounded pill would be the one
soft shape on screen. `.mail-open-text` overrides to 6px because it is a scroll
inside a panel inside a card, and a full-width bar there reads as a third frame.
Verify by measuring the gutter (`getBoundingClientRect().width - clientWidth`
minus borders), not by looking: 9 is ours, 15 is the default. Measure it on a
**visible** page — an element on a hidden page has no box and reports 0.

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

Ambient loops are on persistent elements for the same reason, so they run
continuously instead of restarting. The full set, all CSS-only:

- `shimmer` — the highlight crossing the progress bar
- `nowPulse` — the current-time line in the week view
- `seamGlint` — a glint travelling each card's top seam (`.card-seam`), 9s
  cycle, desynced per card
- `breathe` — the card icon tiles, staggered so the cards don't inhale in
  unison; this keyframe existed unused for months while this file claimed it
  ran, which is worth remembering when trusting docs over the stylesheet
- `statusBreathe` — the Feeds Online dot in the rail; only the `.ok` state
  breathes, an error should sit still and be looked at
- `brGlint` — one surface's corner brackets briefly brighten; co-prime cycles
  (11/13/17/19s) across the three cards and the rail so the combined pattern
  effectively never repeats

Every loop's 0% keyframe is its resting state, so even an unexpected restart
lands on rest rather than mid-glow. A fourth ambient candidate — a drifting
ground grid behind the panels — was mocked up and rejected by the user: it was
the only one that sat behind text being read. Do not add it unasked, and keep
new ambience off the panels' *contents* entirely.

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

Check both at 1920×1080 and at a smaller window. **No cell may name nothing** —
that is the invariant, and it is directly measurable:

```js
console.log('cells naming nothing:', [...document.querySelectorAll('.mon-events')]
  .filter(e => e.querySelectorAll('.mon-chip').length === 0).length);   // must be 0
```

It replaces an older rule that said a too-short cell must fall back to an
`"N events"` count. That fallback was the bug, not the safeguard: it fired
whenever capacity hit 1 and described the day without naming a single event.
Go small enough and it is reproducible — 1280×610 is roughly a 1080p screen at
150% Windows scaling, and it lands on capacity 1.

Capacity by window height, measured on the dashboard with the news panel at its
176px cap (a short feed inflates the calendar and flatters the numbers):

| viewport | cell height | events named | before this change |
|---|---|---|---|
| 1920×1000 | 110px | 6 | 3 |
| 1536×824 | 81px | 4 | 2 |
| 1440×700 | 60px | 2 | 0 — read `"N events"` |
| 1280×610 | 45px | 1 | 0 — read `"N events"` |

Run the page checks on **all four pages**, not just the dashboard: Calendar,
News and Mail each give a card the whole viewport, which is where an uncapped
panel starts pushing the page taller. Last measured at 1920×1000 — no page
scrolls, no clipped cells, seven events per day on the Calendar page against
six on the dashboard.

For the month grid specifically, `verify-visual.html` renders three pinned cell
heights (45/60/110px) and screenshots them. Capacity arithmetic is duplicated
there by hand, so `CHIP_H`/`NUM_RESERVE` changes have to be copied across or
the picture stops being of the thing that ships.

The frame invariants behind month and week stepping are pure date maths, so
assert them rather than clicking through: for every day of several years,
`startOfWeek(d)` and `endOfWeek(d)` must fall inside `monthGridStart(d)` and
`monthGridEnd(d)`, and `monthDays(d)` must be whole weeks starting on a Monday.

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
