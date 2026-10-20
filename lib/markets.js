'use strict';

// Market quotes — read-only, no API key, no account.
//
// Yahoo's chart endpoint is public and unauthenticated, and it resolves the
// user's three symbols natively: QQQM and SOXX as US ETFs, BTC-USD as crypto.
// Key-based alternatives were considered first and rejected on cost of setup
// rather than capability: Finnhub needs crypto remapped to an exchange pair
// (BINANCE:BTCUSDT), and Twelve Data's free tier is 800 calls/day against the
// ~864 a dashboard left open all day would make. Both would also mean a key to
// paste into .env and Railway for a panel that shows three numbers.
//
// The trade-off is that this endpoint is unofficial: it can change shape or
// rate-limit without notice. That is survivable here because the panel fails
// independently (see buildPayload) and the whole thing is one module — swapping
// providers means rewriting quote() and nothing else.
//
// Raw fetch, no SDK, matching notion.js / news.js / gmail.js.

const API = 'https://query1.finance.yahoo.com/v8/finance/chart/';

// The dashboard reloads every five minutes and a browser refresh reloads on
// demand, so quotes are cached briefly. This is politeness toward an endpoint
// nobody is paying for, not a performance measure.
const TTL_MS = 60 * 1000;
const cache = new Map();

function pctOf(now, then) {
  if (!Number.isFinite(now) || !Number.isFinite(then) || then === 0) return null;
  return ((now / then) - 1) * 100;
}

async function quote(symbol) {
  const url = `${API}${encodeURIComponent(symbol)}?interval=1d&range=1mo`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) {
    const err = new Error(`${symbol}: HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }

  const json = await res.json();
  const result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result || !result.meta) throw new Error(`${symbol}: no data in response`);

  const m = result.meta;

  // Closes carry nulls — a day the series has no bar for. BTC-USD had exactly
  // one in the month this was written, which is why they are filtered rather
  // than trusted positionally.
  const closes = (((result.indicators || {}).quote || [{}])[0].close || [])
    .filter((v) => Number.isFinite(v));

  const price = Number.isFinite(m.regularMarketPrice) ? m.regularMarketPrice : null;

  return {
    symbol: m.symbol || symbol,
    name: m.shortName || m.longName || symbol,
    currency: m.currency || 'USD',
    kind: m.instrumentType || '',
    price,

    // The feed's own day change, NOT one computed from `closes`. Those two
    // agree for the ETFs and disagree for Bitcoin, and the feed is the one
    // that is right: crypto's previous-day close can be missing from the
    // series, so computing it silently measured against the day before that
    // and reported -0.16% where the real move was -0.94%.
    //
    // `chartPreviousClose` is not the baseline either. It is the close before
    // the requested range, so it moves when `range` moves — a plausible-looking
    // field that answers a different question.
    changePct: Number.isFinite(m.regularMarketChangePercent)
      ? m.regularMarketChangePercent
      : null,

    // Derived here and labelled as the window it covers. For an ETF a 1-month
    // range is ~21 trading bars, for crypto ~30 daily ones; both span about a
    // calendar month, which is what the label claims.
    periodChangePct: closes.length > 1 ? pctOf(price, closes[0]) : null,
    high: closes.length ? Math.max(...closes) : null,
    low: closes.length ? Math.min(...closes) : null,
    series: closes,

    // US sessions close in the middle of a Singapore day, so a quote several
    // hours stale is normal rather than a fault. Showing when it was taken is
    // what makes a flat line at 03:00 legible instead of alarming.
    quotedAt: Number.isFinite(m.regularMarketTime)
      ? new Date(m.regularMarketTime * 1000).toISOString()
      : null,
  };
}

async function fetchMarkets(symbols) {
  const wanted = (symbols || []).filter(Boolean);
  if (!wanted.length) return [];

  const fresh = Date.now() - TTL_MS;
  const settled = await Promise.allSettled(wanted.map(async (s) => {
    const hit = cache.get(s);
    if (hit && hit.at > fresh) return hit.value;
    const value = await quote(s);
    cache.set(s, { at: Date.now(), value });
    return value;
  }));

  // One dead symbol must not blank the panel — the same rule the news feeds
  // follow. A symbol that fails and has nothing cached is reported in place,
  // so a typo in MARKET_SYMBOLS is visible rather than silently absent.
  const out = settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    console.error(`Market ${wanted[i]} failed:`, r.reason && r.reason.message);
    const stale = cache.get(wanted[i]);
    if (stale) return Object.assign({}, stale.value, { stale: true });
    return { symbol: wanted[i], name: wanted[i], price: null, changePct: null, series: [], error: true };
  });

  if (out.every((q) => q.error)) throw new Error('Every market symbol failed');
  return out;
}

module.exports = { fetchMarkets, quote, TTL_MS };
