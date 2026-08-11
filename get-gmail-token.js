'use strict';
/**
 * One-time helper: turns your OAuth client into a refresh token.
 *
 *   node get-gmail-token.js
 *
 * Opens a consent page, catches the redirect on localhost, exchanges the code,
 * and prints the refresh token IN YOUR TERMINAL. Nothing is written to disk and
 * nothing leaves this machine except the standard Google OAuth exchange.
 *
 * Run it yourself. The token it prints is a long-lived credential for your
 * mailbox — paste it straight into .env, and later into Railway's Variables.
 *
 * You only need this once. Re-run it if you ever revoke access or rotate the
 * client secret.
 */

require('dotenv').config();

const http = require('http');
const crypto = require('crypto');
const { SCOPE, TOKEN_URL } = require('./lib/gmail');

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be in .env first.');
  process.exit(1);
}

// Loopback redirect — the flow Google documents for Desktop app clients.
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname !== '/oauth') {
    res.writeHead(404).end();
    return;
  }

  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  const done = (msg) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<body style="background:#02040a;color:#e9f7ff;font:16px system-ui;
      display:grid;place-items:center;height:100vh;margin:0">
      <p>${msg}</p></body>`);
  };

  if (error) {
    done('Authorisation was declined. You can close this tab.');
    console.error('\nGoogle returned: ' + error);
    server.close();
    process.exitCode = 1;
    return;
  }

  if (state !== expectedState) {
    done('State mismatch — ignoring this response.');
    console.error('\nState did not match. Start again.');
    server.close();
    process.exitCode = 1;
    return;
  }

  try {
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const body = await r.text();
    if (!r.ok) throw new Error(`${r.status}: ${body.slice(0, 300)}`);

    const json = JSON.parse(body);
    if (!json.refresh_token) {
      throw new Error(
        'Google returned no refresh_token. This happens when the app was already ' +
        'authorised. Revoke it at myaccount.google.com/permissions and run this again.'
      );
    }

    done('Done. Copy the token from your terminal, then close this tab.');

    console.log('\n' + '='.repeat(66));
    console.log('Add this line to .env (and later to Railway > Variables):\n');
    console.log('GMAIL_REFRESH_TOKEN=' + json.refresh_token);
    console.log('\n' + '='.repeat(66));
    console.log('Scope granted: ' + (json.scope || SCOPE));
    console.log('This token can read message headers and labels. It cannot read');
    console.log('message bodies. Treat it like a password.');
  } catch (err) {
    done('Token exchange failed. Check your terminal.');
    console.error('\nFAILED: ' + err.message);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

const expectedState = crypto.randomBytes(16).toString('hex');
let redirectUri;

server.listen(0, '127.0.0.1', () => {
  redirectUri = `http://127.0.0.1:${server.address().port}/oauth`;

  const consent = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  consent.searchParams.set('client_id', CLIENT_ID);
  consent.searchParams.set('redirect_uri', redirectUri);
  consent.searchParams.set('response_type', 'code');
  consent.searchParams.set('scope', SCOPE);
  // offline + consent together are what actually produce a refresh token.
  consent.searchParams.set('access_type', 'offline');
  consent.searchParams.set('prompt', 'consent');
  consent.searchParams.set('state', expectedState);

  console.log('\nOpen this URL in your browser and approve access:\n');
  console.log(consent.toString());
  console.log('\nWaiting for the redirect on ' + redirectUri + ' ...');
});
