'use strict';
/**
 * Boots the simulator once, waits for the 30-day history import and rollups, seeds design data and stops it.
 * That data folder is the template every worker's server is cloned from.
 */
const fs = require('node:fs');
const path = require('node:path');
const { TestServer, tmpRoot, sandboxApp } = require('./server');
const { designAlerts } = require('./seed');

const FALLBACK_TILE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mPMz8//DwAFgAK/7cpxvQAAAABJRU5ErkJggg==';

/** Stand-in map tile: looks like streets, so screenshots are readable, without calling OpenStreetMap. */
async function makeTile(file) {
  try {
    const sharp = require('sharp');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e8e6df"/>
      <g stroke="#fff" stroke-width="7"><path d="M0 64H256M0 180H256M72 0V256M196 0V256"/></g>
      <path d="M0 230L256 20" stroke="#f7d98a" stroke-width="9"/><rect x="96" y="84" width="72" height="72" fill="#cfe3c4"/></svg>`;
    await sharp(Buffer.from(svg)).png().toFile(file);
  } catch {
    fs.writeFileSync(file, Buffer.from(FALLBACK_TILE, 'base64'));
  }
}

module.exports = async () => {
  const t0 = Date.now();
  tmpRoot();
  sandboxApp();
  fs.mkdirSync(path.resolve(__dirname, '../.output/screenshots'), { recursive: true });
  await makeTile(path.join(process.env.E2E_TMP, 'tile.png'));

  if (process.env.E2E_REAL === '1') {
    // One server for the whole run (a failed test must not restart it: the import is real GoGPS load).
    const { readDotEnv, realServerEnv, tcpOpen } = require('./real-env');
    const env = readDotEnv();
    const serverEnv = realServerEnv(env);
    const s = new TestServer({ name: 'real', mock: false, env: serverEnv });
    await s.start();
    global.__e2eServer = s;
    Object.assign(process.env, {
      E2E_REAL_PORT: String(s.port), E2E_REAL_DATA: s.dataDir,
      E2E_REAL_USER: serverEnv.OWNER_USERNAME, E2E_REAL_PASS: serverEnv.OWNER_PASSWORD,
      E2E_NVR_REACHABLE: (await tcpOpen(env.NVR_HOST)) ? '1' : '0',
      E2E_SERVER_LOG: path.join(process.env.E2E_TMP, 'real-server.log'),
    });
    // Workers read the log from here; the file lives and dies with the temp folder.
    const logFile = process.env.E2E_SERVER_LOG;
    s.proc.stdout.on('data', (c) => fs.appendFileSync(logFile, c));
    s.proc.stderr.on('data', (c) => fs.appendFileSync(logFile, c));
    return;
  }

  const s = new TestServer({ name: 'template' });
  await s.start();
  const me = await fetch(`${s.url}/health`).then((r) => r.json());
  if (me.status !== 'ok') throw new Error('template server unhealthy');
  await s.waitForLog(/daily trip counts updated/, 240_000);
  for (let i = 0; i < 480 && !s.kv('rollup_at'); i++) await new Promise((r) => setTimeout(r, 500));
  if (!s.kv('rollup_at')) throw new Error(`template: rollups did not finish:\n${s.log.slice(-1500)}`);
  designAlerts(s);
  await s.stop();
  process.env.E2E_TEMPLATE_DIR = s.dataDir;
  console.log(`[e2e] template ready in ${Math.round((Date.now() - t0) / 1000)} s (${s.log.match(/camera history: \d+ captures/)?.[0] || 'no captures logged'})`);
};
