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

What has not been verified:

- Deployment on Railway
- A real calendar day busy enough to stress the week view — only mocked; the
  user's own calendar still has no day like this
- The month grid's `ResizeObserver` re-fit. The capacity logic it calls is
  verified, but the callback itself could not be observed in the test browser,
  which does not composite frames. Worth one look in a real browser by dragging
  the window narrower and back.

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

## Design reference

The visual target was a light card-based dashboard mockup the user supplied:
white cards on a very light grey ground, blue primary, rounded corners, a
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
