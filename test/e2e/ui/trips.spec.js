'use strict';
// The Reyslar page.
const fs = require('node:fs');
const { uiTest: test, expect } = require('../support/fixtures');
const { tripTruck } = require('../support/seed');

async function ready(owner, truck) {
  await owner.patch(`/api/gate-events/${truck.out}`, { hidden: false });
  await expect.poll(async () => (await owner.get(`/api/trips?from=${truck.day}&to=${truck.day}&vehicle=${truck.id}`)).data.trips[0]?.inEventId ?? null, { timeout: 30_000 }).toBe(truck.back);
}

test('a dispatcher reaches it from the report tabs, and sees the trip with where it went', async ({ page, signIn, owner, server }) => {
  const truck = tripTruck(server, { name: 'E2E Reys' });
  try {
    await ready(owner, truck);
    await signIn('dispatcher', 'hisobot');
    await page.getByRole('link', { name: 'Reyslar' }).click();
    await expect(page).toHaveURL(/#\/reyslar/);
    await expect(page.locator('#trRows')).toBeVisible();
    await page.goto(`${server.url}/#/reyslar?from=${truck.day}&to=${truck.day}&vehicle=${truck.id}`);
    const row = page.locator(`#trRows tr[data-state=done]`);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('E2E Reys');
    await expect(row).toContainText('24.5');
    await expect(row).toContainText('5 Чинабад улица');
    await expect(row).not.toContainText('Узбекистан');
    await expect(page.locator('#trCount')).toHaveText('1');
    await expect(page.locator('#trDest')).toContainText('5 Чинабад улица');
    await expect(page).toHaveURL(new RegExp(`vehicle=${truck.id}`));
  } finally { truck.done(); }
});

test('a row opens the details, photos of both passes and the stop; it leads to the map of that day', async ({ page, signIn, owner, server }) => {
  const truck = tripTruck(server);
  try {
    await ready(owner, truck);
    await signIn('owner', `reyslar?from=${truck.day}&to=${truck.day}&vehicle=${truck.id}`);
    await page.locator('#trRows tbody tr').first().click();
    const modal = page.locator('.modal');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Chiqish kamerasi');
    await expect(modal).toContainText('Kirish kamerasi');
    await expect(modal.locator('#trStops')).toContainText('40 daq');
    await expect(modal.locator('.photos img')).toHaveCount(2);
    await modal.getByRole('link', { name: "Xaritada ko'rish" }).click();
    await expect(page).toHaveURL(new RegExp(`#/transport/${truck.id}\\?day=${truck.day}`));
    await expect(page.locator('.modal')).toHaveCount(0);
  } finally { truck.done(); }
});

test('filters: by truck, keeping the choice in the address; a keyboard opens a row too', async ({ page, signIn, owner, server }) => {
  const a = tripTruck(server, { name: 'E2E Bir' }), b = tripTruck(server, { name: 'E2E Ikki', t: a.t });
  try {
    await ready(owner, a);
    await ready(owner, b);
    await signIn('owner', `reyslar?from=${a.day}&to=${a.day}&near=1`);
    await expect(page.locator('#trRows')).toContainText('E2E Ikki');
    await page.locator('#trVehicle').selectOption(String(a.id));
    await expect(page.locator('#trRows')).not.toContainText('E2E Ikki');
    await expect(page.locator('#trRows')).toContainText('E2E Bir');
    await expect(page).toHaveURL(new RegExp(`vehicle=${a.id}`));
    await page.locator('#trRows tbody tr').first().focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.modal')).toBeVisible();
  } finally { a.done(); b.done(); }
});

test('CSV: the trips, with decimals as the other reports write them', async ({ page, signIn, owner, server }) => {
  const truck = tripTruck(server, { name: 'E2E CSV' });
  try {
    await ready(owner, truck);
    await signIn('owner', `reyslar?from=${truck.day}&to=${truck.day}&vehicle=${truck.id}`);
    await expect(page.locator('#trRows')).toBeVisible();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#trCsv').click()]);
    expect(dl.suggestedFilename()).toBe(`reyslar_${truck.day}_${truck.day}.csv`);
    const text = fs.readFileSync(await dl.path(), 'utf8');
    expect(text).toContain('E2E CSV');
    expect(text).toContain('24,5');
    expect(text).toContain('5 Чинабад улица');
  } finally { truck.done(); }
});

test('a page left open updates by itself', async ({ page, signIn, owner, server }) => {
  const truck = tripTruck(server);
  try {
    await ready(owner, truck);
    await signIn('owner', `reyslar?from=${truck.day}&to=${truck.day}&vehicle=${truck.id}`);
    await expect(page.locator('#trRows [data-state=done]')).toHaveCount(1);
    await owner.patch(`/api/gate-events/${truck.back}`, { hidden: true });
    await expect(page.locator('#trRows [data-state=no_return], #trRows [data-state=open]')).toHaveCount(1, { timeout: 30_000 });
  } finally { truck.done(); }
});

test('nothing to show says so, and CSV refuses politely', async ({ page, signIn }) => {
  await signIn('owner', 'reyslar?from=2020-03-03&to=2020-03-03');
  await expect(page.locator('#trTable')).toContainText("reys yo'q");
  await page.locator('#trCsv').click();
  await expect(page.locator('.toast')).toContainText("Eksport uchun ma'lumot yo'q");
});
