const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

/* ── Configuration ─────────────────────────────────────── */

const NODE_ENV = process.env.NODE_ENV || 'production';
const PORT = Number(process.env.PORT || 8090);
const HOST = '0.0.0.0';
const API_ORIGIN = process.env.API_ORIGIN || 'https://baku.gps.az';
const ROOT = __dirname;

const GPS_LOGIN = process.env.GPS_LOGIN || '';
const GPS_PASSWORD = process.env.GPS_PASSWORD || '';

const CORS_ORIGINS = (process.env.CORS_ORIGINS || '*')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

/* ── MIME types ─────────────────────────────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico':  'image/x-icon'
};

/* ── Helpers ───────────────────────────────────────────── */

function log(msg) {
  const ts = new Date().toISOString();
  process.stdout.write(`[${ts}] ${msg}\n`);
}

function isOriginAllowed(origin) {
  if (CORS_ORIGINS.includes('*')) return true;
  return CORS_ORIGINS.includes(origin);
}

function setCors(req, res) {
  const origin = req.headers.origin || '*';
  if (isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Auth,Authorization');
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  if (NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

function send(res, code, body, contentType = 'text/plain; charset=utf-8') {
  res.statusCode = code;
  res.setHeader('Content-Type', contentType);
  res.end(body);
}

/* ── Credential injection ──────────────────────────────── */

let dashboardCache = null;

function getDashboardHtml() {
  if (dashboardCache && NODE_ENV === 'production') return dashboardCache;

  let html = fs.readFileSync(path.join(ROOT, 'fleet-dashboard.html'), 'utf-8');

  // Replace the placeholder credentials with real ones from env
  html = html.replace(
    /const AUTO_LOGIN_CREDENTIALS\s*=\s*\{[^}]+\};/,
    `const AUTO_LOGIN_CREDENTIALS = { login: ${JSON.stringify(GPS_LOGIN)}, password: ${JSON.stringify(GPS_PASSWORD)} };`
  );

  dashboardCache = html;
  return html;
}

/* ── Static file server ────────────────────────────────── */

function serveStatic(req, res) {
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let reqPath = decodeURIComponent(parsed.pathname || '/');
  if (reqPath === '/') reqPath = '/fleet-dashboard.html';

  // Serve dashboard with injected credentials
  if (reqPath === '/fleet-dashboard.html') {
    setSecurityHeaders(res);
    setCors(req, res);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(getDashboardHtml());
    return;
  }

  const safePath = path.normalize(reqPath).replace(/^\/+/, '');
  const filePath = path.join(ROOT, safePath);

  if (!filePath.startsWith(ROOT)) {
    send(res, 403, 'Forbidden');
    return;
  }

  // Block sensitive files
  const base = path.basename(filePath);
  if (base.startsWith('.') || base === 'server.js' || base === 'dev-server.js' || base.endsWith('.md') || base === 'package.json') {
    send(res, 404, 'Not found');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { send(res, 404, 'Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    setSecurityHeaders(res);
    setCors(req, res);
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.end(data);
  });
}

/* ── API proxy ─────────────────────────────────────────── */

function proxyToGpsApi(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    setCors(req, res);
    res.end();
    return;
  }

  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const apiPath = parsed.pathname.replace(/^\/gps-api/, '') + (parsed.search || '');
  const target = new URL(apiPath, API_ORIGIN);

  const headers = { ...req.headers };
  delete headers.host;
  delete headers.origin;
  delete headers.referer;

  const upstream = https.request(target, {
    method: req.method,
    headers
  }, (up) => {
    res.statusCode = up.statusCode || 502;
    for (const [k, v] of Object.entries(up.headers)) {
      const lk = k.toLowerCase();
      if (lk === 'content-security-policy') continue;
      if (lk === 'access-control-allow-origin') continue;
      if (v !== undefined) res.setHeader(k, v);
    }
    setCors(req, res);
    up.pipe(res);
  });

  upstream.on('error', (err) => {
    log(`Proxy error: ${err.message}`);
    send(res, 502, JSON.stringify({ error: 'Proxy error' }), 'application/json; charset=utf-8');
  });

  req.pipe(upstream);
}

/* ── Health check ──────────────────────────────────────── */

function handleHealth(_req, res) {
  const payload = {
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    env: NODE_ENV
  };
  send(res, 200, JSON.stringify(payload), 'application/json; charset=utf-8');
}

/* ── Router ────────────────────────────────────────────── */

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsed.pathname;

  if (pathname === '/health' || pathname === '/healthz') {
    handleHealth(req, res);
    return;
  }
  if (pathname.startsWith('/gps-api/')) {
    proxyToGpsApi(req, res);
    return;
  }
  serveStatic(req, res);
});

/* ── Graceful shutdown ─────────────────────────────────── */

function shutdown(signal) {
  log(`Received ${signal}, shutting down gracefully…`);
  server.close(() => {
    log('Server closed.');
    process.exit(0);
  });
  setTimeout(() => { process.exit(1); }, 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/* ── Start ─────────────────────────────────────────────── */

if (!GPS_LOGIN || !GPS_PASSWORD) {
  log('WARNING: GPS_LOGIN and/or GPS_PASSWORD not set — auto-login will fail.');
}

server.listen(PORT, HOST, () => {
  log(`Server running on http://${HOST}:${PORT} [${NODE_ENV}]`);
  log(`Health check: http://127.0.0.1:${PORT}/health`);
  log(`API proxy:    http://127.0.0.1:${PORT}/gps-api`);
});
