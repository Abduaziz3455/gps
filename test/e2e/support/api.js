'use strict';
/** HTTP client for the tests: JSON, cookie, raw sockets for requests fetch refuses to send, and SSE. */
const net = require('node:net');
const crypto = require('node:crypto');

/** A different address per client, so login-throttle counts don't leak between tests (nginx sets X-Real-IP). */
const randomIp = () => `10.${crypto.randomInt(255)}.${crypto.randomInt(255)}.${crypto.randomInt(1, 255)}`;

class Api {
  constructor(base, { ip } = {}) { this.base = base; this.ip = ip || randomIp(); this.cookie = ''; }

  async call(method, path, { body, rawBody, headers = {}, cookie } = {}) {
    const h = { 'x-real-ip': this.ip, ...headers };
    const c = cookie !== undefined ? cookie : this.cookie;
    if (c) h.cookie = c;
    let payload;
    if (rawBody !== undefined) payload = rawBody;
    else if (body !== undefined) { h['content-type'] = h['content-type'] || 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(this.base + path, { method, headers: h, body: payload, redirect: 'manual' });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, data, text, headers: r.headers, setCookie: r.headers.getSetCookie?.() || [] };
  }
  get(p, o) { return this.call('GET', p, o); }
  post(p, body = {}, o = {}) { return this.call('POST', p, { body, ...o }); }
  patch(p, body = {}, o = {}) { return this.call('PATCH', p, { body, ...o }); }
  del(p, o) { return this.call('DELETE', p, o); }

  async login(username, password) {
    const r = await this.post('/api/auth/login', { username, password });
    if (r.status === 200) this.cookie = r.setCookie[0].split(';')[0];
    return r;
  }
  /** The session token (for adding the cookie to a browser context). */
  get token() { return this.cookie.split('=')[1]; }
}

/** One raw HTTP/1.1 request; resolves with the status line, or an error description if the connection dies. */
function rawRequest(port, head, { timeoutMs = 4000, body = '' } = {}) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    let data = '';
    const done = (r) => { s.destroy(); resolve(r); };
    s.setTimeout(timeoutMs, () => done({ status: null, error: 'timeout', data }));
    s.once('connect', () => s.write(`${head}\r\n\r\n${body}`));
    s.on('data', (c) => {
      data += c;
      const m = /^HTTP\/1\.1 (\d+)/.exec(data);
      if (m && data.includes('\r\n\r\n')) done({ status: Number(m[1]), data });
    });
    s.once('error', (e) => done({ status: null, error: e.code, data }));
    s.once('close', () => done({ status: /^HTTP\/1\.1 (\d+)/.exec(data)?.[1] ? Number(/^HTTP\/1\.1 (\d+)/.exec(data)[1]) : null, error: data ? null : 'closed without a response', data }));
  });
}

/** Server-sent events reader. */
function openStream(base, cookie, { ip } = {}) {
  const ac = new AbortController();
  const events = [];
  const waiters = [];
  const state = { status: null, ended: false, endedAt: null };
  const ready = fetch(`${base}/api/stream`, { headers: { cookie: cookie || '', 'x-real-ip': ip || randomIp(), accept: 'text/event-stream' }, signal: ac.signal })
    .then(async (r) => {
      state.status = r.status;
      state.contentType = r.headers.get('content-type');
      if (!r.ok) { await r.text(); state.ended = true; return; }
      pump(r.body).catch(() => {}).finally(() => { state.ended = true; state.endedAt = Date.now(); });
    });
  async function pump(body) {
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block)?.[1];
        const d = /^data: (.*)$/m.exec(block)?.[1];
        if (!ev) continue;
        const item = { event: ev, data: d ? JSON.parse(d) : null, at: Date.now() };
        events.push(item);
        for (const w of [...waiters]) if (w.match(item)) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.timer); w.resolve(item); }
      }
    }
  }
  return {
    ready, events, state,
    /** Next event of that name (already received ones count only with `past`). */
    next(name, { timeoutMs = 20_000, past = false, where = () => true } = {}) {
      const match = (e) => e.event === name && where(e.data);
      if (past) { const hit = events.find(match); if (hit) return Promise.resolve(hit); }
      return new Promise((resolve, reject) => {
        const w = { match, resolve, timer: setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error(`no "${name}" event in ${timeoutMs} ms (got: ${[...new Set(events.map((e) => e.event))].join(', ') || 'nothing'})`)); }, timeoutMs) };
        waiters.push(w);
      });
    },
    close() { ac.abort(); },
  };
}

module.exports = { Api, rawRequest, openStream, randomIp };
