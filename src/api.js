'use strict';
/**
 * JSON API. Every route says who may call it: public, any logged-in user ('user'), or 'owner'.
 * State-changing requests must be JSON from our own origin (CSRF protection on top of SameSite cookies).
 */
const fs = require('node:fs');
const bus = require('./bus');
const T = require('./time');
const { Router, parseCookies, readJson, json, clientIp } = require('./http');
const { COOKIE, httpError } = require('./auth');
const { vehicleLabel, vehicleType, prettyPlate, plateKey } = require('./gps/normalize');
const { view: gateView } = require('./gate');

const VEHICLE_TYPES = ['auto', 'mixer', 'dump', 'excavator', 'car', 'other'];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function buildApi(ctx) {
  const { h, config, auth, poller, gate, analytics, rules, push, gps, health: monitor } = ctx;
  const r = new Router();

  // --- guards ----------------------------------------------------------------------------------
  const user = (req) => { if (!req.user) throw httpError(401, 'Tizimga kiring'); };
  const owner = (req) => { user(req); if (req.user.role !== 'owner') throw httpError(403, "Bu bo'lim faqat rahbar uchun"); };

  const range = (q, defDays = 7) => {
    const to = DAY_RE.test(q.to || '') ? q.to : T.today();
    const from = DAY_RE.test(q.from || '') ? q.from : T.addDays(to, -(defDays - 1));
    if (from > to) throw httpError(400, "Sana oralig'i noto'g'ri");
    if (T.daysBetween(from, to).length > 400) throw httpError(400, "Oraliq juda katta (400 kundan ko'p)");
    return { from, to };
  };
  const intParam = (v, name) => { const n = Number(v); if (!Number.isInteger(n)) throw httpError(400, `${name} noto'g'ri`); return n; };

  // --- vehicles / live -------------------------------------------------------------------------
  const vehicleRows = () => h.all('SELECT * FROM vehicles WHERE active = 1 OR in_gps = 1');
  const liveView = (v, p) => ({
    id: v.id, label: vehicleLabel(v), gpsName: v.name, plate: v.plate ? prettyPlate(v.plate) : null, model: v.model,
    type: vehicleType(v), active: !!v.active, inGps: !!v.in_gps,
    lat: p?.lat ?? null, lng: p?.lng ?? null, speed: p?.speed ?? 0, course: p?.course ?? 0,
    status: p?.status ?? 'offline', recordTime: p?.recordTime ?? null, address: p?.address ?? '', inYard: !!p?.inYard,
  });
  const vehiclesLive = () => {
    const day = T.today();
    const stats = new Map(h.all('SELECT vehicle_id, km, trips_out, trips_in, fuel_used, fuel_end FROM daily_stats WHERE day = ?', day).map((s) => [s.vehicle_id, s]));
    const lastGate = new Map(h.all(`SELECT g.* FROM gate_events g JOIN (SELECT vehicle_id, MAX(t) t FROM gate_events
      WHERE vehicle_id IS NOT NULL AND status != 'vetoed' GROUP BY vehicle_id) x ON x.vehicle_id = g.vehicle_id AND x.t = g.t`).map((g) => [g.vehicle_id, g]));
    return vehicleRows().filter((v) => v.active).map((v) => {
      const s = stats.get(v.id), g = lastGate.get(v.id);
      return {
        ...liveView(v, poller?.live.get(v.id)),
        today: { km: s ? Math.round(s.km * 10) / 10 : 0, trips: Math.max(s?.trips_out || 0, s?.trips_in || 0), fuel: s?.fuel_used ?? null, fuelLevel: s?.fuel_end ?? null },
        lastGate: g ? { id: g.id, t: g.t, direction: g.direction } : null,
      };
    });
  };

  r.get('/api/vehicles', (req) => { user(req); return vehiclesLive(); });

  r.patch('/api/vehicles/:id', async (req, res, p) => {
    owner(req);
    const id = intParam(p.id, 'id');
    if (!h.get('SELECT 1 FROM vehicles WHERE id = ?', id)) throw httpError(404, 'Transport topilmadi');
    const b = req.body;
    if ('type' in b) { if (!VEHICLE_TYPES.includes(b.type)) throw httpError(400, "Noto'g'ri tur"); h.run('UPDATE vehicles SET type = ? WHERE id = ?', b.type, id); }
    if ('plate' in b) {
      const pl = b.plate ? plateKey(b.plate) : null;
      if (pl && h.get('SELECT 1 FROM vehicles WHERE plate = ? AND id != ?', pl, id)) throw httpError(409, 'Bu raqam boshqa transportga biriktirilgan');
      h.run('UPDATE vehicles SET plate = ? WHERE id = ?', pl, id);
    }
    if ('display' in b) h.run('UPDATE vehicles SET display = ? WHERE id = ?', b.display ? String(b.display).slice(0, 40) : null, id);
    if ('fuelNorm' in b) h.run('UPDATE vehicles SET fuel_norm = ? WHERE id = ?', b.fuelNorm === null || b.fuelNorm === '' ? null : Number(b.fuelNorm) || null, id);
    if ('active' in b) h.run('UPDATE vehicles SET active = ? WHERE id = ?', b.active ? 1 : 0, id);
    bus.emit('vehicles');
    const v = h.get('SELECT * FROM vehicles WHERE id = ?', id);
    return { ...liveView(v, poller?.live.get(id)), rawType: v.type, fuelNorm: v.fuel_norm, display: v.display };
  });

  r.get('/api/vehicles/all', (req) => {
    owner(req);
    return h.all('SELECT * FROM vehicles ORDER BY active DESC, name').map((v) => ({
      id: v.id, gpsName: v.name, label: vehicleLabel(v), plate: v.plate ? prettyPlate(v.plate) : '', display: v.display || '', type: v.type,
      model: v.model, fuelNorm: v.fuel_norm, active: !!v.active, inGps: !!v.in_gps,
      learned: h.all('SELECT plate, hits FROM alias_hits WHERE vehicle_id = ? ORDER BY hits DESC LIMIT 3', v.id).map((a) => ({ plate: prettyPlate(a.plate), hits: a.hits })),
      // Camera reads matched to this vehicle by "same digits and letters": the likely real plate.
      suggestedPlate: v.plate ? null : (() => { const g = h.get("SELECT plate, COUNT(*) n FROM gate_events WHERE vehicle_id = ? AND identified_by = 'similar' GROUP BY plate ORDER BY n DESC LIMIT 1", v.id); return g ? prettyPlate(g.plate) : null; })(),
    }));
  });

  r.get('/api/vehicles/:id/track', (req, res, p) => {
    user(req);
    const id = intParam(p.id, 'id');
    const day = DAY_RE.test(req.query.day || '') ? req.query.day : T.today();
    const from = T.dayStart(day), to = from + T.DAY;
    const pts = h.all('SELECT t, lat, lng, speed, course, status FROM positions WHERE vehicle_id = ? AND t >= ? AND t < ? ORDER BY t', id, from, to);
    // Stops: runs of non-moving samples lasting 5 min or more.
    const stops = [];
    let cur = null;
    for (const pt of pts) {
      if (pt.status !== 'moving') {
        if (!cur) cur = { start: pt.t, end: pt.t, lat: pt.lat, lng: pt.lng };
        else cur.end = pt.t;
      } else if (cur) {
        cur.end = pt.t;
        if (cur.end - cur.start >= 5 * 60e3) stops.push(cur);
        cur = null;
      }
    }
    if (cur && (Math.max(cur.end, Math.min(Date.now(), to)) - cur.start >= 5 * 60e3)) stops.push({ ...cur, end: null });
    return { day, points: pts.map((x) => [x.t, x.lat, x.lng, Math.round(x.speed), x.status[0]]), stops };
  });

  r.get('/api/vehicles/:id/days', (req, res, p) => {
    user(req);
    const id = intParam(p.id, 'id');
    const { from, to } = range(req.query, 14);
    return analytics.vehicleDays(id, from, to);
  });

  r.get('/api/vehicles/:id/events', (req, res, p) => {
    user(req);
    const id = intParam(p.id, 'id');
    const { from, to } = range(req.query, 1);
    const a = T.dayStart(from), b = T.dayStart(to) + T.DAY;
    return {
      gate: h.all('SELECT * FROM gate_events WHERE vehicle_id = ? AND t >= ? AND t < ? ORDER BY t DESC LIMIT 500', id, a, b).map((g) => gateView(g, h)),
      fuel: h.all('SELECT * FROM fuel_events WHERE vehicle_id = ? AND t >= ? AND t < ? ORDER BY t DESC', id, a, b),
      alerts: h.all('SELECT * FROM alerts WHERE vehicle_id = ? AND t >= ? AND t < ? ORDER BY t DESC LIMIT 200', id, a, b).map((x) => rules.view(x)),
    };
  });

  const stopCache = new Map();
  r.get('/api/vehicles/:id/stops', async (req, res, p) => {
    user(req);
    const id = intParam(p.id, 'id');
    if (!gps) throw httpError(503, 'GPS ulanmagan');
    const day = DAY_RE.test(req.query.day || '') ? req.query.day : T.today();
    const key = `${id}:${day}`;
    const hit = stopCache.get(key);
    if (hit && Date.now() - hit.at < (day === T.today() ? 5 * 60e3 : 3600e3)) return hit.data;
    const from = T.dayStart(day), to = Math.min(from + T.DAY, Date.now());
    const rows = await gps.moveStop([id], from, to);
    const row = rows.find((x) => Number(x.vehicleId) === id) || rows[0] || {};
    const data = {
      moves: (row.moves || []).map((m) => ({ start: T.parseApiTime(m.start), end: T.parseApiTime(m.end), km: Math.round((m.mileage || 0) * 10) / 10, duration: m.duration })),
      stops: (row.stops || []).map((s) => ({ start: T.parseApiTime(s.start), end: T.parseApiTime(s.end), duration: s.duration, address: s.address || '' })),
    };
    stopCache.set(key, { at: Date.now(), data });
    if (stopCache.size > 500) stopCache.delete(stopCache.keys().next().value);
    return data;
  });

  // --- gate ------------------------------------------------------------------------------------
  r.get('/api/gate-events', (req) => {
    user(req);
    const q = req.query;
    const where = [], args = [];
    if (DAY_RE.test(q.from || '')) { where.push('t >= ?'); args.push(T.dayStart(q.from)); }
    if (DAY_RE.test(q.to || '')) { where.push('t < ?'); args.push(T.dayStart(q.to) + T.DAY); }
    if (q.before) { where.push('t < ?'); args.push(Number(q.before)); }
    if (q.direction === 'in' || q.direction === 'out') { where.push('direction = ?'); args.push(q.direction); }
    if (q.vehicle) { where.push('vehicle_id = ?'); args.push(Number(q.vehicle)); }
    if (q.kind === 'fleet') where.push('vehicle_id IS NOT NULL');
    if (q.kind === 'outside') where.push('vehicle_id IS NULL');
    if (q.plate) { where.push('(plate LIKE ? OR plate_raw LIKE ?)'); const s = `%${plateKey(q.plate)}%`; args.push(s, s); }
    if (q.status === 'hidden') where.push("status = 'vetoed'");
    else if (q.status !== 'all') where.push("status != 'vetoed'");
    const limit = Math.min(500, Number(q.limit) || 100);
    const rows = h.all(`SELECT * FROM gate_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t DESC LIMIT ?`, ...args, limit);
    return rows.map((g) => gateView(g, h));
  });

  r.get('/api/gate-events/:id', (req, res, p) => {
    user(req);
    const ev = gate?.get(intParam(p.id, 'id'));
    if (!ev) throw httpError(404, 'Hodisa topilmadi');
    return ev;
  });

  /** Manual correction by a dispatcher: assign the right vehicle, or hide/restore an event. */
  r.patch('/api/gate-events/:id', (req, res, p) => {
    user(req);
    const id = intParam(p.id, 'id');
    const row = h.get('SELECT * FROM gate_events WHERE id = ?', id);
    if (!row) throw httpError(404, 'Hodisa topilmadi');
    const b = req.body;
    if ('vehicleId' in b) {
      const vid = b.vehicleId === null ? null : intParam(b.vehicleId, 'vehicleId');
      if (vid !== null && !h.get('SELECT 1 FROM vehicles WHERE id = ?', vid)) throw httpError(404, 'Transport topilmadi');
      h.run("UPDATE gate_events SET vehicle_id = ?, identified_by = ?, status = CASE WHEN ? IS NULL THEN 'outside' WHEN status IN ('outside','vetoed','pending') THEN 'confirmed' ELSE status END, status_note = ?, resolve_at = NULL WHERE id = ?",
        vid, vid ? 'manual' : null, vid, `Qo'lda: ${req.user.name}`, id);
    }
    if ('hidden' in b) {
      h.run("UPDATE gate_events SET status = ?, status_note = ?, resolve_at = NULL WHERE id = ?",
        b.hidden ? 'vetoed' : (row.vehicle_id ? 'confirmed' : 'outside'), `Qo'lda: ${req.user.name}`, id);
    }
    const ev = gate.get(id);
    bus.emit('gate:update', ev);
    return ev;
  });

  const sendJpeg = (res, file) => {
    if (!file || !fs.existsSync(file)) throw httpError(404, 'Rasm topilmadi');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    fs.createReadStream(file).pipe(res);
    return undefined;
  };

  r.get('/api/gate-events/:id/photo/:n', async (req, res, p) => {
    user(req);
    if (!gate) throw httpError(404, 'Kameralar ulanmagan');
    let file;
    try { file = await gate.photoFile(intParam(p.id, 'id'), intParam(p.n, 'n')); } catch (e) { throw httpError(502, `NVR: ${e.message}`); }
    return sendJpeg(res, file);
  });

  r.get('/api/push-image/:id', async (req, res, p) => {
    const id = intParam(p.id, 'id');
    if (!push.checkImage(id, req.query.exp, req.query.sig)) throw httpError(403, 'Taqiqlangan');
    return sendJpeg(res, await gate?.photoFile(id, 0));
  });

  /**
   * Who is inside the yard now. Fleet vehicles with a live GPS signal: GPS decides (the exit camera misses
   * many plates, so camera presence alone would keep trucks "inside" for hours); the camera entry gives the
   * time when it falls within the GPS visit. Without a signal, and for outside vehicles: the last camera pass
   * (entries older than 12 h without an exit are dropped).
   */
  const yard = () => {
    const now = Date.now();
    const rows = h.all("SELECT * FROM gate_events WHERE t >= ? AND status != 'vetoed' ORDER BY t", now - T.DAY);
    const last = new Map();
    for (const g of rows) {
      const key = g.vehicle_id ? `v${g.vehicle_id}` : g.plate_valid ? `p${g.plate}` : null;
      if (key) last.set(key, g);
    }
    const inside = [], gpsOnly = [];
    for (const v of h.all('SELECT * FROM vehicles WHERE active = 1')) {
      const p = poller?.live.get(v.id);
      const g = last.get(`v${v.id}`);
      const camIn = g && g.direction === 'in' ? g : null;
      if (p && p.status !== 'offline') {
        if (!p.inYard) continue;
        const visit = poller.openVisit.get(v.id);
        const camOk = camIn && (!visit || camIn.t >= visit.enter_t - 10 * 60e3);
        const item = { key: `v${v.id}`, vehicleId: v.id, label: vehicleLabel(v), fleet: true, gpsInYard: true,
          since: camOk ? camIn.t : visit && !visit.approx ? visit.enter_t : visit?.enter_t ?? null, event: camOk ? gateView(camIn, h) : null };
        (camOk ? inside : gpsOnly).push(item);
      } else if (camIn && now - camIn.t < 12 * 3600e3) {
        inside.push({ key: `v${v.id}`, vehicleId: v.id, label: vehicleLabel(v), fleet: true, gpsInYard: null, since: camIn.t, event: gateView(camIn, h) });
      }
    }
    for (const [key, g] of last) {
      if (g.vehicle_id || g.direction !== 'in' || now - g.t > 12 * 3600e3) continue;
      const ev = gateView(g, h);
      inside.push({ key, vehicleId: null, label: ev.plateText, fleet: false, gpsInYard: null, since: g.t, event: ev });
    }
    inside.sort((a, b) => a.since - b.since);
    return { inside, gpsOnly };
  };
  r.get('/api/yard', (req) => { user(req); return yard(); });

  r.get('/api/today', (req) => {
    user(req);
    const y = yard();
    const live = [...(poller?.live.values() || [])];
    const active = new Set(h.all('SELECT id FROM vehicles WHERE active = 1').map((v) => v.id));
    const counts = { moving: 0, idle: 0, stopped: 0, offline: 0 };
    for (const v of vehiclesLive()) counts[v.status]++;
    void live; void active;
    return { ...analytics.today(), insideFleet: y.inside.filter((x) => x.fleet).length + y.gpsOnly.length, insideOutside: y.inside.filter((x) => !x.fleet).length, status: counts };
  });

  // --- alerts ----------------------------------------------------------------------------------
  r.get('/api/alerts', (req) => {
    user(req);
    const q = req.query;
    const where = [], args = [];
    if (q.state === 'open') where.push('acked_at IS NULL');
    if (q.type) { where.push('type = ?'); args.push(String(q.type)); }
    if (q.vehicle) { where.push('vehicle_id = ?'); args.push(Number(q.vehicle)); }
    const limit = Math.min(500, Number(q.limit) || 200);
    return h.all(`SELECT * FROM alerts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t DESC LIMIT ?`, ...args, limit).map((a) => rules.view(a));
  });
  r.post('/api/alerts/:id/ack', (req, res, p) => {
    user(req);
    h.run('UPDATE alerts SET acked_by = ?, acked_at = ? WHERE id = ? AND acked_at IS NULL', req.user.id, Date.now(), intParam(p.id, 'id'));
    const a = rules.view(h.get('SELECT * FROM alerts WHERE id = ?', intParam(p.id, 'id')) || httpErrorRow());
    bus.emit('alert:update', a);
    return a;
  });
  r.post('/api/alerts/ack-all', (req) => {
    user(req);
    const n = h.run(`UPDATE alerts SET acked_by = ?, acked_at = ? WHERE acked_at IS NULL`, req.user.id, Date.now()).changes;
    bus.emit('alert:update', null);
    return { acked: n };
  });

  // --- analytics & reports -----------------------------------------------------------------------
  r.get('/api/analytics/overview', (req) => { owner(req); const { from, to } = range(req.query); return analytics.overview(from, to); });
  r.get('/api/analytics/series', (req) => { owner(req); const { from, to } = range(req.query, 30); return analytics.series(from, to); });
  r.get('/api/analytics/vehicles', (req) => { owner(req); const { from, to } = range(req.query); return analytics.byVehicle(from, to); });
  r.get('/api/reports/vehicles', (req) => { user(req); const { from, to } = range(req.query, 1); return analytics.report(from, to); });
  r.post('/api/analytics/recompute', async (req) => {
    owner(req);
    const day = DAY_RE.test(req.body.day || '') ? req.body.day : T.today();
    await analytics.rollup(day);
    return { ok: true, day };
  });

  // --- users -----------------------------------------------------------------------------------
  r.get('/api/users', (req) => { owner(req); return auth.users(); });
  r.post('/api/users', (req) => { owner(req); return auth.createUser(req.body); });
  r.patch('/api/users/:id', (req, res, p) => { owner(req); return auth.updateUser(intParam(p.id, 'id'), req.body, req.user); });
  r.delete('/api/users/:id', (req, res, p) => { owner(req); auth.deleteUser(intParam(p.id, 'id'), req.user); return { ok: true }; });

  // --- session ---------------------------------------------------------------------------------
  const cookie = (res, value, maxAgeS) => {
    const secure = config.env === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${secure}`);
  };
  r.post('/api/auth/login', (req, res) => {
    const s = auth.login(req.body.username, req.body.password, { ip: clientIp(req), ua: req.headers['user-agent'] });
    cookie(res, s.token, Math.floor((s.expires - Date.now()) / 1000));
    return { user: s.user };
  });
  r.post('/api/auth/logout', (req, res) => {
    auth.logout(req.cookies[COOKIE]);
    cookie(res, '', 0);
    return { ok: true };
  });
  r.get('/api/me', (req) => {
    user(req);
    return {
      user: req.user,
      yard: config.yard,
      pushKey: push.publicKey,
      cameras: !!gate,
      gps: !!poller,
      offlineMinutes: config.gps.offlineMinutes,
      mock: config.mock,
    };
  });
  r.post('/api/me/password', (req) => {
    user(req);
    const u = h.get('SELECT pass_hash FROM users WHERE id = ?', req.user.id);
    if (!require('./auth').verifyPassword(req.body.current || '', u.pass_hash)) throw httpError(400, "Joriy parol noto'g'ri");
    auth.updateUser(req.user.id, { password: req.body.password });
    return { ok: true, relogin: true };
  });

  // --- push ------------------------------------------------------------------------------------
  r.post('/api/push/subscribe', (req) => { user(req); return push.subscribe(req.user, req.body.subscription, req.body.prefs, req.headers['user-agent']); });
  r.post('/api/push/prefs', (req) => { user(req); return push.updatePrefs(req.user, String(req.body.endpoint || ''), req.body.prefs); });
  r.post('/api/push/status', (req) => { user(req); return push.get(String(req.body.endpoint || ''), req.user) || { endpoint: null }; });
  r.post('/api/push/unsubscribe', (req) => { user(req); push.unsubscribe(req.user, String(req.body.endpoint || '')); return { ok: true }; });
  r.post('/api/push/test', async (req) => {
    user(req);
    const ep = String(req.body.endpoint || '');
    await push.broadcast({ title: '🔔 Sinov xabari', body: 'Bildirishnomalar ishlayapti', tag: 'test', url: '/#/sozlamalar', kind: 'test' },
      (prefs, role, sub) => sub.user_id === req.user.id && (!ep || sub.endpoint === ep));
    return { ok: true };
  });

  // --- system ----------------------------------------------------------------------------------
  const health = () => ({
    time: Date.now(),
    gps: poller ? { lastOk: poller.lastOk || null, error: poller.lastError, vehicles: poller.live.size } : null,
    nvr: gate ? gate.health() : null,
    rollupAt: h.kvGet('rollup_at'),
    status: monitor ? monitor.summary() : null, // plain-language state of each part + active problems
  });
  r.get('/api/health', (req) => { user(req); return health(); });
  r.get('/api/system', (req) => {
    owner(req);
    const count = (t) => h.get(`SELECT COUNT(*) n FROM ${t}`).n;
    return {
      ...health(),
      counts: { positions: count('positions'), gateEvents: count('gate_events'), alerts: count('alerts'), users: count('users'), pushSubscriptions: count('push_subscriptions'), daysOfStats: h.get('SELECT COUNT(DISTINCT day) n FROM daily_stats').n },
      push: { sent: push.sent, failed: push.failed },
      dbBytes: (() => { try { return fs.statSync(require('node:path').join(config.dataDir, 'dispatcher.db')).size; } catch { return null; } })(),
      config: { yard: config.yard, cameras: config.nvr.cameras, speedLimit: config.rules.speedLimit, offlineMinutes: config.gps.offlineMinutes, longStopMinutes: config.rules.longStopMin, workHours: config.rules.workHours },
      uptimeS: Math.round(process.uptime()),
    };
  });

  // --- live stream (SSE) -----------------------------------------------------------------------
  r.get('/api/stream', (req, res) => {
    user(req);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.write('retry: 5000\n\n');
    send('hello', { time: Date.now() });
    const vehiclesById = () => new Map(vehicleRows().map((v) => [v.id, v]));
    let vmap = vehiclesById();
    const handlers = {
      positions: (list) => send('positions', list.map((p) => { const v = vmap.get(p.id); return v && v.active ? liveView(v, p) : null; }).filter(Boolean)),
      vehicles: () => { vmap = vehiclesById(); send('vehicles', {}); },
      gate: (ev) => send('gate', ev),
      'gate:update': (ev) => send('gate:update', ev),
      alert: (a) => send('alert', a),
      'alert:update': (a) => send('alert:update', a),
      health: () => send('health', health()),
    };
    for (const [k, fn] of Object.entries(handlers)) bus.on(k, fn);
    const ping = setInterval(() => res.write(': ping\n\n'), 25e3);
    const healthTick = setInterval(() => send('health', health()), 30e3);
    req.on('close', () => {
      clearInterval(ping);
      clearInterval(healthTick);
      for (const [k, fn] of Object.entries(handlers)) bus.off(k, fn);
    });
    return undefined;
  });

  return r;
}

function httpErrorRow() { throw httpError(404, 'Topilmadi'); }

/** Wraps the router: auth from cookie, JSON body, CSRF check, errors -> JSON. */
function apiHandler(ctx, router) {
  const { auth, config } = ctx;
  return async (req, res, url) => {
    req.query = Object.fromEntries(url.searchParams);
    req.cookies = parseCookies(req.headers.cookie);
    req.user = auth.session(req.cookies[COOKIE]);
    const m = router.match(req.method, url.pathname);
    if (!m) return json(res, 404, { error: 'Topilmadi' });
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const origin = req.headers.origin;
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        const allowed = origin && (origin === config.publicOrigin || new URL(origin).host === host);
        if (origin && !allowed) throw httpError(403, "Ruxsat yo'q (origin)");
        if (!/^application\/json/.test(req.headers['content-type'] || '') && req.headers['content-length'] !== '0' && req.headers['content-length']) {
          throw httpError(415, 'JSON kutilgan');
        }
        req.body = await readJson(req);
      } else req.body = {};
      const out = await m.handlers[0](req, res, m.params);
      if (out !== undefined && !res.headersSent) json(res, 200, out);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) ctx.log.error?.(`${req.method} ${url.pathname}: ${e.stack || e.message}`);
      if (!res.headersSent) json(res, status, { error: status >= 500 && !e.status ? 'Server xatosi' : e.message });
      else res.end();
    }
  };
}

module.exports = { buildApi, apiHandler, VEHICLE_TYPES };
