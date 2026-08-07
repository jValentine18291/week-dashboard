# The Week — personal dashboard

A desktop dashboard showing your week at a glance: a Google Calendar month grid
with a week view a click away,
a This Week checklist merging tasks and events with a progress bar, and recent
Notion notes as coloured cards. Click anything to expand it.

Read-only by design — nothing here writes back to Notion or Google.

Working on this with Claude Code? `CLAUDE.md` loads automatically and holds the
project's constraints and pitfalls; `HANDOVER.md` has the background and the
reasoning behind them.

Phase 1. No news, no stocks — those come later, once you know you want them.

---

## What you need before starting

Three secrets. Collect them first, then everything else takes ten minutes.

### 1. Google Calendar feed

No OAuth needed — Google publishes a private read-only feed.

1. Open Google Calendar on desktop
2. Hover your calendar in the left sidebar → ⋮ → **Settings and sharing**
3. Scroll to **Integrate calendar**
4. Copy **Secret address in iCal format**

Treat this URL like a password. Anyone holding it can read your calendar. If it
ever leaks, click **Reset** on that page and the old URL dies.

### 2. Notion integration token

1. Go to notion.so/my-integrations → **New integration**
2. Name it "Week Dashboard", pick your workspace, choose **Internal**
3. Copy the **Internal Integration Secret**

### 3. Notion data source IDs

For your Tasks database and your Notes database:

1. Open the database as a full page
2. **⋯** → **Connections** → add your "Week Dashboard" integration
   (it can see nothing you don't share explicitly)
3. **⋯** → Database settings → **Manage data sources** → **⋯** → **Copy data source ID**

Note this is the *data source* ID, not the database ID. The Notion API changed
in version 2025-09-03 and this app uses the current endpoints.

---

## Expected Notion columns

**Tasks:** a title, a date column called `Due`, a status column called
`Status`, a tag column called `Area`, and optionally a `Priority` column
(High / Medium / Low) which drives the coloured pills.

**Notes:** a title. That's all — sorted by creation date.

If your columns are named differently, don't rename them. Set the
`NOTION_*_PROPERTY` variables in `.env` instead.

---

## Running it locally

```bash
npm install
cp .env.example .env
# open .env and fill in your values
npm start
```

Visit http://localhost:3000

---

## Deploying to Railway

1. Push this folder to a GitHub repo (`.env` is gitignored — check before pushing)
2. railway.com → **New Project** → **Deploy from GitHub repo**
3. Once created: **Variables** tab → add every line from your `.env`
4. **Settings** → **Networking** → **Generate Domain**

Railway detects Node and runs `npm start` automatically. No config file needed.

Set `NODE_ENV=production` in Railway variables so the login cookie is
marked secure.

---

## Notes on behaviour

- **Ask** in the sidebar opens an assistant drawer for general questions.
  It is deliberately **not** connected to your dashboard — it cannot see your
  calendar, tasks or notes, and nothing from them is ever sent. Conversations
  live in the browser only and are gone on reload. Leave `OPENAI_API_KEY` blank
  to switch the whole feature off.
- **The calendar opens on the month**, with a Month/Week toggle in its header.
  Your choice is remembered in the browser. The month grid runs Monday-first
  and greys the leading and trailing days of neighbouring months, which still
  show their events.
- **A day with more events than fit** shows the first few and then `+N more`.
  In a short window, where only one line fits, it shows a plain count instead.
  Click any event, in either view, for its details.
- **Multi-day events show on every day they cover.** Continuation days are
  marked with a `↳` so you can see where the event actually started. A holiday
  entered as 10–13 August covers the 10th, 11th and 12th — Google's end date is
  the morning you get back, not the last day away.
- **Tasks stay weekly** even while the calendar shows a month, so the
  This Week progress bar keeps measuring a week.
- **The week runs Monday to Sunday**, in the timezone set by `TIMEZONE`.
- **Data is cached for 60 seconds.** The Refresh button bypasses the cache.
- **The page refreshes itself every five minutes**, so a window left open on a
  second monitor stays current.
- **Panels fail independently.** A broken calendar feed shows an error in that
  panel while tasks and notes carry on.
- **Every row in This Week shows its date on the right**, in a single aligned
  column, with a second line qualifying it — a time for a timed event, "All
  day", "Due", or "Overdue". Tasks are square markers, events round.
- **Overdue tasks** show a red date, since the query pulls everything due on or
  before Sunday.
- **Completed tasks stay visible**, ticked and greyed, so the progress bar has
  something to measure.
- **Overlapping events split into columns** automatically, sized per cluster —
  a busy morning doesn't narrow a quiet afternoon.
- **The calendar grid opens at 8am** and expands automatically if you have
  anything earlier or later.

---

## Where phase 2 would go

The payload is assembled in `buildPayload()` in `server.js`. A news or stocks
panel is a new function in `lib/`, one more entry in the `Promise.allSettled`
array, and one more render function in `public/app.js`. The structure is
already there — don't restructure to add them.

The layout grid in `styles.css` reserves the space: `.layout` currently uses

```
"cal   week"
"notes week"
```

Market Watch slots between `cal` and `notes`; News goes under `week`.
