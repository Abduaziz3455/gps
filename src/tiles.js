'use strict';
/**
 * Map tiles, fetched by this server and passed on to the browser.
 *
 * OpenStreetMap answers browser requests that have no Referer with an "Access blocked" picture (status 200,
 * x-blocked header). Browsers, extensions and privacy settings can all strip the Referer, so here the request
 * carries what its policy asks for: an honest User-Agent and our address. Its caching headers go on to the browser.
 * https://operations.osmfoundation.org/policies/tiles/
 */
const { version } = require('../package.json');
const { httpError } = require('./auth');

const MAX_ZOOM = 19;
const TIMEOUT_MS = 15_000;

/**
 * At most `limit` requests to the tile server at a time, about what a browser would open by itself. The rest wait,
 * and leave the line when the browser no longer wants the tile (the map moved on).
 *
 * Moving around the map asks for hundreds of tiles. Without a limit each one can become a new connection and a DNS
 * lookup, and those share a small queue with the GPS polls: see src/dnscache.js.
 */
function createTileGate({ limit = 6, maxWaiting = 200, maxWaitMs = 10_000 } = {}) {
  let active = 0;
  const waiting = new Set();
  return {
    warnedAt: 0,
    /** Resolves 'go' (call release afterwards), 'gone' (the browser left) or 'busy' (too long a line, or too long a wait). */
    enter(res) {
      if (active < limit) { active++; return Promise.resolve('go'); }
      if (waiting.size >= maxWaiting) return Promise.resolve('busy');
      return new Promise((resolve) => {
        const entry = {
          done(result) {
            waiting.delete(entry);
            clearTimeout(timer);
            res.off('close', gone);
            resolve(result);
          },
        };
        const gone = () => entry.done('gone');
        const timer = setTimeout(() => entry.done('busy'), maxWaitMs);
        res.once('close', gone);
        waiting.add(entry);
      });
    },
    release() {
      const [next] = waiting;
      if (next) next.done('go'); // its place is the one just freed
      else active--;
    },
  };
}
const sharedGate = createTileGate();

function tileUrl({ z, x, y }, template) {
  if (![z, x, y].every((v) => /^\d{1,7}$/.test(v))) return null;
  const size = 2 ** Number(z);
  if (Number(z) > MAX_ZOOM || Number(x) >= size || Number(y) >= size) return null;
  return template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

async function serveTile(req, res, params, { config, log, tileGate: gate = sharedGate }) {
  const url = tileUrl(params, config.tiles.url);
  if (!url) throw httpError(404, 'Topilmadi');

  const turn = await gate.enter(res);
  if (turn === 'gone') return void res.end();
  if (turn === 'busy') { // expected under load, the map asks again: an answer, not an error with a stack in the log
    if (Date.now() - gate.warnedAt > 60_000) {
      gate.warnedAt = Date.now();
      log.warn?.('map tiles: too many waiting, some were refused');
    }
    res.statusCode = 503;
    res.setHeader('Retry-After', '2');
    return void res.end();
  }
  try {
    await fetchTile(req, res, url, { config, log });
  } finally {
    gate.release();
  }
}

async function fetchTile(req, res, url, { config, log }) {
  const origin = config.publicOrigin || 'https://tbb-gps.uz'; // a request without a Referer gets blocked, also in development
  const headers = { 'User-Agent': `TBB-Dispatcher/${version} (+${origin})`, Referer: `${origin}/` };
  if (req.headers['if-none-match']) headers['If-None-Match'] = req.headers['if-none-match'];

  let up;
  try {
    up = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    log.warn?.(`map tile: ${e.message}${e.cause?.code ? ` (${e.cause.code})` : ''}`);
    throw httpError(502, 'Xarita serveri javob bermadi');
  }
  const blocked = up.headers.get('x-blocked');
  if (blocked) log.warn?.(`map tile blocked: ${blocked}`);
  if (blocked || (!up.ok && up.status !== 304)) throw httpError(up.status === 404 ? 404 : 502, 'Xarita serveri javob bermadi');

  const etag = up.headers.get('etag');
  if (etag) res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', `private, ${up.headers.get('cache-control') || 'max-age=86400'}`);
  if (up.status === 304) {
    res.statusCode = 304;
    return void res.end();
  }
  const body = Buffer.from(await up.arrayBuffer());
  res.statusCode = 200;
  res.setHeader('Content-Type', up.headers.get('content-type') || 'image/png');
  res.setHeader('Content-Length', body.length);
  res.end(body);
}

module.exports = { serveTile, tileUrl, createTileGate };
