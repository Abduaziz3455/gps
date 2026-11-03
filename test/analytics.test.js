'use strict';
// GPS normalisation (status mapping checked against live data on 3 Nov 2026), Tashkent day maths, rollups.
const test = require('node:test');
const assert = require('node:assert');
const config = require('../src/config');
const { open, helpers } = require('../src/db');
const { Analytics } = require('../src/analytics');
const { normalizeLast, similarPlate, plateKey, vehicleLabel } = require('../src/gps/normalize');
const T = require('../src/time');

test('getlastdata rows -> status', () => {
  const now = Date.parse('2026-11-03T06:40:00Z');
  const row = (state, speed, recordTime) => ({ vehicleId: 1, latitude: 41.2, longitude: 69.3, state, speed, course: 10, recordTime, address: 'x' });
  const st = (...a) => normalizeLast(row(...a), now, 30 * 60e3).status;
  assert.equal(st(4, 47, '2026-11-03T06:39:23Z'), 'moving');
  assert.equal(st(2, 9, '2026-11-03T06:20:19Z'), 'idle');
  assert.equal(st(3, 0, '2026-11-03T06:39:26Z'), 'stopped');
  assert.equal(st(1, 0, '2026-10-31T07:14:16Z'), 'offline', 'state 1 with a days-old record');
  assert.equal(st(3, 0, '2026-11-03T05:00:00Z'), 'offline', 'no record for 30+ min');
  assert.equal(normalizeLast({ vehicleId: 1, latitude: 0, longitude: 0 }, now, 1), null);
});

test('plates and labels', () => {
  assert.equal(plateKey('85 117 АА'), '85117AA'); // Cyrillic look-alikes
  assert.ok(similarPlate('10870HAD', '10870HDA'));
  assert.ok(!similarPlate('10870HAD', '10872HDA'));
  assert.equal(vehicleLabel({ name: '33' }), '№33');
  assert.equal(vehicleLabel({ name: '10 870 HAD', plate: '10870HDA' }), '10 870 HDA');
});

test('Tashkent days', () => {
  assert.equal(T.dayOf(Date.parse('2026-11-02T19:30:00Z')), '2026-11-03'); // 00:30 local
  assert.equal(T.dayStart('2026-11-03'), Date.parse('2026-11-02T19:00:00Z'));
  assert.equal(T.localIso(Date.parse('2026-11-03T05:00:00Z')), '2026-11-03T10:00:00');
  assert.equal(T.parseApiTime('2026-11-03T10:00:00'), Date.parse('2026-11-03T05:00:00Z'), 'naive = local');
  assert.equal(T.parseApiTime('2026-11-03T06:39:23Z'), Date.parse('2026-11-03T06:39:23Z'));
  assert.equal(T.addDays('2026-11-01', -1), '2026-10-31');
});

test('rollup reads the three GoGPS reports and the gate events', async () => {
  const h = helpers(open(':memory:'));
  h.run("INSERT INTO vehicles (id, name, updated_at) VALUES (1, 'A', 0), (2, 'B', 0)");
  const day = '2026-11-02';
  const at = (hh) => T.dayStart(day) + hh * 3600e3;
  const ev = (vid, dir, t, stay = null) => h.run(`INSERT INTO gate_events (capture_name, t, direction, camera, channel, vehicle_id, status, stay_s, created_at)
    VALUES (?, ?, ?, 'c', 1, ?, 'confirmed', ?, 0)`, `${vid}-${t}`, t, dir, vid, stay);
  ev(1, 'out', at(8), 1200); ev(1, 'in', at(9.5)); ev(1, 'out', at(10), 1800); ev(1, 'in', at(12));
  const calls = [];
  const gps = {
    mileage: async (ids, from, to, s) => { calls.push(['mileage', ids, from, to, s]); return [{ vehicleId: 1, periods: [{ mileage: 120.5, mileageEnd: 51000, motohours: 30000, idlingTime: 3000 }] }]; },
    fuel: async () => [{ vehicleId: 1, periods: [{ fuelLevelStart: 150, fuelLevelEnd: 90, fuelConsumption: 60 }] }, { vehicleId: 2, periods: [{ fuelLevelStart: 0, fuelLevelEnd: 0, fuelConsumption: 0 }] }],
    fuelInOut: async () => [{ vehicleId: 1, fuels: [{ event: 'FuelIn', startDate: `${day}T07:30:00`, valueFuel: 100 }, { event: 'FuelOut', startDate: `${day}T22:00:00`, valueFuel: 35 }] }],
  };
  const a = new Analytics({ h, gps, config });
  await a.rollup(day);
  assert.equal(calls[0][2], T.dayStart(day));
  const s = h.get('SELECT * FROM daily_stats WHERE day = ? AND vehicle_id = 1', day);
  assert.equal(s.km, 120.5);
  assert.equal(s.engine_s, 30000);
  assert.equal(s.fuel_used, 60);
  assert.equal(s.refuel_l, 100);
  assert.equal(s.drain_l, 35);
  assert.equal(s.trips_out, 2);
  assert.equal(s.turnaround_s, Math.round((1.5 * 3600 + 2 * 3600) / 2));
  assert.equal(s.yard_s, 3000);
  assert.equal(h.get('SELECT fuel_used FROM daily_stats WHERE day = ? AND vehicle_id = 2', day).fuel_used, null, 'no sensor -> NULL, not 0');
  assert.equal(h.get("SELECT COUNT(*) n FROM fuel_events WHERE kind = 'drain'").n, 1);
  const byV = a.byVehicle(day, day);
  assert.equal(byV[0].fuelPer100, Math.round((60 / 120.5) * 1000) / 10);
});
