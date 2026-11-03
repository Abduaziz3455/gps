'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { Tracker } = require('../src/cameras/tracker');
const { nvrToEpoch } = require('../src/cameras/hikvision');

const IN = { channel: 4, name: 'ANPR-1', direction: 'in' };
const OUT = { channel: 3, name: 'ANPR-2', direction: 'out' };
const CAMS = { 4: IN, 3: OUT };
const T0 = nvrToEpoch('2026-10-12T08:00:00');
const MIN = 60e3;

const tracker = () => new Tracker(new DatabaseSync(':memory:'), { repeatWindowMs: 20 * MIN, samePassWindowMs: 60e3 });

/** Feeds captures into a tracker with unique record names. */
class Seq {
  constructor() {
    this.t = tracker();
    this.n = 0;
  }

  see(cam, minutes, plate) {
    this.n += 1;
    const cap = { channel: cam.channel, time: T0 + Math.round(minutes * MIN), plate, name: `r${this.n}`, uriPath: '/x' };
    return this.t.process(cap, cam);
  }
}

test('tracker', async (t) => {
  await t.test('in then out reports stay', () => {
    const s = new Seq();
    const dIn = s.see(IN, 0, '85450KBA');
    const dOut = s.see(OUT, 9, '85450KBA');
    assert.ok(dIn.emit && dOut.emit);
    assert.equal(dOut.staySeconds, 9 * 60);
    assert.ok(!(dIn.gap || dOut.gap));
    assert.equal(dOut.direction, 'out');
    assert.deepEqual(s.t.insidePlates(), []);
  });

  await t.test('duplicate record is ignored', () => {
    const tr = tracker();
    const cap = { channel: 4, time: T0, plate: '85450KBA', name: 'same', uriPath: '/x' };
    assert.notEqual(tr.process(cap, IN), null);
    assert.equal(tr.process(cap, IN), null);
  });

  await t.test('retrigger same direction is skipped', () => {
    const s = new Seq();
    s.see(IN, 0, '85159YAA');
    const d = s.see(IN, 1, '85159YAA');
    assert.ok(!d.emit);
    assert.equal(d.skipReason, 'repeat after 0:01:00');
    assert.equal(s.t.presence('85159YAA').lastSeen, T0 + MIN);
    assert.equal(s.t.presence('85159YAA').lastEvent, T0);
  });

  await t.test('one pass seen by both cameras is skipped', () => {
    const s = new Seq();
    s.see(IN, 0, '01M393YA');
    const d = s.see(OUT, 0.2, '01M393YA'); // 12 s later on the other camera
    assert.ok(!d.emit);
    assert.equal(d.skipReason, 'same pass, 0:00:12 after other camera');
  });

  await t.test('quick visit is an exit', () => {
    // 85W670JA 12 Oct: in 11:44:56, out 11:46:34 (98 s); the image shows the van driving out.
    const s = new Seq();
    s.see(IN, 0, '85W670JA');
    const d = s.see(OUT, 98 / 60, '85W670JA');
    assert.ok(d.emit);
    assert.equal(d.staySeconds, 98);
  });

  await t.test('entering vehicle seen from behind by exit camera is skipped', () => {
    // 85304RAA 9 Oct: ANPR-2 read the rear plate 50 s after ANPR-1, truck driving into the yard.
    const s = new Seq();
    s.see(IN, 0, '85304RAA');
    const d = s.see(OUT, 50 / 60, '05304RAA');
    assert.equal(d.plate, '85304RAA');
    assert.equal(d.raw, '05304RAA');
    assert.ok(!d.emit);
  });

  await t.test('missed exit is flagged', () => {
    const s = new Seq();
    s.see(IN, 0, '85304RAA');
    const d = s.see(IN, 180, '85304RAA');
    assert.ok(d.emit && d.gap);
  });

  await t.test('exit without entry is flagged', () => {
    const d = new Seq().see(OUT, 0, '85942DBA');
    assert.ok(d.emit && d.gap);
    assert.equal(d.staySeconds, null);
  });

  await t.test('misread exit matches entry', () => {
    const s = new Seq();
    s.see(IN, 0, '85450KBA');
    const d = s.see(OUT, 10, '05450KBA');
    assert.equal(d.plate, '85450KBA');
    assert.equal(d.staySeconds, 10 * 60);
  });

  await t.test('partial reread of vehicle in view is skipped', () => {
    // Live case 12 Oct 13:10: ANPR-1 read 10861HDA, then A861HA 16 s later (same truck).
    const s = new Seq();
    s.see(IN, 0, '10861HDA');
    const d = s.see(IN, 16 / 60, 'A861HA');
    assert.equal(d.plate, '10861HDA');
    assert.ok(!d.emit);
  });

  await t.test('partial read without recent match still alerts', () => {
    const s = new Seq();
    s.see(IN, 0, '10861HDA');
    const d = s.see(IN, 10, 'A861HA'); // 10 min later: not the same pass
    assert.ok(d.emit);
    assert.equal(d.plate, 'A861HA');
    assert.ok(!d.valid);
  });

  await t.test('plateless vehicle alerts without tracking', () => {
    const d = new Seq().see(OUT, 0, 'UNKNOWN');
    assert.ok(d.emit);
    assert.equal(d.plate, null);
  });

  await t.test('fleet plates are correction candidates', () => {
    const tr = new Tracker(new DatabaseSync(':memory:'), { fleetPlates: () => ['85450KBA'] });
    const d = tr.process({ channel: 4, time: T0, plate: '05450KBA', name: 'a', uriPath: '/x' }, IN);
    assert.equal(d.plate, '85450KBA');
    assert.ok(d.emit && d.valid);
  });

  await t.test('presence, inside plates and last sighting time', () => {
    const s = new Seq();
    assert.equal(s.t.lastSightingTime(), null);
    s.see(IN, 0, '85450KBA');
    s.see(IN, 5, '10835HDA');
    s.see(OUT, 30, '85450KBA');
    assert.deepEqual(s.t.insidePlates(), ['10835HDA']);
    assert.deepEqual(s.t.presence('85450KBA'), { inside: false, lastSeen: T0 + 30 * MIN, lastEvent: T0 + 30 * MIN });
    assert.equal(s.t.presence('nope'), null);
    assert.equal(s.t.lastSightingTime(), T0 + 30 * MIN);
  });
});

// Regression on the 264 real captures from the 9-12 Oct survey (docs/site-survey.md in the notifier).
// The fixture stays in the notifier's repository; skip when it is not on this machine.
const FIXTURE = '/home/user/tbb_car_notifier/tests/data/survey_captures.json';

test('survey replay', { skip: !fs.existsSync(FIXTURE) && 'survey fixture not found' }, async (t) => {
  const rows = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  rows.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  const tr = tracker();
  for (const r of rows) {
    const cap = { channel: r.channel, time: nvrToEpoch(r.time), plate: r.plate, name: r.name, uriPath: '/x' };
    tr.process(cap, CAMS[r.channel]);
  }
  const events = tr.db.prepare('SELECT plate, kind, time FROM cam_passes ORDER BY time').all();

  await t.test('fleet trucks stay distinct', () => {
    const seen = new Set(events.map((e) => e.plate));
    for (const p of ['10835HDA', '10863HDA', '10865HDA', '10872HDA']) assert.ok(seen.has(p), p);
  });

  await t.test('pairing quality', () => {
    const by = new Map();
    for (const e of events) {
      if (!by.has(e.plate)) by.set(e.plate, []);
      by.get(e.plate).push(e);
    }
    const c = { pair: 0, out_without_in: 0, in_after_in: 0 };
    const stays = [];
    for (const seq of by.values()) {
      let prev = null;
      for (const e of seq) {
        if (e.kind === 'out') {
          if (prev && prev.kind === 'in') {
            c.pair += 1;
            stays.push(e.time - prev.time);
          } else {
            c.out_without_in += 1;
          }
        } else if (prev && prev.kind === 'in') {
          c.in_after_in += 1;
        }
        prev = e;
      }
    }
    assert.equal(c.pair, 58); // 57 with a 2-min same-pass window; 85W670JA's 98 s visit now counts
    assert.equal(c.out_without_in, 9);
    assert.equal(c.in_after_in, 20);
    // Nothing shorter than the same-pass window; quick drop-offs (78 s, 98 s) are real and verified on images.
    assert.ok(Math.min(...stays) >= 60e3);
  });
});
