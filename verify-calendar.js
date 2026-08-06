'use strict';
// Regression guard for landmine 1. Serves a synthetic .ics over localhost and
// runs the real fetchCalendarEvents against it, covering every DTSTART
// anchoring Google emits. A live feed will not exercise all of them — the
// user's own calendar contains no recurring UTC events, which is exactly the
// case that broke silently.
//
//   node verify-calendar.js        exits non-zero on any mismatch

process.env.TZ = process.env.TIMEZONE || 'Asia/Singapore';

const http = require('http');
const { fetchCalendarEvents } = require('./lib/calendar');

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//week-dashboard fixture//EN',
  'BEGIN:VTIMEZONE',
  'TZID:Asia/Singapore',
  'BEGIN:STANDARD',
  'DTSTART:19700101T000000',
  'TZOFFSETFROM:+0800',
  'TZOFFSETTO:+0800',
  'TZNAME:+08',
  'END:STANDARD',
  'END:VTIMEZONE',

  // Floating wall-clock recurrence: 09:00 means 09:00 wherever you are.
  'BEGIN:VEVENT',
  'UID:floating-1',
  'SUMMARY:Floating 9am weekly',
  'DTSTART:20260803T090000',
  'DTEND:20260803T100000',
  'RRULE:FREQ=WEEKLY;COUNT=3',
  'END:VEVENT',

  // Zone-anchored recurrence — what Google writes for a normal repeating event.
  'BEGIN:VEVENT',
  'UID:tzid-1',
  'SUMMARY:TZID 7pm weekly',
  'DTSTART;TZID=Asia/Singapore:20260803T190000',
  'DTEND;TZID=Asia/Singapore:20260803T220000',
  'RRULE:FREQ=WEEKLY;COUNT=3',
  'END:VEVENT',

  // UTC-anchored recurrence. 11:00Z is 19:00 in Singapore.
  'BEGIN:VEVENT',
  'UID:utc-1',
  'SUMMARY:UTC 11z weekly',
  'DTSTART:20260803T110000Z',
  'DTEND:20260803T120000Z',
  'RRULE:FREQ=WEEKLY;COUNT=3',
  'END:VEVENT',

  // Recurring all-day: exactly one whole day, not 16 hours.
  'BEGIN:VEVENT',
  'UID:allday-1',
  'SUMMARY:Yearly birthday',
  'DTSTART;VALUE=DATE:20260804',
  'DTEND;VALUE=DATE:20260805',
  'RRULE:FREQ=YEARLY;COUNT=2',
  'END:VEVENT',

  // Multi-day all-day: DTEND is exclusive, so this is three days.
  'BEGIN:VEVENT',
  'UID:allday-2',
  'SUMMARY:Three day trip',
  'DTSTART;VALUE=DATE:20260810',
  'DTEND;VALUE=DATE:20260813',
  'END:VEVENT',

  // Non-recurring timed event: never went through the rrule path.
  'BEGIN:VEVENT',
  'UID:single-1',
  'SUMMARY:Single 3pm',
  'DTSTART;TZID=Asia/Singapore:20260806T150000',
  'DTEND;TZID=Asia/Singapore:20260806T163000',
  'END:VEVENT',

  'END:VCALENDAR',
].join('\r\n');

const EXPECT = {
  'Floating 9am weekly': { time: '09:00', mins: 60 },
  'TZID 7pm weekly': { time: '19:00', mins: 180 },
  'UTC 11z weekly': { time: '19:00', mins: 60 },
  'Yearly birthday': { time: null, mins: 1440 },
  'Three day trip': { time: null, mins: 4320 },
  'Single 3pm': { time: '15:00', mins: 90 },
};

const pad = (n) => String(n).padStart(2, '0');
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/calendar' });
  res.end(ICS);
});

server.listen(0, async () => {
  const url = `http://127.0.0.1:${server.address().port}/fixture.ics`;
  let failures = 0;

  try {
    const events = await fetchCalendarEvents(
      url,
      new Date(2026, 7, 1),
      new Date(2026, 7, 31, 23, 59, 59)
    );

    const seen = new Set();
    for (const e of events) {
      const want = EXPECT[e.title];
      if (!want) {
        console.log(`UNEXPECTED  ${e.title}`);
        failures++;
        continue;
      }
      seen.add(e.title);

      const start = new Date(e.start);
      const mins = e.end ? Math.round((new Date(e.end) - start) / 60000) : 0;
      const timeOk = want.time === null || hm(start) === want.time;
      const durOk = mins === want.mins;
      if (!timeOk || !durOk) failures++;

      console.log(
        `${timeOk && durOk ? 'PASS' : 'FAIL'}  ${e.title.padEnd(22)}` +
        `start ${(e.allDay ? 'all-day' : hm(start)).padEnd(8)}` +
        `${want.time ? `want ${want.time}` : '         '}   ` +
        `dur ${String(mins).padStart(4)}m want ${want.mins}m`
      );
    }

    for (const title of Object.keys(EXPECT)) {
      if (!seen.has(title)) {
        console.log(`MISSING  ${title}`);
        failures++;
      }
    }

    console.log('');
    console.log(failures === 0
      ? 'All anchorings correct — floating, TZID, UTC, all-day, multi-day, single.'
      : `${failures} failure(s).`);
  } catch (err) {
    console.error('FAILED:', err.message);
    failures++;
  } finally {
    server.close();
    process.exitCode = failures === 0 ? 0 : 1;
  }
});
