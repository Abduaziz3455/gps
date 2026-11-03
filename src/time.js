'use strict';
/**
 * Local-time helpers. Everything is stored as epoch milliseconds; days and hours are Tashkent's (UTC+5,
 * no daylight saving), so plain offset arithmetic is exact.
 */
const config = require('./config');

const OFF = () => config.tzOffsetMin * 60e3;
const DAY = 86400e3;

/** 'YYYY-MM-DD' of the local day containing `ms`. */
function dayOf(ms) {
  return new Date(ms + OFF()).toISOString().slice(0, 10);
}

/** Epoch ms of local midnight starting `day` ('YYYY-MM-DD'). */
function dayStart(day) {
  return Date.parse(`${day}T00:00:00Z`) - OFF();
}

function addDays(day, n) {
  return dayOf(dayStart(day) + n * DAY + 1);
}

function today(now = Date.now()) {
  return dayOf(now);
}

/** Days from `from` to `to` inclusive. */
function daysBetween(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Naive local 'YYYY-MM-DDTHH:MM:SS' (what GoGPS expects together with `timezone`). */
function localIso(ms) {
  return new Date(ms + OFF()).toISOString().slice(0, 19);
}

/** Parse a GoGPS time. With Z/offset it is absolute; without, it is local time. */
function parseApiTime(s) {
  if (!s) return null;
  const str = String(s);
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(str)) {
    const t = Date.parse(str);
    return Number.isFinite(t) ? t : null;
  }
  const t = Date.parse(str.slice(0, 23) + 'Z');
  return Number.isFinite(t) ? t - OFF() : null;
}

/** Local hour (0-23) and ISO weekday (1 = Monday) of `ms`. */
function hourOf(ms) {
  return new Date(ms + OFF()).getUTCHours();
}
function weekdayOf(ms) {
  return ((new Date(ms + OFF()).getUTCDay() + 6) % 7) + 1;
}

/** Minutes since local midnight. */
function minuteOfDay(ms) {
  const d = new Date(ms + OFF());
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function parseHm(s) {
  const [h, m] = String(s).split(':').map(Number);
  return h * 60 + (m || 0);
}

module.exports = { DAY, dayOf, dayStart, addDays, today, daysBetween, localIso, parseApiTime, hourOf, weekdayOf, minuteOfDay, parseHm };
