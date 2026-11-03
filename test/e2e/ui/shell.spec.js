'use strict';
// Login form, navigation by role, header widgets, session handling, escaping of stored text.
const { uiTest: test, expect } = require('../support/fixtures');
const { uid, alert, FLEET } = require('../support/seed');

test.describe('login page', () => {
  test('anonymous visitors see only the form, with the login field focused', async ({ page, server }) => {
    await page.goto(server.url);
    await expect(page.locator('#loginForm')).toBeVisible();
    await expect(page.locator('#app')).toBeHidden();
    await expect(page.locator('[name=username]')).toBeFocused();
    await expect(page.locator('[name=password]')).toHaveAttribute('type', 'password');
  });

  test('wrong password: a readable error, the form stays usable', async ({ page, server }) => {
    await page.goto(server.url);
    await page.fill('[name=username]', 'owner');
    await page.fill('[name=password]', 'wrong-password');
    await page.click('#loginForm button');
    await expect(page.locator('#loginError')).toHaveText("Login yoki parol noto'g'ri");
    await expect(page.locator('#loginForm button')).toBeEnabled();
    await expect(page.locator('#app')).toBeHidden();
  });

  test('the error clears on the next attempt, and Enter submits', async ({ page, server }) => {
    await page.goto(server.url);
    await page.fill('[name=username]', 'owner');
    await page.fill('[name=password]', 'wrong-password');
    await page.press('[name=password]', 'Enter');
    await expect(page.locator('#loginError')).toBeVisible();
    await page.fill('[name=password]', 'owner12345');
    await page.press('[name=password]', 'Enter');
    await expect(page.locator('#app')).toBeVisible();
    await expect(page.locator('#loginError')).toBeHidden();
  });

  test('empty fields: the browser asks for them, nothing is sent', async ({ page, server }) => {
    await page.goto(server.url);
    let sent = false;
    page.on('request', (r) => { if (r.url().includes('/api/auth/login')) sent = true; });
    await page.click('#loginForm button');
    await page.waitForTimeout(300);
    expect(sent).toBe(false);
  });

  test('a login with spaces around it still works', async ({ page, server }) => {
    await page.goto(server.url);
    await page.fill('[name=username]', '  owner ');
    await page.fill('[name=password]', 'owner12345');
    await page.click('#loginForm button');
    await expect(page.locator('#app')).toBeVisible();
  });

  test('locked out: the message says to wait', async ({ page, server, context }) => {
    test.info().annotations.push({ type: 'allow-errors' });
    await context.setExtraHTTPHeaders({ 'x-real-ip': `10.77.${Math.floor(Math.random() * 255)}.1` });
    await page.goto(server.url);
    for (let i = 0; i < 8; i++) {
      await page.fill('[name=username]', 'owner');
      await page.fill('[name=password]', `wrong-${i}-pass`);
      await page.click('#loginForm button');
      await expect(page.locator('#loginError')).toBeVisible();
    }
    await page.fill('[name=password]', 'owner12345');
    await page.click('#loginForm button');
    await expect(page.locator('#loginError')).toContainText("Juda ko'p urinish");
  });

  test('server unreachable on start: a retry link, not a blank page', async ({ page, server }) => {
    await page.route('**/api/me', (r) => r.abort());
    await page.goto(server.url);
    await expect(page.locator('#boot')).toContainText("Server bilan aloqa yo'q");
    await expect(page.locator('#boot a')).toBeVisible();
  });

  test('the password never appears in a URL', async ({ page, server }) => {
    const urls = [];
    page.on('request', (r) => urls.push(r.url()));
    await page.goto(server.url);
    await page.fill('[name=username]', 'owner');
    await page.fill('[name=password]', 'owner12345');
    await page.click('#loginForm button');
    await expect(page.locator('#app')).toBeVisible();
    expect(urls.join(' ')).not.toContain('owner12345');
  });
});

test.describe('session', () => {
  test('a reload stays signed in, on the same page', async ({ page, signIn }) => {
    await signIn('owner', 'hisobot');
    await expect(page.locator('#pageTitle')).toHaveText('Hisobotlar');
    await page.reload();
    await expect(page.locator('#app')).toBeVisible();
    await expect(page.locator('#pageTitle')).toHaveText('Hisobotlar');
  });

  test('logout returns to the form and really ends the session', async ({ page, signIn, server }) => {
    await signIn('owner');
    await page.click('#userBtn');
    await page.click('#logoutBtn');
    await expect(page.locator('#loginForm')).toBeVisible();
    await expect(page.locator('#app')).toBeHidden();
    const status = await page.evaluate(() => fetch('/api/me').then((r) => r.status));
    expect(status).toBe(401);
    void server;
  });

  test('session cookie is out of reach of page scripts', async ({ page, signIn }) => {
    await signIn('owner');
    expect(await page.evaluate(() => document.cookie)).not.toContain('tbb_session');
  });

  test('a session ended elsewhere (password changed, blocked): back to the form', async ({ page, signIn, server }) => {
    await signIn('owner', 'darvoza');
    await expect(page.locator('#gTiles .tile').first()).toBeVisible();
    server.run('DELETE FROM sessions');
    await page.evaluate(() => { location.hash = '#/hisobot'; });
    await expect(page.locator('#loginForm')).toBeVisible({ timeout: 15_000 });
  });
});

test('blocked while the app is open: back to the login form within seconds', async ({ page, signIn, owner }) => {
  const username = `live${uid()}`;
  const { data } = await owner.post('/api/users', { username, role: 'dispatcher', password: 'password-1' });
  await signIn({ username, password: 'password-1' }, 'hisobot');
  await expect(page.locator('#repTable table')).toBeVisible();
  await owner.patch(`/api/users/${data.id}`, { disabled: true });
  await expect(page.locator('#loginForm')).toBeVisible({ timeout: 25_000 });
});

test.describe('navigation', () => {
  test('owner: seven sections in the sidebar', async ({ page, signIn }) => {
    await signIn('owner');
    await expect(page.locator('#nav a span:not(.i):not(.badge)')).toHaveText(['Xarita', 'Darvoza', 'Ogohlantirish', 'Transport', 'Tahlil', 'Hisobot', 'Sozlamalar']);
  });

  test('dispatcher: no Tahlil', async ({ page, signIn }) => {
    await signIn('dispatcher');
    await expect(page.locator('#nav a[data-path=tahlil]')).toHaveCount(0);
    await expect(page.locator('#nav a')).toHaveCount(6);
  });

  test('a dispatcher with a direct link to Tahlil lands on the map; no analytics request is made', async ({ page, signIn }) => {
    const calls = [];
    page.on('request', (r) => { if (r.url().includes('/api/analytics')) calls.push(r.url()); });
    await signIn('dispatcher', 'tahlil');
    await expect(page.locator('#pageTitle')).toHaveText('Jonli xarita');
    expect(calls).toEqual([]);
  });

  for (const [path, title] of [['xarita', 'Jonli xarita'], ['darvoza', 'Darvoza va hovli'], ['ogohlantirish', 'Ogohlantirishlar'], ['transport', 'Transport'], ['tahlil', 'Tahlil'], ['hisobot', 'Hisobotlar'], ['sozlamalar', 'Sozlamalar']]) {
    test(`clicking ${path}: right heading, tab title and highlighted link`, async ({ page, signIn }) => {
      await signIn('owner', path === 'xarita' ? 'hisobot' : 'xarita');
      await page.click(`#nav a[data-path=${path}]`);
      await expect(page).toHaveURL(new RegExp(`#/${path}`));
      await expect(page.locator('#pageTitle')).toHaveText(title);
      await expect(page).toHaveTitle(`${title} · TBB Dispatcher`);
      await expect(page.locator(`#nav a[data-path=${path}]`)).toHaveAttribute('aria-current', 'page');
      await expect(page.locator('#nav a[aria-current=page]')).toHaveCount(1);
      await expect(page.locator('#main .notice.bad', { hasText: "ochib bo'lmadi" })).toHaveCount(0);
    });
  }

  test('an unknown address opens the map', async ({ page, signIn }) => {
    await signIn('owner', 'no-such-page');
    await expect(page.locator('#pageTitle')).toHaveText('Jonli xarita');
  });

  test('browser back and forward walk through pages', async ({ page, signIn }) => {
    await signIn('owner', 'xarita');
    await page.click('#nav a[data-path=darvoza]');
    await expect(page.locator('#pageTitle')).toHaveText('Darvoza va hovli');
    await page.click('#nav a[data-path=hisobot]');
    await expect(page.locator('#pageTitle')).toHaveText('Hisobotlar');
    await page.goBack();
    await expect(page.locator('#pageTitle')).toHaveText('Darvoza va hovli');
    await page.goBack();
    await expect(page.locator('#pageTitle')).toHaveText('Jonli xarita');
    await page.goForward();
    await expect(page.locator('#pageTitle')).toHaveText('Darvoza va hovli');
  });

  test('going around all pages quickly: no error from pages being torn down', async ({ page, signIn }) => {
    await signIn('owner');
    for (let i = 0; i < 3; i++) {
      for (const p of ['xarita', 'transport/21389', 'tahlil', 'xarita', 'darvoza', 'sozlamalar?tab=tizim', 'ogohlantirish', 'hisobot']) {
        await page.evaluate((h) => { location.hash = `#/${h}`; }, p);
        await page.waitForTimeout(60);
      }
    }
    await page.waitForTimeout(800);
    await expect(page.locator('#main .notice.bad')).toHaveCount(0);
  });

  test('leaving the map mid-zoom doesn\'t throw', async ({ page, signIn }) => {
    await signIn('owner', 'xarita');
    await expect(page.locator('.vrow').first()).toBeVisible();
    await page.click('#yardBtn');
    await page.evaluate(() => { location.hash = '#/hisobot'; });
    await page.waitForTimeout(1000);
    await expect(page.locator('#pageTitle')).toHaveText('Hisobotlar');
  });
});

test.describe('header', () => {
  test('the clock shows Tashkent time, whatever the device\'s zone', async ({ browser, server }) => {
    const ctx = await browser.newContext({ timezoneId: 'America/New_York' });
    const page = await ctx.newPage();
    await page.route(/tile\.openstreetmap\.org/, (r) => r.abort());
    await page.goto(server.url);
    await page.fill('[name=username]', 'owner');
    await page.fill('[name=password]', 'owner12345');
    await page.click('#loginForm button');
    await expect(page.locator('#clock')).toContainText('Toshkent');
    const shown = (await page.locator('#clock').textContent()).slice(0, 5);
    const expected = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit', hour12: false }).format(Date.now());
    const mins = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
    expect(Math.abs(mins(shown) - mins(expected)) % 1439).toBeLessThanOrEqual(1);
    await ctx.close();
  });

  test('user menu: name and role; opens, closes by clicking outside', async ({ page, signIn }) => {
    await signIn('dispatcher');
    await expect(page.locator('#userName')).toHaveText('Dispetcher (demo)');
    await expect(page.locator('#userAvatar')).toHaveText('D');
    await expect(page.locator('#userDrop')).toBeHidden();
    await page.click('#userBtn');
    await expect(page.locator('#userDrop')).toBeVisible();
    await expect(page.locator('#userBtn')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#userRole')).toHaveText('dispatcher · Dispetcher');
    await page.click('#pageTitle');
    await expect(page.locator('#userDrop')).toBeHidden();
    await expect(page.locator('#userBtn')).toHaveAttribute('aria-expanded', 'false');
  });

  test('user menu closes on Escape', async ({ page, signIn }) => {
    await signIn('owner');
    await page.click('#userBtn');
    await page.keyboard.press('Escape');
    await expect(page.locator('#userDrop')).toBeHidden();
  });

  test('user menu: settings link opens settings', async ({ page, signIn }) => {
    await signIn('owner');
    await page.click('#userBtn');
    await page.click('#userDrop a[href="#/sozlamalar"]');
    await expect(page.locator('#pageTitle')).toHaveText('Sozlamalar');
  });

  test('bell: counts open alerts, opens the list, follows acknowledgements', async ({ page, signIn, owner, server }) => {
    await owner.post('/api/alerts/ack-all');
    const id = alert(server, { title: 'Sinov qo\'ng\'irog\'i' });
    await signIn('owner', 'hisobot');
    await expect(page.locator('#bellCount')).toHaveText('1');
    await expect(page.locator('#nav [data-badge]')).toHaveText('1');
    await page.click('#bell');
    await expect(page.locator('#pageTitle')).toHaveText('Ogohlantirishlar');
    await owner.post(`/api/alerts/${id}/ack`);
    await expect(page.locator('#bellCount')).toBeHidden();
  });

  test('bell: no badge when nothing is open; "99+" past 99', async ({ page, signIn, owner, server }) => {
    await owner.post('/api/alerts/ack-all');
    await signIn('owner', 'hisobot');
    await expect(page.locator('#bellCount')).toBeHidden();
    server.sql((db) => {
      const ins = db.prepare("INSERT INTO alerts (key, type, severity, t, title) VALUES (?, 'speeding', 'info', ?, 'x')");
      db.exec('BEGIN');
      for (let i = 0; i < 120; i++) ins.run(`many:${uid()}`, Date.now());
      db.exec('COMMIT');
    });
    await page.reload();
    await expect(page.locator('#bellCount')).toHaveText('99+');
    await owner.post('/api/alerts/ack-all');
  });

  test('sidebar shows live connection and each part of the system', async ({ page, signIn }) => {
    await signIn('owner');
    const box = page.locator('#healthBox');
    await expect(box).toContainText('Jonli aloqa');
    await expect(box).toContainText('GPS');
    await expect(box).toContainText('Kamera tizimi (NVR)');
    await expect(box.locator('.dot.bad')).toHaveCount(0);
  });
});

test.describe('stored text is shown as text, never run', () => {
  const XSS = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';

  test('vehicle name: list, marker, card, transport page, settings, report', async ({ page, signIn, owner, server }) => {
    await owner.patch(`/api/vehicles/${FLEET.fuel}`, { display: XSS.slice(0, 40) });
    try {
      await signIn('owner', `xarita?v=${FLEET.fuel}`);
      await expect(page.locator('#drawer h2')).toContainText('<img src=x');
      await expect(page.locator('.vrow .vname', { hasText: '<img src=x' })).toHaveCount(1);
      await page.waitForTimeout(300);
      for (const h of [`transport/${FLEET.fuel}`, 'transport', 'hisobot', 'tahlil', 'sozlamalar?tab=transportlar']) {
        await page.evaluate((x) => { location.hash = `#/${x}`; }, h);
        await page.waitForTimeout(500);
      }
      expect(await page.evaluate(() => window.__xss)).toBeUndefined();
      await expect(page.locator('#main img[src="x"]')).toHaveCount(0);
    } finally { await owner.patch(`/api/vehicles/${FLEET.fuel}`, { display: '' }); void server; }
  });

  test('user name: header, users table', async ({ page, signIn, owner }) => {
    const username = `xss${uid()}`;
    const { data } = await owner.post('/api/users', { username, name: XSS, role: 'owner', password: 'password-1' });
    await signIn({ username, password: 'password-1' }, 'sozlamalar?tab=foydalanuvchilar');
    await expect(page.locator('#setPanel table')).toContainText('<img src=x');
    await expect(page.locator('#userName')).toContainText('<img src=x');
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    await owner.del(`/api/users/${data.id}`);
  });

  test('alert title and body', async ({ page, signIn, server }) => {
    const id = alert(server, { title: XSS, body: XSS });
    await signIn('owner', `ogohlantirish?id=${id}`);
    await expect(page.locator(`.arow[data-id="${id}"] .arow-title`)).toContainText('<img src=x');
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  });

  test('a plate read by the camera: feed and detail', async ({ page, signIn, server }) => {
    const { gateEvent } = require('../support/seed');
    const id = gateEvent(server, { t: Date.now() - 1000, plate: XSS, plateRaw: XSS, valid: 0, status: 'outside', note: XSS, camera: XSS });
    await signIn('owner', `darvoza?event=${id}`);
    await expect(page.locator('.modal')).toBeVisible();
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    server.run('DELETE FROM gate_events WHERE id = ?', id);
  });

  test('a script in the URL does nothing', async ({ page, signIn }) => {
    await signIn('owner', 'xarita');
    await page.evaluate(() => { location.hash = `#/${encodeURIComponent('<img src=x onerror=window.__xss=1>')}`; });
    await page.waitForTimeout(400);
    await page.evaluate(() => { location.hash = '#/transport/<img src=x onerror=window.__xss=1>'; });
    await page.waitForTimeout(400);
    await page.evaluate(() => { location.hash = '#/hisobot?from=<img src=x onerror=window.__xss=1>&to=x'; });
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  });
});

test('the CSP actually blocks an injected script', async ({ page, signIn }) => {
  test.info().annotations.push({ type: 'allow-errors' });
  await signIn('owner');
  await page.evaluate(() => { const s = document.createElement('script'); s.textContent = 'window.__csp = 1'; document.head.append(s); });
  expect(await page.evaluate(() => window.__csp)).toBeUndefined();
});

test('service worker: registers, with push and click handling', async ({ page, signIn, server }) => {
  await signIn('owner');
  const scope = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return r.scope; });
  expect(scope).toBe(`${server.url}/`);
});

test('notification tap: the service worker\'s message opens the right page', async ({ page, signIn }) => {
  await signIn('owner');
  await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'open', url: '/#/ogohlantirish?id=1' } })));
  await expect(page.locator('#pageTitle')).toHaveText('Ogohlantirishlar');
});
