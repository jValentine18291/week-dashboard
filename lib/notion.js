'use strict';

// Notion API version 2025-09-03 introduced multi-source databases.
// Databases are now queried through /v1/data_sources/{id}/query - the older
// /v1/databases/{id}/query endpoint belongs to the previous API version.
const NOTION_VERSION = '2025-09-03';
const API = 'https://api.notion.com/v1';

async function notionRequest(path, token, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body || {}),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Notion ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json();
}

// --- property readers -------------------------------------------------
// Written defensively: a missing or renamed property returns null rather
// than throwing, so one bad column never blanks the whole panel.

function readTitle(props) {
  const entry = Object.values(props || {}).find((p) => p && p.type === 'title');
  if (!entry || !Array.isArray(entry.title)) return 'Untitled';
  const text = entry.title.map((t) => t.plain_text).join('').trim();
  return text || 'Untitled';
}

function readDate(props, name) {
  const p = props?.[name];
  if (!p || p.type !== 'date' || !p.date) return null;
  return p.date.start;
}

function readChoice(props, name) {
  const p = props?.[name];
  if (!p) return null;
  if (p.type === 'status') return p.status?.name || null;
  if (p.type === 'select') return p.select?.name || null;
  if (p.type === 'checkbox') return p.checkbox ? 'Done' : 'Not started';
  return null;
}

function readTags(props, name) {
  const p = props?.[name];
  if (!p) return [];
  if (p.type === 'multi_select') return (p.multi_select || []).map((t) => t.name);
  if (p.type === 'select') return p.select ? [p.select.name] : [];
  return [];
}

// --- tasks ------------------------------------------------------------

async function fetchTasks(config, weekEndISODate) {
  const {
    token,
    tasksDataSourceId,
    dueProperty,
    statusProperty,
    areaProperty,
    priorityProperty,
    doneValues,
  } = config;
  if (!tasksDataSourceId) return [];

  // Only the date filter goes to the API. Status is interpreted here so a
  // renamed or differently-typed status column can't 400 the request.
  const data = await notionRequest(`/data_sources/${tasksDataSourceId}/query`, token, {
    page_size: 100,
    filter: {
      property: dueProperty,
      date: { on_or_before: weekEndISODate },
    },
    sorts: [{ property: dueProperty, direction: 'ascending' }],
  });

  const done = doneValues.map((v) => v.toLowerCase());

  return (data.results || []).map((page) => {
    const props = page.properties || {};
    const status = readChoice(props, statusProperty);
    return {
      kind: 'task',
      id: page.id,
      title: readTitle(props),
      due: readDate(props, dueProperty),
      status,
      done: !!status && done.includes(status.toLowerCase()),
      priority: readChoice(props, priorityProperty),
      areas: readTags(props, areaProperty),
      url: page.url,
    };
  });
}

// --- notes ------------------------------------------------------------

async function fetchNotes(config, limit = 8) {
  const { token, notesDataSourceId, areaProperty } = config;
  if (!notesDataSourceId) return [];

  const data = await notionRequest(`/data_sources/${notesDataSourceId}/query`, token, {
    page_size: limit,
    sorts: [{ timestamp: 'created_time', direction: 'descending' }],
  });

  return (data.results || []).map((page) => ({
    id: page.id,
    title: readTitle(page.properties || {}),
    created: page.created_time,
    areas: readTags(page.properties || {}, areaProperty),
    url: page.url,
  }));
}

module.exports = { fetchTasks, fetchNotes };
