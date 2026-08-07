'use strict';

// RSS reader. Feeds, not a news API — NewsAPI's free tier is development-only
// (see HANDOVER phase 2 research). Raw parsing rather than an XML dependency,
// matching lib/notion.js and lib/chat.js: the fields wanted are few and the
// shapes are regular. Measured against the two live feeds this ships with,
// which between them cover both quirks that matter — CDATA and non-CDATA
// text, and media:thumbnail with attributes in either order.

const DEFAULT_FEEDS = [
  'https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&categoryId=10416',
  'https://feeds.bbci.co.uk/news/world/rss.xml',
];

const MAX_PER_FEED = 12;
const MAX_SUMMARY = 220;
const FETCH_TIMEOUT_MS = 6000;

// Order matters: &amp; is decoded last so an encoded entity like &amp;lt;
// does not get decoded twice into a real tag.
function decode(s) {
  if (!s) return '';
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (m, d) => String.fromCharCode(parseInt(d, 16)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(block, name) {
  const m = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + name + '>', 'i').exec(block);
  return m ? decode(m[1]) : '';
}

// media:thumbnail and enclosure both put the URL in an attribute, and the two
// live feeds order those attributes differently — so match the attribute, not
// a position.
function imageOf(block) {
  const media = /<media:(?:thumbnail|content)\b[^>]*\burl=["']([^"']+)["']/i.exec(block);
  if (media) return media[1];
  const enclosure = /<enclosure\b[^>]*\burl=["']([^"']+)["']/i.exec(block);
  if (enclosure && /image/i.test(enclosure[0])) return enclosure[1];
  return null;
}

// Some feeds title their channel something useless — CNA's is literally
// "Latest News", which is no help once two sources are interleaved. Prefer a
// known short name, then the channel title if it is actually distinctive,
// then the hostname.
const SOURCE_ALIASES = {
  'www.channelnewsasia.com': 'CNA',
  'feeds.bbci.co.uk': 'BBC',
  'www.straitstimes.com': 'Straits Times',
  'www.businesstimes.com.sg': 'Business Times',
  'www.theguardian.com': 'Guardian',
  'www.aljazeera.com': 'Al Jazeera',
};

const GENERIC_TITLE = /^(latest|top|breaking|home|news|rss|feed)\b/i;

function sourceName(channelTitle, host) {
  if (SOURCE_ALIASES[host]) return SOURCE_ALIASES[host];
  if (channelTitle && !GENERIC_TITLE.test(channelTitle)) return channelTitle;
  return host.replace(/^www\./, '');
}

function parseFeed(xml, host) {
  const channel = xml.split(/<item[\s>]/i)[0];
  const source = sourceName(tag(channel, 'title'), host || '');

  const out = [];
  const blocks = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];
  for (const block of blocks.slice(0, MAX_PER_FEED)) {
    const title = tag(block, 'title');
    if (!title) continue;
    const published = tag(block, 'pubDate') || tag(block, 'dc:date');
    const when = published ? new Date(published) : null;
    out.push({
      title,
      link: tag(block, 'link') || null,
      summary: tag(block, 'description').slice(0, MAX_SUMMARY) || null,
      published: when && !isNaN(when) ? when.toISOString() : null,
      image: imageOf(block),
      source,
    });
  }
  return out;
}

async function fetchOne(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'week-dashboard/1.0 (+personal dashboard)' },
    });
    if (!res.ok) throw new Error(`${res.status}`);
    return parseFeed(await res.text(), new URL(url).hostname);
  } finally {
    clearTimeout(timer);
  }
}

// One dead feed must not blank the panel, so each is settled independently —
// the same reason server.js settles its data sources separately.
async function fetchNews(feeds, limit = 8) {
  const list = (feeds && feeds.length ? feeds : DEFAULT_FEEDS);
  const results = await Promise.allSettled(list.map(fetchOne));

  const items = [];
  const failed = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push(...r.value);
    else failed.push(new URL(list[i]).hostname);
  });

  if (!items.length && failed.length) {
    throw new Error(`No feed could be read (${failed.join(', ')})`);
  }

  // Interleave by recency so one prolific feed cannot crowd the other out.
  items.sort((a, b) => new Date(b.published || 0) - new Date(a.published || 0));
  return items.slice(0, limit);
}

module.exports = { fetchNews, parseFeed, decode, imageOf, sourceName, DEFAULT_FEEDS };
