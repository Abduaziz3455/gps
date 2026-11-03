'use strict';
// Hostile or malformed requests, anonymous: the server must answer and stay up. Each runs on its own server state,
// so one crash doesn't hide the others.
const base = require('@playwright/test');
const { TestServer } = require('../support/server');
const { Api, rawRequest } = require('../support/api');

const { expect } = base;
let s;

const test = base.test;
test.beforeAll(async () => {
  s = new TestServer({ name: `crash${process.pid}`, env: { CAMERA_BACKFILL_DAYS: '0' } }).seedFrom(process.env.E2E_TEMPLATE_DIR);
  await s.start();
});
test.afterAll(async () => { await s.destroy(); });
test.beforeEach(async () => { if (!s.alive) await s.start(); });

async function stillUp() {
  await new Promise((r) => setTimeout(r, 150));
  if (!s.alive) return false;
  try { return (await fetch(`${s.url}/health`, { signal: AbortSignal.timeout(3000) })).ok; } catch { return false; }
}

// [what, raw request head (without the Host line)]
const VECTORS = [
  ['broken percent-encoding in a page path', 'GET /%E0%A4%A HTTP/1.1'],
  ['broken percent-encoding, bare %', 'GET /% HTTP/1.1'],
  ['broken percent-encoding in an API id', 'GET /api/users/%E0%A4%A HTTP/1.1'],
  ['broken percent-encoding in a vehicle route', 'GET /api/vehicles/%FF/track HTTP/1.1'],
  ['broken percent-encoding in a session cookie', 'GET /api/me HTTP/1.1\r\nCookie: tbb_session=%E0%A4%A'],
  ['broken percent-encoding in another cookie', 'GET /api/me HTTP/1.1\r\nCookie: x=%'],
  ['a URL that is only slashes', 'GET // HTTP/1.1'],
  ['an invalid absolute URL', 'GET http://[ HTTP/1.1'],
  ['an absolute URL with a bad port', 'GET http://a:b/ HTTP/1.1'],
  ['a null byte in the path', 'GET /%00 HTTP/1.1'],
  ['a null byte in a file name', 'GET /js/main.js%00.png HTTP/1.1'],
  ['an unparsable Origin', 'POST /api/auth/logout HTTP/1.1\r\nOrigin: ::::\r\nContent-Length: 0'],
  ['a very long URL', `GET /${'a'.repeat(8000)} HTTP/1.1`],
  ['a very long query', `GET /api/me?x=${'a'.repeat(8000)} HTTP/1.1`],
  ['a route with an encoded slash', 'GET /api/vehicles/1%2F2/track HTTP/1.1'],
  ['a huge id', 'GET /api/vehicles/99999999999999999999999/track HTTP/1.1\r\nCookie: tbb_session=x'],
];

for (const [what, head] of VECTORS) {
  test(`stays up: ${what}`, async () => {
    const [line, ...rest] = head.split('\r\n');
    const r = await rawRequest(s.port, [line, `Host: 127.0.0.1:${s.port}`, ...rest].join('\r\n'));
    const up = await stillUp();
    expect(up, `the whole server went down from one anonymous request: ${what}\n${s.log.slice(-500)}`).toBe(true);
    expect(r.status, `no HTTP answer (${r.error})`).not.toBeNull();
    expect(r.status).toBeLessThan(500);
  });
}

test('stays up: a client that disconnects mid-body', async () => {
  await new Promise((resolve) => {
    const sock = require('node:net').connect({ host: '127.0.0.1', port: s.port }, () => {
      sock.write(`POST /api/auth/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"user`);
      setTimeout(() => { sock.destroy(); resolve(); }, 100);
    });
  });
  expect(await stillUp()).toBe(true);
});

test('stays up: a client that drops the live stream at once', async () => {
  const a = new Api(s.url);
  await a.login('owner', 'owner12345');
  for (let i = 0; i < 5; i++) {
    const ac = new AbortController();
    const p = fetch(`${s.url}/api/stream`, { headers: { cookie: a.cookie }, signal: ac.signal }).catch(() => {});
    ac.abort();
    await p;
  }
  expect(await stillUp()).toBe(true);
});

test('stays up: a client that drops while a photo downloads', async () => {
  const a = new Api(s.url);
  await a.login('owner', 'owner12345');
  const id = s.get("SELECT id FROM gate_events WHERE capture_uri LIKE '/mock/%' ORDER BY t DESC LIMIT 1").id;
  const ac = new AbortController();
  await fetch(`${s.url}/api/gate-events/${id}/photo/0`, { headers: { cookie: a.cookie }, signal: ac.signal }).then(() => ac.abort()).catch(() => {});
  expect(await stillUp()).toBe(true);
});

test('stays up: a burst of 200 concurrent requests', async () => {
  const a = new Api(s.url);
  await a.login('owner', 'owner12345');
  const rs = await Promise.all(Array.from({ length: 200 }, (_, i) => a.get(['/api/vehicles', '/api/gate-events', '/api/yard', '/api/today', '/api/alerts'][i % 5])));
  expect(rs.every((r) => r.status === 200)).toBe(true);
  expect(await stillUp()).toBe(true);
});

test.describe('path traversal', () => {
  for (const p of ['/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/package.json', '/..%5c..%5cpackage.json', '/js/..%2f..%2fserver.js', '/vendor/leaflet/..%2f..%2f..%2fpackage.json', '/vendor/leaflet/../../../server.js', '/js/../../server.js', '/....//....//server.js', '/%252e%252e/server.js']) {
    test(`can't escape public/: ${p}`, async () => {
      const r = await rawRequest(s.port, `GET ${p} HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nConnection: close`);
      expect(await stillUp()).toBe(true);
      expect(r.data).not.toMatch(/"dependencies"|TBB Dispatcher v2 server|require\('node:/);
    });
  }
});
