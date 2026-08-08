# Picking this up on another machine

Everything that matters about *the code* is already in the repo: `CLAUDE.md`
holds the rules, `HANDOVER.md` the reasoning behind them, `README.md` the
behaviour. Those clone with it and Claude Code loads `CLAUDE.md` automatically.

This file covers the part that is **not** in git: getting a bare machine to a
working checkout, and where the project currently stands.

`SETUP.txt` is a different document — it is the first-time build from a zip,
collecting every secret by hand. You do not need it. The repo and the Railway
project already exist, so the config comes from Railway rather than from you.

---

## Start here

Open Claude Code in an empty folder and give it this file, then:

> Read WORKSTATION.md and set this machine up for the week-dashboard project.

Everything below is written to be acted on in that order.

---

## What this is

A personal read-only dashboard — Google Calendar via a secret iCal feed, Notion
tasks, an RSS news panel, and a Gemini-backed chat drawer. Node + Express,
vanilla JS, **no build step**. Desktop only, sized for 1920×1080.

| | |
|---|---|
| Repo | `jValentine18291/week-dashboard` — public, branch `main` |
| Live | https://week-dashboard-production.up.railway.app |
| Host | Railway, project `week-dashboard`, workspace "John Val's Projects" |
| Deploys | Automatically on push to `main` |
| Timezone | `Asia/Singapore`, pinned in `server.js` before any `Date` use |

---

## 1. Tooling

Needed: **git**, **Node 20+**, **GitHub CLI**, **Railway CLI**.

Windows, in a terminal:

```
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
winget install --id GitHub.cli -e
```

macOS:

```
brew install git node gh
```

Then the Railway CLI, which comes from npm on both:

```
npm install -g @railway/cli
```

**Close and reopen the terminal afterwards.** A shell reads `PATH` once at
startup, so a freshly installed command will look "not found" in a window that
was already open. This wastes more time than it should.

### Windows only: two traps

**`.ps1` scripts are blocked by default.** `npm` and `railway` resolve to
`npm.ps1` and `railway.ps1`, which fail with `UnauthorizedAccess` under the
default `Restricted` execution policy. Either append `.cmd`:

```
npm.cmd install -g @railway/cli
railway.cmd login
```

or relax the policy for your own account once, which makes the plain names work
everywhere:

```
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

**Install CLIs yourself, not through the agent.** An `npm install -g` run from
Claude Code's shell may land somewhere your own terminal cannot see. MSI
installers via `winget` are fine either way. If the agent installs something
globally, check you can see it before building on it.

---

## 2. Sign in

Both of these open a browser and involve your credentials, so run them
yourself — the agent cannot and should not do them for you.

```
gh auth login
```

GitHub.com → HTTPS → yes to authenticating git → login with a web browser.

```
railway login
```

Note that being signed in on railway.app does **not** authenticate the CLI;
it keeps its own token. `railway whoami` confirms it.

---

## 3. Clone and configure

```
git clone https://github.com/jValentine18291/week-dashboard.git
cd week-dashboard
npm install
```

Set your commit identity if this machine has none:

```
git config --global user.name "John Val"
git config --global user.email "jvalentine18291@gmail.com"
```

**Do not type the secrets by hand.** They already exist in Railway and can be
pulled straight down:

```
railway link --project week-dashboard
railway variables
```

Write those into a local `.env`, dropping the `RAILWAY_*` entries — those are
injected by the platform and mean nothing locally — and set `NODE_ENV=development`
and `PORT=8080` instead. `.env` is gitignored; keep it that way.

The keys the app actually reads:

```
DASHBOARD_PASSWORD   COOKIE_SECRET        TIMEZONE
GOOGLE_CALENDAR_ICS_URL
NOTION_TOKEN         NOTION_TASKS_DATA_SOURCE_ID   NOTION_NOTES_DATA_SOURCE_ID
OPENAI_API_KEY       OPENAI_BASE_URL      OPENAI_MODEL
NEWS_FEEDS (optional)
```

Then:

```
npm start
```

`http://localhost:8080`. The startup log must say the timezone — if it reports
UTC, every date calculation in `lib/week.js` is wrong and nothing else matters.

---

## 4. Confirm a deploy actually landed

`/healthz` reports the short commit SHA it was built from:

```
curl https://week-dashboard-production.up.railway.app/healthz
```

Compare it against `git log -1`. This endpoint exists because a stale container
is otherwise indistinguishable from a working one — several commits have
appeared to deploy and did not, with clean logs and an Online service.

**Railway's Redeploy button re-runs the previous build.** It does not fetch
newer commits. Push to `main` instead.

---

## 5. Where it stands

Last commit **`edbefa5`** — "Overlap the boot handoff, and energize the panels
as it lifts". Deployed and live; local, GitHub and production all agree.

Recent work, newest first:

- Boot screen now hands off to the dashboard properly — the panels rise
  *through* the departing overlay while a cyan charge runs outward from the
  rail, instead of finishing 1.3s behind an opaque panel
- The month sits centred and glowing on the calendar card
- The rail became real navigation: Dashboard, Ask, Calendar, News, with
  full-screen Calendar and News pages and month/week stepping
- The animated emblem was re-ported from a second design handoff

**Nothing visual has ever been checked by eye.** All of it was verified
numerically and structurally — every animated attribute diffed against the
handoff, month-grid invariants asserted across four years, no page scroll and
no clipped cells at 1920×1080. But the browser available to the agent does not
composite frames, so no screenshot was ever taken. If something looks wrong,
that is where it will be, and it is not a surprise.

Open, in rough priority order:

- **Look at it.** Especially the boot handoff, which is brand new.
- The month grid's `ResizeObserver` re-fit — its logic is tested, the callback
  itself has never been observed running
- **Market Watch** — phase 2, scoped and deliberately unbuilt. Research is in
  `HANDOVER.md`; do not start it unasked
- A shared-element emblem hand-off for the boot transition, deferred: it needs
  `Emblem.create` to gain a seek option first, or the arriving emblem jumps

---

## 6. Things the agent should know

Not obvious from the code, and each cost real time to learn.

- **Read `CLAUDE.md` before changing behaviour.** Several apparent gaps are
  deliberate cuts — no write access, no search bar, no Tasks nav entry. It also
  lists ten landmines that have each cost a debugging session.
- **A bigger card header costs a chip line per day.** The month grid measures
  its own box; re-measure after any header change and confirm clipped cells is
  still zero.
- **Verify against the source, not against expectation.** Recurring events once
  rendered at 11:00 and were signed off as proof the timezone handling worked.
  The feed said 19:00. Consistency is not correctness.
- **A non-compositing browser reports animation `currentTime` as 0 forever.**
  Any timing-based check there reads as "restarted" and means nothing. Verify
  structurally instead — node identity, class state, computed values.
- **PowerShell specifics:** git writes progress to stderr and PowerShell renders
  it as a red error even on success; `Get-Content -Raw` defaults to ANSI and
  mangles UTF-8, so use `[System.IO.File]::ReadAllText(path, UTF8)` when
  comparing files; here-strings break on embedded quotes, so pass commit
  messages with `git commit -F <file>`.
