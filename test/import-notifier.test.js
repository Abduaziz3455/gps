'use strict';
// The move from the old Python bot: nothing it finished happens again, nothing it hadn't finished is lost.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { open, helpers } = require('../src/db');
const { importNotifier, parseAlertFolder } = require('../scripts/import-notifier');

const CAMERAS = [{ channel: 4, contextChannel: 5, topView: { from: -2, to: 2 } }, { channel: 3, contextChannel: 6, topView: { from: -2, to: 2 } }];
const iso = (ms) => new Date(ms + 5 * 3600e3).toISOString().slice(0, 19);

function setup(t, now) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const legacy = new DatabaseSync(':memory:');
  legacy.exec(`CREATE TABLE sightings (name TEXT PRIMARY KEY, channel INT, camera TEXT, time TEXT, plate TEXT);
    CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE held (name TEXT PRIMARY KEY, due TEXT, decision TEXT);
    CREATE TABLE recipients (chat_id TEXT PRIMARY KEY, kind TEXT, title TEXT, added TEXT);
    CREATE TABLE outbox (id INTEGER PRIMARY KEY, created TEXT, alert_dir TEXT, chat_id TEXT, status TEXT, attempts INT, next_attempt TEXT, last_error TEXT, sent_at TEXT);`);
  const db = open(':memory:');
  const h = helpers(db);
  h.run('INSERT INTO vehicles (id, name, updated_at) VALUES (21312, ?, ?)', '85 519 EBA', now);
  h.run('INSERT INTO vehicles (id, name, updated_at) VALUES (33959, ?, ?)', '10 870 HAD', now);
  let n = 0;
  const ev = (t0, o = {}) => {
    const name = `rec${++n}`;
    h.run(`INSERT INTO gate_events (capture_name, t, direction, camera, channel, plate, plate_valid, vehicle_id, status, status_note, created_at, photos)
      VALUES (?, ?, ?, 'cam', ?, 'P', 1, ?, ?, ?, ?, ?)`, name, t0, o.direction || 'in', o.direction === 'out' ? 3 : 4, o.vehicle ?? 1, o.status || 'confirmed', o.note || null, now, o.photos || '[]');
    return { name, id: n };
  };
  return { dir, legacy, h, ev };
}

test('folder names of the old archive', () => {
  assert.deepEqual(parseAlertFolder('2026-11-05', '113350_out_85450KBA'), { t: Date.parse('2026-11-05T11:33:50+05:00'), direction: 'out' });
  assert.equal(parseAlertFolder('2026-11-05', 'junk'), null);
});

test('state carries over: recipients, moved groups, offset and report marks', (t) => {
  const now = Date.now();
  const s = setup(t, now);
  s.legacy.exec(`INSERT INTO recipients VALUES ('-1001234567890', 'group', 'Hisobchilar', '2026-10-12T18:31:28'), ('7654321', 'user', 'Ali', '2026-10-12T19:23:52');
    INSERT INTO kv VALUES ('telegram_offset', '530483517'), ('daily_report', '2026-11-04'), ('monthly_report', '2026-10'), ('migrated:-55', '-100777'), ('watchdog_failed_id', '26');
    INSERT INTO sightings VALUES ('old', 4, 'ANPR-1', '${iso(now - 60e3)}', 'X');`);
  const r = importNotifier({ legacy: s.legacy, h: s.h, photoDir: path.join(s.dir, 'photos'), now, cameras: CAMERAS });
  assert.equal(r.recipients, 2);
  assert.deepEqual(s.h.all('SELECT chat_id, kind, title FROM tg_recipients ORDER BY added_at').map((x) => x.title), ['Hisobchilar', 'Ali']);
  assert.equal(s.h.kvGet('tg_offset'), 530483517);
  assert.equal(s.h.kvGet('tg_daily_report'), '2026-11-04');
  assert.equal(s.h.kvGet('tg_monthly_report'), '2026-10');
  assert.equal(s.h.kvGet('tg_moved:-55'), '-100777');
});

test('alerts: only what it had not finished, nothing it already sent', (t) => {
  const now = Date.now();
  const s = setup(t, now);
  const before = s.ev(now - 600e3);           // it saw this one: sent by the old bot
  const after = s.ev(now - 60e3);             // after its last capture: ours to send
  const heldOne = s.ev(now - 700e3);          // it was holding this for GPS when it stopped
  const vetoed = s.ev(now - 50e3, { status: 'vetoed' });
  const tooOld = s.ev(now - 7 * 3600e3);
  s.legacy.exec(`INSERT INTO sightings VALUES ('old', 4, 'ANPR-1', '${iso(now - 300e3)}', 'X'); INSERT INTO held VALUES ('${heldOne.name}', '2026', '{}');`);
  const r = importNotifier({ legacy: s.legacy, h: s.h, photoDir: path.join(s.dir, 'photos'), now, cameras: CAMERAS });
  assert.equal(r.catchUp, 1);
  assert.equal(r.held, 1);
  const state = (e) => s.h.get('SELECT alert_state a, top_view v FROM gate_events WHERE id = ?', e.id);
  assert.equal(state(before).a, null);
  assert.equal(state(tooOld).a, null);
  assert.equal(state(vetoed).a, null);
  assert.deepEqual(state(after), { a: 'pending', v: 'pending' });
  assert.deepEqual(state(heldOne), { a: 'pending', v: 'pending' });
});

test('its unsent queue is sent from here, photos included', (t) => {
  const now = Date.now();
  const s = setup(t, now);
  const folder = path.join(s.dir, 'alerts', '2026-11-05', '113350_out_X');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'caption.txt'), '🔴 CHIQDI');
  fs.writeFileSync(path.join(folder, '1_ANPR-2.jpg'), 'a');
  fs.writeFileSync(path.join(folder, '2_Yo_l-1.jpg'), 'b');
  s.legacy.exec(`INSERT INTO outbox (id, created, alert_dir, chat_id, status, attempts, next_attempt) VALUES (1, '2026', '/app/data/alerts/2026-11-05/113350_out_X', '-5', 'pending', 2, '2026');`);
  const r = importNotifier({ legacy: s.legacy, h: s.h, photoDir: path.join(s.dir, 'data', 'photos'), alertsDir: path.join(s.dir, 'alerts'), now, cameras: CAMERAS });
  assert.equal(r.queued, 1);
  const row = s.h.get("SELECT * FROM outbox WHERE kind = 'legacy'");
  assert.equal(row.target, '-5');
  const p = JSON.parse(row.payload);
  assert.equal(p.text, '🔴 CHIQDI');
  assert.deepEqual(p.photos.map((x) => x.name), ['ANPR-2', 'Yo_l-1']);
  assert.ok(fs.existsSync(p.photos[0].file));
});

test('archive: load photos go into the history, and an exit it alerted is no longer vetoed; a manual decision stays', (t) => {
  const now = Date.parse('2026-11-05T18:00:00+05:00');
  const s = setup(t, now);
  const t0 = Date.parse('2026-11-05T11:33:50+05:00');
  const wrong = s.ev(t0, { direction: 'out', status: 'vetoed', note: 'GPS: 5 daqiqadan keyin ham hovlida turibdi', photos: JSON.stringify([{ name: 'ANPR-2', file: 'x.jpg' }]) });
  const t1 = t0 + 3600e3;
  const manual = s.ev(t1, { direction: 'out', status: 'vetoed', note: "Qo'lda: Rahbar" });
  for (const [t2, d] of [[t0, '113350_out_85450KBA'], [t1, '123350_out_85450KBA']]) {
    void t2;
    const f = path.join(s.dir, 'alerts', '2026-11-05', d);
    fs.mkdirSync(f, { recursive: true });
    fs.writeFileSync(path.join(f, '2_Yo_l-1.jpg'), 'LOAD');
  }
  const photoDir = path.join(s.dir, 'photos');
  const r = importNotifier({ legacy: s.legacy, h: s.h, photoDir, alertsDir: path.join(s.dir, 'alerts'), now, cameras: CAMERAS });
  assert.equal(r.vetoesReversed, 1);
  assert.deepEqual([...r.days], ['2026-11-05']);
  const row = s.h.get('SELECT * FROM gate_events WHERE id = ?', wrong.id);
  assert.equal(row.status, 'unconfirmed');
  const photos = JSON.parse(row.photos);
  assert.equal(photos.length, 2);
  assert.equal(photos[1].name, "Yo'l-1");
  assert.equal(photos[1].v, 'top');
  assert.equal(fs.readFileSync(path.join(photoDir, photos[1].file), 'utf8'), 'LOAD');
  assert.equal(s.h.get('SELECT status s FROM gate_events WHERE id = ?', manual.id).s, 'vetoed');
});

test('aliases: a plate known under another GPS name; names that no longer exist are skipped', (t) => {
  const now = Date.now();
  const s = setup(t, now);
  const r = importNotifier({ legacy: s.legacy, h: s.h, photoDir: path.join(s.dir, 'p'), aliases: { '10964DDA': '85 519 EBA', '10840HDA': '37' }, now, cameras: CAMERAS });
  assert.deepEqual(r.aliases, ['10964DDA = 85 519 EBA']);
  assert.equal(s.h.get('SELECT plate FROM vehicles WHERE id = 21312').plate, '10964DDA');
});

test('aliases: passes taken for an outside vehicle become that truck\'s', (t) => {
  const now = Date.now();
  const s = setup(t, now);
  const id = Number(s.h.run(`INSERT INTO gate_events (capture_name, t, direction, camera, channel, plate, plate_valid, status, status_note, created_at)
    VALUES ('r', ?, 'in', 'c', 4, '10964DDA', 1, 'outside', ?, ?)`, now - 3600e3, "GPS ro'yxatida yo'q", now).lastInsertRowid);
  const r = importNotifier({ legacy: s.legacy, h: s.h, photoDir: path.join(s.dir, 'p'), aliases: { '10964DDA': '85 519 EBA' }, now, cameras: CAMERAS });
  assert.equal(r.relinked, 1);
  const row = s.h.get('SELECT * FROM gate_events WHERE id = ?', id);
  assert.equal(row.vehicle_id, 21312);
  assert.equal(row.status, 'unconfirmed');
  assert.equal(row.status_note, null);
  assert.equal(r.days.size, 1);
});

test('the old database still has its write-ahead log after a stop: it is read with what is in the log', (t) => {
  const now = Date.now();
  const s = setup(t, now);
  const file = path.join(s.dir, 'events.db');
  const writer = new DatabaseSync(file);
  writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE sightings (name TEXT, channel INT, camera TEXT, time TEXT, plate TEXT); CREATE TABLE kv (k TEXT, v TEXT); CREATE TABLE held (name TEXT, due TEXT, decision TEXT); CREATE TABLE recipients (chat_id TEXT, kind TEXT, title TEXT, added TEXT); CREATE TABLE outbox (alert_dir TEXT, chat_id TEXT, status TEXT); INSERT INTO recipients VALUES ('-1', 'group', 'G', '2026-10-12T18:31:28');");
  // Copied while the log is still there, as a stopped container leaves it.
  const copy = path.join(s.dir, 'copy');
  fs.mkdirSync(copy);
  for (const f of fs.readdirSync(s.dir).filter((x) => x.startsWith('events.db'))) fs.copyFileSync(path.join(s.dir, f), path.join(copy, f));
  writer.close();
  assert.ok(fs.existsSync(path.join(copy, 'events.db-wal')), 'the test needs the log');
  const legacy = new DatabaseSync(path.join(copy, 'events.db'), { readOnly: true });
  const r = importNotifier({ legacy, h: s.h, photoDir: path.join(s.dir, 'p'), now, cameras: CAMERAS });
  legacy.close();
  assert.equal(r.recipients, 1);
});

test('dry run: reports everything, changes nothing, files included', (t) => {
  const now = Date.parse('2026-11-05T18:00:00+05:00');
  const s = setup(t, now);
  s.legacy.exec("INSERT INTO recipients VALUES ('1', 'user', 'A', '2026-10-12T18:31:28'); INSERT INTO kv VALUES ('telegram_offset', '5');");
  s.ev(Date.parse('2026-11-05T11:33:50+05:00'), { direction: 'out' });
  const f = path.join(s.dir, 'alerts', '2026-11-05', '113350_out_X');
  fs.mkdirSync(f, { recursive: true });
  fs.writeFileSync(path.join(f, '2_Yo_l-1.jpg'), 'LOAD');
  const photoDir = path.join(s.dir, 'p');
  const r = importNotifier({ legacy: s.legacy, h: s.h, photoDir, alertsDir: path.join(s.dir, 'alerts'), now, dryRun: true, cameras: CAMERAS });
  assert.equal(r.recipients, 1);
  assert.equal(r.photos, 1);
  assert.ok(!fs.existsSync(photoDir), 'no files');
  assert.equal(s.h.get('SELECT COUNT(*) n FROM tg_recipients').n, 0);
  assert.equal(s.h.kvGet('tg_offset'), null);
  assert.equal(s.h.kvGet('notifier_imported'), null);
});
