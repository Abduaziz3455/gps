'use strict';
/**
 * Alert rules. Each incident gets a stable `key`, so it is raised once however often the rule fires.
 *   fuel_drain  any drain GoGPS reports                                   critical
 *   speeding    over the limit in 2 consecutive polls (once per 30 min)    warning
 *   no_signal   no GPS record for OFFLINE_MINUTES, vehicle active in 7 d   warning (once per outage)
 *   long_stop   parked outside the yard longer than LONG_STOP_MINUTES      info    (work hours only)
 *   system      NVR / GPS unreachable for 5 min                            critical (owners)
 */
const bus = require('./bus');
const T = require('./time');
const { vehicleLabel } = require('./gps/normalize');

class Rules {
  constructor({ h, config, poller, gate, log = console }) {
    this.h = h;
    this.cfg = config;
    this.poller = poller;
    this.gate = gate;
    this.log = log;
    this.over = new Map(); // vehicleId -> consecutive polls over the limit
    this.movingAt = new Map(); // vehicleId -> last record time while moving
    this.down = {}; // system -> since
    this.timer = null;
  }

  label(id) {
    const v = this.h.get('SELECT * FROM vehicles WHERE id = ?', id);
    return v ? vehicleLabel(v) : `#${id}`;
  }

  raise({ key, type, severity, vehicleId = null, t = Date.now(), title, body = '', data = null, silent = false }) {
    const r = this.h.run(`INSERT OR IGNORE INTO alerts (key, type, severity, vehicle_id, t, title, body, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      key, type, severity, vehicleId, t, title, body, data ? JSON.stringify(data) : null);
    if (!r.changes) return null;
    const a = { ...this.view(this.h.get('SELECT * FROM alerts WHERE id = ?', Number(r.lastInsertRowid))), silent };
    bus.emit('alert', a);
    return a;
  }

  view(r) {
    return {
      id: r.id, type: r.type, severity: r.severity, vehicleId: r.vehicle_id, vehicleLabel: r.vehicle_id ? this.label(r.vehicle_id) : null,
      t: r.t, title: r.title, body: r.body, data: r.data ? JSON.parse(r.data) : null, ackedAt: r.acked_at,
      ackedBy: r.acked_by ? this.h.get('SELECT name FROM users WHERE id = ?', r.acked_by)?.name : null,
    };
  }

  onPositions(list) {
    const limit = this.cfg.rules.speedLimit;
    for (const p of list) {
      if (p.status === 'moving') this.movingAt.set(p.id, p.recordTime);
      const n = p.speed > limit && p.status !== 'offline' ? (this.over.get(p.id) || 0) + 1 : 0;
      this.over.set(p.id, n);
      if (n === 2) {
        const bucket = Math.floor(p.recordTime / 1800e3);
        this.raise({
          key: `speeding:${p.id}:${bucket}`, type: 'speeding', severity: 'warning', vehicleId: p.id, t: p.recordTime,
          title: `Tezlik oshirildi: ${this.label(p.id)}`, body: `${Math.round(p.speed)} km/soat (chegara ${limit}) · ${p.address || ''}`,
          data: { speed: p.speed, lat: p.lat, lng: p.lng },
        });
      }
    }
  }

  onFuel(f) {
    if (f.kind !== 'drain') return;
    this.raise({
      key: `drain:${f.vehicle_id}:${f.t}`, type: 'fuel_drain', severity: 'critical', vehicleId: f.vehicle_id, t: f.t,
      title: `Yoqilg'i to'kildi: ${this.label(f.vehicle_id)}`, body: `−${Math.round(f.litres)} L, ${T.localIso(f.t).slice(0, 16).replace('T', ' ')}`,
      data: { litres: f.litres }, silent: Date.now() - f.t > 2 * T.DAY,
    });
  }

  /** Periodic checks: no signal, long stops, system health. */
  check(now = Date.now()) {
    const offMs = this.cfg.gps.offlineMinutes * 60e3;
    const since = T.addDays(T.today(now), -7);
    const active = new Set(this.h.all('SELECT DISTINCT vehicle_id FROM daily_stats WHERE day >= ? AND (km >= 1 OR trips_out > 0)', since).map((r) => r.vehicle_id));
    const [wa, wb] = this.cfg.rules.workHours.split('-').map(T.parseHm);
    const m = T.minuteOfDay(now);
    const workTime = m >= wa && m < wb;
    for (const p of this.poller?.live.values() || []) {
      if (p.recordTime && now - p.recordTime > offMs && active.has(p.id)) {
        this.raise({
          key: `no_signal:${p.id}:${p.recordTime}`, type: 'no_signal', severity: 'warning', vehicleId: p.id, t: now,
          title: `GPS signal yo'q: ${this.label(p.id)}`, body: `Oxirgi ma'lumot: ${T.localIso(p.recordTime).slice(0, 16).replace('T', ' ')} · ${p.address || ''}`,
          silent: now - p.recordTime > T.DAY,
        });
      }
      if ((p.status === 'stopped' || p.status === 'idle') && !p.inYard && workTime) {
        const lastMove = this.movingAt.get(p.id) ?? this.h.get("SELECT MAX(t) t FROM positions WHERE vehicle_id = ? AND status = 'moving'", p.id)?.t;
        if (lastMove) this.movingAt.set(p.id, lastMove);
        if (lastMove && now - lastMove > this.cfg.rules.longStopMin * 60e3 && now - lastMove < 12 * 3600e3) {
          this.raise({
            key: `long_stop:${p.id}:${lastMove}`, type: 'long_stop', severity: 'info', vehicleId: p.id, t: now,
            title: `Uzoq to'xtash: ${this.label(p.id)}`, body: `${Math.round((now - lastMove) / 60e3)} daqiqadan beri hovlidan tashqarida turibdi · ${p.address || ''}`,
            data: { lat: p.lat, lng: p.lng },
          });
        }
      }
    }
    const systems = {
      gps: this.poller ? (this.poller.lastOk ? now - this.poller.lastOk : Infinity) : null,
      nvr: this.gate ? (this.gate.nvr.lastOk ? now - this.gate.nvr.lastOk : Infinity) : null,
    };
    for (const [name, age] of Object.entries(systems)) {
      if (age === null) continue;
      if (age > 5 * 60e3 && this.started && now - this.started > 5 * 60e3) {
        this.down[name] ||= now - Math.min(age, now - this.started);
        this.raise({
          key: `system:${name}:${this.down[name]}`, type: 'system', severity: 'critical', t: now,
          title: name === 'gps' ? "GPS (GoGPS) bilan aloqa yo'q" : "Kameralar (NVR) bilan aloqa yo'q",
          body: `${T.localIso(this.down[name]).slice(11, 16)} dan beri`,
        });
      } else if (age <= 5 * 60e3 && this.down[name]) {
        delete this.down[name];
      }
    }
  }

  start() {
    this.started = Date.now();
    bus.on('positions', (l) => { try { this.onPositions(l); } catch (e) { this.log.warn?.(`rules: ${e.message}`); } });
    bus.on('fuel', (f) => { try { this.onFuel(f); } catch (e) { this.log.warn?.(`rules: ${e.message}`); } });
    const loop = () => { try { this.check(); } catch (e) { this.log.warn?.(`rules: ${e.message}`); } this.timer = setTimeout(loop, 60e3); };
    this.timer = setTimeout(loop, 30e3);
  }

  stop() { clearTimeout(this.timer); }
}

module.exports = { Rules };
