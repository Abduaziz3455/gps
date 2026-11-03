'use strict';
// Restarts, first run, production settings, no GPS or NVR configured, the shell tool, and losing the connection.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const base = require('@playwright/test');
const { browserFixtures, expect } = require('../support/fixtures');
const { TestServer, sandboxApp, baseEnv, sleep } = require('../support/server');
const { Api } = require('../support/api');
const seed = require('../support/seed');

const test = base.test.extend({
  ...browserFixtures,
  server: async ({}, use) => {
    const s = new TestServer({ name: `life${process.pid}${Date.now()}`, env: { CAMERA_BACKFILL_DAYS: '0' } }).seedFrom(process.env.E2E_TEMPLATE_DIR);
    await s.start();
    await use(s);
    await s.destroy();
  },
});
const login = async (s, u = 'owner', p = 'owner12345') => { const a = new Api(s.url); const r = await a.login(u, p); expect(r.status).toBe(200); return a; };

test.describe('restart', () => {
  test('users, sessions, edits and history survive; nothing is duplicated', async ({ server: s }) => {
    const a = await login(s);
    await a.patch(`/api/vehicles/${seed.FLEET.fuel}`, { display: 'Saqlangan' });
    await a.post('/api/users', { username: 'kept.user', role: 'dispatcher', password: 'password-1' });
    const count = () => ({ gate: s.get('SELECT COUNT(*) n FROM gate_events').n, users: s.get('SELECT COUNT(*) n FROM users').n });
    const before = count();
    await s.restart();
    expect((await a.get('/api/me')).status, 'still signed in').toBe(200);
    expect((await a.get('/api/vehicles')).data.find((v) => v.id === seed.FLEET.fuel).label).toBe('Saqlangan');
    expect((await new Api(s.url).login('kept.user', 'password-1')).status).toBe(200);
    expect(count().users).toBe(before.users);
    expect(s.get('SELECT COUNT(*) n FROM gate_events').n).toBeGreaterThanOrEqual(before.gate);
    expect(s.get('SELECT COUNT(*) n FROM (SELECT capture_name FROM gate_events GROUP BY capture_name HAVING COUNT(*) > 1)').n).toBe(0);
  });

  test('the map isn\'t empty right after a restart: last positions are restored', async ({ server: s }) => {
    const a = await login(s);
    await expect.poll(() => s.kv('live_snapshot')?.length || 0, { timeout: 90_000 }).toBeGreaterThan(0);
    await s.restart();
    const located = (await a.get('/api/vehicles')).data.filter((v) => v.lat != null);
    expect(located.length).toBeGreaterThan(0);
  });

  test('push keys and photo-link secret stay the same (phones stay subscribed)', async ({ server: s }) => {
    const vapid = s.kv('vapid').publicKey, secret = s.kv('image_secret');
    await s.restart();
    expect(s.kv('vapid').publicKey).toBe(vapid);
    expect(s.kv('image_secret')).toBe(secret);
    const a = await login(s);
    expect((await a.get('/api/me')).data.pushKey).toBe(vapid);
  });

  test('being down reports itself on return, with the period', async ({ server: s }) => {
    const a = await login(s);
    await s.stop();
    s.run("INSERT INTO kv (k, v) VALUES ('alive_at', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", String(Date.now() - 12 * 60e3));
    await s.start();
    const alerts = (await a.get('/api/alerts?type=system&limit=20')).data;
    const down = alerts.find((x) => x.data?.problem === 'server_down');
    expect(down, 'an outage alert').toBeTruthy();
    expect(down.title).toBe('Dispatcher tizimi ishlamay qoldi');
    expect(down.body).toContain('12 daqiqa');
  });

  test('a short restart isn\'t reported', async ({ server: s }) => {
    const a = await login(s);
    await s.restart();
    expect((await a.get('/api/alerts?type=system&limit=20')).data.filter((x) => x.data?.problem === 'server_down')).toEqual([]);
  });

  test('a port already in use: a clear failure, not a hang', async ({ server: s }) => {
    const other = new TestServer({ name: `busy${Date.now()}`, env: { CAMERA_BACKFILL_DAYS: '0' } }).seedFrom(process.env.E2E_TEMPLATE_DIR);
    other.port = s.port;
    await other.start({ waitReady: false });
    await expect.poll(() => other.exitCode !== undefined, { timeout: 20_000, message: 'a second server on the same port should exit' }).toBe(true);
    expect(other.log).toMatch(/EADDRINUSE/);
    await other.destroy();
  });
});

test.describe('first run', () => {
  test('owner from the environment is created once; changing the variable later doesn\'t reset them', async () => {
    const env = { MOCK: '', OWNER_USERNAME: 'first.owner', OWNER_PASSWORD: 'first-password-1', INTERNET_PROBES: '127.0.0.1:9' };
    const s = new TestServer({ name: `first${Date.now()}`, mock: false, env });
    await s.start();
    try {
      await login(s, 'first.owner', 'first-password-1');
      expect(s.get('SELECT COUNT(*) n FROM users').n).toBe(1);
      await s.stop();
      s.extraEnv = { ...env, OWNER_PASSWORD: 'changed-password-2' };
      await s.start();
      expect((await new Api(s.url).login('first.owner', 'changed-password-2')).status).toBe(401);
      await login(s, 'first.owner', 'first-password-1');
    } finally { await s.destroy(); }
  });

  test('no owner configured: starts, warns, nobody can log in', async () => {
    const s = new TestServer({ name: `noowner${Date.now()}`, mock: false });
    await s.start();
    try {
      expect(s.log).toContain('No users yet');
      expect((await new Api(s.url).login('admin', 'admin')).status).toBe(401);
      expect((await new Api(s.url).login('owner', 'owner12345')).status, 'demo accounts exist only in MOCK mode').toBe(401);
    } finally { await s.destroy(); }
  });

  test('a too-short owner password: refuses clearly', async () => {
    const s = new TestServer({ name: `weak${Date.now()}`, mock: false, env: { OWNER_USERNAME: 'x.owner', OWNER_PASSWORD: 'short' } });
    await s.start({ waitReady: false });
    await expect.poll(() => s.exitCode !== undefined || /kamida 8/.test(s.log), { timeout: 15_000 }).toBe(true);
    await s.destroy();
  });
});

test.describe('production settings', () => {
  test('Secure cookie, HSTS, and the configured origin accepted', async () => {
    const s = new TestServer({ name: `prod${Date.now()}`, env: { NODE_ENV: 'production', CAMERA_BACKFILL_DAYS: '0', PUBLIC_ORIGIN: 'https://tbbdispatcher.example' } }).seedFrom(process.env.E2E_TEMPLATE_DIR);
    await s.start();
    try {
      const a = new Api(s.url);
      const r = await a.login('owner', 'owner12345');
      expect(r.setCookie[0]).toContain('Secure');
      expect((await a.get('/')).headers.get('strict-transport-security')).toContain('max-age=31536000');
      expect((await a.post('/api/push/status', {}, { headers: { origin: 'https://tbbdispatcher.example' } })).status).toBe(200);
      expect((await a.post('/api/push/status', {}, { headers: { origin: 'https://other.example' } })).status).toBe(403);
    } finally { await s.destroy(); }
  });

  test('behind nginx: the login throttle sees the visitor\'s address, not the proxy\'s', async ({ server: s }) => {
    const c = new Api(s.url, { ip: '203.0.113.7' });
    for (let i = 0; i < 8; i++) await c.login('owner', 'wrong-password');
    expect((await c.login('owner', 'owner12345')).status).toBe(429);
    expect((await new Api(s.url, { ip: '203.0.113.8' }).login('owner', 'owner12345')).status).toBe(200);
    const hash = s.get("SELECT ip FROM sessions WHERE ip = '203.0.113.8'");
    expect(hash.ip).toBe('203.0.113.8');
  });
});

test.describe('no GPS and no NVR configured', () => {
  let s, a;
  test.beforeAll(async () => {
    s = new TestServer({ name: `bare${process.pid}`, mock: false, env: { OWNER_USERNAME: 'bare.owner', OWNER_PASSWORD: 'bare-password-1' } });
    await s.start();
    a = await login(s, 'bare.owner', 'bare-password-1');
  });
  test.afterAll(async () => { await s.destroy(); });

  test('says so at start and in /api/me', async () => {
    expect(s.log).toContain('live map and GPS analytics are off');
    expect(s.log).toContain('gate cameras are off');
    expect((await a.get('/api/me')).data).toMatchObject({ gps: false, cameras: false, mock: false });
    expect((await a.get('/health')).data).toMatchObject({ gps: null, nvr: null });
  });

  for (const [u, code] of [
    ['/api/vehicles', 200], ['/api/vehicles/all', 200], ['/api/yard', 200], ['/api/today', 200], ['/api/gate-events', 200], ['/api/alerts', 200],
    ['/api/analytics/overview', 200], ['/api/analytics/series', 200], ['/api/analytics/vehicles', 200], ['/api/reports/vehicles', 200], ['/api/health', 200], ['/api/system', 200],
    ['/api/gate-events/1', 404], ['/api/gate-events/1/photo/0', 404], ['/api/vehicles/1/stops', 503], ['/api/vehicles/1/track', 200],
  ]) {
    test(`GET ${u}: ${code}`, async () => { expect((await a.get(u)).status).toBe(code); });
  }

  test('recompute does nothing, without an error', async () => {
    expect((await a.post('/api/analytics/recompute', {})).status).toBe(200);
  });

  test('events kept from when cameras were on: can be read and corrected', async () => {
    const id = seed.gateEvent(s, { t: Date.now() - 1000, plate: '01A123BC', status: 'outside' });
    const list = (await a.get('/api/gate-events')).data;
    expect(list.some((e) => e.id === id), 'in the list').toBe(true);
    expect((await a.get(`/api/gate-events/${id}`)).status, 'and its detail').toBe(200);
    expect((await a.patch(`/api/gate-events/${id}`, { hidden: true })).status, 'and it can be hidden').toBe(200);
    s.run('DELETE FROM gate_events WHERE id = ?', id);
  });

  test('the app opens on every page, empty but honest', async ({ page, context }) => {
    await context.addCookies([{ name: 'tbb_session', value: a.token, url: s.url }]);
    await page.goto(`${s.url}/#/xarita`);
    await expect(page.locator('#vlist .empty')).toHaveText('Transport topilmadi');
    await expect(page.locator('#healthBox')).toBeVisible();
    for (const [h, sel, txt] of [['darvoza', '#feed .empty', "hodisa yo'q"], ['hisobot', '#repTable .empty', "ma'lumot yo'q"], ['sozlamalar?tab=tizim', '#setPanel', '.env faylida sozlanmagan'], ['tahlil', '#anChart .empty', "ma'lumot yo'q"], ['transport', '#main', 'Transportni tanlang']]) {
      await page.evaluate((x) => { location.hash = `#/${x}`; }, h);
      await expect(page.locator(sel).first(), h).toContainText(txt);
    }
  });
});

test.describe('shell tool: npm run user', () => {
  let dataDir;
  test.beforeAll(() => {
    const s = new TestServer({ name: `cli${process.pid}`, mock: false });
    dataDir = s.dataDir;
  });
  const cli = (args, extra = {}) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join('scripts', 'user.js'), ...args], {
    cwd: sandboxApp(), encoding: 'utf8', env: { ...baseEnv(), DATA_DIR: dataDir, ...extra }, timeout: 20_000,
  });

  test('add, list, password, disable, enable', () => {
    const add = cli(['add', 'ali.v', 'dispatcher', 'Ali', 'Valiyev'], { NEW_PASSWORD: 'cli-password-1' });
    expect(add.status, add.stderr).toBe(0);
    expect(add.stdout).toContain('Created ali.v (dispatcher)');
    expect(add.stdout).not.toContain('cli-password-1');
    const list = cli(['list']);
    expect(list.stdout).toMatch(/ali\.v\s+dispatcher\s+active\s+Ali Valiyev/);
    expect(cli(['password', 'ali.v'], { NEW_PASSWORD: 'cli-password-2' }).status).toBe(0);
    expect(cli(['disable', 'ali.v']).stdout).toContain('disabled');
    expect(cli(['list']).stdout).toMatch(/ali\.v\s+dispatcher\s+DISABLED/);
    expect(cli(['enable', 'ali.v']).stdout).toContain('enabled');
  });

  test('refusals: bad input, unknown user, unknown command', () => {
    expect(cli(['add', 'x y', 'dispatcher'], { NEW_PASSWORD: 'cli-password-1' }).status).toBe(1);
    expect(cli(['add', 'okname', 'admin'], { NEW_PASSWORD: 'cli-password-1' }).status).toBe(1);
    expect(cli(['add', 'okname2', 'owner'], { NEW_PASSWORD: 'short' }).status).toBe(1);
    expect(cli(['password', 'nobody'], { NEW_PASSWORD: 'cli-password-1' }).status).toBe(1);
    expect(cli(['disable', 'nobody']).status).toBe(1);
    expect(cli(['nonsense']).status).toBe(1);
    expect(cli([]).status).toBe(0);
  });

  test('the last owner can\'t be disabled from the shell either', () => {
    expect(cli(['add', 'only.owner', 'owner', 'Boss'], { NEW_PASSWORD: 'cli-password-1' }).status).toBe(0);
    const r = cli(['disable', 'only.owner']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('rahbar');
  });
});

test.describe('losing the connection', () => {
  const open = async (page, context, s, hash = 'hisobot') => {
    const a = await login(s);
    await context.addCookies([{ name: 'tbb_session', value: a.token, url: s.url }]);
    await page.goto(`${s.url}/#/${hash}`);
    await expect(page.locator('#app')).toBeVisible();
    await expect(page.locator('#healthBox .dot').first()).toBeVisible();
  };

  test('this device offline: says so; back online: clears', async ({ page, context, server: s }) => {
    await open(page, context, s);
    await context.setOffline(true);
    await expect(page.locator('#sysBanner')).toContainText("Qurilmangizda internet yo'q");
    await context.setOffline(false);
    await expect(page.locator('#sysBanner')).toBeHidden({ timeout: 20_000 });
  });

  test('server gone: the banner tells it apart from the device, and it recovers by itself', async ({ page, context, server: s }) => {
    test.setTimeout(120_000);
    test.info().annotations.push({ type: 'allow-errors' });
    await open(page, context, s);
    await s.stop();
    await expect(page.locator('#healthBox')).toBeVisible();
    await expect(page.locator('#sysBanner')).toContainText("Dispatcher serveri bilan aloqa yo'q", { timeout: 40_000 });
    await s.start();
    await expect(page.locator('#sysBanner')).toBeHidden({ timeout: 45_000 });
    await expect(page.locator('#healthBox .dot.bad')).toHaveCount(0);
    const stamp = async () => page.evaluate(async () => { const { state } = await import('/js/api.js'); return Math.max(...[...state.vehicles.values()].map((v) => v.recordTime || 0)); });
    const t0 = await stamp();
    await expect.poll(stamp, { timeout: 30_000, message: 'live data flows again' }).toBeGreaterThan(t0);
  });

  test('a request failing while offline: a message, not a dead page', async ({ page, context, server: s }) => {
    await open(page, context, s, 'hisobot');
    await expect(page.locator('#repTable table')).toBeVisible();
    await context.setOffline(true);
    await page.click('[data-p=yesterday]');
    await expect(page.locator('.toast.bad')).toContainText("Server bilan aloqa yo'q");
    await expect(page.locator('#repTable')).not.toHaveClass(/is-loading/);
    await context.setOffline(false);
    await sleep(100);
    await page.click('[data-p=today]');
    await expect(page.locator('#repTable table')).toBeVisible();
  });
});

test.describe('alert rules, live', () => {
  test('speeding is raised from real polls, once per incident', async () => {
    test.setTimeout(150_000);
    const s = new TestServer({ name: `speed${Date.now()}`, env: { SPEED_LIMIT_KMH: '10', GPS_POLL_SECONDS: '2', CAMERA_BACKFILL_DAYS: '0' } }).seedFrom(process.env.E2E_TEMPLATE_DIR);
    s.run("DELETE FROM alerts WHERE type = 'speeding'");
    await s.start();
    try {
      const a = await login(s);
      const moving = (await a.get('/api/vehicles')).data.filter((v) => v.status === 'moving').length;
      test.skip(!moving && !(await new Promise((r) => setTimeout(async () => r((await a.get('/api/vehicles')).data.some((v) => v.status === 'moving')), 8000))), 'no simulated truck is moving at this hour');
      await expect.poll(async () => (await a.get('/api/alerts?type=speeding')).data.length, { timeout: 60_000 }).toBeGreaterThan(0);
      const rows = (await a.get('/api/alerts?type=speeding')).data;
      expect(rows[0].title).toContain('Tezlik oshirildi');
      expect(rows[0].body).toContain('chegara 10');
      expect(rows[0].vehicleLabel).toBeTruthy();
      const ids = rows.map((r) => r.vehicleId);
      expect(new Set(ids).size, 'one per vehicle in the half-hour window').toBe(ids.length);
    } finally { await s.destroy(); }
  });

  test('no signal: raised for a vehicle that worked this week, not for one long dead', async () => {
    test.setTimeout(120_000);
    const s = new TestServer({ name: `sig${Date.now()}`, env: { GPS_POLL_SECONDS: '2', CAMERA_BACKFILL_DAYS: '0' } }).seedFrom(process.env.E2E_TEMPLATE_DIR);
    // The silent tracker counts as active only if it drove in the last 7 days.
    seed.stats(s, seed.addDays(seed.tashkentDay(), -1), seed.FLEET.dead, { km: 50 });
    s.run("DELETE FROM alerts WHERE type = 'no_signal'");
    await s.start();
    try {
      const a = await login(s);
      await expect.poll(async () => (await a.get('/api/alerts?type=no_signal')).data.length, { timeout: 60_000, message: 'rules run after 30 s' }).toBeGreaterThan(0);
      const rows = (await a.get('/api/alerts?type=no_signal')).data;
      expect(rows.map((r) => r.vehicleId)).toEqual([seed.FLEET.dead]);
      expect(rows[0].title).toContain("GPS signal yo'q");
    } finally { await s.destroy(); }
  });

  test('fuel drains become critical alerts, and show on the vehicle', async () => {
    test.setTimeout(120_000);
    const s = new TestServer({ name: `fuel${Date.now()}`, env: { GPS_POLL_SECONDS: '5', CAMERA_BACKFILL_DAYS: '0' } }).seedFrom(process.env.E2E_TEMPLATE_DIR);
    await s.start();
    try {
      const a = await login(s);
      const row = s.get("SELECT vehicle_id, t, litres FROM fuel_events WHERE kind = 'drain' ORDER BY t DESC LIMIT 1");
      test.skip(!row, 'the simulator produced no drain this month');
      const alerts = (await a.get('/api/alerts?type=fuel_drain&limit=100')).data;
      const hit = alerts.find((x) => x.vehicleId === row.vehicle_id && x.t === row.t);
      expect(hit, 'a drain in fuel_events has its alert').toBeTruthy();
      expect(hit.severity).toBe('critical');
      expect(hit.title).toContain("Yoqilg'i to'kildi");
    } finally { await s.destroy(); }
  });
});
