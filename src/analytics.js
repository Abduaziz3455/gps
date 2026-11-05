'use strict';
/**
 * Trips: a vehicle-day's trips are max(identified exits, identified entries). The exit camera reads fewer
 * plates (42% vs 97% at the entry, docs/site-survey.md) and history has no GPS to identify unread exits,
 * so counting exits alone would undercount.
 *
 * Analytics: per-vehicle daily totals (rollups) and the queries behind the dashboards.
 *
 * A day's totals come from three GoGPS reports for the whole fleet (mileage + engine hours, fuel, refuels and
 * drains) plus local tables (gate events, positions). Today is recomputed every 10 min; past days once.
 * Pages read only SQLite, so they are instant and never touch the GPS rate limit.
 */
const bus = require('./bus');
const T = require('./time');
const { vehicleLabel, prettyPlate, normalizeFuelEvent } = require('./gps/normalize');

const COUNTED = "('confirmed','unconfirmed','history')"; // real passes (vetoed maneuvers and pending excluded)
const TURNAROUND_MAX_MS = 12 * 3600e3;

const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

class Analytics {
  constructor({ h, gps, config, log = console }) {
    this.h = h;
    this.gps = gps;
    this.cfg = config;
    this.log = log;
    this.timer = null;
  }

  // --- rollups ---------------------------------------------------------------------------------

  /** Gate-derived columns for a day, from local tables only. */
  gateStats(day) {
    const from = T.dayStart(day), to = from + T.DAY;
    const out = new Map();
    const get = (id) => {
      if (!out.has(id)) out.set(id, { trips_out: 0, trips_in: 0, first_out: null, last_in: null, yard_s: null, turnaround_s: null, max_speed: null });
      return out.get(id);
    };
    const evs = this.h.all(`SELECT vehicle_id, direction, t, stay_s FROM gate_events
      WHERE vehicle_id IS NOT NULL AND status IN ${COUNTED} AND t >= ? AND t < ? ORDER BY t`, from, to);
    for (const e of evs) {
      const s = get(e.vehicle_id);
      if (e.direction === 'out') {
        s.trips_out++;
        if (s.first_out == null) s.first_out = e.t;
        if (e.stay_s) s.yard_s = (s.yard_s || 0) + e.stay_s;
      } else {
        s.trips_in++;
        s.last_in = e.t;
      }
    }
    // Turnaround: each exit to the same vehicle's next entry (within 12 h; may fall on the next day).
    const outs = evs.filter((e) => e.direction === 'out');
    const sums = new Map();
    for (const e of outs) {
      const next = this.h.get(`SELECT MIN(t) t FROM gate_events WHERE vehicle_id = ? AND direction = 'in'
        AND status IN ${COUNTED} AND t > ? AND t < ?`, e.vehicle_id, e.t, e.t + TURNAROUND_MAX_MS)?.t;
      if (next) {
        const a = sums.get(e.vehicle_id) || [0, 0];
        sums.set(e.vehicle_id, [a[0] + (next - e.t) / 1000, a[1] + 1]);
      }
    }
    for (const [id, [sum, n]] of sums) get(id).turnaround_s = Math.round(sum / n);
    for (const r of this.h.all('SELECT vehicle_id, MAX(speed) s FROM positions WHERE t >= ? AND t < ? GROUP BY vehicle_id', from, to)) {
      get(r.vehicle_id).max_speed = r.s;
    }
    return out;
  }

  /** Recompute one day. `withGps` false: only the gate/positions columns (no GoGPS requests). */
  async rollup(day, { withGps = true } = {}) {
    // Trucks with no tracker are counted by the cameras, and GoGPS isn't asked about them.
    const ids = this.h.all('SELECT id FROM vehicles WHERE in_gps = 1 OR camera_only = 1').map((r) => r.id);
    const gpsIds = this.h.all('SELECT id FROM vehicles WHERE in_gps = 1').map((r) => r.id);
    if (!ids.length) return;
    const from = T.dayStart(day), to = Math.min(from + T.DAY, Date.now());
    const gps = new Map();
    const g = (id) => { if (!gps.has(id)) gps.set(id, { refuel_l: 0, drain_l: 0 }); return gps.get(id); };
    const fuelEvents = [];
    if (withGps && this.gps && to > from && gpsIds.length) {
      const [mil, fuel, inout] = await Promise.all([
        this.gps.mileage(gpsIds, from, to, 86400),
        this.gps.fuel(gpsIds, from, to, 86400),
        this.gps.fuelInOut(gpsIds, from, to),
      ]);
      for (const v of mil) {
        const ps = v.periods || [];
        const s = g(Number(v.vehicleId));
        s.km = ps.reduce((a, p) => a + (Number(p.mileage) || 0), 0);
        s.engine_s = ps.reduce((a, p) => a + (Number(p.motohours) || 0), 0);
        s.idle_s = ps.reduce((a, p) => a + (Number(p.idlingTime) || 0), 0);
        const last = ps[ps.length - 1];
        s.odometer = last && Number(last.mileageEnd) ? Number(last.mileageEnd) : null;
      }
      for (const v of fuel) {
        const ps = v.periods || [];
        const used = ps.reduce((a, p) => a + (Number(p.fuelConsumption) || 0), 0);
        const start = Number(ps[0]?.fuelLevelStart) || 0, end = Number(ps[ps.length - 1]?.fuelLevelEnd) || 0;
        if (used || start || end) Object.assign(g(Number(v.vehicleId)), { fuel_used: used, fuel_start: start, fuel_end: end });
      }
      for (const v of inout) {
        for (const f of v.fuels || []) {
          const e = normalizeFuelEvent(f);
          if (!e) continue;
          const s = g(Number(v.vehicleId));
          if (e.kind === 'refuel') s.refuel_l += e.litres; else s.drain_l += e.litres;
          fuelEvents.push({ vehicle_id: Number(v.vehicleId), ...e });
        }
      }
    }
    const gate = this.gateStats(day);
    const now = Date.now();
    this.h.tx(() => {
      for (const id of ids) {
        const a = gps.get(id) || {}, b = gate.get(id) || {};
        const prev = this.h.get('SELECT * FROM daily_stats WHERE day = ? AND vehicle_id = ?', day, id);
        const keep = (k, d) => (k in a ? a[k] : prev ? prev[k] : d);
        this.h.run(`INSERT OR REPLACE INTO daily_stats (day, vehicle_id, km, engine_s, idle_s, fuel_used, fuel_start, fuel_end,
          refuel_l, drain_l, odometer, trips_out, trips_in, turnaround_s, yard_s, max_speed, first_out, last_in, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        day, id, keep('km', 0), Math.round(keep('engine_s', 0)), Math.round(keep('idle_s', 0)), keep('fuel_used', null),
        keep('fuel_start', null), keep('fuel_end', null), withGps ? a.refuel_l || 0 : prev?.refuel_l || 0,
        withGps ? a.drain_l || 0 : prev?.drain_l || 0, keep('odometer', null),
        b.trips_out || 0, b.trips_in || 0, b.turnaround_s ?? null, b.yard_s ?? null, b.max_speed ?? null,
        b.first_out ?? null, b.last_in ?? null, withGps ? now : prev?.updated_at || 0);
      }
      for (const f of fuelEvents) {
        const r = this.h.run('INSERT OR IGNORE INTO fuel_events (vehicle_id, t, kind, litres) VALUES (?, ?, ?, ?)', f.vehicle_id, f.t, f.kind, f.litres);
        if (r.changes) bus.emit('fuel', f);
      }
    });
  }

  /** Days in the last `days` that were never computed after they ended. */
  staleDays(days) {
    const today = T.today();
    const out = [];
    for (let i = days; i >= 1; i--) {
      const d = T.addDays(today, -i);
      const r = this.h.get('SELECT MIN(updated_at) u FROM daily_stats WHERE day = ?', d);
      if (!r || !r.u || r.u < T.dayStart(d) + T.DAY + 20 * 60e3) out.push(d);
    }
    return out;
  }

  start() {
    const run = async () => {
      try {
        for (const d of this.staleDays(30)) {
          await this.rollup(d);
          this.log.info?.(`rollup ${d} done`);
        }
        await this.rollup(T.today());
        this.h.kvSet('rollup_at', Date.now());
      } catch (e) {
        this.log.warn?.(`rollup failed: ${e.message}`);
      }
      this.timer = setTimeout(run, 10 * 60e3);
    };
    this.timer = setTimeout(run, 15e3);
    // Gate columns follow camera events quickly (no GPS requests).
    let pending = null;
    const local = () => { clearTimeout(pending); pending = setTimeout(() => this.rollup(T.today(), { withGps: false }).catch(() => {}), 5000); };
    bus.on('gate', local);
    bus.on('gate:update', local);
  }

  stop() { clearTimeout(this.timer); }

  // --- queries ---------------------------------------------------------------------------------

  vehicles() {
    return this.h.all('SELECT * FROM vehicles WHERE active = 1 ORDER BY name');
  }

  /** Fleet totals for [from, to] (days), plus the previous period of the same length for comparison. */
  overview(from, to) {
    const n = T.daysBetween(from, to).length;
    const prevTo = T.addDays(from, -1), prevFrom = T.addDays(from, -n);
    const cur = this._totals(from, to), prev = this._totals(prevFrom, prevTo);
    return { from, to, days: n, current: cur, previous: prev, previousRange: { from: prevFrom, to: prevTo } };
  }

  _totals(from, to) {
    const s = this.h.get(`SELECT COALESCE(SUM(km),0) km, COALESCE(SUM(engine_s),0) engine_s, COALESCE(SUM(idle_s),0) idle_s,
      SUM(fuel_used) fuel_used, COALESCE(SUM(refuel_l),0) refuel_l, COALESCE(SUM(drain_l),0) drain_l,
      COALESCE(SUM(MAX(trips_out, trips_in)),0) trips, COALESCE(SUM(trips_in),0) trips_in,
      SUM(CASE WHEN fuel_used IS NOT NULL THEN km END) km_fuel,
      COUNT(DISTINCT CASE WHEN MAX(trips_out, trips_in) > 0 OR km >= 5 THEN day || ':' || vehicle_id END) active_days,
      COUNT(DISTINCT CASE WHEN km > 0 OR engine_s > 0 OR trips_out > 0 THEN day || ':' || vehicle_id END) reporting_days
      FROM daily_stats d JOIN vehicles v ON v.id = d.vehicle_id AND v.active = 1 WHERE day BETWEEN ? AND ?`, from, to);
    const vehiclesTotal = this.h.get('SELECT COUNT(*) n FROM vehicles WHERE active = 1 AND in_gps = 1').n;
    const days = T.daysBetween(from, to).length;
    const ta = this.h.get(`SELECT SUM(turnaround_s * trips_out) w, SUM(CASE WHEN turnaround_s IS NOT NULL THEN trips_out END) n
      FROM daily_stats d JOIN vehicles v ON v.id = d.vehicle_id AND v.active = 1 WHERE day BETWEEN ? AND ?`, from, to);
    const start = T.dayStart(from), end = T.dayStart(to) + T.DAY;
    const stay = this.h.get(`SELECT AVG(stay_s) a, COUNT(*) n FROM gate_events WHERE direction = 'out' AND vehicle_id IS NOT NULL
      AND status IN ${COUNTED} AND stay_s IS NOT NULL AND t >= ? AND t < ?`, start, end);
    const outside = this.h.get(`SELECT COUNT(*) n, COUNT(DISTINCT plate) plates FROM gate_events WHERE direction = 'in'
      AND vehicle_id IS NULL AND status IN ('outside','history') AND plate_valid = 1 AND t >= ? AND t < ?`, start, end);
    const drains = this.h.get('SELECT COUNT(*) n FROM fuel_events WHERE kind = ? AND t >= ? AND t < ?', 'drain', start, end).n;
    const speeding = this.h.get("SELECT COUNT(*) n FROM alerts WHERE type = 'speeding' AND t >= ? AND t < ?", start, end).n;
    return {
      km: r1(s.km),
      trips: s.trips,
      tripsIn: s.trips_in,
      engineHours: r1(s.engine_s / 3600),
      idleShare: s.engine_s ? Math.round((s.idle_s / s.engine_s) * 100) : null,
      fuelUsed: r1(s.fuel_used),
      fuelPer100: s.fuel_used && s.km_fuel ? r1((s.fuel_used / s.km_fuel) * 100) : null,
      refuelL: r1(s.refuel_l),
      drainL: r1(s.drain_l),
      drains,
      utilization: vehiclesTotal && days ? Math.round((s.active_days / (vehiclesTotal * days)) * 100) : null,
      activeVehicleDays: s.active_days,
      turnaroundMin: ta.n ? Math.round(ta.w / ta.n / 60) : null,
      yardMin: stay.n ? Math.round(stay.a / 60) : null,
      outsideVisits: outside.n,
      outsidePlates: outside.plates,
      speeding,
      vehiclesTotal,
    };
  }

  /** One row per day. */
  series(from, to) {
    const rows = new Map(this.h.all(`SELECT day, SUM(km) km, SUM(MAX(trips_out, trips_in)) trips, SUM(fuel_used) fuel, SUM(engine_s) engine_s,
      SUM(idle_s) idle_s, COUNT(CASE WHEN MAX(trips_out, trips_in) > 0 OR km >= 5 THEN 1 END) active
      FROM daily_stats d JOIN vehicles v ON v.id = d.vehicle_id AND v.active = 1 WHERE day BETWEEN ? AND ? GROUP BY day`, from, to).map((r) => [r.day, r]));
    return T.daysBetween(from, to).map((day) => {
      const r = rows.get(day) || {};
      return { day, km: r1(r.km || 0), trips: r.trips || 0, fuel: r1(r.fuel), engineHours: r1((r.engine_s || 0) / 3600), idleHours: r1((r.idle_s || 0) / 3600), active: r.active || 0 };
    });
  }

  /** Per-vehicle totals for the ranking table. */
  byVehicle(from, to) {
    const rows = this.h.all(`SELECT v.*, COALESCE(SUM(km),0) km, COALESCE(SUM(MAX(trips_out, trips_in)),0) trips, COALESCE(SUM(engine_s),0) engine_s,
      COALESCE(SUM(idle_s),0) idle_s, SUM(fuel_used) fuel_used, COALESCE(SUM(refuel_l),0) refuel_l, COALESCE(SUM(drain_l),0) drain_l,
      MAX(max_speed) max_speed, SUM(turnaround_s * trips_out) ta_w, SUM(CASE WHEN turnaround_s IS NOT NULL THEN trips_out END) ta_n,
      SUM(yard_s) yard_s, COUNT(CASE WHEN MAX(trips_out, trips_in) > 0 OR km >= 5 THEN 1 END) active_days, MAX(odometer) odometer,
      SUM(CASE WHEN fuel_used IS NOT NULL THEN km END) km_fuel
      FROM vehicles v LEFT JOIN daily_stats d ON d.vehicle_id = v.id AND d.day BETWEEN ? AND ?
      WHERE v.active = 1 GROUP BY v.id ORDER BY trips DESC, km DESC`, from, to);
    const days = T.daysBetween(from, to).length;
    return rows.map((r) => ({
      id: r.id, label: vehicleLabel(r), gpsName: r.name, type: r.type,
      km: r1(r.km), trips: r.trips, engineHours: r1(r.engine_s / 3600),
      idleShare: r.engine_s ? Math.round((r.idle_s / r.engine_s) * 100) : null,
      fuelUsed: r1(r.fuel_used), fuelPer100: r.fuel_used && r.km_fuel ? r1((r.fuel_used / r.km_fuel) * 100) : null, fuelNorm: r.fuel_norm,
      refuelL: r1(r.refuel_l), drainL: r1(r.drain_l), maxSpeed: r1(r.max_speed),
      turnaroundMin: r.ta_n ? Math.round(r.ta_w / r.ta_n / 60) : null,
      yardHours: r1((r.yard_s || 0) / 3600), activeDays: r.active_days, days, odometer: r1(r.odometer),
    }));
  }

  /** Daily table (reports page): one row per vehicle for a day range. */
  report(from, to) {
    return this.byVehicle(from, to);
  }

  /** One vehicle's fuel use and utilization over a range, by the same rules as the Tahlil page and Hisobot. */
  vehicleSummary(id, from, to) {
    const r = this.byVehicle(from, to).find((v) => v.id === id);
    if (!r) return null;
    return {
      from, to, days: r.days, activeDays: r.activeDays, utilization: r.days ? Math.round((r.activeDays / r.days) * 100) : null,
      km: r.km, fuelUsed: r.fuelUsed, fuelPer100: r.fuelPer100, fuelNorm: r.fuelNorm,
    };
  }

  /** Per-day rows for one vehicle. */
  vehicleDays(id, from, to) {
    const rows = new Map(this.h.all('SELECT * FROM daily_stats WHERE vehicle_id = ? AND day BETWEEN ? AND ?', id, from, to).map((r) => [r.day, r]));
    return T.daysBetween(from, to).map((day) => {
      const r = rows.get(day) || {};
      return {
        day, km: r1(r.km || 0), trips: Math.max(r.trips_out || 0, r.trips_in || 0), tripsOut: r.trips_out || 0, tripsIn: r.trips_in || 0, engineHours: r1((r.engine_s || 0) / 3600), idleHours: r1((r.idle_s || 0) / 3600),
        fuelUsed: r1(r.fuel_used), refuelL: r1(r.refuel_l || 0), drainL: r1(r.drain_l || 0), maxSpeed: r1(r.max_speed),
        turnaroundMin: r.turnaround_s ? Math.round(r.turnaround_s / 60) : null, odometer: r1(r.odometer), firstOut: r.first_out, lastIn: r.last_in,
      };
    });
  }

  /** Today's numbers for the dispatcher header. */
  today() {
    const day = T.today();
    const start = T.dayStart(day);
    const g = this.h.get(`SELECT SUM(direction='out' AND vehicle_id IS NOT NULL) out_fleet, SUM(direction='in' AND vehicle_id IS NOT NULL) in_fleet,
      SUM(direction='in' AND vehicle_id IS NULL) in_outside, COUNT(*) total FROM gate_events WHERE t >= ? AND status IN ('confirmed','unconfirmed','outside','history','pending')`, start);
    const s = this.h.get('SELECT COALESCE(SUM(km),0) km, SUM(fuel_used) fuel FROM daily_stats WHERE day = ?', day);
    const unacked = this.h.get('SELECT COUNT(*) n FROM alerts WHERE acked_at IS NULL AND t >= ?', Date.now() - 7 * T.DAY).n;
    return { day, tripsOut: g.out_fleet || 0, tripsIn: g.in_fleet || 0, outsideIn: g.in_outside || 0, gateTotal: g.total || 0, km: r1(s.km), fuel: r1(s.fuel), unackedAlerts: unacked };
  }
}

module.exports = { Analytics, COUNTED };
