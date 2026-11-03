'use strict';
const { test, expect } = require('../support/fixtures');
const { FLEET, tashkentDay, addDays, dayStart } = require('../support/seed');

const V = FLEET.fuel;
const live = async (c, id) => (await c.get('/api/vehicles')).data.find((v) => v.id === id);
const all = async (c, id) => (await c.get('/api/vehicles/all')).data.find((v) => v.id === id);
const reset = (server, id) => server.run("UPDATE vehicles SET type = 'auto', plate = NULL, display = NULL, fuel_norm = NULL, active = 1 WHERE id = ?", id);

test.describe('list', () => {
  test('the whole fleet, with everything the map needs', async ({ dispatcher }) => {
    const { data } = await dispatcher.get('/api/vehicles');
    expect(data.length).toBe(FLEET.total);
    expect(new Set(data.map((v) => v.id)).size).toBe(FLEET.total);
    for (const v of data) {
      expect(typeof v.label).toBe('string');
      expect(['moving', 'idle', 'stopped', 'offline']).toContain(v.status);
      expect(['mixer', 'dump', 'excavator', 'car', 'other']).toContain(v.type);
      expect(v.today).toMatchObject({ km: expect.any(Number), trips: expect.any(Number) });
    }
  });

  test('a tracker silent for days shows "offline", with its last position', async ({ dispatcher }) => {
    await expect.poll(async () => (await live(dispatcher, FLEET.dead)).status, { timeout: 30_000 }).toBe('offline');
    const v = await live(dispatcher, FLEET.dead);
    expect(v.recordTime).toBeLessThan(Date.now() - 86400e3);
  });

  test('statuses follow GoGPS\'s state, not speed alone', async ({ dispatcher }) => {
    const { data } = await dispatcher.get('/api/vehicles');
    for (const v of data.filter((x) => x.status === 'moving')) expect(v.speed).toBeGreaterThan(0);
    for (const v of data.filter((x) => x.status === 'stopped')) expect(v.speed).toBe(0);
  });

  test('inYard agrees with the yard list', async ({ dispatcher }) => {
    const [vs, yard] = await Promise.all([dispatcher.get('/api/vehicles'), dispatcher.get('/api/yard')]);
    const listed = new Set([...yard.data.inside, ...yard.data.gpsOnly].filter((x) => x.fleet).map((x) => x.vehicleId));
    for (const v of vs.data.filter((x) => x.inYard && x.status !== 'offline')) expect(listed.has(v.id), v.label).toBe(true);
  });

  test('/api/today status counts add up to the fleet', async ({ dispatcher }) => {
    const { data } = await dispatcher.get('/api/today');
    expect(Object.values(data.status).reduce((a, b) => a + b, 0)).toBe(FLEET.total);
    expect(data.day).toBe(tashkentDay());
  });

  test('the owner list has editing fields and camera suggestions', async ({ owner }) => {
    const { data } = await owner.get('/api/vehicles/all');
    expect(data.length).toBe(FLEET.total);
    const mixer = data.find((v) => v.id === FLEET.mixer);
    expect(mixer.gpsName).toBe('10 870 HAD');
    expect(mixer).toHaveProperty('learned');
    expect(mixer).toHaveProperty('suggestedPlate');
  });

  test('a Cyrillic GPS name stays readable', async ({ owner }) => {
    const v = (await owner.get('/api/vehicles/all')).data.find((x) => x.id === FLEET.parked);
    expect(v.gpsName).toBe('85 117 АА');
  });
});

test.describe('editing', () => {
  test.afterEach(({ server }) => reset(server, V));

  for (const type of ['mixer', 'dump', 'excavator', 'car', 'other', 'auto']) {
    test(`type: ${type}`, async ({ owner }) => {
      const r = await owner.patch(`/api/vehicles/${V}`, { type });
      expect(r.status).toBe(200);
      expect(r.data.rawType).toBe(type);
    });
  }
  for (const bad of ['truck', '', null, 5, ['mixer']]) {
    test(`invalid type is refused: ${JSON.stringify(bad)}`, async ({ owner }) => {
      expect((await owner.patch(`/api/vehicles/${V}`, { type: bad })).status).toBe(400);
    });
  }

  test('real plate: normalised, pretty-printed, used as the label', async ({ owner }) => {
    const r = await owner.patch(`/api/vehicles/${V}`, { plate: '85 777 kba' });
    expect(r.data.plate).toBe('85 777 KBA');
    expect(r.data.label).toBe('85 777 KBA');
    expect((await live(owner, V)).label).toBe('85 777 KBA');
  });

  test('a Cyrillic plate is folded to Latin', async ({ owner }) => {
    expect((await owner.patch(`/api/vehicles/${V}`, { plate: '85 778 КВА' })).data.plate).toBe('85 778 KBA');
  });

  test('a plate already on another vehicle: 409', async ({ owner, server }) => {
    await owner.patch(`/api/vehicles/${V}`, { plate: '85111AAA' });
    try {
      expect((await owner.patch(`/api/vehicles/${FLEET.fuel2}`, { plate: '85 111 AAA' })).status).toBe(409);
    } finally { reset(server, FLEET.fuel2); }
  });

  test('clearing the plate: the GPS name returns', async ({ owner }) => {
    await owner.patch(`/api/vehicles/${V}`, { plate: '85779KBA' });
    const r = await owner.patch(`/api/vehicles/${V}`, { plate: '' });
    expect(r.data.plate).toBeNull();
    expect(r.data.label).toBe('85 450 KBA');
  });

  test('a plate with no usable characters is treated as empty', async ({ owner }) => {
    const r = await owner.patch(`/api/vehicles/${V}`, { plate: '!!!' });
    expect(r.status).toBe(200);
    expect(r.data.plate).toBeNull();
    expect(r.data.label).toBe('85 450 KBA');
  });

  test('display name: wins over everything, cut to 40 characters, empty clears it', async ({ owner }) => {
    expect((await owner.patch(`/api/vehicles/${V}`, { display: 'Mikser 31' })).data.label).toBe('Mikser 31');
    expect((await owner.patch(`/api/vehicles/${V}`, { display: 'x'.repeat(60) })).data.display.length).toBe(40);
    expect((await owner.patch(`/api/vehicles/${V}`, { display: '' })).data.label).toBe('85 450 KBA');
  });

  test('fuel norm: number, null and empty', async ({ owner }) => {
    expect((await owner.patch(`/api/vehicles/${V}`, { fuelNorm: 38.5 })).data.fuelNorm).toBe(38.5);
    expect((await owner.patch(`/api/vehicles/${V}`, { fuelNorm: null })).data.fuelNorm).toBeNull();
    await owner.patch(`/api/vehicles/${V}`, { fuelNorm: 40 });
    expect((await owner.patch(`/api/vehicles/${V}`, { fuelNorm: '' })).data.fuelNorm).toBeNull();
  });

  test('a negative fuel norm is refused (the UI refuses it; the API must too)', async ({ owner }) => {
    expect((await owner.patch(`/api/vehicles/${V}`, { fuelNorm: -5 })).status).toBe(400);
  });

  test('a fuel norm that isn\'t a number is refused, not silently cleared', async ({ owner }) => {
    await owner.patch(`/api/vehicles/${V}`, { fuelNorm: 40 });
    const r = await owner.patch(`/api/vehicles/${V}`, { fuelNorm: 'abc' });
    expect(r.status).toBe(400);
    expect((await all(owner, V)).fuelNorm).toBe(40);
  });

  test('a refused edit changes nothing at all', async ({ owner, server }) => {
    const before = server.get('SELECT * FROM vehicles WHERE id = ?', V);
    expect((await owner.patch(`/api/vehicles/${V}`, { type: 'dump', display: 'Yangi', fuelNorm: -1 })).status).toBe(400);
    expect(server.get('SELECT * FROM vehicles WHERE id = ?', V)).toEqual(before);
  });

  test('a display name that isn\'t text is refused', async ({ owner }) => {
    expect((await owner.patch(`/api/vehicles/${V}`, { display: { a: 1 } })).status).toBe(400);
  });

  test('switched off: gone from the map, analytics and reports; history stays; back on: returns', async ({ owner, server }) => {
    const day = addDays(tashkentDay(), -1);
    const km = async () => (await owner.get(`/api/analytics/overview?from=${day}&to=${day}`)).data.current;
    const before = await km();
    const vkm = server.get('SELECT km FROM daily_stats WHERE vehicle_id = ? AND day = ?', V, day)?.km || 0;
    expect((await owner.patch(`/api/vehicles/${V}`, { active: false })).data.active).toBe(false);
    expect(await live(owner, V)).toBeUndefined();
    expect((await owner.get(`/api/reports/vehicles?from=${day}&to=${day}`)).data.find((v) => v.id === V)).toBeUndefined();
    expect((await km()).km).toBeCloseTo(before.km - vkm, 0);
    expect((await km()).vehiclesTotal).toBe(before.vehiclesTotal - 1);
    expect((await owner.get('/api/vehicles/all')).data.find((v) => v.id === V).active, 'still on the owner\'s list').toBe(false);
    await owner.patch(`/api/vehicles/${V}`, { active: true });
    expect(await live(owner, V)).toBeTruthy();
  });

  test('an empty patch changes nothing; unknown fields are ignored', async ({ owner, server }) => {
    const a = server.get('SELECT * FROM vehicles WHERE id = ?', V);
    expect((await owner.patch(`/api/vehicles/${V}`, {})).status).toBe(200);
    expect((await owner.patch(`/api/vehicles/${V}`, { name: 'hacked', id: 1, in_gps: 0 })).status).toBe(200);
    expect(server.get('SELECT * FROM vehicles WHERE id = ?', V)).toEqual(a);
  });

  test('unknown vehicle: 404. Bad id: 400', async ({ owner }) => {
    expect((await owner.patch('/api/vehicles/999999', { type: 'car' })).status).toBe(404);
    expect((await owner.patch('/api/vehicles/abc', { type: 'car' })).status).toBe(400);
  });

  for (const raw of ['null', '5', '"x"']) {
    test(`body that isn't an object is a client error: ${raw}`, async ({ owner }) => {
      const r = await owner.call('PATCH', `/api/vehicles/${V}`, { rawBody: raw, headers: { 'content-type': 'application/json' } });
      expect(r.status).toBeLessThan(500);
    });
  }
});

test.describe('track, days, events, stops', () => {
  const YESTERDAY = () => addDays(tashkentDay(), -1);

  test('track: ordered points inside the requested day, in the documented shape', async ({ dispatcher }) => {
    const day = YESTERDAY();
    const { data } = await dispatcher.get(`/api/vehicles/${V}/track?day=${day}`);
    expect(data.day).toBe(day);
    expect(data.points.length).toBeGreaterThan(0);
    const start = dayStart(day);
    let prev = 0;
    for (const p of data.points) {
      expect(p).toHaveLength(5);
      expect(p[0]).toBeGreaterThanOrEqual(prev);
      expect(p[0]).toBeGreaterThanOrEqual(start);
      expect(p[0]).toBeLessThan(start + 86400e3);
      expect(['m', 'i', 's', 'o']).toContain(p[4]);
      prev = p[0];
    }
    for (const s of data.stops) {
      if (s.end) expect(s.end - s.start, 'stops are 5 min or longer').toBeGreaterThanOrEqual(5 * 60e3);
    }
  });

  test('track without a day: today', async ({ dispatcher }) => {
    expect((await dispatcher.get(`/api/vehicles/${V}/track`)).data.day).toBe(tashkentDay());
  });

  test('track: a day with no data, and an unknown vehicle: empty', async ({ dispatcher }) => {
    expect((await dispatcher.get(`/api/vehicles/${V}/track?day=2019-01-01`)).data.points).toEqual([]);
    expect((await dispatcher.get('/api/vehicles/999999/track')).data.points).toEqual([]);
  });

  test('track: a garbage day falls back to today', async ({ dispatcher }) => {
    expect((await dispatcher.get(`/api/vehicles/${V}/track?day=junk`)).data.day).toBe(tashkentDay());
  });

  test('bad vehicle ids: 400 on all four', async ({ dispatcher }) => {
    for (const p of ['track', 'days', 'events', 'stops']) expect((await dispatcher.get(`/api/vehicles/abc/${p}`)).status, p).toBe(400);
  });

  test('days: 14 by default, in order, ending today', async ({ dispatcher }) => {
    const { data } = await dispatcher.get(`/api/vehicles/${V}/days`);
    expect(data.length).toBe(14);
    expect(data[13].day).toBe(tashkentDay());
    expect(data[0].day).toBe(addDays(tashkentDay(), -13));
    expect([...data.map((d) => d.day)].sort()).toEqual(data.map((d) => d.day));
  });

  test('days: a trip count is the larger of exits and entries (the exit camera misses plates)', async ({ dispatcher }) => {
    const { data } = await dispatcher.get(`/api/vehicles/${V}/days?from=${addDays(tashkentDay(), -13)}&to=${YESTERDAY()}`);
    for (const d of data) expect(d.trips).toBe(Math.max(d.tripsOut, d.tripsIn));
  });

  test('events: gate passes, fuel and alerts of that vehicle only', async ({ dispatcher }) => {
    const day = YESTERDAY();
    const { data } = await dispatcher.get(`/api/vehicles/${V}/events?from=${day}&to=${day}`);
    for (const g of data.gate) expect(g.vehicleId).toBe(V);
    for (const f of data.fuel) expect(f.vehicle_id).toBe(V);
    for (const a of data.alerts) expect(a.vehicleId).toBe(V);
  });

  test('stops: moves and stops inside the day; a second call is served from cache', async ({ dispatcher }) => {
    const day = YESTERDAY();
    const a = await dispatcher.get(`/api/vehicles/${V}/stops?day=${day}`);
    expect(a.status).toBe(200);
    expect(a.data.moves.concat(a.data.stops).length).toBeGreaterThan(0);
    const start = dayStart(day);
    for (const m of a.data.moves) { expect(m.start).toBeGreaterThanOrEqual(start); expect(m.end).toBeGreaterThan(m.start); expect(m.km).toBeGreaterThanOrEqual(0); }
    const b = await dispatcher.get(`/api/vehicles/${V}/stops?day=${day}`);
    expect(b.data).toEqual(a.data);
  });
});

test.describe('date ranges', () => {
  const URLS = ['/api/analytics/overview', '/api/analytics/series', '/api/analytics/vehicles', '/api/reports/vehicles', `/api/vehicles/${V}/days`, `/api/vehicles/${V}/events`];

  for (const u of URLS) {
    test(`from after to: 400 on ${u}`, async ({ owner }) => {
      expect((await owner.get(`${u}?from=2026-02-02&to=2026-02-01`)).status).toBe(400);
    });
    test(`over 400 days: 400; exactly 400: fine, on ${u}`, async ({ owner }) => {
      expect((await owner.get(`${u}?from=2024-01-01&to=2026-01-01`)).status).toBe(400);
      expect((await owner.get(`${u}?from=2025-01-01&to=${addDays('2025-01-01', 399)}`)).status).toBe(200);
    });
    for (const [from, to] of [['2026-13-45', '2026-13-45'], ['2026-02-31', '2026-03-01'], ['0000-00-00', '0000-00-00'], ['9999-99-99', '9999-99-99']]) {
      test(`impossible date ${from} is a client error, on ${u}`, async ({ owner }) => {
        const r = await owner.get(`${u}?from=${from}&to=${to}`);
        expect(r.status, r.text.slice(0, 120)).toBeLessThan(500);
      });
    }
  }

  for (const p of ['track', 'stops']) {
    test(`impossible day is a client error, on ${p}`, async ({ dispatcher }) => {
      const r = await dispatcher.get(`/api/vehicles/${V}/${p}?day=2026-13-45`);
      expect(r.status, r.text.slice(0, 120)).toBeLessThan(500);
    });
  }

  test('an enormous range is refused at once', async ({ owner }) => {
    const t0 = Date.now();
    expect((await owner.get('/api/analytics/series?from=2000-01-01&to=2100-12-31')).status).toBe(400);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  test('garbage dates fall back to the default range', async ({ owner }) => {
    const { data } = await owner.get('/api/analytics/series?from=abc&to=def');
    expect(data.length).toBe(30);
    expect(data[29].day).toBe(tashkentDay());
  });

  test('a year boundary is walked correctly', async ({ owner }) => {
    const { data } = await owner.get('/api/analytics/series?from=2025-12-30&to=2026-01-02');
    expect(data.map((d) => d.day)).toEqual(['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02']);
  });

  test('a leap day is walked correctly', async ({ owner }) => {
    const { data } = await owner.get('/api/analytics/series?from=2028-02-28&to=2028-03-01');
    expect(data.map((d) => d.day)).toEqual(['2028-02-28', '2028-02-29', '2028-03-01']);
  });
});
