'use strict';
/**
 * TBB Dispatcher v2 server: one process for the web app, the JSON API, the GPS poller, the camera pipeline,
 * analytics rollups, alert rules and push notifications. See docs/ARCHITECTURE.md.
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

loadEnv(path.join(__dirname, '.env'));

require('./src/dnscache').install();
const config = require('./src/config');
const bus = require('./src/bus');
const { open, helpers } = require('./src/db');
const { Auth } = require('./src/auth');
const { GpsClient } = require('./src/gps/client');
const { Poller } = require('./src/gps/poller');
const { Gate } = require('./src/gate');
const { Analytics } = require('./src/analytics');
const { Places } = require('./src/places');
const { Trips } = require('./src/trips');
const { PlateLinks } = require('./src/platelinks');
const { Rules } = require('./src/rules');
const { Push } = require('./src/push');
const { Health, gpsFresh } = require('./src/health');
const { Outbox } = require('./src/notify/outbox');
const { buildApi, apiHandler } = require('./src/api');
const { serveFile, securityHeaders, json } = require('./src/http');

const log = {
  info: (m) => process.stdout.write(`${new Date().toISOString()} INFO ${m}\n`),
  warn: (m) => process.stdout.write(`${new Date().toISOString()} WARN ${m}\n`),
  error: (m) => process.stderr.write(`${new Date().toISOString()} ERROR ${m}\n`),
};

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

function build() {
  const db = open(path.join(config.dataDir, 'dispatcher.db'));
  const h = helpers(db);
  const auth = new Auth({ h, config });
  auth.ensureOwner(log);

  let gps = null, nvr = null, sim = null, topView = null;
  if (config.mock) {
    const { Sim, MockGps, MockNvr, MockTopView, MOCK_TYPES } = require('./src/mock/sim');
    sim = new Sim({ yard: config.yard });
    gps = new MockGps({ sim, dataDir: config.dataDir });
    nvr = new MockNvr({ sim, cameras: config.nvr.cameras, dataDir: config.dataDir });
    if (config.nvr.topViewEnabled) topView = new MockTopView({ dataDir: config.dataDir });
    log.warn('MOCK mode: simulated GPS and cameras (demo data)');
    ctxSeed = { MOCK_TYPES };
  } else {
    if (config.gps.enabled) gps = new GpsClient({ ...config.gps, tzOffsetMin: config.tzOffsetMin, log });
    else log.warn('GPS_LOGIN / GPS_PASSWORD not set: live map and GPS analytics are off');
    if (config.nvr.enabled) {
      const { NVR } = require('./src/cameras/hikvision');
      nvr = new NVR({ host: config.nvr.host, user: config.nvr.user, password: config.nvr.password, tzOffsetMin: config.tzOffsetMin });
      if (config.nvr.topViewEnabled) {
        const { TopView } = require('./src/cameras/topview');
        topView = new TopView({ host: config.nvr.host, user: config.nvr.user, password: config.nvr.password, rtspPort: config.nvr.rtspPort, tzOffsetMin: config.tzOffsetMin, ffmpeg: config.nvr.ffmpeg, ffprobe: config.nvr.ffprobe, log });
      }
    } else log.warn('NVR_HOST / NVR_PASSWORD not set: gate cameras are off');
  }

  const poller = gps ? new Poller({ h, gps, config, log }) : null;
  let gate = null;
  if (nvr) {
    const { Tracker } = require('./src/cameras/tracker');
    const plates = require('./src/cameras/plates');
    let gateRef = null;
    const tracker = new Tracker(db, {
      repeatWindowMs: config.nvr.repeatWindowMin * 60e3,
      samePassWindowMs: config.nvr.samePassWindowSec * 1000,
      fleetPlates: () => (gateRef ? gateRef.fleetPlates() : []),
    });
    gate = gateRef = new Gate({ h, nvr, poller, config, tracker, plates, topView, log });
  }
  const analytics = new Analytics({ h, gps, config, log });
  const places = new Places({ h, config, log });
  const trips = new Trips({ h, gps, places, config, log });
  const plateLinks = new PlateLinks({ h, analytics, trips, log });
  const rules = new Rules({ h, config, poller, gate, places, log });
  const push = new Push({ h, config, log });
  // In MOCK mode the internet probe is simulated too (see src/mock/sim.js mockFail).
  const probe = config.mock ? async () => ({ ok: require('./src/mock/sim').mockFail(config.dataDir) !== 'internet' }) : undefined;
  const health = new Health({ h, config, poller, gate, rules, log, ...(probe ? { probe } : {}) });
  const outbox = new Outbox({ h, log });
  const ctx = { h, db, config, auth, gps, nvr, poller, gate, analytics, places, trips, plateLinks, rules, push, health, sim, outbox, log };
  if (config.telegram.enabled) {
    const { Telegram } = require('./src/telegram');
    ctx.telegram = new Telegram(ctx);
  } else log.warn('TELEGRAM_BOT_TOKEN not set: Telegram alerts and commands are off');
  return ctx;
}

let ctxSeed = null;

async function start() {
  const ctx = build();
  const { config: cfg, poller, gate, analytics, places, rules, push, health, h, outbox, telegram } = ctx;
  const api = apiHandler(ctx, buildApi(ctx));
  const publicDir = path.join(__dirname, 'public');
  const leafletDir = path.join(__dirname, 'node_modules', 'leaflet', 'dist');
  const version = require('./package.json').version;

  const badRequest = (res) => { res.statusCode = 400; res.end('Bad request'); };
  const handle = async (req, res) => {
    securityHeaders(res, cfg.env === 'production');
    let url;
    try { url = new URL(req.url, 'http://local'); } catch { return badRequest(res); }
    if (url.pathname === '/health' || url.pathname === '/healthz') {
      return json(res, 200, { status: 'ok', version, uptime: Math.round(process.uptime()), gps: poller ? gpsFresh(poller.lastOk, cfg.gps.pollSeconds) : null, nvr: gate ? !!gate.nvr.lastOk : null });
    }
    if (url.pathname.startsWith('/api/')) return api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; return res.end(); }
    if (url.pathname.startsWith('/vendor/leaflet/')) {
      if (serveFile(req, res, leafletDir, url.pathname.slice('/vendor/leaflet/'.length), { cache: 'public, max-age=604800' })) return;
      res.statusCode = 404;
      return res.end('Not found');
    }
    if (url.pathname !== '/' && url.pathname !== '/index.html') {
      let rel;
      try { rel = decodeURIComponent(url.pathname).replace(/^\/+/, ''); } catch { return badRequest(res); }
      const cache = rel === 'sw.js' ? 'no-cache' : 'public, max-age=300';
      if (serveFile(req, res, publicDir, rel, { cache })) return;
      if (path.extname(rel)) { res.statusCode = 404; return res.end('Not found'); }
    }
    serveFile(req, res, publicDir, 'index.html', { cache: 'no-cache' });
  };
  // A request must never be able to take the process down: nothing may escape as an unhandled rejection.
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log.error(`${req.method} ${String(req.url).slice(0, 200)}: ${e.stack || e.message}`);
      if (!res.headersSent) json(res, 500, { error: 'Server xatosi' });
      else res.destroy();
    });
  });

  if (cfg.mock) await seedMock(ctx);
  server.listen(cfg.port, cfg.host, () => log.info(`TBB Dispatcher ${version} on http://${cfg.host}:${cfg.port} [${cfg.env}]`));

  push.start();
  rules.start();
  health.start();
  if (poller) poller.start();
  analytics.start();
  places.start();
  ctx.trips.start();
  outbox.start();
  telegram?.start();
  if (gate) {
    // Camera history arrived after the first rollups: recompute the camera columns of those days.
    bus.on('gate:history', async ({ since }) => {
      try {
        const T = require('./src/time');
        for (const day of T.daysBetween(T.dayOf(since), T.today())) await analytics.rollup(day, { withGps: false });
        log.info('camera history: daily trip counts updated');
      } catch (e) {
        log.error(`camera history rollup: ${e.stack || e.message}`);
      }
    });
    // Let the poller load the vehicle list first so plate matching works from the start.
    setTimeout(() => gate.start().catch((e) => log.error(`camera pipeline: ${e.stack || e.message}`)), poller ? 4000 : 0);
  }

  const shutdown = (sig) => {
    log.info(`${sig}: shutting down`);
    poller?.stop(); gate?.stop(); analytics.stop(); places.stop(); ctx.trips.stop(); rules.stop(); health.stop(); outbox.stop(); telegram?.stop();
    h.kvSet('alive_at', Date.now()); // the outage report after restart counts from this moment
    server.close(() => { ctx.db.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return { server, ctx };
}

/** Demo database: vehicle types, a few users, and today's / yesterday's positions so tracks aren't empty. */
async function seedMock(ctx) {
  const { h, poller, sim } = ctx;
  if (h.kvGet('mock_seeded')) return;
  await poller.syncVehicles();
  for (const [id, type] of Object.entries(ctxSeed.MOCK_TYPES)) h.run('UPDATE vehicles SET type = ? WHERE id = ?', type, Number(id));
  if (!h.get("SELECT 1 FROM users WHERE username = 'owner'")) ctx.auth.createUser({ username: 'owner', name: 'Rahbar (demo)', role: 'owner', password: 'owner12345' });
  if (!h.get("SELECT 1 FROM users WHERE username = 'dispatcher'")) ctx.auth.createUser({ username: 'dispatcher', name: 'Dispetcher (demo)', role: 'dispatcher', password: 'dispatcher123' });
  const { FLEET } = require('./src/mock/sim');
  const { haversineM } = require('./src/gps/normalize');
  const T = require('./src/time');
  const from = T.dayStart(T.addDays(T.today(), -1)), to = Date.now() - 60e3;
  h.tx(() => {
    for (const [id] of FLEET) {
      if (id === 22238 || id === 22871) continue;
      let inside = null, visit = null;
      for (let t = from; t < to; t += 30e3) {
        const p = sim.position(id, t);
        const status = p.state === 4 ? 'moving' : p.state === 2 ? 'idle' : 'stopped';
        if (status === 'moving' || t % 120e3 < 30e3) h.run('INSERT OR IGNORE INTO positions VALUES (?, ?, ?, ?, ?, ?, ?)', id, t, p.lat, p.lng, p.speed, p.course, status);
        const inYard = haversineM(p.lat, p.lng, ctx.config.yard.lat, ctx.config.yard.lng) <= ctx.config.yard.radiusM;
        if (inYard && !inside) visit = Number(h.run('INSERT INTO yard_visits (vehicle_id, enter_t, approx) VALUES (?, ?, ?)', id, t, inside === null ? 1 : 0).lastInsertRowid);
        if (!inYard && inside) h.run('UPDATE yard_visits SET exit_t = ? WHERE id = ?', t, visit);
        inside = inYard;
      }
    }
  });
  for (const r of h.all('SELECT id, vehicle_id, enter_t FROM yard_visits WHERE exit_t IS NULL')) poller.openVisit.set(r.vehicle_id, { id: r.id, enter_t: r.enter_t });
  h.kvSet('mock_seeded', true);
  ctx.log.info('MOCK: demo users owner/owner12345 and dispatcher/dispatcher123');
}

if (require.main === module) start();

module.exports = { start, build };
