'use strict';

require('dotenv').config();

// Pin the timezone before anything touches Date, so "this week" means
// this week where you are, not where the server happens to run.
process.env.TZ = process.env.TIMEZONE || 'Asia/Singapore';

const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');

const { fetchCalendarEvents } = require('./lib/calendar');
const { fetchTasks, fetchNotes } = require('./lib/notion');
const week = require('./lib/week');

const app = express();
const PORT = process.env.PORT || 3000;

const COOKIE_SECRET = process.env.COOKIE_SECRET || 'change-me-in-env';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const notionConfig = {
  token: process.env.NOTION_TOKEN,
  tasksDataSourceId: process.env.NOTION_TASKS_DATA_SOURCE_ID,
  notesDataSourceId: process.env.NOTION_NOTES_DATA_SOURCE_ID,
  dueProperty: process.env.NOTION_DUE_PROPERTY || 'Due',
  statusProperty: process.env.NOTION_STATUS_PROPERTY || 'Status',
  areaProperty: process.env.NOTION_AREA_PROPERTY || 'Area',
  priorityProperty: process.env.NOTION_PRIORITY_PROPERTY || 'Priority',
  doneValues: (process.env.NOTION_DONE_VALUES || 'Done,Complete,Completed')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

app.use(cookieParser(COOKIE_SECRET));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// --- auth -------------------------------------------------------------

// Loopback only. Deliberately does not consult X-Forwarded-For: that header is
// caller-supplied, so trusting it would let anyone claim to be local.
function isLoopback(req) {
  const ip = (req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1';
}

// A missing password means "open" — a convenience on localhost and a data leak
// on a public URL. Anything not arriving over loopback is refused rather than
// waved through: the failure mode of an unset variable must not be "serve
// everything to everyone". Fails closed on purpose.
//
// The check is NOT keyed on NODE_ENV alone. The first Railway deploy had
// neither DASHBOARD_PASSWORD nor NODE_ENV set, so a production-only guard would
// itself have been disabled by the same missing configuration it exists to
// catch. Where the request came from cannot be left unset.
function requireAuth(req, res, next) {
  if (!DASHBOARD_PASSWORD) {
    if (IS_PRODUCTION || !isLoopback(req)) {
      return res.status(503).json({
        error: 'DASHBOARD_PASSWORD is not set. Refusing to serve data unprotected.',
      });
    }
    return next(); // local dev only
  }
  if (req.signedCookies && req.signedCookies.session === 'ok') return next();
  return res.status(401).json({ error: 'unauthorised' });
}

app.post('/api/login', (req, res) => {
  const supplied = (req.body && req.body.password) || '';
  if (!DASHBOARD_PASSWORD || supplied !== DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: 'Wrong password.' });
  }
  res.cookie('session', 'ok', {
    signed: true,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 30,
  });
  res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
  // Mirrors requireAuth: open only for a loopback caller with no password set.
  const unprotected = !DASHBOARD_PASSWORD;
  const open = unprotected && !IS_PRODUCTION && isLoopback(req);
  const misconfigured = unprotected && !open;
  const signedIn = open || req.signedCookies?.session === 'ok';
  res.json({ signedIn, open, misconfigured });
});

// --- dashboard --------------------------------------------------------

let cache = { at: 0, payload: null };
const CACHE_MS = 60 * 1000;

async function buildPayload() {
  const now = new Date();
  const start = week.startOfWeek(now);
  const end = week.endOfWeek(now);

  // The month grid is drawn in whole weeks, so it reaches wider than the month
  // itself and always contains the current week. Fetching that wider window
  // once lets the client switch between month and week views without another
  // round trip; the week view just filters the same array down.
  const gridStart = week.monthGridStart(now);
  const gridEnd = week.monthGridEnd(now);

  // Tasks stay on the week deliberately: the "This Week" panel and its progress
  // bar measure the current week, not the month the calendar happens to show.
  // Each source is settled independently: a broken calendar feed should not
  // take the tasks panel down with it.
  const [events, tasks, notes] = await Promise.allSettled([
    fetchCalendarEvents(process.env.GOOGLE_CALENDAR_ICS_URL, gridStart, gridEnd),
    fetchTasks(notionConfig, week.toLocalISODate(end)),
    fetchNotes(notionConfig),
  ]);

  const unwrap = (r, label) => {
    if (r.status === 'fulfilled') return { data: r.value, error: null };
    console.error(`${label} failed:`, r.reason?.message || r.reason);
    return { data: [], error: r.reason?.message || 'Could not load' };
  };

  return {
    generatedAt: now.toISOString(),
    timezone: process.env.TZ,
    week: {
      start: start.toISOString(),
      end: end.toISOString(),
      days: week.weekDays(now).map((d) => d.toISOString()),
      today: week.startOfDay(now).toISOString(),
    },
    month: {
      start: week.startOfMonth(now).toISOString(),
      end: week.endOfMonth(now).toISOString(),
      gridStart: gridStart.toISOString(),
      gridEnd: gridEnd.toISOString(),
      days: week.monthDays(now).map((d) => d.toISOString()),
    },
    calendar: unwrap(events, 'Calendar'),
    tasks: unwrap(tasks, 'Tasks'),
    notes: unwrap(notes, 'Notes'),
  };
}

app.get('/api/dashboard', requireAuth, async (req, res) => {
  const fresh = req.query.refresh === '1';
  if (!fresh && cache.payload && Date.now() - cache.at < CACHE_MS) {
    return res.json(cache.payload);
  }
  try {
    const payload = await buildPayload();
    cache = { at: Date.now(), payload };
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not build the dashboard.' });
  }
});

// Reports the commit it was built from. "Is the new code actually live?" was
// otherwise only answerable by grepping served assets, and a host's Redeploy
// button may re-run the previous build rather than fetch the latest commit.
// A short SHA of a private repo discloses nothing useful on its own.
app.get('/healthz', (req, res) => {
  const sha = (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || '').slice(0, 7);
  res.type('text/plain').send(sha ? `ok ${sha}` : 'ok');
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Dashboard running on port ${PORT} (timezone ${process.env.TZ})`);
  if (!DASHBOARD_PASSWORD) {
    console[IS_PRODUCTION ? 'error' : 'warn'](
      IS_PRODUCTION
        ? 'REFUSING TO SERVE DATA: DASHBOARD_PASSWORD is not set. Set it in the ' +
          'host\'s environment variables, then redeploy.'
        : 'No DASHBOARD_PASSWORD set — running open. Local development only.'
    );
  }
});
