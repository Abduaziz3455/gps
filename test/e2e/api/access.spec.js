'use strict';
// Who may call what. The table is checked against src/api.js, so a new route can't slip past without a row here.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('../support/fixtures');
const { REPO } = require('../support/server');
const { FLEET } = require('../support/seed');

const V = FLEET.fuel;
// [method, route as written in api.js, concrete path, access]
const ROUTES = [
  ['GET', '/api/vehicles', '/api/vehicles', 'user'],
  ['GET', '/api/tiles/:z/:x/:y', '/api/tiles/1/0/0', 'user'],
  ['PATCH', '/api/vehicles/:id', `/api/vehicles/${V}`, 'owner'],
  ['GET', '/api/vehicles/all', '/api/vehicles/all', 'owner'],
  ['GET', '/api/vehicles/:id/track', `/api/vehicles/${V}/track`, 'user'],
  ['GET', '/api/vehicles/:id/days', `/api/vehicles/${V}/days`, 'user'],
  ['GET', '/api/vehicles/:id/events', `/api/vehicles/${V}/events`, 'user'],
  ['GET', '/api/vehicles/:id/stops', `/api/vehicles/${V}/stops`, 'user'],
  ['GET', '/api/vehicles/:id/summary', `/api/vehicles/${V}/summary`, 'user'],
  ['GET', '/api/vehicles/:id/places', `/api/vehicles/${V}/places`, 'user'],
  ['GET', '/api/places', '/api/places', 'user'],
  ['GET', '/api/places/stats', '/api/places/stats', 'user'],
  ['GET', '/api/places/common', '/api/places/common', 'owner'],
  ['POST', '/api/places/common/search', '/api/places/common/search', 'owner'],
  ['POST', '/api/places/common/hide', '/api/places/common/hide', 'owner'],
  ['GET', '/api/places/common/ignored', '/api/places/common/ignored', 'owner'],
  ['POST', '/api/places/common/restore', '/api/places/common/restore', 'owner'],
  ['GET', '/api/places/:id/vehicles', '/api/places/1/vehicles', 'user'],
  ['POST', '/api/places', '/api/places', 'owner'],
  ['PATCH', '/api/places/:id', '/api/places/1', 'owner'],
  ['DELETE', '/api/places/:id', '/api/places/1', 'owner'],
  ['GET', '/api/gate-events', '/api/gate-events', 'user'],
  ['GET', '/api/gate-events/:id', '/api/gate-events/1', 'user'],
  ['PATCH', '/api/gate-events/:id', '/api/gate-events/1', 'user'],
  ['GET', '/api/gate-events/:id/photo/:n', '/api/gate-events/1/photo/0', 'user'],
  ['GET', '/api/push-image/:id', '/api/push-image/1', 'signed'],
  ['GET', '/api/yard', '/api/yard', 'user'],
  ['GET', '/api/today', '/api/today', 'user'],
  ['GET', '/api/alerts', '/api/alerts', 'user'],
  ['POST', '/api/alerts/:id/ack', '/api/alerts/1/ack', 'user'],
  ['POST', '/api/alerts/ack-all', '/api/alerts/ack-all', 'user'],
  ['GET', '/api/analytics/overview', '/api/analytics/overview', 'owner'],
  ['GET', '/api/analytics/series', '/api/analytics/series', 'owner'],
  ['GET', '/api/analytics/vehicles', '/api/analytics/vehicles', 'owner'],
  ['GET', '/api/reports/vehicles', '/api/reports/vehicles', 'user'],
  ['POST', '/api/analytics/recompute', '/api/analytics/recompute', 'owner'],
  ['GET', '/api/users', '/api/users', 'owner'],
  ['POST', '/api/users', '/api/users', 'owner'],
  ['PATCH', '/api/users/:id', '/api/users/1', 'owner'],
  ['DELETE', '/api/users/:id', '/api/users/1', 'owner'],
  ['POST', '/api/auth/login', '/api/auth/login', 'public'],
  ['POST', '/api/auth/logout', '/api/auth/logout', 'public'],
  ['GET', '/api/me', '/api/me', 'user'],
  ['POST', '/api/me/password', '/api/me/password', 'user'],
  ['POST', '/api/push/subscribe', '/api/push/subscribe', 'user'],
  ['POST', '/api/push/prefs', '/api/push/prefs', 'user'],
  ['POST', '/api/push/status', '/api/push/status', 'user'],
  ['POST', '/api/push/unsubscribe', '/api/push/unsubscribe', 'user'],
  ['POST', '/api/push/test', '/api/push/test', 'user'],
  ['GET', '/api/health', '/api/health', 'user'],
  ['GET', '/api/system', '/api/system', 'owner'],
  ['GET', '/api/stream', '/api/stream', 'user'],
];

test('every route in src/api.js is covered by the access table', () => {
  const src = fs.readFileSync(path.join(REPO, 'src/api.js'), 'utf8');
  const found = [...src.matchAll(/\br\.(get|post|patch|delete)\('(\/api\/[^']+)'/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`).sort();
  const listed = ROUTES.map(([m, r]) => `${m} ${r}`).sort();
  expect(listed).toEqual(found);
});

for (const [method, , url, access] of ROUTES) {
  if (access === 'user' || access === 'owner') {
    test(`anonymous is refused: ${method} ${url}`, async ({ anon }) => {
      const r = await anon.call(method, url, method === 'GET' ? {} : { body: {} });
      expect(r.status).toBe(401);
      expect(r.data.error).toBeTruthy();
    });
    test(`invalid session is refused: ${method} ${url}`, async ({ anon }) => {
      const r = await anon.call(method, url, { cookie: 'tbb_session=not-a-real-token', ...(method === 'GET' ? {} : { body: {} }) });
      expect(r.status).toBe(401);
    });
  }
  if (access === 'owner') {
    test(`dispatcher is refused: ${method} ${url}`, async ({ dispatcher }) => {
      const r = await dispatcher.call(method, url, method === 'GET' ? {} : { body: {} });
      expect(r.status).toBe(403);
    });
    if (method === 'GET') {
      test(`owner is allowed: ${method} ${url}`, async ({ owner }) => {
        expect((await owner.get(url)).status).toBe(200);
      });
    }
  }
  if (access === 'user' && method === 'GET' && url !== '/api/stream') {
    for (const who of ['owner', 'dispatcher']) {
      test(`${who} is allowed: GET ${url}`, async ({ owner, dispatcher, server }) => {
        const client = who === 'owner' ? owner : dispatcher;
        const place = url.startsWith('/api/places/1/') ? (await owner.post('/api/places', { name: `Ruxsat ${who}`, lat: 41.9, lng: 69.9 })).data : null;
        const u = url.replace('/gate-events/1', `/gate-events/${server.get('SELECT MIN(id) id FROM gate_events').id}`).replace('/places/1/', `/places/${place?.id}/`);
        try {
          expect((await client.get(u)).status).toBe(200);
        } finally { if (place) await owner.del(`/api/places/${place.id}`); }
      });
    }
  }
}

test('unknown API routes answer JSON 404, for everyone', async ({ anon, owner }) => {
  for (const c of [anon, owner]) {
    const r = await c.get('/api/nope');
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type')).toContain('application/json');
  }
  expect((await owner.call('DELETE', '/api/vehicles')).status).toBe(404);
  expect((await owner.call('PUT', '/api/users/1', { body: {} })).status).toBe(404);
});

test('API responses are never cached and never sniffed', async ({ owner }) => {
  const r = await owner.get('/api/me');
  expect(r.headers.get('cache-control')).toBe('no-store');
  expect(r.headers.get('x-content-type-options')).toBe('nosniff');
});

test('a dispatcher can change neither owners nor themselves into owners', async ({ dispatcher, server }) => {
  const me = (await dispatcher.get('/api/me')).data.user;
  expect((await dispatcher.patch(`/api/users/${me.id}`, { role: 'owner' })).status).toBe(403);
  expect(server.get('SELECT role FROM users WHERE id = ?', me.id).role).toBe('dispatcher');
});
