'use strict';
// The Telegram mini app (public/tg/) on a phone-sized screen, against the real server with a bot token. Telegram's
// script is replaced by a stand-in that hands the page initData signed with that token, so the real login runs.
const { uiTest, expect } = require('../support/fixtures');
const { TestServer, FakeTelegram } = require('../support/server');
const { initData, routeTelegram, TOKEN } = require('../support/telegram-webapp');
const { FLEET, gateEvent, alert, uid } = require('../support/seed');

const test = uiTest.extend({
  tgApi: [async ({}, use) => { const f = await new FakeTelegram().start(); await use(f); await f.stop(); }, { scope: 'worker' }],
  server: [async ({ tgApi }, use, workerInfo) => {
    const s = new TestServer({ name: `tg${workerInfo.workerIndex}`, env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_API_BASE: tgApi.url, ADMIN_IDS: '100' } })
      .seedFrom(process.env.E2E_TEMPLATE_DIR);
    await s.start();
    await use(s);
    await s.destroy();
  }, { scope: 'worker', timeout: 180_000 }],
});
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

let nextId = 700000 + Math.floor(Math.random() * 90000);
/** Open the mini app as a fresh Telegram account; link it to `role` unless told not to. */
async function openApp(page, context, server, { role = 'owner', link = true, startParam = '', id = nextId++ } = {}) {
  const data = initData({ id, startParam });
  await routeTelegram(context, { data, startParam });
  await page.goto(`${server.url}/tg/#tgWebAppData=${encodeURIComponent(data)}&tgWebAppVersion=8.0`);
  if (!link) return { id, data };
  await expect(page.locator('#linkForm')).toBeVisible();
  await page.fill('#linkForm [name=username]', role);
  await page.fill('#linkForm [name=password]', role === 'owner' ? 'owner12345' : 'dispatcher123');
  await page.click('#linkForm button');
  await expect(page.locator('#app')).toBeVisible();
  return { id, data };
}

test('outside Telegram: says to open it there', async ({ page, context, server }) => {
  await routeTelegram(context, { data: '' });
  await page.goto(`${server.url}/tg/`);
  await expect(page.locator('#messageTitle')).toHaveText('Telegram ichida oching');
  await expect(page.locator('#app')).toBeHidden();
});

test('first time: the site login once; then straight in; unlinked by the owner, it asks again', async ({ page, context, server, owner }) => {
  test.info().annotations.push({ type: 'allow-errors' }); // the wrong password is a 401 in the console
  const id = nextId++;
  const data = initData({ id, first: 'Dispetcher', last: 'Telefon' });
  await routeTelegram(context, { data });
  await page.goto(`${server.url}/tg/`);
  await expect(page.locator('#linkWho')).toHaveText('Telegram: Dispetcher Telefon');
  await page.fill('#linkForm [name=username]', 'dispatcher');
  await page.fill('#linkForm [name=password]', 'wrong-password');
  await page.click('#linkForm button');
  await expect(page.locator('#linkError')).toHaveText("Login yoki parol noto'g'ri");
  await page.fill('#linkForm [name=password]', 'dispatcher123');
  await page.click('#linkForm button');
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#pageTitle')).toHaveText('Bugun');
  await expect(page.locator('.tg-tiles.four .tg-tile')).toHaveCount(4);

  // Opened again: no form.
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#link')).toBeHidden();

  // The owner sees the link in Settings → Users and removes it.
  const users = (await owner.get('/api/users')).data;
  const disp = users.find((u) => u.username === 'dispatcher');
  expect(disp.telegram).toEqual({ name: 'Dispetcher Telefon' });
  expect((await owner.del(`/api/users/${disp.id}/telegram`)).status).toBe(200);
  await page.reload();
  await expect(page.locator('#linkForm')).toBeVisible();
});

test('every screen opens; the back button shows on screens opened from a tab', async ({ page, context, server }) => {
  const ev = gateEvent(server, { direction: 'out', plate: '85450KBA', vehicleId: FLEET.fuel, status: 'confirmed', by: 'plate', stay: 1800 });
  await openApp(page, context, server);
  const screens = [
    ['bugun', '.tg-tiles.four .tg-tile', false],
    ['xarita', '.leaflet-marker-pane .vm', false],
    ['xarita?view=list', '.tg-vlist .tg-veh', false],
    ['darvoza', '.tg-ev', false],
    ['darvoza?tab=hovli', '.tg-h', false],
    ['hisobot', '.tg-tiles .tg-tile', false],
    ['ogohlantirish', '.tg-seg', true],
    [`v/${FLEET.fuel}`, '.tg-minimap.leaflet-container', true],
    [`e/${ev}`, '.tg-dl', true],
  ];
  for (const [hash, sel, back] of screens) {
    await page.evaluate((h) => { location.hash = `#/${h}`; }, hash);
    await expect(page.locator(sel).first(), hash).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#main .notice.bad')).toHaveCount(0);
    expect(await page.evaluate(() => window.__tg.back), `back button on ${hash}`).toBe(back);
  }
  // The page never scrolls sideways on a phone.
  for (const hash of ['bugun', 'xarita', 'darvoza', 'hisobot', `v/${FLEET.fuel}`]) {
    await page.evaluate((h) => { location.hash = `#/${h}`; }, hash);
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), hash).toBe(true);
  }
  // Telegram's back button goes back to where the screen was opened from.
  await page.evaluate(() => { location.hash = '#/darvoza'; });
  await page.locator(`.tg-ev[data-id="${ev}"]`).click();
  await expect(page.locator('.tg-dl')).toBeVisible();
  await page.evaluate(() => window.__tgBack());
  await expect(page.locator('#pageTitle')).toHaveText('Darvoza');
});

test('the map: status filter and search narrow the trucks; a tap opens the card', async ({ page, context, server }) => {
  await openApp(page, context, server);
  await page.evaluate(() => { location.hash = '#/xarita'; });
  const markers = page.locator('.leaflet-marker-pane .vm');
  await expect(markers).toHaveCount(FLEET.total);
  await page.locator('.tg-chip[data-s="offline"]').click();
  const offline = Number(await page.locator('.tg-chip[data-s="offline"] b').textContent());
  await expect(markers).toHaveCount(offline);
  await page.locator('.tg-chip[data-s=""]').click();
  await page.fill('.tg-search input', '85 450');
  await expect(markers).toHaveCount(1);
  await markers.first().click();
  await expect(page.locator('.tg-sheet')).toBeVisible();
  await expect(page.locator('.tg-sheet .plate')).toHaveText('85 450 KBA');
  await page.locator('.tg-sheet [data-nav]').click();
  await page.locator('.tg-pick [data-y]').click();
  expect((await page.evaluate(() => window.__tg.opened)).at(-1)).toMatch(/^https:\/\/yandex\.uz\/maps\/\?pt=/);
  await page.locator('.tg-sheet a', { hasText: 'Batafsil' }).click();
  await expect(page.locator('#pageTitle')).toHaveText('85 450 KBA');
});

test('a t.me link with a start parameter opens that pass', async ({ page, context, server }) => {
  const plate = `01${String(uid()).replace(/\D/g, '').slice(0, 3).padEnd(3, '7')}TTA`;
  const ev = gateEvent(server, { direction: 'in', plate, vehicleId: null, status: 'outside' });
  await openApp(page, context, server, { startParam: `e${ev}` });
  await expect(page.locator('.tg-dl')).toBeVisible();
  await expect(page.locator('#pageTitle')).toHaveText('Kirdi');
  await expect(page.locator('.tg-dl')).toContainText("Begona: GPS ro'yxatida yo'q");
  expect(await page.evaluate(() => window.__tg.back)).toBe(true);
  await page.evaluate(() => window.__tgBack());
  await expect(page.locator('#pageTitle')).toHaveText('Bugun');
});

test('alerts: acknowledged from the app, the site sees it', async ({ page, context, server, owner }) => {
  const title = `Uzoq to'xtash: sinov ${uid()}`;
  const id = alert(server, { type: 'long_stop', severity: 'info', vehicleId: FLEET.parked, title, key: `e2e-tg-${uid()}` });
  await openApp(page, context, server, { role: 'dispatcher' });
  await page.locator('#bell').click();
  const row = page.locator(`.tg-alert[data-id="${id}"]`);
  await expect(row).toContainText(title);
  await row.locator('[data-ack]').click();
  await expect(row).toBeHidden();
  const a = (await owner.get('/api/alerts?limit=500')).data.find((x) => x.id === id);
  expect(a.ackedBy).toBe('Dispetcher (demo)');
});

test('unlinking from inside the app closes it and asks for the login next time', async ({ page, context, server }) => {
  const { data } = await openApp(page, context, server, { role: 'dispatcher' });
  await page.locator('#userBtn').click();
  await page.locator('[data-unlink]').click();
  await expect.poll(() => page.evaluate(() => window.__tg.closed)).toBe(true);
  await expect(page.locator('#messageTitle')).toHaveText('Telegram uzildi');
  await routeTelegram(context, { data });
  await page.reload();
  await expect(page.locator('#linkForm')).toBeVisible();
});
