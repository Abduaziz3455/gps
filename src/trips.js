'use strict';
/**
 * Trip record: one row per trip of a fleet vehicle. Left the yard, where it went, when it came back, km, fuel, photos.
 *
 * Nothing here is entered by hand and everything can be worked out again, like place_visits:
 *   yard_visits + gate_events   when it left and came back
 *   gps_segments                GoGPS's moves and stops, for km and addresses
 *   positions                   coordinates of a stop, and how far from the yard the truck got
 *   fuel_events                 refuels and drains during the trip
 * The destination is decided when a trip is read, so naming a place changes past trips at once.
 *
 * A trip runs from leaving the GPS circle to reaching it again, as the Telegram alerts count it. The camera's time is
 * used only when GPS has none (no tracker, or history older than the poller). The two aren't the same moment: real
 * trucks pass the exit camera and stand in the circle for up to 5 h (10 870 HAD, 5 Nov), and reach the circle and then
 * queue, overnight even, before the entry camera (10 873 HAD, 4-5 Nov). So a camera pass joins the GPS crossing that has
 * no opposite crossing between them, however long ago, instead of one within some window.
 *
 * GoGPS takes about 48 s to answer for one day of the whole fleet (measured 5 Nov 2026), and km from stored positions
 * came out 9% short, so its answer is fetched in the background on its own lane and stored. Pages only read SQLite.
 */
const bus = require('./bus');
const T = require('./time');
const { COUNTED } = require('./analytics');
const { haversineM, vehicleLabel, vehicleType } = require('./gps/normalize');

const MERGE_OUT_MS = 12 * 3600e3; // the longest a truck was seen standing after the exit camera, with margin
const MERGE_IN_MS = 24 * 3600e3; // overnight in the queue
const JITTER_MS = 10 * 60e3; // out of the circle and back this fast, unseen by the cameras, is a truck at its edge
const MIN_STOP_S = 5 * 60; // the rule of the stop marks on the map and of place visits
const MERGE_STOP_KM = 0.3; // GoGPS splits one stop with moves of a few metres (real: 0.001 km, 1 s)
const LONG_TRIP_MS = 24 * 3600e3;
const OPEN_MAX_MS = 24 * 3600e3; // out longer than this with no return seen: "not recorded" rather than "on the road"
const NEAR_YARD_M = 500; // a stop this close is the plant's own street (same as the reports' camera check)
const NEAR_TRIP_M = 1000; // never got farther than this: waiting or shuffling near the plant, not a trip
const NEAR_TRIP_KM = 2; // the same, for history with no positions to measure
const NEAR_TRIP_FAR_KM = 5; // more than this on the clock can't have stayed within that distance
const REBUILD_DAYS = 3; // recent trips are worked out again; records and corrections can arrive late
const TODAY_EVERY_MS = 15 * 60e3;
const BACKFILL_DAYS = 45;
const BACKFILL_GAP_MS = 60e3; // history goes slowly: GoGPS is shared with the live polling
const FUEL_EVERY_MS = 60e3;
const VERSION = 1; // bump when the rules change: everything is worked out again once
const LANE = { lane: 'bulk', retries: 2 };

/**
 * Exits and entries GPS saw, without a truck wobbling at the edge of the circle.
 * @param {{enter_t:number, exit_t:number|null, approx:number}[]} visits oldest first
 * @param {number[]} cameraTimes this vehicle's camera passes
 */
function gpsPasses(visits, cameraTimes = []) {
  const out = [];
  const seenByCamera = (a, b) => cameraTimes.some((t) => t >= a && t <= b);
  let skipEnter = false;
  for (let i = 0; i < visits.length; i++) {
    const v = visits[i], next = visits[i + 1];
    if (!v.approx && !skipEnter) out.push({ t: v.enter_t, dir: 'in', src: 'gps' });
    skipEnter = false;
    if (v.exit_t == null) continue;
    if (next && next.enter_t - v.exit_t < JITTER_MS && !seenByCamera(v.exit_t, next.enter_t)) skipEnter = true;
    else out.push({ t: v.exit_t, dir: 'out', src: 'gps' });
  }
  return out;
}

/**
 * Walks one vehicle's passes in time order into trips. A camera pass and a GPS crossing the same way, with no crossing
 * the other way between them, are one pass: GPS gives the time, the camera the photos. Two camera passes the same way
 * are two passes: the one between them went unseen.
 * @param {{t:number, dir:'in'|'out', src:'camera'|'gps', eventId?:number}[]} passes
 * @returns trips, oldest first; startT is null when no exit was seen, endT when no return was
 */
function pairPasses(passes) {
  const sorted = [...passes].sort((a, b) => a.t - b.t || (a.src === 'camera' ? -1 : 1));
  const trips = [];
  let cur = null, last = null;
  const blank = () => ({ startT: null, endT: null, startSrc: null, endSrc: null, outEvent: null, inEvent: null, lastOut: null, lastIn: null });
  const setStart = (trip, p) => {
    if (p.src === 'camera') trip.outEvent = p.eventId ?? null;
    if (p.src === 'gps' || trip.startSrc !== 'gps') Object.assign(trip, { startT: p.t, startSrc: p.src });
    trip.lastOut = p.t;
  };
  const setEnd = (trip, p) => {
    if (p.src === 'camera') trip.inEvent = p.eventId ?? null;
    // The first sign of being back: the truck is home from then on, whatever the queue does.
    if (trip.endT == null || (p.src === 'gps' && trip.endSrc !== 'gps')) Object.assign(trip, { endT: p.t, endSrc: p.src });
    trip.lastIn = p.t;
  };
  for (const p of sorted) {
    if (p.dir === 'out') {
      if (cur && p.t - cur.lastOut <= MERGE_OUT_MS && !(p.src === 'camera' && cur.outEvent != null)) { setStart(cur, p); continue; }
      if (cur) trips.push(cur);
      cur = blank();
      setStart(cur, p);
      last = null;
    } else if (cur) {
      setEnd(cur, p);
      trips.push(cur);
      last = cur;
      cur = null;
    } else if (last && p.t - last.lastIn <= MERGE_IN_MS && !(p.src === 'camera' && last.inEvent != null)) {
      setEnd(last, p);
    } else {
      last = blank();
      setEnd(last, p);
      trips.push(last);
    }
  }
  if (cur) trips.push(cur);
  return trips.sort((a, b) => (a.startT ?? a.endT) - (b.startT ?? b.endT));
}

/** Km inside [from, to]. A move partly inside counts for the share of its time that is. Null when GoGPS has none. */
function kmWithin(moves, from, to) {
  let km = 0, any = false;
  for (const m of moves) {
    if (m.end_t < from || m.start_t > to) continue;
    any = true;
    const a = Math.max(m.start_t, from), b = Math.min(m.end_t, to);
    km += m.end_t > m.start_t ? (m.km || 0) * ((b - a) / (m.end_t - m.start_t)) : (m.km || 0);
  }
  return any ? km : null;
}

/** A trip's stops of 5 min or more. Moves under 300 m don't end a stop. `segments` oldest first, both kinds. */
function stopsWithin(segments, from, to) {
  const out = [];
  let cur = null, gapKm = 0;
  const flush = () => { if (cur && (cur.e - cur.s) / 1000 >= MIN_STOP_S) out.push(cur); cur = null; };
  for (const s of segments) {
    if (s.end_t <= from || s.start_t >= to) continue;
    if (s.kind === 'move') {
      gapKm += s.km || 0;
      if (gapKm >= MERGE_STOP_KM) flush();
      continue;
    }
    const a = Math.max(s.start_t, from), b = Math.min(s.end_t, to);
    if (cur) { cur.e = b; cur.a = cur.a || s.address || null; } else cur = { s: a, e: b, a: s.address || null };
    gapKm = 0;
  }
  flush();
  return out;
}

const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

class Trips {
  constructor({ h, gps, places, config, log = console }) {
    this.h = h;
    this.gps = gps;
    this.places = places;
    this.cfg = config;
    this.log = log;
    this.stopped = false;
    this.queue = Promise.resolve(); // one rebuild at a time
    this.timers = [];
    this.pending = null;
    this.onGate = () => this.soon();
  }

  // --- GoGPS's moves and stops -------------------------------------------------------------------

  /** Store one day of moves and stops for the whole fleet. */
  async syncSegments(day) {
    const ids = this.h.all('SELECT id FROM vehicles WHERE in_gps = 1').map((r) => r.id);
    if (!ids.length || !this.gps) return false;
    const from = T.dayStart(day), to = Math.min(from + T.DAY, Date.now());
    const rows = await this.gps.moveStop(ids, from, to, LANE);
    this.storeSegments(day, rows);
    return true;
  }

  storeSegments(day, rows) {
    const from = T.dayStart(day), to = from + T.DAY;
    this.h.tx(() => {
      for (const v of rows) {
        const id = Number(v.vehicleId);
        // Only the trucks that came back in the answer: one left out of it keeps what is known.
        this.h.run('DELETE FROM gps_segments WHERE vehicle_id = ? AND start_t >= ? AND start_t < ?', id, from, to);
        const add = (kind, s, km, address) => {
          const a = T.parseApiTime(s.start), b = T.parseApiTime(s.end);
          if (a == null || b == null) return;
          this.h.run('INSERT OR REPLACE INTO gps_segments (vehicle_id, start_t, kind, end_t, km, address) VALUES (?, ?, ?, ?, ?, ?)', id, a, kind, b, km, address);
        };
        for (const m of v.moves || []) add('move', m, Number(m.mileage) || 0, null);
        for (const s of v.stops || []) add('stop', s, null, s.address || null);
      }
      this.h.run('INSERT OR REPLACE INTO gps_segment_days (day, synced_at) VALUES (?, ?)', day, Date.now());
    });
  }

  /** Days of history still to fetch, newest first: a past day counts once it was fetched after it ended. */
  daysToFetch(now = Date.now()) {
    const first = this.h.get('SELECT MIN(t) t FROM gate_events').t;
    if (first == null) return [];
    const today = T.dayOf(now);
    const oldest = T.addDays(today, -BACKFILL_DAYS);
    const days = [];
    for (let d = T.addDays(today, -1); d >= oldest && d >= T.dayOf(first); d = T.addDays(d, -1)) {
      const r = this.h.get('SELECT synced_at FROM gps_segment_days WHERE day = ?', d);
      if (!r || r.synced_at < T.dayStart(d) + T.DAY + 5 * 60e3) days.push(d);
    }
    return days;
  }

  // --- working trips out -------------------------------------------------------------------------

  /** Street names around the yard, from stops whose coordinates are known: tells the yard's stops in older history. */
  yardAddresses(now = Date.now()) {
    const y = this.cfg.yard;
    const seen = new Map();
    const stops = this.h.all("SELECT vehicle_id, start_t, end_t, address FROM gps_segments WHERE kind = 'stop' AND address IS NOT NULL AND start_t >= ? AND end_t - start_t >= ?", now - 14 * T.DAY, MIN_STOP_S * 1000);
    for (const s of stops) {
      const p = this.h.get('SELECT lat, lng FROM positions WHERE vehicle_id = ? AND t BETWEEN ? AND ? LIMIT 1', s.vehicle_id, s.start_t, s.end_t);
      if (!p) continue;
      const c = seen.get(s.address) || { near: 0, far: 0 };
      if (haversineM(p.lat, p.lng, y.lat, y.lng) <= NEAR_YARD_M) c.near++; else c.far++;
      seen.set(s.address, c);
    }
    return [...seen].filter(([, c]) => c.near >= 5 && c.near / (c.near + c.far) >= 0.7).map(([a]) => a);
  }

  /** Everything known about one pair of passes, ready to store. */
  describe(vehicleId, trip, yardAddrs) {
    const y = this.cfg.yard;
    const { startT, endT } = trip;
    const row = { ...trip, km: null, kmSrc: null, farM: null, near: 0, stops: [], refuel: 0, drain: 0 };
    if (startT == null || endT == null) return row;
    const segs = this.h.all('SELECT kind, start_t, end_t, km, address FROM gps_segments WHERE vehicle_id = ? AND end_t >= ? AND start_t <= ? ORDER BY start_t, kind', vehicleId, startT, endT);
    const pts = this.h.all('SELECT t, lat, lng FROM positions WHERE vehicle_id = ? AND t BETWEEN ? AND ? ORDER BY t', vehicleId, startT, endT);
    const km = kmWithin(segs.filter((s) => s.kind === 'move'), startT, endT);
    if (km != null) { row.km = km; row.kmSrc = 'gps'; } else if (pts.length > 1) {
      let m = 0;
      for (let i = 1; i < pts.length; i++) m += haversineM(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng);
      row.km = m / 1000;
      row.kmSrc = 'positions';
    }
    if (pts.length) row.farM = Math.round(Math.max(...pts.map((p) => haversineM(p.lat, p.lng, y.lat, y.lng))));
    row.stops = stopsWithin(segs, startT, endT).map((s) => {
      const p = pts.find((x) => x.t >= s.s && x.t <= s.e);
      const out = { s: s.s, e: s.e, a: s.a };
      if (p) { out.lat = p.lat; out.lng = p.lng; }
      const atYard = p ? haversineM(p.lat, p.lng, y.lat, y.lng) <= NEAR_YARD_M : yardAddrs.includes(s.a);
      if (atYard) out.y = 1;
      return out;
    });
    // Positions may cover only part of an old trip (they start on 3 Nov 2026), so distance alone can't say it stayed.
    const away = row.stops.some((s) => !s.y);
    const stayed = row.farM != null && row.farM <= NEAR_TRIP_M && (row.km == null || row.km < NEAR_TRIP_FAR_KM);
    row.near = stayed || (row.km != null && row.km < NEAR_TRIP_KM && !away) ? 1 : 0;
    const f = this.h.get("SELECT COALESCE(SUM(CASE kind WHEN 'refuel' THEN litres END), 0) r, COALESCE(SUM(CASE kind WHEN 'drain' THEN litres END), 0) d FROM fuel_events WHERE vehicle_id = ? AND t BETWEEN ? AND ?", vehicleId, startT, endT);
    row.refuel = f.r;
    row.drain = f.d;
    return row;
  }

  /**
   * Days away with several stops at the plant's street aren't one trip: the passes between them weren't recorded (no
   * cameras and no poller for days: 10-29 to 11-03, 491 km). Real long trips look different (49 h, 13 km, one such stop).
   * It is shown as what is known, an exit and a return, rather than as a trip that didn't happen.
   */
  whole(vehicleId, trip, yardAddrs) {
    const row = this.describe(vehicleId, trip, yardAddrs);
    if (row.startT == null || row.endT == null || row.endT - row.startT <= LONG_TRIP_MS) return [row];
    if (row.stops.filter((s) => s.y).length < 2) return [row];
    const out = { ...trip, endT: null, endSrc: null, inEvent: null };
    const back = { ...trip, startT: null, startSrc: null, outEvent: null };
    return [this.describe(vehicleId, out, yardAddrs), this.describe(vehicleId, back, yardAddrs)];
  }

  /** Work one vehicle's trips out again from `since`. Returns whether anything changed. */
  rebuildVehicle(vehicleId, since, yardAddrs, now = Date.now()) {
    const h = this.h;
    const anchor = 'COALESCE(start_t, end_t)';
    // A trip reaching into that time is redone whole, and so is the one before: a pass may yet join it.
    const open = h.get(`SELECT MIN(${anchor}) t FROM trips WHERE vehicle_id = ? AND COALESCE(end_t, ?) >= ?`, vehicleId, now, since).t;
    let from = Math.min(since, open ?? since);
    const prev = h.get(`SELECT MAX(${anchor}) t FROM trips WHERE vehicle_id = ? AND ${anchor} < ?`, vehicleId, from).t;
    if (prev != null) from = prev;
    // Passes from further back only set the walk's state: anything anchored before `from` stays as stored.
    const back = from - MERGE_IN_MS - MERGE_OUT_MS;
    const events = h.all(`SELECT id, t, direction FROM gate_events WHERE vehicle_id = ? AND t >= ? AND status IN ${COUNTED} ORDER BY t`, vehicleId, back);
    const visits = h.all('SELECT enter_t, exit_t, approx FROM yard_visits WHERE vehicle_id = ? AND COALESCE(exit_t, enter_t) >= ? ORDER BY enter_t', vehicleId, back);
    const passes = [...events.map((e) => ({ t: e.t, dir: e.direction, src: 'camera', eventId: e.id })), ...gpsPasses(visits, events.map((e) => e.t))];
    const fresh = pairPasses(passes).filter((t) => (t.startT ?? t.endT) >= from).flatMap((t) => this.whole(vehicleId, t, yardAddrs));
    const stored = h.all(`SELECT * FROM trips WHERE vehicle_id = ? AND ${anchor} >= ? ORDER BY ${anchor}`, vehicleId, from);
    const key = (s, e) => `${s ?? ''}:${e ?? ''}`;
    const fuelKnown = new Map(stored.filter((r) => r.fuel_checked).map((r) => [key(r.start_t, r.end_t), r.fuel_used]));
    const sig = (t) => JSON.stringify([t.start_t, t.end_t, t.start_src, t.end_src, t.out_event, t.in_event, r1(t.km), t.km_src, t.far_m, t.near, t.stops, t.refuel_l, t.drain_l]);
    const asRow = (t) => ({ start_t: t.startT, end_t: t.endT, start_src: t.startSrc, end_src: t.endSrc, out_event: t.outEvent, in_event: t.inEvent, km: t.km, km_src: t.kmSrc, far_m: t.farM, near: t.near, stops: JSON.stringify(t.stops), refuel_l: t.refuel, drain_l: t.drain });
    const rows = fresh.map(asRow);
    // What didn't change stays as it is, with its id: a row can be open on someone's screen.
    let same = 0;
    while (same < rows.length && same < stored.length && sig(rows[same]) === sig(stored[same])) same++;
    if (same === rows.length && same === stored.length) return false;
    h.tx(() => {
      for (const r of stored.slice(same)) h.run('DELETE FROM trips WHERE id = ?', r.id);
      for (const r of rows.slice(same)) {
        const k = key(r.start_t, r.end_t);
        h.run(`INSERT INTO trips (vehicle_id, day, start_t, end_t, start_src, end_src, out_event, in_event, km, km_src, far_m, near, stops, refuel_l, drain_l, fuel_used, fuel_checked)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, vehicleId, T.dayOf(r.start_t ?? r.end_t), r.start_t, r.end_t, r.start_src, r.end_src, r.out_event, r.in_event,
        r.km, r.km_src, r.far_m, r.near, r.stops, r.refuel_l, r.drain_l, fuelKnown.get(k) ?? null, fuelKnown.has(k) ? 1 : 0);
      }
    });
    return true;
  }

  _enqueue(fn) {
    this.queue = this.queue.then(fn).catch((e) => this.log.warn?.(`trips: ${e.message}`));
    return this.queue;
  }

  /** Work trips out again from `since` for the whole fleet; giving way to other requests between vehicles. */
  rebuild(since = Date.now() - REBUILD_DAYS * T.DAY) {
    return this._enqueue(async () => {
      const yardAddrs = this.yardAddresses();
      let changed = false;
      for (const { id } of this.h.all('SELECT id FROM vehicles')) {
        if (this.stopped) return;
        if (this.rebuildVehicle(id, since, yardAddrs)) changed = true;
        await new Promise((r) => { setImmediate(r); });
      }
      if (changed) bus.emit('trips');
    });
  }

  /** After a gate event: soon, and only once for a burst of them. */
  soon(ms = 10e3) {
    clearTimeout(this.pending);
    this.pending = setTimeout(() => this.rebuild(), ms);
  }

  // --- fuel --------------------------------------------------------------------------------------

  /** One finished trip's fuel, for a truck whose sensor reported that day. Only GoGPS knows it for a stretch of time. */
  async fuelStep() {
    const t = this.h.get(`SELECT t.* FROM trips t JOIN vehicles v ON v.id = t.vehicle_id AND v.in_gps = 1
      WHERE t.fuel_checked = 0 AND t.near = 0 AND t.start_t IS NOT NULL AND t.end_t IS NOT NULL ORDER BY t.end_t DESC LIMIT 1`);
    if (!t || !this.gps) return false;
    const sensor = this.h.get('SELECT 1 FROM daily_stats WHERE vehicle_id = ? AND day = ? AND (fuel_used > 0 OR fuel_end > 0)', t.vehicle_id, t.day);
    let used = null;
    if (sensor) {
      const rows = await this.gps.fuel([t.vehicle_id], t.start_t, t.end_t, 86400, LANE);
      const row = rows.find((r) => Number(r.vehicleId) === t.vehicle_id);
      used = (row?.periods || []).reduce((a, p) => a + (Number(p.fuelConsumption) || 0), 0);
    }
    this.h.run('UPDATE trips SET fuel_used = ?, fuel_checked = 1 WHERE id = ?', used, t.id);
    return true;
  }

  // --- reading -----------------------------------------------------------------------------------

  view(t, v, now = Date.now()) {
    const stops = JSON.parse(t.stops || '[]').map((s) => {
      const place = s.lat != null ? this.places?.at(s.lat, s.lng) : null;
      return { startT: s.s, endT: s.e, seconds: Math.round((s.e - s.s) / 1000), address: s.a, lat: s.lat ?? null, lng: s.lng ?? null, atYard: !!s.y, place: place ? { id: place.id, name: place.name } : null };
    });
    const away = stops.filter((s) => !s.atYard);
    const longest = (list) => list.reduce((a, b) => (b.seconds > (a?.seconds ?? -1) ? b : a), null);
    const main = longest(away.filter((s) => s.place)) || longest(away);
    const state = t.start_t == null ? 'no_exit' : t.end_t != null ? 'done' : now - t.start_t > OPEN_MAX_MS ? 'no_return' : 'open';
    return {
      id: t.id, vehicleId: t.vehicle_id, label: vehicleLabel(v), type: vehicleType(v), gpsName: v.name, day: t.day,
      startT: t.start_t, endT: t.end_t, startSrc: t.start_src, endSrc: t.end_src, state, near: !!t.near,
      durationS: t.start_t != null && t.end_t != null ? Math.round((t.end_t - t.start_t) / 1000) : null,
      km: r1(t.km), kmSrc: t.km_src, farM: t.far_m, fuelUsed: r1(t.fuel_used), refuelL: r1(t.refuel_l), drainL: r1(t.drain_l),
      outEventId: t.out_event, inEventId: t.in_event, stops,
      destination: main ? { name: main.place?.name || null, placeId: main.place?.id ?? null, address: main.address, lat: main.lat, lng: main.lng, seconds: main.seconds } : null,
    };
  }

  /** Trips for a range of days, newest first, with totals for the same selection. Trucks turned off in Settings stay out. */
  list({ from, to, vehicle = null, place = null, near = false, limit = 5000 }) {
    const where = ['t.day BETWEEN ? AND ?', 'v.active = 1'], args = [from, to];
    if (vehicle != null) { where.push('t.vehicle_id = ?'); args.push(vehicle); }
    const rows = this.h.all(`SELECT t.*, v.name, v.plate, v.display, v.type FROM trips t JOIN vehicles v ON v.id = t.vehicle_id
      WHERE ${where.join(' AND ')} ORDER BY COALESCE(t.start_t, t.end_t) DESC, t.id DESC`, ...args)
      .map((t) => this.view(t, { name: t.name, plate: t.plate, display: t.display, type: t.type }));
    const atPlace = place == null ? rows : rows.filter((t) => t.stops.some((s) => s.place?.id === place));
    const nearCount = atPlace.filter((t) => t.near).length;
    const shown = near ? atPlace : atPlace.filter((t) => !t.near);
    return { trips: shown.slice(0, limit), truncated: shown.length > limit, nearCount, totals: this.totals(shown), destinations: this.destinations(shown) };
  }

  totals(rows) {
    const whole = rows.filter((t) => t.durationS != null);
    const fuelled = rows.filter((t) => t.fuelUsed != null);
    return {
      trips: rows.length,
      vehicles: new Set(rows.map((t) => t.vehicleId)).size,
      complete: whole.length,
      km: r1(rows.reduce((a, t) => a + (t.km || 0), 0)),
      fuelUsed: fuelled.length ? r1(fuelled.reduce((a, t) => a + t.fuelUsed, 0)) : null,
      avgDurationS: whole.length ? Math.round(whole.reduce((a, t) => a + t.durationS, 0) / whole.length) : null,
    };
  }

  /** Where the trips went: named places first by trips, then addresses. */
  destinations(rows, max = 20) {
    const map = new Map();
    for (const t of rows) {
      const d = t.destination;
      if (!d) continue;
      const key = d.placeId ? `p${d.placeId}` : `a${d.address || ''}`;
      if (!map.has(key)) map.set(key, { name: d.name, placeId: d.placeId, address: d.address, trips: 0, vehicles: new Set(), km: 0, seconds: 0 });
      const x = map.get(key);
      x.trips++;
      x.vehicles.add(t.vehicleId);
      x.km += t.km || 0;
      x.seconds += d.seconds;
    }
    return [...map.values()].sort((a, b) => Number(!a.placeId) - Number(!b.placeId) || b.trips - a.trips).slice(0, max)
      .map((x) => ({ name: x.name, placeId: x.placeId, address: x.address, trips: x.trips, vehicles: x.vehicles.size, avgKm: r1(x.km / x.trips), avgStayMin: Math.round(x.seconds / x.trips / 60) }));
  }

  // --- running -----------------------------------------------------------------------------------

  start() {
    bus.on('gate', this.onGate);
    bus.on('gate:update', this.onGate);
    const later = (fn, ms) => { const t = setTimeout(fn, ms); this.timers.push(t); };
    const first = async () => {
      if (this.h.kvGet('trips_version') !== VERSION) {
        await this.rebuild(0);
        this.h.kvSet('trips_version', VERSION);
      } else await this.rebuild();
    };
    later(first, 10e3);
    if (!this.gps) return;
    const today = async () => {
      try {
        await this.syncSegments(T.today());
        await this.rebuild();
      } catch (e) { this.log.warn?.(`trips: moves and stops of today: ${e.message}`); }
      if (!this.stopped) later(today, TODAY_EVERY_MS);
    };
    later(today, 60e3);
    const backfill = async () => {
      const [day] = this.daysToFetch();
      if (day) {
        try {
          await this.syncSegments(day);
          await this.rebuild(T.dayStart(day) - T.DAY);
          this.log.info?.(`trips: moves and stops of ${day} stored`);
        } catch (e) { this.log.warn?.(`trips: moves and stops of ${day}: ${e.message}`); }
      }
      if (!this.stopped) later(backfill, day ? BACKFILL_GAP_MS : 3600e3);
    };
    later(backfill, 3 * 60e3);
    const fuel = async () => {
      try { await this.fuelStep(); } catch (e) { this.log.warn?.(`trips: fuel: ${e.message}`); }
      if (!this.stopped) later(fuel, FUEL_EVERY_MS);
    };
    later(fuel, 4 * 60e3);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.pending);
    for (const t of this.timers) clearTimeout(t);
    bus.off('gate', this.onGate);
    bus.off('gate:update', this.onGate);
  }
}

module.exports = { Trips, gpsPasses, pairPasses, kmWithin, stopsWithin, MERGE_OUT_MS, MERGE_IN_MS, JITTER_MS, OPEN_MAX_MS, NEAR_TRIP_M, NEAR_TRIP_KM };
