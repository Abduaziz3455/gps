'use strict';
// Unknown plates, on a server of their own: a truck added here changes the fleet the other tests count.
const { test, uiTest, expect } = require('../support/fixtures');
const { TestServer, FakeTelegram, ACCOUNTS } = require('../support/server');
const { Api } = require('../support/api');
const { gateEvent, tashkentDay, FLEET } = require('../support/seed');

const PLATE = '10834HDA', TEXT = '10 834 HDA';
const DAY = 86400e3;

/** A regular the simulator doesn't have: an exit and an entry on each of three days. */
function regular(s, plate = PLATE) {
  const ids = [];
  const noon = Date.parse(`${tashkentDay()}T07:00:00Z`);
  for (const d of [1, 2, 3]) {
    ids.push(gateEvent(s, { t: noon - d * DAY, direction: 'out', plate, vehicleId: null, status: 'outside' }));
    ids.push(gateEvent(s, { t: noon - d * DAY + 3600e3, direction: 'in', plate, vehicleId: null, status: 'outside' }));
  }
  return ids;
}

async function boot(env = {}) {
  const s = new TestServer({ name: `plates${Date.now() % 100000}`, env }).seedFrom(process.env.E2E_TEMPLATE_DIR);
  await s.start();
  const owner = new Api(s.url);
  await owner.login(ACCOUNTS.owner.username, ACCOUNTS.owner.password);
  return { s, owner };
}

test('over HTTP: listed, linked with its past, undone; refusals change nothing', async () => {
  const { s, owner } = await boot();
  try {
    const ids = regular(s);
    const row = (await owner.get('/api/plates/unknown')).data.find((r) => r.plate === PLATE);
    expect(row).toMatchObject({ text: TEXT, passes: 6, in: 3, out: 3, days: 3 });

    expect((await owner.post(`/api/plates/${PLATE}/link`, { vehicleId: 12345 })).status).toBe(404);
    expect((await owner.post(`/api/plates/${PLATE}/link`, { vehicleId: 'x' })).status).toBe(400);
    expect((await owner.post('/api/plates/NOTAPLATE/link', { vehicleId: FLEET.fuel })).status).toBe(400);
    expect((await owner.post(`/api/plates/${PLATE}/link`, { newTruck: { type: 'spaceship' } })).status).toBe(400);
    expect((await owner.post('/api/plates/85450KBA/link', { vehicleId: FLEET.mixer })).status, 'another truck\'s plate').toBe(409);
    expect((await owner.del(`/api/plates/${PLATE}/link`)).status).toBe(404);
    expect((await owner.get('/api/plates/decided')).data).toEqual([]);

    const r = await owner.post(`/api/plates/${PLATE}/link`, { vehicleId: FLEET.fuel });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ moved: 6, days: 3 });
    const ev = (await owner.get(`/api/gate-events/${ids[0]}`)).data;
    expect(ev).toMatchObject({ vehicleId: FLEET.fuel, identifiedBy: 'link', status: 'history' });
    expect((await owner.get('/api/plates/unknown')).data.some((x) => x.plate === PLATE)).toBe(false);
    expect((await owner.get('/api/plates/decided')).data[0]).toMatchObject({ plate: PLATE, kind: 'vehicle', vehicleId: FLEET.fuel, passes: 6 });
    expect((await owner.post(`/api/plates/${PLATE}/link`, { vehicleId: FLEET.mixer })).status, 'decided already').toBe(409);
    expect((await owner.patch(`/api/vehicles/${FLEET.mixer}`, { plate: PLATE })).status, 'not as another truck\'s plate either').toBe(409);
    expect((await owner.get('/api/vehicles/all')).data.find((v) => v.id === FLEET.fuel).linked).toEqual([TEXT]);

    expect((await owner.del(`/api/plates/${PLATE}/link`)).data.moved).toBe(6);
    expect((await owner.get(`/api/gate-events/${ids[0]}`)).data).toMatchObject({ vehicleId: null, status: 'outside' });
    expect((await owner.get('/api/plates/unknown')).data.some((x) => x.plate === PLATE)).toBe(true);
  } finally { await s.destroy(); }
});

test('a truck with no tracker: in the reports and trips, off the live map, not counted as lost; gone again on undo; survives a restart', async () => {
  const { s, owner } = await boot();
  try {
    regular(s);
    const before = (await owner.get('/api/vehicles')).data.length;
    const { data: made } = await owner.post(`/api/plates/${PLATE}/link`, { newTruck: { name: 'Mikser 29', type: 'mixer' } });
    expect(made).toMatchObject({ label: 'Mikser 29', moved: 6 });
    const noon = Date.parse(`${tashkentDay()}T07:00:00Z`);
    const day = tashkentDay(noon - DAY);

    const v = (await owner.get('/api/vehicles')).data.find((x) => x.id === made.vehicleId);
    expect(v).toMatchObject({ label: 'Mikser 29', cameraOnly: true, inGps: false, lat: null });
    expect((await owner.get('/api/vehicles')).data.length).toBe(before + 1);
    const offlineCount = (x) => x.filter((a) => !a.cameraOnly && a.status === 'offline').length;
    const t = (await owner.get('/api/today')).data;
    expect(t.status.offline, 'no tracker is not "signal lost"').toBe(offlineCount((await owner.get('/api/vehicles')).data));

    const report = (await owner.get(`/api/reports/vehicles?from=${day}&to=${day}`)).data.find((x) => x.id === made.vehicleId);
    expect(report.trips).toBe(1);
    const trips = (await owner.get(`/api/trips?from=${day}&to=${day}&vehicle=${made.vehicleId}`)).data.trips;
    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({ state: 'done', startSrc: 'camera', endSrc: 'camera', durationS: 3600, km: null });
    expect((await owner.get(`/api/vehicles/${made.vehicleId}/stops?day=${day}`)).data).toEqual({ moves: [], stops: [] });

    // Its status survives the poller refreshing the list from GoGPS, and a restart.
    await s.restart();
    await owner.login(ACCOUNTS.owner.username, ACCOUNTS.owner.password);
    await expect.poll(async () => (await owner.get('/api/vehicles')).data.find((x) => x.id === made.vehicleId)?.cameraOnly, { timeout: 30_000 }).toBe(true);
    expect((await owner.get(`/api/trips?from=${day}&to=${day}&vehicle=${made.vehicleId}`)).data.trips).toHaveLength(1);

    await owner.del(`/api/plates/${PLATE}/link`);
    expect((await owner.get('/api/vehicles')).data.length).toBe(before);
    expect((await owner.get(`/api/trips?from=${day}&to=${day}&vehicle=${made.vehicleId}`)).data.trips).toHaveLength(0);
  } finally { await s.destroy(); }
});

test('Telegram: a truck with no tracker goes out with its name and no GPS warning', async () => {
  const tg = await new FakeTelegram().start();
  const { s, owner } = await boot({ TELEGRAM_BOT_TOKEN: 'TEST:TOKEN', TELEGRAM_API_BASE: tg.url, ADMIN_IDS: '100', TELEGRAM_CHAT_IDS: '-1001234567890' });
  try {
    regular(s);
    const { data: made } = await owner.post(`/api/plates/${PLATE}/link`, { newTruck: {} });
    const id = gateEvent(s, { t: Date.now() - 30e3, direction: 'out', plate: PLATE, vehicleId: made.vehicleId, status: 'history', note: "GPS yo'q: faqat kamera", by: 'link' });
    s.run("UPDATE gate_events SET top_view = 'pending', alert_state = 'pending' WHERE id = ?", id);
    await expect.poll(() => tg.alerts().filter((a) => a.caption.includes(TEXT)).length, { timeout: 60_000 }).toBeGreaterThan(0);
    const [a] = tg.alerts().filter((x) => x.caption.includes(TEXT));
    expect(a.caption).toContain('🔴 <b>CHIQDI</b>');
    expect(a.caption).not.toMatch(/signal|GPS ro'yxatida yo'q|🚫/);
  } finally { await s.destroy(); await tg.stop(); }
});

uiTest('the owner: sees the card, decides each way, the fleet table follows, and undoes', async ({ page, context }) => {
  const { s, owner } = await boot();
  try {
    regular(s);
    regular(s, '10861HDA');
    regular(s, '85W670JA');
    await context.addCookies([{ name: 'tbb_session', value: owner.token, url: s.url, httpOnly: true, sameSite: 'Lax' }]);
    await page.goto(`${s.url}/#/sozlamalar`);
    await page.getByRole('tab', { name: 'Transportlar' }).click();
    const row = (p) => page.locator(`.plate-table tr[data-plate="${p}"]`);
    await expect(row(PLATE)).toContainText(TEXT);
    await expect(row(PLATE)).toContainText('6 marta');
    await expect(page.locator('#plateCount')).toContainText('ta');

    // Choosing nothing refuses; then this GPS truck.
    await row(PLATE).getByRole('button', { name: 'Biriktirish' }).click();
    await expect(page.locator('.toast')).toContainText('Avval GPS transportini tanlang');
    await row(PLATE).locator('[name=vehicle]').selectOption(String(FLEET.fuel));
    await row(PLATE).getByRole('button', { name: 'Biriktirish' }).click();
    await page.locator('.modal').getByRole('button', { name: 'Biriktirish' }).click();
    await expect(row(PLATE)).toHaveCount(0);
    await expect(page.locator('#plateDecided')).toContainText(TEXT);
    await expect(page.locator(`.veh-edit tr[data-id="${FLEET.fuel}"]`)).toContainText(TEXT);

    // No tracker: a new row in the fleet table.
    await row('10861HDA').getByRole('button', { name: "Bizniki, GPS'siz" }).click();
    await page.locator('.modal').getByRole('button', { name: "Qo'shish" }).click();
    await expect(page.locator('.veh-edit')).toContainText('10 861 HDA');
    await expect(page.locator('.veh-edit')).toContainText('Faqat kamera');

    // Not ours.
    await row('85W670JA').getByRole('button', { name: 'Begona' }).click();
    await expect(page.locator('#plateDecided summary')).toContainText('3');

    // Undo the truck: its row goes, and the plate is back in the list.
    await page.locator('#plateDecided summary').click();
    await page.locator('#plateDecided tr[data-plate="10861HDA"]').getByRole('button', { name: 'Qaytarish' }).click();
    await page.locator('.modal').getByRole('button', { name: 'Qaytarish' }).click();
    await expect(row('10861HDA')).toBeVisible();
    await expect(page.locator('.veh-edit')).not.toContainText('10 861 HDA');
    expect(s.alive).toBe(true);
  } finally { await s.destroy(); }
});

uiTest('a truck with no tracker: not on the live map, a clear page of its own; a dispatcher has no card', async ({ page, context }) => {
  const { s, owner } = await boot();
  try {
    regular(s);
    const { data: made } = await owner.post(`/api/plates/${PLATE}/link`, { newTruck: {} });
    await context.addCookies([{ name: 'tbb_session', value: owner.token, url: s.url, httpOnly: true, sameSite: 'Lax' }]);
    await page.goto(`${s.url}/#/xarita`);
    await expect(page.locator('#vlist .vrow').first()).toBeVisible();
    await expect(page.locator('#vlist')).not.toContainText(TEXT);
    await page.goto(`${s.url}/#/transport`);
    await expect(page.locator('tr', { hasText: TEXT })).toContainText('Faqat kamera');
    await page.goto(`${s.url}/#/transport/${made.vehicleId}`);
    await expect(page.locator('#infoCard')).toContainText('kameralari');

    const d = new Api(s.url);
    await d.login(ACCOUNTS.dispatcher.username, ACCOUNTS.dispatcher.password);
    await context.clearCookies();
    await context.addCookies([{ name: 'tbb_session', value: d.token, url: s.url, httpOnly: true, sameSite: 'Lax' }]);
    await page.goto(`${s.url}/#/sozlamalar`);
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Hisob' }), 'the page is there').toBeVisible();
    await expect(page.getByRole('tab', { name: 'Transportlar' })).toHaveCount(0);
  } finally { await s.destroy(); }
});
