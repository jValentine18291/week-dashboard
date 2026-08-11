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
const { fetchNews } = require('./lib/news');
const { fetchMail, fetchBody } = require('./lib/gmail');
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
// Comma-separated RSS URLs. Blank falls back to the shipped pair (Singapore
// and world) — see lib/news.js.
const newsFeeds = (process.env.NEWS_FEEDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Gmail, read-only and metadata-only. Blank refresh token disables the panel
// entirely; the rest of the dashboard is unaffected.
const MAIL_LIMIT = Number(process.env.GMAIL_LIMIT || 8);
const gmailConfig = {
  clientId: process.env.GMAIL_CLIENT_ID,
  clientSecret: process.env.GMAIL_CLIENT_SECRET,
  refreshToken: process.env.GMAIL_REFRESH_TOKEN,
};

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

// The dashboard card shows the newest few; the News page shows the lot. One
// fetch serves both, for the same reason the calendar fetches the whole month
// grid — switching pages must not cost a round trip.
const NEWS_LIMIT = 24;

// Events keyed by the month grid they were fetched for, so navigating back to
// a month already seen is free. Separate from the payload cache above: that one
// is anchored to today and would be useless for any other month.
const calCache = new Map();
const CAL_CACHE_MAX = 24;

function monthKeyOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Throws on failure rather than caching it, so a transient feed error does not
// stick for a minute. Callers settle it.
async function monthCalendar(anchor) {
  const key = monthKeyOf(anchor);
  const hit = calCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const data = await fetchCalendarEvents(
    process.env.GOOGLE_CALENDAR_ICS_URL,
    week.monthGridStart(anchor),
    week.monthGridEnd(anchor)
  );

  calCache.set(key, { at: Date.now(), data });
  // A window left open stepping through months would otherwise grow this
  // without limit. Evict the least recently fetched.
  if (calCache.size > CAL_CACHE_MAX) {
    let oldestKey = null, oldestAt = Infinity;
    for (const [k, v] of calCache) if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k; }
    calCache.delete(oldestKey);
  }
  return data;
}

// YYYY-MM-DD only, and a real date — "2026-02-31" is rejected rather than
// rolling into March. Bounded to a decade either side: the range exists to keep
// a malformed or hostile anchor from driving recurrence expansion somewhere
// absurd, not because a further month would be wrong.
const ANCHOR_LIMIT_MS = 10 * 365 * 24 * 60 * 60 * 1000;

function parseAnchor(raw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw || ''));
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  if (Math.abs(date.getTime() - Date.now()) > ANCHOR_LIMIT_MS) return null;
  return date;
}

// The month grid and week that a given anchor date falls in. Shared by the
// dashboard payload and /api/calendar so both describe a date the same way.
function framesFor(anchor) {
  const now = new Date();
  return {
    week: {
      start: week.startOfWeek(anchor).toISOString(),
      end: week.endOfWeek(anchor).toISOString(),
      days: week.weekDays(anchor).map((d) => d.toISOString()),
      // Always the real today, whatever month is being looked at — it is what
      // the "today" highlight and the overdue check key on.
      today: week.startOfDay(now).toISOString(),
    },
    month: {
      start: week.startOfMonth(anchor).toISOString(),
      end: week.endOfMonth(anchor).toISOString(),
      gridStart: week.monthGridStart(anchor).toISOString(),
      gridEnd: week.monthGridEnd(anchor).toISOString(),
      days: week.monthDays(anchor).map((d) => d.toISOString()),
    },
  };
}

async function buildPayload() {
  const now = new Date();
  const frames = framesFor(now);

  // The month grid is drawn in whole weeks, so it reaches wider than the month
  // itself and always contains the current week. Fetching that wider window
  // once lets the client switch between month and week views without another
  // round trip; the week view just filters the same array down.
  //
  // Tasks stay on the week deliberately: the "This Week" panel and its progress
  // bar measure the current week, not the month the calendar happens to show.
  // Each source is settled independently: a broken calendar feed should not
  // take the tasks panel down with it.
  // Notes is deliberately absent: the panel was replaced by News at the user's
  // request, so fetching it would be a Notion call nobody reads. lib/notion.js
  // still exports fetchNotes — see CLAUDE.md for how to bring the panel back.
  const [events, tasks, news, mail] = await Promise.allSettled([
    monthCalendar(now),
    fetchTasks(notionConfig, week.toLocalISODate(week.endOfWeek(now))),
    fetchNews(newsFeeds, NEWS_LIMIT),
    fetchMail(gmailConfig, MAIL_LIMIT),
  ]);

  const unwrap = (r, label) => {
    if (r.status === 'fulfilled') return { data: r.value, error: null };
    console.error(`${label} failed:`, r.reason?.message || r.reason);
    return { data: [], error: r.reason?.message || 'Could not load' };
  };

  return {
    generatedAt: now.toISOString(),
    timezone: process.env.TZ,
    week: frames.week,
    month: frames.month,
    calendar: unwrap(events, 'Calendar'),
    tasks: unwrap(tasks, 'Tasks'),
    news: unwrap(news, 'News'),
    // Shaped as an object rather than a list, so unwrap's [] default would be
    // wrong here — give it its own empty shape.
    mail: (() => {
      const r = unwrap(mail, 'Mail');
      return { data: r.data && r.data.messages ? r.data : { unread: 0, messages: [], configured: false }, error: r.error };
    })(),
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

// The Calendar page only. The dashboard payload is anchored to today, so
// stepping to another month needs its own window — but the month grid it
// returns still covers whole Monday-Sunday weeks, so the week view of any date
// inside it is served from the same array without a further request.
//
// Tasks and news are deliberately absent: this endpoint answers "what is on in
// that month", and the "This Week" panel stays anchored to the real week.
app.get('/api/calendar', requireAuth, async (req, res) => {
  const anchor = parseAnchor(req.query.anchor);
  if (!anchor) return res.status(400).json({ error: 'anchor must be a real YYYY-MM-DD date within ten years.' });

  const frames = framesFor(anchor);
  try {
    res.json({ ...frames, calendar: { data: await monthCalendar(anchor), error: null } });
  } catch (err) {
    console.error('Calendar failed:', err.message);
    res.json({ ...frames, calendar: { data: [], error: err.message || 'Could not load' } });
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
  // Google returns 400 — not 401 — for a bad or truncated API key. Measured:
  // a truncated, bogus or empty key all give 400. So the key is named first.
  if (s === 400) {
    return 'The provider rejected the request (400). With Google this usually means the API ' +
      'key value is wrong — too short from a clipped paste, or too long because more than ' +
      'the key itself ended up in the field. An invalid model name gives the same code. ' +
      'Compare chat_key_len on /healthz against your real key length.';
  }
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

// One message body, fetched only when the user opens it. Bodies are never in
// the dashboard payload: they should not sit in the browser unasked, and they
// would bloat a response that refreshes every sixty seconds.
app.get('/api/mail/:id', requireAuth, async (req, res) => {
  if (!gmailConfig.refreshToken) {
    return res.status(503).json({ error: 'Mail is not connected.' });
  }
  // Gmail ids are opaque but always url-safe. Reject anything else rather than
  // interpolating it into an upstream path.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(req.params.id)) {
    return res.status(400).json({ error: 'Bad message id.' });
  }
  try {
    res.json(await fetchBody(gmailConfig, req.params.id));
  } catch (err) {
    console.error('Mail body failed:', err.message);
    res.status(502).json({ error: 'Could not load that message.' });
  }
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
    // Length only, never the value. A key's length is a property of its format
    // rather than secret material, and it is the one thing that makes a
    // truncated paste — which Google reports as a generic 400 — visible.
    `chat_key_len=${chatConfig.apiKey ? chatConfig.apiKey.length : 0}`,
    // Which of the three Gmail values are present. The refresh token is the one
    // that is easy to forget on a second machine or on the host.
    `mail=${gmailConfig.refreshToken ? 'set' : 'unset'}`,
    `mail_client=${gmailConfig.clientId ? 'set' : 'unset'}`,
    `mail_secret=${gmailConfig.clientSecret ? 'set' : 'unset'}`,
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
