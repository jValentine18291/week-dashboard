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
const { streamChat, DEFAULT_BASE_URL } = require('./lib/chat');
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

// The chat relay is a separate concern from the dashboard: it is never given
// calendar, task or note data. See lib/chat.js.
const chatBaseUrl = process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL;

const chatConfig = {
  apiKey: process.env.OPENAI_API_KEY,
  baseUrl: chatBaseUrl,
  // Pointing at Gemini and leaving the model unset would otherwise send an
  // OpenAI model name to Google and fail with an unhelpful error.
  model: process.env.OPENAI_MODEL ||
    (/googleapis\.com/.test(chatBaseUrl) ? 'gemini-3.1-flash-lite' : 'gpt-4o-mini'),
  maxTokens: Number(process.env.OPENAI_MAX_TOKENS || 800),
  systemPrompt: process.env.OPENAI_SYSTEM_PROMPT ||
    'You are a concise assistant embedded in a personal dashboard. ' +
    'You have no access to the user\'s calendar, tasks or notes — if asked ' +
    'about them, say so plainly. Answer general questions directly.',
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

// Session teardown only — this clears a cookie, it does not write to Notion or
// Google. The read-only constraint is about the data sources, not the gate.
app.post('/api/logout', (req, res) => {
  res.clearCookie('session', {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PRODUCTION,
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
// --- chat ---------------------------------------------------------------

// Single-user app, so one global window is enough. This exists because the
// dashboard is internet-facing behind one password: anyone who gets through
// the gate would otherwise have an unmetered relay on the owner's bill.
const CHAT_WINDOW_MS = 10 * 60 * 1000;
const CHAT_MAX = 30;
let chatHits = [];

function chatAllowed() {
  const now = Date.now();
  chatHits = chatHits.filter((t) => now - t < CHAT_WINDOW_MS);
  if (chatHits.length >= CHAT_MAX) return false;
  chatHits.push(now);
  return true;
}

// Maps an upstream status to something the user can act on. The full error is
// in the server log; this is what reaches the browser.
function describeChatFailure(err) {
  const s = err && err.status;
  if (s === 400) return 'The provider rejected the request (400). The model name is the usual cause.';
  if (s === 401 || s === 403) {
    return `The provider rejected the API key (${s}). Check the key is correct and, ` +
      'if it has IP or referrer restrictions, that this server is allowed.';
  }
  if (s === 404) return 'The provider had no such model or endpoint (404). Check OPENAI_MODEL and OPENAI_BASE_URL.';
  if (s === 429) return 'Rate limited or out of quota at the provider (429). Wait, or check your plan limits.';
  if (s >= 500) return `The provider is having trouble (${s}). Try again shortly.`;
  if (s) return `The provider returned ${s}.`;
  return 'Could not reach the provider — the network call itself failed.';
}

app.post('/api/chat', requireAuth, async (req, res) => {
  if (!chatConfig.apiKey) {
    return res.status(503).json({ error: 'Chat is not configured. Set OPENAI_API_KEY and redeploy.' });
  }
  if (!chatAllowed()) {
    return res.status(429).json({ error: 'Too many messages. Try again in a few minutes.' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    await streamChat(chatConfig, req.body && req.body.messages, (delta) => send({ delta }));
    send({ done: true });
  } catch (err) {
    console.error('Chat failed:', err.message);
    // Never relay the upstream body — it can echo request material. Relaying
    // the status alone is safe and turns an opaque failure into an actionable
    // one, which "could not be reached" was not.
    send({ error: describeChatFailure(err) });
  }
  res.end();
});

app.get('/healthz', (req, res) => {
  const sha = (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || '').slice(0, 7);

  // Which subsystems the container actually has configuration for. Booleans
  // and a public hostname only — never a key, never a URL with a secret in it.
  // "Is the variable live?" was otherwise unanswerable from outside, and a
  // container with stale env looks identical to a correct one.
  const host = (() => {
    try { return new URL(chatConfig.baseUrl).host; } catch (e) { return 'invalid'; }
  })();
  const parts = [
    sha ? `ok ${sha}` : 'ok',
    `calendar=${process.env.GOOGLE_CALENDAR_ICS_URL ? 'set' : 'unset'}`,
    `notion=${process.env.NOTION_TOKEN ? 'set' : 'unset'}`,
    `chat=${chatConfig.apiKey ? 'set' : 'unset'}`,
    `chat_host=${chatConfig.apiKey ? host : '-'}`,
    `chat_model=${chatConfig.apiKey ? chatConfig.model : '-'}`,
  ];
  res.type('text/plain').send(parts.join(' '));
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
