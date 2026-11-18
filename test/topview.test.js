'use strict';
// Top view: finding the vehicle in a window of frames (the failures seen on real recordings on 5 Nov 2026), reading a
// real video through ffmpeg, and that errors can't leak the NVR's address or password.
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { TopView, LiveFrames, findVehicle, laneMask, splitJpegs, takeJpegs, W, H, CH } = require('../src/cameras/topview');

const GREY = [120, 120, 118];
/** A frame: grey road, with `blocks` of colour: {x, y, w, h, c}. */
function frame(blocks = [], base = GREY) {
  const f = new Uint8Array(W * H * CH);
  for (let p = 0; p < W * H; p++) f.set(base, p * CH);
  for (const b of blocks) {
    for (let y = b.y; y < Math.min(H, b.y + b.h); y++) for (let x = b.x; x < Math.min(W, b.x + b.w); x++) f.set(b.c, (y * W + x) * CH);
  }
  return f;
}
const seq = (from, list) => list.map((small, i) => ({ t: from + i * 2, small }));
const empty = () => frame();
const CAB = [230, 110, 40];
const truck = (x, y, c = CAB) => frame([{ x, y, w: 50, h: 40, c }]);
const all = laneMask(null);

test('a truck already in the first frame: the truck is found, not the empty lane', () => {
  // 13:14:59 on 5 Nov: the bed in the first frame, then an empty lane. The old rule compared with the first frame.
  const frames = seq(-2, [truck(40, 40), empty(), empty(), empty(), empty(), empty(), empty(), empty()]);
  const r = findVehicle(frames, { mask: all, expect: 1 });
  assert.equal(r.index, 0);
});

test('nothing passing: nothing is returned, an empty lane is never offered as the vehicle', () => {
  const frames = seq(-16, Array.from({ length: 18 }, empty));
  assert.equal(findVehicle(frames, { mask: all, expect: 1 }).index, null);
});

test('the same picture with different exposure is not a vehicle', () => {
  const frames = seq(-16, Array.from({ length: 18 }, (_, i) => frame([], GREY.map((g) => g + i * 3))));
  assert.equal(findVehicle(frames, { mask: all, expect: 1 }).index, null);
});

test('two trucks in the window: the one nearest the expected moment, not the next one behind', () => {
  // 15:32:00: its truck at about -2 s, the next truck at +14 s. The old rule sent the next truck's cab.
  const frames = seq(-16, [empty(), empty(), empty(), empty(), empty(), empty(), truck(40, 30), truck(30, 40), empty(), empty(), empty(), empty(), empty(), empty(), truck(40, 30, [60, 200, 200]), truck(30, 40, [60, 200, 200]), empty(), empty()]);
  const r = findVehicle(frames, { mask: all, expect: 1 });
  assert.ok(r.t < 0, `picked t=${r.t}`);
  assert.equal(r.passes, 2);
});

test('driving forward: the frame after the cab, where the bed is', () => {
  const frames = seq(-4, [empty(), empty(), truck(100, 10), truck(70, 30), frame([{ x: 30, y: 45, w: 42, h: 30, c: [150, 160, 130] }]), empty(), empty(), empty()]);
  const r = findVehicle(frames, { mask: all, expect: 1 });
  assert.equal(r.index, 4);
});

test('reversing through the picture: the frame near the best stays', () => {
  // A mixer backing away towards the far end: later frames only show it leaving.
  const frames = seq(-4, [empty(), empty(), truck(30, 40), truck(50, 30), truck(90, 12), frame([{ x: 130, y: 0, w: 20, h: 16, c: CAB }]), empty(), empty(), empty()]);
  const r = findVehicle(frames, { mask: all, expect: 1 });
  assert.ok(r.index <= 4, `picked frame ${r.index}`);
});

test('traffic on the public road outside the lane does not count', () => {
  const lane = laneMask([[0, 0.6], [0.46, 0], [0.74, 0], [0.74, 1], [0, 1]]);
  const car = frame([{ x: 2, y: 2, w: 30, h: 20, c: [240, 240, 240] }]);
  const frames = seq(-16, [empty(), empty(), car, empty(), empty(), empty(), empty(), empty()]);
  assert.equal(findVehicle(frames, { mask: lane, expect: 1 }).index, null);
  assert.equal(findVehicle(frames, { mask: all, expect: 1 }).passes, 1, 'without the lane it would have counted');
});

test('a mask leaves out what it should', () => {
  const m = laneMask([[0, 0], [0.5, 0], [0.5, 1], [0, 1]], 10, 10);
  assert.equal(m[0], 1);
  assert.equal(m[9], 0);
  assert.equal(m.reduce((a, b) => a + b, 0), 50);
});

test('JPEG stream is split into pictures', () => {
  const a = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]), b = Buffer.from([0xff, 0xd8, 3, 0xff, 0xd9]);
  assert.deepEqual(splitJpegs(Buffer.concat([a, b])).map((x) => x.length), [6, 5]);
});

test('messages from ffmpeg cannot leak the address or password', () => {
  const m = TopView.clean('[rtsp @ 0x1] Could not open\nrtsp://admin:s3cret%40x@203.0.113.7:554/Streaming/tracks/501?starttime=x: Server returned 400 Bad Request');
  assert.ok(!/s3cret|203\.0|admin/.test(m), m);
  assert.match(m, /400 Bad Request/);
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('ffmpeg: reads a video, key frames only, and finds the vehicle', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topview-'));
  try {
    // 24 s, key frame every 2 s, a block crossing from 10 s to 14 s.
    const video = path.join(dir, 'lane.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=640x360:r=10:d=24', '-vf', "drawbox=x=100:y=100:w=300:h=200:color=orange:t=fill:enable='between(t,10,14)'",
      '-c:v', 'libx264', '-g', '20', '-keyint_min', '20', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', video]);
    const tv = new TopView({ source: () => ({ url: video }) });
    assert.equal(await tv.ready(5, 0), true);
    const cam = { contextChannel: 5, topView: { from: -10, to: 14, expect: 2 } };
    const shot = await tv.grab(cam, Date.now());
    assert.ok(shot.jpeg, 'found the vehicle');
    assert.equal(shot.jpeg[0], 0xff);
    assert.equal(shot.frames, 12);
    assert.ok(shot.t >= 0 && shot.t <= 4, `at t=${shot.t}`);
    const missing = new TopView({ source: () => ({ url: path.join(dir, 'nothing.mp4') }) });
    assert.equal(await missing.ready(5, 0), false);
    await assert.rejects(missing.scan(5, 0, 4));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('no ffmpeg on the machine: a clear error, not a crash', async () => {
  const tv = new TopView({ ffmpeg: '/nonexistent/ffmpeg', ffprobe: '/nonexistent/ffprobe', source: () => ({ url: 'x' }) });
  assert.equal(await tv.ready(5, 0), false);
  await assert.rejects(tv.scan(5, 0, 4), /not installed/);
});

// --- live frames ---------------------------------------------------------------------------------

/** A stand-in for ffmpeg: what the test writes to its pipes is what LiveFrames reads. */
function fakeSpawn() {
  const procs = [];
  const sp = () => {
    const p = new EventEmitter();
    p.stderr = new PassThrough();
    p.stdio = [null, null, p.stderr, new PassThrough(), new PassThrough()];
    p.kill = () => p.emit('close', null, 'SIGKILL');
    procs.push(p);
    return p;
  };
  return { sp, procs };
}
const jpeg = (n) => Buffer.from([0xff, 0xd8, n, n, 0xff, 0xd9]);

test('live frames: each key frame keeps its time, and a window is served only when it is all there', () => {
  const { sp, procs } = fakeSpawn();
  let now = 1_000_000;
  const live = new LiveFrames({ channels: [5], source: () => ({ url: 'x' }), spawn: sp, now: () => now, keepS: 60, log: {} });
  live.start();
  const [p] = procs;
  for (let i = 0; i < 20; i++) { // 40 s, a key frame every 2 s; the pipes deliver in pieces
    const small = Buffer.alloc(W * H * CH, i);
    p.stdio[3].emit('data', small.subarray(0, 1000));
    p.stdio[3].emit('data', small.subarray(1000));
    const j = jpeg(i);
    p.stdio[4].emit('data', j.subarray(0, 3));
    p.stdio[4].emit('data', j.subarray(3));
    now += 2000;
  }
  const t0 = 1_000_000;
  const w = live.window(5, t0 + 10e3, t0 + 20e3);
  assert.deepEqual(w.map((f) => f.at - t0), [10e3, 12e3, 14e3, 16e3, 18e3, 20e3]);
  assert.equal(w[0].jpeg[2], 5, 'the n-th JPEG goes with the n-th small frame');
  assert.equal(w[0].small[0], 5);
  assert.equal(live.window(5, t0 + 30e3, t0 + 50e3), null, 'still coming');
  assert.equal(live.window(5, t0 - 20e3, t0 + 10e3), null, 'older than what is kept');
  assert.equal(live.window(6, t0, t0 + 10e3), null, 'not a live channel');
  now += 120e3; // the next frame arrives two minutes later: what is older than a minute is let go
  p.stdio[3].emit('data', Buffer.alloc(W * H * CH));
  p.stdio[4].emit('data', jpeg(99));
  assert.equal(live.health()[0].frames, 1);
  live.stop();
});

test('live frames: a gap in the middle is not covered', () => {
  const { sp, procs } = fakeSpawn();
  let now = 0;
  const live = new LiveFrames({ channels: [5], source: () => ({ url: 'x' }), spawn: sp, now: () => now, log: {} });
  live.start();
  for (const at of [0, 2, 4, 6, 20, 22, 24, 26]) {
    now = at * 1000;
    procs[0].stdio[3].emit('data', Buffer.alloc(W * H * CH));
    procs[0].stdio[4].emit('data', jpeg(at));
  }
  assert.equal(live.window(5, 0, 26e3), null);
  assert.ok(live.window(5, 20e3, 26e3));
  live.stop();
});

test('live frames: a stream that breaks off is read again', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { sp, procs } = fakeSpawn();
  const warned = [];
  const live = new LiveFrames({ channels: [5, 6], source: () => ({ url: 'x' }), spawn: sp, log: { warn: (m) => warned.push(m), info() {} } });
  live.start();
  assert.equal(procs.length, 2);
  procs[0].stderr.emit('data', 'rtsp://admin:pw@10.0.0.1:554/x: Connection refused');
  procs[0].emit('close', 1, null);
  assert.equal(live.health()[0].running, false);
  assert.ok(!/pw|10\.0/.test(warned[0]), warned[0]);
  t.mock.timers.tick(5000);
  assert.equal(procs.length, 3, 'started again');
  live.stop();
  procs[2].emit('close', null, 'SIGKILL');
  t.mock.timers.tick(60e3);
  assert.equal(procs.length, 3, 'not after stop');
});

test('JPEGs split across pieces of a stream are kept whole', () => {
  const { pics, rest } = takeJpegs(Buffer.concat([jpeg(1), jpeg(2), jpeg(3).subarray(0, 4)]));
  assert.deepEqual(pics.map((p) => p[2]), [1, 2]);
  assert.equal(rest.length, 4);
});

test('grab: the live frames are used when they hold the window, the recording otherwise', async () => {
  const tv = new TopView({ source: () => { throw new Error('no recording'); } });
  const t0 = 5_000_000;
  const frames = [0, 0, 0, 1, 0, 0, 0, 0].map((v, i) => ({ at: t0 - 4000 + i * 2000, small: v ? truck(40, 30) : empty(), jpeg: jpeg(i) }));
  tv.live = { window: (ch, from, to) => frames.filter((f) => f.at >= from && f.at <= to), stop() {} };
  const shot = await tv.grab({ contextChannel: 5, topView: { from: -4, to: 10, expect: 1 } }, t0);
  assert.equal(shot.source, 'live');
  assert.equal(shot.t, 2);
  assert.equal(shot.jpeg[2], 3);
  assert.equal(tv.covers(5, t0, t0 + 1), true);
  tv.live = { window: () => null, stop() {} };
  await assert.rejects(tv.grab({ contextChannel: 5, topView: { from: -4, to: 10, expect: 1 } }, t0), /no recording/);
});

test('ffmpeg: live frames from a stream', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-'));
  try {
    const video = path.join(dir, 'lane.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=640x360:r=10:d=6', '-c:v', 'libx264', '-bf', '0', '-g', '20', '-keyint_min', '20', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', video]);
    const live = new LiveFrames({ channels: [5], source: () => ({ url: video, args: ['-re'] }), log: {} });
    const t0 = Date.now();
    live.start();
    await new Promise((resolve) => { const iv = setInterval(() => { if (!live.health()[0].running && live.cams.get(5).frames.length) { clearInterval(iv); resolve(); } }, 100); });
    live.stop();
    const got = live.window(5, t0, Date.now());
    assert.equal(got.length, 3, 'three key frames in 6 s');
    assert.equal(got[0].jpeg[0], 0xff);
    assert.equal(got[0].small.length, W * H * CH);
    assert.ok(got[2].at - got[0].at >= 3000, 'timed as they came, in real time');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
