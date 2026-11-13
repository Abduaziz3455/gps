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
  type       TEXT NOT NULL,                -- fuel_drain | no_signal | long_stop | system (speeding: old rows only)
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
CREATE TABLE IF NOT EXISTS gps_segments (      -- GoGPS's moves and stops, kept because it takes 48 s to ask (src/trips.js)
  vehicle_id INTEGER NOT NULL,
  start_t    INTEGER NOT NULL,
  kind       TEXT NOT NULL,                -- move | stop
  end_t      INTEGER NOT NULL,
  km         REAL,
  address    TEXT,
  PRIMARY KEY (vehicle_id, start_t, kind)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS gps_segments_t ON gps_segments(start_t);
CREATE TABLE IF NOT EXISTS gps_segment_days (day TEXT PRIMARY KEY, synced_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS trips (             -- worked out, never edited: can be deleted and rebuilt (src/trips.js)
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id   INTEGER NOT NULL,
  day          TEXT NOT NULL,                -- the day it left, or came back when no exit was seen
  start_t      INTEGER,                      -- NULL: no exit seen
  end_t        INTEGER,                      -- NULL: on the road, or no return seen
  start_src    TEXT,                         -- gps | camera
  end_src      TEXT,
  out_event    INTEGER,                      -- gate event with the photos
  in_event     INTEGER,
  km           REAL,
  km_src       TEXT,                         -- gps | positions (GoGPS hasn't answered yet: comes out about 9% short)
  far_m        INTEGER,                      -- farthest from the yard
  near         INTEGER NOT NULL DEFAULT 0,   -- 1: never got away from the plant
  stops        TEXT NOT NULL DEFAULT '[]',   -- JSON [{s, e, a: address, lat, lng, y: at the yard}]
  refuel_l     REAL NOT NULL DEFAULT 0,
  drain_l      REAL NOT NULL DEFAULT 0,
  fuel_used    REAL,                         -- NULL: no fuel sensor, or not asked yet
  fuel_checked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS trips_day ON trips(day);
CREATE INDEX IF NOT EXISTS trips_v ON trips(vehicle_id, start_t);
CREATE TABLE IF NOT EXISTS plate_links (       -- the owner's decision about a plate the cameras read (src/platelinks.js)
  plate      TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,                  -- vehicle | outside
  vehicle_id INTEGER,                        -- kind vehicle
  created    INTEGER NOT NULL DEFAULT 0,     -- 1: the vehicle was made for this plate (no GPS tracker)
  by_user    INTEGER,
  at         INTEGER NOT NULL
);
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
CREATE TABLE IF NOT EXISTS outbox (            -- durable delivery queue, one row per recipient (src/notify/outbox.js)
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  channel      TEXT NOT NULL,                -- telegram (more can be added)
  target       TEXT NOT NULL,                -- chat id, in the channel's own terms
  kind         TEXT NOT NULL,                -- what the channel's sender does with it: gate | text | legacy
  ref          INTEGER,                      -- e.g. the gate event
  payload      TEXT,                         -- JSON
  dedupe       TEXT,                         -- same channel + target + dedupe: queued once
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed
  attempts     INTEGER NOT NULL DEFAULT 0,
  next_attempt INTEGER NOT NULL,
  last_error   TEXT,
  created_at   INTEGER NOT NULL,
  sent_at      INTEGER
);
CREATE INDEX IF NOT EXISTS outbox_due ON outbox(status, next_attempt);
CREATE UNIQUE INDEX IF NOT EXISTS outbox_once ON outbox(channel, target, dedupe) WHERE dedupe IS NOT NULL;
CREATE TABLE IF NOT EXISTS tg_recipients (     -- Telegram chats added with bot commands (/ulash, /qoshish)
  chat_id  TEXT PRIMARY KEY,
  kind     TEXT NOT NULL,                    -- group | user
  title    TEXT NOT NULL,
  added_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tg_alerts (         -- what was sent for a gate event: the same text and photos for every recipient
  event_id INTEGER PRIMARY KEY,
  caption  TEXT NOT NULL,
  file_ids TEXT,                             -- JSON: Telegram's copies, so further recipients need no upload
  built_at INTEGER NOT NULL
);
`;

/** Columns added after the first release. CREATE TABLE IF NOT EXISTS doesn't touch a table that already exists. */
const ADDED_COLUMNS = {
  users: {
    telegram_id: 'TEXT',     // the Telegram account linked to this user in the mini app (src/telegram/webapp.js)
    telegram_name: 'TEXT',   // its name as Telegram gave it, for Settings → Users
  },
  sessions: {
    via: 'TEXT',             // NULL: the login form. telegram: the mini app (ends when Telegram is unlinked)
  },
  vehicles: {
    camera_only: 'INTEGER NOT NULL DEFAULT 0', // 1: our truck with no GPS tracker, known by its plate alone
  },
  gate_events: {
    top_view: 'TEXT',        // pending | done | none (looked, no vehicle) | failed; NULL: not wanted (history, no top view camera)
    top_view_note: 'TEXT',
    top_view_tries: 'INTEGER NOT NULL DEFAULT 0',
    alert_state: 'TEXT',     // pending until the event is final (GPS decided, top view settled); then done
    read_by: 'TEXT',         // NULL: the camera's read. own: our reader, from live video (the camera's capture was missing).
                             // own-reread: our reader re-read the camera's picture, which the camera couldn't read
    read_conf: 'REAL',       // our reader's confidence (weakest character), when it read the plate
  },
};

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  for (const [table, cols] of Object.entries(ADDED_COLUMNS)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [col, type] of Object.entries(cols)) if (!have.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_telegram ON users(telegram_id) WHERE telegram_id IS NOT NULL');
  db.exec("CREATE INDEX IF NOT EXISTS gate_events_work ON gate_events(alert_state, top_view) WHERE alert_state = 'pending' OR top_view = 'pending'");
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
