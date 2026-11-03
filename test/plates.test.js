'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const plates = require('../src/cameras/plates');

const KNOWN = ['85450KBA', '85304RAA', '85159YAA', '85942DBA', '10964DDA',
  '10835HDA', '10863HDA', '10865HDA', '10872HDA', '01M393YA'];

test('validation', async (t) => {
  await t.test('valid formats', () => {
    for (const p of ['85450KBA', '01M393YA', '10S264MB', '10835HDA']) assert.ok(plates.isValid(p), p);
  });
  await t.test('bad region code is invalid', () => {
    for (const p of ['05450KBA', '55450KBA', '65159YAA', '81304RAA', '06450KBA']) assert.ok(!plates.isValid(p), p);
  });
  await t.test('partial reads are invalid', () => {
    for (const p of ['8594DBA', '304RAA', '01M39', '10865', '8711AO']) assert.ok(!plates.isValid(p), p);
  });
  await t.test('pretty', () => {
    assert.equal(plates.pretty('85450KBA'), '85 450 KBA');
    assert.equal(plates.pretty('01M393YA'), '01 M 393 YA');
    assert.equal(plates.pretty('A861HA'), 'A861HA');
  });
  await t.test('normalize', () => {
    assert.equal(plates.normalize('UNKNOWN'), null);
    assert.equal(plates.normalize(null), null);
    assert.equal(plates.normalize('10 835-hda'), '10835HDA');
  });
});

test('correction', async (t) => {
  await t.test('observed misreads are fixed', () => {
    const cases = {
      '05450KBA': '85450KBA', '55450KBA': '85450KBA', '65159YAA': '85159YAA',
      '81304RAA': '85304RAA', '05304RAA': '85304RAA', '8594DBA': '85942DBA',
      '304RAA': '85304RAA', '1964DDA': '10964DDA', '01M39': '01M393YA',
      '10835HD': '10835HDA', '10865': '10865HDA',
    };
    for (const [raw, want] of Object.entries(cases)) assert.equal(plates.correct(raw, KNOWN), want, raw);
  });
  await t.test('valid fleet plates are never merged', () => {
    // Three real, different trucks one or two characters apart.
    for (const p of ['10835HDA', '10863HDA', '10872HDA']) assert.equal(plates.correct(p, KNOWN), p);
  });
  await t.test('ambiguous read is left alone', () => {
    // Equally close to 10863HDA and 10865HDA.
    assert.equal(plates.correct('10864HD', KNOWN), '10864HD');
  });
  await t.test('unrelated read is left alone', () => {
    assert.equal(plates.correct('8711AO', KNOWN), '8711AO');
  });
  await t.test('distance', () => {
    assert.equal(plates.distance('kitten', 'sitting'), 3);
    assert.equal(plates.distance('', 'abc'), 3);
  });
});
