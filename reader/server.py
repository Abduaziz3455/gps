"""Plate reader service: our own plate reading next to the cameras' (docs/plate-recognition-plan.md).

  POST /read          a JPEG in the body -> {"reads": [{plate, conf, det, box, cut}], "ms": n}     (mode A)
  GET  /passes?after= vehicles our reader saw on the plate cameras' live video, oldest first      (mode B)
  GET  /health        {"ok": true, "watchers": {...}}

Mode B, per plate camera:
  - The camera's sub stream is decoded all the time at 4 frames a second, 160x90 grey: a few % of one core. It
    only tells when something moves in the picture.
  - While something moves, the main stream (2560x1440) is decoded too, 4 frames a second, and the newest frame is
    read whenever the reader is free. Measured on recorded passes (6 Nov 2026): at 4 frames a second our reader got
    36 of 39 plates right and none wrong, when a plate had to be read the same in 2 frames or more.
  - A pass is done when nothing has moved for a few seconds. Its plate is the one read most often, in 2 frames or
    more, with confidence >= MIN_CONF and not cut off at the picture edge. The best frame goes with it.

Runs only on the app's private network; the RTSP address and password are never logged.
"""
import base64
import json
import logging
import os
import re
import subprocess
import threading
import time
from collections import Counter, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlparse

import cv2
import numpy as np

import pipeline

log = logging.getLogger('reader')
MIN_CONF = float(os.environ.get('READER_MIN_CONF', '0.5'))
MIN_VOTES = int(os.environ.get('READER_MIN_VOTES', '2'))
FPS = 4
MOTION_W, MOTION_H = 160, 90
MOTION_SHARE = float(os.environ.get('READER_MOTION_SHARE', '0.02'))  # share of pixels that changed
QUIET_S = 3.0           # a pass ends after this long without motion
REUSE_FRAMES = 4        # vehicle boxes are reused for this many frames (1 s at 4 frames a second)
MAX_PASS_S = 40.0       # a vehicle standing in view: close the pass, start again if it still moves
FORMATS = [re.compile(r'^(\d{2})[A-Z]\d{3}[A-Z]{2}$'), re.compile(r'^(\d{2})\d{3}[A-Z]{3}$')]
REGIONS = {'01', '10', '20', '25', '30', '40', '50', '60', '70', '75', '80', '85', '90', '95'}


def valid(p):
    for f in FORMATS:
        m = f.match(p or '')
        if m:
            return m.group(1) in REGIONS
    return False


def clean(text):
    """ffmpeg's message without the RTSP address (it holds the password)."""
    return re.sub(r'rtsp://\S+', 'rtsp://…', str(text or ''))[-300:]


class Engine:
    """One model set, one read at a time: the server is shared, reads queue instead of running side by side."""

    def __init__(self):
        self.reader = pipeline.Reader(threads=int(os.environ.get('READER_THREADS', '1')))
        self.lock = threading.Lock()
        self.reads = 0
        self.ms = deque(maxlen=200)

    def read(self, img, vehicles=None):
        with self.lock:
            t0 = time.perf_counter()
            out = self.reader.read(pipeline.scene(img), vehicles)
            ms = (time.perf_counter() - t0) * 1000
            self.reads += 1
            self.ms.append(ms)
            return out, ms

    def vehicles(self, img):
        """Vehicle boxes, grown 15% each way: in a quarter of a second the vehicle moves on a little."""
        with self.lock:
            img = pipeline.scene(img)
            H, W = img.shape[:2]
            out = []
            for x1, y1, x2, y2 in self.reader.vehicles(img):
                dx, dy = (x2 - x1) * 0.15, (y2 - y1) * 0.15
                out.append([max(0, x1 - dx), max(0, y1 - dy), min(W, x2 + dx), min(H, y2 + dy)])
            return out


class Passes:
    def __init__(self, keep=300):
        self.items = deque(maxlen=keep)
        self.seq = 0
        self.boot = os.urandom(6).hex()  # new on every start: the app knows the numbering started again
        self.lock = threading.Lock()

    def add(self, p):
        with self.lock:
            self.seq += 1
            p['seq'] = self.seq
            self.items.append(p)
        log.info('pass ch%s %s x%d (%d frames read)', p['channel'], p['plate'], p['votes'], p['frames'])

    def after(self, seq):
        with self.lock:
            return [p for p in self.items if p['seq'] > seq]


def ffmpeg(url, vf, fmt, extra=()):
    # A file instead of a camera (tests): read it at its own speed, like a live stream.
    src = ['-rtsp_transport', 'tcp', '-timeout', '10000000'] if url.startswith('rtsp://') else ['-re']
    return subprocess.Popen(
        ['ffmpeg', '-nostdin', '-v', 'error', *src, '-threads', '1', '-i', url, '-an', '-vf', vf, *extra, '-f', fmt, '-'],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)


class Watcher(threading.Thread):
    def __init__(self, channel, base_url, engine, passes):
        super().__init__(daemon=True, name=f'watch-ch{channel}')
        self.channel = channel
        # READER_TEST_SUB_<ch> / READER_TEST_MAIN_<ch>: video files instead of the camera (tests only).
        self.sub_url = os.environ.get(f'READER_TEST_SUB_{channel}') or f'{base_url}/Streaming/Channels/{channel}02'
        self.main_url = os.environ.get(f'READER_TEST_MAIN_{channel}') or f'{base_url}/Streaming/Channels/{channel}01'
        self.engine = engine
        self.passes = passes
        self.state = 'starting'
        self.error = None
        self.last_frame = None
        self.motion_until = 0.0
        self.pass_ = None
        self.lock = threading.Lock()

    # --- motion on the sub stream ---------------------------------------------------------------
    def run(self):
        while True:
            try:
                self._watch_sub()
            except Exception as e:  # noqa: BLE001 - keep watching whatever happened
                self.error = clean(e)
            self._close_now()  # a pass open when the stream dropped still gets reported
            self.state = 'reconnecting'
            time.sleep(5)

    def _watch_sub(self):
        p = ffmpeg(self.sub_url, f'fps={FPS},scale={MOTION_W}:{MOTION_H}', 'rawvideo', ['-pix_fmt', 'gray'])
        size = MOTION_W * MOTION_H
        prev = None
        try:
            while True:
                buf = p.stdout.read(size)
                if not buf or len(buf) < size:
                    raise RuntimeError(f'sub stream ended: {clean(p.stderr.read())}')
                self.state = 'watching'
                self.error = None
                self.last_frame = time.time()
                f = cv2.GaussianBlur(np.frombuffer(buf, np.uint8).reshape(MOTION_H, MOTION_W), (5, 5), 0)
                if prev is not None:
                    changed = float((cv2.absdiff(f, prev) > 18).mean())
                    if changed > MOTION_SHARE:
                        self._moved()
                prev = f
                self._maybe_close()
        finally:
            p.kill()

    def _moved(self):
        now = time.time()
        self.motion_until = now + QUIET_S
        with self.lock:
            if self.pass_ is None:
                self.pass_ = {'start': now, 'votes': Counter(), 'best': {}, 'frames': 0, 'stop': threading.Event(),
                              'reader_done': threading.Event()}
                threading.Thread(target=self._read_main, args=(self.pass_,), daemon=True, name=f'main-ch{self.channel}').start()

    def _close_now(self):
        with self.lock:
            ps, self.pass_ = self.pass_, None
        if ps is not None:
            ps['stop'].set()
            ps['reader_done'].wait(15)  # the frame being read still counts
            self._finish(ps)

    def _maybe_close(self):
        now = time.time()
        with self.lock:
            ps = self.pass_
            if ps is None or (now < self.motion_until and now - ps['start'] < MAX_PASS_S):
                return
            self.pass_ = None
        ps['stop'].set()
        threading.Thread(target=lambda: (ps['reader_done'].wait(15), self._finish(ps)), daemon=True).start()

    # --- reading the main stream while something moves -------------------------------------------
    def _read_main(self, ps):
        p = ffmpeg(self.main_url, f'fps={FPS}', 'image2pipe', ['-c:v', 'mjpeg', '-q:v', '3'])
        latest = {'jpg': None, 't': 0.0}
        done = threading.Event()

        def pump():  # keep only the newest frame: the reader takes what it can, it never falls behind
            buf = b''
            while not done.is_set():
                chunk = p.stdout.read(65536)
                if not chunk:
                    break
                buf += chunk
                while True:
                    s = buf.find(b'\xff\xd8')
                    e = buf.find(b'\xff\xd9', s + 2)
                    if s < 0 or e < 0:
                        break
                    latest['jpg'], latest['t'] = buf[s:e + 2], time.time()
                    buf = buf[e + 2:]
        threading.Thread(target=pump, daemon=True).start()
        try:
            seen = 0.0
            vehicles, reuse = None, 0
            while not ps['stop'].is_set():
                if latest['t'] <= seen:
                    time.sleep(0.05)
                    continue
                jpg, seen = latest['jpg'], latest['t']
                img = cv2.imdecode(np.frombuffer(jpg, np.uint8), cv2.IMREAD_COLOR)
                if img is None:
                    continue
                # The vehicle detector is most of a read: run it every few frames and reuse its boxes in between,
                # and at once again when the reused boxes show no plate.
                if vehicles is None or reuse >= REUSE_FRAMES:
                    vehicles, reuse = self.engine.vehicles(img), 0
                reads, _ = self.engine.read(img, vehicles)  # [] (no vehicle): whole frame and quarters
                reuse += 1
                if not any(r['conf'] >= MIN_CONF for r in reads):
                    vehicles = None
                ps['frames'] += 1
                for r in reads:
                    if r['conf'] >= MIN_CONF and not r['cut'] and valid(r['plate']):
                        ps['votes'][r['plate']] += 1
                        b = ps['best'].get(r['plate'])
                        if b is None or r['conf'] > b['conf']:
                            ps['best'][r['plate']] = {'conf': r['conf'], 'jpg': jpg, 't': seen}
        finally:
            done.set()
            p.kill()
            ps['reader_done'].set()

    def _finish(self, ps):
        if not ps['votes']:
            return
        plate, votes = ps['votes'].most_common(1)[0]
        if votes < MIN_VOTES:
            log.info('ch%s: %s read only %d time(s) in %d frames, not reported', self.channel, plate, votes, ps['frames'])
            return
        b = ps['best'][plate]
        others = {k: v for k, v in ps['votes'].items() if k != plate}
        self.passes.add({'channel': self.channel, 'time': int(b['t'] * 1000), 'plate': plate, 'conf': b['conf'],
                         'votes': votes, 'frames': ps['frames'], 'others': others,
                         'jpeg': base64.b64encode(b['jpg']).decode()})


def base_url():
    from urllib.parse import urlparse as up
    host = up(os.environ['NVR_HOST']).hostname
    auth = f"{quote(os.environ.get('NVR_USER', 'admin'), safe='')}:{quote(os.environ.get('NVR_PASSWORD', ''), safe='')}"
    return f"rtsp://{auth}@{host}:{os.environ.get('NVR_RTSP_PORT', '554')}"


def make_handler(engine, passes, watchers):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, obj):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            u = urlparse(self.path)
            if u.path == '/health':
                ms = sorted(engine.ms)
                return self._send(200, {'ok': True, 'reads': engine.reads, 'median_ms': round(ms[len(ms) // 2]) if ms else None,
                                        'watchers': {w.channel: {'state': w.state, 'error': w.error,
                                                                 'last_frame': w.last_frame} for w in watchers}})
            if u.path == '/passes':
                after = int((parse_qs(u.query).get('after') or ['0'])[0])
                return self._send(200, {'boot': passes.boot, 'seq': passes.seq, 'passes': passes.after(after)})
            self._send(404, {'error': 'not found'})

        def do_POST(self):
            if urlparse(self.path).path != '/read':
                return self._send(404, {'error': 'not found'})
            n = int(self.headers.get('Content-Length') or 0)
            if not 0 < n <= 8 << 20:
                return self._send(400, {'error': 'send one JPEG, at most 8 MB'})
            try:
                img = pipeline.decode(self.rfile.read(n))
            except ValueError as e:
                return self._send(400, {'error': str(e)})
            reads, ms = engine.read(img)
            self._send(200, {'reads': reads, 'ms': round(ms)})
    return H


def main():
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    engine = Engine()
    passes = Passes()
    channels = [int(c) for c in os.environ.get('READER_CHANNELS', '').split(',') if c.strip()]
    watchers = []
    if channels and (os.environ.get('NVR_HOST') or os.environ.get(f'READER_TEST_SUB_{channels[0]}')):
        url = base_url() if os.environ.get('NVR_HOST') else 'rtsp://none'
        for ch in channels:
            w = Watcher(ch, url, engine, passes)
            w.start()
            watchers.append(w)
    port = int(os.environ.get('READER_PORT', '8091'))
    log.info('plate reader on :%d, watching channels %s', port, channels or 'none')
    ThreadingHTTPServer(('0.0.0.0', port), make_handler(engine, passes, watchers)).serve_forever()


if __name__ == '__main__':
    main()
