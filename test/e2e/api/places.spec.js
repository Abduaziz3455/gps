'use strict';
// Places over HTTP: who may do what, inputs, numbers from the simulator's real track.
const { test, expect } = require('../support/fixtures');
const { openStream } = require('../support/api');
const { FLEET, tashkentDay, addDays, uid } = require('../support/seed');

const today = () => tashkentDay();
const name = () => `Joy ${uid()}`;

/** A stop on the simulator's track, away from the yard and from any place already marked. */
async function freeStop(api, vehicleId = FLEET.parked) {
  const y = addDays(today(), -1);
  const places = (await api.get('/api/places')).data;
  const { stops } = (await api.get(`/api/vehicles/${vehicleId}/track?day=${y}`)).data;
  const taken = (s) => places.some((p) => Math.abs(p.lat - s.lat) < 0.003 && Math.abs(p.lng - s.lng) < 0.004);
  const s = stops.find((x) => !taken(x));
  if (!s) throw new Error('no free stop on the track');
  return { ...s, day: y };
}

test.describe('places', () => {
  test('nobody signed in: 401 everywhere', async ({ anon }) => {
    for (const [m, p] of [['get', '/api/places'], ['get', '/api/places/stats'], ['get', '/api/places/1/vehicles'], ['get', `/api/vehicles/${FLEET.fuel}/places`], ['get', `/api/vehicles/${FLEET.fuel}/summary`]]) {
      expect((await anon[m](p)).status, p).toBe(401);
    }
    expect((await anon.post('/api/places', { name: 'x' })).status).toBe(401);
    expect((await anon.patch('/api/places/1', { name: 'x' })).status).toBe(401);
    expect((await anon.del('/api/places/1')).status).toBe(401);
  });

  test('a dispatcher reads but cannot change', async ({ owner, dispatcher }) => {
    const s = await freeStop(owner);
    const made = (await owner.post('/api/places', { name: name(), lat: s.lat, lng: s.lng })).data;
    try {
      expect((await dispatcher.get('/api/places')).data.some((p) => p.id === made.id)).toBe(true);
      expect((await dispatcher.get('/api/places/stats')).status).toBe(200);
      expect((await dispatcher.post('/api/places', { name: name(), lat: 41, lng: 69 })).status).toBe(403);
      expect((await dispatcher.patch(`/api/places/${made.id}`, { radiusM: 300 })).status).toBe(403);
      expect((await dispatcher.del(`/api/places/${made.id}`)).status).toBe(403);
    } finally { await owner.del(`/api/places/${made.id}`); }
  });

  test('default size 150 m; a truck standing there is counted, with its name', async ({ owner, server }) => {
    const s = await freeStop(owner);
    const r = await owner.post('/api/places', { name: name(), lat: s.lat, lng: s.lng });
    expect(r.status).toBe(200);
    expect(r.data.radiusM).toBe(150);
    try {
      const q = `from=${s.day}&to=${s.day}`;
      await expect.poll(async () => (await owner.get(`/api/places/stats?${q}`)).data.find((p) => p.id === r.data.id)?.trips, { timeout: 20_000 }).toBeGreaterThan(0);
      const row = (await owner.get(`/api/places/stats?${q}`)).data.find((p) => p.id === r.data.id);
      expect(row.vehicles).toBeGreaterThan(0);
      expect(row.computing).toBe(false);
      expect((await owner.get(`/api/places/${r.data.id}/vehicles?${q}`)).data.some((v) => v.id === FLEET.parked)).toBe(true);
      expect((await owner.get(`/api/vehicles/${FLEET.parked}/places?${q}`)).data.find((p) => p.id === r.data.id).name).toBe(r.data.name);
      expect(server.get('SELECT COUNT(*) n FROM place_visits WHERE place_id = ?', r.data.id).n).toBeGreaterThan(0);
    } finally { await owner.del(`/api/places/${r.data.id}`); }
    expect(server.get('SELECT COUNT(*) n FROM place_visits WHERE place_id = ?', r.data.id).n).toBe(0);
  });

  test('a working truck: its stop at a site, marked with the default size, counts as its trip', async ({ owner, server }) => {
    const y = addDays(today(), -1);
    const me = (await owner.get('/api/me')).data;
    const { stops } = (await owner.get(`/api/vehicles/${FLEET.fuel}/track?day=${y}`)).data;
    const away = stops.filter((s) => Math.hypot((s.lat - me.yard.lat) * 111320, (s.lng - me.yard.lng) * 83000) > 500);
    expect(away.length, 'the simulated truck stops at sites').toBeGreaterThan(0);
    const s = away[0];
    const made = (await owner.post('/api/places', { name: name(), lat: s.lat, lng: s.lng })).data;
    try {
      const q = `from=${y}&to=${y}`;
      await expect.poll(async () => (await owner.get(`/api/vehicles/${FLEET.fuel}/places?${q}`)).data.find((p) => p.id === made.id)?.trips ?? 0, { timeout: 20_000 }).toBeGreaterThan(0);
      const v = server.all('SELECT * FROM place_visits WHERE place_id = ? AND vehicle_id = ?', made.id, FLEET.fuel);
      expect(v.some((x) => x.enter_t <= s.start + 60e3 && x.exit_t >= s.start), 'the visit is the stop that was marked').toBe(true);
    } finally { await owner.del(`/api/places/${made.id}`); }
  });

  test('bad input is refused; the error says why', async ({ owner }) => {
    const ok = { name: name(), lat: 41.9, lng: 69.9 };
    for (const [body, status] of [[{ ...ok, name: '' }, 400], [{ ...ok, radiusM: 10 }, 400], [{ ...ok, radiusM: 99999 }, 400], [{ ...ok, lat: 'x' }, 400], [{ name: 'Yarim' }, 400]]) {
      const r = await owner.post('/api/places', body);
      expect(r.status, JSON.stringify(body)).toBe(status);
      expect(r.data.error).toBeTruthy();
    }
    expect((await owner.patch('/api/places/999999', { name: 'x y' })).status).toBe(404);
    expect((await owner.del('/api/places/999999')).status).toBe(404);
    expect((await owner.get('/api/places/abc/vehicles')).status).toBe(400);
    expect((await owner.get('/api/places/999999/vehicles')).status).toBe(404);
    expect((await owner.get('/api/places/stats?from=2026-02-02&to=2026-01-01')).status).toBe(400);
  });

  test('the yard cannot be marked: it already has a name', async ({ owner }) => {
    const me = (await owner.get('/api/me')).data;
    const r = await owner.post('/api/places', { name: name(), lat: me.yard.lat, lng: me.yard.lng });
    expect(r.status).toBe(409);
    expect(r.data.error).toContain(me.yard.name);
  });

  test('every open page hears about a change', async ({ owner, server }) => {
    const st = openStream(server.url, owner.cookie);
    await st.ready;
    try {
      await st.next('hello', { past: true });
      const made = (await owner.post('/api/places', { name: name(), lat: 41.81, lng: 69.81 })).data;
      await st.next('places');
      await owner.del(`/api/places/${made.id}`);
      await st.next('places');
    } finally { st.close(); }
  });
});

test.describe('vehicle summary', () => {
  test('matches the Hisobot row for the same range', async ({ dispatcher }) => {
    const to = today(), from = addDays(to, -13);
    const s = (await dispatcher.get(`/api/vehicles/${FLEET.fuel}/summary?from=${from}&to=${to}`)).data;
    const row = (await dispatcher.get(`/api/reports/vehicles?from=${from}&to=${to}`)).data.find((v) => v.id === FLEET.fuel);
    expect(s.days).toBe(14);
    expect(s.fuelPer100).toBe(row.fuelPer100);
    expect(s.activeDays).toBe(row.activeDays);
    expect(s.utilization).toBe(Math.round((row.activeDays / row.days) * 100));
  });

  test('an unknown vehicle: 404; a bad id: 400', async ({ dispatcher }) => {
    expect((await dispatcher.get('/api/vehicles/999999/summary')).status).toBe(404);
    expect((await dispatcher.get('/api/vehicles/abc/summary')).status).toBe(400);
  });
});
