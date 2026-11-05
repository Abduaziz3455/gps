'use strict';
/**
 * What GPS adds to a gate event: did it see the crossing, the trip since the vehicle left, fuel, today's km, the
 * odometer. Crossings come from the poller's yard visits; km and fuel from GoGPS reports for that vehicle.
 * Never throws: whatever GPS can't answer is left out, and `error` says so.
 */
const T = require('./time');
const { normalizeFuelEvent, haversineM } = require('./gps/normalize');

const NO_SIGNAL_MS = 10 * 60e3;
const TRIP_LOOKBACK_MS = 24 * 3600e3;
// Requests for an alert fail fast: an alert isn't worth waiting minutes on GPS for, and goes out without the numbers.
const FAST = { timeoutMs: 25e3, retries: 2 };

const sum = (ps, k) => ps.reduce((a, p) => a + (Number(p[k]) || 0), 0);

class GateDetails {
  constructor({ h, gps, poller, config, log = console }) {
    this.h = h;
    this.gps = gps;
    this.poller = poller;
    this.cfg = config;
    this.log = log;
  }

  /** What GPS saw at the capture, in one line. */
  stateLine(ev) {
    const t = ev.t, vid = ev.vehicleId;
    const ncfg = this.cfg.nvr;
    if (ev.direction === 'out') {
      const v = this.h.get('SELECT MIN(exit_t) t FROM yard_visits WHERE vehicle_id = ? AND exit_t BETWEEN ? AND ?', vid, t - ncfg.matchBeforeSec * 1000, t + ncfg.exitConfirmMin * 60e3);
      if (v?.t) return `✅ GPS: ${T.localIso(v.t).slice(11, 19)} da hovlidan yo'lga chiqdi`;
    } else {
      const v = this.h.get('SELECT MIN(enter_t) t FROM yard_visits WHERE vehicle_id = ? AND approx = 0 AND enter_t BETWEEN ? AND ?', vid, t - 2 * 60e3, t + 20 * 60e3);
      if (v?.t) return `✅ GPS: ${T.localIso(v.t).slice(11, 19)} da hovliga kirdi`;
    }
    const last = this.h.get('SELECT t, lat, lng, status FROM positions WHERE vehicle_id = ? AND t <= ? ORDER BY t DESC LIMIT 1', vid, t + 60e3);
    if (!last || t - last.t > NO_SIGNAL_MS) {
      // No samples around then can also mean this server was off. Only a tracker silent until now has lost its signal.
      const seen = this.poller?.live.get(vid)?.recordTime;
      if (seen && seen > t - NO_SIGNAL_MS) return null;
      return `⚠️ GPS: ${last ? `${T.localIso(last.t).slice(11, 16)} dan beri ` : ''}signal yo'q`;
    }
    if (last.status === 'moving') return '📡 GPS: harakatda';
    const y = this.cfg.yard;
    const inYard = haversineM(last.lat, last.lng, y.lat, y.lng) <= y.radiusM;
    if (inYard) {
      const v = this.h.get('SELECT enter_t FROM yard_visits WHERE vehicle_id = ? AND enter_t <= ? AND (exit_t IS NULL OR exit_t >= ?) ORDER BY enter_t DESC LIMIT 1', vid, t, t);
      const since = v ? ` (${T.hmOn(v.enter_t, t)} dan)` : '';
      // Past the exit camera but still inside the circle is normal: trucks stand there for minutes before driving off.
      return `📡 GPS: hovli hududida${since}`;
    }
    return `⚠️ GPS: boshqa joyda turibdi — ${(this.poller?.live.get(vid)?.address) || 'manzil noma\'lum'}`;
  }

  /** @returns {Promise<object|null>} null: not a fleet vehicle, or no GPS */
  async forEvent(ev) {
    if (!ev.vehicleId || !this.gps) return null;
    if (this.h.get('SELECT camera_only c FROM vehicles WHERE id = ?', ev.vehicleId)?.c) return null; // no tracker to ask
    const t = ev.t, id = ev.vehicleId;
    const out = {};
    try {
      out.state = this.stateLine(ev);
      if (ev.direction === 'in') {
        // The trip: from when it last left the yard. A visit that ended before the entry window.
        const left = this.h.get('SELECT MAX(exit_t) t FROM yard_visits WHERE vehicle_id = ? AND exit_t IS NOT NULL AND exit_t < ? AND exit_t > ?', id, t - this.cfg.nvr.matchBeforeSec * 1000, t - TRIP_LOOKBACK_MS)?.t;
        if (left) out.tripStart = left;
      } else {
        const v = this.h.get('SELECT enter_t FROM yard_visits WHERE vehicle_id = ? AND enter_t <= ? AND (exit_t IS NULL OR exit_t >= ?) ORDER BY enter_t DESC LIMIT 1', id, t, t - this.cfg.nvr.matchBeforeSec * 1000);
        if (v) out.yardSince = v.enter_t;
      }
      const midnight = T.dayStart(T.dayOf(t));
      const mil = (from) => this.gps.mileage([id], from, t, 86400, FAST).then((rows) => rows.find((r) => Number(r.vehicleId) === id)?.periods || []);
      const fuel = (from) => this.gps.fuel([id], from, t, 86400, FAST).then((rows) => rows.find((r) => Number(r.vehicleId) === id)?.periods || []);
      const today = await mil(midnight);
      if (today.length) {
        out.todayKm = sum(today, 'mileage');
        const end = Number(today[today.length - 1].mileageEnd);
        if (end) out.odometer = end;
      }
      const f = await fuel(midnight);
      const lastF = f[f.length - 1];
      const hasSensor = sum(f, 'fuelConsumption') > 0 || Number(f[0]?.fuelLevelStart) > 0 || Number(lastF?.fuelLevelEnd) > 0;
      if (hasSensor) {
        out.todayFuel = sum(f, 'fuelConsumption');
        out.fuelLevel = Number(lastF.fuelLevelEnd) || null;
      }
      if (out.tripStart) {
        out.tripKm = sum(await mil(out.tripStart), 'mileage');
        if (hasSensor) out.tripFuel = sum(await fuel(out.tripStart), 'fuelConsumption');
      }
      const since = out.tripStart || out.yardSince;
      if (since) {
        const rows = await this.gps.fuelInOut([id], since, t, FAST);
        const row = rows.find((r) => Number(r.vehicleId) === id);
        out.fuelEvents = (row?.fuels || []).map(normalizeFuelEvent).filter(Boolean);
      }
    } catch (e) {
      this.log.warn?.(`GPS details for ${ev.vehicleLabel}: ${e.message}`);
      out.error = e.message;
    }
    return out;
  }
}

module.exports = { GateDetails };
