'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open, helpers } = require('../src/db');
const T = require('../src/time');
const bus = require('../src/bus');
const { Trips, gpsPasses, pairPasses, kmWithin, stopsWithin } = require('../src/trips');

const MIN = 60e3, HOUR = 3600e3;
const T0 = Date.parse('2026-11-05T05:00:00Z'); // 10:00 in Tashkent
const YARD = { lat: 41.2655, lng: 69.3418, radiusM: 150, name: 'TBB hovli' };
const cam = (t, dir, eventId) => ({ t, dir, src: 'camera', eventId });
const gps = (t, dir) => ({ t, dir, src: 'gps' });

// --- pairing, on what the real fleet does ------------------------------------------------------------

test('a plain trip: GPS gives the times, the cameras the photos', () => {
  const [t, ...rest] = pairPasses([cam(T0, 'out', 1), gps(T0 + 2 * MIN, 'out'), gps(T0 + 80 * MIN, 'in'), cam(T0 + 82 * MIN, 'in', 2)]);
  assert.equal(rest.length, 0);
  assert.equal(t.startT, T0 + 2 * MIN);
  assert.equal(t.startSrc, 'gps');
  assert.equal(t.endT, T0 + 80 * MIN);
  assert.equal(t.outEvent, 1);
  assert.equal(t.inEvent, 2);
});

test('cameras only, as in history older than the poller', () => {
  const [t] = pairPasses([cam(T0, 'out', 1), cam(T0 + 90 * MIN, 'in', 2)]);
  assert.deepEqual([t.startT, t.startSrc, t.endT, t.endSrc], [T0, 'camera', T0 + 90 * MIN, 'camera']);
});

test('real: 10 873 HAD reached the circle at 17:49 and the entry camera at 14:57 next day: one return, no extra trip', () => {
  const back = T0 - 16 * HOUR, gate = T0 + 5 * HOUR;
  const trips = pairPasses([cam(back - 3 * HOUR, 'out', 1), gps(back, 'in'), cam(gate, 'in', 2), cam(gate + 12 * MIN, 'out', 3), gps(gate + 16 * MIN, 'out')]);
  assert.equal(trips.length, 2);
  assert.equal(trips[0].endT, back, 'home from when it reached the circle');
  assert.equal(trips[0].inEvent, 2, 'the entry photo still belongs to it');
  assert.equal(trips[1].startT, gate + 16 * MIN);
  assert.equal(trips[1].endT, null);
});

test('real: 85 519 EBA queued 42 min between the circle and the camera: not a second trip', () => {
  const trips = pairPasses([gps(T0, 'out'), gps(T0 + 2 * HOUR, 'in'), cam(T0 + 2 * HOUR + 42 * MIN, 'in', 5)]);
  assert.equal(trips.length, 1);
  assert.equal(trips[0].inEvent, 5);
});

test('real: a truck stood 51 min in the circle after the exit camera: one departure, when it really left', () => {
  const trips = pairPasses([cam(T0, 'out', 1), gps(T0 + 51 * MIN, 'out'), gps(T0 + 2 * HOUR, 'in')]);
  assert.equal(trips.length, 1);
  assert.equal(trips[0].startT, T0 + 51 * MIN);
  assert.equal(trips[0].outEvent, 1);
});

test('an exit the camera read but GPS crossed just before: GPS time stays', () => {
  const [t] = pairPasses([gps(T0, 'out'), cam(T0 + 20e3, 'out', 1), gps(T0 + HOUR, 'in')]);
  assert.equal(t.startT, T0);
  assert.equal(t.outEvent, 1);
});

test('two camera exits are two trips, the first with no return seen; two camera entries likewise', () => {
  const a = pairPasses([cam(T0, 'out', 1), cam(T0 + 2 * HOUR, 'out', 2)]);
  assert.deepEqual(a.map((t) => [t.outEvent, t.endT]), [[1, null], [2, null]]);
  const b = pairPasses([cam(T0, 'in', 1), cam(T0 + 2 * HOUR, 'in', 2)]);
  assert.deepEqual(b.map((t) => [t.startT, t.inEvent]), [[null, 1], [null, 2]]);
});

test('an entry with no exit seen is still a row, with no start', () => {
  const [t] = pairPasses([cam(T0, 'in', 1)]);
  assert.equal(t.startT, null);
  assert.equal(t.endT, T0);
});

test('same second: the camera pass goes first, so the order of the input does not matter', () => {
  const a = pairPasses([gps(T0, 'out'), cam(T0, 'out', 1), gps(T0 + HOUR, 'in')]);
  const b = pairPasses([cam(T0, 'out', 1), gps(T0, 'out'), gps(T0 + HOUR, 'in')]);
  assert.deepEqual(a, b);
});

test('no passes, no trips', () => assert.deepEqual(pairPasses([]), []));

// --- the circle's edge --------------------------------------------------------------------------------

test('real: out of the circle for 14 s and back is not a trip', () => {
  const visits = [
    { enter_t: T0, exit_t: T0 + 14e3, approx: 0 },
    { enter_t: T0 + 113e3, exit_t: T0 + 3 * HOUR, approx: 0 },
  ];
  assert.deepEqual(gpsPasses(visits), [{ t: T0, dir: 'in', src: 'gps' }, { t: T0 + 3 * HOUR, dir: 'out', src: 'gps' }]);
});

test('a short time away is a trip if a camera saw it go', () => {
  const visits = [{ enter_t: T0, exit_t: T0 + MIN, approx: 0 }, { enter_t: T0 + 6 * MIN, exit_t: null, approx: 0 }];
  const passes = gpsPasses(visits, [T0 + 3 * MIN]);
  assert.equal(passes.filter((p) => p.dir === 'out').length, 1);
  assert.equal(passes.filter((p) => p.dir === 'in').length, 2);
});

test('the visit it was already in when first seen has no real entry time', () => {
  const passes = gpsPasses([{ enter_t: T0, exit_t: T0 + HOUR, approx: 1 }]);
  assert.deepEqual(passes, [{ t: T0 + HOUR, dir: 'out', src: 'gps' }]);
});

// --- km and stops --------------------------------------------------------------------------------------

test('km: a move partly inside counts for its share; none known is null, not zero', () => {
  const moves = [{ start_t: T0, end_t: T0 + 10 * MIN, km: 10 }, { start_t: T0 + HOUR, end_t: T0 + HOUR + 10 * MIN, km: 6 }];
  assert.equal(kmWithin(moves, T0 + 5 * MIN, T0 + 2 * HOUR), 11);
  assert.equal(kmWithin(moves, T0 + 3 * HOUR, T0 + 4 * HOUR), null);
  assert.equal(kmWithin([{ start_t: T0, end_t: T0, km: 0.001 }], T0 - 1, T0 + 1), 0.001, 'a move of no length');
});

test('real: GoGPS splits one stop with a 1 s move of a few metres: one stop; a real drive ends it', () => {
  const stop = (s, e, a = 'A') => ({ kind: 'stop', start_t: s, end_t: e, address: a });
  const move = (s, e, km) => ({ kind: 'move', start_t: s, end_t: e, km });
  const segs = [stop(T0, T0 + 3 * MIN), move(T0 + 3 * MIN, T0 + 3 * MIN + 1e3, 0.001), stop(T0 + 3 * MIN + 1e3, T0 + 8 * MIN), move(T0 + 8 * MIN, T0 + 20 * MIN, 5), stop(T0 + 20 * MIN, T0 + 24 * MIN, 'B'), move(T0 + 24 * MIN, T0 + 30 * MIN, 3), stop(T0 + 30 * MIN, T0 + 50 * MIN, 'C')];
  const stops = stopsWithin(segs, T0, T0 + 50 * MIN);
  assert.deepEqual(stops.map((s) => [s.a, (s.e - s.s) / MIN]), [['A', 8], ['C', 20]], 'B is under 5 min');
});

test('stops are cut to the trip', () => {
  const [s] = stopsWithin([{ kind: 'stop', start_t: T0 - HOUR, end_t: T0 + 10 * MIN, address: 'A' }], T0, T0 + HOUR);
  assert.equal(s.s, T0);
});

// --- the whole thing, on a database ---------------------------------------------------------------------

const NEAR_YARD = { lat: YARD.lat + 0.001, lng: YARD.lng }; // about 110 m
const SITE = { lat: YARD.lat + 0.1, lng: YARD.lng }; // about 11 km

function setup({ gpsImpl = null } = {}) {
  const db = open(':memory:');
  const h = helpers(db);
  const add = (id, name, extra = {}) => h.run('INSERT INTO vehicles (id, name, plate, display, active, in_gps, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, name, extra.plate ?? null, extra.display ?? null, extra.active ?? 1, 1, Date.now());
  add(1, '85 450 KBA');
  add(2, '10 870 HAD');
  let n = 0;
  const event = (vid, t, direction, status = 'confirmed') => Number(h.run(`INSERT INTO gate_events (capture_name, t, direction, camera, channel, plate, plate_valid, vehicle_id, status, created_at)
    VALUES (?, ?, ?, 'cam', 3, 'X', 1, ?, ?, ?)`, `c${n++}`, t, direction, vid, status, t).lastInsertRowid);
  const visit = (vid, enter, exit = null, approx = 0) => h.run('INSERT INTO yard_visits (vehicle_id, enter_t, exit_t, approx) VALUES (?, ?, ?, ?)', vid, enter, exit, approx);
  const pos = (vid, t, p, status = 'stopped') => h.run('INSERT OR IGNORE INTO positions (vehicle_id, t, lat, lng, speed, course, status) VALUES (?, ?, ?, ?, 0, 0, ?)', vid, t, p.lat, p.lng, status);
  const seg = (vid, kind, s, e, km, address = null) => h.run('INSERT INTO gps_segments (vehicle_id, start_t, kind, end_t, km, address) VALUES (?, ?, ?, ?, ?, ?)', vid, s, kind, e, km, address);
  const places = { rows: [], at(lat, lng) { return this.rows.find((p) => Math.abs(p.lat - lat) < 0.002 && Math.abs(p.lng - lng) < 0.002) || null; } };
  const trips = new Trips({ h, gps: gpsImpl, places, config: { yard: YARD }, log: {} });
  return { db, h, trips, places, event, visit, pos, seg };
}
const byDay = (s, day = T.dayOf(T0)) => s.trips.list({ from: day, to: day, near: true });

test('a delivery end to end: times, km, destination, photos; asked twice it stays the same', async () => {
  const s = setup();
  const out = s.event(1, T0, 'out'), back = s.event(1, T0 + 90 * MIN, 'in');
  s.visit(1, T0 - HOUR, T0 + 2 * MIN, 1);
  s.visit(1, T0 + 88 * MIN);
  s.seg(1, 'move', T0, T0 + 20 * MIN, 10);
  s.seg(1, 'stop', T0 + 20 * MIN, T0 + 60 * MIN, null, '5 Чинабад улица, Ташкент, Узбекистан');
  s.seg(1, 'move', T0 + 60 * MIN, T0 + 88 * MIN, 9);
  s.pos(1, T0 + 30 * MIN, SITE);
  await s.trips.rebuild(0);
  const before = s.h.all('SELECT * FROM trips');
  const { trips: [t], totals } = byDay(s);
  assert.equal(t.state, 'done');
  assert.equal(t.startT, T0 + 2 * MIN);
  assert.equal(t.endT, T0 + 88 * MIN);
  assert.equal(t.durationS, 86 * 60);
  assert.equal(t.km, 18, 'the first move counts from when it left the circle: 9 + 9');
  assert.equal(t.kmSrc, 'gps');
  assert.equal(t.outEventId, out);
  assert.equal(t.inEventId, back);
  assert.equal(t.destination.address, '5 Чинабад улица, Ташкент, Узбекистан');
  assert.equal(t.destination.seconds, 40 * 60);
  assert.equal(t.near, false);
  assert.equal(totals.trips, 1);
  await s.trips.rebuild(0);
  assert.deepEqual(s.h.all('SELECT * FROM trips'), before, 'nothing changes, ids stay');
});

test('a maneuver and a pending pass are not passes', async () => {
  const s = setup();
  s.event(1, T0, 'out', 'vetoed');
  s.event(1, T0 + HOUR, 'out', 'pending');
  await s.trips.rebuild(0);
  assert.equal(byDay(s).trips.length, 0);
});

test('real: standing near the plant, 0.2 km in 2 h: flagged, left out of the count unless asked for', async () => {
  const s = setup();
  s.event(1, T0, 'out');
  s.event(1, T0 + 2 * HOUR, 'in');
  s.seg(1, 'move', T0, T0 + MIN, 0.2);
  s.seg(1, 'stop', T0 + MIN, T0 + 2 * HOUR, null, 'Уйсозлар 2-й проезд');
  s.pos(1, T0 + 2 * MIN, NEAR_YARD);
  await s.trips.rebuild(0);
  const day = T.dayOf(T0);
  const hidden = s.trips.list({ from: day, to: day });
  assert.equal(hidden.trips.length, 0);
  assert.equal(hidden.nearCount, 1);
  assert.equal(hidden.totals.trips, 0);
  const [t] = byDay(s).trips;
  assert.equal(t.near, true);
  assert.equal(t.stops[0].atYard, true);
  assert.equal(t.destination, null, 'the plant is not where it went');
});

test('real: positions cover a sliver of a long trip: 468 km with samples only near the yard is not "near"', async () => {
  const s = setup();
  s.event(1, T0, 'out');
  s.event(1, T0 + 20 * HOUR, 'in');
  s.seg(1, 'move', T0, T0 + 19 * HOUR, 468);
  s.pos(1, T0 + 19 * HOUR + MIN, NEAR_YARD);
  await s.trips.rebuild(0);
  assert.equal(byDay(s).trips[0].near, false);
});

test('history with no positions: a short trip with no stop away is near, one with a stop away is not', async () => {
  const s = setup();
  s.event(1, T0, 'out');
  s.event(1, T0 + HOUR, 'in');
  s.seg(1, 'move', T0, T0 + 10 * MIN, 1.5);
  s.event(2, T0, 'out');
  s.event(2, T0 + HOUR, 'in');
  s.seg(2, 'move', T0, T0 + 5 * MIN, 1);
  s.seg(2, 'stop', T0 + 5 * MIN, T0 + 50 * MIN, null, 'Somewhere else');
  await s.trips.rebuild(0);
  const near = Object.fromEntries(byDay(s).trips.map((t) => [t.vehicleId, t.near]));
  assert.deepEqual(near, { 1: true, 2: false });
});

test('real: days of no recordings, 491 km and several stops at the plant, is an exit and a return, not one trip', async () => {
  const s = setup();
  const addr = 'Уйсозлар 2-й проезд, Ташкент, Узбекистан';
  const back = T0 + 5 * 24 * HOUR;
  s.event(1, T0, 'out');
  s.visit(1, back);
  s.seg(1, 'move', T0, T0 + HOUR, 491);
  for (const d of [1, 2, 3]) {
    const a = T0 + d * 24 * HOUR;
    s.seg(1, 'stop', a, a + HOUR, null, addr);
    s.seg(1, 'move', a + HOUR, a + 2 * HOUR, 1);
    s.pos(1, a + MIN, NEAR_YARD);
  }
  await s.trips.rebuild(0);
  const rows = s.h.all('SELECT start_t, end_t, km FROM trips ORDER BY COALESCE(start_t, end_t)');
  assert.deepEqual(rows.map((r) => [r.start_t, r.end_t, r.km]), [[T0, null, null], [null, back, null]]);
});

test('a long real trip with one stop at the plant stays one trip', async () => {
  const s = setup();
  const back = T0 + 49 * HOUR;
  s.event(1, T0, 'out');
  s.event(1, back, 'in');
  s.seg(1, 'move', T0, T0 + HOUR, 13);
  s.seg(1, 'stop', T0 + 2 * HOUR, T0 + 3 * HOUR, null, 'Yard street');
  s.pos(1, T0 + 2 * HOUR + MIN, NEAR_YARD);
  await s.trips.rebuild(0);
  const rows = s.h.all('SELECT start_t, end_t FROM trips');
  assert.deepEqual(rows.map((r) => [r.start_t, r.end_t]), [[T0, back]]);
});

test('older history: the plant street is known by its address, learned from stops with coordinates', async () => {
  const s = setup();
  const now = Date.now();
  const addr = 'Уйсозлар 2-й проезд';
  for (let i = 0; i < 6; i++) {
    s.seg(2, 'stop', now - (i + 1) * HOUR, now - (i + 1) * HOUR + 10 * MIN, null, addr);
    s.pos(2, now - (i + 1) * HOUR + MIN, NEAR_YARD);
    s.seg(2, 'stop', now - (i + 1) * HOUR + 20 * MIN, now - (i + 1) * HOUR + 30 * MIN, null, 'Ташкент, Узбекистан');
    s.pos(2, now - (i + 1) * HOUR + 21 * MIN, SITE);
  }
  assert.deepEqual(s.trips.yardAddresses(now), [addr], 'a vague address used everywhere is not the yard');
  const old = T0 - 20 * 24 * HOUR;
  s.event(1, old, 'out');
  s.event(1, old + 2 * HOUR, 'in');
  s.seg(1, 'stop', old + 10 * MIN, old + 40 * MIN, null, addr);
  s.seg(1, 'move', old, old + 10 * MIN, 8);
  await s.trips.rebuild(0);
  const day = T.dayOf(old);
  const [t] = s.trips.list({ from: day, to: day }).trips;
  assert.equal(t.stops[0].atYard, true);
  assert.equal(t.destination, null);
});

test('before GoGPS has answered: km from positions, marked; replaced once it has', async () => {
  const s = setup();
  s.event(1, T0, 'out');
  s.event(1, T0 + HOUR, 'in');
  s.pos(1, T0 + MIN, YARD, 'moving');
  s.pos(1, T0 + 30 * MIN, SITE);
  await s.trips.rebuild(0);
  let [t] = byDay(s).trips;
  assert.equal(t.kmSrc, 'positions');
  assert.ok(t.km > 10 && t.km < 12, String(t.km));
  s.trips.storeSegments(T.dayOf(T0), [{ vehicleId: 1, moves: [{ start: T.localIso(T0), end: T.localIso(T0 + 50 * MIN), mileage: 24.5 }], stops: [] }]);
  await s.trips.rebuild(0);
  [t] = byDay(s).trips;
  assert.equal(t.kmSrc, 'gps');
  assert.equal(t.km, 24.5);
});

test('naming a place changes past trips at once, and a named stop beats a longer unnamed one', async () => {
  const s = setup();
  s.event(1, T0, 'out');
  s.event(1, T0 + 3 * HOUR, 'in');
  s.seg(1, 'move', T0, T0 + 10 * MIN, 9);
  s.seg(1, 'stop', T0 + 10 * MIN, T0 + 30 * MIN, null, 'Site street');
  s.pos(1, T0 + 11 * MIN, SITE);
  s.seg(1, 'move', T0 + 30 * MIN, T0 + 40 * MIN, 9);
  const other = { lat: YARD.lat + 0.2, lng: YARD.lng };
  s.seg(1, 'stop', T0 + 40 * MIN, T0 + 2 * HOUR, null, 'Long stop');
  s.pos(1, T0 + 41 * MIN, other);
  await s.trips.rebuild(0);
  assert.equal(byDay(s).trips[0].destination.address, 'Long stop');
  s.places.rows = [{ id: 7, name: 'Sergeli', ...SITE }];
  const { trips: [t], destinations } = byDay(s);
  assert.equal(t.destination.name, 'Sergeli');
  assert.equal(destinations[0].name, 'Sergeli');
  const day = T.dayOf(T0);
  assert.equal(s.trips.list({ from: day, to: day, place: 7 }).trips.length, 1);
  assert.equal(s.trips.list({ from: day, to: day, place: 8 }).trips.length, 0);
});

test('open, then not recorded: a truck out for over a day stops saying "on the road"', async () => {
  const s = setup();
  const now = Date.now();
  s.event(1, now - HOUR, 'out');
  s.event(2, now - 30 * HOUR, 'out');
  await s.trips.rebuild(0);
  const a = s.trips.list({ from: T.dayOf(now - HOUR), to: T.dayOf(now - HOUR), vehicle: 1 }).trips[0];
  const b = s.trips.list({ from: T.dayOf(now - 30 * HOUR), to: T.dayOf(now - 30 * HOUR), vehicle: 2 }).trips[0];
  assert.equal(a.state, 'open');
  assert.equal(b.state, 'no_return');
});

test('a truck turned off in Settings stays out, as in the other reports; its trips come back with it', async () => {
  const s = setup();
  s.event(1, T0, 'out');
  await s.trips.rebuild(0);
  s.h.run('UPDATE vehicles SET active = 0 WHERE id = 1');
  assert.equal(byDay(s).trips.length, 0);
  s.h.run('UPDATE vehicles SET active = 1 WHERE id = 1');
  assert.equal(byDay(s).trips.length, 1);
});

test('a late pass joins the trip it belongs to, and a correction moves a trip between trucks', async () => {
  const s = setup();
  const out = s.event(1, T0, 'out');
  await s.trips.rebuild(T0 - T.DAY);
  assert.equal(byDay(s).trips[0].endT, null);
  s.event(1, T0 + HOUR, 'in');
  await s.trips.rebuild(T0 + 30 * MIN);
  assert.equal(byDay(s).trips.length, 1);
  assert.equal(byDay(s).trips[0].endT, T0 + HOUR, 'the open trip was redone even though it started before that time');
  s.h.run('UPDATE gate_events SET vehicle_id = 2 WHERE id = ?', out);
  await s.trips.rebuild(T0 - T.DAY);
  const rows = byDay(s).trips;
  assert.equal(rows.length, 2);
  const of = (id) => rows.find((t) => t.vehicleId === id);
  assert.equal(of(1).state, 'no_exit', 'the entry is left with no exit');
  assert.equal(of(2).startT, T0, 'the exit went with the correction');
  assert.equal(of(2).endT, null);
});

test('rebuilding recent days keeps older trips and what fuel was already asked for', async () => {
  const s = setup();
  const old = T0 - 10 * T.DAY;
  s.event(1, old, 'out');
  s.event(1, old + HOUR, 'in');
  s.seg(1, 'move', old, old + 30 * MIN, 12);
  s.event(1, T0, 'out');
  s.event(1, T0 + HOUR, 'in');
  await s.trips.rebuild(0);
  s.h.run('UPDATE trips SET fuel_used = 5.5, fuel_checked = 1');
  const ids = s.h.all('SELECT id FROM trips ORDER BY id').map((r) => r.id);
  s.event(1, T0 + 2 * HOUR, 'out');
  await s.trips.rebuild(T0 - T.DAY);
  const rows = s.h.all('SELECT id, fuel_used, fuel_checked, end_t FROM trips ORDER BY COALESCE(start_t, end_t)');
  assert.equal(rows.length, 3);
  assert.equal(rows[0].id, ids[0], 'the old trip wasn\'t touched');
  assert.equal(rows[1].fuel_used, 5.5, 'same trip, same fuel');
  assert.equal(rows[2].fuel_checked, 0, 'the new one still has to be asked');
});

test('fuel: asked once per finished trip, only for a truck with a sensor that day; a failure is retried', async () => {
  const calls = [];
  let fail = true;
  const gpsImpl = { fuel: async (ids, from, to, sampling, opts) => {
    calls.push({ ids, from, to, opts });
    if (fail) throw new Error('GoGPS down');
    return [{ vehicleId: ids[0], periods: [{ fuelConsumption: 7 }, { fuelConsumption: 3.5 }] }];
  } };
  const s = setup({ gpsImpl });
  for (const v of [1, 2]) { s.event(v, T0, 'out'); s.event(v, T0 + HOUR, 'in'); s.seg(v, 'move', T0, T0 + 30 * MIN, 12); }
  s.event(1, T0 + 2 * HOUR, 'out'); // not finished
  await s.trips.rebuild(0);
  s.h.run("INSERT INTO daily_stats (day, vehicle_id, fuel_used, updated_at) VALUES (?, 1, 40, 0), (?, 2, NULL, 0)", T.dayOf(T0), T.dayOf(T0));
  await assert.rejects(s.trips.fuelStep());
  fail = false;
  while (await s.trips.fuelStep());
  const rows = s.h.all('SELECT vehicle_id, fuel_used, fuel_checked, end_t FROM trips ORDER BY vehicle_id, start_t');
  assert.deepEqual(rows.filter((r) => r.end_t).map((r) => [r.vehicle_id, r.fuel_used, r.fuel_checked]), [[1, 10.5, 1], [2, null, 1]]);
  assert.equal(calls.filter((c) => c.ids[0] === 2).length, 0, 'no request for a truck with no sensor');
  assert.equal(calls[0].opts.lane, 'bulk', 'never in the way of an alert\'s reports');
  assert.equal(byDay(s).totals.fuelUsed, 10.5);
});

test('moves and stops: one call per day on the slow lane; a day is fetched again only until it is complete', async () => {
  const calls = [];
  const gpsImpl = { moveStop: async (ids, from, to, opts) => {
    calls.push({ ids, opts });
    return [{ vehicleId: 1, moves: [{ start: T.localIso(from + HOUR), end: T.localIso(from + 2 * HOUR), mileage: 3 }], stops: [{ start: T.localIso(from + 3 * HOUR), end: T.localIso(from + 4 * HOUR), address: 'A' }] }];
  } };
  const s = setup({ gpsImpl });
  const now = T0;
  s.event(1, now - 3 * T.DAY, 'out');
  assert.deepEqual(s.trips.daysToFetch(now), [T.addDays(T.dayOf(now), -1), T.addDays(T.dayOf(now), -2), T.addDays(T.dayOf(now), -3)], 'newest first, only as far back as there are passes');
  const day = T.addDays(T.dayOf(now), -2);
  await s.trips.syncSegments(day);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].ids, [1, 2]);
  assert.equal(calls[0].opts.lane, 'bulk');
  assert.ok(!s.trips.daysToFetch(now).includes(day));
  assert.equal(s.h.get('SELECT COUNT(*) n FROM gps_segments').n, 2);
  await s.trips.syncSegments(day);
  assert.equal(s.h.get('SELECT COUNT(*) n FROM gps_segments').n, 2, 'replaced, not added');
  s.h.run('UPDATE gps_segment_days SET synced_at = ? WHERE day = ?', T.dayStart(day) + HOUR, day);
  assert.ok(s.trips.daysToFetch(now).includes(day), 'fetched while the day was still going on: not complete');
});

test('GoGPS failing leaves the stored data alone', async () => {
  const s = setup({ gpsImpl: { moveStop: async () => { throw new Error('down'); } } });
  s.seg(1, 'move', T0, T0 + MIN, 5);
  await assert.rejects(s.trips.syncSegments(T.dayOf(T0)));
  assert.equal(s.h.get('SELECT COUNT(*) n FROM gps_segments').n, 1);
});

test('the page hears about a change, and not about nothing', async () => {
  const s = setup();
  s.event(1, T0, 'out');
  let heard = 0;
  const on = () => heard++;
  bus.on('trips', on);
  await s.trips.rebuild(0);
  assert.equal(heard, 1);
  await s.trips.rebuild(0);
  assert.equal(heard, 1);
  bus.off('trips', on);
});

test('a burst of gate events is one rebuild; stop() cancels what is waiting', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup();
  let runs = 0;
  s.trips.rebuild = () => { runs++; return Promise.resolve(); };
  s.trips.soon(); s.trips.soon(); s.trips.soon();
  t.mock.timers.tick(10e3);
  assert.equal(runs, 1);
  s.trips.soon();
  s.trips.stop();
  t.mock.timers.tick(10e3);
  assert.equal(runs, 1);
});

test('totals and the list of destinations', async () => {
  const s = setup();
  for (const [v, off] of [[1, 0], [2, 0], [1, 4 * HOUR]]) {
    s.event(v, T0 + off, 'out');
    s.event(v, T0 + off + HOUR, 'in');
    s.seg(v, 'move', T0 + off, T0 + off + 10 * MIN, 10);
    s.seg(v, 'stop', T0 + off + 10 * MIN, T0 + off + 40 * MIN, null, 'Site');
  }
  s.event(2, T0 + 6 * HOUR, 'out');
  await s.trips.rebuild(0);
  const r = byDay(s);
  assert.equal(r.totals.trips, 4);
  assert.equal(r.totals.complete, 3);
  assert.equal(r.totals.vehicles, 2);
  assert.equal(r.totals.km, 30);
  assert.equal(r.totals.avgDurationS, 3600);
  assert.equal(r.totals.fuelUsed, null, 'no sensor: unknown, not zero');
  assert.deepEqual(r.destinations, [{ name: null, placeId: null, address: 'Site', trips: 3, vehicles: 2, avgKm: 10, avgStayMin: 30 }]);
});
