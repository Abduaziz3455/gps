'use strict';
// Gate pipeline: plate matching and the GPS resolution rules (confirm, veto, identify unread plates, learn aliases).
const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const { open, helpers } = require('../src/db');
const { Gate } = require('../src/gate');
const { Tracker } = require('../src/cameras/tracker');
const plates = require('../src/cameras/plates');
const bus = require('../src/bus');

const T0 = Date.parse('2026-11-03T05:00:00Z'); // 10:00 Tashkent
const CAMS = [
  { channel: 4, name: 'ANPR-1', direction: 'in', contextChannel: null, contextName: null },
  { channel: 3, name: 'ANPR-2', direction: 'out', contextChannel: null, contextName: null },
];

function setup() {
  const db = open(':memory:');
  const h = helpers(db);
  const now = Date.now();
  const add = (id, name, plate = null) => h.run('INSERT INTO vehicles (id, name, plate, updated_at) VALUES (?, ?, ?, ?)', id, name, plate, now);
  add(1, '85 450 KBA');
  add(2, '10 870 HAD'); // GPS typo of the camera plate 10870HDA
  add(3, '33'); // fleet number only
  add(4, '85 159 YAA');
  const poller = { live: new Map(), openVisit: new Map() };
  const config = {
    dataDir: '/nonexistent',
    nvr: { cameras: CAMS, resolveAfterSec: 90, exitConfirmMin: 5, matchBeforeSec: 45, matchAfterSec: 90, pollSeconds: 60, catchupHours: 6, backfillDays: 0, keepPhotosDays: 0 },
  };
  let gate;
  const tracker = new Tracker(db, { fleetPlates: () => gate.fleetPlates() });
  gate = new Gate({ h, nvr: { captureImage: async () => Buffer.alloc(0) }, poller, config, tracker, plates, log: {} });
  const visit = (vid, enter, exit = null) => h.run('INSERT INTO yard_visits (vehicle_id, enter_t, exit_t) VALUES (?, ?, ?)', vid, enter, exit);
  let n = 0;
  const capture = async (channel, t, plate) => {
    n++;
    const cap = { channel, time: t, plate, name: `ch0${channel}_${n}_${plate || 'UNKNOWN'}`, uriPath: '' };
    const d = tracker.process(cap, CAMS.find((c) => c.channel === channel));
    if (d?.emit) await gate.onDecision(d, 'live');
    return h.get('SELECT * FROM gate_events WHERE capture_name = ?', cap.name);
  };
  return { db, h, gate, poller, visit, capture };
}

test('plate matching: exact GPS name, owner-set plate, same digits+letters, fleet numbers need a plate', () => {
  const { gate, h } = setup();
  assert.deepEqual(gate.matchPlate('85450KBA').vehicle.id, 1);
  assert.equal(gate.matchPlate('85450KBA').how, 'plate');
  assert.equal(gate.matchPlate('10870HDA').vehicle.id, 2);
  assert.equal(gate.matchPlate('10870HDA').how, 'similar');
  assert.equal(gate.matchPlate('10872HDA'), null);
  h.run("UPDATE vehicles SET plate = '10872HDA' WHERE id = 3");
  assert.equal(gate.matchPlate('10872HDA').vehicle.id, 3);
  assert.equal(gate.matchPlate('10872HDA').how, 'alias');
});

test('exit confirmed when GPS left the yard within the window', async () => {
  const { gate, visit, capture } = setup();
  visit(1, T0 - 3600e3, T0 + 20e3);
  const ev = await capture(3, T0, '85450KBA');
  assert.equal(ev.status, 'pending');
  gate.resolvePending(T0 + 100e3);
  assert.equal(gate.get(ev.id).status, 'confirmed');
});

test('exit vetoed when the truck is still parked in the yard 5 minutes later', async () => {
  const { gate, poller, capture } = setup();
  poller.live.set(1, { id: 1, status: 'stopped', inYard: true, recordTime: T0 + 4 * 60e3 });
  const ev = await capture(3, T0, '85450KBA');
  gate.resolvePending(T0 + 100e3);
  assert.equal(gate.get(ev.id).status, 'pending', 'waits for exit_confirm');
  const notified = [];
  const on = (e) => notified.push(e.id);
  bus.on('gate:notify', on);
  gate.resolvePending(T0 + 6 * 60e3);
  bus.off('gate:notify', on);
  assert.equal(gate.get(ev.id).status, 'vetoed');
  assert.deepEqual(notified, [], 'vetoed exits are never notified');
});

test('unread exit is identified by the one vehicle that left the yard then', async () => {
  const { gate, visit, capture } = setup();
  visit(4, T0 - 3600e3, T0 + 15e3);
  visit(1, T0 - 3600e3, T0 + 900e3); // left much later
  const ev = await capture(3, T0, null);
  gate.resolvePending(T0 + 60e3);
  assert.equal(gate.get(ev.id).status, 'pending', 'waits until the match window has passed');
  gate.resolvePending(T0 + 110e3);
  const r = gate.get(ev.id);
  assert.equal(r.status, 'confirmed');
  assert.equal(r.vehicleId, 4);
  assert.equal(r.identifiedBy, 'gps');
});

test('unread exit with two departures at once stays unidentified', async () => {
  const { gate, visit, capture } = setup();
  visit(4, T0 - 3600e3, T0 + 15e3);
  visit(1, T0 - 3600e3, T0 + 25e3);
  const ev = await capture(3, T0, null);
  gate.resolvePending(T0 + 120e3);
  const r = gate.get(ev.id);
  assert.equal(r.status, 'outside');
  assert.equal(r.vehicleId, null);
});

test('a plate outside the fleet becomes an alias after 3 consistent exits', async () => {
  const { gate, visit, capture } = setup();
  for (let i = 0; i < 3; i++) {
    const t = T0 + i * 3 * 3600e3;
    visit(3, t - 3600e3, t + 10e3);
    // the vehicle comes back in between (so the tracker sees new exits, not repeats)
    await capture(4, t - 2 * 3600e3, '10872HDA');
    const ev = await capture(3, t, '10872HDA');
    gate.resolvePending(t + 120e3);
    const r = gate.get(ev.id);
    if (i < 2) assert.equal(r.status, 'outside', `exit ${i + 1}: not learned yet`);
    else { assert.equal(r.status, 'confirmed'); assert.equal(r.vehicleId, 3); assert.equal(r.identifiedBy, 'learned'); }
  }
  assert.equal(gate.matchPlate('10872HDA').vehicle.id, 3);
});

test('entry of a fleet vehicle is notified at once and confirmed when GPS shows it arriving', async () => {
  const { gate, visit, capture } = setup();
  const seen = [];
  const on = (e) => seen.push(e.id);
  bus.on('gate:notify', on);
  const ev = await capture(4, Date.now() - 5000, '85159YAA');
  bus.off('gate:notify', on);
  assert.deepEqual(seen, [ev.id]);
  visit(4, ev.t + 30e3);
  gate.resolvePending(ev.t + 100e3);
  assert.equal(gate.get(ev.id).status, 'confirmed');
});

test('outside vehicle entry: status outside, no GPS wait', async () => {
  const { capture } = setup();
  const ev = await capture(4, T0, '01A123BC');
  assert.equal(ev.status, 'outside');
  assert.equal(ev.vehicle_id, null);
});

void DatabaseSync;

// --- first-run camera import ------------------------------------------------------------------

function importRig(t, { db = open(':memory:'), pollSeconds = 0.01, backfillDays = 30 } = {}) {
  const h = helpers(db);
  if (!h.get('SELECT 1 FROM vehicles WHERE id = 1')) h.run('INSERT INTO vehicles (id, name, updated_at) VALUES (1, ?, ?)', '85 450 KBA', Date.now());
  const down = new Set(CAMS.map((c) => c.channel)); // cameras that fail; all of them until back()
  const searches = [];
  const nvr = {
    searchCaptures: async (ch, since) => {
      searches.push({ ch, since });
      if (down.has(ch)) throw new Error('connect EHOSTUNREACH');
      return [{ channel: ch, time: Date.now() - 86400e3, plate: '85450KBA', name: `ch0${ch}_history`, uriPath: '' }];
    },
    captureImage: async () => Buffer.alloc(0),
    anprEvents: (fn, { signal }) => new Promise((resolve) => { nvr.fire = fn; signal.addEventListener('abort', resolve); }),
  };
  const config = {
    dataDir: '/nonexistent',
    nvr: { cameras: CAMS, resolveAfterSec: 90, exitConfirmMin: 5, matchBeforeSec: 45, matchAfterSec: 90, pollSeconds, catchupHours: 6, backfillDays, keepPhotosDays: 0 },
  };
  let gate;
  const tracker = new Tracker(db, { fleetPlates: () => gate.fleetPlates() });
  gate = new Gate({ h, nvr, poller: { live: new Map(), openVisit: new Map() }, config, tracker, plates, log: {} });
  t.after(() => gate.stop()); // also when an assertion fails: a running poll would keep the test process alive
  const sightings = () => h.get('SELECT COUNT(*) n FROM cam_sightings').n;
  return { db, h, nvr, gate, down, searches, sightings, done: () => h.kvGet('camera_history_done') };
}
const until = async (cond) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(cond(), 'condition not met in time');
};
const THIRTY_DAYS_AGO = () => Date.now() - 29 * 86400e3;

test('camera history: NVR down on the first start, imported when it comes back, only once', async (t) => {
  const r = importRig(t);
  const imported = [];
  const on = (x) => imported.push(x);
  bus.on('gate:history', on);
  t.after(() => bus.off('gate:history', on));
  await r.gate.start();
  await until(() => r.searches.length > 4); // retried by the polls
  assert.equal(r.done(), null);
  assert.equal(r.sightings(), 0);
  assert.equal(imported.length, 0);

  r.down.clear();
  await until(() => r.done());
  assert.equal(r.sightings(), 2);
  assert.equal(imported.length, 1);
  assert.deepEqual(r.h.all('SELECT DISTINCT status FROM gate_events').map((x) => x.status), ['history']);
  r.gate.stop();

  // After a restart: no second import, whatever the outcome of the first.
  const again = importRig(t, { db: r.db, pollSeconds: 60 });
  again.down.clear();
  await again.gate.start();
  assert.ok(again.searches.every((s) => s.since > THIRTY_DAYS_AGO()), 'the import ran again');
});

test('camera history: one camera failing records nothing, so the retry stays in time order', async (t) => {
  const r = importRig(t);
  r.down.delete(4);
  await r.gate.start();
  await until(() => r.searches.length > 4);
  assert.equal(r.done(), null);
  assert.equal(r.sightings(), 0);
  r.down.clear();
  await until(() => r.done());
  assert.equal(r.sightings(), 2);
});

test('camera history: an empty answer counts as done; a database from before the mark is not imported again', async (t) => {
  const empty = importRig(t, { pollSeconds: 60 });
  empty.down.clear();
  empty.nvr.searchCaptures = async () => [];
  await empty.gate.start();
  assert.ok(empty.done());

  const old = importRig(t, { pollSeconds: 60 });
  old.down.clear();
  old.h.run("INSERT INTO cam_sightings (name, channel, camera, time, plate) VALUES ('ch04_old', 4, 'ANPR-1', ?, '85450KBA')", Date.now() - 3600e3);
  await old.gate.start();
  assert.ok(old.searches.length > 0 && old.searches.every((s) => s.since > THIRTY_DAYS_AGO()), 'the import ran on an old database');
});

test('camera history: a live camera event waits while the import is pending', async (t) => {
  const r = importRig(t, { pollSeconds: 60 });
  await r.gate.start();
  await until(() => r.nvr.fire);
  const before = r.searches.length;
  r.nvr.fire(4);
  await new Promise((res) => setTimeout(res, 2200)); // a live sync would start 2 s after the event
  assert.equal(r.searches.length, before);
});
