'use strict';
/**
 * Places: areas the owner names on the map, starting from a point where a truck stopped ("Karyer", "Sergeli obyekti").
 *
 * A visit (reys) is one stay inside the circle with at least 5 min standing, the same rule as the stop marks on the
 * map, so driving through or waiting at a traffic light doesn't count. Visits are worked out from the stored position
 * samples in the background and kept in `place_visits`, so pages only read a small table.
 *
 * Suggestions: spots where several trucks keep stopping are found the same way and listed for the owner on the Joylar
 * page, who names one (it becomes a place) or ignores it. They are not drawn on the maps.
 *
 * Nothing here touches the poller or the positions table: the work runs on its own timer, one day of samples at a
 * time, giving way to other requests in between. If it fails, the rest of the app doesn't notice.
 */
const bus = require('./bus');
const T = require('./time');
const { httpError } = require('./auth');
const { haversineM, vehicleLabel } = require('./gps/normalize');

// Thresholds checked against the real fleet on 4 Nov 2026 (1.5 days, 20 trucks); see docs/ARCHITECTURE.md, section 6a.
const RADIUS = { min: 50, max: 2000, def: 150 }; // visit counts hardly change from 100 to 300 m; 75 m starts to miscount
const NAME_MAX = 60;
const MIN_STOP_MS = 5 * 60e3; // real stops fall into under 3 min (traffic) or 5+ min, with few in between
const MERGE_GAP_MS = 20 * 60e3; // drift or a short shuffle is not a new visit; real trucks never came back within 20-90 min
const REFRESH_EVERY_MS = 5 * 60e3;
const REFRESH_WINDOW_MS = T.DAY; // records can arrive late, so the last day is always worked out again
const M_PER_DEG = 111320;
const COMMON = {
  days: 30, // how far back to look
  everyMs: 3600e3,
  firstAfterMs: 5e3,
  clusterM: 150, // visits this close to each other are one spot; at 100 m the busiest real site fell apart
  minVisits: 3, minVehicles: 2, // one truck parked at its driver's home isn't a common place; one big pour is a real site
  yardMarginM: 100, placeMarginM: 50, hiddenM: 200,
  max: 20, // busiest first: naming or ignoring one brings the next
};

/**
 * Visits of one vehicle from its samples inside a circle, oldest first.
 * `seen(a, b)`: did the vehicle report anywhere between these times? It was inside at both ends, so a long gap with
 * reports means it left and came back, and a long gap without any means the tracker went quiet while it stood there.
 * `resume`: a stored visit to continue, with `lastStatus` the status of its last sample.
 */
function detectVisits(samples, seen, resume = null) {
  const visits = [];
  let cur = resume ? { enter_t: resume.enter_t, exit_t: resume.exit_t, stoppedMs: resume.stopped_s * 1000 } : null;
  let prev = resume ? { t: resume.exit_t, status: resume.lastStatus } : null;
  const close = () => { if (cur && cur.stoppedMs >= MIN_STOP_MS) visits.push(cur); cur = null; };
  for (const s of samples) {
    if (cur && s.t - prev.t > MERGE_GAP_MS && seen(prev.t, s.t)) close();
    if (!cur) cur = { enter_t: s.t, exit_t: s.t, stoppedMs: 0 };
    else {
      if (prev.status !== 'moving') cur.stoppedMs += s.t - prev.t;
      cur.exit_t = s.t;
    }
    prev = s;
  }
  close();
  return visits;
}

/**
 * Spots where visits gather: visits within 150 m of a spot's centre join it, and only spots used more than once and
 * by different vehicles are kept, busiest first. `visits`: [{vehicle_id, lat, lng, t}].
 */
function findCommon(visits, dayOf = T.dayOf) {
  const cells = new Map();
  const cellOf = (lat, lng) => [Math.floor(lat / 0.002), Math.floor(lng / 0.003)];
  for (const s of visits) {
    const [a, b] = cellOf(s.lat, s.lng);
    let best = null, bestD = COMMON.clusterM;
    for (let i = a - 1; i <= a + 1; i++) {
      for (let j = b - 1; j <= b + 1; j++) {
        for (const c of cells.get(`${i}:${j}`) || []) {
          const d = haversineM(s.lat, s.lng, c.lat, c.lng);
          if (d <= bestD) { best = c; bestD = d; }
        }
      }
    }
    if (!best) {
      best = { lat: s.lat, lng: s.lng, n: 0, vehicles: new Set(), days: new Set() };
      const k = `${a}:${b}`;
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(best);
    }
    best.lat = (best.lat * best.n + s.lat) / (best.n + 1);
    best.lng = (best.lng * best.n + s.lng) / (best.n + 1);
    best.n++;
    best.vehicles.add(s.vehicle_id);
    best.days.add(dayOf(s.t));
  }
  return [...cells.values()].flat()
    .filter((c) => c.n >= COMMON.minVisits && c.vehicles.size >= COMMON.minVehicles)
    .sort((x, y) => y.n - x.n)
    .map((c) => ({ lat: Math.round(c.lat * 1e6) / 1e6, lng: Math.round(c.lng * 1e6) / 1e6, visits: c.n, vehicles: c.vehicles.size, days: c.days.size }));
}

const yieldNow = () => new Promise((r) => { setImmediate(r); });
const minutes = (ms) => (ms == null ? null : Math.round(ms / 60e3));

class Places {
  constructor({ h, config, log = console }) {
    this.h = h;
    this.cfg = config;
    this.log = log;
    this.timer = null;
    this.stopped = false;
    this.queue = Promise.resolve(); // one job at a time
    this.computing = new Set(); // places whose whole history is being worked out
    this.commonAll = h.kvGet('common_places', []); // from the last search, so a restart shows them straight away
    this._load();
  }

  _load() { this.rows = this.h.all('SELECT * FROM places ORDER BY name'); }

  view(p) {
    return { id: p.id, name: p.name, lat: p.lat, lng: p.lng, radiusM: p.radius_m, computing: this.computing.has(p.id) };
  }

  list() { return this.rows.map((p) => this.view(p)); }

  /** The place containing this point (the nearest centre when circles overlap), or null. */
  at(lat, lng) {
    if (lat == null || lng == null) return null;
    let best = null, bestD = Infinity;
    for (const p of this.rows) {
      const d = haversineM(lat, lng, p.lat, p.lng);
      if (d <= p.radius_m && d < bestD) { best = p; bestD = d; }
    }
    return best;
  }

  /** Spots to suggest: not the yard, not already named, not ignored. Worked out here, so naming one removes it at once. */
  common() {
    const hidden = this.h.kvGet('common_hidden', []);
    return this.commonAll.filter((c) => !this.rows.some((p) => haversineM(c.lat, c.lng, p.lat, p.lng) <= p.radius_m + COMMON.placeMarginM)
      && !hidden.some((x) => haversineM(c.lat, c.lng, x.lat, x.lng) <= COMMON.hiddenM)).slice(0, COMMON.max);
  }

  hideCommon(b) {
    if (typeof b.lat !== 'number' || typeof b.lng !== 'number' || !(Math.abs(b.lat) <= 90) || !(Math.abs(b.lng) <= 180)) throw httpError(400, "Nuqta noto'g'ri");
    this.h.kvSet('common_hidden', [...this.h.kvGet('common_hidden', []), { lat: b.lat, lng: b.lng }]);
    bus.emit('places');
  }

  /**
   * Visits of the last 30 days, by the same rule as a place's: 5 min standing in all. Real trucks flicker to "moving"
   * while they stand (166 pieces were 49 visits), so pieces close in time and place are added up into one.
   */
  refreshCommon(now = Date.now()) {
    return this._enqueue(async () => {
      const runs = new Map();
      const open = new Map();
      const visits = [];
      const y = this.cfg.yard;
      const flush = (vid) => {
        const v = open.get(vid);
        if (v && v.stoppedMs >= MIN_STOP_MS && haversineM(v.lat, v.lng, y.lat, y.lng) > y.radiusM + COMMON.yardMarginM) visits.push({ vehicle_id: vid, lat: v.lat, lng: v.lng, t: v.start });
        open.delete(vid);
      };
      const end = (vid, r) => {
        const v = open.get(vid);
        if (v && r.start - v.last <= MERGE_GAP_MS && haversineM(r.lat, r.lng, v.lat, v.lng) <= COMMON.clusterM) {
          v.last = r.last;
          v.stoppedMs += r.last - r.start;
          return;
        }
        flush(vid);
        open.set(vid, { start: r.start, last: r.last, lat: r.lat, lng: r.lng, stoppedMs: r.last - r.start });
      };
      for (let from = now - COMMON.days * T.DAY; from < now; from += T.DAY) {
        if (this.stopped) return;
        for (const p of this.h.all('SELECT vehicle_id, t, lat, lng, status FROM positions INDEXED BY positions_t WHERE t >= ? AND t < ? ORDER BY t', from, from + T.DAY)) {
          const r = runs.get(p.vehicle_id);
          if (p.status === 'moving') {
            if (r) { r.last = p.t; end(p.vehicle_id, r); runs.delete(p.vehicle_id); }
          } else if (r) r.last = p.t;
          else runs.set(p.vehicle_id, { start: p.t, last: p.t, lat: p.lat, lng: p.lng });
        }
        await yieldNow();
      }
      for (const [vid, r] of runs) end(vid, r);
      for (const vid of [...open.keys()]) flush(vid);
      const found = findCommon(visits);
      if (this.stopped) return;
      const changed = JSON.stringify(found) !== JSON.stringify(this.commonAll);
      this.commonAll = found;
      this.h.kvSet('common_places', found);
      if (changed) bus.emit('places');
    });
  }

  // --- changes ---------------------------------------------------------------------------------

  _name(v, id = null) {
    const name = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
    if (name.length < 2 || name.length > NAME_MAX) throw httpError(400, `Joy nomi 2–${NAME_MAX} ta belgi bo'lishi kerak`);
    if (this.h.get('SELECT 1 FROM places WHERE name = ? COLLATE NOCASE AND id IS NOT ?', name, id)) throw httpError(409, 'Bu nomli joy allaqachon bor');
    return name;
  }

  _radius(v) {
    const r = Number(v);
    if (!Number.isFinite(r) || r < RADIUS.min || r > RADIUS.max) throw httpError(400, `Radius ${RADIUS.min}–${RADIUS.max} m bo'lishi kerak`);
    return Math.round(r);
  }

  create(b, user) {
    const name = this._name(b.name);
    const radius = this._radius(b.radiusM ?? RADIUS.def);
    const lat = Number(b.lat), lng = Number(b.lng);
    if (typeof b.lat !== 'number' || typeof b.lng !== 'number' || !(Math.abs(lat) <= 90) || !(Math.abs(lng) <= 180)) throw httpError(400, 'Nuqta noto\'g\'ri');
    const y = this.cfg.yard;
    if (haversineM(lat, lng, y.lat, y.lng) <= y.radiusM) throw httpError(409, `Bu nuqta ${y.name} ichida`);
    const inside = this.at(lat, lng);
    if (inside) throw httpError(409, `Bu nuqta "${inside.name}" joyi ichida`);
    const now = Date.now();
    const id = Number(this.h.run('INSERT INTO places (name, lat, lng, radius_m, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      name, lat, lng, radius, user?.id ?? null, now, now).lastInsertRowid);
    this._load();
    this.rebuild(id);
    bus.emit('places');
    return this.view(this.rows.find((p) => p.id === id));
  }

  /** Name and radius only: the point itself stays where the truck stopped. */
  update(id, b) {
    const p = this.rows.find((x) => x.id === id);
    if (!p) throw httpError(404, 'Joy topilmadi');
    const name = 'name' in b ? this._name(b.name, id) : p.name;
    const radius = 'radiusM' in b ? this._radius(b.radiusM) : p.radius_m;
    this.h.run('UPDATE places SET name = ?, radius_m = ?, updated_at = ? WHERE id = ?', name, radius, Date.now(), id);
    this._load();
    if (radius !== p.radius_m) this.rebuild(id);
    bus.emit('places');
    return this.view(this.rows.find((x) => x.id === id));
  }

  remove(id) {
    if (!this.rows.some((x) => x.id === id)) throw httpError(404, 'Joy topilmadi');
    this.h.run('DELETE FROM places WHERE id = ?', id); // its visits go with it (ON DELETE CASCADE)
    this._load();
    bus.emit('places');
  }

  // --- visits ----------------------------------------------------------------------------------

  _enqueue(fn) {
    this.queue = this.queue.then(fn).catch((e) => this.log.warn?.(`places: ${e.message}`));
    return this.queue;
  }

  /** All the history of one place, after it was created or resized. */
  rebuild(id) {
    this.computing.add(id);
    return this._enqueue(async () => {
      try {
        const oldest = this.h.get('SELECT MIN(t) t FROM positions').t;
        if (oldest != null) await this._scan(id, oldest);
      } finally {
        this.computing.delete(id);
        if (!this.stopped) bus.emit('places');
      }
    });
  }

  /** The recent samples of every place. */
  refresh(now = Date.now()) {
    return this._enqueue(async () => {
      for (const { id } of this.rows) {
        if (this.stopped) return;
        await this._scan(id, now - REFRESH_WINDOW_MS);
        await yieldNow();
      }
    });
  }

  /** Work out one place's visits again from `since`; a stored visit reaching into that time is redone whole. */
  async _scan(id, since) {
    const place = this.rows.find((p) => p.id === id);
    if (!place) return;
    const h = this.h;
    const starts = new Map(h.all('SELECT vehicle_id, MIN(enter_t) t FROM place_visits WHERE place_id = ? AND exit_t >= ? GROUP BY vehicle_id', id, since - MERGE_GAP_MS).map((r) => [r.vehicle_id, r.t]));
    const dLat = (place.radius_m / M_PER_DEG) * 1.01;
    const dLng = dLat / Math.max(0.01, Math.cos((place.lat * Math.PI) / 180));
    const byVehicle = new Map();
    const end = Date.now() + T.DAY;
    for (let from = Math.min(since, ...starts.values()); from < end; from += T.DAY) {
      if (this.stopped) return;
      const rows = h.all(`SELECT vehicle_id, t, lat, lng, status FROM positions INDEXED BY positions_t WHERE t >= ? AND t < ?
        AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ? ORDER BY t`, from, from + T.DAY, place.lat - dLat, place.lat + dLat, place.lng - dLng, place.lng + dLng);
      for (const r of rows) {
        if (r.t < (starts.get(r.vehicle_id) ?? since)) continue;
        if (haversineM(r.lat, r.lng, place.lat, place.lng) > place.radius_m) continue;
        if (!byVehicle.has(r.vehicle_id)) byVehicle.set(r.vehicle_id, []);
        byVehicle.get(r.vehicle_id).push(r);
      }
      await yieldNow(); // about 30k rows a day: other requests go first
    }
    if (this.stopped || !this.rows.some((p) => p.id === id)) return; // deleted meanwhile
    h.tx(() => {
      h.run('DELETE FROM place_visits WHERE place_id = ? AND exit_t >= ?', id, since - MERGE_GAP_MS);
      for (const [vid, samples] of byVehicle) {
        const seen = (a, b) => !!h.get('SELECT 1 FROM positions WHERE vehicle_id = ? AND t > ? AND t < ? LIMIT 1', vid, a, b);
        // Standing here since before `since` with a quiet tracker: this is still the same visit.
        const last = h.get('SELECT * FROM place_visits WHERE place_id = ? AND vehicle_id = ? ORDER BY enter_t DESC LIMIT 1', id, vid);
        const first = samples[0].t;
        const resume = last && (first - last.exit_t <= MERGE_GAP_MS || !seen(last.exit_t, first))
          ? { ...last, lastStatus: h.get('SELECT status FROM positions WHERE vehicle_id = ? AND t = ?', vid, last.exit_t)?.status ?? 'stopped' } : null;
        if (resume) h.run('DELETE FROM place_visits WHERE place_id = ? AND vehicle_id = ? AND enter_t = ?', id, vid, last.enter_t);
        for (const v of detectVisits(samples, seen, resume)) {
          h.run('INSERT OR REPLACE INTO place_visits (place_id, vehicle_id, enter_t, exit_t, stopped_s) VALUES (?, ?, ?, ?, ?)', id, vid, v.enter_t, v.exit_t, Math.round(v.stoppedMs / 1000));
        }
      }
    });
  }

  start() {
    const loop = async () => {
      await this.refresh();
      if (!this.stopped) this.timer = setTimeout(loop, REFRESH_EVERY_MS);
    };
    this.timer = setTimeout(loop, 30e3);
    const common = async () => {
      await this.refreshCommon();
      if (!this.stopped) this.commonTimer = setTimeout(common, COMMON.everyMs);
    };
    this.commonTimer = setTimeout(common, COMMON.firstAfterMs);
  }

  stop() { this.stopped = true; clearTimeout(this.timer); clearTimeout(this.commonTimer); }

  // --- numbers ---------------------------------------------------------------------------------

  /** One row per place for [from, to] (days). A visit belongs to the day it began. */
  stats(from, to) {
    const a = T.dayStart(from), b = T.dayStart(to) + T.DAY;
    return this.h.all(`SELECT p.*, COUNT(x.vehicle_id) trips, COUNT(DISTINCT x.vehicle_id) vehicles, AVG(x.exit_t - x.enter_t) stay, MAX(x.exit_t) last
      FROM places p LEFT JOIN (SELECT pv.* FROM place_visits pv JOIN vehicles v ON v.id = pv.vehicle_id AND v.active = 1 WHERE pv.enter_t >= ? AND pv.enter_t < ?) x ON x.place_id = p.id
      GROUP BY p.id ORDER BY trips DESC, p.name`, a, b).map((r) => ({
      ...this.view(r), trips: r.trips, vehicles: r.vehicles, avgStayMin: minutes(r.stay), lastAt: r.last,
    }));
  }

  /** Which vehicles came to one place. */
  vehiclesAt(id, from, to) {
    if (!this.rows.some((p) => p.id === id)) throw httpError(404, 'Joy topilmadi');
    return this.h.all(`SELECT v.*, COUNT(*) trips, AVG(x.exit_t - x.enter_t) stay, MAX(x.exit_t) last FROM place_visits x JOIN vehicles v ON v.id = x.vehicle_id AND v.active = 1
      WHERE x.place_id = ? AND x.enter_t >= ? AND x.enter_t < ? GROUP BY v.id ORDER BY trips DESC, last DESC`, id, T.dayStart(from), T.dayStart(to) + T.DAY).map((r) => ({
      id: r.id, label: vehicleLabel(r), type: r.type, trips: r.trips, avgStayMin: minutes(r.stay), lastAt: r.last,
    }));
  }

  /** Which places one vehicle went to. */
  ofVehicle(vehicleId, from, to) {
    return this.h.all(`SELECT p.id, p.name, COUNT(*) trips, AVG(x.exit_t - x.enter_t) stay, MAX(x.exit_t) last FROM place_visits x JOIN places p ON p.id = x.place_id
      WHERE x.vehicle_id = ? AND x.enter_t >= ? AND x.enter_t < ? GROUP BY p.id ORDER BY trips DESC, p.name`, vehicleId, T.dayStart(from), T.dayStart(to) + T.DAY).map((r) => ({
      id: r.id, name: r.name, trips: r.trips, avgStayMin: minutes(r.stay), lastAt: r.last,
    }));
  }
}

module.exports = { Places, detectVisits, findCommon, RADIUS, COMMON };
