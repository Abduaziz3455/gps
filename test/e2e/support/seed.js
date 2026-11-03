'use strict';
/** Known rows, written directly to a running server's database, for scenarios the simulator can't produce on demand. */
const crypto = require('node:crypto');

const uid = () => crypto.randomBytes(5).toString('hex');

/** IDs from src/mock/sim.js FLEET. */
const FLEET = {
  total: 20,
  dead: 22238, // tracker silent for days: always "offline"
  dead2: 22871,
  parked: 22872, // excavator standing at a site all day
  fuel: 21389, // has a fuel sensor; GPS name "85 450 KBA"
  fuel2: 22078, // "85 159 YAA"
  mixer: 33959, // GPS "10 870 HAD", the camera reads 10870HDA
};

function alert(server, { type = 'speeding', severity = 'warning', vehicleId = null, t = Date.now(), title, body = 'Sinov', data = null, ackedAt = null, ackedBy = null, key } = {}) {
  const k = key || `e2e:${uid()}`;
  const r = server.run('INSERT INTO alerts (key, type, severity, vehicle_id, t, title, body, data, acked_at, acked_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    k, type, severity, vehicleId, t, title || `Sinov ${k}`, body, data ? JSON.stringify(data) : null, ackedAt, ackedBy);
  return Number(r.lastInsertRowid);
}

function gateEvent(server, { t = Date.now(), direction = 'in', camera, channel, plate = '85450KBA', plateRaw, valid = 1, vehicleId = null, status = 'confirmed', note = null, by = null, stay = null, gap = 0, photos = '[]', uri = '/mock/picture?name=x' } = {}) {
  const name = `e2e_${uid()}`;
  const r = server.run(`INSERT INTO gate_events (capture_name, t, direction, camera, channel, plate, plate_raw, plate_valid, vehicle_id, identified_by, status, status_note, stay_s, gap, capture_uri, photos, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  name, t, direction, camera || (direction === 'in' ? 'ANPR-1' : 'ANPR-2'), channel || (direction === 'in' ? 4 : 3), plate, plateRaw ?? plate, valid, vehicleId, by, status, note, stay, gap, uri, photos, Date.now());
  return Number(r.lastInsertRowid);
}

function stats(server, day, vehicleId, o = {}) {
  const v = { km: 0, engine_s: 0, idle_s: 0, fuel_used: null, refuel_l: 0, drain_l: 0, trips_out: 0, trips_in: 0, turnaround_s: null, yard_s: null, max_speed: null, odometer: null, ...o };
  server.run(`INSERT OR REPLACE INTO daily_stats (day, vehicle_id, km, engine_s, idle_s, fuel_used, refuel_l, drain_l, trips_out, trips_in, turnaround_s, yard_s, max_speed, odometer, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, day, vehicleId, v.km, v.engine_s, v.idle_s, v.fuel_used, v.refuel_l, v.drain_l, v.trips_out, v.trips_in, v.turnaround_s, v.yard_s, v.max_speed, v.odometer, Date.now());
}

/** Tashkent helpers (UTC+5). */
const tashkentDay = (ms = Date.now()) => new Date(ms + 5 * 3600e3).toISOString().slice(0, 10);
const addDays = (day, n) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dayStart = (day) => Date.parse(`${day}T00:00:00Z`) - 5 * 3600e3;

/** Page content that exercises the design: every alert type and severity, long text, read and unread. */
function designAlerts(server) {
  const now = Date.now();
  alert(server, { type: 'fuel_drain', severity: 'critical', vehicleId: FLEET.fuel, t: now - 300e3, title: "Yoqilg'i to'kildi: 85 450 KBA", body: '−42 L, bugun 14:05' });
  alert(server, { type: 'speeding', severity: 'warning', vehicleId: FLEET.fuel2, t: now - 900e3, title: 'Tezlik oshirildi: 85 159 YAA', body: '97 km/soat (chegara 80) · Амир Темур проспект, Ташкент' });
  alert(server, { type: 'no_signal', severity: 'warning', vehicleId: FLEET.dead, t: now - 3600e3, title: "GPS signal yo'q: 85 805 TAA", body: "Oxirgi ma'lumot: 2026-10-30 09:15 · Сергели йули, Ташкент" });
  alert(server, { type: 'long_stop', severity: 'info', vehicleId: FLEET.mixer, t: now - 5400e3, title: "Uzoq to'xtash: 10 870 HAD", body: '95 daqiqadan beri hovlidan tashqarida turibdi' });
  alert(server, { type: 'system', severity: 'critical', t: now - 7200e3, title: "Zavoddagi kameralarga ulanib bo'lmayapti", body: "Zavoddan hech qanday javob yo'q. Eng ko'p uchraydigan sabablar: zavod interneti (Wi-Fi/router yoki provayder) ishlamayapti, elektr o'chgan yoki NVR o'chgan. Avval zavoddagi internetni tekshiring." });
  alert(server, { type: 'speeding', severity: 'warning', vehicleId: FLEET.fuel, t: now - 86400e3 * 2, title: 'Tezlik oshirildi: 85 450 KBA', body: 'ko\'rib chiqilgan', ackedAt: now - 86400e3, ackedBy: 1 });
}

module.exports = { uid, alert, gateEvent, stats, FLEET, tashkentDay, addDays, dayStart, designAlerts };
