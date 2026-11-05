'use strict';
/**
 * Settings from the environment (.env is loaded by server.js). Nothing secret ever reaches the browser.
 */
const path = require('node:path');

const env = process.env;
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const ROOT = path.resolve(__dirname, '..');
const list = (v) => [...new Set(String(v || '').split(',').map((x) => x.trim()).filter(Boolean))];

/**
 * Default cameras: the pairing verified on 12 Oct 2026 (docs/site-survey.md), the top views measured on 5 Nov 2026 (docs/ARCHITECTURE.md, 2a).
 * topView: seconds around the plate capture to read from the overview camera's recording, where the vehicle is
 * expected (`expect`), and the part of the picture a vehicle on this lane covers (fractions of width and height).
 * Yo'l-2's picture also holds the public road on the upper left, whose traffic must not count.
 */
const DEFAULT_CAMERAS = [
  { channel: 4, name: 'ANPR-1', direction: 'in', contextChannel: 5, contextName: "Yo'l-2",
    topView: { from: -16, to: 20, expect: 1, lane: [[0, 0.6], [0.46, 0], [0.74, 0], [0.74, 1], [0, 1]] } },
  { channel: 3, name: 'ANPR-2', direction: 'out', contextChannel: 6, contextName: "Yo'l-1",
    topView: { from: -30, to: 4, expect: -12, lane: [[0, 0.35], [1, 0.35], [1, 1], [0, 1]] } },
];

function parseCameras(text) {
  if (!text) return DEFAULT_CAMERAS;
  const list = JSON.parse(text);
  if (!Array.isArray(list) || !list.length) throw new Error('CAMERAS_JSON must be a non-empty array');
  return list.map((c) => ({
    channel: Number(c.channel),
    name: String(c.name),
    direction: c.direction === 'out' ? 'out' : 'in',
    contextChannel: c.contextChannel ? Number(c.contextChannel) : null,
    contextName: c.contextName || null,
    topView: c.topView || null,
  }));
}

const config = {
  root: ROOT,
  env: env.NODE_ENV || 'production',
  port: num(env.PORT, 8090),
  host: env.HOST || '0.0.0.0',
  publicOrigin: (env.PUBLIC_ORIGIN || '').replace(/\/$/, ''), // e.g. https://tbb-gps.uz (Origin check, push links)
  dataDir: path.resolve(ROOT, env.DATA_DIR || 'data'),
  mock: bool(env.MOCK, false), // fake GPS + NVR for development and screenshots

  tzOffsetMin: num(env.TZ_OFFSET_MINUTES, 300), // Asia/Tashkent, UTC+5, no DST

  owner: { username: env.OWNER_USERNAME || '', password: env.OWNER_PASSWORD || '' },
  sessionDays: num(env.SESSION_DAYS, 30),

  gps: {
    baseUrl: (env.GPS_BASE_URL || env.API_ORIGIN || 'https://baku.gps.az').replace(/\/$/, '').replace(/\/api\/v3$/, ''),
    login: env.GPS_LOGIN || '',
    password: env.GPS_PASSWORD || '',
    pollSeconds: num(env.GPS_POLL_SECONDS, 10),
    minGapMs: num(env.GPS_MIN_GAP_MS, 1000), // the API rejects requests closer than 1 s
    offlineMinutes: num(env.OFFLINE_MINUTES, 30),
  },

  yard: {
    lat: num(env.YARD_LAT, 41.2655),
    lng: num(env.YARD_LNG, 69.3418),
    radiusM: num(env.YARD_RADIUS_M, 150),
    name: env.YARD_NAME || 'TBB hovli',
  },

  nvr: {
    host: (env.NVR_HOST || '').replace(/\/$/, ''),
    user: env.NVR_USER || 'admin',
    password: env.NVR_PASSWORD || '',
    cameras: parseCameras(env.CAMERAS_JSON),
    pollSeconds: num(env.CAMERA_POLL_SECONDS, 60),
    backfillDays: num(env.CAMERA_BACKFILL_DAYS, 30),
    catchupHours: num(env.CAMERA_CATCHUP_HOURS, 6),
    repeatWindowMin: num(env.REPEAT_WINDOW_MINUTES, 20),
    samePassWindowSec: num(env.SAME_PASS_WINDOW_SECONDS, 60),
    resolveAfterSec: num(env.GPS_SETTLE_SECONDS, 90),
    exitConfirmMin: num(env.EXIT_CONFIRM_MINUTES, 5),
    matchBeforeSec: num(env.MATCH_BEFORE_SECONDS, 45),
    matchAfterSec: num(env.MATCH_AFTER_SECONDS, 90),
    keepPhotosDays: num(env.KEEP_PHOTOS_DAYS, 90),
    rtspPort: num(env.NVR_RTSP_PORT, 554),
    topViewEnabled: bool(env.TOP_VIEW, true),
    topViewWorkers: num(env.TOP_VIEW_WORKERS, 2),
    ffmpeg: env.FFMPEG_PATH || 'ffmpeg',
    ffprobe: env.FFPROBE_PATH || 'ffprobe',
  },

  telegram: {
    token: env.TELEGRAM_BOT_TOKEN || '',
    apiBase: (env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, ''),
    chatIds: list(env.TELEGRAM_CHAT_IDS),     // alert recipients from the environment, besides those added with /ulash and /qoshish
    adminIds: list(env.ADMIN_IDS),            // the only users whose commands work; they get reports and health messages
    allVehicles: bool(env.TELEGRAM_ALL_VEHICLES, true), // false: alerts for GPS vehicles only
    reportTime: env.REPORT_TIME === undefined ? '22:00' : env.REPORT_TIME, // daily report; empty turns it off
    reportTo: env.REPORT_TO || 'groups',      // admins | groups (admins + alert groups) | all (+ users)
  },

  tiles: { url: env.TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png' },

  push: {
    subject: env.VAPID_SUBJECT || 'mailto:admin@tbb-gps.uz',
  },

  rules: {
    speedLimit: num(env.SPEED_LIMIT_KMH, 80),
    longStopMin: num(env.LONG_STOP_MINUTES, 90),
    workHours: env.WORK_HOURS || '06:00-22:00',
  },
};

config.gps.enabled = Boolean(config.gps.login && config.gps.password) || config.mock;
config.nvr.enabled = Boolean(config.nvr.host && config.nvr.password) || config.mock;
config.telegram.enabled = Boolean(config.telegram.token);

module.exports = config;
