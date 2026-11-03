'use strict';
// Login, sessions, throttling, CSRF, passwords.
const crypto = require('node:crypto');
const { test, expect } = require('../support/fixtures');
const { Api } = require('../support/api');
const { ACCOUNTS } = require('../support/server');
const { uid } = require('../support/seed');

const OWN = ACCOUNTS.owner;

test.describe('login', () => {
  test('correct credentials: 200, the user, a hardened cookie', async ({ anon }) => {
    const r = await anon.login(OWN.username, OWN.password);
    expect(r.status).toBe(200);
    expect(r.data.user).toMatchObject({ username: 'owner', role: 'owner', disabled: false });
    expect(JSON.stringify(r.data)).not.toMatch(/pass|hash|salt/i);
    const c = r.setCookie[0];
    expect(c).toMatch(/^tbb_session=/);
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Path=/');
    expect(Number(/Max-Age=(\d+)/.exec(c)[1]), '30 days').toBeGreaterThan(29 * 86400);
  });

  test('the database stores only the hash of the session token', async ({ anon, server }) => {
    await anon.login(OWN.username, OWN.password);
    const raw = decodeURIComponent(anon.token);
    expect(server.get('SELECT COUNT(*) n FROM sessions WHERE token_hash = ?', raw).n).toBe(0);
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    expect(server.get('SELECT COUNT(*) n FROM sessions WHERE token_hash = ?', hash).n).toBe(1);
  });

  test('last login time is recorded', async ({ anon, server }) => {
    const t0 = Date.now();
    await anon.login(OWN.username, OWN.password);
    expect(server.get('SELECT last_login_at t FROM users WHERE username = ?', 'owner').t).toBeGreaterThanOrEqual(t0 - 1000);
  });

  test('wrong password and unknown user get the same answer', async ({ anon }) => {
    const a = await anon.login(OWN.username, 'wrong-password');
    const b = await anon.login('no-such-user', 'wrong-password');
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.data.error).toBe(b.data.error);
    expect(a.setCookie.length).toBe(0);
  });

  test('unknown users are not revealed by response time', async ({ server }) => {
    const time = async (u) => {
      const c = new Api(server.url);
      const t0 = performance.now();
      await c.login(u, 'wrong-password');
      return performance.now() - t0;
    };
    const med = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const known = [], unknown = [];
    for (let i = 0; i < 5; i++) { known.push(await time(OWN.username)); unknown.push(await time(`nobody${i}`)); }
    expect(med(known) / med(unknown), `known ${med(known).toFixed(1)} ms vs unknown ${med(unknown).toFixed(1)} ms`).toBeLessThan(3);
  });

  test('usernames ignore case, as the UNIQUE index does', async ({ anon }) => {
    expect((await anon.login('OWNER', OWN.password)).status).toBe(200);
  });

  test('passwords are case-sensitive and not trimmed', async ({ anon }) => {
    expect((await anon.login(OWN.username, OWN.password.toUpperCase())).status).toBe(401);
    expect((await anon.login(OWN.username, ` ${OWN.password}`)).status).toBe(401);
  });

  for (const [name, body] of [
    ['empty object', {}],
    ['no password', { username: 'owner' }],
    ['no username', { password: 'x' }],
    ['null fields', { username: null, password: null }],
    ['number fields', { username: 1, password: 2 }],
    ['object fields', { username: { a: 1 }, password: { b: 2 } }],
    ['array fields', { username: ['owner'], password: ['wrong-password'] }],
    ['SQL injection', { username: "owner' OR '1'='1' --", password: "' OR ''='" }],
    ['a very long username', { username: 'a'.repeat(100000), password: 'x' }],
  ]) {
    test(`malformed login is refused without a server error: ${name}`, async ({ anon }) => {
      const r = await anon.post('/api/auth/login', body);
      expect(r.status).toBe(401);
      expect(r.setCookie.length).toBe(0);
    });
  }

  for (const raw of ['null', '[]', '123', '"text"', 'true']) {
    test(`JSON body that isn't an object is a client error, not a crash: ${raw}`, async ({ anon }) => {
      const r = await anon.call('POST', '/api/auth/login', { rawBody: raw, headers: { 'content-type': 'application/json' } });
      expect(r.status).toBeLessThan(500);
    });
  }

  test('broken JSON: 400', async ({ anon }) => {
    expect((await anon.call('POST', '/api/auth/login', { rawBody: '{oops', headers: { 'content-type': 'application/json' } })).status).toBe(400);
  });

  test('a body over 1 MB is refused', async ({ anon }) => {
    let status;
    try { status = (await anon.post('/api/auth/login', { username: 'x'.repeat(2 * 1024 * 1024) })).status; } catch { status = 'connection closed'; }
    expect([413, 'connection closed']).toContain(status);
  });

  test('a disabled user cannot log in, and gets no hint why', async ({ owner, server }) => {
    const u = `dis${uid()}`;
    const { data } = await owner.post('/api/users', { username: u, role: 'dispatcher', password: 'password-1' });
    await owner.patch(`/api/users/${data.id}`, { disabled: true });
    const r = await new Api(server.url).login(u, 'password-1');
    expect(r.status).toBe(401);
    expect(r.data.error).toBe((await new Api(server.url).login(u, 'wrong-wrong')).data.error);
  });
});

test.describe('throttling', () => {
  test('8 failures lock that address, even for the right password', async ({ server }) => {
    const c = new Api(server.url);
    for (let i = 0; i < 8; i++) expect((await c.login(OWN.username, 'wrong-password')).status).toBe(401);
    const locked = await c.login(OWN.username, OWN.password);
    expect(locked.status).toBe(429);
    expect(locked.setCookie.length).toBe(0);
  });

  test('another address is not affected', async ({ server }) => {
    const c = new Api(server.url);
    for (let i = 0; i < 8; i++) await c.login(OWN.username, 'wrong-password');
    expect((await new Api(server.url).login(OWN.username, OWN.password)).status).toBe(200);
  });

  test('a successful login clears the count', async ({ server }) => {
    const c = new Api(server.url);
    for (let i = 0; i < 7; i++) await c.login(OWN.username, 'wrong-password');
    expect((await c.login(OWN.username, OWN.password)).status).toBe(200);
    for (let i = 0; i < 7; i++) expect((await c.login(OWN.username, 'wrong-password')).status).toBe(401);
    expect((await c.login(OWN.username, OWN.password)).status).toBe(200);
  });

  test('guessing the current password in Settings is throttled too', async ({ server }) => {
    const c = new Api(server.url);
    await c.login(OWN.username, OWN.password);
    let last;
    for (let i = 0; i < 12; i++) last = await c.post('/api/me/password', { current: `guess-${i}`, password: 'new-password-1' });
    expect(last.status, 'a stolen session must not allow unlimited guesses at the password').toBe(429);
  });
});

test.describe('sessions', () => {
  test('logout ends the session and clears the cookie', async ({ anon }) => {
    await anon.login(OWN.username, OWN.password);
    const r = await anon.post('/api/auth/logout');
    expect(r.status).toBe(200);
    expect(r.setCookie[0]).toContain('Max-Age=0');
    expect((await anon.get('/api/me')).status).toBe(401);
  });

  test('logout on one device leaves the others signed in', async ({ server }) => {
    const a = new Api(server.url), b = new Api(server.url);
    await a.login(OWN.username, OWN.password);
    await b.login(OWN.username, OWN.password);
    await a.post('/api/auth/logout');
    expect((await b.get('/api/me')).status).toBe(200);
  });

  test('logging out without a session is harmless', async ({ anon }) => {
    expect((await anon.post('/api/auth/logout')).status).toBe(200);
  });

  test('an expired session is refused', async ({ anon, server }) => {
    await anon.login(OWN.username, OWN.password);
    const hash = crypto.createHash('sha256').update(decodeURIComponent(anon.token)).digest('hex');
    server.run('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', Date.now() - 1000, hash);
    expect((await anon.get('/api/me')).status).toBe(401);
  });

  test('a role change applies at once, without logging in again', async ({ owner, server }) => {
    const u = `role${uid()}`;
    const { data } = await owner.post('/api/users', { username: u, role: 'dispatcher', password: 'password-1' });
    const c = new Api(server.url);
    await c.login(u, 'password-1');
    expect((await c.get('/api/users')).status).toBe(403);
    await owner.patch(`/api/users/${data.id}`, { role: 'owner' });
    expect((await c.get('/api/users')).status).toBe(200);
    await owner.patch(`/api/users/${data.id}`, { role: 'dispatcher' });
    expect((await c.get('/api/users')).status).toBe(403);
  });

  test('/api/me says what the app needs and holds no secret', async ({ owner }) => {
    const { data } = await owner.get('/api/me');
    expect(data.user.username).toBe('owner');
    expect(data.yard).toMatchObject({ lat: expect.any(Number), lng: expect.any(Number), radiusM: expect.any(Number) });
    expect(typeof data.pushKey).toBe('string');
    expect(data).toMatchObject({ cameras: true, gps: true, mock: true });
    expect(JSON.stringify(data)).not.toMatch(/password|private|pass_hash|secret/i);
  });
});

test.describe('CSRF', () => {
  const body = { username: `csrf${uid()}`, role: 'owner', password: 'password-1' };

  test('a foreign Origin is refused, with a valid cookie', async ({ owner, server }) => {
    const before = server.get('SELECT COUNT(*) n FROM users').n;
    const r = await owner.post('/api/users', body, { headers: { origin: 'https://evil.example' } });
    expect(r.status).toBe(403);
    expect(server.get('SELECT COUNT(*) n FROM users').n).toBe(before);
  });

  test('look-alike origins are refused', async ({ owner, server }) => {
    for (const o of [`http://127.0.0.1:${server.port}.evil.example`, `https://evil.example/${server.url}`, 'http://127.0.0.1:1']) {
      expect((await owner.post('/api/alerts/ack-all', {}, { headers: { origin: o } })).status, o).toBe(403);
    }
  });

  test('"Origin: null" (sandboxed iframes) is refused as 403, not an error', async ({ owner }) => {
    expect((await owner.post('/api/alerts/ack-all', {}, { headers: { origin: 'null' } })).status).toBe(403);
  });

  test('an unparsable Origin is refused as 403, not an error', async ({ owner }) => {
    expect((await owner.post('/api/alerts/ack-all', {}, { headers: { origin: 'not a url' } })).status).toBe(403);
  });

  test('our own origin works', async ({ owner, server }) => {
    expect((await owner.post('/api/push/status', {}, { headers: { origin: server.url } })).status).toBe(200);
  });

  test('a form post (non-JSON) is refused, even with a cookie', async ({ owner }) => {
    for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const r = await owner.call('POST', '/api/alerts/ack-all', { rawBody: 'a=1', headers: { 'content-type': ct } });
      expect(r.status, ct).toBe(415);
    }
  });

  test('GET never changes anything: state-changing routes refuse it', async ({ owner }) => {
    for (const p of ['/api/alerts/ack-all', '/api/auth/logout', '/api/analytics/recompute']) expect((await owner.get(p)).status, p).toBe(404);
    expect((await owner.get('/api/me')).status, 'still signed in').toBe(200);
  });
});

test.describe('changing my password', () => {
  async function fresh(owner, server) {
    const u = `pw${uid()}`;
    await owner.post('/api/users', { username: u, role: 'dispatcher', password: 'old-password-1' });
    const c = new Api(server.url);
    await c.login(u, 'old-password-1');
    return { c, u };
  }

  test('wrong current password: 400, nothing changes', async ({ owner, server }) => {
    const { c, u } = await fresh(owner, server);
    expect((await c.post('/api/me/password', { current: 'nope-nope', password: 'new-password-1' })).status).toBe(400);
    expect((await new Api(server.url).login(u, 'old-password-1')).status).toBe(200);
  });

  test('too short: 400', async ({ owner, server }) => {
    const { c } = await fresh(owner, server);
    expect((await c.post('/api/me/password', { current: 'old-password-1', password: 'short' })).status).toBe(400);
  });

  for (const [name, p] of [['missing', undefined], ['number', 12345678], ['null', null]]) {
    test(`new password ${name}: refused, and the old one still works`, async ({ owner, server }) => {
      const { c, u } = await fresh(owner, server);
      const r = await c.post('/api/me/password', { current: 'old-password-1', password: p });
      expect(r.status).toBe(400);
      expect((await new Api(server.url).login(u, 'old-password-1')).status).toBe(200);
    });
  }

  test('success: every device is signed out, the old password stops working', async ({ owner, server }) => {
    const { c, u } = await fresh(owner, server);
    const other = new Api(server.url);
    await other.login(u, 'old-password-1');
    const r = await c.post('/api/me/password', { current: 'old-password-1', password: 'new-password-1' });
    expect(r.data).toMatchObject({ ok: true, relogin: true });
    expect((await c.get('/api/me')).status).toBe(401);
    expect((await other.get('/api/me')).status).toBe(401);
    expect((await new Api(server.url).login(u, 'old-password-1')).status).toBe(401);
    expect((await new Api(server.url).login(u, 'new-password-1')).status).toBe(200);
  });

  test('passwords are stored scrypt-hashed', async ({ owner, server }) => {
    const { u } = await fresh(owner, server);
    const row = server.get('SELECT pass_hash FROM users WHERE username = ?', u);
    expect(row.pass_hash).toMatch(/^scrypt\$/);
    expect(row.pass_hash).not.toContain('old-password-1');
  });
});
