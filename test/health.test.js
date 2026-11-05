'use strict';
// Health monitor: which link is broken (diagnosis), when it is reported, and the recovery message.
const test = require('node:test');
const assert = require('node:assert');
const config = require('../src/config');
const { open, helpers } = require('../src/db');
const { Rules } = require('../src/rules');
const { Health, diagnose, nvrErrorKind, gpsErrorKind, gpsFresh, parseHostPort } = require('../src/health');

const ok = { internet: true, gps: { ok: true }, nvr: { ok: true }, router: null, cameras: [], diskFreeBytes: 50 * 1024 ** 3, diskFreeShare: 0.5 };
const keys = (obs) => diagnose({ ...ok, ...obs }).map((p) => p.key);

test('diagnosis names the broken link', () => {
  assert.deepEqual(keys({}), []);
  // our server offline: only that, the rest can't be known
  assert.deepEqual(keys({ internet: false, gps: { ok: false, error: 'timeout' }, nvr: { ok: false, kind: 'timeout' } }), ['server_internet']);
  // GoGPS
  assert.deepEqual(keys({ gps: { ok: false, error: 'GPS login failed (HTTP 401)' } }), ['gps_auth']);
  assert.deepEqual(keys({ gps: { ok: false, error: '/api/v3/vehicles/getlastdata: timeout' } }), ['gps_down']);
  // plant side
  assert.deepEqual(keys({ nvr: { ok: false, kind: 'refused' } }), ['nvr_down'], 'router answered, NVR did not');
  assert.deepEqual(keys({ nvr: { ok: false, kind: 'timeout' }, router: true }), ['nvr_down'], 'router probe OK -> NVR');
  assert.deepEqual(keys({ nvr: { ok: false, kind: 'timeout' }, router: false }), ['site_internet'], 'router silent -> plant internet');
  assert.deepEqual(keys({ nvr: { ok: false, kind: 'timeout' } }), ['site_unreachable'], 'no router probe: say both');
  assert.deepEqual(keys({ nvr: { ok: false, kind: 'auth' } }), ['nvr_auth']);
  assert.deepEqual(keys({ nvr: { ok: false, kind: 'http', status: 500 } }), ['nvr_error']);
  // cameras (only judged while the NVR answers)
  const cams = [{ channel: 4, name: 'ANPR-1', role: 'kirish', anpr: true, offline: true }, { channel: 3, name: 'ANPR-2', role: 'chiqish', anpr: true, silent: { crossings: 6 } }];
  assert.deepEqual(keys({ cameras: cams }), ['camera_offline:4', 'camera_silent:3']);
  assert.deepEqual(keys({ cameras: cams, nvr: { ok: false, kind: 'refused' } }), ['nvr_down']);
  assert.deepEqual(keys({ diskFreeBytes: 0.5 * 1024 ** 3, diskFreeShare: 0.01 }), ['disk_low']);
  const silent = diagnose({ ...ok, cameras: [cams[1]] })[0];
  assert.match(silent.text, /6 ta mashina chiqdi/);
});

test('error classification', () => {
  assert.equal(nvrErrorKind(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), 'refused');
  assert.equal(nvrErrorKind(new Error('NVR GET /ISAPI/System/deviceInfo: timed out after 10000 ms')), 'timeout');
  assert.equal(nvrErrorKind(Object.assign(new Error('x'), { status: 401 })), 'auth');
  assert.equal(nvrErrorKind(Object.assign(new Error('x'), { code: 'EHOSTUNREACH' })), 'unreachable');
  assert.equal(gpsErrorKind('/api/v3/auth/login: not authorized'), 'auth');
  assert.deepEqual(parseHostPort('http://87.192.249.151:8008/'), { host: '87.192.249.151', port: 8008 });
});

test('a blip is not an alarm; an outage is reported once, then its recovery with the period', async () => {
  const h = helpers(open(':memory:'));
  const rules = new Rules({ h, config });
  const health = new Health({ h, config, rules, log: {} });
  let obs = { ...ok };
  health.observe = async (now) => ({ ...obs, at: now, nvr: { ...obs.nvr, lastOk: obs.nvr.ok ? now : T0 - 30e3 } });
  const T0 = Date.parse('2026-11-03T05:00:00Z'); // 10:00 local
  const at = (min) => T0 + min * 60e3;
  const alerts = () => h.all('SELECT title, body, severity FROM alerts ORDER BY id');

  obs = { ...ok, nvr: { ok: false, kind: 'timeout' }, router: false };
  await health.check(at(0));
  obs = { ...ok };
  await health.check(at(1));
  await health.check(at(2));
  assert.equal(alerts().length, 0, 'one failed check is a blip');

  obs = { ...ok, nvr: { ok: false, kind: 'timeout' }, router: false };
  for (let m = 3; m <= 6; m++) await health.check(at(m));
  assert.equal(alerts().length, 1);
  assert.equal(alerts()[0].title, "Zavodda internet yo'q");
  assert.match(alerts()[0].body, /09:59 dan beri/, 'counted from the last successful contact');
  assert.equal(health.summary(at(6)).problems.length, 1);

  obs = { ...ok };
  await health.check(at(7));
  assert.equal(alerts().length, 1, 'one good check is not a recovery yet');
  await health.check(at(8));
  const rec = alerts()[1];
  assert.equal(rec.severity, 'info');
  assert.match(rec.title, /Tiklandi: Zavod interneti/);
  assert.match(rec.body, /09:59–10:07 \(8 daqiqa\)/);
  assert.equal(health.summary(at(8)).problems.length, 0);
  assert.equal(h.get('SELECT COUNT(*) n FROM alerts WHERE acked_at IS NULL').n, 0, 'recovery closes the outage alert');
});

test('our own downtime is reported after a restart', () => {
  const h = helpers(open(':memory:'));
  const rules = new Rules({ h, config });
  const health = new Health({ h, config, rules, log: {} });
  const t = Date.parse('2026-11-03T05:00:00Z');
  h.kvSet('alive_at', t);
  health.checkOwnDowntime(t + 60e3);
  assert.equal(h.get('SELECT COUNT(*) n FROM alerts').n, 0, 'a quick restart is not an outage');
  h.kvSet('alive_at', t);
  health.checkOwnDowntime(t + 20 * 60e3);
  const a = h.get('SELECT * FROM alerts');
  assert.equal(a.title, 'Dispatcher tizimi ishlamay qoldi');
  assert.match(a.body, /10:00 dan 10:20 gacha \(20 daqiqa\)/);
});

test('gpsFresh: GoGPS answered lately; never answered, or silent for three polls and a minute, is not fresh', () => {
  const now = 1_000_000;
  assert.equal(gpsFresh(0, 10, now), false, 'no answer since the start');
  assert.equal(gpsFresh(now - 89_000, 10, now), true);
  assert.equal(gpsFresh(now - 90_000, 10, now), false);
  assert.equal(gpsFresh(now - 200_000, 60, now), true, 'a slower poll gets more time');
  assert.equal(gpsFresh(now - 240_000, 60, now), false);
});
