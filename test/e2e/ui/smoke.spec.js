'use strict';
// The main path on Firefox and WebKit (Safari, iPhone). Chromium gets the full suite.
const { uiTest: test, expect } = require('../support/fixtures');
const { FLEET } = require('../support/seed');

test('log in, see the fleet on the map, log out', async ({ page, server }) => {
  await page.goto(server.url);
  await page.fill('[name=username]', 'owner');
  await page.fill('[name=password]', 'owner12345');
  await page.click('#loginForm button');
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('.vrow')).toHaveCount(FLEET.total);
  await expect(page.locator('.leaflet-marker-pane .vm')).toHaveCount(FLEET.total);
  await page.click('#userBtn');
  await page.click('#logoutBtn');
  await expect(page.locator('#loginForm')).toBeVisible();
});

test('every section opens without an error', async ({ page, signIn }) => {
  await signIn('owner');
  for (const [h, sel] of [['darvoza', '#gTiles .tile'], ['ogohlantirish', '#alCount'], [`transport/${FLEET.fuel}`, '#dayTiles .tile'], ['transport', 'tbody tr'], ['tahlil', '#anKpis .tile'], ['hisobot', '#repTable table'], ['sozlamalar', '#setPanel h3'], ['sozlamalar?tab=tizim', '#setPanel .card'], ['sozlamalar?tab=foydalanuvchilar', '#setPanel table'], ['sozlamalar?tab=transportlar', 'table.veh-edit']]) {
    await page.evaluate((x) => { location.hash = `#/${x}`; }, h);
    await expect(page.locator(sel).first(), h).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#main .notice.bad', { hasText: "ochib bo'lmadi" })).toHaveCount(0);
  }
});

test('live stream connects and delivers', async ({ page, signIn }) => {
  await signIn('owner');
  await expect(page.locator('#healthBox .dot.bad')).toHaveCount(0);
  const stamp = async () => page.evaluate(async () => { const { state } = await import('/js/api.js'); return Math.max(...[...state.vehicles.values()].map((v) => v.recordTime || 0)); });
  const t0 = await stamp();
  await expect.poll(stamp, { timeout: 30_000 }).toBeGreaterThan(t0);
});

test('open a vehicle card, and the gate event dialog', async ({ page, signIn, server }) => {
  const { gateEvent } = require('../support/seed');
  const id = gateEvent(server, { t: Date.now() - 1000, plate: '01A123BC', status: 'outside' });
  await signIn('dispatcher', `xarita?v=${FLEET.fuel}`);
  await expect(page.locator('#drawer h2')).toHaveText('85 450 KBA');
  await page.evaluate((e) => { location.hash = `#/darvoza?event=${e}`; }, id);
  await expect(page.locator('.modal h2')).toContainText('01 A 123 BC');
  await expect.poll(() => page.locator('.photos img').first().evaluate((i) => i.complete && i.naturalWidth > 0)).toBe(true);
  server.run('DELETE FROM gate_events WHERE id = ?', id);
});

test('date inputs work: report for yesterday', async ({ page, signIn }) => {
  const { addDays, tashkentDay } = require('../support/seed');
  const y = addDays(tashkentDay(), -1);
  await signIn('dispatcher', `hisobot?from=${y}&to=${y}`);
  await expect(page.locator('#repTable table')).toBeVisible();
  await expect(page.locator('[data-from]')).toHaveValue(y);
});

test('CSV downloads', async ({ page, signIn }) => {
  await signIn('dispatcher', 'hisobot');
  await expect(page.locator('#repTable table')).toBeVisible();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#repCsv')]);
  expect(dl.suggestedFilename()).toMatch(/\.csv$/);
});
