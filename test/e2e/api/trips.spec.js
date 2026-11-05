'use strict';
// Trip records over HTTP: who may read them, inputs, and one real pass through server.js with the simulator running.
const { test, expect } = require('../support/fixtures');
const { openStream } = require('../support/api');
const { tripTruck, tashkentDay, addDays, FLEET, uid } = require('../support/seed');

/** A correction through the API, which makes the server work trips out again; then the truck's trip. */
async function tripOf(owner, truck) {
  await owner.patch(`/api/gate-events/${truck.out}`, { hidden: false });
  let row = null;
  await expect.poll(async () => {
    row = (await owner.get(`/api/trips?from=${truck.day}&to=${truck.day}&vehicle=${truck.id}`)).data.trips[0];
    return row?.inEventId ?? null;
  }, { timeout: 30_000 }).toBe(truck.back);
  return row;
}

test.describe('trips', () => {
  test('nobody signed in: 401', async ({ anon }) => {
    expect((await anon.get('/api/trips')).status).toBe(401);
  });

  test('inputs: a bad range and a bad filter are refused, an empty range is empty', async ({ owner }) => {
    expect((await owner.get('/api/trips?from=2026-11-05&to=2026-11-01')).status).toBe(400);
    expect((await owner.get('/api/trips?from=2020-01-01&to=2026-11-05')).status).toBe(400);
    expect((await owner.get('/api/trips?vehicle=abc')).status).toBe(400);
    expect((await owner.get('/api/trips?place=abc')).status).toBe(400);
    const r = await owner.get('/api/trips?from=2020-01-01&to=2020-01-02');
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ trips: [], nearCount: 0, destinations: [], totals: { trips: 0, km: 0, fuelUsed: null, avgDurationS: null } });
  });

  test('a finished trip: times, km, where it went, the gate events; a dispatcher reads it too', async ({ owner, dispatcher, server }) => {
    const truck = tripTruck(server);
    try {
      const t = await tripOf(owner, truck);
      expect(t).toMatchObject({ vehicleId: truck.id, state: 'done', startT: truck.t, endT: truck.t + 3600e3, durationS: 3600, km: 24.5, kmSrc: 'gps', near: false, outEventId: truck.out, inEventId: truck.back });
      expect(t.destination).toMatchObject({ address: '5 Чинабад улица, Ташкент, Узбекистан', seconds: 2400, name: null });
      expect(t.stops).toHaveLength(1);
      const seen = (await dispatcher.get(`/api/trips?from=${truck.day}&to=${truck.day}&vehicle=${truck.id}`));
      expect(seen.status).toBe(200);
      expect(seen.data.totals).toMatchObject({ trips: 1, vehicles: 1, complete: 1, km: 24.5, avgDurationS: 3600 });
      expect((await owner.get(`/api/gate-events/${t.outEventId}`)).status).toBe(200);
    } finally { truck.done(); }
  });

  test('naming the place where it stopped names the trip, without working anything out again', async ({ owner, server }) => {
    const truck = tripTruck(server);
    let place;
    try {
      await tripOf(owner, truck);
      place = (await owner.post('/api/places', { name: `Sergeli ${uid()}`, lat: truck.lat, lng: truck.lng })).data;
      const q = `from=${truck.day}&to=${truck.day}&vehicle=${truck.id}`;
      const r = (await owner.get(`/api/trips?${q}`)).data;
      expect(r.trips[0].destination).toMatchObject({ name: place.name, placeId: place.id });
      expect(r.destinations[0]).toMatchObject({ name: place.name, placeId: place.id, trips: 1, vehicles: 1 });
      expect((await owner.get(`/api/trips?${q}&place=${place.id}`)).data.trips).toHaveLength(1);
      expect((await owner.get(`/api/trips?${q}&place=${place.id + 1000}`)).data.trips).toHaveLength(0);
    } finally {
      if (place) await owner.del(`/api/places/${place.id}`);
      truck.done();
    }
  });

  test('a truck that stayed by the plant is left out unless asked for', async ({ owner, server }) => {
    const y = await owner.get('/api/me');
    const truck = tripTruck(server, { km: 0.4, lat: y.data.yard.lat, lng: y.data.yard.lng, address: 'Yard street' });
    try {
      await owner.patch(`/api/gate-events/${truck.out}`, { hidden: false });
      const q = `from=${truck.day}&to=${truck.day}&vehicle=${truck.id}`;
      await expect.poll(async () => (await owner.get(`/api/trips?${q}`)).data.nearCount, { timeout: 30_000 }).toBe(1);
      expect((await owner.get(`/api/trips?${q}`)).data.trips).toHaveLength(0);
      const all = (await owner.get(`/api/trips?${q}&near=1`)).data;
      expect(all.trips[0]).toMatchObject({ near: true, destination: null });
    } finally { truck.done(); }
  });

  test('hiding a pass as wrong changes the trip; putting it back restores it', async ({ owner, server }) => {
    const truck = tripTruck(server);
    try {
      await tripOf(owner, truck);
      await owner.patch(`/api/gate-events/${truck.back}`, { hidden: true });
      const q = `from=${truck.day}&to=${truck.day}&vehicle=${truck.id}`;
      await expect.poll(async () => (await owner.get(`/api/trips?${q}`)).data.trips[0]?.endT ?? null, { timeout: 30_000 }).toBe(null);
      await owner.patch(`/api/gate-events/${truck.back}`, { hidden: false });
      await expect.poll(async () => (await owner.get(`/api/trips?${q}`)).data.trips[0]?.endT ?? null, { timeout: 30_000 }).toBe(truck.t + 3600e3);
    } finally { truck.done(); }
  });

  test('open pages hear about a change', async ({ owner, server }) => {
    const stream = openStream(server.url, `tbb_session=${owner.token}`);
    const truck = tripTruck(server);
    try {
      await stream.ready;
      await owner.patch(`/api/gate-events/${truck.out}`, { hidden: false });
      await expect.poll(() => stream.events.filter((e) => e.event === 'trips').length, { timeout: 30_000 }).toBeGreaterThan(0);
    } finally { stream.close(); truck.done(); }
  });

  test('the simulator: real passes become trips, with GoGPS km once it has answered, and every link works', async ({ owner, server }) => {
    test.setTimeout(150_000);
    const day = tashkentDay();
    const from = addDays(day, -2);
    await expect.poll(async () => (await owner.get(`/api/trips?from=${from}&to=${day}&near=1`)).data.totals.trips, { timeout: 60_000 }).toBeGreaterThan(0);
    // The first answer from GoGPS comes a minute after the start; trips are then worked out again with it.
    await expect.poll(async () => (await owner.get(`/api/trips?from=${from}&to=${day}&near=1`)).data.trips.filter((t) => t.kmSrc === 'gps' && t.km > 0).length, { timeout: 120_000 }).toBeGreaterThan(0);
    const { trips, totals } = (await owner.get(`/api/trips?from=${from}&to=${day}&near=1`)).data;
    expect(totals.trips).toBe(trips.length);
    for (const t of trips.slice(0, 25)) {
      expect(t.startT ?? t.endT).toBeTruthy();
      expect(['done', 'open', 'no_exit', 'no_return']).toContain(t.state);
      if (t.durationS != null) expect(t.durationS).toBeGreaterThanOrEqual(0);
      for (const id of [t.outEventId, t.inEventId]) if (id) expect((await owner.get(`/api/gate-events/${id}`)).data.vehicleId).toBe(t.vehicleId);
      for (const s of t.stops) expect(s.seconds).toBeGreaterThanOrEqual(300);
    }
    expect(trips.some((t) => t.vehicleId === FLEET.dead && t.km > 0)).toBe(false);
  });

  test('plate decisions are the owner\'s alone', async ({ anon, dispatcher }) => {
    for (const [m, p, b] of [['get', '/api/plates/unknown'], ['get', '/api/plates/decided'], ['post', '/api/plates/10834HDA/link', { outside: true }], ['del', '/api/plates/10834HDA/link']]) {
      expect((await anon[m](p, b)).status, p).toBe(401);
      expect((await dispatcher[m](p, b)).status, p).toBe(403);
    }
  });
});
