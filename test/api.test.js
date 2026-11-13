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

async function server({ telegramToken = null } = {}) {
  const db = open(':memory:');
  const h = helpers(db);
  const cfg = telegramToken ? { ...config, telegram: { ...config.telegram, token: telegramToken } } : config;
  const auth = new Auth({ h, config: cfg });
  auth.createUser({ username: 'boss', name: 'Boss', role: 'owner', password: 'owner-pass-1' });
  auth.createUser({ username: 'disp', name: 'Disp', role: 'dispatcher', password: 'disp-pass-1' });
  h.run('INSERT INTO vehicles (id, name, updated_at) VALUES (1, ?, 0), (2, ?, 0)', '85 450 KBA', '85 159 YAA');
  const day = T.today();
  h.run(`INSERT INTO daily_stats (day, vehicle_id, km, engine_s, idle_s, trips_out, trips_in, updated_at) VALUES
    (?, 1, 100, 36000, 3600, 2, 3, 0), (?, 2, 50, 18000, 9000, 1, 1, 0)`, day, day);
  const ctx = { h, db, config: cfg, auth, gps: null, nvr: null, poller: null, gate: null, log: { error() {} } };
  ctx.analytics = new Analytics({ h, gps: null, config });
  ctx.rules = new Rules({ h, config });
  ctx.push = new Push({ h, config, sender: async () => {} });
  const handle = apiHandler(ctx, buildApi(ctx));
  const srv = http.createServer((req, res) => handle(req, res, new URL(req.url, 'http://x')));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (path, { method = 'GET', body, cookie, origin, ip } = {}) => {
    const headers = {};
    if (ip) headers['x-real-ip'] = ip; // as nginx sends it; trusted from 127.0.0.1 only
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

test('Telegram mini app: link once with the password, then open without it; unlink, move, disable', async (t) => {
  const { sign } = require('../src/telegram/webapp');
  const TOKEN = '123456:TEST-token';
  const { srv, call, login, h } = await server({ telegramToken: TOKEN });
  t.after(() => srv.close());
  const initData = (id, name = 'Ali') => sign({ auth_date: Math.floor(Date.now() / 1000), user: { id, first_name: name } }, TOKEN);
  const open = (data, cookie) => call('/api/auth/telegram', { method: 'POST', body: { initData: data }, cookie });
  const link = (data, username, password) => call('/api/auth/telegram/link', { method: 'POST', body: { initData: data, username, password } });

  // Not Telegram's data: refused before anything else.
  assert.equal((await open('auth_date=1&user=%7B%22id%22%3A1%7D&hash=' + 'a'.repeat(64))).status, 401);
  assert.equal((await open(sign({ auth_date: Math.floor(Date.now() / 1000), user: { id: 1 } }, '999:OTHER'))).status, 401);

  // A Telegram account nobody linked: the app asks for the login, and no session is left on this phone.
  const ali = initData(111, 'Ali');
  const first = await open(ali);
  assert.equal(first.status, 200);
  assert.deepEqual(first.data.linked, false);
  assert.equal(first.data.telegram.name, 'Ali');
  assert.equal(first.cookie, 'tbb_session=');
  assert.equal((await link(ali, 'disp', 'wrong-pass-1')).status, 401);

  // Linking with the password: a session, and the account shows it.
  const linked = await link(ali, 'disp', 'disp-pass-1');
  assert.equal(linked.status, 200);
  assert.equal(linked.data.user.username, 'disp');
  assert.deepEqual(linked.data.user.telegram, { name: 'Ali' });
  const me = await call('/api/me', { cookie: linked.cookie });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.role, 'dispatcher');
  assert.ok(!JSON.stringify(me.data).includes('111'), 'the Telegram id stays on the server');
  const s = h.get("SELECT created_at, expires_at FROM sessions WHERE via = 'telegram'");
  assert.equal(s.expires_at - s.created_at, 86400e3, 'a mini app session lasts a day');
  assert.equal((await call('/api/analytics/overview', { cookie: linked.cookie })).status, 403, 'the same role checks as the site');

  // Next time: no password. The phone's previous session is replaced.
  const again = await open(ali, linked.cookie);
  assert.equal(again.data.linked, true);
  assert.notEqual(again.cookie, linked.cookie);
  assert.equal((await call('/api/me', { cookie: linked.cookie })).status, 401);
  assert.equal((await call('/api/me', { cookie: again.cookie })).status, 200);

  // The owner sees it, and the user's own site login is independent of it.
  const owner = await login('boss', 'owner-pass-1');
  const site = await login('disp', 'disp-pass-1');
  assert.deepEqual((await call('/api/users', { cookie: owner })).data.find((u) => u.username === 'disp').telegram, { name: 'Ali' });

  // The same Telegram account linked to another user moves there: the first user's mini app sessions end.
  const moved = await link(ali, 'boss', 'owner-pass-1');
  assert.equal(moved.data.user.username, 'boss');
  assert.equal((await call('/api/me', { cookie: again.cookie })).status, 401);
  assert.equal((await call('/api/users', { cookie: owner })).data.find((u) => u.username === 'disp').telegram, null);
  assert.equal((await call('/api/me', { cookie: site })).status, 200, 'the site login is untouched');

  // A second Telegram account for the same user replaces the first.
  const vali = initData(222, 'Vali');
  await link(vali, 'boss', 'owner-pass-1');
  assert.equal((await open(ali)).data.linked, false);
  assert.equal((await open(vali)).data.linked, true);

  // The owner unlinks someone: their mini app stops opening by itself.
  const dispTg = await link(initData(333, 'D'), 'disp', 'disp-pass-1');
  const dispId = dispTg.data.user.id;
  assert.equal((await call(`/api/users/${dispId}/telegram`, { method: 'DELETE', cookie: dispTg.cookie })).status, 403, 'only the owner unlinks others');
  assert.equal((await call(`/api/users/${dispId}/telegram`, { method: 'DELETE', cookie: owner })).status, 200);
  assert.equal((await call('/api/me', { cookie: dispTg.cookie })).status, 401);
  assert.equal((await open(initData(333, 'D'))).data.linked, false);

  // A disabled user can't open it either.
  const relinked = await link(initData(333, 'D'), 'disp', 'disp-pass-1');
  await call(`/api/users/${dispId}`, { method: 'PATCH', cookie: owner, body: { disabled: true } });
  assert.equal((await open(initData(333, 'D'))).status, 403);
  assert.equal((await call('/api/me', { cookie: relinked.cookie })).status, 401);
  await call(`/api/users/${dispId}`, { method: 'PATCH', cookie: owner, body: { disabled: false } });

  // Unlinking oneself from inside the app ends that session.
  const self = await open(initData(333, 'D'));
  const out = await call('/api/me/telegram', { method: 'DELETE', cookie: self.cookie });
  assert.equal(out.status, 200);
  assert.equal(out.data.telegram, null);
  assert.equal(out.cookie, 'tbb_session=');
  assert.equal((await open(initData(333, 'D'))).data.linked, false);
});

test('Telegram mini app: linking is throttled per Telegram account, and needs a bot token', async (t) => {
  const { sign } = require('../src/telegram/webapp');
  const TOKEN = '123456:TEST-token';
  const { srv, call } = await server({ telegramToken: TOKEN });
  t.after(() => srv.close());
  const data = sign({ auth_date: Math.floor(Date.now() / 1000), user: { id: 444, first_name: 'X' } }, TOKEN);
  // Each guess from another address: the address limit never trips, the Telegram account's does.
  for (let i = 0; i < 8; i++) assert.equal((await call('/api/auth/telegram/link', { method: 'POST', ip: `10.0.0.${i + 1}`, body: { initData: data, username: 'boss', password: `guess-${i}` } })).status, 401);
  const locked = await call('/api/auth/telegram/link', { method: 'POST', ip: '10.0.0.99', body: { initData: data, username: 'boss', password: 'owner-pass-1' } });
  assert.equal(locked.status, 429, 'even the right password waits now');
  const otherAccount = sign({ auth_date: Math.floor(Date.now() / 1000), user: { id: 445, first_name: 'Y' } }, TOKEN);
  assert.equal((await call('/api/auth/telegram/link', { method: 'POST', ip: '10.0.0.99', body: { initData: otherAccount, username: 'boss', password: 'owner-pass-1' } })).status, 200, 'another account from that address is not held up');

  const plain = await server();
  t.after(() => plain.srv.close());
  assert.equal((await plain.call('/api/auth/telegram', { method: 'POST', body: { initData: data } })).status, 401, 'no bot token: no mini app login');
});
