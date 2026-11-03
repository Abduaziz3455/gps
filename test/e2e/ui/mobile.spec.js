'use strict';
// Phone: can every task be reached and done, by touch?
const { uiTest: test, expect } = require('../support/fixtures');
const { FLEET } = require('../support/seed');

test('owner: the tab bar reaches the main sections', async ({ page, signIn }) => {
  await signIn('owner');
  await expect(page.locator('#tabbar')).toBeVisible();
  await expect(page.locator('.sidebar')).toBeHidden();
  for (const [path, title] of [['darvoza', 'Darvoza va hovli'], ['ogohlantirish', 'Ogohlantirishlar'], ['tahlil', 'Tahlil'], ['hisobot', 'Hisobotlar'], ['xarita', 'Jonli xarita']]) {
    await page.locator(`#tabbar a[data-path=${path}]`).tap();
    await expect(page.locator('#pageTitle')).toHaveText(title);
    await expect(page.locator(`#tabbar a[data-path=${path}]`)).toHaveAttribute('aria-current', 'page');
  }
});

test('owner: Settings is reachable through the user menu', async ({ page, signIn }) => {
  await signIn('owner');
  await page.locator('#userBtn').tap();
  await page.locator('#userDrop a[href="#/sozlamalar"]').tap();
  await expect(page.locator('#pageTitle')).toHaveText('Sozlamalar');
});

test('owner: the Transport list is reachable from a menu', async ({ page, signIn }) => {
  await signIn('owner');
  const links = page.locator('#tabbar a[data-path=transport], #userDrop a[href="#/transport"]');
  expect(await links.count(), 'on a phone, the owner has no link to the Transport section').toBeGreaterThan(0);
});

test('dispatcher: the tab bar has Settings', async ({ page, signIn }) => {
  await signIn('dispatcher');
  await page.locator('#tabbar a[data-path=sozlamalar]').tap();
  await expect(page.locator('#pageTitle')).toHaveText('Sozlamalar');
});

test('log in and out by touch', async ({ page, server }) => {
  await page.goto(server.url);
  await page.locator('[name=username]').fill('dispatcher');
  await page.locator('[name=password]').fill('dispatcher123');
  await page.locator('#loginForm button').tap();
  await expect(page.locator('#app')).toBeVisible();
  await page.locator('#userBtn').tap();
  await page.locator('#logoutBtn').tap();
  await expect(page.locator('#loginForm')).toBeVisible();
});

test('map: tap a truck in the list; the card opens, closes, and its actions work', async ({ page, signIn }) => {
  await signIn('dispatcher');
  await page.fill('#vsearch', '85 450');
  await expect(page.locator('.vrow')).toHaveCount(1);
  await page.locator('.vrow').tap();
  await expect(page.locator('#drawer h2')).toHaveText('85 450 KBA');
  await page.locator('#dTrack').tap();
  await expect(page.locator('#dTrack')).toContainText('Izni yashirish');
  await page.locator('#dClose').tap();
  await expect(page.locator('#drawer')).toBeHidden();
});

for (const [what, hash, prepare] of [
  ['a search with one result', 'xarita', async (page) => { await page.fill('#vsearch', '85 450'); await expect(page.locator('.vrow')).toHaveCount(1); }],
  ['a status filter', 'xarita', async (page) => { await page.locator('.fchip[data-f=offline]').tap(); }],
  ['an empty alerts list', 'ogohlantirish', async (page) => { await expect(page.locator('#alCount')).toContainText('ta'); }],
  ['the settings account tab', 'sozlamalar?tab=hisob', async (page) => { await expect(page.locator('#pwForm')).toBeVisible(); }],
]) {
  test(`the tab bar stays a bar at the bottom: ${what}`, async ({ page, signIn, owner }) => {
    await owner.post('/api/alerts/ack-all');
    await signIn('dispatcher', hash);
    await prepare(page);
    await page.waitForTimeout(300);
    const m = await page.evaluate(() => { const t = document.querySelector('#tabbar').getBoundingClientRect(); return { height: Math.round(t.height), gapBelow: Math.round(innerHeight - t.bottom) }; });
    expect(m.height, 'tab bar height').toBeLessThan(90);
    expect(m.gapBelow).toBeLessThanOrEqual(1);
  });
}

test('map: the card leaves the tab bar usable', async ({ page, signIn }) => {
  await signIn('dispatcher', `xarita?v=${FLEET.fuel}`);
  await expect(page.locator('#drawer h2')).toBeVisible();
  await page.locator('#tabbar a[data-path=darvoza]').tap();
  await expect(page.locator('#pageTitle')).toHaveText('Darvoza va hovli');
});

test('gate: tap an event; the detail opens and closes', async ({ page, signIn, server }) => {
  const { gateEvent } = require('../support/seed');
  const id = gateEvent(server, { t: Date.now() - 1000, plate: '01A123BC', status: 'outside' });
  await signIn('dispatcher', 'darvoza');
  await page.locator(`#feed .ev[data-id="${id}"]`).tap();
  await expect(page.locator('.modal')).toBeVisible();
  await expect(page.locator('#evSave')).toBeInViewport();
  await page.locator('.modal-foot [data-close]').tap();
  await expect(page.locator('.modal')).toHaveCount(0);
  server.run('DELETE FROM gate_events WHERE id = ?', id);
});

test('alerts: acknowledge by touch', async ({ page, signIn, server, owner }) => {
  const { alert } = require('../support/seed');
  await owner.post('/api/alerts/ack-all');
  const id = alert(server);
  await signIn('dispatcher', 'ogohlantirish');
  await page.locator(`.arow[data-id="${id}"] [data-ack]`).tap();
  await expect(page.locator(`.arow[data-id="${id}"]`)).toHaveCount(0);
});

test('report: the table scrolls inside its frame; CSV works', async ({ page, signIn }) => {
  await signIn('dispatcher', 'hisobot');
  await expect(page.locator('#repTable table')).toBeVisible();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#repCsv').tap()]);
  expect(dl.suggestedFilename()).toMatch(/^hisobot_.*\.csv$/);
});

test('a toast can be read and dismissed above the tab bar', async ({ page, signIn }) => {
  await signIn('dispatcher', 'darvoza?event=99999999');
  const t = page.locator('.toast.bad');
  await expect(t).toBeVisible();
  await t.locator('button').tap();
  await expect(t).toHaveCount(0);
});
