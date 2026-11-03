'use strict';
/**
 * HTTP Digest authentication (RFC 7616, qop=auth or the older no-qop form) over node:http / node:https.
 *
 * Hikvision ISAPI accepts only digest auth. Rather than paying a 401 round trip on every call, the client
 * keeps the last challenge and signs later requests with it, counting `nc` up as the RFC requires. When the
 * NVR rejects a cached nonce (expired or `stale=true`), the fresh challenge from that 401 is used for one
 * retry.
 */
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');

/** Hash names in the `algorithm` parameter mapped to node:crypto names. MD5 is what the NVR offers. */
const HASHES = { 'MD5': 'md5', 'SHA-256': 'sha256', 'SHA-512-256': 'sha512-256' };

const hash = (alg, s) => crypto.createHash(alg).update(s).digest('hex');

/**
 * Parse the parameters of one `WWW-Authenticate: Digest ...` value.
 * Returns null when the value is not a Digest challenge (e.g. Basic).
 * @param {string} header
 * @returns {{realm?: string, nonce?: string, qop?: string, opaque?: string, algorithm?: string, stale?: string} | null}
 */
function parseChallenge(header) {
  const m = /^\s*Digest\s+(.*)$/is.exec(header || '');
  if (!m) return null;
  const params = {};
  const re = /([\w-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]*))/g;
  let p;
  while ((p = re.exec(m[1]))) params[p[1].toLowerCase()] = p[2] !== undefined ? p[2].replace(/\\(.)/g, '$1') : p[3];
  return params.nonce ? params : null;
}

/** The Digest challenge among a response's (possibly repeated) WWW-Authenticate headers. */
function findChallenge(res) {
  const raw = res.rawHeaders || [];
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i].toLowerCase() === 'www-authenticate') {
      const c = parseChallenge(raw[i + 1]);
      if (c) return c;
    }
  }
  return null;
}

/**
 * Build the Authorization header value for one request.
 * @param {{user: string, password: string, method: string, uri: string, challenge: object, nc: number, cnonce?: string}} o
 */
function authorization({ user, password, method, uri, challenge: c, nc, cnonce = crypto.randomBytes(8).toString('hex') }) {
  const algName = (c.algorithm || 'MD5').toUpperCase();
  const sess = algName.endsWith('-SESS');
  const alg = HASHES[sess ? algName.slice(0, -5) : algName];
  if (!alg) throw new Error(`unsupported digest algorithm ${c.algorithm}`);
  let ha1 = hash(alg, `${user}:${c.realm || ''}:${password}`);
  if (sess) ha1 = hash(alg, `${ha1}:${c.nonce}:${cnonce}`);
  const ha2 = hash(alg, `${method}:${uri}`);
  // The server may offer "auth,auth-int"; we only ever sign the headers (auth).
  const qop = c.qop && c.qop.split(',').map((s) => s.trim()).includes('auth') ? 'auth' : null;
  const ncHex = nc.toString(16).padStart(8, '0');
  const response = qop
    ? hash(alg, `${ha1}:${c.nonce}:${ncHex}:${cnonce}:${qop}:${ha2}`)
    : hash(alg, `${ha1}:${c.nonce}:${ha2}`);
  const q = (s) => `"${String(s).replace(/(["\\])/g, '\\$1')}"`;
  const parts = [
    `username=${q(user)}`, `realm=${q(c.realm || '')}`, `nonce=${q(c.nonce)}`, `uri=${q(uri)}`,
    `algorithm=${c.algorithm || 'MD5'}`, `response=${q(response)}`,
  ];
  if (c.opaque !== undefined) parts.push(`opaque=${q(c.opaque)}`);
  if (qop) parts.push(`qop=${qop}`, `nc=${ncHex}`, `cnonce=${q(cnonce)}`);
  return `Digest ${parts.join(', ')}`;
}

/**
 * One plain HTTP(S) request. The timeout is an inactivity timeout (like Python requests): no bytes for
 * `timeoutMs` aborts. With `stream`, it only covers waiting for the response headers; the caller then owns
 * the IncomingMessage and its own idle handling (the NVR's event stream never ends on its own).
 * @param {{method?: string, url: string|URL, headers?: object, body?: Buffer|string, timeoutMs?: number,
 *   stream?: boolean, agent?: http.Agent, rejectUnauthorized?: boolean}} opts
 * @returns {Promise<{status: number, headers: object, rawHeaders: string[], body: Buffer} | http.IncomingMessage>}
 */
function rawRequest({ method = 'GET', url, headers = {}, body, timeoutMs = 90000, stream = false, agent, rejectUnauthorized }) {
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  const hdrs = { ...headers };
  if (body !== undefined && body !== null) hdrs['Content-Length'] = Buffer.byteLength(body);
  const options = { method, headers: hdrs, agent };
  if (rejectUnauthorized !== undefined) options.rejectUnauthorized = rejectUnauthorized;
  return new Promise((resolve, reject) => {
    const req = mod.request(u, options, (res) => {
      if (stream) {
        req.setTimeout(0);
        return resolve(res);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks),
      }));
      res.on('error', reject);
      res.on('aborted', () => reject(new Error(`${method} ${u.pathname}: response aborted`)));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`${method} ${u.pathname}: timed out after ${timeoutMs} ms`)));
    req.on('error', reject);
    if (body !== undefined && body !== null) req.write(body);
    req.end();
  });
}

/** Read and drop a streamed response body (a 401 we are about to retry), so the socket is freed. */
function drain(res) {
  return new Promise((resolve) => {
    res.on('end', resolve);
    res.on('close', resolve);
    res.on('error', resolve);
    res.resume();
  });
}

/**
 * A digest-authenticating HTTP client for one set of credentials (one device).
 */
class DigestClient {
  /**
   * @param {{user: string, password: string, rejectUnauthorized?: boolean}} o
   *   rejectUnauthorized: pass false for an https NVR with a self-signed certificate.
   */
  constructor({ user, password, rejectUnauthorized }) {
    this.user = user;
    this.password = password;
    this.rejectUnauthorized = rejectUnauthorized;
    this.challenge = null; // last Digest challenge seen
    this.nc = 0; // requests signed with this.challenge so far
    this.agents = { 'http:': new http.Agent({ keepAlive: true }), 'https:': new https.Agent({ keepAlive: true }) };
  }

  _sign(method, url) {
    const u = new URL(url);
    this.nc += 1;
    return authorization({
      user: this.user, password: this.password, method, uri: u.pathname + u.search, challenge: this.challenge, nc: this.nc,
    });
  }

  /**
   * Send a request, authenticating with digest. Sends once (signed if a challenge is cached); on 401 takes
   * the new challenge and retries once. Any other status is returned to the caller unchanged.
   * @param {{method?: string, url: string|URL, headers?: object, body?: Buffer|string, timeoutMs?: number, stream?: boolean}} opts
   * @returns {Promise<{status: number, headers: object, body: Buffer} | import('node:http').IncomingMessage>}
   *   With `stream: true`, the raw IncomingMessage (check `.statusCode`).
   */
  async request(opts) {
    const method = opts.method || 'GET';
    const send = () => {
      const headers = { ...(opts.headers || {}) };
      if (this.challenge) headers.Authorization = this._sign(method, opts.url);
      const agent = this.agents[new URL(opts.url).protocol];
      return rawRequest({ ...opts, method, headers, agent, rejectUnauthorized: this.rejectUnauthorized });
    };
    const res = await send();
    const status = opts.stream ? res.statusCode : res.status;
    if (status !== 401) return res;
    const challenge = findChallenge(res);
    if (opts.stream) await drain(res);
    if (!challenge) return res; // not a digest server; let the caller see the 401
    this.challenge = challenge;
    this.nc = 0;
    return send();
  }

  /** Close idle keep-alive sockets (for shutdown and tests). */
  close() {
    for (const a of Object.values(this.agents)) a.destroy();
  }
}

module.exports = { DigestClient, rawRequest, parseChallenge, authorization };
