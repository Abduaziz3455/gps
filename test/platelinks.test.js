'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open, helpers } = require('../src/db');
const T = require('../src/time');
const bus = require('../src/bus');
const plates = require('../src/cameras/plates');
const { Tracker } = require('../src/cameras/tracker');
const { Gate } = require('../src/gate');
const { Analytics } = require('../src/analytics');
const { Trips } = require('../src/trips');
const { Places } = require('../src/places');
const { Reports } = require('../src/reports');
const { GateDetails } = require('../src/gatedetails');
const { PlateLinks } = require('../src/platelinks');

const HOUR = 3600e3, DAY = 24 * HOUR;
const NOW = Date.now();
const YARD = { lat: 41.2655, lng: 69.3418, radiusM: 150, name: 'TBB hovli' };
const CAMS = [
  { channel: 4, name: 'ANPR-1', direction: 'in', contextChannel: null, contextName: null },
  { channel: 3, name: 'ANPR-2', direction: 'out', contextChannel: null, contextName: null },
];

function setup() {
  const db = open(':memory:');
  const h = helpers(db);
  const now = Date.now();
  const add = (id, name, plate = null) => h.run('INSERT INTO vehicles (id, name, plate, updated_at) VALUES (?, ?, ?, ?)', id, name, plate, now);
  add(1, '85 518 EBA');
  add(2, '10 870 HAD');
  add(3, '85 519 EBA', '10964DDA');
  const poller = { live: new Map(), openVisit: new Map() };
  const config = { dataDir: '/nonexistent', yard: YARD, nvr: { cameras: CAMS, resolveAfterSec: 90, exitConfirmMin: 5, matchBeforeSec: 45, matchAfterSec: 90, pollSeconds: 60, catchupHours: 6, backfillDays: 0, keepPhotosDays: 0 } };
  let gate;
  const tracker = new Tracker(db, { fleetPlates: () => gate.fleetPlates() });
  gate = new Gate({ h, nvr: { captureImage: async () => Buffer.alloc(0) }, poller, config, tracker, plates, log: {} });
  const analytics = new Analytics({ h, gps: null, config, log: {} });
  const places = new Places({ h, config, log: {} });
  const trips = new Trips({ h, gps: null, places, config, log: {} });
  const links = new PlateLinks({ h, analytics, trips, log: {} });
  let n = 0;
  const pass = (plate, t, direction = 'in', extra = {}) => Number(h.run(`INSERT INTO gate_events (capture_name, t, direction, camera, channel, plate, plate_valid, vehicle_id, identified_by, status, status_note, created_at)
    VALUES (?, ?, ?, 'cam', 3, ?, ?, ?, ?, ?, ?, ?)`, `c${n++}`, t, direction, plate, extra.valid ?? 1, extra.vehicleId ?? null, extra.by ?? null, extra.status ?? 'outside', extra.note ?? null, t).lastInsertRowid);
  /** A regular: `days` days of an exit and an entry. */
  const regular = (plate, days = 3) => {
    const ts = [];
    // Midday, so an exit and its entry are on one day whatever time the tests run.
    const noon = T.dayStart(T.dayOf(NOW)) + 12 * HOUR;
    for (let d = 1; d <= days; d++) {
      ts.push(noon - d * DAY, noon - d * DAY + HOUR);
      pass(plate, noon - d * DAY, 'out');
      pass(plate, noon - d * DAY + HOUR, 'in');
    }
    return ts;
  };
  const capture = async (channel, t, plate, name = `live_${n++}`) => {
    const cap = { channel, time: t, plate, name, uriPath: '' };
    const d = tracker.process(cap, CAMS.find((c) => c.channel === channel));
    if (d?.emit) await gate.onDecision(d, 'live');
    return h.get('SELECT * FROM gate_events WHERE capture_name = ?', name);
  };
  return { db, h, gate, poller, config, analytics, trips, links, pass, regular, capture };
}

const owner = { id: 1 };

// --- who gets asked about -------------------------------------------------------------------------------

test('a regular is listed with its numbers; a one-off visit, an old plate, a misread and a fleet truck are not', () => {
  const s = setup();
  s.regular('10834HDA', 3);
  s.pass('01A123BC', NOW - DAY); s.pass('01A123BC', NOW - DAY + HOUR, 'out'); // one visit
  for (let d = 40; d < 46; d++) s.pass('01B555CD', NOW - d * DAY); // gone for over a month
  for (let d = 1; d < 6; d++) s.pass('XX', NOW - d * DAY, 'in', { valid: 0 });
  for (let d = 1; d < 6; d++) s.pass('85518EBA', NOW - d * DAY, 'in', { vehicleId: 1, status: 'confirmed' });
  const [r, ...rest] = s.links.unknown();
  assert.equal(rest.length, 0);
  assert.equal(r.plate, '10834HDA');
  assert.equal(r.text, '10 834 HDA');
  assert.equal(r.passes, 6);
  assert.equal(r.in, 3);
  assert.equal(r.out, 3);
  assert.equal(r.days, 3);
  assert.ok(r.photoUrl === null || /\/photo\/0$/.test(r.photoUrl));
});

test('busiest first; a decided plate leaves the list', () => {
  const s = setup();
  s.regular('10834HDA', 2);
  s.regular('10861HDA', 5);
  assert.deepEqual(s.links.unknown().map((r) => r.plate), ['10861HDA', '10834HDA']);
  s.links.markOutside('10861HDA', owner);
  assert.deepEqual(s.links.unknown().map((r) => r.plate), ['10834HDA']);
});

// --- evidence, on what the real plates showed ----------------------------------------------------------

test('a truck that always crosses when the plate passes is suggested', () => {
  const s = setup();
  for (const t of s.regular('10963DDA', 3)) s.h.run('INSERT INTO yard_visits (vehicle_id, enter_t, exit_t) VALUES (1, ?, ?)', t - DAY / 2, t + 60e3);
  const [r] = s.links.unknown();
  assert.equal(r.evidence.suggestion?.vehicleId, 1);
  assert.equal(r.evidence.suggestion.label, '85 518 EBA');
  assert.equal(r.evidence.suggestion.basis, 'crossings');
  assert.equal(r.evidence.noGps, false);
});

/** The plant's street, known from stops with coordinates, and a pass history for one unknown plate. */
function streetSetup(passDays = 6) {
  const s = setup();
  const seg = (vid, a, b, address) => s.h.run("INSERT OR REPLACE INTO gps_segments (vehicle_id, start_t, kind, end_t, address) VALUES (?, ?, 'stop', ?, ?)", vid, a, b, address);
  for (let i = 1; i <= 6; i++) {
    seg(3, NOW - i * HOUR, NOW - i * HOUR + 10 * 60e3, PLANT_STREET);
    s.h.run("INSERT OR IGNORE INTO positions (vehicle_id, t, lat, lng, speed, course, status) VALUES (3, ?, ?, ?, 0, 0, 'stopped')", NOW - i * HOUR + 60e3, YARD.lat, YARD.lng);
  }
  const ts = s.regular('10963DDA', passDays);
  for (const t of [NOW, ...ts]) s.h.run('INSERT OR REPLACE INTO gps_segment_days (day, synced_at) VALUES (?, ?)', T.dayOf(t), NOW);
  return { ...s, seg, ts };
}
const PLANT_STREET = 'Уйсозлар 2-й проезд, Ташкент, Узбекистан';

test('real: 10963DDA and 85 518 EBA, on the street at 60 of 60 passes while nothing else comes close: suggested', () => {
  const s = streetSetup();
  for (const t of s.ts) {
    s.seg(1, t - 20 * 60e3, t + 60e3, PLANT_STREET);
    if (Math.floor((t - NOW) / HOUR) % 2 === 0) s.seg(2, t - 20 * 60e3, t + 60e3, PLANT_STREET);
  }
  const [r] = s.links.unknown();
  assert.equal(r.evidence.suggestion?.vehicleId, 1);
  assert.equal(r.evidence.suggestion.basis, 'street');
  assert.equal(r.evidence.suggestion.hits, 12);
  assert.equal(r.evidence.suggestion.checked, 12);
});

test('street: another truck there nearly as often: no suggestion, and no claim it has no GPS', () => {
  const s = streetSetup();
  for (const t of s.ts) { s.seg(1, t - 60e3, t + 60e3, PLANT_STREET); s.seg(2, t - 60e3, t + 60e3, PLANT_STREET); }
  const [r] = s.links.unknown();
  assert.equal(r.evidence.suggestion, null);
  assert.equal(r.evidence.noGps, false);
});

test('real: 10834HDA, best fit 43 of 60: may have no tracker, and no truck is suggested', () => {
  const s = streetSetup();
  s.ts.forEach((t, i) => { if (i % 3) s.seg(2, t - 60e3, t + 60e3, PLANT_STREET); });
  const [r] = s.links.unknown();
  assert.equal(r.evidence.suggestion, null);
  assert.equal(r.evidence.noGps, true);
});

test('real: while history is still being fetched, passes on days not fetched yet say nothing about a truck', () => {
  const s = streetSetup();
  for (const t of s.ts) s.seg(1, t - 60e3, t + 60e3, PLANT_STREET);
  // Only the newest day is in: 2 of 12 passes. Counted as misses, this read "may have no tracker" for 10963DDA on 5 Nov.
  s.h.run('DELETE FROM gps_segment_days');
  s.h.run('INSERT INTO gps_segment_days (day, synced_at) VALUES (?, ?)', T.dayOf(s.ts[0]), NOW);
  let [r] = s.links.unknown();
  assert.equal(r.evidence.suggestion, null);
  assert.equal(r.evidence.noGps, false);
  // Once they are in, the same passes give the answer.
  for (const t of s.ts) s.h.run('INSERT OR REPLACE INTO gps_segment_days (day, synced_at) VALUES (?, ?)', T.dayOf(t), NOW);
  [r] = s.links.unknown();
  assert.equal(r.evidence.suggestion?.vehicleId, 1);
});

test('street: too few passes to tell', () => {
  const s = streetSetup(3);
  for (const t of s.ts) s.seg(1, t - 60e3, t + 60e3, PLANT_STREET);
  assert.equal(s.links.unknown()[0].evidence.suggestion, null);
});

test('real: 10834HDA passes and no GPS truck crosses with it: probably no tracker', () => {
  const s = setup();
  for (const t of s.regular('10834HDA', 3)) s.h.run('INSERT OR REPLACE INTO gps_segment_days (day, synced_at) VALUES (?, ?)', T.dayOf(t), NOW);
  s.h.run('INSERT INTO yard_visits (vehicle_id, enter_t, exit_t) VALUES (2, ?, ?)', NOW - 10 * DAY, NOW - 9 * DAY);
  const [r] = s.links.unknown();
  assert.equal(r.evidence.suggestion, null);
  assert.equal(r.evidence.noGps, true);
});

test('before there are GPS crossings to compare, it says neither', () => {
  const s = setup();
  s.regular('10834HDA', 3);
  const [r] = s.links.unknown();
  assert.equal(r.evidence.suggestion, null);
  assert.equal(r.evidence.noGps, false);
});

test('a truck with its own capture at that moment is not the unknown plate', () => {
  const s = setup();
  for (const t of s.regular('10963DDA', 3)) {
    s.h.run('INSERT INTO yard_visits (vehicle_id, enter_t, exit_t) VALUES (2, ?, ?)', t - DAY / 2, t + 60e3);
    s.pass('10870HDA', t, 'out', { vehicleId: 2, status: 'confirmed' });
    s.pass('10870HDA', t, 'in', { vehicleId: 2, status: 'confirmed' });
  }
  assert.equal(s.links.unknown()[0].evidence.suggestion, null);
});

test('no suggestion when two trucks fit about equally', () => {
  const s = setup();
  for (const t of s.regular('10963DDA', 3)) {
    s.h.run('INSERT INTO yard_visits (vehicle_id, enter_t, exit_t) VALUES (1, ?, ?)', t - DAY / 2, t + 60e3);
    s.h.run('INSERT INTO yard_visits (vehicle_id, enter_t, exit_t) VALUES (2, ?, ?)', t - DAY / 2, t + 60e3);
  }
  assert.equal(s.links.unknown()[0].evidence.suggestion, null);
});

test('real: 10963DDA is one character from the fleet\'s 10964DDA: shown, not assumed', () => {
  const s = setup();
  s.regular('10963DDA', 3);
  const [r] = s.links.unknown();
  assert.deepEqual(r.similar.map((x) => x.vehicleId), [3]);
  assert.equal(s.gate.matchPlate('10963DDA'), null);
});

// --- this GPS truck -----------------------------------------------------------------------------------

test('link: past passes move, days are recounted, trips appear; a vetoed pass stays vetoed', async () => {
  const s = setup();
  const ts = s.regular('10963DDA', 3);
  const vetoed = s.pass('10963DDA', NOW - 2 * DAY + 2 * HOUR, 'out', { status: 'vetoed' });
  const r = await s.links.link('10963DDA', 1, owner);
  assert.equal(r.moved, 7);
  assert.equal(r.days, 3);
  assert.equal(r.label, '85 518 EBA');
  const rows = s.h.all("SELECT * FROM gate_events WHERE plate = '10963DDA' AND id != ?", vetoed);
  assert.ok(rows.every((e) => e.vehicle_id === 1 && e.identified_by === 'link' && e.status === 'history'), JSON.stringify(rows[0]));
  assert.equal(s.h.get('SELECT status FROM gate_events WHERE id = ?', vetoed).status, 'vetoed');
  const day = T.dayOf(ts[0]);
  const d = s.h.get('SELECT trips_out, trips_in FROM daily_stats WHERE day = ? AND vehicle_id = 1', day);
  assert.deepEqual({ ...d }, { trips_out: 1, trips_in: 1 });
  const list = s.trips.list({ from: T.addDays(day, -3), to: day });
  assert.equal(list.trips.length, 3);
  assert.ok(list.trips.every((t) => t.vehicleId === 1));
});

test('after a link, a live capture is that truck, with its usual GPS check', async () => {
  const s = setup();
  s.regular('10963DDA', 2);
  await s.links.link('10963DDA', 1, owner);
  const ev = await s.capture(4, NOW, '10963DDA');
  assert.equal(ev.vehicle_id, 1);
  assert.equal(ev.identified_by, 'link');
  assert.equal(ev.status, 'pending');
});

test('a link leaves the truck\'s own reads alone: setting `plate` would have turned off its similar match', async () => {
  const s = setup();
  s.regular('10861HDA', 2);
  await s.links.link('10861HDA', 2, owner);
  assert.equal(s.gate.matchPlate('10870HDA').vehicle.id, 2, 'GPS "10 870 HAD" still matches its usual read');
  assert.equal(s.h.get('SELECT plate FROM vehicles WHERE id = 2').plate, null);
  assert.equal(s.gate.matchPlate('10861HDA').vehicle.id, 2);
  assert.ok(s.gate.fleetPlates().includes('10861HDA'), 'near misreads now snap to it');
});

test('a second plate can go to a truck that already has one', async () => {
  const s = setup();
  s.regular('10963DDA', 2);
  await s.links.link('10963DDA', 3, owner);
  assert.equal(s.gate.matchPlate('10963DDA').vehicle.id, 3);
  assert.equal(s.gate.matchPlate('10964DDA').vehicle.id, 3);
});

test('refused: a bad plate, a truck that does not exist, a plate a truck already has, a plate already decided', async () => {
  const s = setup();
  s.regular('10963DDA', 2);
  await assert.rejects(s.links.link('NONSENSE', 1, owner), (e) => e.status === 400);
  await assert.rejects(s.links.link('10963DDA', 999, owner), (e) => e.status === 404);
  await assert.rejects(s.links.link('10964DDA', 1, owner), (e) => e.status === 409);
  await assert.rejects(s.links.link('85 518 EBA', 2, owner), (e) => e.status === 409, 'the GPS name of another truck');
  await s.links.link('10963DDA', 1, owner);
  await assert.rejects(s.links.link('10963DDA', 2, owner), (e) => e.status === 409);
  await assert.rejects(s.links.addTruck('10963DDA', {}, owner), (e) => e.status === 409);
  assert.equal(s.h.get('SELECT vehicle_id FROM plate_links').vehicle_id, 1);
});

test('undo: passes are outsiders again and the counts follow; a pass corrected by hand stays where it was put', async () => {
  const s = setup();
  const ts = s.regular('10963DDA', 2);
  const manual = s.pass('10963DDA', NOW - 3 * DAY, 'in', { vehicleId: 2, by: 'manual', status: 'confirmed' });
  await s.links.link('10963DDA', 1, owner);
  const r = await s.links.undo('10963DDA');
  assert.equal(r.moved, 4);
  const rows = s.h.all("SELECT * FROM gate_events WHERE plate = '10963DDA' AND id != ?", manual);
  assert.ok(rows.every((e) => e.vehicle_id === null && e.identified_by === null && e.status === 'outside'));
  assert.equal(s.h.get('SELECT vehicle_id FROM gate_events WHERE id = ?', manual).vehicle_id, 2);
  assert.equal(s.gate.matchPlate('10963DDA'), null);
  assert.equal(s.h.get('SELECT trips_out FROM daily_stats WHERE day = ? AND vehicle_id = 1', T.dayOf(ts[0])).trips_out, 0);
  assert.equal(s.links.unknown()[0].plate, '10963DDA', 'it can be decided again');
  await assert.rejects(s.links.undo('10963DDA'), (e) => e.status === 404);
});

// --- our truck, no GPS ---------------------------------------------------------------------------------

test('no tracker: it gets a vehicle of its own, and its trips count from the cameras alone', async () => {
  const s = setup();
  const ts = s.regular('10834HDA', 3);
  const r = await s.links.addTruck('10834HDA', {}, owner);
  assert.ok(r.vehicleId >= 1e9, 'never a GoGPS id');
  assert.equal(r.label, '10 834 HDA');
  assert.equal(r.moved, 6);
  const v = s.h.get('SELECT * FROM vehicles WHERE id = ?', r.vehicleId);
  assert.equal(v.camera_only, 1);
  assert.equal(v.in_gps, 0);
  assert.equal(v.active, 1);
  const d = s.h.get('SELECT trips_out, trips_in FROM daily_stats WHERE day = ? AND vehicle_id = ?', T.dayOf(ts[0]), r.vehicleId);
  assert.deepEqual({ ...d }, { trips_out: 1, trips_in: 1 });
  assert.equal(s.analytics.byVehicle(T.dayOf(ts[4]), T.dayOf(ts[0])).find((x) => x.id === r.vehicleId).trips, 3);
  const trips = s.trips.list({ from: T.dayOf(ts[4]), to: T.dayOf(ts[0]) }).trips.filter((t) => t.vehicleId === r.vehicleId);
  assert.equal(trips.length, 3);
  assert.ok(trips.every((t) => t.durationS === 3600 && t.startSrc === 'camera' && t.km === null));
});

test('no tracker, live: no waiting for GPS and no false warning; the alert goes out at once, counted', async () => {
  const s = setup();
  s.regular('10834HDA', 2);
  const { vehicleId } = await s.links.addTruck('10834HDA', {}, owner);
  const notified = [];
  const on = (e) => notified.push(e.id);
  bus.on('gate:notify', on);
  const ev = await s.capture(3, NOW, '10834HDA');
  bus.off('gate:notify', on);
  assert.equal(ev.vehicle_id, vehicleId);
  assert.equal(ev.status, 'history');
  assert.equal(ev.status_note, "GPS yo'q: faqat kamera");
  assert.equal(ev.resolve_at, null);
  assert.deepEqual(notified, [ev.id]);
});

test('no tracker: GoGPS is not asked, Telegram gets no GPS lines, and the camera-vs-GPS check leaves it out', async () => {
  const s = setup();
  const calls = [];
  const gps = { mileage: async (ids) => { calls.push(ids); return []; }, fuel: async () => [], fuelInOut: async () => [] };
  s.regular('10834HDA', 2);
  const { vehicleId } = await s.links.addTruck('10834HDA', {}, owner);
  const details = new GateDetails({ h: s.h, gps, poller: s.poller, config: s.config, log: {} });
  assert.equal(await details.forEvent({ vehicleId, t: NOW, direction: 'out', vehicleLabel: 'x' }), null);
  assert.equal(calls.length, 0);
  const a = new Analytics({ h: s.h, gps, config: s.config, log: {} });
  await a.rollup(T.dayOf(NOW));
  assert.ok(calls.length && !calls[0].includes(vehicleId), 'the fleet report does not ask about it');
  const reports = new Reports({ h: s.h, analytics: a, poller: s.poller, gate: s.gate, config: s.config, log: {} });
  assert.ok(!reports.audit(30).some((r) => r.plate === '10834HDA'));
});

test('a GoGPS vehicle list refresh does not touch a truck with no tracker', async () => {
  const s = setup();
  s.regular('10834HDA', 2);
  const { vehicleId } = await s.links.addTruck('10834HDA', {}, owner);
  s.h.run('UPDATE vehicles SET in_gps = 0'); // what the poller does before writing what GoGPS sent back
  const v = s.h.get('SELECT * FROM vehicles WHERE id = ?', vehicleId);
  assert.equal(v.active, 1);
  assert.equal(v.camera_only, 1);
});

test('two trucks with no tracker get their own ids', async () => {
  const s = setup();
  s.regular('10834HDA', 2);
  s.regular('10835HDA', 2);
  const a = await s.links.addTruck('10834HDA', {}, owner);
  const b = await s.links.addTruck('10835HDA', { name: 'Mikser 29', type: 'mixer' }, owner);
  assert.notEqual(a.vehicleId, b.vehicleId);
  const v = s.h.get('SELECT * FROM vehicles WHERE id = ?', b.vehicleId);
  assert.equal(v.display, 'Mikser 29');
  assert.equal(v.type, 'mixer');
  assert.equal(b.label, 'Mikser 29');
});

test('undoing it removes the truck and what was counted for it, including a pass corrected to it by hand', async () => {
  const s = setup();
  const ts = s.regular('10834HDA', 2);
  const { vehicleId } = await s.links.addTruck('10834HDA', {}, owner);
  const other = s.pass('01A123BC', NOW - DAY, 'in', { vehicleId, by: 'manual', status: 'confirmed' });
  const r = await s.links.undo('10834HDA');
  assert.equal(r.moved, 5);
  assert.equal(s.h.get('SELECT 1 x FROM vehicles WHERE id = ?', vehicleId), undefined);
  assert.equal(s.h.get('SELECT COUNT(*) n FROM daily_stats WHERE vehicle_id = ?', vehicleId).n, 0);
  assert.equal(s.h.get('SELECT COUNT(*) n FROM trips WHERE vehicle_id = ?', vehicleId).n, 0);
  assert.equal(s.h.get('SELECT vehicle_id FROM gate_events WHERE id = ?', other).vehicle_id, null);
  assert.equal(s.h.get('SELECT status FROM gate_events WHERE t = ?', ts[0]).status, 'outside');
});

// --- not ours ------------------------------------------------------------------------------------------

test('not ours: stays an outsider, and learned matching can no longer claim it', async () => {
  const s = setup();
  s.regular('85W670JA', 2);
  s.h.run("INSERT INTO alias_hits (plate, vehicle_id, hits, last) VALUES ('85W670JA', 2, 9, 0)");
  assert.equal(s.gate.matchPlate('85W670JA').how, 'learned');
  s.links.markOutside('85W670JA', owner);
  assert.equal(s.gate.matchPlate('85W670JA'), null);
  assert.ok(!s.gate.fleetPlates().includes('85W670JA') || s.gate.learnedAliases(s.gate.vehicles()).has('85W670JA'));
  const ev = await s.capture(4, NOW, '85W670JA');
  assert.equal(ev.status, 'outside');
  assert.equal(s.h.get("SELECT COUNT(*) n FROM gate_events WHERE plate = '85W670JA' AND vehicle_id IS NOT NULL").n, 0);
  await s.links.undo('85W670JA');
  assert.equal(s.gate.matchPlate('85W670JA').how, 'learned', 'undone: as before');
});

test('the decided list says what was decided, last first', async () => {
  const s = setup();
  s.regular('10963DDA', 2);
  s.regular('10834HDA', 2);
  s.regular('85W670JA', 2);
  await s.links.link('10963DDA', 1, owner);
  await s.links.addTruck('10834HDA', {}, owner);
  s.links.markOutside('85W670JA', owner);
  const rows = s.links.decided();
  const by = Object.fromEntries(rows.map((r) => [r.plate, r]));
  assert.equal(by['10963DDA'].label, '85 518 EBA');
  assert.equal(by['10963DDA'].passes, 4);
  assert.equal(by['10834HDA'].created, true);
  assert.equal(by['85W670JA'].kind, 'outside');
  assert.equal(by['85W670JA'].passes, 4);
});

// --- trucks added to GoGPS, or renamed to their real plates ---------------------------------------------

test('a truck added to GoGPS under the plate gets its past outsider passes, and those days are recounted', async () => {
  const s = setup();
  const ts = s.regular('10834HDA', 3);
  s.links.markOutside('01M393YA', owner);
  s.regular('01M393YA', 2);
  s.h.run('INSERT INTO vehicles (id, name, updated_at) VALUES (39895, ?, 0)', '10 834 HDA');
  s.h.run('INSERT INTO vehicles (id, name, updated_at) VALUES (39900, ?, 0)', '01 M 393 YA');
  const r = await s.links.claimFleetPlates();
  assert.equal(r.moved, 6);
  const evs = s.h.all("SELECT vehicle_id, identified_by, status FROM gate_events WHERE plate = '10834HDA'");
  assert.ok(evs.every((e) => e.vehicle_id === 39895 && e.identified_by === 'plate' && e.status === 'history'));
  assert.equal(s.h.get('SELECT trips_out FROM daily_stats WHERE day = ? AND vehicle_id = 39895', T.dayOf(ts[0])).trips_out, 1);
  assert.ok(!s.links.unknown().some((u) => u.plate === '10834HDA'));
  assert.equal(s.h.get("SELECT COUNT(*) n FROM gate_events WHERE plate = '01M393YA' AND vehicle_id IS NOT NULL").n, 0, "the owner's \"not ours\" stands");
  assert.equal((await s.links.claimFleetPlates()).moved, 0, 'once');
});

test('a truck renamed in GoGPS to its real plate gets that plate\'s passes; a plate two trucks have is left alone', async () => {
  const s = setup();
  s.regular('10963DDA', 2);
  s.regular('10835HDA', 2);
  s.h.run("UPDATE vehicles SET name = '10 963 DDA' WHERE id = 1");
  s.h.run('INSERT INTO vehicles (id, name, updated_at) VALUES (39896, ?, 0), (39897, ?, 0)', '10 835 HDA', '10 835 HDA');
  assert.equal((await s.links.claimFleetPlates()).moved, 4);
  assert.equal(s.h.get("SELECT COUNT(*) n FROM gate_events WHERE plate = '10963DDA' AND vehicle_id = 1").n, 4);
  assert.equal(s.h.get("SELECT COUNT(*) n FROM gate_events WHERE plate = '10835HDA' AND vehicle_id IS NOT NULL").n, 0);
});

test('linking a plate to the truck whose GPS name it is works; to another truck it is still refused', async () => {
  const s = setup();
  s.regular('10834HDA', 2);
  s.h.run('INSERT INTO vehicles (id, name, updated_at) VALUES (39895, ?, 0)', '10 834 HDA');
  await assert.rejects(s.links.link('10834HDA', 1, owner), (e) => e.status === 409 && /10 834 HDA/.test(e.message));
  const r = await s.links.link('10834HDA', 39895, owner);
  assert.equal(r.moved, 4);
});
