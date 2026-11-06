'use strict';
/**
 * Our own plate reader (reader/, a separate container): a second reader next to the cameras'.
 * Model choice and measurements: docs/plate-recognition-plan.md.
 *
 *  Mode A, re-read:  a camera capture whose plate the camera couldn't read (empty or malformed) is read again from
 *                    the camera's own picture. Our read is used only when it is a valid Uzbek plate with confidence
 *                    >= minConf; the camera's read stays in plate_raw.
 *  Mode B, backup:   the reader watches the plate cameras' live video and reports each vehicle it read. A report is
 *                    held for `holdSec`: if the camera's own capture of that pass shows up meanwhile, the camera wins
 *                    and ours is dropped. Otherwise ours goes through the tracker and the gate exactly like a
 *                    camera capture (repeat and same-pass windows, plate matching, GPS resolution, alerts), named
 *                    own_<channel>_<ms>.
 *
 * If the reader is down or slow, the gate works exactly as without it: every call has a short timeout and a
 * failure only costs our read.
 */
const plates = require('./plates');

const OWN_PREFIX = 'own_';
const RECENT_MS = 15 * 60e3;

class OwnReader {
  /**
   * @param {{url: string, holdSec?: number, minConf?: number, pollSec?: number, timeoutMs?: number}} cfg
   * @param {{gate: import('../gate').Gate, h: object, log?: object, fetch?: typeof fetch}} deps
   */
  constructor(cfg, { gate, h, log = console, fetch: f = globalThis.fetch }) {
    this.url = cfg.url.replace(/\/$/, '');
    this.holdMs = (cfg.holdSec ?? 45) * 1000;
    this.minConf = cfg.minConf ?? 0.5;
    this.pollMs = (cfg.pollSec ?? 3) * 1000;
    this.timeoutMs = cfg.timeoutMs ?? 15000;
    this.gate = gate;
    this.h = h;
    this.log = log;
    this.fetch = f;
    this.after = null; // last pass seq taken from the reader; null: not asked yet (skip what it saw before we started)
    this.boot = null;  // the reader's id for its current run: a new one means it restarted
    this.held = [];
    this.timer = null;
    this.stopped = false;
    this.lastOk = null;
    this.lastError = null;
    this.stats = { passes: 0, used: 0, cameraHad: 0, rereads: 0, rereadUsed: 0 };
  }

  start() {
    const tick = async () => {
      if (this.stopped) return;
      await this.poll().catch((e) => this._fail(e));
      await this.release().catch((e) => this.log.warn?.(`own reader: ${e.message}`));
      this.timer = setTimeout(tick, this.pollMs);
    };
    tick();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  _fail(e) {
    const msg = String(e?.message || e);
    if (msg !== this.lastError) this.log.warn?.(`own reader: ${msg}`);
    this.lastError = msg;
  }

  async _get(path) {
    const res = await this.fetch(this.url + path, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`GET ${path.split('?')[0]}: HTTP ${res.status}`);
    return res.json();
  }

  /** Take new passes from the reader and hold them. */
  async poll() {
    let r = await this._get(`/passes?after=${this.after ?? 0}`);
    if (this.after !== null && r.boot !== this.boot) r = await this._get('/passes?after=0'); // restarted: ask for all
    if (this.lastError) this.log.info?.('own reader: back');
    this.lastOk = Date.now();
    this.lastError = null;
    if (this.after === null || r.boot !== this.boot) {
      // First contact (the app just started) or the reader restarted (new boot id, numbering from 1 again). Passes
      // from the last minutes are taken: one handled before an app restart comes back with the same name
      // (own_<channel>_<ms>) and the tracker skips it. Older ones are not news any more.
      this.boot = r.boot;
      this.after = r.seq;
      this.held.push(...r.passes.filter((p) => Date.now() - p.time < RECENT_MS));
      return;
    }
    this.after = r.seq;
    this.held.push(...r.passes);
  }

  /** Passes held long enough: the camera's capture had its chance. */
  async release(now = Date.now()) {
    const due = this.held.filter((p) => now - p.time >= this.holdMs);
    this.held = this.held.filter((p) => now - p.time < this.holdMs);
    for (const p of due) await this.handle(p);
  }

  /** True when the camera itself recorded a capture on this channel around this time. */
  cameraHad(channel, t) {
    return !!this.h.get(`SELECT 1 FROM cam_sightings WHERE channel = ? AND time BETWEEN ? AND ? AND name NOT LIKE 'own\\_%' ESCAPE '\\' LIMIT 1`,
      channel, t - 60e3, t + 30e3);
  }

  async handle(p) {
    this.stats.passes++;
    const cam = this.gate.cameras.get(p.channel);
    if (!cam) return;
    if (this.cameraHad(p.channel, p.time)) {
      this.stats.cameraHad++;
      return;
    }
    const plate = plates.normalize(p.plate);
    if (!plate || !plates.isValid(plate) || p.conf < this.minConf) return;
    const cap = {
      name: `${OWN_PREFIX}${p.channel}_${p.time}`, channel: p.channel, time: p.time, plate,
      own: { conf: p.conf, votes: p.votes, jpeg: Buffer.from(p.jpeg, 'base64') },
    };
    const d = this.gate.tracker.process(cap, cam);
    if (!d) return;
    this.log.info?.(`own reader: ${cam.name} ${plate} (${p.votes} frames, conf ${p.conf}): ${d.emit ? 'new gate event' : d.skipReason}`);
    if (!d.emit) return;
    this.stats.used++;
    await this.gate.onDecision(d, 'live');
  }

  /**
   * Mode A: our read of a camera picture, or null. Only a valid plate with enough confidence, not cut off at the
   * picture edge.
   * @param {Buffer} jpeg
   */
  async reread(jpeg) {
    this.stats.rereads++;
    const res = await this.fetch(`${this.url}/read`, {
      method: 'POST', body: jpeg, headers: { 'Content-Type': 'image/jpeg' }, signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`POST /read: HTTP ${res.status}`);
    const { reads } = await res.json();
    const ok = reads
      .map((r) => ({ ...r, plate: plates.normalize(r.plate) }))
      .filter((r) => r.plate && plates.isValid(r.plate) && r.conf >= this.minConf && !r.cut)
      .sort((a, b) => b.conf * b.det - a.conf * a.det);
    if (ok.length) this.stats.rereadUsed++;
    return ok[0] || null;
  }

  health() {
    return { url: this.url.replace(/\/\/[^/]*@/, '//'), lastOk: this.lastOk, error: this.lastError, held: this.held.length, ...this.stats };
  }
}

module.exports = { OwnReader, OWN_PREFIX };
