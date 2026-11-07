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
  - A pass is done when nothing has moved for a few seconds. Every plate read the same in 2 frames or more, with
    confidence >= MIN_CONF and not cut off at the picture edge, that moved across the picture is reported (a parked
    vehicle read while a person walked by is not a pass; two trucks close behind each other are two). The best frame
    goes with each.
  - The main stream needs about 1.5 s to give its first frame after motion starts, and an entering truck crosses the
    picture in about 2.5 s: live reading can miss most of it (7 Nov 2026). So when a pass ends with a plate seen but
    not reported, the same seconds are read again from the NVR's recording, from PRE_S before the motion. The NVR
    serves a recording only about a minute later, so such a pass reaches the app 1.5-2 minutes after it happened.

Runs only on the app's private network; the RTSP address and password are never logged.
"""
import base64
import json
import logging
import os
import queue
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
MOTION_SHARE = float(os.environ.get('READER_MOTION_SHARE', '0.01'))  # share of pixels that changed; real passes: 2.5-99%
QUIET_S = 3.0           # a pass ends after this long without motion
REUSE_FRAMES = 4        # vehicle boxes are reused for this many frames (1 s at 4 frames a second)
# A plate must move this far across the picture during the pass. Measured on 36 recorded passes (6 Nov 2026): every
# one moved 281 px or more; a parked vehicle's plate stays within a few px.
MIN_MOVE_PX = 60
MAX_PASS_S = 40.0       # a vehicle standing in view: close the pass, start again if it still moves
PRE_S = 4.0             # a re-read from the recording starts this long before the motion was seen
# The NVR serves a recording about a minute after (7 Nov 2026: 40 s back was refused with 400, 60 s back worked).
REC_DELAY_S = float(os.environ.get('READER_REC_DELAY', '60'))
REC_TRIES = 6           # 15 s apart: the recording may not be there yet
PARKED_S = 1800         # a plate seen standing still does not ask for a re-read for this long
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


def jpegs(stream):
    """JPEG frames from an ffmpeg image2pipe stream, as they come."""
    buf = b''
    while True:
        chunk = stream.read(65536)
        if not chunk:
            return
        buf += chunk
        while True:
            a = buf.find(b'\xff\xd8')
            b = buf.find(b'\xff\xd9', a + 2)
            if a < 0 or b < 0:
                break
            yield buf[a:b + 2]
            buf = buf[b + 2:]


def similar(a, b):
    """At most 2 characters apart (edit distance): a misread of the same plate, or a truck with a near number."""
    if abs(len(a) - len(b)) > 2:
        return False
    row = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        prev, row[0] = row[0], i
        for j, cb in enumerate(b, 1):
            prev, row[j] = row[j], min(row[j] + 1, row[j - 1] + 1, prev + (ca != cb))
    return row[-1] <= 2


def new_pass(start, source):
    return {'start': start, 'last': start, 'source': source, 'votes': Counter(), 'best': {}, 'at': {}, 'frames': 0,
            'seen': set(), 'stop': threading.Event(), 'reader_done': threading.Event()}


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
        log.info('pass ch%s %s x%d (%d frames read%s)', p['channel'], p['plate'], p['votes'], p['frames'],
                 ', from the recording' if p.get('source') == 'recording' else '')

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
        # READER_TEST_SUB_<ch> / _MAIN_<ch> / _REC_<ch>: video files instead of the camera and its recording (tests).
        self.sub_url = os.environ.get(f'READER_TEST_SUB_{channel}') or f'{base_url}/Streaming/Channels/{channel}02'
        self.main_url = os.environ.get(f'READER_TEST_MAIN_{channel}') or f'{base_url}/Streaming/Channels/{channel}01'
        self.test_rec = os.environ.get(f'READER_TEST_REC_{channel}')
        self.base_url = base_url
        self.can_reread = bool(self.test_rec) or base_url.startswith('rtsp://') and not os.environ.get(f'READER_TEST_MAIN_{channel}')
        self.engine = engine
        self.passes = passes
        self.state = 'starting'
        self.error = None
        self.last_frame = None
        self.motion_until = 0.0
        self.pass_ = None
        self.lock = threading.Lock()
        self.jobs = queue.Queue(maxsize=3)
        self.parked = {}  # plate -> when it was last read standing still
        self.stats = Counter()

    # --- motion on the sub stream ---------------------------------------------------------------
    def run(self):
        threading.Thread(target=self._rereader, daemon=True, name=f'rec-ch{self.channel}').start()
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
                self.pass_ = new_pass(now, 'live')
                threading.Thread(target=self._read_main, args=(self.pass_,), daemon=True, name=f'main-ch{self.channel}').start()
            self.pass_['last'] = now

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

    # --- reading -----------------------------------------------------------------------------------
    def _read_frame(self, st, img):
        """Plate reads in one frame. The vehicle detector is most of a read: its boxes are reused for a few frames,
        and found again at once when the reused boxes show no plate."""
        if st.get('vehicles') is None or st['reuse'] >= REUSE_FRAMES:
            st['vehicles'], st['reuse'] = self.engine.vehicles(img), 0
        reads, _ = self.engine.read(img, st['vehicles'])  # [] (no vehicle): whole frame and quarters
        st['reuse'] += 1
        if not any(r['conf'] >= MIN_CONF for r in reads):
            st['vehicles'] = None
        return reads

    @staticmethod
    def _count(ps, reads, jpg, t):
        ps['frames'] += 1
        for r in reads:
            if r['cut'] or not valid(r['plate']):
                continue
            ps['seen'].add(r['plate'])  # any confidence: a plate was in view
            if r['conf'] < MIN_CONF:
                continue
            ps['votes'][r['plate']] += 1
            b = r['box']
            ps['at'].setdefault(r['plate'], []).append(((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, t))
            best = ps['best'].get(r['plate'])
            if best is None or r['conf'] > best['conf']:
                ps['best'][r['plate']] = {'conf': r['conf'], 'jpg': jpg, 't': t}

    def _read_main(self, ps):
        """While something moves: the newest main-stream frame, whenever the reader is free (it never falls behind)."""
        p = ffmpeg(self.main_url, f'fps={FPS}', 'image2pipe', ['-c:v', 'mjpeg', '-q:v', '3'])
        latest = {'jpg': None, 't': 0.0}
        done = threading.Event()

        def pump():
            for jpg in jpegs(p.stdout):
                if done.is_set():
                    break
                latest['jpg'], latest['t'] = jpg, time.time()
        threading.Thread(target=pump, daemon=True).start()
        try:
            seen, st = 0.0, {}
            while not ps['stop'].is_set():
                if latest['t'] <= seen:
                    time.sleep(0.05)
                    continue
                jpg, seen = latest['jpg'], latest['t']
                img = cv2.imdecode(np.frombuffer(jpg, np.uint8), cv2.IMREAD_COLOR)
                if img is not None:
                    self._count(ps, self._read_frame(st, img), jpg, seen)
        finally:
            done.set()
            p.kill()
            ps['reader_done'].set()

    # --- deciding ----------------------------------------------------------------------------------
    def _decide(self, ps):
        """The plates of a pass: read the same in MIN_VOTES frames or more and moved across the picture. A plate a
        few characters from a stronger one, read in the same seconds, is a misread of it and is skipped; one read at
        other times is another truck (fleet numbers can be one character apart)."""
        found, weak, strong = [], [], []
        for plate, votes in ps['votes'].most_common():
            ts = [a[2] for a in ps['at'][plate]]
            if any(similar(plate, q) and min(ts) >= t0 - 1 and max(ts) <= t1 + 1 for q, t0, t1 in strong):
                continue
            if votes < MIN_VOTES:
                weak.append(f'{plate} x{votes}')
                continue
            strong.append((plate, min(ts), max(ts)))
            at = ps['at'][plate]
            moved = max(((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5 for a in at for b in at)
            if moved < MIN_MOVE_PX:
                # Something else moved (a person, a light), and a standing vehicle's plate was read: not a pass.
                log.info('ch%s: %s did not move (%d px), not reported', self.channel, plate, moved)
                self.parked[plate] = time.time()
                continue
            found.append(plate)
        return found, weak

    def _finish(self, ps):
        found, weak = self._decide(ps)
        rec = ps['source'] == 'recording'
        for plate in found:
            b = ps['best'][plate]
            others = {k: v for k, v in ps['votes'].items() if k != plate}
            self.stats['passes_recording' if rec else 'passes_live'] += 1
            self.passes.add({'channel': self.channel, 'time': int(b['t'] * 1000), 'plate': plate, 'conf': b['conf'],
                             'votes': ps['votes'][plate], 'frames': ps['frames'], 'others': others, 'source': ps['source'],
                             'jpeg': base64.b64encode(b['jpg']).decode()})
        if rec:
            self.stats['rereads_found' if found else 'rereads_empty'] += 1
            if not found:
                log.info('ch%s: recording %s: no plate read twice (%s)', self.channel, time.strftime('%H:%M:%S', time.localtime(ps['start'])),
                         ', '.join(weak) or f'{ps["frames"]} frames')
            return
        now = time.time()
        # A plate in view that wasn't reported, and isn't one standing in the yard: read the recording of these seconds.
        parked = [q for q, t in self.parked.items() if now - t < PARKED_S]
        open_ = [p for p in ps['seen'] if not any(similar(p, q) for q in found + parked)]
        if weak:
            log.info('ch%s: %s read too few times in %d frames, not reported%s', self.channel, ', '.join(weak), ps['frames'],
                     '; reading the recording' if open_ and self.can_reread else '')
        if open_ and self.can_reread:
            try:
                self.jobs.put_nowait({'start': ps['start'], 'end': ps['last'], 'live': ps['frames']})
            except queue.Full:
                self.stats['rereads_skipped'] += 1
                log.warning('ch%s: too many recordings waiting, this one is not read', self.channel)

    # --- reading the recording ---------------------------------------------------------------------
    def _rereader(self):
        while True:
            job = self.jobs.get()
            wait = job['end'] + REC_DELAY_S - time.time()
            if wait > 0:
                time.sleep(wait)
            self.stats['rereads'] += 1
            try:
                ps = self._read_recording(job)
            except Exception as e:  # noqa: BLE001 - one recording lost, the next one is tried
                self.stats['rereads_failed'] += 1
                log.warning('ch%s: recording of %s not read: %s', self.channel,
                            time.strftime('%H:%M:%S', time.localtime(job['start'])), clean(e))
                continue
            self._finish(ps)

    def _read_recording(self, job):
        start = job['start'] - PRE_S
        dur = min(job['end'] - start + 1.5, MAX_PASS_S + PRE_S + 2)
        clip = f'/tmp/rec_ch{self.channel}.mkv'
        if self.test_rec:
            clip = self.test_rec
        else:
            url = f"{self.base_url}/Streaming/tracks/{self.channel}01?starttime={time.strftime('%Y%m%dT%H%M%S', time.localtime(start))}Z"
            for i in range(REC_TRIES):
                r = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-rtsp_transport', 'tcp', '-timeout', '10000000',
                                    '-i', url, '-an', '-c', 'copy', '-t', f'{dur:.1f}', '-y', clip],
                                   capture_output=True, text=True, timeout=dur + 60)
                if r.returncode == 0 and os.path.exists(clip) and os.path.getsize(clip) > 0:
                    break
                if i == REC_TRIES - 1 or '400' not in r.stderr:  # 400: not in the recording yet
                    raise RuntimeError(r.stderr.strip() or f'ffmpeg exit {r.returncode}')
                time.sleep(15)
        ps = new_pass(job['start'], 'recording')
        p = subprocess.Popen(['ffmpeg', '-nostdin', '-v', 'error', '-threads', '1', '-i', clip, '-an', '-vf', f'fps={FPS}',
                              '-c:v', 'mjpeg', '-q:v', '3', '-f', 'image2pipe', '-'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            st = {}
            for i, jpg in enumerate(jpegs(p.stdout)):
                img = cv2.imdecode(np.frombuffer(jpg, np.uint8), cv2.IMREAD_COLOR)
                if img is not None:
                    self._count(ps, self._read_frame(st, img), jpg, start + i / FPS)
        finally:
            p.kill()
            if not self.test_rec:
                try:
                    os.remove(clip)
                except OSError:
                    pass
        return ps


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
                                        'watchers': {w.channel: {'state': w.state, 'error': w.error, 'last_frame': w.last_frame,
                                                                 **w.stats} for w in watchers}})
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
