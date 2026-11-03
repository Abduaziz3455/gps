'use strict';
const { test, expect } = require('../support/fixtures');
const { Api, openStream } = require('../support/api');
const { uid, alert, gateEvent, FLEET, dayStart } = require('../support/seed');

// Endpoints on a closed local port: sending fails at once and nothing leaves the machine.
const endpoint = () => `https://127.0.0.1:1/${uid()}`;
const P256 = 'BNNL5ZaTfK81qhXOx23-wewhigUeFb632jN6LvRWCFH1ubQr77FE_9qV1FuojuRmHP42zmf34rXgW80OvUVDgTk';
const AUTH = 'zqbxT6JKstKSY9JKibZLSQ';
const sub = (ep = endpoint()) => ({ endpoint: ep, keys: { p256dh: P256, auth: AUTH } });

test.describe('push subscriptions', () => {
  test('subscribe with defaults, then read them back', async ({ dispatcher }) => {
    const s = sub();
    const r = await dispatcher.post('/api/push/subscribe', { subscription: s });
    expect(r.status).toBe(200);
    expect(r.data.prefs).toEqual({ gateIn: true, gateOut: true, onlyFleet: false, alerts: true, system: true, quietFrom: '', quietTo: '' });
    expect((await dispatcher.post('/api/push/status', { endpoint: s.endpoint })).data.endpoint).toBe(s.endpoint);
  });

  for (const [name, s] of [
    ['nothing', undefined], ['no endpoint', { keys: { p256dh: 'x', auth: 'y' } }], ['http endpoint', { endpoint: 'http://push.example/1', keys: { p256dh: 'x', auth: 'y' } }],
    ['not a string', { endpoint: 5, keys: { p256dh: 'x', auth: 'y' } }], ['no keys', { endpoint: 'https://a/b' }], ['missing auth key', { endpoint: 'https://a/b', keys: { p256dh: 'x' } }],
  ]) {
    test(`invalid subscription: 400, ${name}`, async ({ dispatcher }) => {
      expect((await dispatcher.post('/api/push/subscribe', { subscription: s })).status).toBe(400);
    });
  }

  test('prefs: only known keys; booleans coerced; bad times cleared; partial updates merge', async ({ dispatcher }) => {
    const s = sub();
    await dispatcher.post('/api/push/subscribe', { subscription: s, prefs: { gateIn: false, evil: 1, quietFrom: '22:00', quietTo: '25h' } });
    const st = (await dispatcher.post('/api/push/status', { endpoint: s.endpoint })).data.prefs;
    expect(st.gateIn).toBe(false);
    expect(st.quietFrom).toBe('22:00');
    expect(st.quietTo).toBe('');
    expect(st).not.toHaveProperty('evil');
    const r = await dispatcher.post('/api/push/prefs', { endpoint: s.endpoint, prefs: { gateOut: false } });
    expect(r.data.prefs).toMatchObject({ gateIn: false, gateOut: false, alerts: true });
  });

  test('a time like 99:99 is not a time', async ({ dispatcher }) => {
    const s = sub();
    await dispatcher.post('/api/push/subscribe', { subscription: s, prefs: { quietFrom: '99:99', quietTo: '07:00' } });
    expect((await dispatcher.post('/api/push/status', { endpoint: s.endpoint })).data.prefs.quietFrom).toBe('');
  });

  test('prefs for an unknown endpoint: 404', async ({ dispatcher }) => {
    expect((await dispatcher.post('/api/push/prefs', { endpoint: 'https://none/x', prefs: {} })).status).toBe(404);
  });

  test('another user can\'t read, change or remove my subscription', async ({ dispatcher, owner, server }) => {
    const s = sub();
    await dispatcher.post('/api/push/subscribe', { subscription: s, prefs: { gateIn: false } });
    expect((await owner.post('/api/push/status', { endpoint: s.endpoint })).data.endpoint).toBeNull();
    expect((await owner.post('/api/push/prefs', { endpoint: s.endpoint, prefs: { gateIn: true } })).status).toBe(404);
    await owner.post('/api/push/unsubscribe', { endpoint: s.endpoint });
    expect((await dispatcher.post('/api/push/status', { endpoint: s.endpoint })).data.prefs.gateIn).toBe(false);
    expect(server.get('SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint = ?', s.endpoint).n).toBe(1);
  });

  test('re-subscribing the same device under another login moves it (shared phone)', async ({ dispatcher, owner, server }) => {
    const s = sub();
    await dispatcher.post('/api/push/subscribe', { subscription: s });
    await owner.post('/api/push/subscribe', { subscription: s });
    const me = (await owner.get('/api/me')).data.user.id;
    expect(server.get('SELECT user_id u FROM push_subscriptions WHERE endpoint = ?', s.endpoint).u).toBe(me);
    expect(server.get('SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint = ?', s.endpoint).n).toBe(1);
  });

  test('unsubscribe removes it; repeating is harmless', async ({ dispatcher, server }) => {
    const s = sub();
    await dispatcher.post('/api/push/subscribe', { subscription: s });
    expect((await dispatcher.post('/api/push/unsubscribe', { endpoint: s.endpoint })).status).toBe(200);
    expect((await dispatcher.post('/api/push/unsubscribe', { endpoint: s.endpoint })).status).toBe(200);
    expect(server.get('SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint = ?', s.endpoint).n).toBe(0);
  });

  test('test message to an unreachable push service: counted as failed, the subscription stays', async ({ owner, server }) => {
    const s = sub();
    await owner.post('/api/push/subscribe', { subscription: s });
    const before = (await owner.get('/api/system')).data.push;
    expect((await owner.post('/api/push/test', { endpoint: s.endpoint })).status).toBe(200);
    const after = (await owner.get('/api/system')).data.push;
    expect(after.failed).toBe(before.failed + 1);
    const row = server.get('SELECT fails FROM push_subscriptions WHERE endpoint = ?', s.endpoint);
    expect(row.fails).toBe(1);
    await owner.post('/api/push/unsubscribe', { endpoint: s.endpoint });
  });

  test('a test message only goes to the caller\'s own devices', async ({ owner, dispatcher }) => {
    const s = sub();
    await dispatcher.post('/api/push/subscribe', { subscription: s });
    const before = (await owner.get('/api/system')).data.push.failed;
    await owner.post('/api/push/test', { endpoint: s.endpoint });
    expect((await owner.get('/api/system')).data.push.failed, 'the dispatcher\'s device was not contacted').toBe(before);
    await dispatcher.post('/api/push/unsubscribe', { endpoint: s.endpoint });
  });
});

test.describe('live stream', () => {
  test('anonymous: 401', async ({ server }) => {
    const st = openStream(server.url, '');
    await st.ready;
    expect(st.state.status).toBe(401);
  });

  test('says hello, as an event stream', async ({ owner, server }) => {
    const st = openStream(server.url, owner.cookie);
    await st.ready;
    try {
      expect(st.state.status).toBe(200);
      expect(st.state.contentType).toContain('text/event-stream');
      const e = await st.next('hello', { past: true });
      expect(e.data.time).toBeGreaterThan(0);
    } finally { st.close(); }
  });

  test('positions arrive within a poll, for active vehicles only', async ({ owner, server }) => {
    await owner.patch(`/api/vehicles/${FLEET.fuel}`, { active: false });
    const st = openStream(server.url, owner.cookie);
    await st.ready;
    try {
      await st.next('vehicles', { timeoutMs: 5000, past: true }).catch(() => {});
      for (let i = 0; i < 2; i++) {
        const e = await st.next('positions', { timeoutMs: 30_000 });
        expect(e.data[0]).toHaveProperty('lat');
        expect(e.data.some((p) => p.id === FLEET.fuel), 'hidden vehicles are not sent').toBe(false);
      }
    } finally { st.close(); await owner.patch(`/api/vehicles/${FLEET.fuel}`, { active: true }); }
  });

  test('a vehicle edit is announced to other sessions', async ({ owner, dispatcher, server }) => {
    const st = openStream(server.url, dispatcher.cookie);
    await st.ready;
    try {
      const wait = st.next('vehicles');
      await owner.patch(`/api/vehicles/${FLEET.parked}`, { display: `D${uid()}` });
      await wait;
    } finally { st.close(); await owner.patch(`/api/vehicles/${FLEET.parked}`, { display: '' }); }
  });

  test('a gate correction is announced', async ({ owner, dispatcher, server }) => {
    const id = gateEvent(server, { t: dayStart('2020-05-01'), status: 'outside', plate: 'P1' });
    const st = openStream(server.url, dispatcher.cookie);
    await st.ready;
    try {
      const wait = st.next('gate:update', { where: (d) => d.id === id });
      await owner.patch(`/api/gate-events/${id}`, { hidden: true });
      expect((await wait).data.status).toBe('vetoed');
    } finally { st.close(); server.run('DELETE FROM gate_events WHERE id = ?', id); }
  });

  test('an acknowledgement is announced', async ({ owner, dispatcher, server }) => {
    const id = alert(server);
    const st = openStream(server.url, dispatcher.cookie);
    await st.ready;
    try {
      const wait = st.next('alert:update', { where: (d) => d?.id === id });
      await owner.post(`/api/alerts/${id}/ack`);
      expect((await wait).data.ackedAt).toBeTruthy();
    } finally { st.close(); }
  });

  test('many streams at once: all served, no listener warnings; closing them frees everything', async ({ owner, server }) => {
    const streams = Array.from({ length: 25 }, () => openStream(server.url, owner.cookie));
    await Promise.all(streams.map((s) => s.ready));
    expect(streams.every((s) => s.state.status === 200)).toBe(true);
    streams.forEach((s) => s.close());
    await new Promise((r) => setTimeout(r, 500));
    expect((await owner.get('/api/me')).status).toBe(200);
    expect(server.log).not.toMatch(/MaxListenersExceededWarning/);
  });

  test('logging out closes the stream: a signed-out browser stops receiving', async ({ server }) => {
    const c = new Api(server.url);
    await c.login('owner', 'owner12345');
    const st = openStream(server.url, c.cookie);
    await st.ready;
    await c.post('/api/auth/logout');
    await expect.poll(() => st.state.ended, { timeout: 45_000, message: 'stream should end after logout' }).toBe(true);
    st.close();
  });

  test('disabling a user closes their stream: they stop seeing the fleet', async ({ owner, server }) => {
    const u = `sse${uid()}`;
    const { data } = await owner.post('/api/users', { username: u, role: 'dispatcher', password: 'password-1' });
    const c = new Api(server.url);
    await c.login(u, 'password-1');
    const st = openStream(server.url, c.cookie);
    await st.ready;
    await owner.patch(`/api/users/${data.id}`, { disabled: true });
    await expect.poll(() => st.state.ended, { timeout: 45_000, message: 'a blocked user must not keep receiving positions' }).toBe(true);
    st.close();
  });
});

test.describe('health endpoints', () => {
  for (const p of ['/health', '/healthz']) {
    test(`${p}: public, minimal`, async ({ anon }) => {
      const r = await anon.get(p);
      expect(r.status).toBe(200);
      expect(Object.keys(r.data).sort()).toEqual(['gps', 'nvr', 'status', 'uptime', 'version']);
      expect(r.data.status).toBe('ok');
    });
  }

  test('/api/health: parts in plain words', async ({ dispatcher }) => {
    const { data } = await dispatcher.get('/api/health');
    expect(data.gps).toMatchObject({ error: null });
    expect(data.nvr).toMatchObject({ enabled: true });
    expect(data.status.parts.map((p) => p.id)).toEqual(['server', 'gps', 'site', 'nvr', 'camera']);
  });

  test('/api/system: counts add up, and no secret is exposed', async ({ owner, server }) => {
    const { data } = await owner.get('/api/system');
    expect(data.counts.users).toBe(server.get('SELECT COUNT(*) n FROM users').n);
    expect(data.counts.gateEvents).toBe(server.get('SELECT COUNT(*) n FROM gate_events').n);
    expect(data.dbBytes).toBeGreaterThan(0);
    expect(data.config.cameras.length).toBe(2);
    expect(JSON.stringify(data)).not.toMatch(/password|privateKey|image_secret|vapid/i);
  });
});

test.describe('static files', () => {
  const HEADERS = {
    'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  };

  for (const p of ['/', '/index.html', '/js/main.js', '/css/app.css', '/sw.js', '/vendor/leaflet/leaflet.js', '/api/me', '/health', '/nope.png']) {
    test(`security headers on ${p}`, async ({ anon }) => {
      const r = await anon.get(p);
      for (const [k, v] of Object.entries(HEADERS)) expect(r.headers.get(k), k).toBe(v);
      const csp = r.headers.get('content-security-policy');
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    });
  }

  test('no HSTS in development (it would break plain localhost)', async ({ anon }) => {
    expect((await anon.get('/')).headers.get('strict-transport-security')).toBeNull();
  });

  for (const [p, type] of [
    ['/', 'text/html'], ['/css/app.css', 'text/css'], ['/js/main.js', 'text/javascript'], ['/manifest.webmanifest', 'application/manifest+json'],
    ['/icons/icon.svg', 'image/svg+xml'], ['/icons/icon-192.png', 'image/png'], ['/vendor/leaflet/leaflet.css', 'text/css'], ['/vendor/leaflet/images/marker-icon.png', 'image/png'],
  ]) {
    test(`${p} is served as ${type}`, async ({ anon }) => {
      const r = await anon.get(p);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain(type);
    });
  }

  test('every page module and icon the app references exists', async ({ anon }) => {
    for (const p of ['live', 'gate', 'alerts', 'vehicle', 'analytics', 'reports', 'settings']) expect((await anon.get(`/js/pages/${p}.js`)).status, p).toBe(200);
    for (const p of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'badge-72.png']) expect((await anon.get(`/icons/${p}`)).status, p).toBe(200);
    for (const p of ['/js/api.js', '/js/ui.js', '/js/map.js', '/js/charts.js', '/js/theme.js']) expect((await anon.get(p)).status, p).toBe(200);
  });

  test('the web app manifest is installable', async ({ anon }) => {
    const m = (await anon.get('/manifest.webmanifest')).data;
    expect(m).toMatchObject({ display: 'standalone', scope: '/', lang: 'uz' });
    for (const i of m.icons) expect((await anon.get(i.src)).status, i.src).toBe(200);
    expect(m.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable')).toBe(true);
    expect(m.icons.some((i) => i.sizes === '192x192')).toBe(true);
  });

  test('caching: revalidated pages and service worker; ETag gives 304', async ({ anon }) => {
    expect((await anon.get('/')).headers.get('cache-control')).toBe('no-cache');
    expect((await anon.get('/sw.js')).headers.get('cache-control')).toBe('no-cache');
    expect((await anon.get('/js/main.js')).headers.get('cache-control')).toContain('max-age');
    const a = await anon.get('/css/app.css');
    const r = await anon.get('/css/app.css', { headers: { 'if-none-match': a.headers.get('etag') } });
    expect(r.status).toBe(304);
    expect(r.text).toBe('');
  });

  test('HEAD works; other methods on pages: 405', async ({ anon }) => {
    const h = await anon.call('HEAD', '/css/app.css');
    expect(h.status).toBe(200);
    expect(h.text).toBe('');
    expect((await anon.call('POST', '/', { body: {} })).status).toBe(405);
    expect((await anon.call('DELETE', '/index.html')).status).toBe(405);
  });

  test('app routes without an extension get the page; a missing asset is 404', async ({ anon }) => {
    expect((await anon.get('/some/deep/path')).headers.get('content-type')).toContain('text/html');
    expect((await anon.get('/js/nope.js')).status).toBe(404);
    expect((await anon.get('/nope.png')).status).toBe(404);
  });

  test('a missing vendor file is 404, not the page with status 200', async ({ anon }) => {
    expect((await anon.get('/vendor/leaflet/nope.js')).status).toBe(404);
  });

  for (const p of ['/.env', '/server.js', '/package.json', '/src/api.js', '/data/dispatcher.db', '/dispatcher.db', '/node_modules/leaflet/package.json']) {
    test(`not served: ${p}`, async ({ anon }) => {
      const r = await anon.get(p);
      expect(r.status === 404 || r.headers.get('content-type').includes('text/html'), `${p} -> ${r.status}`).toBe(true);
      expect(r.text).not.toMatch(/GPS_PASSWORD|require\('node:|"dependencies"|SQLite format/);
    });
  }

  test('the page source holds no credentials or inline scripts', async ({ anon }) => {
    const r = await anon.get('/');
    expect(r.text).not.toMatch(/password\s*[:=]\s*['"][^'"]+/i);
    expect(r.text.match(/<script(?![^>]*\bsrc=)[^>]*>/g), 'CSP forbids inline scripts').toBeNull();
    expect(r.text).toContain('lang="uz"');
  });
});
