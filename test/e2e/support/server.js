'use strict';
/**
 * Starts the real server.js as a child process.
 *
 * Safety: simulator servers run from a sandbox COPY of the app that has no .env, because server.js loads the
 * .env next to itself. They cannot reach the real GPS or NVR whatever the environment says. Only real.spec.js
 * passes real credentials, and it does so explicitly.
 */
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '../../..');
const ACCOUNTS = {
  owner: { username: 'owner', password: 'owner12345' },
  dispatcher: { username: 'dispatcher', password: 'dispatcher123' },
};

function tmpRoot() {
  if (!process.env.E2E_TMP) process.env.E2E_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tbb-e2e-'));
  return process.env.E2E_TMP;
}

/** Copy of the app without .env. node_modules is a junction back to the repo. */
function sandboxApp() {
  const app = path.join(tmpRoot(), 'app');
  if (!fs.existsSync(path.join(app, 'server.js'))) {
    fs.mkdirSync(app, { recursive: true });
    for (const f of ['server.js', 'package.json']) fs.copyFileSync(path.join(REPO, f), path.join(app, f));
    for (const d of ['src', 'public', 'scripts']) fs.cpSync(path.join(REPO, d), path.join(app, d), { recursive: true });
    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(app, 'node_modules'), 'junction');
  }
  if (fs.existsSync(path.join(app, '.env'))) throw new Error('sandbox must not contain .env');
  return app;
}

/** Remove the temp tree. The junction goes first, so nothing can reach the repo's node_modules through it. */
function cleanup() {
  const root = process.env.E2E_TMP;
  if (!root || !root.startsWith(os.tmpdir())) return;
  const link = path.join(root, 'app', 'node_modules');
  try { fs.unlinkSync(link); } catch { /* not there */ }
  if (fs.existsSync(link)) throw new Error(`could not remove junction ${link}; leaving the temp folder in place`);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Only what Windows and Node need; nothing inherited from the shell can change the app's configuration. */
function baseEnv() {
  const out = {};
  for (const k of ['SystemRoot', 'SystemDrive', 'PATH', 'Path', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOME', 'WINDIR', 'ComSpec', 'PATHEXT']) {
    if (process.env[k] !== undefined) out[k] = process.env[k];
  }
  return out;
}

class TestServer {
  /**
   * @param {{name: string, env?: object, mock?: boolean, dataDir?: string, app?: string}} o
   *   env wins over the defaults. mock:false starts without the simulator.
   */
  constructor({ name, env = {}, mock = true, dataDir, app }) {
    this.name = name;
    this.extraEnv = env;
    this.mock = mock;
    this.dataDir = dataDir || path.join(tmpRoot(), 'data', `${name}-${process.pid}-${Date.now()}`);
    this.app = app || sandboxApp();
    this.log = '';
    this.proc = null;
    this.exitCode = undefined;
    this.port = null;
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  get url() { return `http://127.0.0.1:${this.port}`; }
  get dbFile() { return path.join(this.dataDir, 'dispatcher.db'); }
  get alive() { return !!this.proc && this.exitCode === undefined; }

  /** Clone a stopped, seeded data folder. The heartbeat is refreshed so the clone doesn't report an outage. */
  seedFrom(templateDir) {
    fs.cpSync(templateDir, this.dataDir, { recursive: true });
    this.sql((db) => db.prepare("INSERT INTO kv (k, v) VALUES ('alive_at', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(String(Date.now())));
    return this;
  }

  async start({ waitReady = true } = {}) {
    this.port = this.port || await freePort();
    const env = {
      ...baseEnv(),
      NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(this.port), DATA_DIR: this.dataDir,
      PUBLIC_ORIGIN: `http://127.0.0.1:${this.port}`,
      INTERNET_PROBES: `127.0.0.1:${this.port}`, // non-mock servers: never probe the outside world
      TILE_URL: `http://127.0.0.1:${this.port}/no-tiles/{z}/{x}/{y}`, // browsers get a stub; the real tile servers stay out of it
      ...(this.mock ? { MOCK: '1' } : {}),
      ...this.extraEnv,
    };
    this.exitCode = undefined;
    this.proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: this.app, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const add = (c) => { this.log += c.toString(); };
    this.proc.stdout.on('data', add);
    this.proc.stderr.on('data', add);
    this.proc.once('exit', (code, sig) => { this.exitCode = code ?? sig ?? 'exit'; });
    if (waitReady) await this.waitReady();
    return this;
  }

  async waitReady(ms = 120_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (this.exitCode !== undefined) throw new Error(`server ${this.name} exited (${this.exitCode}) while starting:\n${this.log.slice(-1500)}`);
      try { if ((await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(2000) })).ok) return; } catch { /* not yet */ }
      await sleep(100);
    }
    throw new Error(`server ${this.name} not ready after ${ms} ms:\n${this.log.slice(-1500)}`);
  }

  async waitForLog(re, ms = 120_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (re.test(this.log)) return;
      if (this.exitCode !== undefined) throw new Error(`server ${this.name} exited (${this.exitCode}) waiting for ${re}:\n${this.log.slice(-1500)}`);
      await sleep(200);
    }
    throw new Error(`no ${re} in the log of ${this.name} after ${ms} ms:\n${this.log.slice(-1500)}`);
  }

  async stop() {
    if (!this.proc || this.exitCode !== undefined) return;
    const done = new Promise((r) => this.proc.once('exit', r));
    this.proc.kill();
    await Promise.race([done, sleep(5000)]);
  }

  async restart(opts) { await this.stop(); return this.start(opts); }
  async destroy() { await this.stop(); fs.rmSync(this.dataDir, { recursive: true, force: true, maxRetries: 3 }); }

  /** Run `fn(db)` on a separate connection to the server's database (seeding and checks). */
  sql(fn) {
    const db = new DatabaseSync(this.dbFile);
    try {
      db.exec('PRAGMA busy_timeout = 5000;');
      return fn(db);
    } finally { db.close(); }
  }
  all(q, ...a) { return this.sql((db) => db.prepare(q).all(...a)); }
  get(q, ...a) { return this.sql((db) => db.prepare(q).get(...a)); }
  run(q, ...a) { return this.sql((db) => db.prepare(q).run(...a)); }
  kv(k) { const r = this.get('SELECT v FROM kv WHERE k = ?', k); return r ? JSON.parse(r.v) : null; }

  /** Simulated failure (see mockFail in src/mock/sim.js). */
  setFail(word) { fs.writeFileSync(path.join(this.dataDir, 'mock_fail'), word); }
  clearFail() { fs.rmSync(path.join(this.dataDir, 'mock_fail'), { force: true }); }
}

/**
 * A stand-in for api.telegram.org: records every call, feeds commands in through getUpdates, and can be made to fail.
 * Real Telegram is never contacted by the simulator suites.
 */
class FakeTelegram {
  constructor() {
    this.calls = [];
    this.updates = [];
    this.nextUpdate = 1000;
    this.nextFile = 1;
    this.down = false;
    this.answer = null;
  }
  async start() {
    const http = require('node:http');
    this.server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => this.handle(req, res, Buffer.concat(chunks)));
    });
    await new Promise((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${this.server.address().port}`;
    return this;
  }
  handle(req, res, body) {
    const method = req.url.split('/').pop();
    if (this.down) return req.socket.destroy();
    const raw = body.toString('latin1');
    const fields = {};
    if (/multipart/.test(req.headers['content-type'] || '')) {
      for (const m of raw.matchAll(/name="(\w+)"\r\n\r\n([\s\S]*?)\r\n--/g)) fields[m[1]] = Buffer.from(m[2], 'latin1').toString('utf8');
    } else Object.assign(fields, Object.fromEntries(new URLSearchParams(raw)));
    const files = [...raw.matchAll(/name="(\w+)"; filename="([^"]+)"/g)].map((m) => m[2]);
    const answer = (result) => res.end(JSON.stringify({ ok: true, result }));
    const custom = this.answer?.(method, fields);
    if (method !== 'getUpdates') this.calls.push({ method, fields, files, t: Date.now(), bytes: body.length });
    if (custom) return res.end(JSON.stringify(custom));
    if (method === 'getUpdates') {
      this.lastOffset = Number(fields.offset) || null;
      const send = () => { const u = this.updates.filter((x) => !this.lastOffset || x.update_id >= this.lastOffset); this.updates = []; answer(u); };
      if (this.updates.length) return send();
      const waited = setTimeout(send, 300);
      return res.once('close', () => clearTimeout(waited));
    }
    if (method === 'getMe') return answer({ id: 1, is_bot: true, username: 'tbb_test_bot' });
    if (method === 'sendPhoto') return answer({ photo: [{ file_id: 's' }, { file_id: `file${this.nextFile++}` }] });
    if (method === 'sendMediaGroup') return answer(JSON.parse(fields.media).map(() => ({ photo: [{ file_id: 's' }, { file_id: `file${this.nextFile++}` }] })));
    return answer(method === 'sendMessage' ? { message_id: 1 } : true);
  }
  /** Someone sends the bot a command. */
  say(text, { user = 100, chat = 100, type = 'private', title } = {}) {
    this.updates.push({ update_id: this.nextUpdate++, message: { text, from: { id: user }, chat: { id: chat, type, title } } });
  }
  sent(method) { return this.calls.filter((c) => c.method === method); }
  /** Albums and single photos with their chat, caption and uploaded file count. */
  alerts() {
    const out = [];
    for (const c of this.calls) {
      if (c.method === 'sendMediaGroup') { const m = JSON.parse(c.fields.media); out.push({ chat: c.fields.chat_id, caption: m[0].caption, photos: m.length, uploaded: c.files.length, t: c.t }); }
      if (c.method === 'sendPhoto') out.push({ chat: c.fields.chat_id, caption: c.fields.caption, photos: 1, uploaded: c.files.length, t: c.t });
    }
    return out;
  }
  async stop() { this.server.closeAllConnections(); await new Promise((r) => this.server.close(r)); }
}

module.exports = { FakeTelegram, TestServer, ACCOUNTS, REPO, tmpRoot, sandboxApp, cleanup, sleep, baseEnv };
