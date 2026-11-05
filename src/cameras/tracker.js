'use strict';
/**
 * Turns ANPR captures into in/out decisions. Rules verified on 264 real
 * captures with the old Python bot.
 *
 * Rules (evidence in docs/site-survey.md):
 * - The camera decides the direction: ANPR-1 faces vehicles entering, ANPR-2 faces vehicles leaving.
 * - Same plate, same direction within `repeatWindowMs`: camera re-trigger or maneuvering -> skip.
 * - Same plate, opposite direction within `samePassWindowMs`: one pass seen by both cameras -> skip.
 * - Only valid plates get presence tracking; unread/invalid plates are still alerted (with a photo).
 *
 * All times are epoch milliseconds.
 */
const plates = require('./plates');

/** Create the tracker's tables (idempotent). */
function migrate(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS cam_sightings (
    name     TEXT PRIMARY KEY,      -- NVR record name (dedupe key)
    channel  INTEGER NOT NULL,
    camera   TEXT NOT NULL,
    time     INTEGER NOT NULL,      -- epoch ms
    plate    TEXT                   -- raw camera read
);
CREATE INDEX IF NOT EXISTS cam_sightings_channel ON cam_sightings(channel, time);
CREATE INDEX IF NOT EXISTS cam_sightings_time ON cam_sightings(time);
CREATE TABLE IF NOT EXISTS cam_passes (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    plate    TEXT NOT NULL,
    kind     TEXT NOT NULL,         -- 'in' | 'out'
    camera   TEXT NOT NULL,
    time     INTEGER NOT NULL       -- epoch ms
);
CREATE INDEX IF NOT EXISTS cam_passes_plate ON cam_passes(plate, time);
CREATE INDEX IF NOT EXISTS cam_passes_time ON cam_passes(time);
CREATE TABLE IF NOT EXISTS cam_presence (
    plate      TEXT PRIMARY KEY,
    inside     INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL,    -- epoch ms of the latest sighting, skipped ones included
    last_event INTEGER NOT NULL     -- epoch ms of the latest emitted in/out
);
CREATE INDEX IF NOT EXISTS cam_presence_inside ON cam_presence(inside);
`);
}

/** Python's str(timedelta), so skip reasons read the same as the notifier's ("repeat after 0:01:00"). */
function fmtDelta(ms) {
  let us = Math.round(ms * 1000);
  const day = 86400e6;
  const days = Math.floor(us / day);
  us -= days * day;
  const s = Math.floor(us / 1e6);
  const frac = us - s * 1e6;
  const hms = `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  const out = frac ? `${hms}.${String(frac).padStart(6, '0')}` : hms;
  return days ? `${days} day${Math.abs(days) === 1 ? '' : 's'}, ${out}` : out;
}

const unique = (xs) => [...new Set(xs)];

class Tracker {
  /**
   * @param {import('node:sqlite').DatabaseSync} db
   * @param {{repeatWindowMs?: number, samePassWindowMs?: number, fleetPlates?: () => string[]}} [opts]
   *   fleetPlates: GPS fleet plates, extra candidates for misread correction.
   */
  constructor(db, { repeatWindowMs = 20 * 60e3, samePassWindowMs = 60e3, fleetPlates = () => [] } = {}) {
    migrate(db);
    this.db = db;
    this.repeatWindowMs = repeatWindowMs;
    this.samePassWindowMs = samePassWindowMs;
    this.fleetPlates = fleetPlates;
    const p = (sql) => db.prepare(sql);
    this.q = {
      addSighting: p('INSERT OR IGNORE INTO cam_sightings (name, channel, camera, time, plate) VALUES (?, ?, ?, ?, ?)'),
      lastSighting: p('SELECT MAX(time) AS t FROM cam_sightings'),
      recentReads: p('SELECT plate FROM cam_sightings WHERE channel = ? AND time >= ? AND time < ? '
        + 'AND plate IS NOT NULL ORDER BY time DESC'),
      presence: p('SELECT inside, last_seen, last_event FROM cam_presence WHERE plate = ?'),
      knownPlates: p('SELECT plate FROM cam_presence'),
      inside: p('SELECT plate FROM cam_presence WHERE inside = 1 ORDER BY last_event'),
      touch: p('UPDATE cam_presence SET last_seen = ? WHERE plate = ? AND last_seen < ?'),
      addPass: p('INSERT INTO cam_passes (plate, kind, camera, time) VALUES (?, ?, ?, ?)'),
      upsertPresence: p('INSERT INTO cam_presence (plate, inside, last_seen, last_event) VALUES (?, ?, ?, ?) '
        + 'ON CONFLICT(plate) DO UPDATE SET inside = excluded.inside, last_seen = excluded.last_seen, '
        + 'last_event = excluded.last_event'),
    };
  }

  // --- store ---

  /** Records a raw NVR capture. Returns false if this record was already processed. */
  addSighting(cap, cameraName) {
    return this.q.addSighting.run(cap.name, cap.channel, cameraName, cap.time, cap.plate ?? null).changes === 1;
  }

  /** Capture time (ms) of the newest processed NVR record; null for a fresh database. */
  lastSightingTime() {
    return this.q.lastSighting.get().t ?? null;
  }

  /** Raw plate reads on one camera in [since, until), newest first. */
  recentReads(channel, since, until) {
    return this.q.recentReads.all(channel, since, until).map((r) => r.plate);
  }

  /** {inside, lastSeen, lastEvent} for a plate, or null if never tracked. */
  presence(plate) {
    const r = this.q.presence.get(plate);
    return r ? { inside: Boolean(r.inside), lastSeen: r.last_seen, lastEvent: r.last_event } : null;
  }

  /** Plates currently believed to be inside the yard, longest-inside first. */
  insidePlates() {
    return this.q.inside.all().map((r) => r.plate);
  }

  knownPlates() {
    return this.q.knownPlates.all().map((r) => r.plate);
  }

  /** A skipped sighting still counts as "seen" (last_seen), without changing the in/out state. */
  touch(plate, time) {
    this.q.touch.run(time, plate, time);
  }

  /** Append an in/out pass and update presence, atomically (a savepoint nests inside a caller's transaction). */
  recordEvent(plate, kind, camera, time) {
    this.db.exec('SAVEPOINT cam_record_event');
    try {
      this.q.addPass.run(plate, kind, camera, time);
      this.q.upsertPresence.run(plate, kind === 'in' ? 1 : 0, time, time);
      this.db.exec('RELEASE cam_record_event');
    } catch (e) {
      this.db.exec('ROLLBACK TO cam_record_event');
      this.db.exec('RELEASE cam_record_event');
      throw e;
    }
  }

  // --- decisions ---

  /**
   * Decide on a capture and record it.
   * @param {{channel: number, time: number, plate: string|null, name: string, uriPath?: string}} cap
   * @param {{channel: number, name: string, direction: 'in'|'out', contextChannel?: number, contextName?: string}} cam
   * @returns {null | {capture: object, camera: object, raw: string|null, plate: string|null, valid: boolean,
   *   emit: boolean, skipReason: string|null, staySeconds: number|null, gap: boolean, direction: 'in'|'out'}}
   *   null if this NVR record was seen before. staySeconds: time inside, on exit. gap: the matching
   *   previous entry/exit was never captured.
   */
  process(cap, cam) {
    if (!this.addSighting(cap, cam.name)) return null;

    const raw = plates.normalize(cap.plate);
    let plate = raw ? plates.correct(raw, unique([...this.knownPlates(), ...this.fleetPlates()])) : null;
    if (plate && !plates.isValid(plate)) {
      // A partial read right after a good read on the same camera is usually the same vehicle,
      // re-captured while maneuvering in view (e.g. A861HA 16 s after 10861HDA).
      const recent = this.recentReads(cap.channel, cap.time - this.samePassWindowMs, cap.time)
        .map(plates.normalize)
        .filter((p) => p && plates.isValid(p));
      plate = plates.correct(raw, unique(recent), 3);
    }
    const valid = plate !== null && plates.isValid(plate);
    const decision = (o) => ({
      capture: cap, camera: cam, raw, plate, valid, emit: true, skipReason: null, staySeconds: null, gap: false,
      direction: cam.direction, ...o,
    });
    if (!valid) return decision({});

    const entering = cam.direction === 'in';
    let stay = null;
    let gap;
    const state = this.presence(plate);
    if (state === null) {
      gap = !entering; // leaving, but we never saw it come in
    } else {
      const sameDir = state.inside === entering;
      const since = cap.time - state.lastEvent;
      if (sameDir && since < this.repeatWindowMs) {
        this.touch(plate, cap.time);
        return decision({ emit: false, skipReason: `repeat after ${fmtDelta(since)}` });
      }
      if (!sameDir && since < this.samePassWindowMs) {
        this.touch(plate, cap.time);
        return decision({ emit: false, skipReason: `same pass, ${fmtDelta(since)} after other camera` });
      }
      if (!entering && state.inside) stay = since;
      gap = sameDir; // the opposite event between the two was never captured
    }

    this.recordEvent(plate, cam.direction, cam.name, cap.time);
    return decision({ staySeconds: stay === null ? null : stay / 1000, gap });
  }
}

module.exports = { Tracker, migrate };
