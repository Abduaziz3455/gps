'use strict';
// Web Push: per-device preferences, quiet hours, dead subscriptions removed, signed image URLs.
const test = require('node:test');
const assert = require('node:assert');
const config = require('../src/config');
const { open, helpers } = require('../src/db');
const { Auth } = require('../src/auth');
const { Push, inQuiet } = require('../src/push');
const bus = require('../src/bus');

test('gate notifications follow each device\'s preferences', async () => {
  const h = helpers(open(':memory:'));
  const auth = new Auth({ h, config });
  const u = auth.createUser({ username: 'disp', name: 'D', role: 'dispatcher', password: 'disp-pass-1' });
  const sent = [];
  const push = new Push({ h, config, sender: async (sub, body) => {
    if (sub.endpoint.endsWith('/gone')) { const e = new Error('gone'); e.statusCode = 410; throw e; }
    sent.push([sub.endpoint, JSON.parse(body)]);
  } });
  const sub = (name, prefs) => push.subscribe(u, { endpoint: `https://push.example/${name}`, keys: { p256dh: 'k', auth: 'a' } }, prefs, 'test');
  sub('all', {});
  sub('exits-only', { gateIn: false });
  sub('fleet-only', { onlyFleet: true });
  sub('gone', {});
  push.start();
  const ev = { id: 7, t: Date.now(), direction: 'in', camera: 'ANPR-1', plateText: '01 A 123 BC', plateValid: true, vehicleId: null, photos: [{}], status: 'outside' };
  bus.emit('gate:notify', ev);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(sent.map((s) => s[0]).sort(), ['https://push.example/all']);
  const payload = sent[0][1];
  assert.match(payload.title, /KIRDI · 01 A 123 BC/);
  assert.match(payload.image, /^\/api\/push-image\/7\?exp=\d+&sig=/);
  const url = new URL(payload.image, 'http://x');
  assert.ok(push.checkImage(7, url.searchParams.get('exp'), url.searchParams.get('sig')));
  assert.ok(!push.checkImage(8, url.searchParams.get('exp'), url.searchParams.get('sig')), 'signature is per event');
  assert.equal(h.get("SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint LIKE '%/gone'").n, 0, '410 removes the subscription');
});

test('quiet hours, including over midnight', () => {
  const at = (hhmm) => Date.parse(`2026-11-03T${hhmm}:00+05:00`);
  assert.ok(inQuiet({ quietFrom: '22:00', quietTo: '07:00' }, at('23:30')));
  assert.ok(inQuiet({ quietFrom: '22:00', quietTo: '07:00' }, at('06:59')));
  assert.ok(!inQuiet({ quietFrom: '22:00', quietTo: '07:00' }, at('07:00')));
  assert.ok(inQuiet({ quietFrom: '13:00', quietTo: '14:00' }, at('13:30')));
  assert.ok(!inQuiet({ quietFrom: '', quietTo: '' }, at('13:30')));
});
