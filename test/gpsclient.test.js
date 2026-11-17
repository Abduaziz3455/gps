'use strict';
// GoGPS client: a refused login keeps GoGPS's reason and isn't tried again at once (16 Nov 2026: account blocked).
const test = require('node:test');
const assert = require('node:assert');
const { GpsClient } = require('../src/gps/client');

const json = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

function rig(login) {
  const calls = [];
  const fetchImpl = async (url, o) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path === '/api/v3/auth/login') return login(JSON.parse(o.body));
    return json(200, [{ vehicleId: 1 }]);
  };
  const c = new GpsClient({ baseUrl: 'https://gps.example', login: 'u', password: 'p', minGapMs: 0, fetchImpl, log: {} });
  return { c, calls, logins: () => calls.filter((p) => p === '/api/v3/auth/login').length };
}

test('a blocked account: the reason is kept, and the login is not asked again for a minute', async () => {
  let answer = { Error: 'Учётная запись заблокирована', ErrorStatus: 1 };
  const r = rig(() => json(200, answer));
  await assert.rejects(r.c.lastData([1]), { message: 'GPS login failed: Учётная запись заблокирована' });
  assert.equal(r.logins(), 1, 'refused: not retried within the same request');
  await assert.rejects(r.c.lastData([1]), /заблокирована/);
  assert.equal(r.logins(), 1, 'the next poll does not ask GoGPS again yet');
  assert.equal(r.c.refused.delayMs, 60e3);

  r.c.refused.until = 0; // a minute later, still blocked: the wait doubles
  await assert.rejects(r.c.lastData([1]));
  assert.equal(r.logins(), 2);
  assert.equal(r.c.refused.delayMs, 120e3);

  answer = { AuthId: 'token' }; // unblocked
  r.c.refused.until = 0;
  assert.deepEqual(await r.c.lastData([1]), [{ vehicleId: 1 }]);
  assert.equal(r.c.refused, null);
});

test('no reason given: still a login failure the health check recognises', async () => {
  const r = rig(() => json(200, {}));
  await assert.rejects(r.c.lastData([1]), { message: 'GPS login failed: no AuthId' });
  const r2 = rig(() => json(401, {}));
  await assert.rejects(r2.c.lastData([1]), { message: 'GPS login failed (HTTP 401)' });
  assert.equal(r2.logins(), 1);
});

test('GoGPS down (HTTP 502 at login) is retried as before, not held back', async () => {
  let n = 0;
  const r = rig(() => (++n < 2 ? json(502, {}) : json(200, { AuthId: 'token' })));
  assert.deepEqual(await r.c.request('/api/v3/vehicles/getlastdata', {}, { retries: 3 }).catch((e) => e.message), [{ vehicleId: 1 }]);
  assert.equal(r.c.refused, null);
});
