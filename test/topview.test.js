'use strict';
// Top view: finding the vehicle in a window of frames (the failures seen on real recordings on 5 Nov 2026), reading a
// real video through ffmpeg, and that errors can't leak the NVR's address or password.
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TopView, findVehicle, laneMask, splitJpegs, W, H, CH } = require('../src/cameras/topview');

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
