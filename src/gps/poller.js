'use strict';
/**
 * The only thing that polls GoGPS for live data: one request for the whole fleet every `pollSeconds`,
 * however many people have the map open. It keeps the live state in memory, stores position samples, and
 * records yard visits (the vehicle inside the circle around the yard), which the gate pipeline uses to
 * confirm or identify camera events.
 */
const bus = require('../bus');
const { normalizeLast, haversineM } = require('./normalize');

const SAMPLE_MOVE_M = 25;
const SAMPLE_EVERY_MS = 120e3;
const VEHICLES_EVERY_MS = 3600e3;

class Poller {
  constructor({ h, gps, config, log = console }) {
    this.h = h;
    this.gps = gps;
    this.cfg = config;
    this.log = log;
    this.live = new Map(); // vehicleId -> normalized last data (+ inYard)
    this.lastSample = new Map(); // vehicleId -> {t, lat, lng, status}
    this.openVisit = new Map(); // vehicleId -> {id, enter_t}
    this.vehiclesLoadedAt = 0;
    this.lastOk = 0;
    this.lastError = null;
    this.timer = null;
    for (const r of h.all('SELECT id, vehicle_id, enter_t FROM yard_visits WHERE exit_t IS NULL')) {
      this.openVisit.set(r.vehicle_id, { id: r.id, enter_t: r.enter_t });
    }
    // Restore the last known positions so the map isn't empty right after a restart.
    for (const p of h.kvGet('live_snapshot', [])) this.live.set(p.id, p);
  }

  vehicleIds() {
    return this.h.all('SELECT id FROM vehicles WHERE in_gps = 1').map((r) => r.id);
  }

  async syncVehicles() {
    const list = await this.gps.vehicles();
    if (!list.length) return;
    const now = Date.now();
    this.h.tx(() => {
      this.h.run('UPDATE vehicles SET in_gps = 0');
      for (const v of list) {
        this.h.run(`INSERT INTO vehicles (id, guid, name, model, updated_at, in_gps) VALUES (?, ?, ?, ?, ?, 1)
          ON CONFLICT(id) DO UPDATE SET guid = excluded.guid, name = excluded.name, model = excluded.model,
          in_gps = 1, updated_at = excluded.updated_at`, v.id, v.guid, v.name, v.model, now);
      }
    });
    this.vehiclesLoadedAt = now;
    bus.emit('vehicles');
    this.log.info?.(`GPS fleet: ${list.length} vehicles`);
  }

  inYard(p) {
    const y = this.cfg.yard;
    return haversineM(p.lat, p.lng, y.lat, y.lng) <= y.radiusM;
  }

  async tick() {
    const now = Date.now();
    if (now - this.vehiclesLoadedAt >= VEHICLES_EVERY_MS || !this.vehicleIds().length) {
      try { await this.syncVehicles(); } catch (e) { this.log.warn?.(`GPS vehicle list failed: ${e.message}`); this.vehiclesLoadedAt = now - VEHICLES_EVERY_MS + 120e3; }
    }
    const ids = this.vehicleIds();
    if (!ids.length) return;
    let rows;
    try {
      rows = [];
      for (let i = 0; i < ids.length; i += 100) rows.push(...await this.gps.lastData(ids.slice(i, i + 100)));
    } catch (e) {
      this.lastError = e.message;
      bus.emit('health');
      throw e;
    }
    this.lastOk = Date.now();
    this.lastError = null;
    const changed = [];
    const offlineMs = this.cfg.gps.offlineMinutes * 60e3;
    for (const row of rows) {
      const p = normalizeLast(row, Date.now(), offlineMs);
      if (!p) continue;
      p.inYard = this.inYard(p);
      const prev = this.live.get(p.id);
      this.live.set(p.id, p);
      if (!prev || prev.recordTime !== p.recordTime || prev.status !== p.status) changed.push(p);
      if (p.recordTime && (!prev || p.recordTime > (prev.recordTime || 0))) {
        this._sample(p);
        if (p.status !== 'offline') this._yard(p);
      }
    }
    // Status can turn to "offline" with no new record: re-evaluate the ones that didn't come back.
    for (const [id, p] of this.live) {
      if (p.status !== 'offline' && p.recordTime && Date.now() - p.recordTime > offlineMs) {
        p.status = 'offline';
        changed.push(p);
      }
      void id;
    }
    if (changed.length) bus.emit('positions', changed);
    if (!this._snapAt || Date.now() - this._snapAt > 60e3) {
      this._snapAt = Date.now();
      this.h.kvSet('live_snapshot', [...this.live.values()]);
    }
  }

  _sample(p) {
    const last = this.lastSample.get(p.id) || this.h.get('SELECT t, lat, lng, status FROM positions WHERE vehicle_id = ? ORDER BY t DESC LIMIT 1', p.id);
    const due = !last || p.recordTime - last.t >= SAMPLE_EVERY_MS || last.status !== p.status
      || haversineM(last.lat, last.lng, p.lat, p.lng) >= SAMPLE_MOVE_M;
    if (!due) return;
    this.h.run('INSERT OR IGNORE INTO positions (vehicle_id, t, lat, lng, speed, course, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      p.id, p.recordTime, p.lat, p.lng, p.speed, p.course, p.status);
    this.lastSample.set(p.id, { t: p.recordTime, lat: p.lat, lng: p.lng, status: p.status });
  }

  _yard(p) {
    const open = this.openVisit.get(p.id);
    if (p.inYard && !open) {
      const firstSeen = !this.h.get('SELECT 1 FROM yard_visits WHERE vehicle_id = ? LIMIT 1', p.id) && !this._seen?.has(p.id);
      const r = this.h.run('INSERT INTO yard_visits (vehicle_id, enter_t, approx) VALUES (?, ?, ?)', p.id, p.recordTime, firstSeen ? 1 : 0);
      this.openVisit.set(p.id, { id: Number(r.lastInsertRowid), enter_t: p.recordTime });
      bus.emit('yard', { vehicleId: p.id, kind: 'enter', t: p.recordTime });
    } else if (!p.inYard && open) {
      this.h.run('UPDATE yard_visits SET exit_t = ? WHERE id = ?', p.recordTime, open.id);
      this.openVisit.delete(p.id);
      bus.emit('yard', { vehicleId: p.id, kind: 'exit', t: p.recordTime });
    }
    (this._seen ||= new Set()).add(p.id);
  }

  start() {
    const loop = async () => {
      try { await this.tick(); } catch (e) { this.log.warn?.(`GPS poll failed: ${e.message}`); }
      this.timer = setTimeout(loop, this.cfg.gps.pollSeconds * 1000);
    };
    loop();
  }

  stop() { clearTimeout(this.timer); }

  /** Live rows for the API: every vehicle, with its last known position. */
  snapshot() {
    return [...this.live.values()];
  }
}

module.exports = { Poller };
