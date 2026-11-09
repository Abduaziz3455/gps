'use strict';
/**
 * Plates the cameras keep reading that no fleet vehicle has. Every such truck counts as an outsider, so its trips are
 * missing from the reports (real: four plates were 18% of all passes in 14 days). The owner decides, once per plate:
 *   this GPS truck     GPS knows it under another name (real: 10964DDA is "85 519 EBA")
 *   our truck, no GPS  a truck with no tracker: it gets a vehicle of its own, counted by the cameras alone
 *   not ours           stop asking
 * Any decision can be undone. Linking also moves the plate's past passes and recounts those days.
 *
 * A vehicle keeps its one `plate` and this table holds the rest, because setting `plate` on a truck would turn off the
 * "same digits and letters" match that its usual reads rely on.
 */
const bus = require('./bus');
const T = require('./time');
const { httpError } = require('./auth');
const { plateKey, prettyPlate, vehicleLabel } = require('./gps/normalize');
const plates = require('./cameras/plates');

const LOOK_BACK_DAYS = 30;
const MIN_PASSES = 4, MIN_DAYS = 2; // a one-off visit is 2 passes on one day; real regulars have 12-80
const MAX_LIST = 30;
const BEFORE_MS = 2 * 60e3, AFTER_MS = 5 * 60e3; // GPS crossing around a capture: same window as the exit check
const OWN_PASS_MS = 3 * 60e3; // a truck with its own capture then wasn't the unknown plate
const SUGGEST_HITS = 3, SUGGEST_SHARE = 0.6;
const STREET_MIN_PASSES = 10, STREET_SHARE = 0.9, STREET_LEAD = 0.2;
const STREET_WINDOW_MS = 10 * 60e3;
const NAME_MAX = 40;
const FIRST_OWN_ID = 1e9; // our own vehicle ids, far above GoGPS's (5 digits)
const NOTE = "Raqam qo'lda biriktirildi";

/** Standing on the plant's street at this pass: the stop ended around an exit or began around an entry, or spans it. */
function atStreet(stops, e) {
  return stops.some((s) => (s.s <= e.t && s.e >= e.t) || Math.abs((e.direction === 'out' ? s.e : s.s) - e.t) <= STREET_WINDOW_MS);
}

class PlateLinks {
  constructor({ h, analytics, trips = null, log = console }) {
    this.h = h;
    this.analytics = analytics;
    this.trips = trips;
    this.log = log;
  }

  /**
   * Which GPS truck this plate is, from two records of ours. Neither guesses: unsure, it says nothing.
   *   crossings  which truck left the circle when the plate passed the exit camera. Exits only: at the entry a real truck
   *              can reach the circle hours before the camera. The poller's record, so only since it began.
   *   street     which truck stood on the plant's street at each pass, from GoGPS's stops, which go back further. Checked on
   *              the 14 plates whose truck is known (5 Nov 2026): at these thresholds 7 right, none wrong, 7 undecided (some
   *              trackers report only "Ташкент" as the address). So it can't prove there is no such truck: "may be" below.
   */
  evidence(events, street = new Map()) {
    const first = this.h.get('SELECT MIN(enter_t) t FROM yard_visits').t;
    const usable = first == null ? [] : events.filter((e) => e.direction === 'out' && e.t >= first);
    const hits = new Map();
    for (const e of usable) {
      for (const r of this.h.all('SELECT DISTINCT vehicle_id v FROM yard_visits WHERE exit_t BETWEEN ? AND ?', e.t - BEFORE_MS, e.t + AFTER_MS)) {
        const own = this.h.get("SELECT 1 FROM gate_events WHERE vehicle_id = ? AND direction = 'out' AND status != 'vetoed' AND t BETWEEN ? AND ? LIMIT 1", r.v, e.t - OWN_PASS_MS, e.t + OWN_PASS_MS);
        if (!own) hits.set(r.v, (hits.get(r.v) || 0) + 1);
      }
    }
    const named = (id, n, checked, basis) => {
      const v = this.h.get('SELECT * FROM vehicles WHERE id = ?', id);
      return v ? { vehicleId: id, label: vehicleLabel(v), hits: n, checked, basis } : null;
    };
    const checked = usable.length;
    const [best, second] = [...hits].sort((a, b) => b[1] - a[1]);
    const strong = best && best[1] >= SUGGEST_HITS && best[1] / checked >= SUGGEST_SHARE && (!second || best[1] >= 2 * second[1]);
    if (strong) return { suggestion: named(best[0], best[1], checked, 'crossings'), noGps: false };

    // Only days GoGPS has answered for: a truck can't be missing from a day nobody has asked about yet.
    const known = new Set(this.h.all('SELECT day FROM gps_segment_days').map((r) => r.day));
    const covered = events.filter((e) => known.has(T.dayOf(e.t)));
    const counted = [...street].map(([id, stops]) => [id, covered.filter((e) => atStreet(stops, e)).length]).sort((a, b) => b[1] - a[1]);
    const n = covered.length;
    if (n >= STREET_MIN_PASSES && counted.length) {
      const [[id, top], [, next] = [null, 0]] = counted;
      if (top / n >= STREET_SHARE && (top - next) / n >= STREET_LEAD) return { suggestion: named(id, top, n, 'street'), noGps: false };
      if (top / n < STREET_SHARE) return { suggestion: null, noGps: true };
      return { suggestion: null, noGps: false };
    }
    // Too little to go on. Crossings alone can't say "no tracker" while most passes are on days still to be fetched.
    if (covered.length < events.length / 2) return { suggestion: null, noGps: false };
    return { suggestion: null, noGps: checked >= SUGGEST_HITS && (!best || best[1] / checked < 1 / 3) };
  }

  /** Each GPS truck's stops on the plant's street since `since`. */
  streetStops(since, now = Date.now()) {
    const addrs = this.trips?.yardAddresses(now) || [];
    const out = new Map();
    if (!addrs.length) return out;
    const rows = this.h.all(`SELECT g.vehicle_id v, g.start_t s, g.end_t e FROM gps_segments g JOIN vehicles x ON x.id = g.vehicle_id AND x.in_gps = 1
      WHERE g.kind = 'stop' AND g.end_t >= ? AND g.address IN (${addrs.map(() => '?').join(',')})`, since, ...addrs);
    for (const r of rows) {
      if (!out.has(r.v)) out.set(r.v, []);
      out.get(r.v).push(r);
    }
    return out;
  }

  /** Fleet plates one character away: a misread, or a truck with the next number. */
  similar(plate) {
    const out = [];
    for (const v of this.h.all('SELECT * FROM vehicles WHERE active = 1')) {
      const k = plateKey(v.plate || v.name);
      if (k && plates.distance(plate, k) === 1) out.push({ vehicleId: v.id, label: vehicleLabel(v), plate: prettyPlate(k) });
    }
    return out;
  }

  /** Regulars nobody decided about yet, most frequent first. */
  unknown(now = Date.now()) {
    const since = now - LOOK_BACK_DAYS * T.DAY;
    const rows = this.h.all(`SELECT plate, COUNT(*) n, SUM(direction = 'in') ins, SUM(direction = 'out') outs, MIN(t) first, MAX(t) last,
      COUNT(DISTINCT date(t / 1000, 'unixepoch', '+5 hours')) days FROM gate_events
      WHERE vehicle_id IS NULL AND plate_valid = 1 AND plate IS NOT NULL AND status != 'vetoed' AND t >= ?
      AND plate NOT IN (SELECT plate FROM plate_links)
      GROUP BY plate HAVING n >= ? AND days >= ? ORDER BY n DESC, last DESC LIMIT ?`, since, MIN_PASSES, MIN_DAYS, MAX_LIST);
    const street = rows.length ? this.streetStops(since, now) : new Map();
    return rows.map((r) => {
      const events = this.h.all("SELECT t, direction FROM gate_events WHERE plate = ? AND vehicle_id IS NULL AND status != 'vetoed' AND t >= ? ORDER BY t DESC LIMIT 60", r.plate, since);
      const photo = this.h.get("SELECT id FROM gate_events WHERE plate = ? AND (photos != '[]' OR capture_uri IS NOT NULL) ORDER BY t DESC LIMIT 1", r.plate);
      return {
        plate: r.plate, text: prettyPlate(r.plate), passes: r.n, in: r.ins, out: r.outs, days: r.days, firstAt: r.first, lastAt: r.last,
        eventId: photo?.id ?? null, photoUrl: photo ? `/api/gate-events/${photo.id}/photo/0` : null,
        evidence: this.evidence(events, street), similar: this.similar(r.plate),
      };
    });
  }

  /** What was decided, last first. */
  decided() {
    return this.h.all('SELECT l.*, v.name, v.plate vplate, v.display, v.type FROM plate_links l LEFT JOIN vehicles v ON v.id = l.vehicle_id ORDER BY l.at DESC').map((l) => ({
      plate: l.plate, text: prettyPlate(l.plate), kind: l.kind, created: !!l.created, at: l.at, vehicleId: l.vehicle_id,
      label: l.vehicle_id && l.name != null ? vehicleLabel({ name: l.name, plate: l.vplate, display: l.display }) : null,
      passes: l.kind === 'vehicle' ? this.h.get("SELECT COUNT(*) n FROM gate_events WHERE plate = ? AND identified_by = 'link'", l.plate).n : this.h.get('SELECT COUNT(*) n FROM gate_events WHERE plate = ?', l.plate).n,
    }));
  }

  /** `forVehicle`: linking to the truck that already has the plate (as its set plate or GPS name) is allowed. */
  _plate(raw, forVehicle = null) {
    const plate = plateKey(raw);
    if (!plates.isValid(plate)) throw httpError(400, "Raqam noto'g'ri");
    if (this.h.get('SELECT 1 FROM plate_links WHERE plate = ?', plate)) throw httpError(409, 'Bu raqam haqida qaror allaqachon qabul qilingan');
    // A truck that already has it: as its set plate, or as the name it has in GPS.
    const owner = this.h.all('SELECT * FROM vehicles').find((v) => plateKey(v.plate) === plate || plateKey(v.name) === plate);
    if (owner && owner.id !== forVehicle) throw httpError(409, `Bu raqam ${vehicleLabel(owner)} transportiga tegishli`);
    return plate;
  }

  /**
   * Past passes of a plate that a truck now has, as its GPS name or set plate, go to that truck. GoGPS gets cars added
   * and renamed to their real plates (2026-11-09: three added, "85 518 EBA" renamed "10 963 DDA"); new passes match
   * them at once, this brings the earlier ones along. The owner's decisions (plate_links) are left alone, and so is a
   * plate two trucks share. Runs after each GoGPS list sync and at start.
   */
  async claimFleetPlates() {
    const owners = new Map(); // plate -> vehicle ids
    for (const v of this.h.all('SELECT * FROM vehicles WHERE active = 1')) {
      for (const k of new Set([plateKey(v.plate), plateKey(v.name)])) {
        if (!plates.isValid(k)) continue;
        if (!owners.has(k)) owners.set(k, new Set());
        owners.get(k).add(v.id);
      }
    }
    const decided = new Set(this.h.all('SELECT plate FROM plate_links').map((r) => r.plate));
    const waiting = this.h.all(`SELECT DISTINCT plate FROM gate_events WHERE vehicle_id IS NULL AND plate_valid = 1
      AND plate IS NOT NULL AND status IN ('outside', 'history')`).map((r) => r.plate);
    let rows = [];
    const claimed = [];
    this.h.tx(() => {
      for (const plate of waiting) {
        const ids = owners.get(plate);
        if (!ids || ids.size !== 1 || decided.has(plate)) continue;
        const [vehicleId] = ids;
        const r = this.h.all("SELECT id, t FROM gate_events WHERE plate = ? AND vehicle_id IS NULL AND plate_valid = 1 AND status IN ('outside', 'history')", plate);
        this.h.run(`UPDATE gate_events SET vehicle_id = ?, identified_by = 'plate', status = 'history', status_note = ?, resolve_at = NULL
          WHERE plate = ? AND vehicle_id IS NULL AND plate_valid = 1 AND status IN ('outside', 'history')`, vehicleId, "GPS'dagi nomi bo'yicha keyin biriktirildi", plate);
        rows = rows.concat(r);
        claimed.push(`${prettyPlate(plate)} (${r.length})`);
      }
    });
    if (!rows.length) return { moved: 0 };
    this.log.info?.(`Past passes to the truck with that plate in GPS: ${claimed.join(', ')}`);
    const days = await this._recount(rows);
    return { moved: rows.length, days: days.length };
  }

  /** Past passes of the plate go to the vehicle. Returns how many, and the days to recount. */
  _move(plate, vehicleId) {
    const rows = this.h.all('SELECT id, t FROM gate_events WHERE plate = ? AND vehicle_id IS NULL AND plate_valid = 1', plate);
    this.h.run(`UPDATE gate_events SET vehicle_id = ?, identified_by = 'link', status_note = ?,
      status = CASE status WHEN 'outside' THEN 'history' ELSE status END, resolve_at = CASE status WHEN 'pending' THEN resolve_at ELSE NULL END
      WHERE plate = ? AND vehicle_id IS NULL AND plate_valid = 1`, vehicleId, NOTE, plate);
    return rows;
  }

  /** Recount after passes moved. Local tables only: past days' km don't change, and GoGPS isn't asked. */
  async _recount(rows) {
    const days = [...new Set(rows.map((r) => T.dayOf(r.t)))];
    for (const day of days) await this.analytics.rollup(day, { withGps: false });
    if (this.trips) await this.trips.rebuild(rows.length ? Math.min(...rows.map((r) => r.t)) - T.DAY : undefined);
    bus.emit('vehicles');
    return days;
  }

  /** This GPS truck has this plate. */
  async link(raw, vehicleId, user) {
    const plate = this._plate(raw, vehicleId);
    const v = this.h.get('SELECT * FROM vehicles WHERE id = ?', vehicleId);
    if (!v) throw httpError(404, 'Transport topilmadi');
    let rows;
    this.h.tx(() => {
      this.h.run("INSERT INTO plate_links (plate, kind, vehicle_id, by_user, at) VALUES (?, 'vehicle', ?, ?, ?)", plate, vehicleId, user?.id ?? null, Date.now());
      rows = this._move(plate, vehicleId);
    });
    const days = await this._recount(rows);
    return { plate, vehicleId, label: vehicleLabel(v), moved: rows.length, days: days.length };
  }

  /** Our truck, with no GPS tracker: a vehicle of its own, known by the plate. */
  async addTruck(raw, { name = null, type = 'auto' } = {}, user) {
    const plate = this._plate(raw);
    const display = typeof name === 'string' && name.trim() ? name.trim().slice(0, NAME_MAX) : null;
    const now = Date.now();
    let id, rows;
    this.h.tx(() => {
      id = Math.max(FIRST_OWN_ID, (this.h.get('SELECT MAX(id) m FROM vehicles').m || 0) + 1);
      this.h.run('INSERT INTO vehicles (id, name, plate, display, type, active, in_gps, camera_only, updated_at) VALUES (?, ?, ?, ?, ?, 1, 0, 1, ?)', id, prettyPlate(plate), plate, display, type, now);
      this.h.run("INSERT INTO plate_links (plate, kind, vehicle_id, created, by_user, at) VALUES (?, 'vehicle', ?, 1, ?, ?)", plate, id, user?.id ?? null, now);
      rows = this._move(plate, id);
    });
    const days = await this._recount(rows);
    return { plate, vehicleId: id, label: display || prettyPlate(plate), moved: rows.length, days: days.length };
  }

  /** Not ours: stop suggesting it. It stays an outsider, and "learned" matching won't claim it either. */
  markOutside(raw, user) {
    const plate = this._plate(raw);
    this.h.run("INSERT INTO plate_links (plate, kind, by_user, at) VALUES (?, 'outside', ?, ?)", plate, user?.id ?? null, Date.now());
    return { plate };
  }

  /** Back to undecided: its passes are outsiders again, and a vehicle made for it goes away with what was counted. */
  async undo(raw) {
    const plate = plateKey(raw);
    const l = this.h.get('SELECT * FROM plate_links WHERE plate = ?', plate);
    if (!l) throw httpError(404, 'Topilmadi');
    let rows = [];
    this.h.tx(() => {
      this.h.run('DELETE FROM plate_links WHERE plate = ?', plate);
      if (l.kind !== 'vehicle') return;
      const made = l.created && !this.h.get('SELECT 1 FROM plate_links WHERE vehicle_id = ?', l.vehicle_id);
      rows = made ? this.h.all('SELECT id, t FROM gate_events WHERE vehicle_id = ?', l.vehicle_id)
        : this.h.all("SELECT id, t FROM gate_events WHERE plate = ? AND identified_by = 'link'", plate);
      for (const r of rows) {
        this.h.run(`UPDATE gate_events SET vehicle_id = NULL, identified_by = NULL, status_note = ?,
          status = CASE status WHEN 'vetoed' THEN 'vetoed' ELSE 'outside' END, resolve_at = NULL WHERE id = ?`, "GPS ro'yxatida yo'q", r.id);
      }
      if (made) {
        this.h.run('DELETE FROM trips WHERE vehicle_id = ?', l.vehicle_id);
        this.h.run('DELETE FROM daily_stats WHERE vehicle_id = ?', l.vehicle_id);
        this.h.run('DELETE FROM vehicles WHERE id = ?', l.vehicle_id);
      }
    });
    await this._recount(rows);
    return { plate, moved: rows.length };
  }
}

module.exports = { PlateLinks, MIN_PASSES, MIN_DAYS };
