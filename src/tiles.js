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

function tileUrl({ z, x, y }, template) {
  if (![z, x, y].every((v) => /^\d{1,7}$/.test(v))) return null;
  const size = 2 ** Number(z);
  if (Number(z) > MAX_ZOOM || Number(x) >= size || Number(y) >= size) return null;
  return template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

async function serveTile(req, res, params, { config, log }) {
  const url = tileUrl(params, config.tiles.url);
  if (!url) throw httpError(404, 'Topilmadi');

  const origin = config.publicOrigin || 'https://tbb-gps.uz'; // a request without a Referer gets blocked, also in development
  const headers = { 'User-Agent': `TBB-Dispatcher/${version} (+${origin})`, Referer: `${origin}/` };
  if (req.headers['if-none-match']) headers['If-None-Match'] = req.headers['if-none-match'];

  let up;
  try {
    up = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    log.warn?.(`map tile: ${e.message}`);
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

module.exports = { serveTile, tileUrl };
