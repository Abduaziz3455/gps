'use strict';
// Rules: no speeding alert, however fast a vehicle goes (the owner asked for none).
const test = require('node:test');
const assert = require('node:assert');
const config = require('../src/config');
const { open, helpers } = require('../src/db');
const { Rules } = require('../src/rules');

test('no speeding alert, however fast and however long', () => {
  const h = helpers(open(':memory:'));
  h.run('INSERT INTO vehicles (id, name, updated_at) VALUES (1, ?, 0)', '85 001 AAA');
  const rules = new Rules({ h, config, log: { info() {}, warn() {} } });
  const t0 = Date.now();
  for (let i = 0; i < 5; i++) rules.onPositions([{ id: 1, status: 'moving', speed: 150, recordTime: t0 + i * 10e3, lat: 41.3, lng: 69.2 }]);
  assert.equal(h.get('SELECT COUNT(*) n FROM alerts').n, 0);
  assert.equal(rules.movingAt.get(1), t0 + 40e3, 'moving time is still kept for the long-stop check');
});
