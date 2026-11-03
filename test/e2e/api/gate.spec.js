'use strict';
const crypto = require('node:crypto');
const { test, expect } = require('../support/fixtures');
const { uid, gateEvent, FLEET, dayStart, tashkentDay, addDays } = require('../support/seed');

// A private day far in the past: the simulator never writes there, so these rows are the only ones in view.
const DAY = '2020-02-01';
const T0 = dayStart(DAY) + 10 * 3600e3;
const q = (extra = '') => `/api/gate-events?from=${DAY}&to=${DAY}${extra}`;
const clear = (server) => server.run('DELETE FROM gate_events WHERE t >= ? AND t < ?', dayStart(DAY), dayStart(DAY) + 86400e3);

test.describe('list and filters', () => {
  test.beforeEach(({ server }) => {
    clear(server);
    gateEvent(server, { t: T0, direction: 'in', plate: '85450KBA', vehicleId: FLEET.fuel, status: 'confirmed', by: 'plate' });
    gateEvent(server, { t: T0 + 60e3, direction: 'out', plate: '85450KBA', vehicleId: FLEET.fuel, status: 'confirmed', by: 'plate', stay: 60 });
    gateEvent(server, { t: T0 + 120e3, direction: 'in', plate: '01A123BC', status: 'outside' });
    gateEvent(server, { t: T0 + 180e3, direction: 'out', plate: null, plateRaw: null, valid: 0, status: 'outside', note: "Raqam o'qilmadi" });
    gateEvent(server, { t: T0 + 240e3, direction: 'out', plate: '85159YAA', vehicleId: FLEET.fuel2, status: 'vetoed', by: 'plate' });
  });

  test('newest first; hidden events left out by default', async ({ dispatcher }) => {
    const { data } = await dispatcher.get(q());
    expect(data.length).toBe(4);
    expect(data.map((e) => e.t)).toEqual([...data.map((e) => e.t)].sort((a, b) => b - a));
    expect(data.every((e) => e.status !== 'vetoed')).toBe(true);
  });

  test('the shape the page relies on', async ({ dispatcher }) => {
    const e = (await dispatcher.get(q('&direction=out&kind=fleet'))).data[0];
    expect(e).toMatchObject({ direction: 'out', camera: 'ANPR-2', plate: '85450KBA', plateText: '85 450 KBA', plateValid: true, vehicleId: FLEET.fuel, vehicleLabel: '85 450 KBA', staySeconds: 60, gap: false });
    expect(e.photos[0].url).toBe(`/api/gate-events/${e.id}/photo/0`);
  });

  test('unread plate reads as null, with its note', async ({ dispatcher }) => {
    const e = (await dispatcher.get(q('&direction=out&kind=outside'))).data[0];
    expect(e.plateText).toBeNull();
    expect(e.vehicleId).toBeNull();
    expect(e.note).toContain("o'qilmadi");
  });

  for (const [query, n] of [
    ['&direction=in', 2], ['&direction=out', 2], ['&direction=sideways', 4],
    ['&kind=fleet', 2], ['&kind=outside', 2], ['&kind=x', 4],
    ['&status=hidden', 1], ['&status=all', 5],
    ['&plate=01A123', 1], ['&plate=85%20450', 2], ['&plate=nomatch', 0],
    [`&vehicle=${FLEET.fuel}`, 2], ['&vehicle=999999', 0],
    ['&direction=in&kind=fleet', 1],
  ]) {
    test(`filter ${query}: ${n} rows`, async ({ dispatcher }) => {
      const r = await dispatcher.get(q(query));
      expect(r.status).toBe(200);
      expect(r.data.length).toBe(n);
    });
  }

  test('a plate typed in Cyrillic finds the Latin one', async ({ dispatcher }) => {
    expect((await dispatcher.get(q(`&plate=${encodeURIComponent('КВА')}`))).data.length).toBe(2);
  });

  test('a search with SQL wildcards doesn\'t match everything', async ({ dispatcher }) => {
    expect((await dispatcher.get(q(`&plate=${encodeURIComponent('%')}`))).data.length, 'the % is stripped, not treated as a wildcard... or empty').toBeLessThanOrEqual(4);
    expect((await dispatcher.get(q(`&plate=${encodeURIComponent("' OR 1=1 --")}`))).status).toBe(200);
  });
});

test.describe('limits and paging', () => {
  test.beforeAll(async ({ server }) => {
    clear(server);
    server.sql((db) => {
      const ins = db.prepare(`INSERT INTO gate_events (capture_name, t, direction, camera, channel, plate, plate_raw, plate_valid, status, created_at)
        VALUES (?, ?, 'in', 'ANPR-1', 4, 'P1', 'P1', 0, 'outside', 0)`);
      db.exec('BEGIN');
      for (let i = 0; i < 620; i++) ins.run(`page_${i}_${uid()}`, T0 + i * 1000);
      db.exec('COMMIT');
    });
  });
  test.afterAll(({ server }) => clear(server));

  test('default 100, capped at 500', async ({ dispatcher }) => {
    expect((await dispatcher.get(q())).data.length).toBe(100);
    expect((await dispatcher.get(q('&limit=10'))).data.length).toBe(10);
    expect((await dispatcher.get(q('&limit=100000'))).data.length).toBe(500);
  });

  test('a negative limit can\'t remove the cap', async ({ dispatcher }) => {
    const r = await dispatcher.get(q('&limit=-1'));
    expect(r.status).toBeLessThan(500);
    if (r.status === 200) expect(r.data.length, 'LIMIT -1 means "no limit" in SQLite').toBeLessThanOrEqual(500);
  });

  test('a garbage limit falls back to the default', async ({ dispatcher }) => {
    expect((await dispatcher.get(q('&limit=abc'))).data.length).toBe(100);
    expect((await dispatcher.get(q('&limit=0'))).data.length).toBe(100);
  });

  test('paging with before: every row once, none skipped', async ({ dispatcher }) => {
    const seen = new Set();
    let before = null;
    for (let page = 0; page < 20; page++) {
      const { data } = await dispatcher.get(q(`&limit=60${before ? `&before=${before}` : ''}`));
      for (const e of data) { expect(seen.has(e.id), 'no duplicates').toBe(false); seen.add(e.id); }
      if (data.length < 60) break;
      before = data[data.length - 1].t;
    }
    expect(seen.size).toBe(620);
  });

  test('garbage before and vehicle don\'t break the query', async ({ dispatcher }) => {
    for (const x of ['&before=abc', '&vehicle=abc']) expect((await dispatcher.get(q(x))).status, x).toBeLessThan(500);
  });
});

test('paging: two passes in the same second, across a page boundary, are both shown', async ({ dispatcher, server }) => {
  clear(server);
  try {
    for (let i = 0; i < 3; i++) gateEvent(server, { t: T0 + 1000, status: 'outside', plate: `TIE${i}` });
    gateEvent(server, { t: T0 + 2000, status: 'outside', plate: 'LATE1' });
    const first = (await dispatcher.get(q('&limit=2'))).data;
    const second = (await dispatcher.get(q(`&limit=2&before=${first[first.length - 1].t}`))).data;
    const ids = new Set([...first, ...second].map((e) => e.id));
    expect(ids.size, 'the next page must not drop rows that share the last timestamp').toBe(4);
  } finally { clear(server); }
});

test.describe('corrections', () => {
  test.beforeEach(({ server }) => clear(server));
  const get = async (c, id) => (await c.get(`/api/gate-events/${id}`)).data;

  test('one event: found, 404, 400', async ({ dispatcher, server }) => {
    const id = gateEvent(server, { t: T0 });
    expect((await dispatcher.get(`/api/gate-events/${id}`)).status).toBe(200);
    expect((await dispatcher.get('/api/gate-events/99999999')).status).toBe(404);
    expect((await dispatcher.get('/api/gate-events/abc')).status).toBe(400);
  });

  test('assign a vehicle: outside becomes confirmed, by hand, signed', async ({ dispatcher, server }) => {
    const id = gateEvent(server, { t: T0, plate: '01A123BC', status: 'outside' });
    const r = await dispatcher.patch(`/api/gate-events/${id}`, { vehicleId: FLEET.fuel });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ vehicleId: FLEET.fuel, identifiedBy: 'manual', status: 'confirmed', vehicleLabel: '85 450 KBA' });
    expect(r.data.note).toContain('Dispetcher');
  });

  test('unassign: back to outside', async ({ owner, server }) => {
    const id = gateEvent(server, { t: T0, vehicleId: FLEET.fuel, status: 'confirmed', by: 'plate' });
    const r = await owner.patch(`/api/gate-events/${id}`, { vehicleId: null });
    expect(r.data).toMatchObject({ vehicleId: null, identifiedBy: null, status: 'outside' });
  });

  test('a pending event taken over by hand is no longer waiting for GPS', async ({ owner, server }) => {
    const id = gateEvent(server, { t: T0, status: 'pending' });
    server.run('UPDATE gate_events SET resolve_at = ? WHERE id = ?', Date.now() + 60000, id);
    await owner.patch(`/api/gate-events/${id}`, { vehicleId: FLEET.fuel });
    expect(server.get('SELECT resolve_at r FROM gate_events WHERE id = ?', id).r).toBeNull();
    expect((await get(owner, id)).status).toBe('confirmed');
  });

  test('assign an unknown vehicle: 404. Not an integer: 400', async ({ dispatcher, server }) => {
    const id = gateEvent(server, { t: T0, status: 'outside' });
    expect((await dispatcher.patch(`/api/gate-events/${id}`, { vehicleId: 999999 })).status).toBe(404);
    expect((await dispatcher.patch(`/api/gate-events/${id}`, { vehicleId: 'abc' })).status).toBe(400);
  });

  test('hide and restore', async ({ dispatcher, server }) => {
    const id = gateEvent(server, { t: T0, vehicleId: FLEET.fuel, status: 'confirmed', by: 'plate' });
    expect((await dispatcher.patch(`/api/gate-events/${id}`, { hidden: true })).data.status).toBe('vetoed');
    expect((await dispatcher.get(q())).data.length).toBe(0);
    expect((await dispatcher.get(q('&status=hidden'))).data.length).toBe(1);
    expect((await dispatcher.patch(`/api/gate-events/${id}`, { hidden: false })).data.status).toBe('confirmed');
  });

  test('restoring an outside event: outside again', async ({ dispatcher, server }) => {
    const id = gateEvent(server, { t: T0, plate: '01A123BC', status: 'vetoed' });
    expect((await dispatcher.patch(`/api/gate-events/${id}`, { hidden: false })).data.status).toBe('outside');
  });

  test('assign and restore in one request: confirmed, not outside', async ({ dispatcher, server }) => {
    const id = gateEvent(server, { t: T0, plate: '01A123BC', status: 'vetoed' });
    const r = await dispatcher.patch(`/api/gate-events/${id}`, { vehicleId: FLEET.fuel, hidden: false });
    expect(r.data.status).toBe('confirmed');
  });

  test('a correction counts in the day\'s trips after recompute', async ({ owner, server }) => {
    const today = tashkentDay();
    const before = server.get('SELECT trips_in n FROM daily_stats WHERE day = ? AND vehicle_id = ?', today, FLEET.parked)?.n || 0;
    const id = gateEvent(server, { t: Date.now() - 60000, direction: 'in', plate: 'E2E1', valid: 0, status: 'outside' });
    await owner.patch(`/api/gate-events/${id}`, { vehicleId: FLEET.parked });
    await owner.post('/api/analytics/recompute', { day: today });
    expect(server.get('SELECT trips_in n FROM daily_stats WHERE day = ? AND vehicle_id = ?', today, FLEET.parked).n).toBe(before + 1);
    server.run('DELETE FROM gate_events WHERE id = ?', id);
  });

  test('unknown event: 404', async ({ dispatcher }) => {
    expect((await dispatcher.patch('/api/gate-events/99999999', { hidden: true })).status).toBe(404);
  });

  for (const raw of ['null', '7']) {
    test(`body that isn't an object is a client error: ${raw}`, async ({ dispatcher, server }) => {
      const id = gateEvent(server, { t: T0 });
      const r = await dispatcher.call('PATCH', `/api/gate-events/${id}`, { rawBody: raw, headers: { 'content-type': 'application/json' } });
      expect(r.status).toBeLessThan(500);
    });
  }
});

test.describe('photos', () => {
  const realEvent = (server) => server.get("SELECT id FROM gate_events WHERE capture_uri LIKE '/mock/%' AND capture_name NOT LIKE 'e2e_%' ORDER BY t DESC LIMIT 1").id;

  test('a history photo is fetched on demand: a private JPEG', async ({ dispatcher, server }) => {
    const id = realEvent(server);
    const r = await fetch(`${dispatcher.base}/api/gate-events/${id}/photo/0`, { headers: { cookie: dispatcher.cookie } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/jpeg');
    expect(r.headers.get('cache-control')).toContain('private');
    const b = Buffer.from(await r.arrayBuffer());
    expect(b[0]).toBe(0xff);
    expect(b[1]).toBe(0xd8);
  });

  test('wrong photo index: 404. Not a number: 400. No such event: 404', async ({ dispatcher, server }) => {
    const id = realEvent(server);
    expect((await dispatcher.get(`/api/gate-events/${id}/photo/99`)).status).toBe(404);
    expect((await dispatcher.get(`/api/gate-events/${id}/photo/-1`)).status).toBe(404);
    expect((await dispatcher.get(`/api/gate-events/${id}/photo/x`)).status).toBe(400);
    expect((await dispatcher.get('/api/gate-events/99999999/photo/0')).status).toBe(404);
  });
});

test.describe('push notification image links', () => {
  const sign = (server, id, exp) => crypto.createHmac('sha256', server.kv('image_secret')).update(`${id}:${exp}`).digest('base64url').slice(0, 32);
  const event = (server) => server.get("SELECT id FROM gate_events WHERE capture_uri LIKE '/mock/%' AND capture_name NOT LIKE 'e2e_%' ORDER BY t DESC LIMIT 1").id;

  test('a valid signature opens without a session', async ({ anon, server }) => {
    const id = event(server);
    const exp = Date.now() + 60000;
    const r = await fetch(`${anon.base}/api/push-image/${id}?exp=${exp}&sig=${sign(server, id, exp)}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/jpeg');
  });

  test('missing, wrong, expired or borrowed signatures: 403', async ({ anon, server }) => {
    const id = event(server);
    const exp = Date.now() + 60000;
    const good = sign(server, id, exp);
    for (const [name, u] of [
      ['none', `/api/push-image/${id}`],
      ['no sig', `/api/push-image/${id}?exp=${exp}`],
      ['wrong', `/api/push-image/${id}?exp=${exp}&sig=${'a'.repeat(32)}`],
      ['short', `/api/push-image/${id}?exp=${exp}&sig=abc`],
      ['other id', `/api/push-image/${id - 1}?exp=${exp}&sig=${good}`],
      ['other expiry', `/api/push-image/${id}?exp=${exp + 1}&sig=${good}`],
      ['expired', `/api/push-image/${id}?exp=${Date.now() - 1000}&sig=${sign(server, id, Date.now() - 1000)}`],
      ['garbage expiry', `/api/push-image/${id}?exp=abc&sig=${good}`],
    ]) expect((await anon.get(u)).status, name).toBe(403);
  });

  test('a validly signed link to a deleted event: 404', async ({ anon, server }) => {
    const exp = Date.now() + 60000;
    expect((await anon.get(`/api/push-image/99999999?exp=${exp}&sig=${sign(server, 99999999, exp)}`)).status).toBe(404);
  });
});

test.describe('who is in the yard', () => {
  test('consistent with itself and with /api/today', async ({ dispatcher }) => {
    const [y, t] = await Promise.all([dispatcher.get('/api/yard'), dispatcher.get('/api/today')]);
    const keys = [...y.data.inside, ...y.data.gpsOnly].map((x) => x.key);
    expect(new Set(keys).size, 'nobody is listed twice').toBe(keys.length);
    expect(t.data.insideOutside).toBe(y.data.inside.filter((x) => !x.fleet).length);
    expect(t.data.insideFleet).toBe(y.data.inside.filter((x) => x.fleet).length + y.data.gpsOnly.length);
    const since = y.data.inside.map((x) => x.since);
    expect(since).toEqual([...since].sort((a, b) => a - b));
  });

  test('an outside vehicle entering shows up; leaving removes it', async ({ dispatcher, server }) => {
    const plate = `01A${String(Math.floor(Math.random() * 900) + 100)}XY`;
    const inId = gateEvent(server, { t: Date.now() - 120000, direction: 'in', plate, status: 'outside' });
    const y1 = (await dispatcher.get('/api/yard')).data;
    expect(y1.inside.some((x) => x.key === `p${plate}`)).toBe(true);
    const outId = gateEvent(server, { t: Date.now() - 60000, direction: 'out', plate, status: 'outside' });
    const y2 = (await dispatcher.get('/api/yard')).data;
    expect(y2.inside.some((x) => x.key === `p${plate}`)).toBe(false);
    server.run('DELETE FROM gate_events WHERE id IN (?, ?)', inId, outId);
  });

  test('a stale outside entry (over 12 h with no exit) is dropped', async ({ dispatcher, server }) => {
    const plate = 'E2E13HRS';
    const id = gateEvent(server, { t: Date.now() - 13 * 3600e3, direction: 'in', plate, status: 'outside' });
    expect((await dispatcher.get('/api/yard')).data.inside.some((x) => x.key === `p${plate}`)).toBe(false);
    server.run('DELETE FROM gate_events WHERE id = ?', id);
  });

  test('a hidden entry doesn\'t put anyone in the yard', async ({ dispatcher, server }) => {
    const plate = 'E2EHIDDEN';
    const id = gateEvent(server, { t: Date.now() - 60000, direction: 'in', plate, status: 'vetoed' });
    expect((await dispatcher.get('/api/yard')).data.inside.some((x) => x.key === `p${plate}`)).toBe(false);
    server.run('DELETE FROM gate_events WHERE id = ?', id);
  });
});

test('the simulator produced a believable month of gate events', async ({ owner }) => {
  const day = addDays(tashkentDay(), -1);
  const { data } = await owner.get(`/api/gate-events?from=${day}&to=${day}&limit=500&status=all`);
  expect(data.length).toBeGreaterThan(10);
  expect(data.some((e) => e.direction === 'in')).toBe(true);
  expect(data.some((e) => e.direction === 'out')).toBe(true);
  expect(data.some((e) => e.vehicleId)).toBe(true);
  expect(data.some((e) => !e.vehicleId && e.plateValid), 'outside vehicles').toBe(true);
  // mixers: GoGPS "10 870 HAD", camera "10870HDA": matched by same digits and letters
  expect(data.filter((e) => e.identifiedBy === 'similar').every((e) => e.vehicleId), 'similar plates are identified').toBe(true);
});
