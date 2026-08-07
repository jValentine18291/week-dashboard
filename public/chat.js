'use strict';
/**
 * Chat drawer. Sends nothing but the conversation itself — no calendar, no
 * tasks, no notes. History lives in memory only and is gone on reload; there
 * is no database in this project and a scratchpad does not need one.
 */
(function () {
  var el = (id) => document.getElementById(id);
  var history = [];
  var busy = false;

  function open() {
    el('chat').classList.add('is-open');
    el('chat-input').focus();
  }
  function close() {
    el('chat').classList.remove('is-open');
  }

  function bubble(cls, text) {
    var log = el('chat-log');
    var empty = log.querySelector('.chat-empty');
    if (empty) empty.remove();
    var b = document.createElement('div');
    b.className = 'chat-msg ' + cls;
    b.textContent = text || '';
    log.appendChild(b);
    log.scrollTop = log.scrollHeight;
    return b;
  }

  function setBusy(v) {
    busy = v;
    el('chat-send').disabled = v;
    el('chat-input').disabled = v;
  }

  async function send() {
    var input = el('chat-input');
    var text = input.value.trim();
    if (!text || busy) return;

    input.value = '';
    bubble('me', text);
    history.push({ role: 'user', content: text });
    setBusy(true);

    var out = bubble('bot', '');
    out.classList.add('streaming');
    var reply = '';

    try {
      var res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history }),
      });

      if (!res.ok) {
        var msg = 'Chat is unavailable.';
        try { msg = (await res.json()).error || msg; } catch (e) { /* keep default */ }
        out.remove();
        bubble('err', res.status === 401 ? 'Session expired — reload and sign in again.' : msg);
        setBusy(false);
        return;
      }

      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';

      for (;;) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        var events = buffer.split('\n\n');
        buffer = events.pop() || '';
        for (var i = 0; i < events.length; i++) {
          var line = events[i].split('\n').find(function (l) { return l.indexOf('data:') === 0; });
          if (!line) continue;
          var payload;
          try { payload = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
          if (payload.error) {
            out.remove();
            bubble('err', payload.error);
            setBusy(false);
            return;
          }
          if (payload.delta) {
            reply += payload.delta;
            out.textContent = reply;
            el('chat-log').scrollTop = el('chat-log').scrollHeight;
          }
        }
      }

      if (reply) history.push({ role: 'assistant', content: reply });
      else { out.remove(); bubble('err', 'No reply came back.'); }
    } catch (err) {
      out.remove();
      bubble('err', 'Could not reach the assistant.');
    } finally {
      out.classList.remove('streaming');
      setBusy(false);
      el('chat-input').focus();
    }
  }

  el('rail-chat').addEventListener('click', function () {
    if (el('chat').classList.contains('is-open')) close(); else open();
  });
  el('chat-close').addEventListener('click', close);
  el('chat-send').addEventListener('click', send);

  el('chat-input').addEventListener('keydown', function (e) {
    // Enter sends; Shift+Enter is a newline.
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && el('chat').classList.contains('is-open')) close();
  });
})();
