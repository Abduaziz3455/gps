'use strict';
/**
 * Development simulator (MOCK=1): a fake GoGPS account and a fake NVR that agree with each other.
 *
 * Every vehicle follows a deterministic daily plan (seeded by vehicle and day): load in the yard, drive to a
 * site, unload, come back, repeat. Positions, GPS reports and camera captures are all derived from that plan,
 * so the whole pipeline (gate events, GPS confirmation, rollups, analytics) can be exercised and demoed
 * without the real systems. Never used in production.
 */
const T = require('../time');

const YARD_ADDR = 'Уйсозлар 2-й проезд, Ташкент, Узбекистан';
const SITES = [
  { lat: 41.3111, lng: 69.2797, addr: 'Амир Темур проспект, Ташкент' },
  { lat: 41.2380, lng: 69.2120, addr: 'Сергели йули, Ташкент' },
  { lat: 41.3460, lng: 69.3350, addr: 'Кукча Дарваза улица, Ташкент' },
  { lat: 41.2860, lng: 69.4300, addr: 'Ханабадтепа проспект, Ташкент' },
  { lat: 41.3290, lng: 69.2280, addr: 'Малая кольцевая дорога, Ташкент' },
  { lat: 41.2030, lng: 69.3600, addr: 'Ахангаранское шоссе, Ташкент' },
  { lat: 41.3700, lng: 69.2900, addr: 'Юнусабад, Ташкент' },
  { lat: 41.2550, lng: 69.1800, addr: 'Чиланзар, Ташкент' },
];
// GPS names as in the real account on 3 Nov 2026; cam = what the plate camera reads (mixers differ: HAD/HDA).
const FLEET = [
  [21673, '85 058 FBA', 'N/V'], [21314, '85 027 WAA', 'N/V'], [21675, '85 942 DBA', 'N/V'], [21680, '85 017 WAA', 'N/V'],
  [21671, '85 518 EBA', 'N/V'], [22077, '85 304 RAA', 'N/V'], [22078, '85 159 YAA', 'N/V'], [21389, '85 450 KBA', 'N/V'],
  [21312, '85 519 EBA', 'N/V'], [22238, '85 805 TAA', 'N/V'], [22872, '85 117 АА', 'N/V'], [22871, '85 274 YAA', 'N/V'],
  [21390, '85 158 YAA', 'N/V'], [33959, '10 870 HAD', 'A/V', '10870HDA'], [33962, '10 863 HAD', 'A/V', '10863HDA'],
  [33951, '10 873 HAD', 'A/V', '10873HDA'], [33953, '10 842 HAD', 'A/V', '10842HDA'], [33952, '10 872 HAD', 'A/V', '10872HDA'],
  [33963, '10 840 HAD', 'A/V', '10840HDA'], [34325, '10 865 HAD', 'N/V', '10865HDA'],
];
const DEAD = new Set([22238, 22871]); // trackers silent for days (as in the real fleet)
const PARKED = new Set([22872]); // stands at a site all day (excavator)
const FUEL_SENSOR = new Set([22078, 21389, 22077]);
const OUTSIDE_PLATES = ['01A123BC', '10K456DA', '30M777AA', '01777AAA', '40B210CA', '85333KAA', '01S505SA', '20E900DD'];
const SPEED_KMH = 38;

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hash = (s) => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
const km = (a, b) => { const R = 6371, r = Math.PI / 180; const x = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lng - a.lng) * r / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
const camPlate = (v) => v[3] || v[1].replace(/[АВЕКМНОРСТУХ]/g, (c) => ({ А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', У: 'Y', Х: 'X' })[c]).replace(/\s/g, '');

class Sim {
  constructor({ yard }) {
    this.yard = { lat: yard.lat, lng: yard.lng };
    this.plans = new Map();
  }

  /** Day plan for one vehicle: [{type: 'yard'|'drive'|'site', start, end, from, to, addr}] covering the day. */
  plan(id, day) {
    const key = `${id}:${day}`;
    if (this.plans.has(key)) return this.plans.get(key);
    const r = rng(hash(key));
    const start = T.dayStart(day), end = start + T.DAY;
    const segs = [];
    const yardPt = { lat: this.yard.lat + (r() - 0.5) * 0.0009, lng: this.yard.lng + (r() - 0.5) * 0.0012 };
    if (PARKED.has(id)) {
      const s = SITES[hash(id) % SITES.length];
      segs.push({ type: 'site', start, end, from: s, to: s, addr: s.addr });
    } else {
      const off = r() < 0.12; // a day off now and then
      let t = start + (6.5 + r() * 2) * 3600e3;
      const stopAt = start + (18.5 + r() * 2) * 3600e3;
      segs.push({ type: 'yard', start, end: t, from: yardPt, to: yardPt, addr: YARD_ADDR });
      while (!off && t < stopAt) {
        const load = (18 + r() * 22) * 60e3;
        segs.push({ type: 'yard', start: t, end: t + load, from: yardPt, to: yardPt, addr: YARD_ADDR });
        t += load;
        const site = SITES[Math.floor(r() * SITES.length)];
        const dest = { lat: site.lat + (r() - 0.5) * 0.01, lng: site.lng + (r() - 0.5) * 0.01 };
        const dist = km(yardPt, dest) * 1.3;
        const drive = (dist / SPEED_KMH) * 3600e3;
        segs.push({ type: 'drive', start: t, end: t + drive, from: yardPt, to: dest, km: dist });
        t += drive;
        const unload = (20 + r() * 35) * 60e3;
        segs.push({ type: 'site', start: t, end: t + unload, from: dest, to: dest, addr: site.addr, idle: r() < 0.5 });
        t += unload;
        segs.push({ type: 'drive', start: t, end: t + drive, from: dest, to: yardPt, km: dist });
        t += drive;
      }
      segs.push({ type: 'yard', start: t, end: Math.max(end, t + 1), from: yardPt, to: yardPt, addr: YARD_ADDR });
    }
    segs.yardPt = yardPt;
    this.plans.set(key, segs);
    if (this.plans.size > 2000) this.plans.delete(this.plans.keys().next().value);
    return segs;
  }

  segAt(id, t) {
    const segs = this.plan(id, T.dayOf(t));
    return segs.find((s) => s.start <= t && t < s.end) || segs[segs.length - 1];
  }

  position(id, t) {
    const s = this.segAt(id, t);
    if (s.type !== 'drive') {
      const idle = s.type === 'yard' ? (Math.floor(t / 300e3) % 4 === 0) : s.idle;
      return { lat: s.from.lat, lng: s.from.lng, speed: idle ? 0 : 0, state: idle ? 2 : 3, course: 0, address: s.addr };
    }
    const f = (t - s.start) / (s.end - s.start);
    const bend = Math.sin(f * Math.PI) * 0.004;
    const lat = s.from.lat + (s.to.lat - s.from.lat) * f + bend;
    const lng = s.from.lng + (s.to.lng - s.from.lng) * f - bend;
    const course = (Math.atan2(s.to.lng - s.from.lng, s.to.lat - s.from.lat) * 180) / Math.PI;
    const speed = SPEED_KMH + Math.sin(t / 37e3) * 14 + (hash(`${id}:${Math.floor(t / 60e3)}`) % 100 === 0 ? 50 : 0);
    return { lat, lng, speed: Math.max(6, speed), state: 4, course: (course + 360) % 360, address: 'Ташкент, Узбекистан' };
  }

  /** Yard departures/arrivals of one vehicle in [from, to): [{t, kind: 'out'|'in'}]. */
  crossings(id, from, to) {
    const out = [];
    for (const day of T.daysBetween(T.dayOf(from), T.dayOf(to - 1))) {
      for (const s of this.plan(id, day)) {
        if (s.type !== 'drive') continue;
        const leaving = s.from === this.plan(id, day).yardPt;
        const t = leaving ? s.start + 8e3 : s.end - 15e3;
        if (t >= from && t < to) out.push({ t, kind: leaving ? 'out' : 'in' });
      }
    }
    return out;
  }
}

/** Fake GoGPS client with the same interface as GpsClient. */
class MockGps {
  constructor({ sim, dataDir = '' }) { this.sim = sim; this.dataDir = dataDir; this.lastOk = 0; this.lastError = null; }
  _check() {
    const f = mockFail(this.dataDir);
    if (f === 'internet' || f === 'gps_down') throw new Error('/api/v3/vehicles/getlastdata: timeout');
    if (f === 'gps_auth') throw new Error('GPS login failed (HTTP 401)');
  }
  async vehicles() { this.lastOk = Date.now(); return FLEET.map(([id, name, model]) => ({ id, guid: null, name, model })); }
  async lastData(ids) {
    this._check();
    const now = Date.now();
    this.lastOk = now;
    return ids.map((id) => {
      const v = FLEET.find((x) => x[0] === id);
      if (!v) return null;
      const rec = DEAD.has(id) ? now - (2 + (id % 4)) * T.DAY : now - 10e3 - (id % 7) * 1000;
      const p = this.sim.position(id, rec);
      return { vehicleId: id, vehicleNumber: v[1], recordTime: new Date(rec).toISOString(), receiveTime: new Date(rec + 2000).toISOString(),
        state: DEAD.has(id) ? 1 : p.state, speed: DEAD.has(id) ? 0 : Math.round(p.speed), course: Math.round(p.course), latitude: +p.lat.toFixed(6), longitude: +p.lng.toFixed(6), address: p.address, geozones: [] };
    }).filter(Boolean);
  }
  _stats(id, from, to) {
    let kmSum = 0, drive = 0, idle = 0, onSite = 0;
    if (DEAD.has(id) || PARKED.has(id)) return { km: 0, drive: 0, idle: PARKED.has(id) ? 3 * 3600 : 0 };
    for (const day of T.daysBetween(T.dayOf(from), T.dayOf(to - 1))) {
      for (const s of this.sim.plan(id, day)) {
        const a = Math.max(s.start, from), b = Math.min(s.end, to);
        if (b <= a) continue;
        if (s.type === 'drive') { kmSum += s.km * ((b - a) / (s.end - s.start)); drive += (b - a) / 1000; }
        else if (s.type === 'site') { onSite += (b - a) / 1000; if (s.idle) idle += (b - a) / 1000 * 0.6; }
      }
    }
    return { km: kmSum, drive, idle: idle + drive * 0.08, onSite };
  }
  async mileage(ids, from, to) {
    return ids.map((id) => {
      const s = this._stats(id, from, to);
      const odo = 40000 + (id % 97) * 1000 + this._stats(id, from - 30 * T.DAY, from).km;
      return { vehicleId: id, periods: [{ start: T.localIso(from), end: T.localIso(to), mileage: +s.km.toFixed(3), mileageBegin: +odo.toFixed(3), mileageEnd: +(odo + s.km).toFixed(3), motohours: Math.round(s.drive + s.idle), idlingTime: Math.round(s.idle) }] };
    });
  }
  async fuel(ids, from, to) {
    return ids.map((id) => {
      if (!FUEL_SENSOR.has(id)) return { vehicleId: id, periods: [{ fuelLevelStart: 0, fuelLevelEnd: 0, fuelConsumption: 0 }] };
      const s = this._stats(id, from, to);
      const used = s.km * 0.36 + s.idle / 3600 * 2.5;
      const start = 80 + (hash(`${id}:${from}`) % 120);
      return { vehicleId: id, periods: [{ fuelLevelStart: start, fuelLevelEnd: Math.max(20, start - used), fuelConsumption: +used.toFixed(1) }] };
    });
  }
  async fuelInOut(ids, from, to) {
    return ids.map((id) => {
      const fuels = [];
      if (FUEL_SENSOR.has(id)) {
        for (const day of T.daysBetween(T.dayOf(from), T.dayOf(to - 1))) {
          const r = rng(hash(`fuel:${id}:${day}`));
          const t = T.dayStart(day) + 7.4 * 3600e3 + r() * 1800e3;
          if (r() < 0.5 && t >= from && t < to) fuels.push({ event: 'FuelIn', startDate: T.localIso(t), endDate: T.localIso(t + 300e3), valueFuel: Math.round(110 + r() * 80) });
          const d = T.dayStart(day) + 21.6 * 3600e3;
          if (hash(`drain:${id}:${day}`) % 23 === 0 && d >= from && d < to) fuels.push({ event: 'FuelOut', startDate: T.localIso(d), endDate: T.localIso(d + 600e3), valueFuel: 32 + (hash(day) % 20) });
        }
      }
      return { vehicleId: id, fuels };
    });
  }
  async moveStop(ids, from, to) {
    return ids.map((id) => {
      const moves = [], stops = [];
      for (const day of T.daysBetween(T.dayOf(from), T.dayOf(to - 1))) {
        for (const s of this.sim.plan(id, day)) {
          const a = Math.max(s.start, from), b = Math.min(s.end, to);
          if (b <= a) continue;
          if (s.type === 'drive') moves.push({ start: T.localIso(a), end: T.localIso(b), duration: Math.round((b - a) / 1000), mileage: +(s.km * (b - a) / (s.end - s.start)).toFixed(3) });
          else if (stops.length && stops[stops.length - 1].address === s.addr && T.parseApiTime(stops[stops.length - 1].end) === a) {
            const last = stops[stops.length - 1]; last.end = T.localIso(b); last.duration = Math.round((b - T.parseApiTime(last.start)) / 1000);
          } else stops.push({ start: T.localIso(a), end: T.localIso(b), duration: Math.round((b - a) / 1000), address: s.addr });
        }
      }
      return { vehicleId: id, moves, stops };
    });
  }
}

/**
 * Simulated failures for trying the health monitor: write one word into <DATA_DIR>/mock_fail
 * (internet, site, nvr_off, nvr_auth, camera_off, camera_blind, gps_down, gps_auth); delete the file to recover.
 */
function mockFail(dataDir) {
  try { return require('node:fs').readFileSync(require('node:path').join(dataDir, 'mock_fail'), 'utf8').trim(); } catch { return ''; }
}
const netError = (code, msg) => Object.assign(new Error(msg || code), { code });

/** Fake NVR: captures at every yard crossing in the plans, plus outside vehicles. Same interface as NVR. */
class MockNvr {
  constructor({ sim, cameras, dataDir = '' }) {
    this.sim = sim;
    this.dataDir = dataDir;
    this.inCam = cameras.find((c) => c.direction === 'in');
    this.outCam = cameras.find((c) => c.direction === 'out');
    this.lastOk = 0;
    this.lastStream = 0;
  }
  _caps(from, to) {
    const caps = [];
    const stamp = (t) => T.localIso(t).replace(/[-:T]/g, '');
    for (const v of FLEET) {
      if (DEAD.has(v[0]) || PARKED.has(v[0])) continue;
      for (const c of this.sim.crossings(v[0], from, to)) {
        const r = rng(hash(`cap:${v[0]}:${c.t}`));
        const cam = c.kind === 'in' ? this.inCam : this.outCam;
        const read = c.kind === 'in' ? r() < 0.97 : r() < 0.6;
        const t = c.t + (c.kind === 'out' ? -3e3 : 2e3);
        caps.push({ channel: cam.channel, time: Math.floor(t / 1000) * 1000, plate: read ? camPlate(v) : null, name: `ch${String(cam.channel).padStart(2, '0')}_${stamp(t)}_${read ? camPlate(v) : 'UNKNOWN'}` });
      }
    }
    for (const day of T.daysBetween(T.dayOf(from), T.dayOf(to - 1))) {
      const r = rng(hash(`outside:${day}`));
      const n = 3 + Math.floor(r() * 6);
      for (let i = 0; i < n; i++) {
        const plate = OUTSIDE_PLATES[Math.floor(r() * OUTSIDE_PLATES.length)];
        const tin = T.dayStart(day) + (8 + r() * 10) * 3600e3, tout = tin + (12 + r() * 40) * 60e3;
        for (const [t, cam] of [[tin, this.inCam], [tout, this.outCam]]) {
          if (t >= from && t < to) caps.push({ channel: cam.channel, time: Math.floor(t / 1000) * 1000, plate, name: `ch${String(cam.channel).padStart(2, '0')}_${stamp(t)}_${plate}` });
        }
      }
    }
    return caps.map((c) => ({ ...c, uriPath: `/mock/picture?name=${c.name}` }));
  }
  _check() {
    const f = mockFail(this.dataDir);
    if (f === 'site' || f === 'internet') throw netError('ETIMEDOUT', 'NVR GET /ISAPI: timed out after 10000 ms');
    if (f === 'nvr_off') throw netError('ECONNREFUSED');
    if (f === 'nvr_auth') throw Object.assign(new Error('NVR GET: HTTP 401'), { status: 401 });
  }
  async ping() { this._check(); this.lastOk = Date.now(); return 200; }
  async channelStatus() {
    this._check();
    const f = mockFail(this.dataDir);
    return { 3: true, 4: f !== 'camera_off', 5: true, 6: true };
  }
  async searchCaptures(channel, from, to) {
    this._check();
    if (mockFail(this.dataDir) === 'camera_blind' && channel === this.inCam.channel) return [];
    this.lastOk = Date.now();
    return this._caps(from, Math.min(to, Date.now())).filter((c) => c.channel === channel).sort((a, b) => a.time - b.time);
  }
  async captureImage(cap) { this.lastOk = Date.now(); return image(cap.plate || 'UNKNOWN', `${cap.channel === this.inCam.channel ? this.inCam.name : this.outCam.name} · ${T.localIso(cap.time).replace('T', ' ')}`, true); }
  async snapshot(channel) { this.lastOk = Date.now(); return image('', `${channel === this.inCam.contextChannel ? this.inCam.contextName : this.outCam.contextName} · ${T.localIso(Date.now()).replace('T', ' ')}`, false); }
  anprEvents(onChannel, { signal } = {}) {
    let last = Date.now();
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        const now = Date.now();
        this.lastStream = this.lastOk = now;
        for (const c of this._caps(last, now)) onChannel(c.channel);
        last = now;
      }, 3000);
      signal?.addEventListener('abort', () => { clearInterval(timer); resolve(); });
    });
  }
}

let sharp = null;
try { sharp = require('sharp'); } catch { /* optional */ }
const TINY_JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');

async function image(plate, caption, anpr) {
  if (!sharp) return TINY_JPEG;
  const esc = (s) => String(s).replace(/[<&>]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3b4452"/><stop offset="1" stop-color="#1c2129"/></linearGradient></defs>
    <rect width="1280" height="720" fill="url(#g)"/>
    <path d="M0 720 L520 300 L760 300 L1280 720 Z" fill="#2a2f37"/>
    <path d="M636 320 L644 320 L652 720 L628 720 Z" fill="#c9c27a" opacity=".5"/>
    ${anpr ? `<rect x="420" y="250" width="440" height="300" rx="18" fill="#d9dde3"/><rect x="455" y="285" width="370" height="120" rx="10" fill="#9fb3c8"/>
    <rect x="490" y="440" width="300" height="70" rx="6" fill="#fff" stroke="#111" stroke-width="4"/>
    <text x="640" y="490" font-family="DejaVu Sans Mono, monospace" font-size="40" font-weight="700" text-anchor="middle" fill="#111">${esc(plate)}</text>`
    : `<rect x="560" y="380" width="160" height="230" rx="14" fill="#c7ccd4"/><rect x="580" y="400" width="120" height="70" rx="8" fill="#8da2b8"/>`}
    <rect x="0" y="0" width="1280" height="44" fill="rgba(0,0,0,.55)"/>
    <text x="16" y="30" font-family="DejaVu Sans, sans-serif" font-size="22" fill="#fff">${esc(caption)}${anpr ? ' · ' + esc(plate) : ''} · DEMO</text>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 70 }).toBuffer();
}

/** Starting vehicle types for the demo database. */
const MOCK_TYPES = { 22077: 'dump', 22078: 'dump', 21389: 'dump', 22238: 'dump', 22871: 'dump', 21390: 'dump', 22872: 'excavator' };

module.exports = { Sim, MockGps, MockNvr, MOCK_TYPES, FLEET, mockFail };
