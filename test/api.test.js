'use strict';
// API: login/session cookie, role checks, CSRF origin check, login throttling, push subscription validation,
// analytics on rolled-up data.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const config = require('../src/config');
const { open, helpers } = require('../src/db');
const { Auth } = require('../src/auth');
const { Analytics } = require('../src/analytics');
const { Rules } = require('../src/rules');
const { Push } = require('../src/push');
const { buildApi, apiHandler } = require('../src/api');
const T = require('../src/time');

async function server() {
  const db = open(':memory:');
  const h = helpers(db);
  const auth = new Auth({ h, config });
  auth.createUser({ username: 'boss', name: 'Boss', role: 'owner', password: 'owner-pass-1' });
  auth.createUser({ username: 'disp', name: 'Disp', role: 'dispatcher', password: 'disp-pass-1' });
  h.run('INSERT INTO vehicles (id, name, updated_at) VALUES (1, ?, 0), (2, ?, 0)', '85 450 KBA', '85 159 YAA');
  const day = T.today();
  h.run(`INSERT INTO daily_stats (day, vehicle_id, km, engine_s, idle_s, trips_out, trips_in, updated_at) VALUES
    (?, 1, 100, 36000, 3600, 2, 3, 0), (?, 2, 50, 18000, 9000, 1, 1, 0)`, day, day);
  const ctx = { h, db, config, auth, gps: null, nvr: null, poller: null, gate: null, log: { error() {} } };
  ctx.analytics = new Analytics({ h, gps: null, config });
  ctx.rules = new Rules({ h, config });
  ctx.push = new Push({ h, config, sender: async () => {} });
  const handle = apiHandler(ctx, buildApi(ctx));
  const srv = http.createServer((req, res) => handle(req, res, new URL(req.url, 'http://x')));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (path, { method = 'GET', body, cookie, origin } = {}) => {
    const headers = {};
    if (body) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    if (origin) headers.origin = origin;
    const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => null), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
  };
  const login = async (u, p) => (await call('/api/auth/login', { method: 'POST', body: { username: u, password: p } })).cookie;
  return { srv, call, login, h };
}

test('auth, roles, CSRF and analytics', async (t) => {
  const { srv, call, login } = await server();
  t.after(() => srv.close());

  assert.equal((await call('/api/me')).status, 401);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'wrong-pass' } })).status, 401);

  const owner = await login('boss', 'owner-pass-1');
  const disp = await login('disp', 'disp-pass-1');
  assert.match(owner, /^tbb_session=/);
  const me = await call('/api/me', { cookie: owner });
  assert.equal(me.data.user.role, 'owner');
  assert.ok(me.data.pushKey, 'VAPID public key is exposed');
  assert.ok(!JSON.stringify(me.data).includes('password'), 'no secrets in /api/me');

  // dispatcher: no analytics, no users; owner: yes
  assert.equal((await call('/api/analytics/overview', { cookie: disp })).status, 403);
  assert.equal((await call('/api/users', { cookie: disp })).status, 403);
  const ov = await call('/api/analytics/overview', { cookie: owner });
  assert.equal(ov.status, 200);
  assert.equal(ov.data.current.km, 150);
  assert.equal(ov.data.current.trips, 4, 'trips = max(exits, entries) per vehicle-day: 3 + 1');
  assert.equal(ov.data.current.idleShare, Math.round((12600 / 54000) * 100));
  assert.equal((await call('/api/reports/vehicles', { cookie: disp })).status, 200, 'reports are for both roles');

  // CSRF: a foreign Origin is refused even with a valid cookie
  const forged = await call('/api/users', { method: 'POST', cookie: owner, origin: 'https://evil.example', body: { username: 'x', role: 'owner', password: '12345678' } });
  assert.equal(forged.status, 403);

  // user management
  const created = await call('/api/users', { method: 'POST', cookie: owner, body: { username: 'new.disp', name: 'New', role: 'dispatcher', password: 'short' } });
  assert.equal(created.status, 400, 'password policy');
  const ok = await call('/api/users', { method: 'POST', cookie: owner, body: { username: 'new.disp', name: 'New', role: 'dispatcher', password: 'long-enough-1' } });
  assert.equal(ok.status, 200);
  const users = await call('/api/users', { cookie: owner });
  const boss = users.data.find((u) => u.username === 'boss');
  const last = await call(`/api/users/${boss.id}`, { method: 'PATCH', cookie: owner, body: { role: 'dispatcher' } });
  assert.equal(last.status, 400, 'the last owner cannot be demoted');

  // disabling a user ends their sessions
  const nd = users.data.find((u) => u.username === 'new.disp');
  const ndCookie = await login('new.disp', 'long-enough-1');
  assert.equal((await call('/api/me', { cookie: ndCookie })).status, 200);
  await call(`/api/users/${nd.id}`, { method: 'PATCH', cookie: owner, body: { disabled: true } });
  assert.equal((await call('/api/me', { cookie: ndCookie })).status, 401);

  // push subscription validation
  assert.equal((await call('/api/push/subscribe', { method: 'POST', cookie: disp, body: { subscription: { endpoint: 'http://insecure' } } })).status, 400);
  const sub = { endpoint: 'https://push.example/abc', keys: { p256dh: 'BPk', auth: 'x' } };
  const s1 = await call('/api/push/subscribe', { method: 'POST', cookie: disp, body: { subscription: sub, prefs: { gateIn: false } } });
  assert.equal(s1.status, 200);
  assert.equal(s1.data.prefs.gateIn, false);
  assert.equal(s1.data.prefs.gateOut, true);

  // logout
  await call('/api/auth/logout', { method: 'POST', cookie: disp });
  assert.equal((await call('/api/me', { cookie: disp })).status, 401);
});

test('login is throttled after 8 failures from one address', async (t) => {
  const { srv, call } = await server();
  t.after(() => srv.close());
  for (let i = 0; i < 8; i++) await call('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'nope-nope' } });
  const r = await call('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'owner-pass-1' } });
  assert.equal(r.status, 429);
});

test('a vehicle removed from GoGPS stays in the list (for its history) but not in the live counts', async (t) => {
  const { srv, call, login, h } = await server();
  t.after(() => srv.close());
  h.run('UPDATE vehicles SET in_gps = 0 WHERE id = 2');
  h.run('INSERT INTO vehicles (id, name, plate, active, in_gps, camera_only, updated_at) VALUES (3, ?, ?, 1, 0, 1, 0)', '10 834 HDA', '10834HDA');
  const disp = await login('disp', 'disp-pass-1');
  const list = (await call('/api/vehicles', { cookie: disp })).data;
  assert.deepEqual(list.map((v) => [v.id, v.inGps]).sort(), [[1, true], [2, false], [3, false]]);
  const { status } = (await call('/api/today', { cookie: disp })).data;
  assert.equal(status.moving + status.idle + status.stopped + status.offline, 1);
});
