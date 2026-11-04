'use strict';
// Places: what counts as a visit (reys), history after a resize, the rolling refresh, and what is refused.
const test = require('node:test');
const assert = require('node:assert');
const config = require('../src/config');
const { open, helpers } = require('../src/db');
const { Places, findCommon } = require('../src/places');
const { Analytics } = require('../src/analytics');
const T = require('../src/time');

const MIN = 60e3;
const SITE = { lat: 41.31, lng: 69.28 };
const FAR = { lat: 41.40, lng: 69.40 };

function setup() {
  const h = helpers(open(':memory:'));
  h.run("INSERT INTO vehicles (id, name, updated_at) VALUES (1, 'A', 0), (2, 'B', 0), (3, 'Hidden', 0)");
  h.run('UPDATE vehicles SET active = 0 WHERE id = 3');
  const places = new Places({ h, config, log: { warn(m) { throw new Error(m); } } });
  const put = (vid, t, status, at = SITE) => h.run('INSERT OR REPLACE INTO positions (vehicle_id, t, lat, lng, speed, course, status) VALUES (?, ?, ?, ?, 0, 0, ?)', vid, t, at.lat, at.lng, status);
  /** A stay: samples every 2 min, as the poller stores for a standing truck, then the first moving sample. */
  const stay = (vid, from, minutes, at = SITE) => {
    for (let m = 0; m < minutes; m += 2) put(vid, from + m * MIN, 'stopped', at);
    put(vid, from + minutes * MIN, 'moving', at);
  };
  const visits = (id) => h.all('SELECT * FROM place_visits WHERE place_id = ? ORDER BY vehicle_id, enter_t', id);
  const add = async (o = {}) => {
    const p = places.create({ name: 'Sergeli', ...SITE, ...o }, { id: 1 });
    await places.queue;
    return p;
  };
  return { h, places, put, stay, visits, add };
}

const DAY_AGO = (n, hour = 10) => T.dayStart(T.addDays(T.today(), -n)) + hour * 3600e3;

test('standing 5 min or more is a visit; driving through or a short wait is not', async () => {
  const { put, stay, visits, add } = setup();
  const t0 = DAY_AGO(2);
  for (let i = 0; i < 4; i++) put(1, t0 + i * 20e3, 'moving'); // driving through
  stay(1, t0 + 60 * MIN, 2); // a traffic light
  stay(2, t0, 30);
  const p = await add();
  const v = visits(p.id);
  assert.equal(v.length, 1, 'only the real stay counts');
  assert.equal(v[0].vehicle_id, 2);
  assert.equal(v[0].stopped_s, 30 * 60);
});

test('leaving and coming back is two visits; GPS drift and a quiet tracker are one', async () => {
  const { put, stay, visits, add } = setup();
  const t0 = DAY_AGO(3);
  // Vehicle 1: two real trips with a report from far away between them.
  stay(1, t0, 20);
  put(1, t0 + 60 * MIN, 'moving', FAR);
  stay(1, t0 + 120 * MIN, 20);
  // Vehicle 2: one sample outside the circle for 4 min at its edge, inside the merge gap.
  stay(2, t0, 10);
  put(2, t0 + 12 * MIN, 'stopped', { lat: SITE.lat + 0.0016, lng: SITE.lng });
  stay(2, t0 + 16 * MIN, 10);
  // Vehicle 3 has its tracker silent for 5 hours while it stands there: no report anywhere in between.
  put(3, t0, 'stopped');
  put(3, t0 + 2 * MIN, 'stopped');
  put(3, t0 + 302 * MIN, 'stopped');
  put(3, t0 + 304 * MIN, 'moving');
  const p = await add();
  const n = (vid) => visits(p.id).filter((x) => x.vehicle_id === vid).length;
  assert.equal(n(1), 2);
  assert.equal(n(2), 1);
  assert.equal(n(3), 1);
});

test('a stay over midnight is one visit, on the day it began', async () => {
  const { stay, visits, places, add } = setup();
  const day = T.addDays(T.today(), -4);
  stay(1, T.dayStart(day) + 23.5 * 3600e3, 60);
  const p = await add();
  assert.equal(visits(p.id).length, 1);
  assert.equal(places.stats(day, day)[0].trips, 1);
  assert.equal(places.stats(T.addDays(day, 1), T.addDays(day, 1))[0].trips, 0);
});

test('the circle decides: resizing works the history out again', async () => {
  const { stay, visits, places, add } = setup();
  const near = { lat: SITE.lat + 0.0027, lng: SITE.lng }; // about 300 m away
  stay(1, DAY_AGO(2), 20, near);
  const p = await add();
  assert.equal(visits(p.id).length, 0, 'outside the default 150 m');
  places.update(p.id, { radiusM: 400 });
  await places.queue;
  assert.equal(visits(p.id).length, 1);
  places.update(p.id, { radiusM: 150 });
  await places.queue;
  assert.equal(visits(p.id).length, 0);
});

test('the rolling refresh is idempotent and follows a visit still going on', async () => {
  const { put, stay, visits, places, add } = setup();
  const now = Date.now();
  stay(1, now - 3 * T.DAY, 20); // older than the refresh window: left alone
  const p = await add();
  assert.equal(visits(p.id).length, 1);

  const start = now - 40 * MIN;
  for (let m = 0; m <= 10; m += 2) put(2, start + m * MIN, 'stopped');
  await places.refresh(now);
  let v = visits(p.id).filter((x) => x.vehicle_id === 2);
  assert.equal(v.length, 1);
  assert.equal(v[0].stopped_s, 10 * 60);
  const before = visits(p.id);
  await places.refresh(now);
  assert.deepEqual(visits(p.id), before, 'running it again changes nothing');

  for (let m = 12; m <= 30; m += 2) put(2, start + m * MIN, 'stopped');
  await places.refresh(now);
  v = visits(p.id).filter((x) => x.vehicle_id === 2);
  assert.equal(v.length, 1, 'the same visit, longer');
  assert.equal(v[0].enter_t, start);
  assert.equal(v[0].stopped_s, 30 * 60);
  assert.equal(visits(p.id).filter((x) => x.vehicle_id === 1).length, 1);
});

test('a visit reaching back past the refresh window stays whole', async () => {
  const { put, visits, places, add } = setup();
  const now = Date.now();
  const start = now - T.DAY - 60 * MIN;
  for (let m = 0; m <= 30; m += 2) put(1, start + m * MIN, 'stopped');
  const p = await add();
  // Still there a whole day later, with a quiet tracker in between.
  put(1, now - 10 * MIN, 'stopped');
  put(1, now - 8 * MIN, 'stopped');
  await places.refresh(now);
  const v = visits(p.id);
  assert.equal(v.length, 1, 'one visit');
  assert.equal(v[0].enter_t, start);
  assert.equal(v[0].exit_t, now - 8 * MIN);
});

test('numbers: per place, per vehicle, hidden vehicles left out', async () => {
  const { put, stay, places, add } = setup();
  const day = T.addDays(T.today(), -2);
  const at = (h) => T.dayStart(day) + h * 3600e3;
  stay(1, at(8), 20); put(1, at(10), 'moving', FAR); stay(1, at(12), 40); stay(2, at(9), 30); stay(3, at(10), 30);
  const p = await add();
  const other = await add({ name: 'Bo\'sh joy', lat: FAR.lat, lng: FAR.lng });
  const [first, second] = places.stats(day, day);
  assert.equal(first.id, p.id, 'busiest first');
  assert.equal(first.trips, 3);
  assert.equal(first.vehicles, 2);
  assert.equal(first.avgStayMin, 30, 'average of 20, 40 and 30 min');
  assert.equal(second.id, other.id);
  assert.equal(second.trips, 0, 'a place nobody went to is still listed');
  assert.equal(second.lastAt, null);
  const vs = places.vehiclesAt(p.id, day, day);
  assert.deepEqual(vs.map((v) => [v.id, v.trips]), [[1, 2], [2, 1]]);
  assert.deepEqual(places.ofVehicle(1, day, day).map((x) => [x.name, x.trips]), [['Sergeli', 2]]);
  assert.equal(places.stats(T.today(), T.today())[0].trips, 0, 'outside the range');
});

test('what is refused changes nothing', async () => {
  const { h, places, add } = setup();
  const p = await add();
  const code = (fn) => { try { fn(); return 200; } catch (e) { return e.status; } };
  const body = { name: 'Boshqa', lat: FAR.lat, lng: FAR.lng };
  assert.equal(code(() => places.create({ ...body, name: ' ' })), 400);
  assert.equal(code(() => places.create({ ...body, name: 'x'.repeat(61) })), 400);
  assert.equal(code(() => places.create({ ...body, name: 42 })), 400);
  assert.equal(code(() => places.create({ ...body, radiusM: 10 })), 400);
  assert.equal(code(() => places.create({ ...body, radiusM: 5000 })), 400);
  assert.equal(code(() => places.create({ ...body, lat: '41' })), 400);
  assert.equal(code(() => places.create({ ...body, lat: 91 })), 400);
  assert.equal(code(() => places.create({ ...body, name: 'SERGELI' })), 409, 'names are unique whatever the case');
  assert.equal(code(() => places.create({ ...body, ...SITE })), 409, 'already inside a place');
  assert.equal(code(() => places.create({ ...body, lat: config.yard.lat, lng: config.yard.lng })), 409, 'the yard already has a name');
  assert.equal(code(() => places.update(p.id, { radiusM: 'big' })), 400);
  assert.equal(code(() => places.update(999, { name: 'Yangi' })), 404);
  assert.equal(code(() => places.remove(999)), 404);
  assert.equal(h.get('SELECT COUNT(*) n FROM places').n, 1);
  assert.equal(h.get('SELECT radius_m r FROM places').r, 150);
});

test('the point stays where the truck stopped; deleting takes the visits along', async () => {
  const { h, stay, visits, places, add } = setup();
  stay(1, DAY_AGO(2), 20);
  const p = await add();
  assert.equal(visits(p.id).length, 1);
  const r = places.update(p.id, { name: '  Yangi   nom ', lat: 1, lng: 1 });
  assert.equal(r.name, 'Yangi nom');
  assert.equal(r.lat, SITE.lat, 'the point is not editable');
  places.remove(p.id);
  await places.queue;
  assert.equal(h.get('SELECT COUNT(*) n FROM place_visits').n, 0);
  assert.equal(places.list().length, 0);
});

test('deleted while its history is being worked out: nothing is left behind', async () => {
  const { h, stay, places } = setup();
  stay(1, DAY_AGO(2), 20);
  const p = places.create({ name: 'Tez', ...SITE });
  places.remove(p.id);
  await places.queue;
  assert.equal(h.get('SELECT COUNT(*) n FROM place_visits').n, 0);
});

test('at(): the nearest centre when circles overlap', async () => {
  const { places, add } = setup();
  await add({ name: 'Katta', radiusM: 1000 });
  const small = await add({ name: 'Kichik', lat: SITE.lat + 0.0095, lng: SITE.lng, radiusM: 100 }); // about 1057 m away
  assert.equal(places.at(SITE.lat + 0.0088, SITE.lng).name, 'Kichik', 'in both circles, nearer the small one');
  assert.equal(places.at(small.lat, small.lng).name, 'Kichik');
  assert.equal(places.at(SITE.lat, SITE.lng).name, 'Katta');
  assert.equal(places.at(FAR.lat, FAR.lng), null);
  assert.equal(places.at(null, null), null);
});

test('common places: visited more than once, by several trucks', () => {
  const day = (n) => T.dayStart('2026-10-01') + n * T.DAY + 3600e3;
  const at = (dLat = 0) => ({ lat: SITE.lat + dLat, lng: SITE.lng });
  const stops = [];
  for (let i = 0; i < 6; i++) stops.push({ vehicle_id: 1 + (i % 3), t: day(i % 3), ...at(i * 0.0001) }); // one spot, a little GPS drift
  for (let i = 0; i < 9; i++) stops.push({ vehicle_id: 7, t: day(i), ...FAR }); // one truck at its driver's home
  for (let i = 0; i < 4; i++) stops.push({ vehicle_id: 1 + (i % 2), t: day(0), lat: 41.5, lng: 69.5 }); // one big pour: a real site
  stops.push({ vehicle_id: 1, t: day(1), lat: 41.6, lng: 69.6 }, { vehicle_id: 2, t: day(2), lat: 41.6, lng: 69.6 }); // too few
  const found = findCommon(stops);
  assert.equal(found.length, 2);
  assert.equal(found[1].visits, 4);
  assert.equal(found[1].days, 1);
  assert.equal(found[0].visits, 6, 'busiest first');
  assert.equal(found[0].vehicles, 3);
  assert.equal(found[0].days, 3);
  assert.ok(Math.abs(found[0].lat - (SITE.lat + 0.00025)) < 1e-6, 'the centre of its stops');
  assert.deepEqual(findCommon([]), []);
});

test('common places: stops are found in the samples; a named or hidden spot is no longer offered', async () => {
  const { stay, put, places, add, h } = setup();
  const now = Date.now();
  // Two trucks stop at the site on two days, 6 stops in all; one short wait and a long stop in the yard don't count.
  for (let i = 0; i < 3; i++) { stay(1, now - (i + 1) * T.DAY, 20); stay(2, now - (i + 1) * T.DAY + 3 * 3600e3, 20); }
  stay(1, now - 5 * T.DAY, 2);
  const y = config.yard;
  for (let i = 0; i < 6; i++) stay(1 + (i % 2), now - (i + 1) * T.DAY + 6 * 3600e3, 20, { lat: y.lat, lng: y.lng });
  put(1, now - 60e3, 'moving', FAR);
  await places.refreshCommon(now);
  const list = places.common();
  assert.equal(list.length, 1, 'the site, not the yard');
  assert.equal(list[0].visits, 6);
  assert.equal(h.kvGet('common_places').length, 1, 'kept for the next start');

  const again = new Places({ h, config, log: console });
  assert.equal(again.common().length, 1, 'known straight after a restart');

  const p = await add({ lat: list[0].lat, lng: list[0].lng });
  assert.equal(places.common().length, 0, 'named');
  places.remove(p.id);
  assert.equal(places.common().length, 1, 'offered again');
  const code = (fn) => { try { fn(); return 200; } catch (e) { return e.status; } };
  assert.equal(code(() => places.hideCommon({ lat: 'x', lng: 1 })), 400);
  places.hideCommon({ lat: list[0].lat, lng: list[0].lng });
  assert.equal(places.common().length, 0, 'hidden');
  assert.equal(again.common().length, 0, 'hidden for good');
});

test('common places: a truck flickering to "moving" while it stands is one visit, as on the real fleet', async () => {
  const { put, places } = setup();
  const t0 = Date.now() - 2 * T.DAY;
  // Each of 3 trucks: half an hour at the spot in 3-minute pieces, none of them a 5-minute stop alone.
  for (const vid of [1, 2, 3]) {
    for (let piece = 0; piece < 6; piece++) {
      const at = t0 + vid * 3600e3 + piece * 5 * MIN;
      put(vid, at, 'stopped'); put(vid, at + 2 * MIN, 'stopped'); put(vid, at + 3 * MIN, 'moving');
    }
  }
  // A truck that comes back after a real trip is a new visit.
  put(1, t0 + 5 * 3600e3, 'moving', FAR);
  for (let m = 0; m <= 20; m += 2) put(1, t0 + 6 * 3600e3 + m * MIN, 'stopped');
  put(1, t0 + 6 * 3600e3 + 22 * MIN, 'moving', FAR);
  await places.refreshCommon();
  const list = places.common();
  assert.equal(list.length, 1);
  assert.equal(list[0].visits, 4, 'not 19 pieces');
  assert.equal(list[0].vehicles, 3);
});

test('common places: at most the 20 busiest are offered', async () => {
  const { h, places } = setup();
  const many = Array.from({ length: 30 }, (_, i) => ({ lat: 41 + i * 0.1, lng: 69, visits: 100 - i, vehicles: 2, days: 2 }));
  h.kvSet('common_places', many);
  const again = new Places({ h, config, log: console });
  assert.equal(again.common().length, 20);
  assert.equal(again.common()[0].visits, 100);
  void places;
});

test('an ignored spot comes back only if trucks keep going there, after the ignore period', async () => {
  const { h, stay, put, places } = setup();
  const now = Date.now();
  const at = now - 10 * T.DAY; // ignored 10 days ago
  const ignored = (when = at) => h.kvSet('common_hidden', [{ ...SITE, at: when }]);
  const trip = (vid, t) => { stay(vid, t, 20); put(vid, t + 40 * MIN, 'moving', FAR); };
  // Why it was suggested in the first place: visits before it was ignored.
  for (let i = 0; i < 4; i++) trip(1 + (i % 2), at - (i + 1) * T.DAY);

  ignored();
  await places.refreshCommon(now);
  assert.equal(places.common().length, 0, 'the old visits alone do not bring it back');

  trip(1, at + T.DAY); trip(1, at + 2 * T.DAY); trip(1, at + 3 * T.DAY);
  await places.refreshCommon(now);
  assert.equal(places.common().length, 0, 'one truck alone does not bring it back');

  trip(2, at + 4 * T.DAY);
  await places.refreshCommon(now);
  const back = places.common();
  assert.equal(back.length, 1, '4 new visits by 2 trucks bring it back');
  assert.equal(back[0].visits, 8, 'with all its visits');
  assert.deepEqual(h.kvGet('common_hidden'), [], 'no longer ignored');

  // Ignoring it again starts over, however busy it is.
  ignored(now - 2 * T.DAY);
  for (let i = 0; i < 6; i++) trip(1 + (i % 2), now - 36 * 3600e3 + i * 3600e3);
  await places.refreshCommon(now);
  assert.equal(places.common().length, 0, 'stays away during the 7 days, whatever happens');
  assert.equal(h.kvGet('common_hidden').length, 1);
  await places.refreshCommon(now + 6 * T.DAY);
  assert.equal(places.common().length, 1, 'and comes back when they are over');
});

test('ignoring keeps the date; a spot ignored before the date was kept starts its period now', async () => {
  const { h, stay, places } = setup();
  const now = Date.now();
  for (let i = 0; i < 6; i++) stay(1 + (i % 2), now - (i + 1) * T.DAY, 20);
  await places.refreshCommon(now);
  const [c] = places.common();

  places.hideCommon({ lat: c.lat, lng: c.lng });
  const [saved] = h.kvGet('common_hidden');
  assert.ok(Math.abs(saved.at - Date.now()) < 5000);
  h.kvSet('common_hidden', [{ lat: c.lat, lng: c.lng }]);
  await places.refreshCommon(now);
  assert.equal(places.common().length, 0, 'not released at once');
  assert.equal(h.kvGet('common_hidden')[0].at, now, 'dated from now');
  await places.refreshCommon(now + T.DAY);
  assert.equal(h.kvGet('common_hidden')[0].at, now, 'the date is not moved again');
});

test('undoing an ignore: the list, its numbers, and a second undo', async () => {
  const { h, stay, places } = setup();
  const now = Date.now();
  for (let i = 0; i < 6; i++) stay(1 + (i % 2), now - (i + 1) * T.DAY, 20);
  await places.refreshCommon(now);
  const [c] = places.common();
  assert.deepEqual(places.ignored(), []);

  places.hideCommon({ lat: c.lat, lng: c.lng });
  assert.equal(places.common().length, 0);
  const [row] = places.ignored();
  assert.equal(row.visits, 6);
  assert.equal(row.vehicles, 2);
  assert.ok(row.at > 0);

  // A spot trucks stop going to drops out of the search; the list still knows what it was.
  h.run('DELETE FROM positions');
  await places.refreshCommon(now);
  assert.equal(places.ignored()[0].visits, 6);

  const code = (fn) => { try { fn(); return 200; } catch (e) { return e.status; } };
  assert.equal(code(() => places.restoreCommon({ lat: 'x', lng: 1 })), 400);
  places.restoreCommon({ lat: FAR.lat, lng: FAR.lng });
  assert.equal(places.ignored().length, 1, 'somewhere else: nothing changes');
  places.restoreCommon({ lat: c.lat, lng: c.lng });
  assert.deepEqual(places.ignored(), []);
  assert.equal(code(() => places.restoreCommon({ lat: c.lat, lng: c.lng })), 200, 'twice is fine');
});

test('undo restores only that spot; the last ignored comes first', () => {
  const { h, places } = setup();
  h.kvSet('common_places', [{ ...SITE, visits: 5, vehicles: 2, days: 2 }, { ...FAR, visits: 4, vehicles: 2, days: 1 }]);
  h.kvSet('common_hidden', [{ ...SITE, at: 1000 }, { ...FAR, at: 2000 }]);
  const again = new Places({ h, config, log: console });
  assert.deepEqual(again.ignored().map((x) => x.visits), [4, 5]);
  again.restoreCommon(SITE);
  assert.deepEqual(again.ignored().map((x) => x.visits), [4]);
  assert.deepEqual(again.common().map((x) => x.visits), [5]);
  void places;
});

test('vehicle summary: the same numbers as the Hisobot table', async () => {
  const h = helpers(open(':memory:'));
  h.run("INSERT INTO vehicles (id, name, updated_at) VALUES (1, 'A', 0)");
  const to = T.today(), from = T.addDays(to, -13);
  const row = (d, km, fuel, trips) => h.run('INSERT INTO daily_stats (day, vehicle_id, km, fuel_used, trips_out, updated_at) VALUES (?, 1, ?, ?, ?, 0)', d, km, fuel, trips);
  row(T.addDays(to, -1), 100, 40, 2);
  row(T.addDays(to, -2), 100, 20, 0);
  row(T.addDays(to, -3), 3, null, 0); // no fuel reading: left out of L/100 km; under 5 km and no trip: not a working day
  const a = new Analytics({ h, gps: null, config });
  const s = a.vehicleSummary(1, from, to);
  assert.equal(s.days, 14);
  assert.equal(s.activeDays, 2);
  assert.equal(s.utilization, 14);
  assert.equal(s.fuelPer100, 30);
  assert.equal(s.fuelPer100, a.byVehicle(from, to)[0].fuelPer100);
  assert.equal(a.vehicleSummary(999, from, to), null);
});
