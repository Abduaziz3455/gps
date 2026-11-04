'use strict';
/**
 * SQLite (Node's built-in node:sqlite). One connection, used synchronously from the single Node thread,
 * so there are no locking concerns. Times are epoch milliseconds; days are local 'YYYY-MM-DD'.
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('owner', 'dispatcher')),
  pass_hash     TEXT NOT NULL,
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ua         TEXT,
  ip         TEXT
);
CREATE TABLE IF NOT EXISTS vehicles (
  id         INTEGER PRIMARY KEY,          -- GoGPS vehicleId
  guid       TEXT,
  name       TEXT NOT NULL,                -- name in GoGPS
  model      TEXT,
  plate      TEXT,                         -- real plate when it differs from the GPS name (owner sets it)
  display    TEXT,                         -- optional display name ("Mikser 31")
  type       TEXT NOT NULL DEFAULT 'auto', -- auto | mixer | dump | excavator | car | other
  fuel_norm  REAL,                         -- L/100 km, for the fuel analytics
  active     INTEGER NOT NULL DEFAULT 1,   -- 0: hidden (sold, broken tracker)
  in_gps     INTEGER NOT NULL DEFAULT 1,   -- 0: no longer in the GoGPS list
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS positions (
  vehicle_id INTEGER NOT NULL,
  t          INTEGER NOT NULL,             -- GPS record time
  lat        REAL NOT NULL,
  lng        REAL NOT NULL,
  speed      REAL NOT NULL,
  course     REAL,
  status     TEXT NOT NULL,
  PRIMARY KEY (vehicle_id, t)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS positions_t ON positions(t);
CREATE TABLE IF NOT EXISTS yard_visits (       -- GPS: inside the yard circle
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL,
  enter_t    INTEGER NOT NULL,
  exit_t     INTEGER,                     -- NULL while inside
  approx     INTEGER NOT NULL DEFAULT 0   -- 1: already inside when first seen (enter time unknown)
);
CREATE INDEX IF NOT EXISTS yard_visits_v ON yard_visits(vehicle_id, enter_t);
CREATE INDEX IF NOT EXISTS yard_visits_exit ON yard_visits(exit_t);
CREATE TABLE IF NOT EXISTS gate_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  capture_name   TEXT NOT NULL UNIQUE,     -- NVR record name
  t              INTEGER NOT NULL,         -- capture time
  direction      TEXT NOT NULL,            -- in | out
  camera         TEXT NOT NULL,
  channel        INTEGER NOT NULL,
  plate          TEXT,                     -- after misread correction
  plate_raw      TEXT,
  plate_valid    INTEGER NOT NULL DEFAULT 0,
  vehicle_id     INTEGER,                  -- fleet vehicle, when identified
  identified_by  TEXT,                     -- plate | alias | similar | learned | gps
  status         TEXT NOT NULL,            -- pending | confirmed | unconfirmed | vetoed | outside | history
  status_note    TEXT,
  stay_s         INTEGER,                  -- time inside, on exits (cameras)
  gap            INTEGER NOT NULL DEFAULT 0,
  capture_uri    TEXT,                     -- NVR picture path (photos of history events are fetched on demand)
  photos         TEXT NOT NULL DEFAULT '[]', -- JSON [{name, file}]
  notified       INTEGER NOT NULL DEFAULT 0,
  resolve_at     INTEGER,                  -- when to look at GPS again (pending only)
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS gate_events_t ON gate_events(t);
CREATE INDEX IF NOT EXISTS gate_events_v ON gate_events(vehicle_id, t);
CREATE INDEX IF NOT EXISTS gate_events_pending ON gate_events(status, resolve_at);
CREATE TABLE IF NOT EXISTS alias_hits (        -- plate read at the exit while exactly this vehicle left the yard
  plate      TEXT NOT NULL,
  vehicle_id INTEGER NOT NULL,
  hits       INTEGER NOT NULL,
  last       INTEGER NOT NULL,
  PRIMARY KEY (plate, vehicle_id)
);
CREATE TABLE IF NOT EXISTS daily_stats (
  day          TEXT NOT NULL,
  vehicle_id   INTEGER NOT NULL,
  km           REAL NOT NULL DEFAULT 0,
  engine_s     INTEGER NOT NULL DEFAULT 0,
  idle_s       INTEGER NOT NULL DEFAULT 0,
  fuel_used    REAL,                       -- NULL: no fuel sensor
  fuel_start   REAL,
  fuel_end     REAL,
  refuel_l     REAL NOT NULL DEFAULT 0,
  drain_l      REAL NOT NULL DEFAULT 0,
  odometer     REAL,
  trips_out    INTEGER NOT NULL DEFAULT 0,
  trips_in     INTEGER NOT NULL DEFAULT 0,
  turnaround_s INTEGER,                    -- average exit -> next entry
  yard_s       INTEGER,                    -- total time inside (cameras)
  max_speed    REAL,
  first_out    INTEGER,
  last_in      INTEGER,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (day, vehicle_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS fuel_events (
  vehicle_id INTEGER NOT NULL,
  t          INTEGER NOT NULL,
  kind       TEXT NOT NULL,                -- refuel | drain
  litres     REAL NOT NULL,
  PRIMARY KEY (vehicle_id, t, kind)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS alerts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT NOT NULL UNIQUE,         -- dedupe: one alert per incident
  type       TEXT NOT NULL,                -- fuel_drain | speeding | no_signal | long_stop | system
  severity   TEXT NOT NULL,                -- info | warning | critical
  vehicle_id INTEGER,
  t          INTEGER NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT,
  data       TEXT,
  acked_by   INTEGER,
  acked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS alerts_t ON alerts(t);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  prefs      TEXT NOT NULL,
  ua         TEXT,
  created_at INTEGER NOT NULL,
  last_ok    INTEGER,
  fails      INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS places (            -- areas the owner named, from a point where a truck stopped
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  lat        REAL NOT NULL,
  lng        REAL NOT NULL,
  radius_m   INTEGER NOT NULL,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS place_visits (      -- worked out from positions (src/places.js)
  place_id   INTEGER NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  vehicle_id INTEGER NOT NULL,
  enter_t    INTEGER NOT NULL,
  exit_t     INTEGER NOT NULL,
  stopped_s  INTEGER NOT NULL,
  PRIMARY KEY (place_id, vehicle_id, enter_t)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS place_visits_v ON place_visits(vehicle_id, enter_t);
`;

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

/** Small helpers so call sites stay short. Statements are cached per SQL text. */
function helpers(db) {
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = db.prepare(sql); cache.set(sql, s); }
    return s;
  };
  return {
    db,
    all: (sql, ...args) => stmt(sql).all(...args),
    get: (sql, ...args) => stmt(sql).get(...args),
    run: (sql, ...args) => stmt(sql).run(...args),
    tx(fn) {
      db.exec('BEGIN');
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    kvGet(k, d = null) {
      const r = stmt('SELECT v FROM kv WHERE k = ?').get(k);
      return r ? JSON.parse(r.v) : d;
    },
    kvSet(k, v) {
      stmt('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(v));
    },
  };
}

module.exports = { open, helpers };
