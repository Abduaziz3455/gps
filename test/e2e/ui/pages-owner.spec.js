'use strict';
// Analytics, reports and settings.
const fs = require('node:fs');
const { uiTest: test, expect } = require('../support/fixtures');
const { Api } = require('../support/api');
const { uid, stats, FLEET, tashkentDay, addDays } = require('../support/seed');

const today = () => tashkentDay();

test.describe('analytics', () => {
  test('headline numbers, chart, attention list and ranking load', async ({ page, signIn }) => {
    await signIn('owner', 'tahlil');
    await expect(page.locator('#anKpis .tile')).toHaveCount(4);
    await expect(page.locator('#anChart svg')).toBeVisible();
    await expect(page.locator('#anTable tbody tr').first()).toBeVisible();
    await expect(page.locator('#anRange')).toContainText('oldingi 7 kunga nisbatan');
    await expect(page.locator('#anPreset [data-p=d7]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('presets: range, URL and pressed button all follow', async ({ page, signIn }) => {
    await signIn('owner', 'tahlil');
    await expect(page.locator('#anKpis .tile')).toHaveCount(4);
    await page.click('#anPreset [data-p=d30]');
    await expect(page.locator('#anRange')).toContainText('oldingi 30 kunga');
    await expect(page).toHaveURL(new RegExp(`from=${addDays(today(), -29)}&to=${today()}`));
    await expect(page.locator('#anPreset [data-p=d30]')).toHaveAttribute('aria-pressed', 'true');
    await page.click('#anPreset [data-p=today]');
    await expect(page.locator('#anRange')).toContainText('oldingi 1 kunga');
  });

  test('the period survives a reload', async ({ page, signIn }) => {
    await signIn('owner', 'tahlil?from=2026-01-01&to=2026-01-31');
    await expect(page.locator('#anRange')).toContainText('1-yanvar');
    await page.reload();
    await expect(page.locator('#anRange')).toContainText('31-yanvar 2026');
    await expect(page.locator('#anPreset [aria-pressed=true]')).toHaveCount(0);
  });

  test('numbers on the tiles match the API', async ({ page, signIn, owner }) => {
    const from = addDays(today(), -7), to = addDays(today(), -1);
    await signIn('owner', `tahlil?from=${from}&to=${to}`);
    const ov = (await owner.get(`/api/analytics/overview?from=${from}&to=${to}`)).data.current;
    await expect(page.locator('#anKpis .tile').nth(0).locator('.tile-value')).toHaveText(ov.trips.toLocaleString('ru-RU').replace(/,/g, '.'));
    expect(ov.trips).toBeGreaterThan(0);
  });

  test('change against the previous period: arrow and percent, right colour for fuel', async ({ page, signIn, server }) => {
    const a = '2020-07-02', b = '2020-07-01';
    stats(server, a, FLEET.fuel, { km: 200, fuel_used: 100, trips_out: 10, trips_in: 10 });
    stats(server, b, FLEET.fuel, { km: 100, fuel_used: 50, trips_out: 5, trips_in: 5 });
    await signIn('owner', `tahlil?from=${a}&to=${a}`);
    const tiles = page.locator('#anKpis .tile');
    await expect(tiles.nth(0).locator('.delta')).toHaveText('▲ 100%');
    await expect(tiles.nth(0).locator('.delta')).toHaveClass(/up/);
    await expect(tiles.nth(2).locator('.delta'), 'more fuel is worse').toHaveClass(/down/);
    await expect(tiles.nth(2)).toContainText('50.0 L/100 km');
  });

  test('metric switch: chart title and bars change', async ({ page, signIn }) => {
    await signIn('owner', 'tahlil');
    await expect(page.locator('#chTitle')).toHaveText('Kunlik reyslar');
    await page.click('#anMetric [data-m=km]');
    await expect(page.locator('#chTitle')).toHaveText('Kunlik masofa, km');
    await expect(page.locator('#anChart svg')).toBeVisible();
    await page.locator('#anChart g.col').last().hover({ force: true });
    await expect(page.locator('#anChart .tooltip')).toContainText('km');
  });

  test('an empty period: dashes and messages, not zeros pretending to be data, and no error', async ({ page, signIn }) => {
    await signIn('owner', 'tahlil?from=2019-02-01&to=2019-02-03');
    await expect(page.locator('#anChart .empty')).toHaveText("Bu davrda ma'lumot yo'q");
    await expect(page.locator('#anTable .empty')).toHaveText("Bu davrda ishlagan transport yo'q");
    await expect(page.locator('#anKpis .tile').nth(2).locator('.tile-value')).toHaveText('—');
  });

  test('attention list: fuel drains link to the filtered alerts', async ({ page, signIn, server }) => {
    const day = '2020-07-05';
    const t = Date.parse(`${day}T05:00:00Z`);
    server.run("INSERT OR REPLACE INTO fuel_events (vehicle_id, t, kind, litres) VALUES (?, ?, 'drain', 42)", FLEET.fuel, t);
    stats(server, day, FLEET.fuel, { km: 10, drain_l: 42 });
    await signIn('owner', `tahlil?from=${day}&to=${day}`);
    const item = page.locator('.att.bad');
    await expect(item).toContainText("Yoqilg'i to'kildi: 1 marta, jami 42 L");
    await item.locator('a').click();
    await expect(page).toHaveURL(/ogohlantirish\?state=all&type=fuel_drain/);
    await expect(page.locator('#alType')).toHaveValue('fuel_drain');
  });

  test('attention list: vehicles over their fuel norm are named', async ({ page, signIn, server, owner }) => {
    const day = '2020-07-06';
    stats(server, day, FLEET.fuel2, { km: 100, fuel_used: 60, trips_out: 1 });
    await owner.patch(`/api/vehicles/${FLEET.fuel2}`, { fuelNorm: 40 });
    try {
      await signIn('owner', `tahlil?from=${day}&to=${day}`);
      await expect(page.locator('.att.warn', { hasText: "normadan ko'p" })).toContainText('85 159 YAA');
    } finally { await owner.patch(`/api/vehicles/${FLEET.fuel2}`, { fuelNorm: null }); }
  });

  test('ranking: most trips first; a row opens the vehicle; full table link keeps the period', async ({ page, signIn }) => {
    const from = addDays(today(), -7), to = addDays(today(), -1);
    await signIn('owner', `tahlil?from=${from}&to=${to}`);
    await expect(page.locator('#anTable tbody tr').first()).toBeVisible();
    const trips = (await page.locator('#anTable tbody tr td:nth-child(2)').allTextContents()).map(Number);
    expect(trips).toEqual([...trips].sort((a, b) => b - a));
    await expect(page.locator('#anFull')).toHaveAttribute('href', `#/hisobot?from=${from}&to=${to}`);
    await page.locator('#anTable tbody tr').first().click();
    await expect(page).toHaveURL(/#\/transport\/\d+/);
  });

  test('a garbage period in the URL: the default', async ({ page, signIn }) => {
    await signIn('owner', 'tahlil?from=junk&to=x');
    await expect(page.locator('#anPreset [data-p=d7]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('reversed dates in the URL: the default', async ({ page, signIn }) => {
    await signIn('owner', 'tahlil?from=2026-02-02&to=2026-02-01');
    await expect(page.locator('#anPreset [data-p=d7]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('impossible dates in the URL: no broken page', async ({ page, signIn }) => {
    await signIn('owner', 'tahlil?from=2026-13-45&to=2026-13-46');
    await expect(page.locator('#anRange')).not.toContainText('undefined');
    await expect(page.locator('.toast.bad')).toHaveCount(0);
  });

  test('a server error: a message, the page survives', async ({ page, signIn }) => {
    await page.route('**/api/analytics/series*', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Server xatosi"}' }));
    await signIn('owner', 'tahlil');
    await expect(page.locator('.toast.bad')).toContainText('Server xatosi');
  });

  test('switching presets fast: the last click wins', async ({ page, signIn }) => {
    await signIn('owner', 'tahlil');
    await expect(page.locator('#anKpis .tile')).toHaveCount(4);
    await page.route('**/api/analytics/overview*today*', (r) => r.continue());
    await page.click('#anPreset [data-p=d30]');
    await page.click('#anPreset [data-p=today]');
    await page.click('#anPreset [data-p=d7]');
    await expect(page.locator('#anRange')).toContainText('oldingi 7 kunga');
  });
});

test.describe('reports', () => {
  const FROM = '2020-08-10', TO = '2020-08-11';
  const seedRange = (server) => {
    stats(server, FROM, FLEET.fuel, { km: 100.5, engine_s: 36000, idle_s: 3600, fuel_used: 40, refuel_l: 100, drain_l: 12, trips_out: 2, trips_in: 3, turnaround_s: 1800, max_speed: 90 });
    stats(server, TO, FLEET.fuel, { km: 50, engine_s: 18000, idle_s: 1800, fuel_used: 20, trips_out: 1, trips_in: 1, max_speed: 70 });
    stats(server, FROM, FLEET.fuel2, { km: 200, engine_s: 7200, trips_out: 1, trips_in: 1 });
  };
  const open = async (page, signIn, role = 'dispatcher') => {
    await signIn(role, `hisobot?from=${FROM}&to=${TO}`);
    await expect(page.locator('#repTable table')).toBeVisible();
  };
  const cell = (page, id, key) => {
    const idx = ['label', 'trips', 'km', 'engineHours', 'idleShare', 'fuelUsed', 'fuelPer100', 'refuelL', 'drainL', 'maxSpeed', 'turnaroundMin', 'activeDays'].indexOf(key) + 1;
    return page.locator(`#repTable tbody tr[data-id="${id}"] td:nth-child(${idx})`);
  };

  test('dispatchers can open it: one row per active vehicle, a totals row', async ({ page, signIn, server }) => {
    seedRange(server);
    await open(page, signIn);
    await expect(page.locator('#repTable tbody tr')).toHaveCount(FLEET.total);
    await expect(page.locator('#repTable tfoot td').first()).toHaveText(`Jami: ${FLEET.total} ta`);
    await expect(page.locator('#repTitle')).toHaveText('Hisobot: 10-avgust – 11-avgust 2020');
  });

  test('cells show the exact figures', async ({ page, signIn, server }) => {
    seedRange(server);
    await open(page, signIn);
    await expect(cell(page, FLEET.fuel, 'trips')).toHaveText('4');
    await expect(cell(page, FLEET.fuel, 'km')).toHaveText('150.5');
    await expect(cell(page, FLEET.fuel, 'engineHours')).toHaveText('15.0');
    await expect(cell(page, FLEET.fuel, 'fuelUsed')).toHaveText('60.0');
    await expect(cell(page, FLEET.fuel, 'fuelPer100')).toHaveText('39.9');
    await expect(cell(page, FLEET.fuel, 'maxSpeed')).toHaveText('90');
    await expect(cell(page, FLEET.fuel, 'activeDays')).toHaveText('2/2');
    await expect(cell(page, FLEET.fuel2, 'fuelUsed'), 'no fuel sensor').toHaveText('—');
  });

  test('totals: summed figures add up; shares are weighted, not summed', async ({ page, signIn, server }) => {
    seedRange(server);
    await open(page, signIn);
    const foot = page.locator('#repTable tfoot td');
    await expect(foot.nth(1)).toHaveText('5');
    await expect(foot.nth(2)).toHaveText('350.5');
    await expect(foot.nth(3)).toHaveText('17.0');
    await expect(foot.nth(5)).toHaveText('60.0');
    await expect(foot.nth(6), 'L/100 km over the km of vehicles with sensors').toHaveText('39.9');
    await expect(foot.nth(9), 'highest speed, not a sum').toHaveText('90');
  });

  test('drains and over-norm are flagged in red', async ({ page, signIn, server, owner }) => {
    seedRange(server);
    await owner.patch(`/api/vehicles/${FLEET.fuel}`, { fuelNorm: 30 });
    try {
      await open(page, signIn);
      await expect(cell(page, FLEET.fuel, 'drainL')).toHaveClass(/warn-cell/);
      await expect(cell(page, FLEET.fuel, 'fuelPer100')).toHaveClass(/warn-cell/);
      await expect(cell(page, FLEET.fuel, 'fuelPer100')).toHaveAttribute('title', /Norma: 30.0/);
    } finally { await owner.patch(`/api/vehicles/${FLEET.fuel}`, { fuelNorm: null }); }
  });

  test('sorting: click toggles direction; keyboard works; missing values stay last', async ({ page, signIn, server }) => {
    seedRange(server);
    await open(page, signIn);
    const th = page.locator('th[data-k=km]');
    await th.click();
    await expect(page.locator('th[data-k=km]')).toHaveAttribute('aria-sort', 'descending');
    await expect(page.locator('#repTable tbody tr').first()).toHaveAttribute('data-id', String(FLEET.fuel2));
    await page.locator('th[data-k=km]').click();
    await expect(page.locator('th[data-k=km]')).toHaveAttribute('aria-sort', 'ascending');
    await page.locator('th[data-k=label]').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('th[data-k=label]')).toHaveAttribute('aria-sort', 'ascending');
    await expect(page.locator('th[data-k=label]'), 'focus stays on the header').toBeFocused();
    await page.locator('th[data-k=fuelUsed]').click();
    const lastCells = await page.locator('#repTable tbody tr td:nth-child(6)').allTextContents();
    expect(lastCells[lastCells.length - 1]).toBe('—');
    expect(lastCells[0]).toBe('60.0');
  });

  test('a row opens the vehicle; so does Enter', async ({ page, signIn, server }) => {
    seedRange(server);
    await open(page, signIn);
    await page.locator(`#repTable tbody tr[data-id="${FLEET.fuel}"]`).click();
    await expect(page).toHaveURL(new RegExp(`#/transport/${FLEET.fuel}`));
    await page.goBack();
    await expect(page.locator('#repTable table')).toBeVisible();
    await page.locator(`#repTable tbody tr[data-id="${FLEET.fuel2}"]`).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`#/transport/${FLEET.fuel2}`));
  });

  test('presets: table and URL follow; the page opens on today', async ({ page, signIn }) => {
    await signIn('dispatcher', 'hisobot');
    await expect(page.locator('[data-p=today]')).toHaveAttribute('aria-pressed', 'true');
    await page.click('[data-p=yesterday]');
    const y = addDays(today(), -1);
    await expect(page).toHaveURL(new RegExp(`from=${y}&to=${y}`));
    await page.click('[data-p=lastMonth]');
    const end = addDays(`${today().slice(0, 8)}01`, -1);
    await expect(page).toHaveURL(new RegExp(`from=${end.slice(0, 8)}01&to=${end}`));
    await page.click('[data-p=month]');
    await expect(page).toHaveURL(new RegExp(`from=${today().slice(0, 8)}01&to=${today()}`));
  });

  test('typed dates: applied; a reversed range is corrected; future is capped', async ({ page, signIn }) => {
    await signIn('dispatcher', 'hisobot');
    const from = page.locator('[data-from]'), to = page.locator('[data-to]');
    await expect(from).toHaveAttribute('max', today());
    await to.fill('2026-02-10');
    await to.dispatchEvent('change');
    await expect(from).toHaveValue('2026-02-10');
    await from.fill('2026-03-01');
    await from.dispatchEvent('change');
    await expect(to, 'from past to: to moves along').toHaveValue('2026-03-01');
    await expect(page.locator('#repTitle')).toContainText('1-mart');
  });

  test('over 400 days: the server\'s message is shown', async ({ page, signIn }) => {
    await signIn('dispatcher', 'hisobot?from=2022-01-01&to=2025-01-01');
    await expect(page.locator('.toast.bad')).toContainText('400 kundan');
  });

  test('CSV: name, BOM, separator, decimal comma, totals; quotes are handled', async ({ page, signIn, server, owner }) => {
    seedRange(server);
    await owner.patch(`/api/vehicles/${FLEET.fuel}`, { display: 'Mikser; "31"' });
    try {
      await open(page, signIn);
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#repCsv')]);
      expect(dl.suggestedFilename()).toBe(`hisobot_${FROM}_${TO}.csv`);
      const raw = fs.readFileSync(await dl.path());
      expect([...raw.subarray(0, 3)], 'UTF-8 BOM for Excel').toEqual([0xef, 0xbb, 0xbf]);
      const lines = raw.toString('utf8').slice(1).split('\r\n');
      expect(lines.length).toBe(FLEET.total + 2);
      expect(lines[0].split(';').slice(0, 3)).toEqual(['Transport', 'GPS nomi', 'Reys']);
      const row = lines.find((l) => l.startsWith('"Mikser; ""31"""'));
      expect(row, 'a name with ; and " stays in one cell').toBeTruthy();
      expect(row).toContain('150,5');
      expect(lines[lines.length - 1].startsWith('Jami;')).toBe(true);
    } finally { await owner.patch(`/api/vehicles/${FLEET.fuel}`, { display: '' }); }
  });

  test('CSV: a vehicle name can\'t become a spreadsheet formula', async ({ page, signIn, server, owner }) => {
    seedRange(server);
    await owner.patch(`/api/vehicles/${FLEET.fuel}`, { display: '=HYPERLINK("http://x")' });
    try {
      await open(page, signIn);
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#repCsv')]);
      const text = fs.readFileSync(await dl.path(), 'utf8');
      expect(text.split('\r\n').some((l) => /^"?=/.test(l.replace(/^﻿/, ''))), 'cells starting with = run in Excel').toBe(false);
    } finally { await owner.patch(`/api/vehicles/${FLEET.fuel}`, { display: '' }); }
  });

  test('CSV follows the current sort', async ({ page, signIn, server }) => {
    seedRange(server);
    await open(page, signIn);
    await page.locator('th[data-k=km]').click();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#repCsv')]);
    const lines = fs.readFileSync(await dl.path(), 'utf8').split('\r\n');
    expect(lines[1].startsWith('85 159 YAA')).toBe(true);
  });

  test('print calls the browser\'s print, with the controls hidden', async ({ page, signIn, server }) => {
    seedRange(server);
    await open(page, signIn);
    await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
    await page.click('#repPrint');
    expect(await page.evaluate(() => window.__printed)).toBe(1);
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('#repCsv')).toBeHidden();
    await expect(page.locator('#repMade')).toContainText(`${FLEET.total} ta transport`);
    await expect(page.locator('#repTable table')).toBeVisible();
  });
});

test.describe('settings: tabs', () => {
  test('owner: five tabs. Dispatcher: two, and direct links to the others fall back', async ({ page, signIn }) => {
    await signIn('dispatcher', 'sozlamalar?tab=foydalanuvchilar');
    await expect(page.locator('[role=tab]')).toHaveText(['Bildirishnomalar', 'Hisob']);
    await expect(page.locator('[role=tab][aria-selected=true]')).toHaveText('Bildirishnomalar');
  });

  test('clicks and arrow keys switch tabs; the URL follows; a reload keeps it', async ({ page, signIn }) => {
    await signIn('owner', 'sozlamalar');
    await expect(page.locator('[role=tab]')).toHaveCount(5);
    await page.click('#tab-hisob');
    await expect(page).toHaveURL(/tab=hisob/);
    await expect(page.locator('#setPanel')).toContainText("Parolni o'zgartirish");
    await page.locator('#tab-hisob').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#tab-foydalanuvchilar')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#tab-foydalanuvchilar')).toBeFocused();
    await page.reload();
    await expect(page.locator('#tab-foydalanuvchilar')).toHaveAttribute('aria-selected', 'true');
    await page.locator('#tab-foydalanuvchilar').focus();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('#tab-tizim'), 'wraps around').toHaveAttribute('aria-selected', 'true');
  });
});

test.describe('settings: my password', () => {
  const account = async (owner) => {
    const username = `pw${uid()}`;
    await owner.post('/api/users', { username, name: 'Parol Sinov', role: 'dispatcher', password: 'old-password-1' });
    return { username, password: 'old-password-1' };
  };
  const fill = async (page, c, p, r) => { await page.fill('#pwForm [name=current]', c); await page.fill('#pwForm [name=password]', p); await page.fill('#pwForm [name=repeat]', r); await page.click('#pwForm [type=submit]'); };

  for (const [name, c, p, r, msg] of [
    ['no current password', '', 'new-password-1', 'new-password-1', 'Joriy parolni kiriting'],
    ['too short', 'old-password-1', 'short', 'short', 'kamida 8'],
    ['not matching', 'old-password-1', 'new-password-1', 'new-password-2', 'mos kelmadi'],
    ['wrong current', 'wrong-password', 'new-password-1', 'new-password-1', "noto'g'ri"],
  ]) {
    test(`refused with a message: ${name}`, async ({ page, signIn, owner }) => {
      await signIn(await account(owner), 'sozlamalar?tab=hisob');
      await fill(page, c, p, r);
      await expect(page.locator('#pwForm .form-error')).toContainText(msg);
      await expect(page.locator('#pwForm [type=submit]')).toBeEnabled();
    });
  }

  test('success: confirmation, back to login, the new password works', async ({ page, signIn, owner, server }) => {
    const acc = await account(owner);
    await signIn(acc, 'sozlamalar?tab=hisob');
    await expect(page.locator('#setPanel')).toContainText('Parol Sinov');
    await fill(page, acc.password, 'new-password-1', 'new-password-1');
    await expect(page.locator('.toast', { hasText: "Parol o'zgartirildi" })).toBeVisible();
    await expect(page.locator('#loginForm')).toBeVisible({ timeout: 10_000 });
    await page.fill('[name=username]', acc.username);
    await page.fill('[name=password]', 'new-password-1');
    await page.click('#loginForm button');
    await expect(page.locator('#app')).toBeVisible();
    expect((await new Api(server.url).login(acc.username, acc.password)).status).toBe(401);
  });
});

test.describe('settings: users', () => {
  const open = async (page, signIn) => {
    await signIn('owner', 'sozlamalar?tab=foydalanuvchilar');
    await expect(page.locator('#setPanel table')).toBeVisible();
  };
  const create = async (page, { username, name = 'Sinov', role = 'dispatcher', password = 'password-1' }) => {
    await page.click('[data-act=new]');
    await page.fill('.modal [name=username]', username);
    await page.fill('.modal [name=name]', name);
    await page.selectOption('.modal [name=role]', role);
    await page.fill('.modal [name=password]', password);
    await page.click('.modal [type=submit]');
  };
  const row = (page, username) => page.locator('#setPanel tbody tr', { hasText: username });

  test('the list marks me, and offers me no way to block or delete myself', async ({ page, signIn }) => {
    await open(page, signIn);
    const me = row(page, 'owner').first();
    await expect(me).toContainText('(siz)');
    await expect(me.locator('[data-act=toggle]')).toHaveCount(0);
    await expect(me.locator('[data-act=delete]')).toHaveCount(0);
  });

  test('add a user: they appear, and can log in', async ({ page, signIn, server }) => {
    const username = `ui${uid()}`;
    await open(page, signIn);
    await create(page, { username, name: 'Ali Valiyev' });
    await expect(row(page, username)).toContainText('Ali Valiyev');
    await expect(page.locator('.modal')).toHaveCount(0);
    expect((await new Api(server.url).login(username, 'password-1')).status).toBe(200);
  });

  for (const [name, o, msg] of [
    ['short password', { password: 'short' }, 'kamida 8'],
    ['invalid login', { username: 'a b' }, 'Login 3-32'],
  ]) {
    test(`add refused: ${name}; the message is inside the dialog, which stays open`, async ({ page, signIn }) => {
      await open(page, signIn);
      await create(page, { username: `ok${uid()}`, ...o });
      await expect(page.locator('.modal .form-error')).toContainText(msg);
      await expect(page.locator('.modal [type=submit]')).toBeEnabled();
    });
  }

  test('add refused: a login already taken', async ({ page, signIn, owner }) => {
    const username = `dup${uid()}`;
    await owner.post('/api/users', { username, role: 'dispatcher', password: 'password-1' });
    await open(page, signIn);
    await create(page, { username });
    await expect(page.locator('.modal .form-error')).toHaveText('Bu login band');
  });

  test('edit: name and role', async ({ page, signIn, owner }) => {
    const username = `ed${uid()}`;
    await owner.post('/api/users', { username, name: 'Eski', role: 'dispatcher', password: 'password-1' });
    await open(page, signIn);
    await row(page, username).locator('[data-act=edit]').click();
    await expect(page.locator('.modal [name=name]')).toHaveValue('Eski');
    await page.fill('.modal [name=name]', 'Yangi');
    await page.selectOption('.modal [name=role]', 'owner');
    await page.click('.modal [type=submit]');
    await expect(row(page, username)).toContainText('Yangi');
    await expect(row(page, username)).toContainText('Rahbar');
  });

  test('edit myself out of the last owner role: refused, with the reason', async ({ page, signIn, server }) => {
    server.run("UPDATE users SET disabled = 1 WHERE role = 'owner' AND username != 'owner'");
    await open(page, signIn);
    await row(page, 'owner').first().locator('[data-act=edit]').click();
    await page.selectOption('.modal [name=role]', 'dispatcher');
    await page.click('.modal [type=submit]');
    await expect(page.locator('.modal .form-error')).toContainText('faol rahbar');
  });

  test('reset a password: mismatch refused; success signs them out', async ({ page, signIn, owner, server }) => {
    const username = `rp${uid()}`;
    await owner.post('/api/users', { username, role: 'dispatcher', password: 'password-1' });
    const c = new Api(server.url);
    await c.login(username, 'password-1');
    await open(page, signIn);
    await row(page, username).locator('[data-act=password]').click();
    await page.fill('.modal [name=password]', 'reset-password-1');
    await page.fill('.modal [name=repeat]', 'reset-password-2');
    await page.click('.modal [type=submit]');
    await expect(page.locator('.modal .form-error')).toContainText('mos kelmadi');
    await page.fill('.modal [name=repeat]', 'reset-password-1');
    await page.click('.modal [type=submit]');
    await expect(page.locator('.toast', { hasText: "Parol o'zgartirildi" })).toBeVisible();
    expect((await c.get('/api/me')).status).toBe(401);
  });

  test('block asks first; cancel keeps them; block and unblock work', async ({ page, signIn, owner }) => {
    const username = `bl${uid()}`;
    await owner.post('/api/users', { username, name: 'Bloklanadigan', role: 'dispatcher', password: 'password-1' });
    await open(page, signIn);
    const r = row(page, username);
    await r.locator('[data-act=toggle]').click();
    await expect(page.locator('.modal')).toContainText('Bloklanadigan');
    await page.locator('.modal-foot [data-close]').click();
    await expect(r).toContainText('Faol');
    await r.locator('[data-act=toggle]').click();
    await page.locator('.modal [data-ok]').click();
    await expect(r).toContainText("O'chirilgan");
    await r.locator('[data-act=toggle]').click();
    await expect(r, 'unblocking needs no confirmation').toContainText('Faol');
  });

  test('delete asks first; then they\'re gone', async ({ page, signIn, owner }) => {
    const username = `dl${uid()}`;
    await owner.post('/api/users', { username, role: 'dispatcher', password: 'password-1' });
    await open(page, signIn);
    await row(page, username).locator('[data-act=delete]').click();
    await page.locator('.modal-foot [data-close]').click();
    await expect(row(page, username)).toHaveCount(1);
    await row(page, username).locator('[data-act=delete]').click();
    await page.locator('.modal [data-ok]').click();
    await expect(row(page, username)).toHaveCount(0);
  });
});

test.describe('settings: vehicles', () => {
  const open = async (page, signIn) => {
    await signIn('owner', 'sozlamalar?tab=transportlar');
    await expect(page.locator('table.veh-edit')).toBeVisible();
  };
  const tr = (page, id) => page.locator(`table.veh-edit tr[data-id="${id}"]`);
  const reset = (server, id) => server.run("UPDATE vehicles SET type = 'auto', plate = NULL, display = NULL, fuel_norm = NULL, active = 1 WHERE id = ?", id);

  test('Save is enabled only when something changed; undoing the edit turns it off', async ({ page, signIn }) => {
    await open(page, signIn);
    const r = tr(page, FLEET.fuel);
    await expect(r.locator('[data-save]')).toBeDisabled();
    await r.locator('[name=display]').fill('X');
    await expect(r.locator('[data-save]')).toBeEnabled();
    await r.locator('[name=display]').fill('');
    await expect(r.locator('[data-save]')).toBeDisabled();
  });

  test('save name, plate, type and norm: stored, and shown across the app', async ({ page, signIn, server }) => {
    await open(page, signIn);
    const r = tr(page, FLEET.fuel);
    await r.locator('[name=plate]').fill('85 500 kba');
    await r.locator('[name=type]').selectOption('dump');
    await r.locator('[name=fuelNorm]').fill('38.5');
    await r.locator('[data-save]').click();
    await expect(page.locator('.toast', { hasText: 'Saqlandi: 85 500 KBA' })).toBeVisible();
    await expect(r.locator('[name=plate]'), 'shown normalised').toHaveValue('85 500 KBA');
    await expect(r.locator('[data-save]')).toBeDisabled();
    const row = server.get('SELECT plate, type, fuel_norm FROM vehicles WHERE id = ?', FLEET.fuel);
    expect(row).toMatchObject({ plate: '85500KBA', type: 'dump', fuel_norm: 38.5 });
    await page.click('#nav a[data-path=xarita]');
    await expect(page.locator('.vrow .vname', { hasText: '85 500 KBA' })).toHaveCount(1);
    reset(server, FLEET.fuel);
  });

  test('a plate on another vehicle: the error is shown, Save stays available', async ({ page, signIn, server }) => {
    server.run('UPDATE vehicles SET plate = ? WHERE id = ?', '85600KBA', FLEET.fuel2);
    await open(page, signIn);
    const r = tr(page, FLEET.fuel);
    await r.locator('[name=plate]').fill('85 600 KBA');
    await r.locator('[data-save]').click();
    await expect(page.locator('.toast.bad')).toContainText('boshqa transportga');
    await expect(r.locator('[data-save]')).toBeEnabled();
    reset(server, FLEET.fuel2);
  });

  test('a negative norm is refused here', async ({ page, signIn }) => {
    await open(page, signIn);
    const r = tr(page, FLEET.fuel);
    await r.locator('[name=fuelNorm]').fill('-5');
    await r.locator('[data-save]').click();
    await expect(page.locator('.toast.bad')).toContainText('musbat');
  });

  test('switch off: leaves the map; back on: returns', async ({ page, signIn, server }) => {
    await open(page, signIn);
    const r = tr(page, FLEET.fuel);
    await r.locator('[name=active]').uncheck({ force: true });
    await r.locator('[data-save]').click();
    await expect(page.locator('.toast', { hasText: 'Saqlandi' })).toBeVisible();
    await expect(r).toHaveClass(/inactive/);
    await page.click('#nav a[data-path=xarita]');
    await expect(page.locator('.vrow')).toHaveCount(FLEET.total - 1);
    await page.fill('#vsearch', '85 450');
    await expect(page.locator('#vlist .empty')).toBeVisible();
    reset(server, FLEET.fuel);
  });

  test('a suggested plate from the cameras fills in on click', async ({ page, signIn, server }) => {
    const { gateEvent } = require('../support/seed');
    const id = gateEvent(server, { t: Date.now() - 86400e3, plate: '10870HDA', vehicleId: FLEET.mixer, status: 'history', by: 'similar' });
    await open(page, signIn);
    const r = tr(page, FLEET.mixer);
    await r.locator('[data-suggest]').click();
    await expect(r.locator('[name=plate]')).toHaveValue('10 870 HDA');
    await expect(r.locator('[data-save]')).toBeEnabled();
    server.run('DELETE FROM gate_events WHERE id = ?', id);
  });
});

test.describe('settings: system', () => {
  test('all cards, in demo mode, with live figures', async ({ page, signIn, server }) => {
    await signIn('owner', 'sozlamalar?tab=tizim');
    const p = page.locator('#setPanel');
    await expect(p).toContainText('Demo rejim');
    await expect(p.locator('.card').filter({ hasText: 'GPS (GoGPS)' }).locator('.pill').first()).toHaveText('Ishlayapti');
    await expect(p).toContainText('TBB hovli');
    await expect(p).toContainText('06:00-22:00');
    await expect(p.locator('table tbody tr')).toHaveCount(2);
    const n = server.get('SELECT COUNT(*) n FROM users').n;
    await expect(p.locator('.kv', { hasText: 'Foydalanuvchilar' })).toContainText(String(n));
  });

  test('recompute: confirms with the day; refresh works', async ({ page, signIn }) => {
    await signIn('owner', 'sozlamalar?tab=tizim');
    await page.click('[data-act=recompute]');
    await expect(page.locator('.toast', { hasText: 'Qayta hisoblandi' })).toContainText(today());
    await page.click('[data-act=reload]');
    await expect(page.locator('[data-act=reload]')).toBeEnabled();
  });

  test('recompute failing: the error is shown, the button works again', async ({ page, signIn }) => {
    await signIn('owner', 'sozlamalar?tab=tizim');
    await page.route('**/api/analytics/recompute', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Server xatosi"}' }));
    await page.click('[data-act=recompute]');
    await expect(page.locator('.toast.bad')).toContainText('Server xatosi');
    await expect(page.locator('[data-act=recompute]')).toBeEnabled();
  });
});

test.describe('settings: notifications on this device', () => {
  /** A push service can't be reached from a test browser, so subscribing is stubbed; everything else is real. */
  const stubPush = (page, { permission = 'granted', endpoint = `https://127.0.0.1:1/${uid()}` } = {}) => page.addInitScript(({ permission, endpoint }) => {
    let sub = null;
    const make = () => ({ endpoint, options: {}, unsubscribe: async () => { sub = null; return true; }, toJSON: () => ({ endpoint, keys: { p256dh: 'BNNL5ZaTfK81qhXOx23-wewhigUeFb632jN6LvRWCFH1ubQr77FE_9qV1FuojuRmHP42zmf34rXgW80OvUVDgTk', auth: 'zqbxT6JKstKSY9JKibZLSQ' } }) });
    PushManager.prototype.getSubscription = async () => sub;
    PushManager.prototype.subscribe = async () => { sub = make(); return sub; };
    Object.defineProperty(Notification, 'permission', { get: () => permission, configurable: true });
    Notification.requestPermission = async () => permission;
  }, { permission, endpoint });
  const openTab = async (page, signIn) => {
    await signIn('dispatcher', 'sozlamalar');
    await expect(page.locator('#setPanel h3').first()).toBeVisible();
  };

  test('turn on: status, stored prefs, the test message, turn off', async ({ page, signIn, server }) => {
    const endpoint = `https://127.0.0.1:1/${uid()}`;
    await stubPush(page, { endpoint });
    await openTab(page, signIn);
    await expect(page.locator('#setPanel .pill').first()).toHaveText("O'chirilgan");
    await page.click('[data-act=enable]');
    await expect(page.locator('.toast', { hasText: 'Bildirishnomalar yoqildi' })).toBeVisible();
    await expect(page.locator('#setPanel .pill.good')).toContainText('Yoqilgan');
    expect(server.get('SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint = ?', endpoint).n).toBe(1);
    await page.click('[data-act=test]');
    await expect(page.locator('.toast', { hasText: 'Sinov xabari yuborildi' })).toBeVisible();
    await page.click('[data-act=disable]');
    await expect(page.locator('[data-act=enable]')).toBeVisible();
    expect(server.get('SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint = ?', endpoint).n).toBe(0);
  });

  test('switches and quiet hours save to the server', async ({ page, signIn, server }) => {
    const endpoint = `https://127.0.0.1:1/${uid()}`;
    await stubPush(page, { endpoint });
    await openTab(page, signIn);
    await page.click('[data-act=enable]');
    await expect(page.locator('#setPanel .pill.good')).toBeVisible();
    await page.locator('[name=gateIn]').uncheck({ force: true });
    await expect(page.locator('.toast', { hasText: 'Saqlandi' }).first()).toBeVisible();
    await expect.poll(() => JSON.parse(server.get('SELECT prefs FROM push_subscriptions WHERE endpoint = ?', endpoint).prefs).gateIn).toBe(false);
    await page.fill('[name=quietFrom]', '22:00');
    await page.dispatchEvent('[name=quietFrom]', 'change');
    await page.fill('[name=quietTo]', '07:00');
    await page.dispatchEvent('[name=quietTo]', 'change');
    await expect.poll(() => JSON.parse(server.get('SELECT prefs FROM push_subscriptions WHERE endpoint = ?', endpoint).prefs).quietTo).toBe('07:00');
    await page.click('[data-act=quietClear]');
    await expect.poll(() => JSON.parse(server.get('SELECT prefs FROM push_subscriptions WHERE endpoint = ?', endpoint).prefs).quietFrom).toBe('');
  });

  test('permission refused: says how to allow it, no subscription', async ({ page, signIn, server }) => {
    const endpoint = `https://127.0.0.1:1/${uid()}`;
    await stubPush(page, { permission: 'default', endpoint });
    await page.addInitScript(() => { Notification.requestPermission = async () => 'denied'; });
    await openTab(page, signIn);
    await page.click('[data-act=enable]');
    await expect(page.locator('.toast', { hasText: 'Ruxsat berilmadi' })).toBeVisible();
    expect(server.get('SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint = ?', endpoint).n).toBe(0);
  });

  test('blocked in the browser: explains it; the button is off', async ({ page, signIn }) => {
    await stubPush(page, { permission: 'denied' });
    await openTab(page, signIn);
    await expect(page.locator('#setPanel .pill.bad')).toHaveText('Brauzerda bloklangan');
    await expect(page.locator('[data-act=enable]')).toBeDisabled();
    await expect(page.locator('#setPanel .notice.bad')).toContainText('bloklangan');
  });

  test('a browser without Web Push: explains the options', async ({ page, signIn }) => {
    await page.addInitScript(() => { delete window.PushManager; });
    await openTab(page, signIn);
    await expect(page.locator('#setPanel .pill').first()).toHaveText("Qo'llab-quvvatlanmaydi");
    await expect(page.locator('#setPanel .notice.warn')).toContainText("qo'llab-quvvatlamaydi");
    await expect(page.locator('[data-act=enable]')).toHaveCount(0);
  });

  test('an iPhone outside the Home Screen: says to add it first', async ({ browser, server }) => {
    const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1' });
    const page = await ctx.newPage();
    await page.addInitScript(() => { delete window.PushManager; });
    await page.route(/\/api\/tiles\//, (r) => r.abort());
    await page.goto(`${server.url}/#/sozlamalar`);
    await page.fill('[name=username]', 'dispatcher');
    await page.fill('[name=password]', 'dispatcher123');
    await page.click('#loginForm button');
    await expect(page.locator('#setPanel .notice.warn')).toContainText('Ekranga qo');
    await ctx.close();
  });

  test('a device subscribed under another login: warns and offers to take it over', async ({ page, signIn, owner }) => {
    const endpoint = `https://127.0.0.1:1/${uid()}`;
    await owner.post('/api/push/subscribe', { subscription: { endpoint, keys: { p256dh: 'x', auth: 'y' } } });
    await stubPush(page, { endpoint });
    await page.addInitScript(({ endpoint }) => {
      PushManager.prototype.getSubscription = async () => ({ endpoint, options: {}, unsubscribe: async () => true, toJSON: () => ({ endpoint, keys: { p256dh: 'x', auth: 'y' } }) });
    }, { endpoint });
    await openTab(page, signIn);
    await expect(page.locator('#setPanel .notice.warn')).toContainText('serverda topilmadi');
    await expect(page.locator('[data-act=enable]')).toBeVisible();
    await page.click('[data-act=enable]');
    await expect(page.locator('#setPanel .pill.good')).toBeVisible();
  });
});
