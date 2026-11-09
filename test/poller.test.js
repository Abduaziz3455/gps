'use strict';
// Poller: the GoGPS vehicle list. A vehicle removed from GoGPS leaves the live map and the checks; added back, it returns.
const test = require('node:test');
const assert = require('node:assert');
const config = require('../src/config');
const { open, helpers } = require('../src/db');
const { Poller } = require('../src/gps/poller');

const quiet = { info() {}, warn() {} };

function fakeGps() {
  const gps = {
    fleet: [{ id: 1, name: '85 001 AAA' }, { id: 2, name: '85 002 AAA' }],
    vehicles: async () => gps.fleet.map((v) => ({ guid: null, model: '', ...v })),
    lastData: async (ids) => ids.map((id) => ({ vehicleId: id, latitude: 41.3, longitude: 69.2, speed: 0, recordTime: new Date().toISOString() })),
  };
  return gps;
}

test('a vehicle removed from GoGPS leaves the live list and the snapshot, and comes back when re-added', async () => {
  const h = helpers(open(':memory:'));
  const gps = fakeGps();
  const p = new Poller({ h, gps, config, log: quiet });
  await p.tick();
  assert.deepEqual([...p.live.keys()].sort(), [1, 2]);

  gps.fleet = [{ id: 1, name: '85 001 AAA' }];
  await p.syncVehicles();
  assert.deepEqual([...p.live.keys()], [1]);
  assert.equal(h.get('SELECT in_gps FROM vehicles WHERE id = 2').in_gps, 0);
  assert.deepEqual(h.kvGet('live_snapshot', []).map((x) => x.id), [1]);

  // A restart with an old snapshot that still holds the removed vehicle doesn't bring it back.
  h.kvSet('live_snapshot', [{ id: 1 }, { id: 2 }]);
  assert.deepEqual([...new Poller({ h, gps, config, log: quiet }).live.keys()], [1]);

  gps.fleet = [{ id: 1, name: '85 001 AAA' }, { id: 2, name: '85 002 AAA' }];
  await p.syncVehicles();
  await p.tick();
  assert.deepEqual([...p.live.keys()].sort(), [1, 2]);
});
