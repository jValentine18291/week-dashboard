'use strict';

// Chat relay. Deliberately knows nothing about the dashboard: no calendar,
// no tasks, no notes are ever sent. The user asked for a scratchpad for
// unrelated questions, so the read-only integrations stay out of it entirely.
//
// Raw fetch rather than a vendor SDK, matching lib/notion.js — the endpoint is
// one POST, and this project has no build step to justify a dependency.
// baseUrl is configurable so the relay can be pointed at any OpenAI-compatible
// endpoint, which is also what makes it testable without spending real money.

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

// Bounds on what reaches the provider. These cap cost and stop a crafted
// request turning the relay into an open-ended bill.
const MAX_MESSAGES = 20;
const MAX_CHARS = 4000;

function sanitise(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && typeof m.content === 'string' &&
      (m.role === 'user' || m.role === 'assistant'))
    .slice(-MAX_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
}

// Parses the provider's SSE stream and hands back plain text deltas, so the
// wire format stays inside this file rather than leaking to the browser.
async function streamChat(config, messages, onDelta) {
  const body = {
    model: config.model,
    stream: true,
    max_tokens: config.maxTokens,
    messages: [{ role: 'system', content: config.systemPrompt }].concat(sanitise(messages)),
  };

  // Google documents its base URL with a trailing slash and OpenAI without
  // one, so normalise rather than emit `//chat/completions`.
  const base = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Chat ${res.status}: ${detail.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE events are separated by a blank line; a chunk can split one in half,
    // so keep the trailing partial in the buffer.
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';

    for (const evt of events) {
      const line = evt.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices && json.choices[0] && json.choices[0].delta;
        if (delta && delta.content) onDelta(delta.content);
      } catch (err) {
        // A malformed chunk should not kill an otherwise working stream.
      }
    }
  }
}

module.exports = { streamChat, sanitise, DEFAULT_BASE_URL, MAX_MESSAGES, MAX_CHARS };
