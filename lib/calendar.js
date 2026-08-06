'use strict';

const ical = require('node-ical');

// Google Calendar's "secret address in iCal format" is a plain read-only URL.
// No OAuth, no consent screen, no refresh tokens. Treat the URL as a password.

const DAY_MS = 24 * 60 * 60 * 1000;

function isAllDay(ev) {
  return ev.datetype === 'date';
}

// Local (not UTC) YYYY-MM-DD. Using UTC here would put a 9pm Singapore event
// on the following day.
function localDateKey(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// rrule.js generates occurrences in "floating" time: the UTC components of the
// returned Date carry the intended WALL-CLOCK time, not a real UTC instant.
// Left uncorrected, a 9am recurring meeting lands 8 hours late in Singapore.
// Re-reading those components as local time restores the correct instant.
function correctFloatingTime(occurrence) {
  return new Date(
    occurrence.getUTCFullYear(),
    occurrence.getUTCMonth(),
    occurrence.getUTCDate(),
    occurrence.getUTCHours(),
    occurrence.getUTCMinutes(),
    occurrence.getUTCSeconds()
  );
}

const asInstant = (occurrence) => new Date(occurrence.getTime());

// Whether the correction above is needed depends on how DTSTART was anchored,
// and one Google feed mixes all three forms. Measured against node-ical 0.18:
//
//   DTSTART:...T090000        (floating)  occurrence is a real instant
//   DTSTART;TZID=...:...      (zoned)     occurrence is a real instant
//   DTSTART:...T110000Z       (UTC)       occurrence is floating wall-clock
//
// Only the last needs correcting. Applying it to the others moves them by the
// UTC offset — 8 hours, in Singapore — which is why the classes in the live
// feed rendered at 11:00 instead of 19:00.
//
// This is version-specific behaviour, so it is detected rather than assumed:
// ask the rule for its first occurrence and keep whichever reading lands on
// the same wall-clock time as the event's own DTSTART. Comparing time-of-day
// rather than the instant keeps this honest when a rule's first occurrence
// falls on a different date than DTSTART.
function occurrenceReader(ev) {
  if (!ev.rrule || !(ev.start instanceof Date)) return correctFloatingTime;

  let probe = null;
  try {
    const ruleStart = ev.rrule.options && ev.rrule.options.dtstart;
    if (ruleStart instanceof Date) {
      probe = ev.rrule.after(new Date(ruleStart.getTime() - 1), true);
    }
  } catch (err) {
    probe = null;
  }
  if (!probe) return correctFloatingTime;

  const minuteOfDay = (d) => d.getHours() * 60 + d.getMinutes();
  const want = minuteOfDay(ev.start);

  if (minuteOfDay(asInstant(probe)) === want) return asInstant;
  if (minuteOfDay(correctFloatingTime(probe)) === want) return correctFloatingTime;
  return correctFloatingTime;
}

function isExcluded(ev, occurrenceDate) {
  if (!ev.exdate) return false;
  const key = localDateKey(occurrenceDate);
  return Object.values(ev.exdate).some(
    (d) => d instanceof Date && localDateKey(d) === key
  );
}

// A recurring event can have single occurrences edited. Those arrive as
// ev.recurrences, keyed by the original occurrence date.
function findOverride(ev, occurrenceDate) {
  if (!ev.recurrences) return null;
  const key = localDateKey(occurrenceDate);
  const match = Object.values(ev.recurrences).find(
    (r) => r && r.start instanceof Date && localDateKey(r.start) === key
  );
  return match || null;
}

function shape(ev, start, end) {
  return {
    id: `${ev.uid || 'event'}-${start.getTime()}`,
    title: (ev.summary || 'Untitled event').toString(),
    start: start.toISOString(),
    end: end ? end.toISOString() : null,
    allDay: isAllDay(ev),
    location: ev.location ? ev.location.toString() : null,
    description: ev.description ? ev.description.toString().slice(0, 600) : null,
  };
}

function overlapsWindow(start, end, windowStart, windowEnd) {
  const s = start.getTime();
  const e = end ? end.getTime() : s;
  return e >= windowStart.getTime() && s <= windowEnd.getTime();
}

async function fetchCalendarEvents(icsUrl, windowStart, windowEnd) {
  if (!icsUrl) return [];

  const data = await ical.async.fromURL(icsUrl);
  const out = [];

  for (const key of Object.keys(data)) {
    const ev = data[key];
    if (!ev || ev.type !== 'VEVENT' || !ev.start) continue;

    const rawDuration =
      ev.end && ev.start ? ev.end.getTime() - ev.start.getTime() : 0;

    // node-ical can resolve an all-day DTSTART and DTEND against different
    // midnights, which leaves a one-day event 8 hours short in Singapore. An
    // all-day span is whole days by definition, so round rather than trust it.
    const durationMs = isAllDay(ev)
      ? Math.max(1, Math.round(rawDuration / DAY_MS)) * DAY_MS
      : rawDuration;

    if (ev.rrule) {
      const readOccurrence = occurrenceReader(ev);
      // Query a padded window, then filter precisely after correcting the
      // floating times - the raw occurrences are not comparable to real dates.
      const padStart = new Date(windowStart.getTime() - durationMs - DAY_MS);
      const padEnd = new Date(windowEnd.getTime() + DAY_MS);

      let raw = [];
      try {
        raw = ev.rrule.between(padStart, padEnd, true);
      } catch (err) {
        console.error('Could not expand recurrence for', ev.summary, err.message);
      }

      for (const occurrence of raw) {
        const occStart = readOccurrence(occurrence);
        if (isExcluded(ev, occStart)) continue;

        const override = findOverride(ev, occStart);
        if (override) {
          const oStart = override.start;
          const oEnd = override.end || new Date(oStart.getTime() + durationMs);
          if (overlapsWindow(oStart, oEnd, windowStart, windowEnd)) {
            out.push(shape(override, oStart, oEnd));
          }
          continue;
        }

        const occEnd = new Date(occStart.getTime() + durationMs);
        if (overlapsWindow(occStart, occEnd, windowStart, windowEnd)) {
          out.push(shape(ev, occStart, occEnd));
        }
      }
      continue;
    }

    // All-day events use the snapped duration too, for the same reason.
    const evEnd = isAllDay(ev) || !ev.end
      ? new Date(ev.start.getTime() + durationMs)
      : ev.end;
    if (overlapsWindow(ev.start, evEnd, windowStart, windowEnd)) {
      out.push(shape(ev, ev.start, evEnd));
    }
  }

  // Drop duplicates that can arise when an override also matches the base rule.
  const seen = new Set();
  const unique = out.filter((e) => {
    const k = `${e.title}|${e.start}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  unique.sort((a, b) => new Date(a.start) - new Date(b.start));
  return unique;
}

module.exports = { fetchCalendarEvents };
