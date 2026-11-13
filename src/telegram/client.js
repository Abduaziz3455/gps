'use strict';
/**
 * Telegram Bot API client. Port of the notifier's telegram.py, with what was measured there kept:
 *
 *  - The address DNS gives for api.telegram.org can accept only about half of the connections while another one
 *    answers every time (12 Oct 2026: 2/6 vs 6/6). So it connects to the address that worked last, then DNS, then the
 *    known Bot API addresses, over IPv4. Only the TCP target changes: TLS still verifies api.telegram.org.
 *  - Connections are kept open and reused: on the server a new one took a median 1.4 s and 1 in 5 failed, a reused one
 *    0.35 s with none failing (13 Oct). TCP keepalive notices one the network silently dropped.
 *
 * The URL contains the bot token, so it never goes into an error message or a log.
 */
const crypto = require('node:crypto');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

const FALLBACK_IPS = ['149.154.167.220', '149.154.167.99', '149.154.166.110'];
const CONNECT_TIMEOUT_MS = 5000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class TelegramError extends Error {
  /** @param {{permanent?: boolean, moveTo?: string|null, conflict?: boolean, retryAfterMs?: number}} [o] */
  constructor(message, { permanent = false, moveTo = null, conflict = false, retryAfterMs = 0 } = {}) {
    super(message);
    this.name = 'TelegramError';
    this.permanent = permanent;  // retrying won't help: blocked the bot, never pressed Start, chat gone
    this.moveTo = moveTo;        // the group became a supergroup with this new id
    this.conflict = conflict;    // another program is polling with the same token
    this.retryAfterMs = retryAfterMs;
  }
}

/** multipart/form-data body. fields: {name: value}; files: {name: {filename, data}}. */
function multipart(fields, files) {
  const boundary = `----tbb${crypto.randomBytes(12).toString('hex')}`;
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  for (const [k, f] of Object.entries(files)) {
    const filename = String(f.filename).replace(/[^\w.-]/g, '_');
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"; filename="${filename}"\r\nContent-Type: image/jpeg\r\n\r\n`), f.data, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

class TelegramClient {
  /** @param {{token: string, apiBase?: string, retries?: number, log?: object}} o  apiBase: tests talk to a local fake. */
  constructor({ token, apiBase = 'https://api.telegram.org', retries = 3, log = console }) {
    this.token = token;
    this.base = new URL(apiBase);
    this.retries = retries;
    this.log = log;
    this.secure = this.base.protocol === 'https:';
    this.goodIp = null;
    this.badIps = new Map(); // ip -> when it last failed to connect
    const options = { keepAlive: true, keepAliveMsecs: 20_000, maxSockets: 8, maxFreeSockets: 4 };
    this.agent = this.secure ? new https.Agent({ ...options, lookup: (h, o, cb) => this._lookup(h, o, cb) }) : new http.Agent(options);
    this.lastOk = 0;
  }

  /** Decide the address for a new connection. */
  _lookup(hostname, opts, cb) {
    const answer = (address) => (opts?.all ? cb(null, [{ address, family: 4 }]) : cb(null, address, 4));
    if (net.isIP(hostname)) return answer(hostname);
    dns.lookup(hostname, { family: 4, all: true }, (err, list) => {
      const known = [this.goodIp, ...(err ? [] : list.map((a) => a.address)), ...FALLBACK_IPS].filter(Boolean);
      const unique = [...new Set(known)];
      // Addresses that failed recently go last, longest ago first.
      const ordered = [...unique.filter((ip) => !this.badIps.has(ip)), ...unique.filter((ip) => this.badIps.has(ip)).sort((a, b) => this.badIps.get(a) - this.badIps.get(b))];
      this.triedIp = ordered[0];
      answer(ordered[0]);
    });
  }

  /** One HTTP request. Resolves with the parsed JSON; rejects with a message free of the URL. */
  _post(method, { body, contentType, timeoutMs }) {
    const mod = this.secure ? https : http;
    const path = `${this.base.pathname.replace(/\/$/, '')}/bot${this.token}/${method}`;
    return new Promise((resolve, reject) => {
      let connected = false;
      const req = mod.request({
        protocol: this.base.protocol, hostname: this.base.hostname, port: this.base.port || (this.secure ? 443 : 80), path, method: 'POST', agent: this.agent,
        headers: { 'Content-Type': contentType, 'Content-Length': body.length },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', () => reject(new Error('response failed')));
        res.on('aborted', () => reject(new Error('response aborted')));
        res.on('end', () => {
          if (this.triedIp && connected) { this.goodIp = this.triedIp; this.badIps.delete(this.triedIp); }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error(`bad answer (HTTP ${res.statusCode})`)); }
        });
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error('timed out')));
      req.on('socket', (s) => {
        if (!s.connecting) { connected = true; return; }
        const t = setTimeout(() => s.destroy(Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' })), CONNECT_TIMEOUT_MS);
        s.once(this.secure ? 'secureConnect' : 'connect', () => { connected = true; clearTimeout(t); });
        s.once('close', () => clearTimeout(t));
      });
      req.on('error', (e) => {
        if (!connected && this.triedIp) this.badIps.set(this.triedIp, Date.now());
        // Never e.message as it is: some carry the host and path.
        reject(new Error(e.code || (e.message === 'timed out' ? 'timed out' : 'connection failed')));
      });
      req.end(body);
    });
  }

  /** A Bot API call with short retries. fields are sent as a form; files make it multipart. */
  async call(method, fields = {}, { files = null, readTimeoutMs = 30e3, retries = this.retries } = {}) {
    let delay = 1000;
    const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]));
    const req = files ? multipart(clean, files)
      : { body: Buffer.from(new URLSearchParams(clean).toString()), contentType: 'application/x-www-form-urlencoded' };
    for (let attempt = 1; ; attempt++) {
      let data;
      try {
        data = await this._post(method, { ...req, timeoutMs: readTimeoutMs });
      } catch (e) {
        this.log.warn?.(`telegram ${method} attempt ${attempt}/${retries} failed: ${e.message}`);
        if (attempt >= retries) throw new TelegramError(`Telegram ${method} failed after ${retries} attempts (${e.message})`);
        await sleep(delay);
        delay = Math.min(delay * 2, 30e3);
        continue;
      }
      this.lastOk = Date.now();
      if (data.ok) return data.result;
      const params = data.parameters || {};
      if (params.retry_after && attempt < retries) {
        await sleep(params.retry_after * 1000);
        continue;
      }
      const desc = String(data.description || '');
      throw new TelegramError(`Telegram ${method} failed: ${desc}`, {
        permanent: data.error_code === 403 || /chat not found|user is deactivated/i.test(desc),
        moveTo: params.migrate_to_chat_id ? String(params.migrate_to_chat_id) : null,
        conflict: data.error_code === 409,
        retryAfterMs: (params.retry_after || 0) * 1000,
      });
    }
  }

  getMe() { return this.call('getMe'); }
  getChat(chatId) { return this.call('getChat', { chat_id: chatId }); }

  /** extra: more sendMessage fields, e.g. reply_markup (objects are sent as JSON). */
  sendText(text, chatId, extra = {}) {
    return this.call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
  }

  /** The button next to the message box in private chats: {type: 'web_app', text, web_app: {url}} or {type: 'default'}. */
  setMenuButton(button) { return this.call('setChatMenuButton', { menu_button: button }); }

  /** Long poll, kept short: a poll stuck on a bad connection is replaced after 35 s, not left waiting. */
  getUpdates(offset, timeoutS = 25) {
    return this.call('getUpdates', { timeout: timeoutS, offset: offset ?? undefined, allowed_updates: ['message', 'my_chat_member'] }, { readTimeoutMs: (timeoutS + 10) * 1000, retries: 1 });
  }

  setCommands(commands, scope = null) {
    return this.call('setMyCommands', { commands: commands.map(([command, description]) => ({ command, description })), scope: scope ?? undefined });
  }

  deleteCommands(scope) { return this.call('deleteMyCommands', { scope }); }

  /**
   * JPEGs as one album, caption on the first. With fileIds (from an earlier send of the same photos) nothing is
   * uploaded again. Returns the file ids of what was sent.
   * @param {{name: string, data: Buffer}[]} photos
   */
  async sendPhotos(caption, photos, chatId, fileIds = null) {
    const n = (fileIds || photos).slice(0, 10).length;
    const largest = (msg) => msg.photo[msg.photo.length - 1].file_id;
    if (n === 1) {
      const fields = { chat_id: chatId, caption, parse_mode: 'HTML' };
      if (fileIds) return [largest(await this.call('sendPhoto', { ...fields, photo: fileIds[0] }))];
      return [largest(await this.call('sendPhoto', fields, { files: { photo: { filename: `${photos[0].name}.jpg`, data: photos[0].data } }, readTimeoutMs: 60e3 }))];
    }
    const media = [], files = {};
    for (let i = 0; i < n; i++) {
      const item = fileIds ? { type: 'photo', media: fileIds[i] } : { type: 'photo', media: `attach://p${i}` };
      if (!fileIds) files[`p${i}`] = { filename: `${photos[i].name}.jpg`, data: photos[i].data };
      if (i === 0) Object.assign(item, { caption, parse_mode: 'HTML' });
      media.push(item);
    }
    const msgs = await this.call('sendMediaGroup', { chat_id: chatId, media }, { files: fileIds ? null : files, readTimeoutMs: 60e3 });
    return msgs.map(largest);
  }

  close() { this.agent.destroy(); }
}

module.exports = { TelegramClient, TelegramError, multipart, FALLBACK_IPS };
