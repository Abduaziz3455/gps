'use strict';
/**
 * The real GoGPS and the real NVR (credentials from .env), through one local server with a throwaway database.
 * Only reads from those systems. Pushes can't reach anybody: the temp database has no subscriptions.
 *
 * Cameras: from a machine the plant router lets through (the production server), the camera tests run. Elsewhere
 * the NVR is unreachable, and the app's behaviour in exactly that situation is tested instead.
 */
const base = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { browserFixtures } = require('../support/fixtures');
const { TestServer, sleep } = require('../support/server');
const { Api, openStream } = require('../support/api');
const { readDotEnv, secretsOf } = require('../support/real-env');
const seed = require('../support/seed');

const expect = base.expect;
const NVR_OK = process.env.E2E_NVR_REACHABLE === '1';
const SHOTS = path.resolve(__dirname, '../.output/screenshots');
const OWNER = { username: process.env.E2E_REAL_USER, password: process.env.E2E_REAL_PASS };

/** Attaches to the server global-setup started, rather than starting one per worker. */
function attach() {
  const s = new TestServer({ name: 'real-attached', mock: false, dataDir: process.env.E2E_REAL_DATA });
  s.port = Number(process.env.E2E_REAL_PORT);
  return s;
}

const test = base.test.extend({
  server: [async ({}, use) => { await use(attach()); }, { scope: 'worker' }],
  baseURL: async ({ server }, use) => { await use(server.url); },
  owner: async ({ server }, use) => {
    const a = new Api(server.url);
    const r = await a.login(OWNER.username, OWNER.password);
    expect(r.status, 'test owner login').toBe(200);
    await use(a);
  },
  ...browserFixtures,
});

async function waitFor(fn, { ms = 120_000, every = 2000, what = 'condition' } = {}) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(every);
  }
  throw new Error(`timed out after ${ms} ms waiting for ${what}`);
}
const today = () => seed.tashkentDay();
const serverLog = () => { try { return fs.readFileSync(process.env.E2E_SERVER_LOG, 'utf8'); } catch { return ''; } };
const liveVehicles = async (owner) => (await owner.get('/api/vehicles')).data;
const withCoords = (list) => list.filter((v) => v.lat != null);

test.describe('GoGPS, real account', () => {
  test('connects and loads the fleet', async ({ owner }) => {
    const h = await waitFor(async () => { const r = (await owner.get('/api/health')).data; return r.gps?.lastOk ? r : null; }, { what: 'the first successful GoGPS poll' });
    expect(h.gps.error).toBeNull();
    const all = (await owner.get('/api/vehicles/all')).data;
    expect(all.length, 'fleet size in the GoGPS account').toBeGreaterThan(0);
    test.info().annotations.push({ type: 'fleet', description: `${all.length} vehicles` });
  });

  test('positions are plausible: Uzbekistan, valid status, not from the future', async ({ owner }) => {
    await waitFor(async () => withCoords(await liveVehicles(owner)).length > 0, { what: 'live positions' });
    const list = await liveVehicles(owner);
    const now = Date.now();
    for (const v of withCoords(list)) {
      expect(v.lat, `${v.label} lat`).toBeGreaterThan(37);
      expect(v.lat, `${v.label} lat`).toBeLessThan(46);
      expect(v.lng, `${v.label} lng`).toBeGreaterThan(55);
      expect(v.lng, `${v.label} lng`).toBeLessThan(74);
      expect(['moving', 'idle', 'stopped', 'offline']).toContain(v.status);
      expect(v.speed).toBeGreaterThanOrEqual(0);
      // A wrong timezone in parsing would put records 5 h ahead of or behind the clock.
      if (v.recordTime) expect(v.recordTime, `${v.label}: record time ahead of the clock`).toBeLessThan(now + 5 * 60e3);
    }
  });

  test('a vehicle counted as live has a recent record; an old record means "offline"', async ({ owner }) => {
    const list = await liveVehicles(owner);
    const offMs = 30 * 60e3;
    for (const v of withCoords(list)) {
      if (!v.recordTime) continue;
      const age = Date.now() - v.recordTime;
      if (age > offMs + 60e3) expect(v.status, `${v.label}: no record for ${Math.round(age / 60e3)} min`).toBe('offline');
    }
    const fresh = list.filter((v) => v.recordTime && Date.now() - v.recordTime < offMs);
    expect(fresh.length, 'at least some trackers report').toBeGreaterThan(0);
  });

  test('live stream delivers real position updates', async ({ owner, server }) => {
    const st = openStream(server.url, owner.cookie);
    await st.ready;
    try {
      expect(st.state.status).toBe(200);
      const e = await st.next('positions', { timeoutMs: 90_000 });
      expect(e.data.length).toBeGreaterThan(0);
      expect(e.data[0]).toHaveProperty('label');
      expect(e.data[0]).toHaveProperty('lat');
    } finally { st.close(); }
  });

  test('samples are stored, and the track endpoint returns them in order within the day', async ({ owner, server }) => {
    await waitFor(() => server.get('SELECT COUNT(*) n FROM positions').n > 0, { what: 'stored positions' });
    const best = server.get('SELECT vehicle_id id, COUNT(*) n FROM positions GROUP BY vehicle_id ORDER BY n DESC LIMIT 1');
    const day = today();
    const tr = (await owner.get(`/api/vehicles/${best.id}/track?day=${day}`)).data;
    expect(tr.day).toBe(day);
    expect(tr.points.length).toBeGreaterThan(0);
    const start = seed.dayStart(day);
    let prev = 0;
    for (const [t, lat, lng] of tr.points) {
      expect(t).toBeGreaterThanOrEqual(prev);
      expect(t).toBeGreaterThanOrEqual(start);
      expect(t).toBeLessThan(start + 86400e3);
      expect(Math.abs(lat)).toBeGreaterThan(0);
      expect(Math.abs(lng)).toBeGreaterThan(0);
      prev = t;
    }
  });

  test('the moves-and-stops report parses: times are inside the day and durations make sense', async ({ owner }) => {
    const list = await liveVehicles(owner);
    const v = list.find((x) => x.status === 'moving') || list.find((x) => x.status !== 'offline') || list[0];
    const day = today();
    const r = await owner.get(`/api/vehicles/${v.id}/stops?day=${day}`);
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    const start = seed.dayStart(day);
    for (const m of r.data.moves) {
      expect(m.start, 'move start parsed').not.toBeNull();
      expect(m.start).toBeGreaterThanOrEqual(start - 3600e3);
      expect(m.start).toBeLessThan(Date.now() + 5 * 60e3);
      expect(m.km).toBeGreaterThanOrEqual(0);
    }
    for (const s of r.data.stops) {
      expect(s.start, 'stop start parsed').not.toBeNull();
      expect(s.duration).toBeGreaterThanOrEqual(0);
    }
  });

  // GoGPS takes 45-55 s per day (three reports), so 30 days is about 25 minutes. The oldest days come first.
  const importedDays = (server) => server.all('SELECT day, SUM(km) km FROM daily_stats WHERE updated_at > 0 GROUP BY day HAVING SUM(km) > 0 ORDER BY day').map((r) => r.day);

  test('daily reports import from GoGPS, and the totals are plausible', async ({ owner, server }) => {
    test.setTimeout(300_000);
    await waitFor(() => importedDays(server).length >= 2, { ms: 280_000, every: 5000, what: 'two days of GoGPS reports' });
    expect(serverLog()).not.toContain('rollup failed');
    const days = importedDays(server);
    const from = days[0], to = days[days.length - 1];
    const cur = (await owner.get(`/api/analytics/overview?from=${from}&to=${to}`)).data.current;
    expect(cur.km, 'km over the imported days').toBeGreaterThan(0);
    expect(cur.engineHours).toBeGreaterThan(0);
    if (cur.idleShare != null) { expect(cur.idleShare).toBeGreaterThanOrEqual(0); expect(cur.idleShare).toBeLessThanOrEqual(100); }
    expect(cur.utilization).toBeGreaterThanOrEqual(0);
    expect(cur.utilization).toBeLessThanOrEqual(100);
    if (cur.fuelPer100 != null) { expect(cur.fuelPer100, 'L/100 km').toBeGreaterThan(0); expect(cur.fuelPer100).toBeLessThan(300); }
    for (const r of server.all('SELECT vehicle_id, day, km FROM daily_stats WHERE km > 1500')) throw new Error(`implausible day: vehicle ${r.vehicle_id} on ${r.day}: ${r.km} km`);
    for (const r of server.all('SELECT vehicle_id, day, engine_s FROM daily_stats WHERE engine_s > 90000')) throw new Error(`implausible day: vehicle ${r.vehicle_id} on ${r.day}: ${r.engine_s} s of engine time`);
    for (const r of server.all('SELECT vehicle_id, day, idle_s, engine_s FROM daily_stats WHERE idle_s > engine_s AND engine_s > 0')) throw new Error(`vehicle ${r.vehicle_id} on ${r.day}: idling ${r.idle_s} s exceeds engine time ${r.engine_s} s`);
  });

  test('reports endpoint and analytics agree, on real data', async ({ owner, server }) => {
    const days = importedDays(server);
    test.skip(!days.length, 'no day imported yet');
    const from = days[0], to = days[days.length - 1];
    const report = (await owner.get(`/api/reports/vehicles?from=${from}&to=${to}`)).data;
    const ov = (await owner.get(`/api/analytics/overview?from=${from}&to=${to}`)).data.current;
    expect(ov.km).toBeGreaterThan(0);
    expect(report.reduce((a, r) => a + r.km, 0)).toBeCloseTo(ov.km, -1);
    expect(report.reduce((a, r) => a + r.trips, 0)).toBe(ov.trips);
  });

  test('yard: every vehicle GPS places inside the circle is listed', async ({ owner }) => {
    const list = await liveVehicles(owner);
    const y = (await owner.get('/api/yard')).data;
    const listed = new Set([...y.inside, ...y.gpsOnly].filter((x) => x.fleet).map((x) => x.vehicleId));
    for (const v of list.filter((x) => x.inYard && x.status !== 'offline')) expect(listed.has(v.id), `${v.label} is in the yard by GPS`).toBe(true);
  });

  test('alerts raised from real data are well-formed', async ({ owner }) => {
    const alerts = (await owner.get('/api/alerts?limit=500')).data;
    for (const a of alerts) {
      expect(['fuel_drain', 'speeding', 'no_signal', 'long_stop', 'system']).toContain(a.type);
      expect(['info', 'warning', 'critical']).toContain(a.severity);
      expect(a.title.length).toBeGreaterThan(0);
      if (a.vehicleId) expect(a.vehicleLabel, `alert ${a.id}`).toBeTruthy();
    }
  });
});

test.describe('secrets', () => {
  const urls = ['/', '/js/main.js', '/js/api.js', '/js/pages/settings.js', '/manifest.webmanifest', '/health',
    '/api/me', '/api/vehicles', '/api/vehicles/all', '/api/health', '/api/system', '/api/yard', '/api/today', '/api/alerts', '/api/gate-events', '/api/users',
    '/api/analytics/overview', '/api/reports/vehicles'];
  const passwords = () => secretsOf(readDotEnv()).filter(([n]) => n !== 'NVR host');

  test('no password or GPS login reaches a browser', async ({ owner }) => {
    const found = [];
    for (const u of urls) {
      const r = await owner.get(u);
      for (const [name, value] of passwords()) if (r.text.includes(value)) found.push(`${name} in ${u}`);
    }
    expect(found).toEqual([]);
  });

  test('no password or GPS login in the server log', async () => {
    expect(serverLog().length, 'the log was captured').toBeGreaterThan(0);
    const log = serverLog();
    expect(passwords().filter(([, v]) => log.includes(v)).map(([n]) => n)).toEqual([]);
  });

  test("a dispatcher isn't shown the plant's address", async ({ owner, server }) => {
    const username = `disp${seed.uid()}`;
    await owner.post('/api/users', { username, role: 'dispatcher', password: 'password-1' });
    const d = new Api(server.url);
    await d.login(username, 'password-1');
    await sleep(70_000); // a failed NVR search has had time to record its error
    const host = secretsOf(readDotEnv()).find(([n]) => n === 'NVR host')[1];
    const found = [];
    for (const u of urls.filter((x) => !['/api/system', '/api/users', '/api/vehicles/all', '/api/analytics/overview'].includes(x))) {
      if ((await d.get(u)).text.includes(host)) found.push(u);
    }
    expect(found, 'NVR connection errors include the IP address').toEqual([]);
  });
});

test.describe('NVR and cameras, real device', () => {
  test.describe('reachable from here', () => {
    test.skip(!NVR_OK, 'The NVR port does not answer from this machine (the plant router allows only some IPs). Run this suite on the production server to test the cameras.');

    test('the health monitor sees the NVR and every camera as working', async ({ owner }) => {
      const s = await waitFor(async () => { const h = (await owner.get('/api/health')).data; return h.status?.checkedAt ? h : null; }, { what: 'a health check' });
      const part = (id) => s.status.parts.find((p) => p.id === id);
      expect(part('nvr').text).toBe('Ishlayapti');
      expect(part('site').text).toBe('Ishlayapti');
      expect(part('camera').state, part('camera').detail || '').toBe('ok');
    });

    test('history import brought in gate events with loadable photos', async ({ owner }) => {
      const list = await waitFor(async () => { const l = (await owner.get('/api/gate-events?limit=5&status=all')).data; return l.length ? l : null; }, { ms: 200_000, what: 'imported gate events' });
      const withPhoto = list.find((e) => e.photos.length);
      expect(withPhoto, 'an event with a photo').toBeTruthy();
      const r = await fetch(owner.base + withPhoto.photos[0].url, { headers: { cookie: owner.cookie } });
      expect(r.status).toBe(200);
      const b = Buffer.from(await r.arrayBuffer());
      expect(b[0] === 0xff && b[1] === 0xd8, 'a JPEG').toBe(true);
    });

    test('the entry camera recorded something in the last 24 h', async ({ owner }) => {
      const list = (await owner.get(`/api/gate-events?from=${seed.addDays(today(), -1)}&to=${today()}&direction=in&limit=5&status=all`)).data;
      expect(list.length, 'entries in the last 2 days').toBeGreaterThan(0);
    });

    test('the live event stream connects', async ({ owner }) => {
      const h = await waitFor(async () => { const r = (await owner.get('/api/health')).data; return r.nvr?.lastStream ? r : null; }, { ms: 60_000, what: 'the NVR event stream' });
      expect(Date.now() - h.nvr.lastStream).toBeLessThan(120_000);
    });
  });

  test.describe('unreachable from here (a real outage, as the app sees it)', () => {
    test.skip(NVR_OK, 'The NVR answers from this machine.');

    test('the app names the broken link, in words a dispatcher can act on', async ({ owner }) => {
      test.setTimeout(240_000);
      const s = await waitFor(async () => {
        const h = (await owner.get('/api/health')).data;
        return h.status?.problems?.some((p) => p.part === 'site' || p.part === 'nvr') ? h : null;
      }, { ms: 220_000, every: 5000, what: 'the camera outage to be reported' });
      const p = s.status.problems.find((x) => x.part === 'site' || x.part === 'nvr');
      expect(p.key).toBe('site_unreachable');
      expect(p.severity).toBe('critical');
      expect(p.title).toContain('kameralarga ulanib');
      expect(s.status.parts.find((x) => x.id === 'site').state).toBe('bad');
      expect(s.status.parts.find((x) => x.id === 'server').state, 'our server is fine').toBe('ok');
    });

    test('GPS keeps working while the cameras are down', async ({ owner }) => {
      const h = (await owner.get('/api/health')).data;
      expect(h.gps.error).toBeNull();
      expect(Date.now() - h.gps.lastOk, 'GoGPS polled recently').toBeLessThan(60_000);
      expect(h.status.parts.find((x) => x.id === 'gps').state).toBe('ok');
    });

    test('a critical system alert was raised once, not on every check', async ({ owner, server }) => {
      const alerts = (await owner.get('/api/alerts?type=system&state=open')).data;
      const site = alerts.filter((a) => a.data?.problem === 'site_unreachable');
      expect(site.length, 'exactly one open alert for this outage').toBe(1);
      expect(site[0].severity).toBe('critical');
      expect(site[0].body).toContain('dan beri');
      expect(server.get("SELECT COUNT(*) n FROM alerts WHERE key LIKE 'system:site_unreachable:%'").n).toBe(1);
    });

    test('gate pages still answer quickly: empty, not an error', async ({ owner }) => {
      const t0 = Date.now();
      const [ev, yard, today_] = await Promise.all([owner.get('/api/gate-events'), owner.get('/api/yard'), owner.get('/api/today')]);
      expect(ev.status).toBe(200);
      expect(yard.status).toBe(200);
      expect(today_.status).toBe(200);
      expect(Date.now() - t0, 'nothing waits on the dead NVR').toBeLessThan(3000);
    });

    test('a photo that must come from the NVR fails cleanly, as 502', async ({ owner, server }) => {
      test.setTimeout(150_000);
      const id = seed.gateEvent(server, { t: Date.now() - 86400e3, uri: '/ISAPI/ContentMgmt/download?name=ch04_e2e' });
      const r = await owner.get(`/api/gate-events/${id}/photo/0`);
      expect(r.status, r.text.slice(0, 200)).toBe(502);
      expect(r.data.error).toContain('NVR');
      server.run('DELETE FROM gate_events WHERE id = ?', id);
    });

    test('the NVR error reported to the owner holds no password', async ({ owner }) => {
      const sys = (await owner.get('/api/system')).data;
      expect(sys.nvr.lastOk, 'no successful NVR request').toBeNull();
      for (const [name, value] of secretsOf(readDotEnv()).filter(([n]) => n !== 'NVR host')) expect(JSON.stringify(sys).includes(value), `${name} in /api/system`).toBe(false);
    });

    test('UI: banner, sidebar and Tizim tab all say the cameras are down and GPS is fine', async ({ page, signIn }) => {
      test.setTimeout(240_000);
      await signIn(OWNER, 'sozlamalar?tab=tizim');
      await expect(page.locator('#sysBanner')).toContainText('kameralarga ulanib', { timeout: 200_000 });
      await expect(page.locator('#healthBox')).toContainText('Zavod interneti — ishlamayapti');
      const cards = page.locator('#setPanel .card');
      await expect(cards.filter({ hasText: 'GPS (GoGPS)' }).locator('.pill').first()).toHaveText('Ishlayapti');
      await expect(cards.filter({ hasText: 'Kameralar (NVR)' }).locator('.pill').first()).toHaveText("Aloqa yo'q");
      await page.screenshot({ path: path.join(SHOTS, 'real-tizim-nvr-down.png') });
    });
  });
});

test.describe('the app on real data', () => {
  const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `real-${name}.png`) });

  test('login form, then the live map shows every real vehicle that has a position', async ({ page, server, owner }) => {
    await page.goto(server.url);
    await page.fill('#loginForm [name=username]', OWNER.username);
    await page.fill('#loginForm [name=password]', OWNER.password);
    await page.click('#loginForm button[type=submit]');
    await expect(page.locator('#app')).toBeVisible();
    await expect(page.locator('.vrow').first()).toBeVisible();
    const list = await liveVehicles(owner);
    await expect(page.locator('.vrow')).toHaveCount(list.length);
    await expect(page.locator('.leaflet-marker-pane .vm')).toHaveCount(withCoords(list).length);
    const chips = await page.locator('.fchip b').allTextContents();
    expect(chips.reduce((a, c) => a + Number(c), 0)).toBe(list.length);
    await page.screenshot({ path: path.join(SHOTS, 'real-xarita.png') });
  });

  test('a real vehicle: drawer, track, then its full page', async ({ page, signIn, owner }) => {
    const list = await liveVehicles(owner);
    const v = list.find((x) => x.status === 'moving') || list.find((x) => x.lat != null);
    await signIn(OWNER, `xarita?v=${v.id}`);
    await expect(page.locator('#drawer h2')).toHaveText(v.label);
    await page.click('#dTrack');
    await expect(page.locator('#trackInfo')).not.toBeEmpty();
    await shot(page, 'xarita-drawer');
    await page.locator('#drawer a.btn-primary').click();
    await expect(page.locator('#pageTitle')).toContainText(v.label);
    await expect(page.locator('#dayTiles .tile')).toHaveCount(5);
    await expect(page.locator('#chKm svg')).toBeVisible();
    await expect(page.locator('#tlCount')).toContainText('ta');
    await shot(page, 'transport');
  });

  test('every page opens without an error on real data', async ({ page, signIn }) => {
    await signIn(OWNER);
    for (const [hash, ready, name] of [
      ['darvoza', '#gTiles .tile', 'darvoza'], ['ogohlantirish', '#alCount', 'ogohlantirish'], ['transport', 'tbody tr.clickable', 'transport-list'],
      ['tahlil', '#anKpis .tile', 'tahlil'], ['hisobot?from=' + seed.addDays(today(), -7) + '&to=' + today(), '#repTable table', 'hisobot'],
      ['sozlamalar?tab=transportlar', 'table.veh-edit', 'sozlamalar-transport'], ['sozlamalar?tab=foydalanuvchilar', '#setPanel table', 'sozlamalar-users'],
    ]) {
      await page.evaluate((h) => { location.hash = `#/${h}`; }, hash);
      await expect(page.locator(ready).first(), hash).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('#main .notice.bad')).toHaveCount(0);
      await shot(page, name);
    }
  });

  test('CSV of a real report opens with the right rows', async ({ page, signIn, owner }) => {
    const y = seed.addDays(today(), -1);
    const from = seed.addDays(today(), -7);
    await signIn(OWNER, `hisobot?from=${from}&to=${y}`);
    await expect(page.locator('#repTable table')).toBeVisible();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#repCsv')]);
    expect(dl.suggestedFilename()).toBe(`hisobot_${from}_${y}.csv`);
    const text = fs.readFileSync(await dl.path(), 'utf8');
    const rows = (await owner.get(`/api/reports/vehicles?from=${from}&to=${y}`)).data;
    expect(text.trim().split('\r\n').length, 'header + vehicles + totals').toBe(rows.length + 2);
  });
});
