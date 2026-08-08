# Handover

Background context for whoever picks this up. `CLAUDE.md` holds the rules;
this file holds the reasoning behind them, so they can be revisited properly
rather than accidentally.

## Where the project stands

Phase 1 is **running against real credentials on both integrations** — a live
Google Calendar iCal feed and two live Notion databases (August 2026, local
machine, Windows). Railway deployment is the remaining milestone.

The Notion databases were created from scratch during that session, using the
default column names, so the long-anticipated column-name mismatch never
arose. That configurability is still worth keeping: it is what makes the app
survive the user renaming a column later.

The calendar was changed to open on a **month** grid in that same session —
see "The move to a month view" below.

What has been verified:

- Monday-start week boundaries, including the Sunday-night edge case
- iCal parsing: timed, all-day, recurring, EXDATE-skipped, and out-of-range events
- Recurring events landing at the correct local time (see landmine 1 in CLAUDE.md)
- Overlap column assignment across five layout scenarios
- Password gate: 401 unauthenticated, cookie issued on success
- Panels degrading independently when a source fails
- Filter tabs, expand/collapse, progress bar, against mock data in a real browser
- A clean unzip, `npm install` and server start from the distributed archive
- **A real iCal feed**, fetched and parsed over a full month grid (24 events),
  with every timed event checked line-by-line against the raw `.ics` text
  rather than against expectation. This is the check that matters; see the
  cautionary tale below.
- **Month grid boundaries** across month-start, month-end, and a month that
  begins on a Monday (Feb 2027 → exactly four rows, no padding weeks)
- **The overlap algorithm against a genuinely busy day** — six events, four
  overlapping, rendered as four 25% columns in the morning while the two
  afternoon events kept full width. Mock data, not real.
- **The one-screen layout** at 1920×950, 1600×860 and 1366×700: the page never
  scrolls and no month cell clips its chips
- **Multi-day events**, in both views — a three-day all-day event draws on all
  three days and stops before the exclusive end date; a timed event crossing
  midnight draws on both days; one ending exactly at midnight stays on its own
  day and fills the evening rather than collapsing to a sliver

- **Real Notion responses**, both databases, through the app's own
  `fetchTasks`/`fetchNotes`. The predicted column-name mismatch did not happen:
  the databases were created fresh using the default names, so no
  `NOTION_*_PROPERTY` override was needed. `Due` is a real `date` property,
  which is the only one that could have 400'd the request. The `Status` column
  uses Notion's built-in options, and `Done` matches `NOTION_DONE_VALUES`
  as shipped.

- **Railway deployment**, at `week-dashboard-production.up.railway.app`. All
  eight variables set, running on port 8080 with the timezone pinned to
  Asia/Singapore (confirmed in the startup log — the server would otherwise
  default to UTC, which is the one environmental difference that could break
  every date calculation in `lib/week.js`). Verified after deploy:
  `/api/session` reports `open:false`, `/api/dashboard` returns 401 without a
  session, and a wrong password is rejected.

## Deploying, and how to tell whether it worked

`/healthz` reports the short commit SHA it was built from. That is the check:

```bash
curl https://week-dashboard-production.up.railway.app/healthz   # -> "ok 87b523d"
```

It exists because a stale container is otherwise indistinguishable from a
working one. Several commits appeared to deploy and did not: the logs were
clean, the service showed Online, and the site simply served old files.

Two traps, both encountered:

- **Railway's Redeploy re-runs the previous build.** It does not fetch newer
  commits. To pick up new code the service must create a *new* deployment.
- **The GitHub connection can silently fail.** Railway reads private repos
  through its GitHub App; if that app has no access to this repository,
  Settings → Source shows "GitHub Repo not found", no branch is watched, and
  every push is ignored. Fixed by granting the Railway GitHub App access at
  github.com/settings/installations. Auto-deploy on push works now.

Adding or changing environment variables does not restart the service either.

What has not been verified:

- The rendered dashboard on the deployed instance. It runs the same commit whose
  output was checked line-by-line against the raw `.ics` locally, but that is an
  inference, not an observation: the data sits behind the password gate.
- A real calendar day busy enough to stress the week view — only mocked; the
  user's own calendar still has no day like this
- The month grid's `ResizeObserver` re-fit. The capacity logic it calls is
  verified, but the callback itself could not be observed in the test browser,
  which does not composite frames. Worth one look in a real browser by dragging
  the window narrower and back.
- **How the three pages look.** Their behaviour was driven end to end in a real
  browser — nav state, card moves, month and week stepping, the news reader and
  its grouping — and measured: no page scrolls, no clipped cells, six chips per
  day on the Calendar page. But the test browser composites no frames, so
  nothing was ever seen. The same gap applies to the second emblem port.

## How the shape of this was decided

The user worked through several framings before settling. Worth knowing,
because suggesting one of the rejected ones again would be going backwards.

**A phone app was the original idea.** Dropped once it became clear the value
was a glanceable surface, which a phone app doesn't provide well. The user
does not want to view this on a phone at all.

**A native desktop app (Electron/Tauri) was considered.** Rejected because a
browser tab delivers the same thing; native would only buy a dock icon,
offline access and native notifications, none of which were wanted.

**Write access was considered and explicitly declined.** The reference mockup
showed working checkboxes and a quick-note box. The user chose to keep those
inputs on his phone rather than expand the integration's permissions. This was
a deliberate call, not an oversight.

**A weekly retrospective review screen was scoped and then superseded.** The
user later asked for a Monday-morning look-ahead instead. Neither is built yet;
a Monday briefing is being handled outside this app.

**News and stocks were deliberately deferred.** The user's instinct was to
build all six panels at once. The agreed sequence was to ship the three panels
that use his own data first, live with it for a couple of weeks, then decide
whether the commodity panels earn their place.

## The timezone bug that survived a "verification"

Worth reading before trusting any timing check in this project.

On the first live run, the recurring classes rendered at 11:00. They were
reported as *proof the timezone handling worked*, on the reasoning that an
uncorrected feed would have shown 19:00. The feed actually said 19:00 — the
classes are in the evening. 11:00 was the bug, and the reasoning had the
direction exactly backwards.

Two things let it through:

- **Consistency was mistaken for correctness.** Five occurrences all landing on
  the same wall-clock time proves the recurrence expanded evenly. It says
  nothing about whether that time is right.
- **Nothing was compared against the source.** The raw `.ics` states the answer
  outright. It was never read until the user noticed the times were wrong.

The fix is `occurrenceReader()` (landmine 1) and `verify-calendar.js`. The
lesson is narrower than "test more": when checking times, diff against the raw
feed, and treat plausible-looking output as unverified.

## The Productivity OS redesign

The user supplied a HUD dashboard reference image, an animated emblem, and an
animated loading screen, with a long brief asking the app to look and behave as
though it belonged to the same fictional operating system. A mockup was
approved before any code changed.

What was built: chamfered HUD panel geometry, the handoff palette and type
system, the rail, the animated emblem, the boot sequence, and the motion
system. Everything real still works — the same read-only calendar and Notion
integrations, the same month/week views, the same one-screen layout.

What the brief asked for that was **not** built, and why:

- **Search field, notification bell, avatar** — hard constraints above. Cut on
  purpose, twice now.
- **Quick Add, quick-note box, tickable checkboxes, event create/edit/drag,
  note create/delete** — the app has no write credentials. The calendar is a
  read-only iCal URL and the Notion token is read-only. This is not a styling
  gap; the credentials cannot do it.
- **Market Watch, Global Events & News** — phase 2, at the user's direction.
  They appear in the boot screen as STANDBY modules so the composition is
  honest about what exists.
- **Routing, page transitions, modals, settings, profile, database** — none of
  these existed in a single-page read-only dashboard. Partly superseded: the
  user asked for a rail nav in August 2026 and there are now three pages. It is
  still not routing in the framework sense — no URLs, no history, no library.
  Settings, profile and a database remain absent and unwanted.
- **React component architecture** (`HudPanel`, `SciFiSidebar`, …) — no build
  step. The same primitives exist as CSS classes.
- **three.js cube** on the boot screen — replaced with the supplied emblem,
  which is the same shape and adds no dependency.

Both handoffs shipped as React. Both were ported to vanilla JS rather than
adding a framework. The emblem port is checked against the original
numerically rather than by eye — every animated attribute is recomputed from a
transcription of the JSX and diffed against the port driven through the same
rAF step. Currently 187 derived values across 33 points of the 15s timeline in
both modes, zero divergence.

A second emblem handoff arrived later and was ported the same way. It is the
same timeline, geometry and palette with seven additions: ignition spokes, a
comet head on the frame draw, orbiting glints, a core impact flare and ripple,
a radial spark burst on the pulse, a second cube highlight, and a spark on
power-down. Sample times for the diff deliberately avoid exact cue boundaries —
`gate()` is a step function and the clock lands within ~1e-13 of the requested
time, which flips a gate at an edge and reports a mismatch that is not one.

## The move to a month view

Asked for on first sight of the working dashboard, alongside "fit everything on
one screen without scrolling". Both were confirmed with the user before being
built, because between them they retire two earlier decisions.

Three things were settled at the time:

- **The week view was kept, not replaced.** A Month/Week toggle sits in the
  calendar header, defaulting to Month. The alternative was deleting the time
  grid outright, which would also have deleted `assignColumns()` — still the
  only part of this project that handles a busy day properly, and still the
  part with the least real-world exposure. Keeping it cost a few lines.
- **Tasks and notes stayed weekly.** Making them monthly would have stretched
  the list past the height available and changed what the progress bar means:
  a month you are ten days into always looks like failure.
- **"This Week" still scrolls internally.** The earlier decision to give it its
  own scrollbar holds — a full week of merged tasks and events can always
  outrun the column. What changed is that it now scrolls *inside the card* so
  the page cannot, rather than being capped at a fixed pixel height.

The layout was sized against 1920×1080, which is what the user runs. It degrades
by fitting fewer event chips per day cell, not by scrolling.

## The rail nav, and the constraint it retired

Asked for in August 2026: a sidebar listing the app's sections, more
comprehensive than the panels on the dashboard. The user named the list himself
— Dashboard, Ask, Calendar, News — and was explicit that **Tasks must not be on
it**, because This Week is meant to be a brief summary on the dashboard rather
than a place you go.

This directly retired a hard constraint. The rail had been kept to working
controls only, and the mockup's ten-item nav was cut twice on the grounds that a
link to a page which does not exist reads as a bug. That reasoning still stands;
what changed is that the destinations were built. The rule in `CLAUDE.md` is now
"entries that go somewhere real" rather than "no nav", which is the same rule
stated honestly.

Four things were settled while building it:

- **Full-screen pages, not expanded panels.** The alternative was growing the
  clicked panel inside the dashboard grid, which is less work but leaves each
  view bounded by a layout designed for three panels at once. The point of the
  section is the extra room: on its own page the month grid fits six events per
  day against five on the dashboard.
- **Ask stayed a drawer.** It is an action, not a destination, and the overlay
  was a deliberate decision — a fourth column would squeeze the calendar and
  break the one-screen rule. It sits second in the rail because the user listed
  it second.
- **The dashboard's calendar never moves off the real month.** Month stepping
  belongs to the Calendar page alone. A dashboard showing March beside a "This
  Week" progress bar measuring this week would be quietly wrong, and This Week
  is the panel most likely to be believed without checking.
- **News kept its interleaving.** `lib/news.js` merges the feeds newest-first so
  a prolific source cannot crowd out a quieter one. Grouping by source was
  wanted too, so it is a toggle beside `Latest` rather than a replacement — the
  original ordering is still the default.

Month navigation is the one part that needed the server: the payload is anchored
to today, so `/api/calendar?anchor=YYYY-MM-DD` returns the same frame shape for
any date. Anchors are validated as real dates within a decade — `2026-02-31` is
rejected rather than rolled into March — and the month-grid cache is bounded,
because a window left open stepping through months would otherwise grow it
without limit.

## The boot handoff

The user asked for a smoother transition between the loading screen and the
dashboard. The diagnosis was not what the request sounded like: there was
already a fade. The problem was ordering. `$('app').hidden = false` ran as soon
as the payload landed, so the entrance choreography — rail, topbar, three cards
— completed in under a second, while the overlay stayed up for another 1.3.
What reached the eye was a cross-fade between two finished still frames.

Nine treatments were mocked up interactively before anything was built, all on
one clock so they could be compared on look rather than length. That mock-up
earned its keep twice over: the first version of the hex-iris option did
nothing at all, because a `clip-path` hole needs the inner shape wound opposite
to the outer one and both were traced clockwise, giving the enclosed area a
winding number of 2 under the nonzero rule. It had been published without
checking the geometry actually did what it claimed. The lesson generalises past
mock-ups: verifying that code *runs* is not verifying that it *does the thing*.

**Bus energize won**, over a discharge flash, forked arcs and a relay flicker.
Two reasons, both in the docs already: it is the only candidate where the
dashboard reads as *activating* rather than being uncovered, which is what the
Motion section asks for; and it is the only one with no photosensitivity cost.
The flicker was built and shown precisely so it could be rejected on the
evidence — it is the one a viewer could reasonably read as a bug.

`READY_HOLD_MS` came down from 900 to 400 in the same change. Note the asymmetry
with `MIN_VISIBLE_MS`, which is protected by a rule against raising it for
spectacle: shortening a stall where nothing moves is the same instinct, not the
opposite of it.

What was **not** taken, and why:

- **A shared-element emblem hand-off** — the badge flying from the boot screen
  into the rail. The strongest continuity available and the one that most
  pushes against "activating, not flying in". It also needs real work first:
  both emblems loop the 15-second choreography independently, so the arriving
  instance would visibly jump unless `Emblem.create` gains a seek option.
- **Anything that flashes.** Capping below white and holding under three
  flashes a second makes a flash defensible, not free.

## Design reference

**Superseded.** The original target was a light card-based mockup: white cards
on very light grey, blue primary. The user later supplied a dark neon "HUD"
mockup and asked for the theme to match, so the palette is now a near-black
ground with cyan and blue accents, glowing card rims and uppercase tracked
headings. Structure, spacing and layout are unchanged — only colour, glow and
type treatment moved.

That second mockup also contained a search field, a notification bell, an
avatar, a quick-add button, a "take a quick note" box, apparently-tickable
checkboxes, and Market Watch and News panels. **None of those were built.** The
chrome is a hard constraint; the write affordances are what the read-only rule
names verbatim; the two panels are phase 2. A mockup is not a decision to
reverse any of them.

**The rail was built, and was the exception.** No written constraint covered a
sidebar — that one was a judgement call, so it went back to the user rather
than being refused on the docs' authority. It ships holding only controls that
do something: Month, Week, Refresh, Log out. The mockup's ten nav items pointed
at pages that do not exist, and two of them (Goals, Files) are not features in
any phase. `POST /api/logout` was added to make Log out real; it clears the
session cookie and touches neither Notion nor Google.

The description below is the original light reference, kept because the layout
still derives from it:

White cards on a very light grey ground, blue primary, rounded corners, a
Google Calendar week grid with colour-coded blocks, a "This Week" checklist
with a progress bar and priority pills, and coloured sticky-note cards.

The current build matches it closely, minus the deliberately cut chrome. Two
deviations worth knowing:

- **Completed tasks stay visible**, ticked and greyed. They have to — the
  progress bar has nothing to measure otherwise. The earlier version filtered
  them out and `lib/notion.js` was changed to return them.
- **The "This Week" list scrolls internally.** A full week of merged tasks and
  events made the card run far past the bottom of the left column.
- **The calendar is now a month grid by default**, not the week grid the mockup
  showed. The week grid is still there behind the toggle and still matches the
  reference. See "The move to a month view" above.

The right column no longer ends above the left — the one-screen layout stretches
the tasks card down the full height. The space reserved for Market Watch and
News in phase 2 is now the gap under the calendar, next to Notes.

## Known rough edges

- Notes show title, tags and date only. Showing note *content* like the mockup
  would need one API call per note — an N+1 pattern that was judged not worth
  it for phase 1.
- Clicking a calendar block opens a browser `alert()`. It works but is ugly;
  a small popover would be the natural improvement.
- Heavily overlapping events become narrow and truncate. Inherent to the
  format, but a day with six concurrent meetings will look poor.
- The 60-second server cache and the 5-minute client refresh are independent.
  A manual Refresh bypasses the cache; the auto-refresh does too.

## The user

Runs a commercial outdoor power equipment distributor in Singapore. Comfortable
with technical concepts and has built tooling before, but is not a daily
developer — he will be running commands in Terminal rather than reading
stack traces. Prefers required actions listed explicitly in point form.
Working timezone is Asia/Singapore throughout.
