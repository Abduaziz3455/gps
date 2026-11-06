'use strict';
// Layout on every kind of screen: nothing wider than the screen, no text over other text, no label cut by its box.
// And the map: working trucks stand apart from parked ones, the yard can be found at any zoom.
const { uiTest: test, expect } = require('../support/fixtures');

const SCREENS = [
  ['small phone', 320, 568], ['phone', 390, 844], ['phone on its side', 844, 390], ['tablet', 768, 1024],
  ['small notebook', 1024, 768], ['notebook', 1366, 768], ['monitor', 1920, 1080], ['big monitor', 2560, 1440],
];
const PAGES = ['xarita', 'darvoza', 'ogohlantirish', 'transport', 'joylar', 'tahlil', 'hisobot', 'sozlamalar'];

/** Runs in the page. Returns what's wrong with the layout, in words. */
function layoutProblems(root = '#app') {
  const seen = (el) => { const r = el.getBoundingClientRect(); const c = getComputedStyle(el); return r.width > 1 && r.height > 1 && c.visibility !== 'hidden'; };
  const out = [];
  const main = document.querySelector('#main');
  for (const el of [document.documentElement, document.body, main].filter(Boolean)) {
    if (el.scrollWidth > el.clientWidth + 1) out.push(`${el.tagName} is ${el.scrollWidth - el.clientWidth}px wider than the screen`);
  }
  const texts = [];
  for (const el of document.querySelectorAll(`${root} *`)) {
    if (!seen(el) || el.closest('svg, .leaflet-container, .toasts, .dropdown, .drawer, .modal-backdrop')) continue;
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const range = document.createRange();
    range.selectNodeContents(el);
    const raw = range.getBoundingClientRect();
    if (!raw.width) continue;
    let v = { l: raw.left, r: raw.right, t: raw.top, b: raw.bottom };
    for (let p = el; p; p = p.parentElement) {
      const c = getComputedStyle(p);
      if (c.overflowX === 'visible' && c.overflowY === 'visible') continue;
      const x = p.getBoundingClientRect();
      v = { l: Math.max(v.l, x.left), r: Math.min(v.r, x.right), t: Math.max(v.t, x.top), b: Math.min(v.b, x.bottom) };
    }
    if (v.r - v.l < 1 || v.b - v.t < 1) continue; // scrolled out of view
    const name = el.textContent.trim().slice(0, 30);
    if (getComputedStyle(el).textOverflow !== 'ellipsis') {
      const box = el.closest('.fchip, .tile, .btn, .pill, .seg button');
      const drawn = box && (parseFloat(getComputedStyle(box).borderLeftWidth) > 0 || getComputedStyle(box).backgroundColor !== 'rgba(0, 0, 0, 0)');
      if (drawn) {
        const x = box.getBoundingClientRect();
        if (raw.right > x.right - 2 || raw.left < x.left + 2) out.push(`"${name}" touches the edge of its box`);
      }
    }
    texts.push({ el, v, name });
  }
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i], b = texts[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      if (Math.min(a.v.r, b.v.r) - Math.max(a.v.l, b.v.l) > 2 && Math.min(a.v.b, b.v.b) - Math.max(a.v.t, b.v.t) > 3) out.push(`"${a.name}" overlaps "${b.name}"`);
    }
  }
  return [...new Set(out)];
}

for (const [name, width, height] of SCREENS) test.describe(name, () => {
  test.use({ hasTouch: width <= 900 }); // touch devices get larger controls, so they're tested as touch devices

  test(`${name} (${width}x${height}): the login page fits, and its form can be reached`, async ({ page, server }) => {
    await page.setViewportSize({ width, height });
    await page.goto(server.url);
    await expect(page.locator('#loginForm')).toBeVisible();
    expect(await page.evaluate(layoutProblems, '#login')).toEqual([]);
    const submit = page.locator('#loginForm button[type=submit]');
    await submit.scrollIntoViewIfNeeded();
    await expect(submit).toBeInViewport();
    await expect(page.locator('#loginForm .brand-mark, .login-hero .brand-mark').locator('visible=true')).toHaveCount(1);
    // The logo really loaded.
    const loaded = await page.locator('.brand-mark').locator('visible=true').first().evaluate((i) => i.complete && i.naturalWidth > 0);
    expect(loaded).toBe(true);
  });

  test(`${name} (${width}x${height}): every page fits`, async ({ page, signIn }) => {
    await page.setViewportSize({ width, height });
    await signIn('owner');
    for (const p of PAGES) {
      await page.evaluate((x) => { location.hash = `#/${x}`; }, p);
      await expect(page.locator('#main > *').first()).toBeVisible();
      await page.waitForTimeout(500);
      expect(await page.evaluate(layoutProblems), p).toEqual([]);
    }
  });

  test(`${name} (${width}x${height}): map labels don't sit on each other`, async ({ page, signIn }) => {
    await page.setViewportSize({ width, height });
    await signIn('owner');
    await expect(page.locator('.leaflet-marker-pane .vm').first()).toBeVisible();
    await page.waitForTimeout(500);
    const hits = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('.vm-label, .yard-label')].filter((e) => getComputedStyle(e).display !== 'none')
        .map((e) => ({ t: e.textContent.trim(), r: e.getBoundingClientRect() }));
      const out = [];
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].r, b = boxes[j].r;
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) out.push(`${boxes[i].t} / ${boxes[j].t}`);
      }
      return out;
    });
    expect(hits).toEqual([]);
  });
});

test('where the list sits: under the map on a phone, beside it from a tablet up', async ({ page, signIn }) => {
  await signIn('owner');
  await expect(page.locator('.live-side')).toBeVisible(); // signing in doesn't wait for the map page to be drawn
  const beside = () => page.evaluate(() => document.querySelector('.live-side').getBoundingClientRect().right <= document.querySelector('.map-wrap').getBoundingClientRect().left + 1);
  for (const [w, h, want] of [[390, 844, false], [768, 1024, true], [1024, 768, true], [1920, 1080, true]]) {
    await page.setViewportSize({ width: w, height: h });
    await expect.poll(beside, `${w}px`).toBe(want);
  }
});

test('notebook: the sidebar shrinks to icons, and keeps their names for hover and screen readers', async ({ page, signIn }) => {
  await signIn('owner');
  await page.setViewportSize({ width: 1100, height: 760 });
  await expect.poll(() => page.locator('.sidebar').evaluate((e) => e.getBoundingClientRect().width)).toBeLessThan(80);
  const link = page.locator('#nav a[data-path=darvoza]');
  await expect(link).toHaveAttribute('title', 'Darvoza');
  await expect(link).toHaveAccessibleName(/Darvoza/);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => page.locator('.sidebar').evaluate((e) => e.getBoundingClientRect().width)).toBeGreaterThan(200);
});

test('working trucks stand apart from parked ones: bigger, filled, labelled', async ({ page, signIn }) => {
  await signIn('owner');
  await page.setViewportSize({ width: 1440, height: 900 });
  const read = (status) => page.locator(`.vm.${status}`).first().evaluate((vm) => {
    const body = vm.querySelector('.vm-body');
    return { size: body.getBoundingClientRect().width, fill: getComputedStyle(body).backgroundColor, label: getComputedStyle(vm.querySelector('.vm-label')).display };
  });
  await expect(page.locator('.vm.moving').first()).toBeAttached();
  await expect(page.locator('.vm.stopped').first()).toBeAttached();
  const moving = await read('moving');
  const parked = await read('stopped');
  expect(moving.size).toBeGreaterThan(parked.size + 8);
  expect(moving.fill).not.toBe(parked.fill);
  expect(parked.label).toBe('none');
  // The list says the same thing as the map.
  const icon = (status) => page.locator(`.vrow.${status} .vicon`).first().evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(await icon('moving')).not.toBe(await icon('stopped'));
});

test('the yard can be found at any zoom', async ({ page, signIn }) => {
  await signIn('owner');
  await page.setViewportSize({ width: 1440, height: 900 });
  const halo = page.locator('.yard-halo');
  const label = page.locator('.yard-label');
  await expect(label).toBeVisible();
  await expect(page.locator('path.yard-area')).toHaveCount(1);
  // City zoom: its true area is a few pixels, so the marker stands in for it.
  await page.click('#fitBtn');
  await expect(halo).toBeVisible();
  const size = await halo.evaluate((e) => e.getBoundingClientRect().width);
  expect(size).toBeGreaterThan(40);
  // Close up: the true area is big enough on its own.
  await page.click('#yardBtn');
  await expect(halo).toBeHidden();
  const area = await page.locator('path.yard-area').evaluate((e) => e.getBoundingClientRect().width);
  expect(area).toBeGreaterThan(100);
  await expect(label).toBeVisible();
});

test('phone: the yard\'s name is not hidden behind the map buttons', async ({ page, signIn }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn('owner');
  await expect(page.locator('.yard-label')).toBeVisible();
  await page.waitForTimeout(400);
  const hit = await page.evaluate(() => {
    const y = document.querySelector('.yard-label').getBoundingClientRect();
    return [...document.querySelectorAll('.map-tools .btn, .leaflet-control-zoom')].map((e) => e.getBoundingClientRect())
      .some((b) => y.left < b.right && b.left < y.right && y.top < b.bottom && b.top < y.bottom);
  });
  expect(hit).toBe(false);
});

test('a tile that fails once is tried again, so the map has no holes', async ({ page, signIn }) => {
  const seen = new Set();
  let retried = false;
  await page.route(/\/api\/tiles\//, (route) => {
    const url = route.request().url();
    if (seen.has(url)) retried = true;
    if (!seen.has(url)) { seen.add(url); return route.fulfill({ status: 502, body: '' }); }
    return route.fallback();
  });
  await signIn('owner');
  await expect.poll(() => retried, { timeout: 10_000 }).toBe(true);
  await expect.poll(() => page.locator('.leaflet-tile-pane img').evaluateAll((a) => a.length > 0 && a.every((i) => i.complete && i.naturalWidth > 0)), { timeout: 10_000 }).toBe(true);
});

test('parked trucks show their labels once zoomed in', async ({ page, signIn }) => {
  await signIn('owner');
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('.vm.stopped').first()).toBeAttached();
  await page.click('#fitBtn');
  await expect(page.locator('.map-near')).toHaveCount(0);
  await page.click('#yardBtn');
  await expect(page.locator('.map-near')).toHaveCount(1);
});

test('login: "show password" works, and is off again after signing in', async ({ page, server }) => {
  await page.goto(server.url);
  await page.fill('[name=username]', 'owner');
  await page.fill('[name=password]', 'owner12345');
  await page.check('#showPw');
  await expect(page.locator('[name=password]')).toHaveAttribute('type', 'text');
  await page.uncheck('#showPw');
  await expect(page.locator('[name=password]')).toHaveAttribute('type', 'password');
  await page.check('#showPw');
  await page.click('#loginForm button[type=submit]');
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('[name=password]')).toHaveAttribute('type', 'password');
  await expect(page.locator('#showPw')).not.toBeChecked();
});

test('a truck in another region: the map opens on the work area, "Hammasi" shows it too', async ({ page, signIn }) => {
  // Bukhara, about 450 km from the yard. The stream is held back so that it can't move the truck home meanwhile.
  await page.route(/\/api\/stream/, () => {});
  await page.route(/\/api\/vehicles$/, async (route) => {
    const res = await route.fetch();
    const list = await res.json();
    Object.assign(list[0], { lat: 39.77, lng: 64.42, label: 'FAR AWAY', status: 'stopped' });
    await route.fulfill({ response: res, json: list });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn('owner');
  const far = page.locator('.vm[title="FAR AWAY"]');
  await expect(far).toBeAttached();
  const onMap = () => far.evaluate((vm) => {
    const a = vm.getBoundingClientRect(), b = vm.closest('.map').getBoundingClientRect();
    return a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom;
  });
  expect(await onMap()).toBe(false);
  await expect(page.locator('.yard-label')).toBeInViewport();
  await page.click('#fitBtn');
  await expect.poll(onMap).toBe(true);
});
