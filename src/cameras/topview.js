'use strict';
/**
 * Top view: the frame of an overview camera's recording with the vehicle right under it, so the load (or the empty
 * bed) can be seen. A live snapshot can't do this: by the time the event arrives the vehicle has passed.
 *
 * Why it works this way, measured on real recordings on 5 Nov 2026 (docs/ARCHITECTURE.md, section 2a):
 *
 *  - When a vehicle passes varies a lot around the plate capture: on the entry from before the capture to 6 s after,
 *    on the exit 6-18 s before it. So a wide window is read, and the moment is found in it, not assumed.
 *  - Comparing with the first frame fails whenever a vehicle is already in that frame: the empty lane then looks like
 *    the biggest change. The background is the median of all frames read: a vehicle covers a spot only briefly.
 *  - The window can hold the vehicle before or behind this one, so vehicles are told apart as separate passes and the
 *    one nearest the expected moment is taken.
 *  - Sand or a tarpaulin on grey road is close in brightness, so a bed scores far below a bright cab. Comparing colour
 *    helps, and of the frames of a pass the one after the cab is taken when the vehicle drives forward (mixers often
 *    reverse through the picture: there the frame near the best stays).
 *  - Nothing found means nothing to show. An empty lane is never sent as if it showed the vehicle.
 *  - The NVR sometimes ends a stream early without an error, so a short read is tried again.
 *  - The NVR keeps a key frame every 2 s and serves a recording in real time. Decoding key frames only uses a fifth of
 *    the CPU and half the memory, and a vehicle takes several seconds to cross the picture.
 *  - The NVR makes a recording playable in 2-minute steps. Earlier than that it answers 400 Bad Request.
 *
 * ffmpeg runs as its own process, so decoding can't hurt the server: it is limited by the worker count, and if it
 * crashes or hangs only this one picture is lost.
 */
const { spawn } = require('node:child_process');

const W = 160, H = 90, CH = 3;         // the size frames are compared at, RGB
const OUT_WIDTH = 1280;                // the photo we keep
const KEY_INTERVAL_S = 2;              // the NVR's key frame interval (measured); corrected from the frames counted
const CHANGED = 25;                    // grey levels that count as "different from the background"
const MIN_SHARE = 0.04;                // of the lane: below this no vehicle is there (a small car covers about 5%)
const NEAR_BEST = 0.85;                // frames this close to a pass's best: the vehicle is fully in view
const TRAILING = 0.4;                  // a later frame still this close to the best can be the bed, if the vehicle moved on
const FORWARD = [-1, 1];               // the way vehicles drive across both overview pictures: towards the lower left
const FORWARD_MIN = 4;                 // pixels (of 160 x 90) of movement that count as driving, not noise
const MIN_READ = 0.7;                  // less than this share of the expected key frames: the NVR cut the stream short
const TOLERANCE_S = 7;                 // a pass this close to the expected moment may be ours; the biggest of them wins
const SOCKET_TIMEOUT_US = 20_000_000;  // the NVR stopped answering
const JPEG_START = Buffer.from([0xff, 0xd8]);
const JPEG_END = Buffer.from([0xff, 0xd9]);

/** Which pixels of a W x H picture are on the lane. No polygon: all of them. */
function laneMask(polygon, w = W, h = H) {
  const mask = new Uint8Array(w * h);
  if (!polygon?.length) return mask.fill(1);
  const pts = polygon.map(([x, y]) => [x * w, y * h]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if ((yi > y + 0.5) !== (yj > y + 0.5) && x + 0.5 < ((xj - xi) * (y + 0.5 - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) mask[y * w + x] = 1;
    }
  }
  return mask;
}

/** Median of each value over the frames: what the place looks like with nothing passing. */
function medianBackground(frames, size = frames[0].length) {
  const bg = new Uint8Array(size);
  const col = new Uint8Array(frames.length);
  for (let p = 0; p < size; p++) {
    for (let f = 0; f < frames.length; f++) col[f] = frames[f][p];
    col.sort();
    bg[p] = col[frames.length >> 1];
  }
  return bg;
}

/**
 * How much of the lane differs from the background, and where. The camera's exposure moves the whole picture
 * together, so each colour's typical difference in this frame is taken off first.
 * @returns {{share: number, x: number, y: number}} x, y: the middle of what differs
 */
function compare(frame, bg, mask, w = W) {
  const pixels = frame.length / CH;
  const hist = [new Uint32Array(511), new Uint32Array(511), new Uint32Array(511)];
  let total = 0;
  for (let p = 0; p < pixels; p++) {
    if (!mask[p]) continue;
    total++;
    for (let c = 0; c < CH; c++) hist[c][frame[p * CH + c] - bg[p * CH + c] + 255]++;
  }
  if (!total) return { share: 0, x: 0, y: 0 };
  const shift = hist.map((h) => {
    let seen = 0;
    for (let d = 0; d < 511; d++) { seen += h[d]; if (seen * 2 >= total) return d - 255; }
    return 0;
  });
  let changed = 0, sx = 0, sy = 0;
  for (let p = 0; p < pixels; p++) {
    if (!mask[p]) continue;
    let far = false;
    for (let c = 0; c < CH && !far; c++) far = Math.abs(frame[p * CH + c] - bg[p * CH + c] - shift[c]) > CHANGED;
    if (far) { changed++; sx += p % w; sy += Math.floor(p / w); }
  }
  return { share: changed / total, x: changed ? sx / changed : 0, y: changed ? sy / changed : 0 };
}

/**
 * Finds the vehicle in a window of frames. Pure, so it is tested on recorded data.
 * @param {{t: number, small: Uint8Array}[]} frames  t: seconds from the plate capture, oldest first
 * @param {{mask: Uint8Array, expect: number}} o
 * @returns {{index: number|null, share?: number, t?: number, shares: number[], passes: number}}
 */
function findVehicle(frames, { mask, expect = 0 }) {
  if (frames.length < 3) return { index: null, shares: [], passes: 0 };
  const bg = medianBackground(frames.map((f) => f.small));
  const seen = frames.map((f) => compare(f.small, bg, mask));
  const shares = seen.map((s) => s.share);
  const passes = [];
  let cur = null;
  shares.forEach((s, i) => {
    if (s >= MIN_SHARE) { if (!cur) passes.push(cur = { from: i, to: i, best: s }); cur.to = i; cur.best = Math.max(cur.best, s); } else cur = null;
  });
  if (!passes.length) return { index: null, shares, passes: 0 };
  const distance = (p) => {
    let d = Infinity;
    for (let i = p.from; i <= p.to; i++) if (shares[i] >= NEAR_BEST * p.best) d = Math.min(d, Math.abs(frames[i].t - expect));
    return d;
  };
  const close = passes.filter((p) => distance(p) <= TOLERANCE_S);
  const pass = close.length ? close.reduce((a, b) => (b.best > a.best ? b : a)) : passes.reduce((a, b) => (distance(b) < distance(a) ? b : a));
  let index = pass.from;
  for (let i = pass.from; i <= pass.to; i++) if (shares[i] >= NEAR_BEST * pass.best) index = i;
  // A vehicle drives cab first: while it keeps going forward, the later frames show the bed.
  for (let i = index + 1; i <= pass.to && shares[i] >= TRAILING * pass.best; i++) {
    const moved = (seen[i].x - seen[index].x) * FORWARD[0] + (seen[i].y - seen[index].y) * FORWARD[1];
    if (moved < FORWARD_MIN) break;
    index = i;
  }
  return { index, share: shares[index], t: frames[index].t, shares, passes: passes.length };
}

/** Splits a stream of JPEGs. */
function splitJpegs(buf) {
  const out = [];
  let at = 0;
  for (;;) {
    const s = buf.indexOf(JPEG_START, at);
    if (s < 0) break;
    const e = buf.indexOf(JPEG_END, s + 2);
    if (e < 0) break;
    out.push(buf.subarray(s, e + 2));
    at = e + 2;
  }
  return out;
}

/** Local "YYYYMMDDTHHMMSSZ": the NVR stores local time and labels it Z (see hikvision.js). */
const nvrTime = (ms, tzOffsetMin) => new Date(ms + tzOffsetMin * 60e3).toISOString().slice(0, 19).replace(/[-:]/g, '') + 'Z';

class TopView {
  /**
   * @param {{host: string, user: string, password: string, rtspPort?: number, tzOffsetMin?: number,
   *   ffmpeg?: string, ffprobe?: string, log?: object, source?: (channel: number, startMs: number) => {url: string, args?: string[]}}} o
   *   source: where the recording comes from (tests read a local video file).
   */
  constructor({ host, user, password, rtspPort = 554, tzOffsetMin = 300, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', log = console, source }) {
    this.ffmpeg = ffmpeg;
    this.ffprobe = ffprobe;
    this.log = log;
    const auth = `${encodeURIComponent(user || '')}:${encodeURIComponent(password || '')}`;
    const hostname = host ? new URL(host).hostname : '';
    const rtsp = ['-rtsp_transport', 'tcp', '-timeout', String(SOCKET_TIMEOUT_US)];
    this.source = source || ((channel, startMs) => ({
      url: `rtsp://${auth}@${hostname}:${rtspPort}/Streaming/tracks/${channel}01?starttime=${nvrTime(startMs, tzOffsetMin)}`, args: rtsp,
    }));
    this.running = new Set();
  }

  /** ffmpeg's message without the address and password that are in the URL. */
  static clean(text) {
    return String(text || '').replace(/rtsp:\/\/\S+/g, 'rtsp://…').replace(/\/\/[^\s/@]+@/g, '//').trim().split('\n').pop().slice(0, 200);
  }

  _spawn(cmd, args, stdio) {
    const p = spawn(cmd, args, { stdio });
    this.running.add(p);
    p.once('close', () => this.running.delete(p));
    return p;
  }

  /** Is the recording playable up to this moment yet? */
  ready(channel, atMs) {
    const { url, args = [] } = this.source(channel, atMs);
    return new Promise((resolve) => {
      const p = this._spawn(this.ffprobe, ['-v', 'error', ...args, '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', url], ['ignore', 'ignore', 'ignore']);
      const timer = setTimeout(() => p.kill('SIGKILL'), 30e3);
      p.once('error', () => { clearTimeout(timer); resolve(false); });
      p.once('close', (code) => { clearTimeout(timer); resolve(code === 0); });
    });
  }

  /**
   * Key frames of a stretch of the recording.
   * @returns {Promise<{t: number, small: Uint8Array, jpeg: Buffer}[]>} t: seconds from startMs
   */
  scan(channel, startMs, seconds) {
    const { url, args = [] } = this.source(channel, startMs);
    const filter = `[0:v]split=2[a][b];[a]scale=${W}:${H},format=rgb24[s];[b]scale=${OUT_WIDTH}:-2[l]`;
    const argv = ['-nostdin', '-v', 'error', ...args, '-skip_frame', 'nokey', '-threads', '1', '-t', String(seconds), '-i', url,
      '-an', '-filter_complex', filter,
      '-map', '[s]', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:3',
      '-map', '[l]', '-fps_mode', 'passthrough', '-c:v', 'mjpeg', '-q:v', '3', '-f', 'image2pipe', 'pipe:4'];
    return new Promise((resolve, reject) => {
      const p = this._spawn(this.ffmpeg, argv, ['ignore', 'ignore', 'pipe', 'pipe', 'pipe']);
      const small = [], jpegs = [];
      let err = '';
      const timer = setTimeout(() => p.kill('SIGKILL'), (seconds + 45) * 1000); // reads in real time; any longer means stuck
      p.stderr.on('data', (c) => { err = (err + c).slice(-2000); });
      p.stdio[3].on('data', (c) => small.push(c));
      p.stdio[4].on('data', (c) => jpegs.push(c));
      p.once('error', (e) => { clearTimeout(timer); reject(new Error(e.code === 'ENOENT' ? 'ffmpeg is not installed' : e.code || 'ffmpeg failed')); });
      p.once('close', (code, signal) => {
        clearTimeout(timer);
        const raw = Buffer.concat(small);
        const pics = splitJpegs(Buffer.concat(jpegs));
        const size = W * H * CH;
        const n = Math.min(Math.floor(raw.length / size), pics.length);
        // Whatever arrived before a failure is still usable; nothing at all is the failure.
        if (!n) return reject(new Error(signal ? `ffmpeg stopped (${signal})` : TopView.clean(err) || `ffmpeg exit ${code}`));
        const step = n * KEY_INTERVAL_S >= seconds * 0.8 ? seconds / n : KEY_INTERVAL_S;
        resolve(Array.from({ length: n }, (_, i) => ({ t: i * step, small: raw.subarray(i * size, (i + 1) * size), jpeg: Buffer.from(pics[i]) })));
      });
    });
  }

  /**
   * The picture of the vehicle at a capture.
   * @param {{contextChannel: number, topView: {from: number, to: number, expect: number, lane?: number[][]}}} cam
   * @param {{final?: boolean}} [o]  final: the last try; a short read is used as it is instead of failing
   * @returns {Promise<{jpeg: Buffer, share: number, t: number, frames: number, passes: number} | {jpeg: null, frames: number, passes: 0}>}
   */
  async grab(cam, captureMs, { final = true } = {}) {
    const { from, to, expect = 0, lane } = cam.topView;
    const frames = (await this.scan(cam.contextChannel, captureMs + from * 1000, to - from)).map((f) => ({ ...f, t: f.t + from }));
    if (!final && frames.length < MIN_READ * ((to - from) / KEY_INTERVAL_S)) throw new Error(`short read: ${frames.length} frames`);
    const found = findVehicle(frames, { mask: laneMask(lane), expect });
    if (found.index === null) return { jpeg: null, frames: frames.length, passes: 0 };
    return { jpeg: frames[found.index].jpeg, share: found.share, t: found.t, frames: frames.length, passes: found.passes };
  }

  /** The end of the stretch grab() reads. */
  static windowEnd(cam, captureMs) { return captureMs + cam.topView.to * 1000; }

  /** Stop whatever is running (shutdown). */
  stop() {
    for (const p of this.running) p.kill('SIGKILL');
  }
}

module.exports = { TopView, findVehicle, laneMask, medianBackground, compare, splitJpegs, W, H, CH, MIN_SHARE };
