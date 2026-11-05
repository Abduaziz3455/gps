'use strict';
/**
 * GoGPS rows -> the shapes the app uses, plus vehicle naming and plate matching.
 *
 * Status, checked on 3 Nov 2026 against all 20 vehicles (docs/ARCHITECTURE.md, section 5):
 *   state 4 = moving (6-47 km/h), 2 = idling (engine on, standing), 3 = parked, 1 = no connection (days old).
 * v1 treated 0/1 as moving, so trackers silent since October showed as "moving".
 */
const { parseApiTime } = require('../time');

const STATUSES = ['moving', 'idle', 'stopped', 'offline'];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function statusOf({ state, speed, recordTime }, now, offlineMs) {
  if (!recordTime || now - recordTime > offlineMs) return 'offline';
  // GoGPS's own state wins (it reported state 2 at 9 km/h on 3 Nov); speed decides only without a state.
  if (state === 1) return 'offline';
  if (state === 4) return 'moving';
  if (state === 2) return 'idle';
  if (state === 3) return 'stopped';
  return speed > 5 ? 'moving' : speed > 0 ? 'idle' : 'stopped';
}

/** One getlastdata row -> live position, or null without usable coordinates. */
function normalizeLast(row, now, offlineMs) {
  const id = num(row.vehicleId ?? row.VehicleId);
  const lat = num(row.latitude ?? row.Latitude);
  const lng = num(row.longitude ?? row.Longitude);
  if (!id || lat === null || lng === null || (lat === 0 && lng === 0)) return null;
  const recordTime = parseApiTime(row.recordTime ?? row.RecordTime ?? row.receiveTime);
  const state = num(row.state ?? row.State);
  const speed = num(row.speed ?? row.Speed) ?? 0;
  const out = {
    id, lat, lng, speed, state,
    course: num(row.course ?? row.Course) ?? 0,
    recordTime,
    receiveTime: parseApiTime(row.receiveTime ?? row.ReceiveTime),
    address: String(row.address ?? row.Address ?? ''),
    geozones: Array.isArray(row.geozones) ? row.geozones.map((g) => g?.name).filter(Boolean) : [],
  };
  out.status = statusOf(out, now, offlineMs);
  return out;
}

/** One entry of a GoGPS fuelInOut report -> {t, kind: 'refuel'|'drain', litres}, or null when it says nothing usable. */
function normalizeFuelEvent(f) {
  const t = parseApiTime(f.startDate);
  const litres = Math.abs(Number(f.valueFuel) || 0);
  if (!t || !litres) return null;
  const refuel = f.event === 'FuelIn' || f.event === 0 || /in|refuel|fill/i.test(String(f.event));
  return { t, kind: refuel ? 'refuel' : 'drain', litres };
}

// Some GoGPS names are typed with Cyrillic look-alikes ("85 117 АА").
const CYR = { А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', У: 'Y', Х: 'X' };

/** Comparable key of a GPS name or plate read: "85 117 АА" -> "85117AA". */
function plateKey(s) {
  return String(s || '').toUpperCase().replace(/[АВЕКМНОРСТУХ]/g, (c) => CYR[c]).replace(/[^A-Z0-9]/g, '');
}

/** Same digits, same letters in another order: GoGPS "10 870 HAD" for the plate 10870HDA. */
function similarPlate(a, b) {
  const da = a.replace(/\D/g, ''), db = b.replace(/\D/g, '');
  if (da !== db || da.length < 5) return false;
  const la = a.replace(/\d/g, '').split('').sort().join(''), lb = b.replace(/\d/g, '').split('').sort().join('');
  return la === lb && la.length >= 2;
}

/** Readable plate: 85450KBA -> "85 450 KBA", 01A123BC -> "01 A 123 BC". */
function prettyPlate(p) {
  if (!p) return '';
  let m = /^(\d{2})(\d{3})([A-Z]{3})$/.exec(p);
  if (m) return m.slice(1).join(' ');
  m = /^(\d{2})([A-Z])(\d{3})([A-Z]{2})$/.exec(p);
  if (m) return m.slice(1).join(' ');
  return p;
}

/** Label for people: display name, else the real plate, else the GPS name ("№33" for bare fleet numbers). */
function vehicleLabel(v) {
  if (!v) return '';
  if (v.display) return v.display;
  if (v.plate) return prettyPlate(v.plate);
  return /^\d{1,3}$/.test(v.name.trim()) ? `№${v.name.trim()}` : v.name;
}

/** Marker/icon type. 'auto' guesses from the GPS model ("A/V" = SANY mixers) and falls back to mixer. */
function vehicleType(v) {
  if (v.type && v.type !== 'auto') return v.type;
  return 'mixer';
}

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371e3, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

module.exports = { STATUSES, statusOf, normalizeLast, normalizeFuelEvent, plateKey, similarPlate, prettyPlate, vehicleLabel, vehicleType, haversineM };
