'use strict';

// Gmail reader — unread count and the newest senders, nothing more.
//
// Scope is gmail.metadata, NOT gmail.readonly. Metadata grants headers and
// labels but cannot read message bodies or snippets, so the token physically
// cannot reach the contents of the user's work mail. That ceiling is the point;
// do not widen the scope to add a preview line without asking him first.
//
// Two consequences of that scope, both load-bearing:
//   - messages.list must filter with labelIds, not the `q` search parameter.
//     Metadata scope does not permit free-text search.
//   - There is no snippet field to fall back on, so the sender and subject
//     headers are all there is.
//
// Raw fetch, no googleapis SDK — the same call style as notion.js, news.js and
// chat.js, and this project has no build step to justify the dependency.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

// Widened from gmail.metadata to gmail.readonly at the user's request, so the
// Mail page can show message bodies. Google has no scope between the two —
// there is no "bodies but nothing else" — so this is a real step up: the token
// can now read the contents of every message in the mailbox.
//
// Only the consent URL in get-gmail-token.js uses this. Existing tokens keep
// whatever scope they were issued with, so the app keeps working on the old
// metadata token until a new one is granted.
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

// Access tokens last an hour. Cached in memory with a safety margin so a
// 60-second dashboard refresh does not mint a new one every time.
let cached = { token: null, expiresAt: 0 };

async function accessToken(config) {
  if (cached.token && Date.now() < cached.expiresAt) return cached.token;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Gmail token ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }

  const json = JSON.parse(text);
  cached = {
    token: json.access_token,
    expiresAt: Date.now() + Math.max(60, (json.expires_in || 3600) - 60) * 1000,
  };
  return cached.token;
}

async function api(path, token) {
  const res = await fetch(API + path, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const err = new Error(`Gmail ${res.status}: ${(await res.text()).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// "John Valentine" <john@x.com>  ->  John Valentine
// bare@address.com              ->  bare
function displayName(from) {
  if (!from) return 'Unknown';
  const quoted = /^\s*"?([^"<]+?)"?\s*</.exec(from);
  if (quoted && quoted[1].trim()) return quoted[1].trim();
  const bare = /<?([^<@\s]+)@/.exec(from);
  return bare ? bare[1] : from.trim();
}

function headerOf(message, name) {
  const list = (message.payload && message.payload.headers) || [];
  const hit = list.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return hit ? hit.value : '';
}

async function fetchMail(config, limit = 6) {
  if (!config.refreshToken) return { unread: 0, messages: [], configured: false };

  const token = await accessToken(config);

  // Unread total for the inbox specifically — not every unread label.
  const inbox = await api('/labels/INBOX', token);
  const unread = inbox.messagesUnread || 0;

  // labelIds rather than q= : see the scope note at the top.
  const list = await api(
    `/messages?labelIds=INBOX&labelIds=UNREAD&maxResults=${limit}`,
    token
  );
  const ids = (list.messages || []).map((m) => m.id);

  const messages = await Promise.all(
    ids.map(async (id) => {
      const m = await api(
        `/messages/${id}?format=metadata` +
        '&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date',
        token
      );
      const ts = Number(m.internalDate);
      return {
        id,
        from: displayName(headerOf(m, 'From')),
        subject: headerOf(m, 'Subject') || '(no subject)',
        received: ts ? new Date(ts).toISOString() : null,
      };
    })
  );

  messages.sort((a, b) => new Date(b.received || 0) - new Date(a.received || 0));
  return { unread, messages, configured: true };
}

// --- message bodies ------------------------------------------------------

const MAX_BODY_CHARS = 20000;

function decodeB64Url(data) {
  return Buffer.from(String(data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    .toString('utf8');
}

// Gmail nests parts arbitrarily deep: multipart/alternative inside
// multipart/mixed inside multipart/related is routine. Flatten first, choose
// after.
function flattenParts(part, out) {
  if (!part) return out;
  if (part.body && part.body.data) out.push({ mime: part.mimeType || '', data: part.body.data });
  (part.parts || []).forEach((p) => flattenParts(p, out));
  return out;
}

// Only ever produces text. The client renders it with textContent, so even a
// miss here cannot execute anything — but strip scripts and styles wholesale
// rather than relying on that alone.
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#0?39;/g, "'")
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function bodyText(payload) {
  const parts = flattenParts(payload, []);
  const plain = parts.find((p) => p.mime.startsWith('text/plain'));
  if (plain) return { text: decodeB64Url(plain.data).trim(), source: 'text/plain' };
  const html = parts.find((p) => p.mime.startsWith('text/html'));
  if (html) return { text: htmlToText(decodeB64Url(html.data)), source: 'text/html' };
  return { text: '', source: 'none' };
}

// Fetched per click, never bundled into the dashboard payload — a body should
// not sit in the browser unless it was asked for.
async function fetchBody(config, id) {
  const token = await accessToken(config);
  const m = await api(`/messages/${encodeURIComponent(id)}?format=full`, token);
  const { text, source } = bodyText(m.payload);
  return {
    id,
    from: displayName(headerOf(m, 'From')),
    subject: headerOf(m, 'Subject') || '(no subject)',
    received: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null,
    text: text.slice(0, MAX_BODY_CHARS),
    truncated: text.length > MAX_BODY_CHARS,
    source,
  };
}

module.exports = {
  fetchMail, fetchBody, displayName, headerOf, accessToken,
  bodyText, htmlToText, decodeB64Url, SCOPE, TOKEN_URL,
};
