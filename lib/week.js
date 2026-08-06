'use strict';

// All date maths runs in the server's local timezone, which server.js pins
// to TZ (default Asia/Singapore). That keeps this file free of tz libraries.

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

// Monday = start of week. JS getDay(): Sun=0 ... Sat=6.
function startOfWeek(now = new Date()) {
  const day = now.getDay();
  const back = day === 0 ? 6 : day - 1;
  return startOfDay(addDays(now, -back));
}

function endOfWeek(now = new Date()) {
  return endOfDay(addDays(startOfWeek(now), 6));
}

// Seven Date objects, Monday through Sunday.
function weekDays(now = new Date()) {
  const start = startOfWeek(now);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

function startOfMonth(now = new Date()) {
  return startOfDay(new Date(now.getFullYear(), now.getMonth(), 1));
}

// Day 0 of the next month is the last day of this one.
function endOfMonth(now = new Date()) {
  return endOfDay(new Date(now.getFullYear(), now.getMonth() + 1, 0));
}

// The month grid is drawn in whole Monday-Sunday rows, so it reaches back into
// the previous month and forward into the next. Those trailing days are shown
// greyed but they still need their events fetched.
function monthGridStart(now = new Date()) {
  return startOfWeek(startOfMonth(now));
}

function monthGridEnd(now = new Date()) {
  return endOfWeek(endOfMonth(now));
}

// 35 or 42 dates depending on how the month falls. Counting by rounded days
// rather than a fixed 42 keeps the grid as few rows as possible, which leaves
// each cell taller.
function monthDays(now = new Date()) {
  const start = monthGridStart(now);
  const span = Math.round((startOfDay(monthGridEnd(now)) - start) / (24 * 60 * 60 * 1000));
  return Array.from({ length: span + 1 }, (_, i) => addDays(start, i));
}

function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// "2026-08-05" in local time — Notion date filters expect this shape.
function toLocalISODate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

module.exports = {
  startOfDay,
  endOfDay,
  addDays,
  startOfWeek,
  endOfWeek,
  weekDays,
  startOfMonth,
  endOfMonth,
  monthGridStart,
  monthGridEnd,
  monthDays,
  isSameDay,
  toLocalISODate,
};
