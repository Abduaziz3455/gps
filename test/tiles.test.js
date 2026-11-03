'use strict';
// Map tiles through our server: what is sent to OpenStreetMap, and what comes back to the browser.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { serveTile, tileUrl } = require('../src/tiles');

const listen = (handler) => new Promise((resolve) => {
  const s = http.createServer(handler).listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` }));
});

/** A fake tile server, and our route in front of it. */
async function rig(t, upstream, publicOrigin = 'https://tbb-gps.uz') {
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
  assert.equal(sent.referer, 'https://tbb-gps.uz/');
  assert.match(sent['user-agent'], /^TBB-Dispatcher\/\d/);
  assert.equal(sent.cookie, undefined, "the user's session never leaves our server");
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
