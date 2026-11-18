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
 *                    One truck can come back as two plates a character or two apart (85942DBA x11 and 85942DDA x3,
 *                    from one recording). A plate that is not one of the fleet's, reported within TWIN_MS of a
 *                    similar plate on the same camera that was read more often or is a fleet plate, is that misread
 *                    and dropped. Fleet plates are never dropped: real trucks here are one character apart.
 *                    The camera decides the direction, and the cameras' own captures are front plates. Ours are not:
 *                    a vehicle in view of both cameras is read by both, from the front by the camera it drives toward
 *                    and from behind by the other. On 18 Nov 2026 the rear read came first five times and the pass
 *                    was logged the wrong way. A pass seen driving away from its camera (heading 'away', from how the
 *                    plate moved in the picture):
 *                    - is dropped when the other camera saw the same plate coming toward it: that read decides;
 *                    - otherwise, on a camera where moving away means seen from behind (`awayIsRear`, ANPR-2), goes
 *                      the other way than the camera stands for: into the yard;
 *                    - otherwise (ANPR-1, where mixers reverse as they come in, front plate moving away) waits up to
 *                      PAIR_WAIT_MS for the other camera's read, and then goes as the camera says.
 *                    Evidence: docs/plate-recognition-plan.md, section 11.
 *
 * If the reader is down or slow, the gate works exactly as without it: every call has a short timeout and a
 * failure only costs our read.
 */
const plates = require('./plates');

const OWN_PREFIX = 'own_';
const RECENT_MS = 15 * 60e3;
const TWIN_MS = 15e3;
const PAIR_MS = 30e3;        // the other camera's read of the same pass: 0-10 s apart on 18 Nov 2026
// A re-read from the recording reaches the app 1.5-2 minutes after the pass (the NVR serves it a minute later).
const PAIR_WAIT_MS = 120e3;

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
    this.recent = []; // passes taken in the last minutes, held or handled: the neighbours a misread is judged by
    this.timer = null;
    this.stopped = false;
    this.lastOk = null;
    this.lastError = null;
    this.stats = { passes: 0, used: 0, cameraHad: 0, misread: 0, away: 0, rear: 0, rereads: 0, rereadUsed: 0 };
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
      this._take(r.passes.filter((p) => Date.now() - p.time < RECENT_MS));
      return;
    }
    this.after = r.seq;
    this._take(r.passes);
  }

  _take(passes) {
    this.held.push(...passes);
    const since = Date.now() - RECENT_MS;
    this.recent = this.recent.filter((p) => p.time >= since);
    this.recent.push(...passes);
  }

  /**
   * The plate this read is a misread of, or null: a similar plate on the same camera within TWIN_MS that was read in
   * more frames or belongs to the fleet, when this one doesn't.
   */
  misreadOf(p, plate) {
    const fleet = new Set(this.gate.fleetPlates());
    if (fleet.has(plate)) return null;
    for (const q of this.recent) {
      if (q === p || q.channel !== p.channel || Math.abs(q.time - p.time) > TWIN_MS || q.conf < this.minConf) continue;
      const other = plates.normalize(q.plate);
      if (!other || other === plate || !plates.isValid(other) || plates.distance(plate, other) > 2) continue;
      if (fleet.has(other) || q.votes > p.votes) return other;
    }
    return null;
  }

  /** Passes held long enough: the camera's capture had its chance, and a pass driving away the other camera's read. */
  async release(now = Date.now()) {
    const waiting = (p) => now - p.time < this.holdMs
      || (p.heading === 'away' && !this.gate.cameras.get(p.channel)?.awayIsRear && now - p.time < PAIR_WAIT_MS
        && !this.frontOn(p, plates.normalize(p.plate)));
    // In the order they happened: a pass read again from the recording arrives a minute after later live ones.
    const due = this.held.filter((p) => !waiting(p)).sort((a, b) => a.time - b.time);
    this.held = this.held.filter(waiting);
    for (const p of due) await this.handle(p);
  }

  /** The other camera's read of this plate, coming toward that camera, within PAIR_MS: the read that saw its front. */
  frontOn(p, plate) {
    return this.recent.find((q) => q.channel !== p.channel && q.heading === 'toward' && q.conf >= this.minConf
      && Math.abs(q.time - p.time) <= PAIR_MS && plates.normalize(q.plate) === plate) || null;
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
    const twin = this.misreadOf(p, plate);
    if (twin) {
      this.stats.misread++;
      this.log.info?.(`own reader: ${cam.name} ${plate} (${p.votes} frames) dropped, a misread of ${twin} in the same seconds`);
      return;
    }
    const cap = {
      name: `${OWN_PREFIX}${p.channel}_${p.time}`, channel: p.channel, time: p.time, plate,
      own: { conf: p.conf, votes: p.votes, jpeg: Buffer.from(p.jpeg, 'base64') },
    };
    const front = p.heading === 'away' ? this.frontOn(p, plate) : null;
    if (front) {
      this.stats.away++;
      const other = this.gate.cameras.get(front.channel);
      this.log.info?.(`own reader: ${cam.name} ${plate} (${p.votes} frames) driving away, dropped: ${other?.name || `ch${front.channel}`} saw it coming, ${other?.direction}`);
      return;
    }
    const rear = p.heading === 'away' && cam.awayIsRear; // seen from behind: going the other way
    if (rear) this.stats.rear++;
    const d = this.gate.tracker.process(cap, rear ? { ...cam, direction: cam.direction === 'in' ? 'out' : 'in' } : cam);
    if (!d) return;
    this.log.info?.(`own reader: ${cam.name} ${plate} (${p.votes} frames, conf ${p.conf}${rear ? `, seen from behind: ${d.direction}` : ''}): ${d.emit ? 'new gate event' : d.skipReason}`);
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
