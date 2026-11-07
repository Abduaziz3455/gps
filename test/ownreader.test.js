'use strict';
// Our own plate reader in the gate pipeline (src/cameras/ownreader.js): backup reads from video when the camera's
// capture is missing, re-reads of plates the camera couldn't read, and the camera keeping priority.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { open, helpers } = require('../src/db');
const { Gate } = require('../src/gate');
const { Tracker } = require('../src/cameras/tracker');
const { OwnReader } = require('../src/cameras/ownreader');
const plates = require('../src/cameras/plates');

const CAMS = [
  { channel: 4, name: 'ANPR-1', direction: 'in', contextChannel: null, contextName: null },
  { channel: 3, name: 'ANPR-2', direction: 'out', contextChannel: null, contextName: null },
];
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

/** A fake reader service: passes to hand out, and the answer to POST /read. */
function fakeReader() {
  const r = { passes: [], seq: 0, boot: 'b1', readAnswer: [], down: false, reads: 0 };
  r.add = (p) => { r.seq++; r.passes.push({ seq: r.seq, jpeg: JPEG.toString('base64'), votes: 5, frames: 12, others: {}, ...p }); };
  r.fetch = async (url, opts = {}) => {
    if (r.down) throw new Error('connect ECONNREFUSED');
    const u = new URL(url);
    if (u.pathname === '/passes') {
      const after = Number(u.searchParams.get('after'));
      return { ok: true, json: async () => ({ boot: r.boot, seq: r.seq, passes: r.passes.filter((p) => p.seq > after) }) };
    }
    if (u.pathname === '/read' && opts.method === 'POST') {
      r.reads++;
      return { ok: true, json: async () => ({ reads: r.readAnswer, ms: 400 }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return r;
}

function setup({ captures = [] } = {}) {
  const db = open(':memory:');
  const h = helpers(db);
  h.run('INSERT INTO vehicles (id, name, updated_at) VALUES (1, ?, ?)', '85 450 KBA', Date.now());
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownreader-'));
  const config = {
    dataDir,
    nvr: { cameras: CAMS, resolveAfterSec: 90, exitConfirmMin: 5, matchBeforeSec: 45, matchAfterSec: 90, pollSeconds: 60, catchupHours: 6, backfillDays: 0, keepPhotosDays: 0 },
  };
  let gate;
  const tracker = new Tracker(db, { fleetPlates: () => gate.fleetPlates() });
  const nvr = { captureImage: async () => JPEG, searchCaptures: async (ch) => captures.filter((c) => c.channel === ch) };
  gate = new Gate({ h, nvr, poller: { live: new Map(), openVisit: new Map() }, config, tracker, plates, log: {} });
  const reader = fakeReader();
  const own = new OwnReader({ url: 'http://reader:8091', holdSec: 45, minConf: 0.5 }, { gate, h, log: process.env.DEBUG_OWN ? console : {}, fetch: reader.fetch });
  const events = () => h.all('SELECT * FROM gate_events ORDER BY t');
  return { h, gate, tracker, own, reader, events, dataDir, captures };
}

test('a vehicle our reader saw while the camera recorded nothing becomes a gate event, after the hold', async () => {
  const { own, reader, events, dataDir } = setup();
  await own.poll(); // first contact
  const t = Date.now() - 50e3;
  reader.add({ channel: 4, time: t, plate: '85450KBA', conf: 0.97 });
  await own.poll();
  await own.release(t + 30e3);
  assert.equal(events().length, 0, 'held while the camera can still deliver');
  await own.release(t + 46e3);
  const [ev] = events();
  assert.ok(ev, 'released after the hold');
  assert.equal(ev.plate, '85450KBA');
  assert.equal(ev.vehicle_id, 1);
  assert.equal(ev.read_by, 'own');
  assert.equal(ev.read_conf, 0.97);
  assert.equal(ev.direction, 'in');
  assert.match(ev.capture_name, /^own_4_/);
  const photos = JSON.parse(ev.photos);
  assert.equal(photos.length, 1, 'the frame it read is the photo');
  assert.deepEqual(fs.readFileSync(path.join(dataDir, 'photos', photos[0].file)), JPEG);
});

test('a pass read again from the recording comes minutes late and still has its photo', async () => {
  const { own, reader, events } = setup();
  await own.poll();
  const t = Date.now() - 200e3; // past the 3 minutes in which the NVR is asked for pictures
  reader.add({ channel: 3, time: t, plate: '85450KBA', conf: 0.96, source: 'recording' });
  await own.poll();
  await own.release();
  const [ev] = events();
  assert.equal(ev.read_by, 'own');
  assert.equal(JSON.parse(ev.photos).length, 1);
});

test("the camera's own capture of the same pass wins: ours is dropped", async () => {
  const { own, reader, events, tracker } = setup();
  await own.poll();
  const t = Date.now() - 50e3;
  tracker.addSighting({ name: 'ch00004_1_85450KBA', channel: 4, time: t + 3e3, plate: '85450KBA' }, 'ANPR-1');
  reader.add({ channel: 4, time: t, plate: '85450KBA', conf: 0.97 });
  await own.poll();
  await own.release(t + 46e3);
  assert.equal(events().length, 0);
  assert.equal(own.stats.cameraHad, 1);
});

test('a pass reported twice is one event (repeat window), and weak or malformed reads are ignored', async () => {
  const { own, reader, events } = setup();
  await own.poll();
  const t = Date.now() - 100e3;
  reader.add({ channel: 4, time: t, plate: '85450KBA', conf: 0.95 });
  reader.add({ channel: 4, time: t + 20e3, plate: '85450KBA', conf: 0.9 });
  reader.add({ channel: 3, time: t + 1e3, plate: '10870HDA', conf: 0.3 });
  reader.add({ channel: 3, time: t + 2e3, plate: '8545OKBA', conf: 0.99 });
  await own.poll();
  await own.release(t + 100e3);
  assert.deepEqual(events().map((e) => e.plate), ['85450KBA']);
});

test("passes the reader saw before we connected aren't replayed; a restarted reader is picked up again", async () => {
  const { own, reader, events } = setup();
  reader.add({ channel: 4, time: Date.now() - 3600e3, plate: '85450KBA', conf: 0.99 });
  await own.poll();
  await own.release(Date.now() + 60e3);
  assert.equal(events().length, 0, 'an hour-old pass from before is not news');
  reader.seq = 0; // the reader restarted: new boot id, numbering starts again
  reader.boot = 'b2';
  reader.passes = [];
  const t = Date.now() - 50e3;
  reader.add({ channel: 3, time: t, plate: '85450KBA', conf: 0.99 });
  await own.poll();
  await own.release(t + 46e3);
  assert.equal(events().length, 1);
  reader.add({ channel: 4, time: t + 600e3, plate: '85450KBA', conf: 0.99 });
  await own.poll();
  await own.release(t + 700e3);
  assert.equal(events().length, 2, 'and later passes after the restart come through');
});

test('the reader being down costs nothing but its reads', async () => {
  const { own, reader } = setup();
  reader.down = true;
  await assert.rejects(own.poll(), /ECONNREFUSED/);
  assert.equal(own.held.length, 0);
});

test("mode A: a capture the camera couldn't read is read again; the camera's read stays in plate_raw", async () => {
  const t = Date.now() - 20e3;
  const { gate, own, reader, events } = setup({ captures: [{ channel: 3, time: t, plate: 'P8545', name: 'ch00003_1_P8545', uriPath: '/x' }] });
  gate.ownReader = own;
  reader.readAnswer = [{ plate: '85450KBA', conf: 0.93, det: 0.8, box: [1, 2, 3, 4], cut: false }];
  await gate.sync([3], t - 60e3);
  const [ev] = events();
  assert.equal(ev.plate, '85450KBA');
  assert.equal(ev.plate_raw, 'P8545');
  assert.equal(ev.read_by, 'own-reread');
  assert.equal(ev.vehicle_id, 1);
  assert.equal(reader.reads, 1);
});

test("mode A leaves good camera reads alone, and a weak or cut-off re-read doesn't replace anything", async () => {
  const t = Date.now() - 20e3;
  const { gate, own, reader, events } = setup({ captures: [
    { channel: 3, time: t, plate: '85450KBA', name: 'ch00003_1_85450KBA', uriPath: '/x' },
    { channel: 4, time: t + 5e3, plate: '', name: 'ch00004_2_UNKNOWN', uriPath: '/y' },
  ] });
  gate.ownReader = own;
  reader.readAnswer = [{ plate: '10834HAA', conf: 0.4, det: 0.8, box: [0, 2, 3, 4], cut: false }, { plate: '10834HDA', conf: 0.9, det: 0.8, box: [0, 2, 3, 4], cut: true }];
  await gate.sync([3, 4], t - 60e3);
  assert.equal(reader.reads, 1, 'only the unread capture is sent');
  const evs = events();
  assert.equal(evs[0].read_by, null);
  assert.equal(evs[1].plate, null);
  assert.equal(evs[1].read_by, null);
});

test("mode A with the reader down: the camera's capture goes through as before", async () => {
  const t = Date.now() - 20e3;
  const { gate, own, reader, events } = setup({ captures: [{ channel: 4, time: t, plate: '', name: 'ch00004_1_UNKNOWN', uriPath: '/y' }] });
  gate.ownReader = own;
  reader.down = true;
  await gate.sync([4], t - 60e3);
  assert.equal(events().length, 1);
  assert.equal(events()[0].read_by, null);
});

test("our reads don't count as the camera working (catch-up start, camera-silent check)", async () => {
  const { own, reader, tracker } = setup();
  await own.poll();
  const t = Date.now() - 50e3;
  tracker.addSighting({ name: 'ch00004_1_X', channel: 4, time: t - 3600e3, plate: '85450KBA' }, 'ANPR-1');
  reader.add({ channel: 3, time: t, plate: '85450KBA', conf: 0.99 });
  await own.poll();
  await own.release(t + 46e3);
  assert.equal(tracker.lastSightingTime(), t - 3600e3);
});
