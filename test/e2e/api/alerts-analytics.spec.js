'use strict';
const { test, expect } = require('../support/fixtures');
const { alert, stats, gateEvent, FLEET, tashkentDay, addDays, dayStart, uid } = require('../support/seed');

test.describe('alerts', () => {
  test('each type and severity reads back in full', async ({ dispatcher, server }) => {
    const id = alert(server, { type: 'fuel_drain', severity: 'critical', vehicleId: FLEET.fuel, title: "Yoqilg'i to'kildi", body: '−42 L', data: { litres: 42 } });
    const a = (await dispatcher.get('/api/alerts?limit=500')).data.find((x) => x.id === id);
    expect(a).toMatchObject({ type: 'fuel_drain', severity: 'critical', vehicleId: FLEET.fuel, vehicleLabel: '85 450 KBA', title: "Yoqilg'i to'kildi", body: '−42 L', data: { litres: 42 }, ackedAt: null, ackedBy: null });
  });

  test('newest first; a limit is honoured and capped', async ({ dispatcher, server }) => {
    for (let i = 0; i < 3; i++) alert(server, { t: Date.now() - i * 1000 });
    const { data } = await dispatcher.get('/api/alerts?limit=3');
    expect(data.length).toBe(3);
    expect(data.map((a) => a.t)).toEqual([...data.map((a) => a.t)].sort((x, y) => y - x));
    const big = await dispatcher.get('/api/alerts?limit=100000');
    expect(big.data.length).toBeLessThanOrEqual(500);
  });

  test('a negative limit can\'t remove the cap', async ({ dispatcher, server }) => {
    server.sql((db) => {
      const ins = db.prepare("INSERT INTO alerts (key, type, severity, t, title) VALUES (?, 'speeding', 'info', 0, 'old')");
      db.exec('BEGIN');
      for (let i = 0; i < 520; i++) ins.run(`bulk:${uid()}`);
      db.exec('COMMIT');
    });
    try {
      const r = await dispatcher.get('/api/alerts?limit=-1');
      expect(r.status).toBeLessThan(500);
      if (r.status === 200) expect(r.data.length).toBeLessThanOrEqual(500);
    } finally { server.run("DELETE FROM alerts WHERE key LIKE 'bulk:%'"); }
  });

  test('filters: state, type, vehicle', async ({ dispatcher, server }) => {
    const v = FLEET.parked;
    const open = alert(server, { type: 'long_stop', severity: 'info', vehicleId: v });
    const done = alert(server, { type: 'long_stop', severity: 'info', vehicleId: v, ackedAt: Date.now(), ackedBy: 1 });
    const other = alert(server, { type: 'no_signal', vehicleId: v });
    const ids = async (qs) => (await dispatcher.get(`/api/alerts?${qs}&limit=500`)).data.map((a) => a.id);
    expect(await ids(`vehicle=${v}`)).toEqual(expect.arrayContaining([open, done, other]));
    expect(await ids(`vehicle=${v}&state=open`)).not.toContain(done);
    expect(await ids(`vehicle=${v}&type=no_signal`)).toEqual([other]);
    expect(await ids('type=nonsense')).toEqual([]);
    expect((await dispatcher.get('/api/alerts?vehicle=abc')).status).toBeLessThan(500);
    expect((await dispatcher.get(`/api/alerts?type=${encodeURIComponent("x' OR '1'='1")}`)).data).toEqual([]);
  });

  test('acknowledge: who and when; a second person can\'t overwrite it', async ({ dispatcher, owner, server }) => {
    const id = alert(server);
    const a = await dispatcher.post(`/api/alerts/${id}/ack`);
    expect(a.status).toBe(200);
    expect(a.data.ackedBy).toContain('Dispetcher');
    const first = a.data.ackedAt;
    const b = await owner.post(`/api/alerts/${id}/ack`);
    expect(b.status).toBe(200);
    expect(b.data.ackedAt).toBe(first);
    expect(b.data.ackedBy).toContain('Dispetcher');
    expect((await dispatcher.get('/api/alerts?state=open&limit=500')).data.some((x) => x.id === id)).toBe(false);
  });

  test('acknowledge: unknown 404, bad id 400', async ({ dispatcher }) => {
    expect((await dispatcher.post('/api/alerts/99999999/ack')).status).toBe(404);
    expect((await dispatcher.post('/api/alerts/abc/ack')).status).toBe(400);
  });

  test('acknowledge all: says how many, leaves none open, touches only open ones', async ({ owner, server }) => {
    const old = alert(server, { ackedAt: 1000, ackedBy: 1 });
    const fresh = [alert(server), alert(server)];
    const r = await owner.post('/api/alerts/ack-all');
    expect(r.data.acked).toBeGreaterThanOrEqual(2);
    expect((await owner.get('/api/alerts?state=open&limit=500')).data.length).toBe(0);
    const again = await owner.post('/api/alerts/ack-all');
    expect(again.data.acked).toBe(0);
    const rows = (await owner.get('/api/alerts?limit=500')).data;
    expect(rows.find((a) => a.id === old).ackedAt).toBe(1000);
    for (const id of fresh) expect(rows.find((a) => a.id === id).ackedAt).toBeTruthy();
  });

  test('duplicate keys are refused by the database: an incident is raised once', async ({ server }) => {
    const key = `dup:${uid()}`;
    alert(server, { key });
    expect(() => alert(server, { key })).toThrow();
  });

  test('/api/today counts open alerts of the last 7 days', async ({ owner, server }) => {
    await owner.post('/api/alerts/ack-all');
    alert(server, { t: Date.now() - 60000 });
    alert(server, { t: Date.now() - 8 * 86400e3 });
    expect((await owner.get('/api/today')).data.unackedAlerts).toBe(1);
  });
});

test.describe('analytics, with exact numbers', () => {
  const DAY = '2020-03-10';
  const PREV = '2020-03-09';
  test.beforeEach(({ server }) => {
    server.run('DELETE FROM daily_stats WHERE day IN (?, ?)', DAY, PREV);
    stats(server, DAY, FLEET.fuel, { km: 100, engine_s: 36000, idle_s: 3600, fuel_used: 40, refuel_l: 100, drain_l: 10, trips_out: 2, trips_in: 3, turnaround_s: 1800, max_speed: 90, odometer: 5000 });
    stats(server, DAY, FLEET.fuel2, { km: 50, engine_s: 18000, idle_s: 9000, trips_out: 1, trips_in: 1 });
    stats(server, DAY, FLEET.mixer, { km: 2, engine_s: 600, idle_s: 0 });
    stats(server, PREV, FLEET.fuel, { km: 200, engine_s: 3600, trips_out: 8, trips_in: 8 });
  });

  test('overview: totals, shares and the previous period', async ({ owner }) => {
    const { data } = await owner.get(`/api/analytics/overview?from=${DAY}&to=${DAY}`);
    expect(data.days).toBe(1);
    expect(data.previousRange).toEqual({ from: PREV, to: PREV });
    const c = data.current;
    expect(c.km).toBe(152);
    expect(c.trips, 'max(exits, entries) per vehicle-day: 3 + 1').toBe(4);
    expect(c.tripsIn).toBe(4);
    expect(c.engineHours).toBe(15.2);
    expect(c.idleShare).toBe(Math.round((12600 / 54600) * 100));
    expect(c.fuelUsed).toBe(40);
    expect(c.fuelPer100, 'only over the km of vehicles with a fuel sensor').toBe(40);
    expect(c.refuelL).toBe(100);
    expect(c.drainL).toBe(10);
    expect(c.vehiclesTotal).toBe(FLEET.total);
    expect(c.activeVehicleDays, 'a trip or at least 5 km: the 2 km vehicle doesn\'t count').toBe(2);
    expect(c.utilization).toBe(Math.round((2 / (FLEET.total * 1)) * 100));
    expect(c.turnaroundMin).toBe(30);
    expect(data.previous.km).toBe(200);
    expect(data.previous.trips).toBe(8);
  });

  test('a period with no data: zeros and nulls, not errors', async ({ owner }) => {
    const { data } = await owner.get('/api/analytics/overview?from=2019-05-01&to=2019-05-31');
    expect(data.days).toBe(31);
    expect(data.current).toMatchObject({ km: 0, trips: 0, engineHours: 0, idleShare: null, fuelUsed: null, fuelPer100: null, utilization: 0, turnaroundMin: null, yardMin: null });
  });

  test('series: one row per day, gaps filled', async ({ owner }) => {
    const { data } = await owner.get(`/api/analytics/series?from=${PREV}&to=2020-03-11`);
    expect(data.map((d) => d.day)).toEqual([PREV, DAY, '2020-03-11']);
    expect(data[1]).toMatchObject({ km: 152, trips: 4, fuel: 40, engineHours: 15.2, active: 2 });
    expect(data[2]).toMatchObject({ km: 0, trips: 0, fuel: null, active: 0 });
  });

  test('per vehicle: ranked by trips; norm and turnaround carried through', async ({ owner, server }) => {
    server.run('UPDATE vehicles SET fuel_norm = 35 WHERE id = ?', FLEET.fuel);
    try {
      const { data } = await owner.get(`/api/analytics/vehicles?from=${DAY}&to=${DAY}`);
      expect(data.length).toBe(FLEET.total);
      expect(data[0]).toMatchObject({ id: FLEET.fuel, trips: 3, km: 100, engineHours: 10, idleShare: 10, fuelUsed: 40, fuelPer100: 40, fuelNorm: 35, drainL: 10, maxSpeed: 90, turnaroundMin: 30, activeDays: 1, days: 1, odometer: 5000 });
      expect(data[1].id).toBe(FLEET.fuel2);
      expect(data[1]).toMatchObject({ fuelUsed: null, fuelPer100: null });
    } finally { server.run('UPDATE vehicles SET fuel_norm = NULL WHERE id = ?', FLEET.fuel); }
  });

  test('the dispatcher report matches the owner\'s analytics', async ({ owner, dispatcher }) => {
    const u = `from=${DAY}&to=${DAY}`;
    expect((await dispatcher.get(`/api/reports/vehicles?${u}`)).data).toEqual((await owner.get(`/api/analytics/vehicles?${u}`)).data);
  });

  test('a fleet-wide number is the sum of the vehicles', async ({ owner }) => {
    const y = addDays(tashkentDay(), -1);
    const from = addDays(y, -6);
    const [ov, vs] = await Promise.all([owner.get(`/api/analytics/overview?from=${from}&to=${y}`), owner.get(`/api/analytics/vehicles?from=${from}&to=${y}`)]);
    expect(vs.data.reduce((a, v) => a + v.trips, 0)).toBe(ov.data.current.trips);
    expect(vs.data.reduce((a, v) => a + v.km, 0)).toBeCloseTo(ov.data.current.km, 0);
  });

  test('analytics matches the database, on simulated data', async ({ owner, server }) => {
    const y = addDays(tashkentDay(), -1);
    const row = server.get('SELECT SUM(km) km, SUM(MAX(trips_out, trips_in)) trips FROM daily_stats WHERE day = ?', y);
    const { data } = await owner.get(`/api/analytics/overview?from=${y}&to=${y}`);
    expect(data.current.km).toBeCloseTo(row.km, 0);
    expect(data.current.trips).toBe(row.trips);
  });

  test('turnaround uses exit-to-next-entry, across midnight', async ({ owner, server }) => {
    const day = '2020-04-01';
    const t = dayStart(addDays(day, 1)) - 600e3;
    const ids = [gateEvent(server, { t, direction: 'out', vehicleId: FLEET.fuel, status: 'history' }), gateEvent(server, { t: t + 1200e3, direction: 'in', vehicleId: FLEET.fuel, status: 'history' })];
    await owner.post('/api/analytics/recompute', { day });
    const r = server.get('SELECT trips_out, turnaround_s FROM daily_stats WHERE day = ? AND vehicle_id = ?', day, FLEET.fuel);
    expect(r).toMatchObject({ trips_out: 1, turnaround_s: 1200 });
    server.run('DELETE FROM gate_events WHERE id IN (?, ?)', ...ids);
    server.run('DELETE FROM daily_stats WHERE day = ?', day);
  });

  test('hidden passes aren\'t counted as trips', async ({ owner, server }) => {
    const day = '2020-04-02';
    const t = dayStart(day) + 3600e3;
    const id = gateEvent(server, { t, direction: 'out', vehicleId: FLEET.fuel, status: 'vetoed' });
    await owner.post('/api/analytics/recompute', { day });
    expect(server.get('SELECT trips_out n FROM daily_stats WHERE day = ? AND vehicle_id = ?', day, FLEET.fuel).n).toBe(0);
    server.run('DELETE FROM gate_events WHERE id = ?', id);
    server.run('DELETE FROM daily_stats WHERE day = ?', day);
  });

  test('recompute: today by default; a garbage day falls back to today', async ({ owner }) => {
    expect((await owner.post('/api/analytics/recompute', {})).data).toMatchObject({ ok: true, day: tashkentDay() });
    expect((await owner.post('/api/analytics/recompute', { day: 'junk' })).data.day).toBe(tashkentDay());
  });

  test('recompute with an impossible date is a client error', async ({ owner }) => {
    expect((await owner.post('/api/analytics/recompute', { day: '2026-13-45' })).status).toBeLessThan(500);
  });

  test('recompute is safe to repeat: totals don\'t grow', async ({ owner, server }) => {
    const day = addDays(tashkentDay(), -2);
    const sum = () => server.get('SELECT SUM(km) km, SUM(trips_in) t, SUM(refuel_l) r FROM daily_stats WHERE day = ?', day);
    await owner.post('/api/analytics/recompute', { day });
    const a = sum();
    await owner.post('/api/analytics/recompute', { day });
    expect(sum()).toEqual(a);
  });
});
