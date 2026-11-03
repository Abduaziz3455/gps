'use strict';
// The health monitor, end to end: for each broken link, the right message, an alert, the banner, and the recovery.
// One server per failure, all running at once, so the waits overlap.
const base = require('@playwright/test');
const { browserFixtures, expect } = require('../support/fixtures');
const { TestServer, sleep } = require('../support/server');
const { Api, openStream } = require('../support/api');

const SCENARIOS = {
  internet: { key: 'server_internet', part: 'server', title: "Dispatcher serverida internet yo'q", only: true },
  site: { key: 'site_unreachable', part: 'site', title: "Zavoddagi kameralarga ulanib bo'lmayapti" },
  nvr_off: { key: 'nvr_down', part: 'nvr', title: 'Kamera yozuv qurilmasi (NVR) javob bermayapti' },
  nvr_auth: { key: 'nvr_auth', part: 'nvr', title: 'Kamera tizimi (NVR) parolni qabul qilmadi' },
  gps_down: { key: 'gps_down', part: 'gps', title: 'GPS xizmati javob bermayapti' },
  gps_auth: { key: 'gps_auth', part: 'gps', title: "GPS tizimiga kirib bo'lmayapti" },
  camera_off: { key: 'camera_offline:4', part: 'camera', title: "ANPR-1 (kirish) kamerasi o'chgan", noRecovery: 'channel status is only re-read every 5 minutes' },
};
const servers = {};
const clients = {};

const test = base.test.extend({ ...browserFixtures, server: async ({}, use) => { await use(servers.ui); } });
test.describe.configure({ timeout: 180_000 });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  const env = { HEALTH_CHECK_SECONDS: '5', GPS_POLL_SECONDS: '2', CAMERA_BACKFILL_DAYS: '0', CAMERA_POLL_SECONDS: '5' };
  const boot = async (name, fail) => {
    const s = new TestServer({ name: `h-${name}-${process.pid}`, env }).seedFrom(process.env.E2E_TEMPLATE_DIR);
    s.run('DELETE FROM alerts');
    s.run("DELETE FROM kv WHERE k = 'live_snapshot'");
    if (fail) s.setFail(fail);
    await s.start();
    const c = new Api(s.url);
    await c.login('owner', 'owner12345');
    servers[name] = s;
    clients[name] = c;
  };
  await Promise.all([...Object.keys(SCENARIOS).map((f) => boot(f, f)), boot('ui', null), boot('healthy', null)]);
});
test.afterAll(async () => { await Promise.all(Object.values(servers).map((s) => s.destroy())); });

const problems = async (c) => (await c.get('/api/health')).data.status;
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(1000); }
  throw new Error(`timed out (${ms} ms): ${what}`);
};

for (const [fail, sc] of Object.entries(SCENARIOS)) {
  test(`${fail}: named, alerted once${sc.noRecovery ? '' : ', recovers with the outage period'}`, async () => {
    const c = clients[fail], s = servers[fail];
    const st = await until(async () => { const x = await problems(c); return x.problems?.some((p) => p.key === sc.key) ? x : null; }, 90_000, `problem ${sc.key}; log:\n${s.log.slice(-400)}`);
    const p = st.problems.find((x) => x.key === sc.key);
    expect(p.title).toBe(sc.title);
    expect(p.part).toBe(sc.part);
    expect(p.text.length, 'says what to do').toBeGreaterThan(40);
    const part = st.parts.find((x) => x.id === sc.part);
    expect(part.state).not.toBe('ok');
    expect(part.detail).toBe(p.text);
    if (sc.only) expect(st.problems.map((x) => x.key), 'internet down hides the rest: nothing else can be known').toEqual([sc.key]);

    const alerts = (await c.get('/api/alerts?type=system&limit=50')).data.filter((a) => a.data?.problem === sc.key);
    expect(alerts.length, 'raised once').toBe(1);
    expect(alerts[0]).toMatchObject({ severity: expect.any(String), ackedAt: null, title: sc.title });
    expect(alerts[0].body).toContain('dan beri');

    if (sc.noRecovery) return;
    const key = sc.key;
    s.clearFail();
    await until(async () => !(await problems(c)).problems?.some((x) => x.key === key), 60_000, `recovery of ${key}`);
    const after = (await c.get('/api/alerts?type=system&limit=50')).data.filter((a) => a.data?.problem === key);
    const rec = after.find((a) => a.data.recovered);
    expect(rec, 'a recovery note').toBeTruthy();
    expect(rec.title).toContain('Tiklandi');
    expect(rec.body).toContain('Ishlamagan vaqt');
    for (const a of after) expect(a.ackedAt, 'the bell only counts what is still wrong').toBeTruthy();
    expect((await problems(c)).parts.find((x) => x.id === sc.part).state).toBe('ok');
  });
}

test('healthy system: no problems, no alerts raised', async () => {
  await sleep(30_000);
  const st = await problems(clients.healthy);
  expect(st.problems).toEqual([]);
  expect(st.parts.every((p) => p.state === 'ok'), JSON.stringify(st.parts)).toBe(true);
  expect((await clients.healthy.get('/api/alerts?type=system')).data).toEqual([]);
});

test('a blip of one check raises no alarm', async () => {
  const c = clients.healthy, s = servers.healthy;
  s.setFail('nvr_off');
  await sleep(6000); // about one check
  s.clearFail();
  await sleep(11_000);
  expect((await c.get('/api/alerts?type=system')).data).toEqual([]);
  expect((await problems(c)).problems).toEqual([]);
});

test('outage while a user is watching: stream, banner, sidebar, toast, bell; then all clear', async ({ page, signIn }) => {
  const s = servers.ui, c = clients.ui;
  const sse = openStream(s.url, c.cookie);
  await sse.ready;
  await signIn('dispatcher', 'hisobot');
  await expect(page.locator('#sysBanner')).toBeHidden();
  s.setFail('nvr_off');
  await expect(page.locator('#sysBanner')).toContainText('Kamera yozuv qurilmasi (NVR) javob bermayapti', { timeout: 60_000 });
  await expect(page.locator('#sysBanner')).toContainText('dan beri');
  await expect(page.locator('#healthBox')).toContainText('Kamera tizimi (NVR) — ishlamayapti');
  await expect(page.locator('.toast', { hasText: 'Kamera yozuv qurilmasi' })).toBeVisible();
  await expect(page.locator('#bellCount')).toHaveText('1');
  const a = await sse.next('alert', { past: true, where: (d) => d.type === 'system' });
  expect(a.data.title).toContain('NVR');
  s.clearFail();
  await expect(page.locator('#sysBanner')).toBeHidden({ timeout: 60_000 });
  await expect(page.locator('#healthBox .dot.bad')).toHaveCount(0);
  await expect(page.locator('#bellCount')).toBeHidden();
  sse.close();
});

test('camera pipeline catches up after an NVR outage, with no duplicates', async () => {
  const s = servers.healthy;
  const dup = () => s.get('SELECT COUNT(*) n FROM (SELECT capture_name FROM gate_events GROUP BY capture_name HAVING COUNT(*) > 1)').n;
  s.setFail('nvr_off');
  await sleep(7000);
  s.clearFail();
  await sleep(7000);
  expect(dup()).toBe(0);
  expect((await problems(clients.healthy)).parts.find((p) => p.id === 'nvr').state).toBe('ok');
});
