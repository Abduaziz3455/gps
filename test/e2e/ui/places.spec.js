'use strict';
// Marking a stop as a place on a vehicle's track, seeing its name everywhere, and the Joylar page.
const { uiTest: test, expect } = require('../support/fixtures');
const { FLEET, tashkentDay, addDays, dayStart, uid } = require('../support/seed');

const yesterday = () => addDays(tashkentDay(), -1);

/** A place on the excavator's site: it stands there all day. */
async function sitePlace(owner, o = {}) {
  const { stops } = (await owner.get(`/api/vehicles/${FLEET.parked}/track?day=${yesterday()}`)).data;
  const places = (await owner.get('/api/places')).data;
  for (const p of places) await owner.del(`/api/places/${p.id}`);
  const r = await owner.post('/api/places', { name: `Obyekt ${uid()}`, lat: stops[0].lat, lng: stops[0].lng, ...o });
  expect(r.status).toBe(200);
  return r.data;
}

test.afterEach(async ({ owner }) => {
  for (const p of (await owner.get('/api/places')).data) await owner.del(`/api/places/${p.id}`);
});

test.describe('marking', () => {
  test('owner: click a stop, name it, change its size, save: the name is on the map and the stop', async ({ page, signIn, owner }) => {
    await signIn('owner', `transport/${FLEET.parked}?day=${yesterday()}`);
    const stop = page.locator('#vmap .stop-marker').first();
    await expect(stop).toBeVisible();
    const zoom = () => page.locator('#vmap img.leaflet-tile').first().getAttribute('src').then((s) => Number(/tiles\/(\d+)\//.exec(s)[1]));
    const zoomBefore = await zoom();
    await stop.click({ force: true });

    const panel = page.locator('.place-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-num]')).toHaveValue('150');
    await expect(page.locator('#vmap path.place-draft')).toHaveCount(1);
    await page.waitForTimeout(400);
    expect(await zoom(), 'marking does not zoom the map in').toBeLessThanOrEqual(zoomBefore);

    // The circle follows the size, and the map zooms out so that all of it stays in view.
    const inView = () => page.evaluate(() => {
      const c = document.querySelector('#vmap path.place-draft').getBoundingClientRect(), m = document.querySelector('#vmap').getBoundingClientRect();
      return c.left >= m.left && c.right <= m.right && c.top >= m.top && c.bottom <= m.bottom;
    });
    const d0 = await page.locator('#vmap path.place-draft').getAttribute('d');
    await panel.locator('[data-num]').fill('1500');
    await expect.poll(() => page.locator('#vmap path.place-draft').getAttribute('d')).not.toBe(d0);
    await expect.poll(inView).toBe(true);
    await expect(panel.locator('[data-range]')).toHaveValue('1500');
    await panel.locator('[data-num]').fill('400');

    await panel.locator('[type=submit]').click();
    await expect(panel.locator('[data-error]'), 'a name is required').toBeVisible();

    const n = `Karyer ${uid()}`;
    await panel.locator('[name=name]').fill(n);
    await panel.locator('[type=submit]').click();
    await expect(panel).toHaveCount(0);
    await expect(page.locator('#vmap path.place-draft')).toHaveCount(0);
    await expect(page.locator('#vmap .place-label.named', { hasText: n })).toBeVisible();
    await expect(page.locator('#vmap path.place-area.named')).toHaveCount(1);
    await expect(page.locator('#infoCard')).toContainText(n);

    const saved = (await owner.get('/api/places')).data.find((p) => p.name === n);
    expect(saved.radiusM).toBe(400);
    // The stop's card now counts its trips.
    await expect(page.locator('#placesCard')).toContainText(n);
  });

  test('a stop in a marked place opens that place: rename, resize, delete', async ({ page, signIn, owner }) => {
    const p = await sitePlace(owner);
    await signIn('owner', `transport/${FLEET.parked}?day=${yesterday()}`);
    await page.locator('#vmap .stop-marker').first().click({ force: true });
    const panel = page.locator('.place-panel');
    await expect(panel.locator('[name=name]')).toHaveValue(p.name);
    const renamed = `${p.name} 2`;
    await panel.locator('[name=name]').fill(renamed);
    await panel.locator('[type=submit]').click();
    await expect(page.locator('#vmap .place-label.named', { hasText: renamed })).toBeVisible();

    await page.locator('#vmap .stop-marker').first().click({ force: true });
    await panel.locator('[data-delete]').click();
    await page.locator('.modal [data-ok]').click();
    await expect(page.locator('#vmap .place-label.named')).toHaveCount(0);
    expect((await owner.get('/api/places')).data).toEqual([]);
  });

  test('cancel and Escape leave nothing behind', async ({ page, signIn, owner }) => {
    await signIn('owner', `transport/${FLEET.parked}?day=${yesterday()}`);
    await page.locator('#vmap .stop-marker').first().click({ force: true });
    await page.locator('.place-panel [data-cancel]').first().click();
    await expect(page.locator('.place-panel')).toHaveCount(0);
    await page.locator('#vmap .stop-marker').first().click({ force: true });
    await page.locator('.place-panel [name=name]').press('Escape');
    await expect(page.locator('.place-panel')).toHaveCount(0);
    await expect(page.locator('#vmap path.place-draft')).toHaveCount(0);
    expect((await owner.get('/api/places')).data).toEqual([]);
  });

  test('a name with markup stays text', async ({ page, signIn, owner }) => {
    await sitePlace(owner, { name: '<img src=x onerror=alert(1)>' });
    await signIn('owner', `transport/${FLEET.parked}?day=${yesterday()}`);
    await expect(page.locator('#vmap .place-label.named')).toHaveText('<img src=x onerror=alert(1)>');
    await expect(page.locator('#vmap .place-label img')).toHaveCount(0);
    await page.locator('#vmap .stop-marker').first().hover({ force: true });
    await expect(page.locator('#vmap .leaflet-tooltip img')).toHaveCount(0);
  });

  test('dispatcher: sees the names but cannot mark', async ({ page, signIn, owner }) => {
    const p = await sitePlace(owner);
    await signIn('dispatcher', `transport/${FLEET.parked}?day=${yesterday()}`);
    await expect(page.locator('#vmap .place-label.named', { hasText: p.name })).toBeVisible();
    await page.locator('#vmap .stop-marker').first().click({ force: true });
    await expect(page.locator('.place-panel')).toHaveCount(0);
  });

  test('a stop running past the end of a past day does not say "now"', async ({ page, signIn }) => {
    await signIn('owner', `transport/${FLEET.parked}?day=${yesterday()}`);
    await page.locator('#vmap .stop-marker').first().click({ force: true });
    await expect(page.locator('.place-panel')).toContainText("To'xtash 00:0");
    await expect(page.locator('.place-panel')).not.toContainText('hozir');
  });

  test('stops in the yard cannot be marked', async ({ page, signIn }) => {
    await signIn('owner', `transport/${FLEET.fuel}?day=${yesterday()}`);
    const n = await page.evaluate(async ({ id, day }) => {
      const { inYard } = await import('/js/places.js');
      const r = await fetch(`/api/vehicles/${id}/track?day=${day}`).then((x) => x.json());
      return r.stops.findIndex((s) => inYard(s.lat, s.lng));
    }, { id: FLEET.fuel, day: yesterday() });
    expect(n, 'the simulator parks trucks in the yard').toBeGreaterThanOrEqual(0);
    await page.locator('#vmap .stop-marker').nth(n).click({ force: true });
    await expect(page.locator('.place-panel')).toHaveCount(0);
  });
});

test.describe('suggested places', () => {
  let nth = 0;
  /**
   * Trucks stopping again and again at one new spot, then the search. The simulator scatters its deliveries too widely
   * to form a spot, and how many it has made depends on the time of day. Each spot has its own number of stops.
   */
  async function seedSpot(server, owner) {
    nth++;
    const visits = 5 + nth, lat = 41.29 + nth * 0.006, lng = 69.31;
    for (let i = 0; i < visits; i++) {
      const vehicle = i % 2 ? FLEET.fuel2 : FLEET.mixer;
      const start = dayStart(addDays(tashkentDay(), -(2 + (i % 3) + nth * 3))) + (1 + i * 0.5) * 3600e3; // each spot has its own days
      for (let m = 0; m < 20; m += 2) server.run('INSERT OR REPLACE INTO positions (vehicle_id, t, lat, lng, speed, course, status) VALUES (?, ?, ?, ?, 0, 0, ?)', vehicle, start + m * 60e3, lat, lng, 'stopped');
      server.run('INSERT OR REPLACE INTO positions (vehicle_id, t, lat, lng, speed, course, status) VALUES (?, ?, ?, ?, 20, 0, ?)', vehicle, start + 20 * 60e3, lat + 0.02, lng, 'moving');
    }
    const r = await owner.post('/api/places/common/search', {});
    expect(r.status).toBe(200);
    const c = r.data.find((x) => x.visits === visits && Math.abs(x.lat - lat) < 1e-4);
    expect(c, 'the search found the spot').toBeTruthy();
    expect(c.vehicles).toBe(2);
    return c;
  }
  const rowOf = (page, c) => page.locator('#plSuggest tr[data-c]', { hasText: `${c.visits} marta` }).first();

  test('the owner\'s map stays as it was: only the yard, no suggestion marks', async ({ page, signIn, owner, server }) => {
    await seedSpot(server, owner);
    await signIn('owner', 'xarita');
    await expect(page.locator('.vrow').first()).toBeVisible();
    await expect(page.locator('#map .yard-label')).toHaveCount(1);
    await expect(page.locator('#map .leaflet-places-pane .place-mark')).toHaveCount(0);
    await expect(page.locator('#map .leaflet-overlay-pane path')).toHaveCount(1);
  });

  test('Joylar: see a spot, name it; only then is it on the map', async ({ page, signIn, owner, server }) => {
    const c = await seedSpot(server, owner);
    await signIn('owner', 'joylar');
    const row = rowOf(page, c);
    await expect(row).toContainText('km');

    // A row shows where the spot is before anything is decided.
    await row.locator('td').first().click();
    await expect(row).toHaveClass(/pl-selected/);
    await expect(page.locator('#plMap path.place-draft')).toHaveCount(1);
    await expect(page.locator('.place-panel')).toHaveCount(0);

    await row.locator('[data-name]').click();
    const panel = page.locator('.place-panel');
    await expect(panel).toContainText(`${c.visits} marta`);
    await expect(panel).toContainText('Tavsiya etilgan joy');
    await expect(panel.locator('[data-num]')).toHaveValue('150');
    const foot = await panel.locator('.place-panel-foot').boundingBox();
    expect(foot.height, 'the buttons fit on one line').toBeLessThan(50);
    await expect(page.locator('#plMap path.place-draft'), 'one circle at a time').toHaveCount(1);

    const n = `Obyekt ${uid()}`;
    await panel.locator('[name=name]').fill(n);
    await panel.locator('[type=submit]').click();
    await expect(page.locator('#plTable', { hasText: n })).toBeVisible();
    await expect(page.locator('#plSuggest tr[data-c]', { hasText: `${c.visits} marta` })).toHaveCount(0);
    expect((await owner.get('/api/places/common')).data.some((x) => x.lat === c.lat), 'a named spot is no longer suggested').toBe(false);

    const made = (await owner.get('/api/places')).data.find((p) => p.name === n);
    expect(made.lat).toBe(c.lat);
    const from = addDays(tashkentDay(), -28);
    await expect.poll(async () => (await owner.get(`/api/places/stats?from=${from}`)).data.find((p) => p.id === made.id)?.trips, 'its past visits are counted').toBe(c.visits);

    await page.evaluate(() => { location.hash = '#/xarita'; });
    await expect(page.locator('#map .place-label.named', { hasText: n })).toHaveCount(1);
    await expect(page.locator('#map path.place-area.named')).toHaveCount(1);
  });

  test('Joylar: ignored, it stays away after a reload and a new search', async ({ page, signIn, owner, server }) => {
    const c = await seedSpot(server, owner);
    await signIn('owner', 'joylar');
    await rowOf(page, c).locator('[data-ignore]').click();
    await expect(page.locator('#plSuggest tr[data-c]', { hasText: `${c.visits} marta` })).toHaveCount(0);
    await expect(page.locator('.toast', { hasText: "E'tiborsiz qoldirildi" })).toContainText('yana taklif qilinadi');
    expect((await owner.post('/api/places/common/search', {})).data.some((x) => x.lat === c.lat)).toBe(false);
    await page.reload();
    await page.locator('#app').waitFor({ state: 'visible' });
    await expect(page.locator('#plTable')).toBeVisible();
    await expect(page.locator('#plSuggest tr[data-c]', { hasText: `${c.visits} marta` })).toHaveCount(0);
  });

  test('Joylar: an ignore can be undone from its message', async ({ page, signIn, owner, server }) => {
    const c = await seedSpot(server, owner);
    await signIn('owner', 'joylar');
    const rows = page.locator('#plSuggest tr[data-c]', { hasText: `${c.visits} marta` });
    await rows.first().locator('[data-ignore]').click();
    await expect(rows).toHaveCount(0);
    const msg = page.locator('.toast', { hasText: "E'tiborsiz qoldirildi" });
    await msg.locator('.toast-action', { hasText: 'Qaytarish' }).click();
    await expect(rows).toHaveCount(1);
    await expect(msg).toHaveCount(0);
    await expect(page.locator('.toast', { hasText: 'Qaytarildi' })).toBeVisible();
    expect((await owner.get('/api/places/common/ignored')).data.some((x) => x.lat === c.lat)).toBe(false);
  });

  test('Joylar: the ignored list stays folded; it shows the spot and brings it back', async ({ page, signIn, owner, server }) => {
    const c = await seedSpot(server, owner);
    await owner.post('/api/places/common/hide', { lat: c.lat, lng: c.lng });
    const total = (await owner.get('/api/places/common/ignored')).data.length;
    await signIn('owner', 'joylar');
    const box = page.locator('#plIgnored');
    await expect(box.locator('summary')).toHaveText(`E'tiborsiz qoldirilganlar (${total})`);
    const row = box.locator('tr[data-ig]', { hasText: `${c.visits} marta` });
    await expect(row, 'closed until asked for').toBeHidden();

    await box.locator('summary').click();
    await expect(row).toBeVisible();
    await expect(row).toContainText('km');
    await row.locator('td').first().click();
    await expect(row).toHaveClass(/pl-selected/);
    await expect(page.locator('#plMap path.place-draft')).toHaveCount(1);

    await row.locator('[data-restore]').click();
    await expect(page.locator('#plSuggest tr[data-c]', { hasText: `${c.visits} marta` })).toHaveCount(1);
    await expect(row).toHaveCount(0);
    expect((await owner.get('/api/places/common')).data.some((x) => x.lat === c.lat)).toBe(true);
  });

  test('dispatcher: no suggestions anywhere', async ({ page, signIn, owner, dispatcher, server }) => {
    await seedSpot(server, owner);
    expect((await dispatcher.get('/api/places/common')).status).toBe(403);
    expect((await dispatcher.get('/api/places/common/ignored')).status).toBe(403);
    expect((await dispatcher.post('/api/places/common/restore', { lat: 41, lng: 69 })).status).toBe(403);
    await signIn('dispatcher', 'xarita');
    await expect(page.locator('.vrow').first()).toBeVisible();
    await expect(page.locator('#map .leaflet-places-pane .place-mark')).toHaveCount(0);
    await page.evaluate(() => { location.hash = '#/joylar'; });
    await expect(page.locator('#plTable')).toBeVisible();
    await expect(page.locator('#plSuggest')).toBeHidden();
    await expect(page.locator('#plIgnored')).toBeHidden();
  });

  test('owner: tapping a place\'s name on the live map opens it', async ({ page, signIn, owner }) => {
    // Away from the simulator's sites: a truck standing on a place's name takes the tap, as trucks always have.
    const name = `Joy ${uid()}`;
    expect((await owner.post('/api/places', { name, lat: 41.30, lng: 69.385 })).status).toBe(200);
    await signIn('owner', 'xarita');
    await page.locator('#map .place-label.named', { hasText: name }).click();
    await expect(page.locator('.place-panel [name=name]')).toHaveValue(name);
    await page.locator('.place-panel [data-cancel]').first().click();
    await expect(page.locator('.place-panel')).toHaveCount(0);
  });
});

test.describe('names instead of addresses', () => {
  test('the live list and the card say the name; the address is still there', async ({ page, signIn, owner }) => {
    const p = await sitePlace(owner);
    await signIn('dispatcher', `xarita?v=${FLEET.parked}`);
    await expect(page.locator(`.vrow[data-id="${FLEET.parked}"] .vmeta`)).toContainText(p.name);
    await expect(page.locator('#drawer')).toContainText(p.name);
    await expect(page.locator('#drawer dl')).toContainText('Manzil');
    await expect(page.locator('#map .place-label.named', { hasText: p.name })).toBeVisible();
  });

  test('an open page follows a new place without a reload', async ({ page, signIn, owner }) => {
    await signIn('dispatcher', 'xarita');
    await expect(page.locator('#map .place-label.named')).toHaveCount(0);
    const p = await sitePlace(owner);
    await expect(page.locator('#map .place-label.named', { hasText: p.name })).toHaveCount(1);
    await expect(page.locator(`.vrow[data-id="${FLEET.parked}"] .vmeta`)).toContainText(p.name);
    await owner.del(`/api/places/${p.id}`);
    await expect(page.locator('#map .place-label.named')).toHaveCount(0);
  });

  test('the timeline names a stop in a place', async ({ page, signIn, owner }) => {
    const p = await sitePlace(owner);
    await signIn('dispatcher', `transport/${FLEET.parked}?day=${yesterday()}`);
    await expect(page.locator('#timeline', { hasText: p.name })).toBeVisible();
  });

  test('names never cover a truck: their layer is under the markers', async ({ page, signIn, owner }) => {
    await sitePlace(owner);
    await signIn('dispatcher', 'xarita');
    await expect(page.locator('#map .place-label.named')).toHaveCount(1);
    const z = await page.evaluate(() => ({
      place: Number(getComputedStyle(document.querySelector('.leaflet-places-pane')).zIndex),
      markers: Number(getComputedStyle(document.querySelector('.leaflet-marker-pane')).zIndex),
      clicks: getComputedStyle(document.querySelector('.place-label.named')).pointerEvents,
    }));
    expect(z.place).toBeLessThan(z.markers);
    expect(z.clicks).toBe('none');
  });
});

test.describe('Joylar page', () => {
  test('no places yet: says how to start', async ({ page, signIn }) => {
    await signIn('owner', 'joylar');
    await expect(page.locator('#plTable .empty')).toContainText("to'xtash nuqtasini");
    await expect(page.locator('#plDetail')).toBeHidden();
  });

  test('trips per place; a row shows who came; the owner can edit; a vehicle opens', async ({ page, signIn, owner }) => {
    const p = await sitePlace(owner);
    const y = yesterday();
    await expect.poll(async () => (await owner.get(`/api/places/stats?from=${y}&to=${y}`)).data[0].trips, { timeout: 20_000 }).toBeGreaterThan(0);
    await signIn('owner', `joylar?from=${y}&to=${y}`);
    const row = page.locator(`#plTable tr[data-id="${p.id}"]`);
    await expect(row).toContainText(p.name);
    await row.click();
    await expect(page).toHaveURL(new RegExp(`place=${p.id}`));
    const v = page.locator(`#plDetail tr[data-v="${FLEET.parked}"]`);
    await expect(v).toBeVisible();

    await page.click('#plEdit');
    await page.locator('.place-panel [data-num]').fill('300');
    await page.locator('.place-panel [type=submit]').click();
    await expect(row).toContainText('300 m');

    await v.click();
    await expect(page).toHaveURL(new RegExp(`#/transport/${FLEET.parked}`));
  });

  test('dispatcher: reads, no edit button', async ({ page, signIn, owner }) => {
    const p = await sitePlace(owner);
    await signIn('dispatcher', `joylar?place=${p.id}`);
    await expect(page.locator('#plDetail h3')).toHaveText(p.name);
    await expect(page.locator('#plEdit')).toHaveCount(0);
  });

  test('the period is kept in the URL', async ({ page, signIn, owner }) => {
    await sitePlace(owner);
    await signIn('owner', 'joylar');
    await page.click('#plRangeCtl [data-p=d7]');
    await expect(page).toHaveURL(new RegExp(`from=${addDays(tashkentDay(), -6)}`));
  });
});

test.describe('vehicle page: period numbers', () => {
  test('average fuel per 100 km and utilization, the same as the API', async ({ page, signIn, dispatcher }) => {
    const y = yesterday(), from = addDays(y, -13);
    const s = (await dispatcher.get(`/api/vehicles/${FLEET.fuel}/summary?from=${from}&to=${y}`)).data;
    await signIn('dispatcher', `transport/${FLEET.fuel}?day=${y}`);
    await expect(page.locator('#tileUse .tile-value')).toContainText(`${s.utilization}`);
    await expect(page.locator('#tileUse .tile-sub')).toContainText(`${s.activeDays} kun ishladi`);
    await expect(page.locator('#tileFuel100')).toContainText('L/100 km');
    if (s.fuelPer100 != null) await expect(page.locator('#tileFuel100 .tile-value')).toContainText(String(s.fuelPer100));
  });

  test('no fuel sensor: says so instead of a zero', async ({ page, signIn }) => {
    await signIn('dispatcher', `transport/${FLEET.mixer}`);
    await expect(page.locator('#tileFuel100 .tile-sub')).toContainText("yoqilg'i ma'lumoti yo'q");
    await expect(page.locator('#tileFuel100 .tile-value')).toContainText('—');
  });

  test('the numbers failing to load does not break the page', async ({ page, signIn }) => {
    await page.route('**/api/vehicles/*/summary*', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }));
    await signIn('dispatcher', `transport/${FLEET.fuel}`);
    await expect(page.locator('#dayTiles .tile')).toHaveCount(5);
    await expect(page.locator('#avgTiles .tile')).toHaveCount(0);
  });
});
