'use strict';
/** The real credentials, for `npm run test:e2e:real` only. Values stay in memory and in the server's environment. */
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { REPO } = require('./server');

function readDotEnv() {
  const out = {};
  const file = path.join(REPO, '.env');
  if (!fs.existsSync(file)) throw new Error('.env not found: the real suite needs GPS_LOGIN, GPS_PASSWORD, NVR_HOST, NVR_PASSWORD');
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/** Strings that must never appear in a browser-visible response or in the logs. */
function secretsOf(env) {
  const host = env.NVR_HOST ? new URL(env.NVR_HOST.includes('//') ? env.NVR_HOST : `http://${env.NVR_HOST}`).hostname : '';
  return [['GPS_PASSWORD', env.GPS_PASSWORD], ['NVR_PASSWORD', env.NVR_PASSWORD], ['GPS_LOGIN', env.GPS_LOGIN], ['OWNER_PASSWORD', env.OWNER_PASSWORD], ['NVR host', host]]
    .filter(([, v]) => v && v.length >= 4);
}

/** The local server's settings: real GPS and NVR; everything that could reach people or production is overridden. */
function realServerEnv(env) {
  const pick = (k, d) => (env[k] !== undefined && env[k] !== '' ? env[k] : d);
  const out = {
    GPS_LOGIN: env.GPS_LOGIN, GPS_PASSWORD: env.GPS_PASSWORD,
    NVR_HOST: env.NVR_HOST, NVR_USER: pick('NVR_USER', 'admin'), NVR_PASSWORD: env.NVR_PASSWORD,
    CAMERA_BACKFILL_DAYS: '3', // enough to prove the import; no need to load 30 days of history from the NVR
    INTERNET_PROBES: pick('INTERNET_PROBES', '1.1.1.1:443,8.8.8.8:53'),
    HEALTH_CHECK_SECONDS: '15',
    SPEED_LIMIT_KMH: pick('SPEED_LIMIT_KMH', '80'), OFFLINE_MINUTES: pick('OFFLINE_MINUTES', '30'),
    LONG_STOP_MINUTES: pick('LONG_STOP_MINUTES', '90'), WORK_HOURS: pick('WORK_HOURS', '06:00-22:00'),
    YARD_LAT: pick('YARD_LAT', '41.2655'), YARD_LNG: pick('YARD_LNG', '69.3418'), YARD_RADIUS_M: pick('YARD_RADIUS_M', '150'), YARD_NAME: pick('YARD_NAME', 'TBB hovli'),
    // A test account in the throwaway database; the real owner password is not needed here.
    OWNER_USERNAME: 'e2e.owner', OWNER_PASSWORD: `e2e-${crypto.randomBytes(12).toString('hex')}`,
  };
  for (const k of ['GPS_BASE_URL', 'CAMERAS_JSON', 'SITE_ROUTER', 'TZ_OFFSET_MINUTES']) if (env[k]) out[k] = env[k];
  return out;
}

const tcpOpen = (hostUrl, ms = 8000) => new Promise((resolve) => {
  const u = new URL(hostUrl.includes('//') ? hostUrl : `http://${hostUrl}`);
  const s = net.connect({ host: u.hostname, port: Number(u.port || 80) });
  const done = (ok) => { s.destroy(); resolve(ok); };
  s.setTimeout(ms, () => done(false));
  s.once('connect', () => done(true));
  s.once('error', () => done(false));
});

module.exports = { readDotEnv, secretsOf, realServerEnv, tcpOpen };
