'use strict';
// Map tiles through our server: what is sent to OpenStreetMap, and what comes back to the browser.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { serveTile, tileUrl, createTileGate } = require('../src/tiles');

const listen = (handler) => new Promise((resolve) => {
  const s = http.createServer(handler).listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` }));
});

/** A fake tile server, and our route in front of it. */
async function rig(t, upstream, publicOrigin = 'https://site.example') {
  const seen = [];
  const osm = await listen((req, res) => { seen.push(req); upstream(req, res); });
  const warnings = [];
  const ctx = { config: { publicOrigin, tiles: { url: `${osm.url}/{z}/{x}/{y}.png` } }, log: { warn: (m) => warnings.push(m) } };
  const app = await listen((req, res) => {
    const [z, x, y] = req.url.split('/').slice(1);
    serveTile(req, res, { z, x, y }, ctx).catch((e) => { res.statusCode = e.status || 500; res.end(); });
  });
  t.after(() => { osm.s.close(); app.s.close(); });
  return { get: (p, headers = {}) => fetch(app.url + p, { headers }), seen, warnings };
}
const tile = (res) => {
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('ETag', '"abc"');
  res.setHeader('Cache-Control', 'max-age=1000');
  res.end('PNGDATA');
};

test('tile coordinates: only real ones reach the tile server', () => {
  const T = 'https://t/{z}/{x}/{y}.png';
  assert.equal(tileUrl({ z: '13', x: '5674', y: '3064' }, T), 'https://t/13/5674/3064.png');
  assert.equal(tileUrl({ z: '0', x: '0', y: '0' }, T), 'https://t/0/0/0.png');
  for (const bad of [{ z: '20', x: '0', y: '0' }, { z: '1', x: '2', y: '0' }, { z: '1', x: '0', y: '2' }, { z: '1', x: '-1', y: '0' },
    { z: '1', x: '0', y: '0.png' }, { z: '1', x: '..', y: '0' }, { z: 'x', x: '0', y: '0' }, { z: '1', x: '99999999', y: '0' }]) {
    assert.equal(tileUrl(bad, T), null, JSON.stringify(bad));
  }
});

test('a tile: asks with our identity, returns the image and the caching rules, privately', async (t) => {
  const r = await rig(t, (req, res) => tile(res));
  const res = await r.get('/13/5674/3064', { cookie: 'session=secret', referer: 'https://tbb-gps.uz/#/xarita' });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'PNGDATA');
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('etag'), '"abc"');
  assert.equal(res.headers.get('cache-control'), 'private, max-age=1000');
  const sent = r.seen[0].headers;
  assert.equal(r.seen[0].url, '/13/5674/3064.png');
  assert.equal(sent.referer, 'https://site.example/');
  assert.match(sent['user-agent'], /^TBB-Dispatcher\/\d/);
  assert.equal(sent.cookie, undefined, "the user's session never leaves our server");
});

test('without a configured address (development) the request still carries a Referer', async (t) => {
  const r = await rig(t, (req, res) => tile(res), '');
  assert.equal((await r.get('/1/0/0')).status, 200);
  assert.equal(r.seen[0].headers.referer, 'https://tbb-gps.uz/');
});

test('a tile the browser already has: 304 passes through', async (t) => {
  const r = await rig(t, (req, res) => { res.statusCode = req.headers['if-none-match'] === '"abc"' ? 304 : 500; res.setHeader('ETag', '"abc"'); res.end(); });
  const res = await r.get('/1/0/0', { 'if-none-match': '"abc"' });
  assert.equal(res.status, 304);
  assert.equal(res.headers.get('etag'), '"abc"');
});

test('blocked by the tile server: an error and a log line, never the "Access blocked" picture', async (t) => {
  const r = await rig(t, (req, res) => { res.setHeader('x-blocked', 'No referer sent'); tile(res); });
  const res = await r.get('/1/0/0');
  assert.equal(res.status, 502);
  assert.notEqual(await res.text(), 'PNGDATA');
  assert.match(r.warnings[0], /No referer sent/);
});

test('tile server errors and silence: 404 stays 404, the rest are 502', async (t) => {
  const missing = await rig(t, (req, res) => { res.statusCode = 404; res.end(); });
  assert.equal((await missing.get('/1/0/0')).status, 404);
  const broken = await rig(t, (req, res) => { res.statusCode = 503; res.end(); });
  assert.equal((await broken.get('/1/0/0')).status, 502);
  const gone = await rig(t, (req, res) => req.socket.destroy());
  assert.equal((await gone.get('/1/0/0')).status, 502);
  assert.equal(gone.warnings.length, 1);
});

test('bad coordinates: 404 without bothering the tile server', async (t) => {
  const r = await rig(t, (req, res) => tile(res));
  assert.equal((await r.get('/25/0/0')).status, 404);
  assert.equal(r.seen.length, 0);
});

// --- the limit on requests to the tile server --------------------------------------------------

/** A tile server that answers only when told to. */
function heldUpstream() {
  const held = [];
  let peak = 0, now = 0;
  return {
    handler: (req, res) => { peak = Math.max(peak, ++now); held.push(res); res.on('close', () => { now--; }); },
    free: () => { for (const res of held.splice(0)) tile(res); },
    get held() { return held.length; },
    get peak() { return peak; },
  };
}
const until = async (cond, what) => {
  for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), what);
};

/** Like rig(), with its own gate. Clients stay open only as long as the test holds them. */
async function gatedRig(t, up, gateOptions) {
  const osm = await listen(up.handler);
  const warnings = [];
  const ctx = { config: { publicOrigin: 'https://site.example', tiles: { url: `${osm.url}/{z}/{x}/{y}.png` } }, log: { warn: (m) => warnings.push(m) }, tileGate: createTileGate(gateOptions) };
  const app = await listen((req, res) => {
    const [z, x, y] = req.url.split('/').slice(1);
    serveTile(req, res, { z, x, y }, ctx).catch((e) => { res.statusCode = e.status || 500; res.end(); });
  });
  t.after(() => { osm.s.closeAllConnections(); osm.s.close(); app.s.closeAllConnections(); app.s.close(); });
  const get = (i, signal) => fetch(`${app.url}/5/${i % 32}/${Math.floor(i / 32)}`, { signal });
  return { get, warnings };
}

test('a burst of tiles: only the limit reaches the tile server at once, and every tile still arrives', async (t) => {
  const up = heldUpstream();
  const r = await gatedRig(t, up, { limit: 3 });
  const all = Array.from({ length: 30 }, (_, i) => r.get(i));
  let done = 0;
  all.forEach((p) => p.then(() => { done++; }));
  while (done < 30) {
    await until(() => up.held > 0 || done === 30, 'the next tiles reach the server');
    assert.ok(up.held <= 3);
    up.free();
    await new Promise((res) => setTimeout(res, 15));
  }
  assert.equal(up.peak, 3);
  for (const res of await Promise.all(all)) assert.equal(res.status, 200);
});

test('a line too long: refused at once with a 503 and one log line, the tile server is not asked', async (t) => {
  const up = heldUpstream();
  const r = await gatedRig(t, up, { limit: 1, maxWaiting: 2 });
  const kept = [r.get(0), r.get(1), r.get(2)];
  await until(() => up.held === 1, 'the first is at the tile server');
  await new Promise((res) => setTimeout(res, 30));
  const refused = await Promise.all([r.get(3), r.get(4)]);
  for (const res of refused) {
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('retry-after'), '2');
  }
  assert.equal(r.warnings.length, 1, 'one line, not one per tile');
  assert.equal(up.held, 1);
  const finish = setInterval(() => up.free(), 5);
  for (const res of await Promise.all(kept)) assert.equal(res.status, 200);
  clearInterval(finish);
});

test('waiting too long: refused, the place in line is not kept', async (t) => {
  const up = heldUpstream();
  const r = await gatedRig(t, up, { limit: 1, maxWaitMs: 50 });
  const first = r.get(0);
  await until(() => up.held === 1, 'the first is at the tile server');
  assert.equal((await r.get(1)).status, 503);
  up.free();
  assert.equal((await first).status, 200);
});

test('the browser no longer wants a waiting tile (the map moved on): it never reaches the tile server', async (t) => {
  const up = heldUpstream();
  const r = await gatedRig(t, up, { limit: 1 });
  const first = r.get(0);
  await until(() => up.held === 1, 'the first is at the tile server');
  const ac = new AbortController();
  const left = r.get(1, ac.signal).catch(() => 'aborted');
  await new Promise((res) => setTimeout(res, 30));
  ac.abort();
  assert.equal(await left, 'aborted');
  await new Promise((res) => setTimeout(res, 30));
  const next = r.get(2);
  await new Promise((res) => setTimeout(res, 30));
  up.free();
  assert.equal((await first).status, 200);
  await until(() => up.held === 1, 'the next in line gets its turn');
  up.free();
  assert.equal((await next).status, 200);
  assert.equal(up.peak, 1);
});

test('a place is given back after every outcome: errors and a silent tile server do not use up the limit', async (t) => {
  let answer = (req, res) => { res.statusCode = 500; res.end(); };
  const r = await gatedRig(t, { handler: (req, res) => answer(req, res) }, { limit: 2 });
  for (let i = 0; i < 5; i++) assert.equal((await r.get(i)).status, 502);
  answer = (req) => req.socket.destroy();
  for (let i = 0; i < 5; i++) assert.equal((await r.get(i)).status, 502);
  answer = (req, res) => tile(res);
  assert.equal((await r.get(0)).status, 200);
});

test("the app's context has its own `gate` (the cameras): tiles do not mistake it for theirs", async (t) => {
  const osm = await listen((req, res) => tile(res));
  const ctx = { config: { publicOrigin: 'https://site.example', tiles: { url: `${osm.url}/{z}/{x}/{y}.png` } }, log: {}, gate: { nvr: {} } };
  const app = await listen((req, res) => { serveTile(req, res, { z: '1', x: '0', y: '0' }, ctx).catch((e) => { res.statusCode = e.status || 500; res.end(String(e)); }); });
  t.after(() => { osm.s.close(); app.s.close(); });
  assert.equal((await fetch(app.url)).status, 200);
});
