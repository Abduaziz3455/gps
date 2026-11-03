'use strict';
// The pages dispatchers live in: map, gate, alerts, vehicle.
const { uiTest: test, expect } = require('../support/fixtures');
const { uid, alert, gateEvent, FLEET, tashkentDay, addDays, dayStart } = require('../support/seed');

const today = () => tashkentDay();

test.describe('live map', () => {
  const ready = async (page) => { await expect(page.locator('.vrow').first()).toBeVisible(); };

  test('every vehicle is listed; status chips add up; markers on the map', async ({ page, signIn }) => {
    await signIn('dispatcher');
    await ready(page);
    await expect(page.locator('.vrow')).toHaveCount(FLEET.total);
    const counts = (await page.locator('.fchip b').allTextContents()).map(Number);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(FLEET.total);
    await expect(page.locator('.leaflet-marker-pane .vm')).toHaveCount(FLEET.total);
    await expect(page.locator('.leaflet-tile-pane img').first()).toBeVisible();
  });

  test('map tiles come from our own server, so no browser setting can get them blocked', async ({ page, signIn, server }) => {
    const tile = page.waitForRequest(/\/api\/tiles\/\d+\/\d+\/\d+$/);
    await signIn('dispatcher');
    expect(new URL((await tile).url()).origin).toBe(server.url);
    // Anything else outside would fail the test: see externalRequests in support/fixtures.js
  });

  test('the yard is drawn and labelled', async ({ page, signIn, server }) => {
    await signIn('owner');
    await expect(page.locator('.vm-label', { hasText: 'TBB hovli' })).toHaveCount(1);
    await expect(page.locator('.leaflet-overlay-pane path')).toHaveCount(1);
    void server;
  });

  test('status filter: list and markers follow; click again clears', async ({ page, signIn }) => {
    await signIn('dispatcher');
    await ready(page);
    const chip = page.locator('.fchip[data-f=offline]');
    const n = Number(await chip.locator('b').textContent());
    expect(n, 'the two silent trackers').toBeGreaterThanOrEqual(2);
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.vrow')).toHaveCount(n);
    await expect(page.locator('.leaflet-marker-pane .vm')).toHaveCount(n);
    await expect(page.locator('.vrow .status.offline')).toHaveCount(n);
    await chip.click();
    await expect(page.locator('.vrow')).toHaveCount(FLEET.total);
  });

  test('the filter survives leaving the page, and a reload', async ({ page, signIn }) => {
    await signIn('dispatcher');
    await ready(page);
    await page.click('.fchip[data-f=offline]');
    await page.click('#nav a[data-path=hisobot]');
    await page.click('#nav a[data-path=xarita]');
    await expect(page.locator('.fchip[data-f=offline]')).toHaveAttribute('aria-pressed', 'true');
    await page.reload();
    await expect(page.locator('.fchip[data-f=offline]')).toHaveAttribute('aria-pressed', 'true');
  });

  for (const [name, q] of [['with spaces', '85 450'], ['no spaces', '85450'], ['lower case', '85450kba'], ['part', '450 k']]) {
    test(`search finds a truck, ${name}`, async ({ page, signIn }) => {
      await signIn('dispatcher');
      await ready(page);
      await page.fill('#vsearch', q);
      await expect(page.locator('.vrow')).toHaveCount(1);
      await expect(page.locator('.vrow .vname')).toHaveText('85 450 KBA');
    });
  }

  test('the map keeps its size when a search or filter shortens the list', async ({ page, signIn }) => {
    await signIn('dispatcher');
    await ready(page);
    const height = () => page.locator('#main').evaluate((e) => Math.round(e.getBoundingClientRect().height));
    const full = await height();
    await page.fill('#vsearch', '85 450');
    await expect(page.locator('.vrow')).toHaveCount(1);
    await page.waitForTimeout(300);
    expect(await height(), 'the page must not collapse to the height of its content').toBe(full);
    await page.fill('#vsearch', '');
    await page.click('.fchip[data-f=offline]');
    await page.waitForTimeout(300);
    expect(await height(), 'nor with a status filter').toBe(full);
  });

  test('search and filter combine; no match says so', async ({ page, signIn }) => {
    await signIn('dispatcher');
    await ready(page);
    await page.fill('#vsearch', 'zzz');
    await expect(page.locator('#vlist .empty')).toHaveText('Transport topilmadi');
    await page.fill('#vsearch', '');
    await expect(page.locator('.vrow')).toHaveCount(FLEET.total);
  });

  test('a real plate or display name is searchable', async ({ page, signIn, owner }) => {
    await owner.patch(`/api/vehicles/${FLEET.mixer}`, { display: 'Mikser 31' });
    try {
      await signIn('dispatcher');
      await ready(page);
      await page.fill('#vsearch', 'mikser');
      await expect(page.locator('.vrow')).toHaveCount(1);
      await expect(page.locator('.vrow .vname')).toHaveText('Mikser 31');
    } finally { await owner.patch(`/api/vehicles/${FLEET.mixer}`, { display: '' }); }
  });

  test('order: moving first, silent trackers last', async ({ page, signIn }) => {
    await signIn('dispatcher');
    await ready(page);
    const order = { moving: 0, idle: 1, stopped: 2, offline: 3 };
    const statuses = await page.locator('.vrow .vmeta .status').evaluateAll((els) => els.map((e) => e.classList[1]));
    const ranks = statuses.map((s) => order[s]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  test('clicking a row opens the card; the URL can be shared; the card closes', async ({ page, signIn }) => {
    await signIn('dispatcher');
    await ready(page);
    await page.fill('#vsearch', '85 450');
    await expect(page.locator('.vrow')).toHaveCount(1);
    await page.locator('.vrow').click();
    await expect(page.locator('#drawer h2')).toHaveText('85 450 KBA');
    await expect(page).toHaveURL(new RegExp(`#/xarita\\?v=${FLEET.fuel}`));
    await expect(page.locator('.vrow').first()).toHaveAttribute('aria-selected', 'true');
    await page.click('#dClose');
    await expect(page.locator('#drawer')).toBeHidden();
    await expect(page).toHaveURL(/#\/xarita$/);
  });

  test('a direct link opens the card', async ({ page, signIn }) => {
    await signIn('dispatcher', `xarita?v=${FLEET.fuel}`);
    await expect(page.locator('#drawer h2')).toHaveText('85 450 KBA');
  });

  test('a direct link to an unknown vehicle: map, no card, no error', async ({ page, signIn }) => {
    await signIn('dispatcher', 'xarita?v=999999');
    await ready(page);
    await expect(page.locator('#drawer')).toBeHidden();
  });

  test('clicking a marker opens its card', async ({ page, signIn }) => {
    await signIn('dispatcher');
    await ready(page);
    await page.click('.fchip[data-f=offline]');
    await page.click('#fitBtn');
    await page.waitForTimeout(600);
    await page.locator('.leaflet-marker-pane .vm').first().click({ force: true });
    await expect(page.locator('#drawer')).toBeVisible();
    await expect(page.locator('#drawer h2')).not.toBeEmpty();
  });

  test('card: follow, today\'s track, link to the vehicle page', async ({ page, signIn }) => {
    await signIn('dispatcher', `xarita?v=${FLEET.fuel}`);
    await page.click('#dFollow');
    await expect(page.locator('#dFollow')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#dFollow')).toContainText('Kuzatilmoqda');
    await page.click('#dTrack');
    await expect(page.locator('#dTrack')).toContainText('Izni yashirish');
    await expect(page.locator('#trackInfo')).not.toBeEmpty();
    const paths = await page.locator('.leaflet-overlay-pane path').count();
    await page.click('#dTrack');
    await expect(page.locator('#dTrack')).toContainText('Bugungi iz');
    await expect(page.locator('.leaflet-overlay-pane path')).toHaveCount(paths - 1);
    await page.locator('#drawer a.btn-primary').click();
    await expect(page).toHaveURL(new RegExp(`#/transport/${FLEET.fuel}`));
  });

  test('card: a silent tracker reads "no signal", with how long ago', async ({ page, signIn }) => {
    await signIn('dispatcher', `xarita?v=${FLEET.dead}`);
    await expect(page.locator('#drawer')).toContainText("Signal yo'q");
    await expect(page.locator('#drawer')).toContainText('kun oldin');
  });

  test('the track of the first vehicle goes away when another is selected', async ({ page, signIn }) => {
    await signIn('dispatcher', `xarita?v=${FLEET.fuel}`);
    await page.click('#dTrack');
    await expect(page.locator('#dTrack')).toContainText('Izni yashirish');
    await page.fill('#vsearch', '85 159');
    await expect(page.locator('.vrow')).toHaveCount(1);
    await page.locator('.vrow').click();
    await expect(page.locator('#drawer h2')).toHaveText('85 159 YAA');
    await expect(page.locator('#dTrack')).toContainText('Bugungi iz');
  });

  test('Hammasi and Hovli move the map', async ({ page, signIn }) => {
    await signIn('dispatcher');
    await ready(page);
    const before = await page.locator('.leaflet-map-pane').getAttribute('style');
    await page.click('#yardBtn');
    await expect.poll(() => page.locator('.leaflet-map-pane').getAttribute('style')).not.toBe(before);
    await page.click('#fitBtn');
    await page.waitForTimeout(400);
    await expect(page.locator('.leaflet-marker-pane .vm')).toHaveCount(FLEET.total);
  });

  test('live: a position update reaches the page without a reload', async ({ page, signIn }) => {
    await signIn('dispatcher');
    await ready(page);
    const stamp = async () => page.evaluate(async () => { const { state } = await import('/js/api.js'); return Math.max(...[...state.vehicles.values()].map((v) => v.recordTime || 0)); });
    const t0 = await stamp();
    await expect.poll(stamp, { timeout: 30_000 }).toBeGreaterThan(t0);
  });

  test('a renamed vehicle updates on an open page', async ({ page, signIn, owner }) => {
    await signIn('dispatcher');
    await ready(page);
    const name = `Yangi ${uid()}`;
    await owner.patch(`/api/vehicles/${FLEET.parked}`, { display: name });
    try {
      await expect(page.locator('.vrow .vname', { hasText: name })).toHaveCount(1, { timeout: 15_000 });
    } finally { await owner.patch(`/api/vehicles/${FLEET.parked}`, { display: '' }); }
  });
});

test.describe('gate', () => {
  const DAY = '2020-06-15';
  const T0 = dayStart(DAY) + 9 * 3600e3;
  const clear = (server) => server.run('DELETE FROM gate_events WHERE t >= ? AND t < ?', dayStart(DAY), dayStart(DAY) + 86400e3);
  const pick = async (page, day) => { await page.fill('#gDay', day); await page.dispatchEvent('#gDay', 'change'); };
  const seedDay = (server) => {
    clear(server);
    return {
      a: gateEvent(server, { t: T0, direction: 'in', plate: '85450KBA', vehicleId: FLEET.fuel, status: 'confirmed', by: 'plate', note: 'GPS: hovliga kirdi' }),
      b: gateEvent(server, { t: T0 + 60e3, direction: 'out', plate: '85450KBA', vehicleId: FLEET.fuel, status: 'unconfirmed', by: 'plate', stay: 3600, note: "GPS ma'lumoti yo'q" }),
      c: gateEvent(server, { t: T0 + 120e3, direction: 'in', plate: '01A123BC', status: 'outside' }),
      d: gateEvent(server, { t: T0 + 180e3, direction: 'out', plate: null, plateRaw: null, valid: 0, status: 'outside', note: "Raqam o'qilmadi", gap: 1 }),
      e: gateEvent(server, { t: T0 + 240e3, direction: 'out', plate: '85159YAA', vehicleId: FLEET.fuel2, status: 'vetoed', by: 'plate', note: 'GPS: 5 daqiqadan keyin ham hovlida turibdi' }),
    };
  };

  test('tiles and today\'s side panels load', async ({ page, signIn }) => {
    await signIn('dispatcher', 'darvoza');
    await expect(page.locator('#gTiles .tile')).toHaveCount(4);
    await expect(page.locator('#insideCount')).toContainText('ta');
    await expect(page.locator('#gDay')).toHaveValue(today());
    await expect(page.locator('#gDay')).toHaveAttribute('max', today());
  });

  test('a past day: its events in order, each with direction and status label', async ({ page, signIn, server }) => {
    seedDay(server);
    await signIn('dispatcher', 'darvoza');
    await pick(page, DAY);
    await expect(page.locator('#feed .ev')).toHaveCount(4);
    await expect(page.locator('#feed .ev').first()).toContainText("Raqam o'qilmadi");
    await expect(page.locator('#feed .ev').last()).toContainText('85 450 KBA');
    await expect(page.locator('#feed .ev').last().locator('.dir')).toHaveText('KIRDI');
    await expect(page.locator('#feed .ev').last().locator('.pill')).toHaveText('GPS tasdiqladi');
    await expect(page.locator('#feed .ev', { hasText: 'Ichkarida: 1 soat' })).toHaveCount(1);
  });

  test('a day with no events says so', async ({ page, signIn }) => {
    await signIn('dispatcher', 'darvoza');
    await pick(page, '2019-03-08');
    await expect(page.locator('#feed .empty')).toHaveText("8-mart: hodisa yo'q");
    await expect(page.locator('#moreBtn')).toBeHidden();
  });

  test('clearing the date falls back to today', async ({ page, signIn }) => {
    await signIn('dispatcher', 'darvoza');
    await pick(page, '2019-03-08');
    await page.fill('#gDay', '');
    await page.dispatchEvent('#gDay', 'change');
    await expect(page.locator('#feed .empty, #feed .ev').first()).toBeVisible();
    await expect.poll(() => page.locator('#feed .empty', { hasText: '8-mart' }).count()).toBe(0);
  });

  test('filters: direction, kind, plate, hidden; they combine', async ({ page, signIn, server }) => {
    seedDay(server);
    await signIn('dispatcher', 'darvoza');
    await pick(page, DAY);
    await expect(page.locator('#feed .ev')).toHaveCount(4);
    await page.click('#segDir button[data-v=in]');
    await expect(page.locator('#feed .ev')).toHaveCount(2);
    await expect(page.locator('#segDir button[data-v=in]')).toHaveAttribute('aria-pressed', 'true');
    await page.click('#segKind button[data-v=outside]');
    await expect(page.locator('#feed .ev')).toHaveCount(1);
    await page.click('#segDir button[data-v=""]');
    await page.click('#segKind button[data-v=""]');
    await expect(page.locator('#feed .ev')).toHaveCount(4);
    await page.fill('#gPlate', '01 a 123');
    await expect(page.locator('#feed .ev')).toHaveCount(1);
    await page.fill('#gPlate', '');
    await expect(page.locator('#feed .ev')).toHaveCount(4);
    await page.check('#gAll');
    await expect(page.locator('#feed .ev')).toHaveCount(5);
    await expect(page.locator('#feed .ev.vetoed')).toHaveCount(1);
  });

  test('detail: photo, facts, correct vehicle', async ({ page, signIn, server }) => {
    const { a } = seedDay(server);
    await signIn('dispatcher', 'darvoza');
    await pick(page, DAY);
    await page.locator(`#feed .ev[data-id="${a}"]`).click();
    const m = page.locator('.modal');
    await expect(m).toBeVisible();
    await expect(m.locator('h2')).toHaveText('Kirish: 85 450 KBA');
    await expect(m).toContainText('15-iyun');
    await expect(m).toContainText("Raqam bo'yicha");
    await expect(m.locator('#evVehicle')).toHaveValue(String(FLEET.fuel));
    await expect(m.locator('#evVehicle option')).toHaveCount(FLEET.total + 1);
    await expect.poll(() => m.locator('.photos img').first().evaluate((i) => i.complete && i.naturalWidth > 0)).toBe(true);
  });

  test('detail: lightbox opens the photo; Escape closes it, not the dialog beneath', async ({ page, signIn, server }) => {
    const { a } = seedDay(server);
    await signIn('dispatcher', 'darvoza');
    await pick(page, DAY);
    await page.locator(`#feed .ev[data-id="${a}"]`).click();
    await page.locator('.photos img').first().click();
    await expect(page.locator('.lightbox img')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.lightbox')).toHaveCount(0);
    await expect(page.locator('.modal'), 'one Escape closes one layer').toBeVisible();
  });

  test('detail closes: Escape, the X, the backdrop, the button', async ({ page, signIn, server }) => {
    const { a } = seedDay(server);
    await signIn('dispatcher', 'darvoza');
    await pick(page, DAY);
    const open = async () => { await page.locator(`#feed .ev[data-id="${a}"]`).click(); await expect(page.locator('.modal')).toBeVisible(); };
    await open();
    await page.keyboard.press('Escape');
    await expect(page.locator('.modal')).toHaveCount(0);
    await open();
    await page.locator('.modal-head [data-close]').click();
    await expect(page.locator('.modal')).toHaveCount(0);
    await open();
    await page.mouse.click(5, 5);
    await expect(page.locator('.modal')).toHaveCount(0);
    await open();
    await page.locator('.modal-foot [data-close]').click();
    await expect(page.locator('.modal')).toHaveCount(0);
  });

  test('keyboard: Enter opens an event', async ({ page, signIn, server }) => {
    const { a } = seedDay(server);
    await signIn('dispatcher', 'darvoza');
    await pick(page, DAY);
    await page.locator(`#feed .ev[data-id="${a}"]`).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.modal')).toBeVisible();
  });

  test('keyboard: Space opens an event too (it is marked as a button)', async ({ page, signIn, server }) => {
    const { a } = seedDay(server);
    await signIn('dispatcher', 'darvoza');
    await pick(page, DAY);
    await page.locator(`#feed .ev[data-id="${a}"]`).focus();
    await page.keyboard.press('Space');
    await expect(page.locator('.modal')).toBeVisible();
  });

  test('keyboard: Tab stays inside an open dialog', async ({ page, signIn, server }) => {
    const { a } = seedDay(server);
    await signIn('dispatcher', 'darvoza');
    await pick(page, DAY);
    await page.locator(`#feed .ev[data-id="${a}"]`).click();
    await expect(page.locator('.modal')).toBeVisible();
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement.closest('.modal')), `focus left the dialog after ${i + 1} Tabs`).toBe(true);
    }
  });

  test('correct the vehicle: saved, the row updates live, unassigning works', async ({ page, signIn, server }) => {
    const { c } = seedDay(server);
    await signIn('dispatcher', 'darvoza');
    await pick(page, DAY);
    await page.locator(`#feed .ev[data-id="${c}"]`).click();
    await page.selectOption('#evVehicle', String(FLEET.fuel2));
    await page.click('#evSave');
    await expect(page.locator('.toast', { hasText: 'Saqlandi' })).toBeVisible();
    await expect(page.locator(`#feed .ev[data-id="${c}"] .ev-title`)).toHaveText('85 159 YAA');
    await expect(page.locator(`#feed .ev[data-id="${c}"] .ev-sub`)).toContainText('Kamera: 01 A 123 BC');
    await page.locator(`#feed .ev[data-id="${c}"]`).click();
    await page.selectOption('#evVehicle', '');
    await page.click('#evSave');
    await expect(page.locator(`#feed .ev[data-id="${c}"] .ev-title`)).toHaveText('01 A 123 BC');
  });

  test('hide an event, and bring it back', async ({ page, signIn, server }) => {
    const { b } = seedDay(server);
    await signIn('dispatcher', 'darvoza');
    await pick(page, DAY);
    await page.check('#gAll');
    await page.locator(`#feed .ev[data-id="${b}"]`).click();
    await page.click('#evHide');
    await expect(page.locator(`#feed .ev[data-id="${b}"]`)).toHaveClass(/vetoed/);
    await page.locator(`#feed .ev[data-id="${b}"]`).click();
    await expect(page.locator('#evHide')).toContainText('Qaytarish');
    await page.click('#evHide');
    await expect(page.locator(`#feed .ev[data-id="${b}"]`)).not.toHaveClass(/vetoed/);
  });

  test('a hidden event leaves the normal feed without a reload', async ({ page, signIn, server }) => {
    const { b } = seedDay(server);
    await signIn('dispatcher', 'darvoza');
    await pick(page, DAY);
    await page.locator(`#feed .ev[data-id="${b}"]`).click();
    await page.click('#evHide');
    await expect(page.locator(`#feed .ev[data-id="${b}"]`)).toHaveCount(0);
  });

  test('direct link from a notification opens the event', async ({ page, signIn, server }) => {
    const { c } = seedDay(server);
    await signIn('dispatcher', `darvoza?event=${c}`);
    await expect(page.locator('.modal h2')).toContainText('01 A 123 BC');
  });

  test('a link to a deleted event: a readable error, the page works', async ({ page, signIn }) => {
    await signIn('dispatcher', 'darvoza?event=99999999');
    await expect(page.locator('.toast.bad')).toContainText('Hodisa topilmadi');
    await expect(page.locator('#gTiles .tile')).toHaveCount(4);
  });

  test('load more: pages through a busy day without duplicates', async ({ page, signIn, server }) => {
    clear(server);
    server.sql((db) => {
      const ins = db.prepare("INSERT INTO gate_events (capture_name, t, direction, camera, channel, plate, plate_raw, plate_valid, status, created_at) VALUES (?, ?, 'in', 'ANPR-1', 4, ?, ?, 0, 'outside', 0)");
      db.exec('BEGIN');
      for (let i = 0; i < 130; i++) ins.run(`more_${i}_${uid()}`, T0 + i * 1000, `P${i}`, `P${i}`);
      db.exec('COMMIT');
    });
    await signIn('dispatcher', 'darvoza');
    await pick(page, DAY);
    await expect(page.locator('#feed .ev')).toHaveCount(60);
    await page.click('#moreBtn');
    await expect(page.locator('#feed .ev')).toHaveCount(120);
    await page.click('#moreBtn');
    await expect(page.locator('#feed .ev')).toHaveCount(130);
    await expect(page.locator('#moreBtn')).toBeHidden();
    const ids = await page.locator('#feed .ev').evaluateAll((e) => e.map((x) => x.dataset.id));
    expect(new Set(ids).size).toBe(130);
    clear(server);
  });

  test('outside vehicle in the yard: listed, without a link; long stays are marked', async ({ page, signIn, server }) => {
    const plate = '01B321CD';
    const id = gateEvent(server, { t: Date.now() - 3 * 3600e3, direction: 'in', plate, status: 'outside' });
    await signIn('dispatcher', 'darvoza');
    const row = page.locator('#inside .inside-row', { hasText: '01 B 321 CD' });
    await expect(row).toContainText('Begona');
    await expect(row).toHaveClass(/long/);
    await expect(row.locator('a')).toHaveCount(0);
    server.run('DELETE FROM gate_events WHERE id = ?', id);
  });

  test('a fleet vehicle in the yard links to its page', async ({ page, signIn }) => {
    await signIn('dispatcher', 'darvoza');
    const link = page.locator('#inside a, #gpsOnly a').first();
    if (await link.count()) {
      await link.click();
      await expect(page).toHaveURL(/#\/transport\/\d+/);
    }
  });
});

test.describe('alerts page', () => {
  const clean = async (owner) => owner.post('/api/alerts/ack-all');

  test('all fields of an alert; link to the vehicle', async ({ page, signIn, owner, server }) => {
    await clean(owner);
    const id = alert(server, { type: 'fuel_drain', severity: 'critical', vehicleId: FLEET.fuel, title: "Yoqilg'i to'kildi: 85 450 KBA", body: '−42 L, 14:05' });
    await signIn('dispatcher', 'ogohlantirish');
    const row = page.locator(`.arow[data-id="${id}"]`);
    await expect(row.locator('.arow-title')).toHaveText("Yoqilg'i to'kildi: 85 450 KBA");
    await expect(row.locator('.arow-body')).toHaveText('−42 L, 14:05');
    await expect(row.locator('.pill')).toHaveText("Yoqilg'i to'kilishi");
    await expect(row.locator('.sev')).toHaveClass(/critical/);
    await expect(row.locator('.sev')).toHaveAttribute('aria-label', 'Muhim');
    await row.locator('.arow-meta a').click();
    await expect(page).toHaveURL(new RegExp(`#/transport/${FLEET.fuel}`));
  });

  test('nothing open: a calm message, the bulk button disabled', async ({ page, signIn, owner }) => {
    await clean(owner);
    await signIn('dispatcher', 'ogohlantirish');
    await expect(page.locator('#alList .empty')).toContainText('Hammasi joyida');
    await expect(page.locator('#alAckAll')).toBeDisabled();
    await expect(page.locator('#alCount')).toHaveText('0 ta ochiq');
  });

  test('acknowledge one: leaves the open list, the bell drops, "Hammasi" shows who', async ({ page, signIn, owner, server }) => {
    await clean(owner);
    const id = alert(server, { title: 'Bitta' });
    await signIn('dispatcher', 'ogohlantirish');
    await expect(page.locator('#bellCount')).toHaveText('1');
    await page.locator(`.arow[data-id="${id}"] [data-ack]`).click();
    await expect(page.locator(`.arow[data-id="${id}"]`)).toHaveCount(0);
    await expect(page.locator('#bellCount')).toBeHidden();
    await page.click('#alState [data-s=all]');
    const row = page.locator(`.arow[data-id="${id}"]`);
    await expect(row).toHaveClass(/acked/);
    await expect(row.locator('.arow-side')).toContainText("Ko'rdi: Dispetcher (demo)");
    await expect(page).toHaveURL(/state=all/);
  });

  test('filter by type: list and URL; a reload keeps it', async ({ page, signIn, owner, server }) => {
    await clean(owner);
    alert(server, { type: 'speeding', title: 'A' });
    alert(server, { type: 'no_signal', title: 'B' });
    await signIn('dispatcher', 'ogohlantirish');
    await expect(page.locator('.arow')).toHaveCount(2);
    await page.selectOption('#alType', 'no_signal');
    await expect(page.locator('.arow')).toHaveCount(1);
    await expect(page.locator('.arow-title')).toHaveText('B');
    await expect(page).toHaveURL(/type=no_signal/);
    await page.reload();
    await expect(page.locator('#alType')).toHaveValue('no_signal');
    await expect(page.locator('.arow')).toHaveCount(1);
  });

  test('acknowledge all: asks first; cancel changes nothing', async ({ page, signIn, owner, server }) => {
    await clean(owner);
    alert(server);
    alert(server);
    await signIn('owner', 'ogohlantirish');
    await page.click('#alAckAll');
    await expect(page.locator('.modal')).toContainText("2 ta ko'rinib turibdi");
    await page.locator('.modal [data-close]').last().click();
    await expect(page.locator('.arow')).toHaveCount(2);
    await page.click('#alAckAll');
    await page.locator('.modal [data-ok]').click();
    await expect(page.locator('.toast', { hasText: "ko'rildi deb belgilandi" })).toBeVisible();
    await expect(page.locator('.arow')).toHaveCount(0);
    await expect(page.locator('#bellCount')).toBeHidden();
  });

  test('a link from a notification highlights that alert, also when already acknowledged', async ({ page, signIn, owner, server }) => {
    await clean(owner);
    const open = alert(server, { title: 'Ochiq' });
    await signIn('dispatcher', `ogohlantirish?id=${open}`);
    await expect(page.locator(`.arow[data-id="${open}"]`)).toHaveClass(/focus/);
    const done = alert(server, { title: 'Yopilgan', ackedAt: Date.now(), ackedBy: 1 });
    await page.evaluate((i) => { location.hash = `#/ogohlantirish?id=${i}`; }, done);
    await expect(page.locator(`.arow[data-id="${done}"]`)).toHaveClass(/focus/);
    await expect(page.locator('#alState [data-s=all]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('a link to an alert that no longer exists: just the list', async ({ page, signIn }) => {
    await signIn('dispatcher', 'ogohlantirish?id=99999999');
    await expect(page.locator('#alCount')).toContainText('ta');
    await expect(page.locator('.arow.focus')).toHaveCount(0);
  });

  test('an update by someone else refreshes an open page', async ({ page, signIn, owner, server }) => {
    await clean(owner);
    const id = alert(server);
    await signIn('dispatcher', 'ogohlantirish');
    await expect(page.locator(`.arow[data-id="${id}"]`)).toBeVisible();
    await owner.post(`/api/alerts/${id}/ack`);
    await expect(page.locator(`.arow[data-id="${id}"]`)).toHaveCount(0);
  });

  test('a failed acknowledgement says so and lets you retry', async ({ page, signIn, owner, server }) => {
    await clean(owner);
    const id = alert(server);
    await signIn('dispatcher', 'ogohlantirish');
    await page.route(`**/api/alerts/${id}/ack`, (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Server xatosi"}' }));
    await page.locator(`.arow[data-id="${id}"] [data-ack]`).click();
    await expect(page.locator('.toast.bad')).toContainText('Server xatosi');
    await expect(page.locator(`.arow[data-id="${id}"] [data-ack]`)).toBeEnabled();
  });
});

test.describe('vehicle page', () => {
  test('without an id: a table of all vehicles; a row opens that vehicle', async ({ page, signIn }) => {
    await signIn('dispatcher', 'transport');
    await expect(page.locator('tbody tr.clickable')).toHaveCount(FLEET.total);
    await page.locator('tbody tr.clickable', { hasText: '85 450 KBA' }).click();
    await expect(page).toHaveURL(new RegExp(`#/transport/${FLEET.fuel}`));
    await expect(page.locator('#pageTitle')).toHaveText('Transport: 85 450 KBA');
  });

  test('an unknown id: back to the table', async ({ page, signIn }) => {
    await signIn('dispatcher', 'transport/999999');
    await expect(page.locator('tbody tr.clickable')).toHaveCount(FLEET.total);
  });

  test('a day: map track, tiles, 14-day charts, timeline', async ({ page, signIn }) => {
    const y = addDays(today(), -1);
    await signIn('dispatcher', `transport/${FLEET.fuel}?day=${y}`);
    await expect(page.locator('#vDay')).toHaveValue(y);
    await expect(page.locator('#dayTiles .tile')).toHaveCount(5);
    await expect(page.locator('#chKm svg')).toBeVisible();
    await expect(page.locator('#chTrips svg')).toBeVisible();
    await expect(page.locator('#vmap .leaflet-overlay-pane path').first()).toBeVisible();
    await expect(page.locator('#timeline .tl-item').first()).toBeVisible();
    await expect(page.locator('#infoCard')).toContainText('85 450 KBA');
    await expect(page).toHaveURL(new RegExp(`day=${y}`));
  });

  test('timeline is in time order', async ({ page, signIn }) => {
    await signIn('dispatcher', `transport/${FLEET.fuel}?day=${addDays(today(), -1)}`);
    await expect(page.locator('#timeline .tl-item').first()).toBeVisible();
    await page.waitForTimeout(700); // the GoGPS report arrives second
    const times = await page.locator('.tl-time').allTextContents();
    expect(times).toEqual([...times].sort());
  });

  test('previous / next day; next is off for today; future can\'t be picked', async ({ page, signIn }) => {
    await signIn('dispatcher', `transport/${FLEET.fuel}`);
    await expect(page.locator('#vDay')).toHaveValue(today());
    await expect(page.locator('#nextDay')).toBeDisabled();
    await expect(page.locator('#vDay')).toHaveAttribute('max', today());
    await page.click('#prevDay');
    await expect(page.locator('#vDay')).toHaveValue(addDays(today(), -1));
    await expect(page.locator('#nextDay')).toBeEnabled();
    await page.click('#nextDay');
    await expect(page.locator('#vDay')).toHaveValue(today());
  });

  test('a month boundary from the arrows', async ({ page, signIn }) => {
    await signIn('dispatcher', `transport/${FLEET.fuel}?day=2026-03-01`);
    await page.click('#prevDay');
    await expect(page.locator('#vDay')).toHaveValue('2026-02-28');
  });

  test('a day with no data says so', async ({ page, signIn }) => {
    await page.route('**/api/vehicles/*/stops*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"moves":[],"stops":[]}' }));
    await signIn('dispatcher', `transport/${FLEET.fuel}?day=2019-05-05`);
    await expect(page.locator('#timeline .empty')).toHaveText("5-may: ma'lumot yo'q");
    await expect(page.locator('#dayTiles .tile').first()).toContainText('0');
  });

  test('choosing another vehicle keeps the day', async ({ page, signIn }) => {
    const y = addDays(today(), -1);
    await signIn('dispatcher', `transport/${FLEET.fuel}?day=${y}`);
    await page.selectOption('#vSel', String(FLEET.fuel2));
    await expect(page.locator('#pageTitle')).toHaveText('Transport: 85 159 YAA');
    await expect(page).toHaveURL(new RegExp(`transport/${FLEET.fuel2}\\?day=${y}`));
  });

  test('a garbage day in the URL: today', async ({ page, signIn }) => {
    await signIn('dispatcher', `transport/${FLEET.fuel}?day=junk`);
    await expect(page.locator('#vDay')).toHaveValue(today());
  });

  test('an impossible day in the URL: today, not a broken page', async ({ page, signIn }) => {
    await signIn('dispatcher', `transport/${FLEET.fuel}?day=2026-13-45`);
    await expect(page.locator('#dayTiles .tile')).toHaveCount(5);
    await expect(page.locator('.toast.bad')).toHaveCount(0);
  });

  test('chart hover shows the day and value', async ({ page, signIn }) => {
    await signIn('dispatcher', `transport/${FLEET.fuel}?day=${addDays(today(), -1)}`);
    await expect(page.locator('#chKm svg')).toBeVisible();
    await page.locator('#chKm g.col').last().hover({ force: true });
    await expect(page.locator('#chKm .tooltip')).toContainText('km');
  });

  test('live link back to the map', async ({ page, signIn }) => {
    await signIn('dispatcher', `transport/${FLEET.fuel}`);
    await page.locator('.page-head a.btn').click();
    await expect(page.locator('#drawer h2')).toHaveText('85 450 KBA');
  });

  test('the excavator (no trips, parked away): the page still reads well', async ({ page, signIn }) => {
    await signIn('dispatcher', `transport/${FLEET.parked}`);
    await expect(page.locator('#infoCard')).toContainText('85 117 АА');
    await expect(page.locator('#dayTiles .tile')).toHaveCount(5);
  });

  test('a report failing: the page says so', async ({ page, signIn }) => {
    await page.route('**/api/vehicles/*/days*', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Server xatosi"}' }));
    await signIn('dispatcher', `transport/${FLEET.fuel}`);
    await expect(page.locator('.toast.bad')).toContainText('Server xatosi');
    await expect(page.locator('#timeline .empty'), 'not "Loading…" forever').not.toHaveText('Yuklanmoqda…');
  });
});
