"""Tests for the reader's pass decisions and its re-read from the recording (server.py).

    python -m unittest reader/test_server.py

The last test reads a real video with the real models: it runs when READER_MODELS and READER_TEST_VIDEO are set
(a recorded pass of a plate camera), and is skipped otherwise.
"""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import server  # noqa: E402


class FakePasses:
    def __init__(self):
        self.items = []

    def add(self, p):
        self.items.append(p)


def watcher(can_reread=True):
    w = server.Watcher(4, 'rtsp://none', engine=None, passes=FakePasses())
    w.can_reread = can_reread
    return w


def read(plate, conf=0.95, x=1000, y=500, cut=False):
    return {'plate': plate, 'conf': conf, 'det': 0.8, 'box': [x - 100, y - 30, x + 100, y + 30], 'cut': cut}


def frames(w, ps, script, t0=1000.0):
    """script: one list of reads per frame, 4 frames a second."""
    for i, reads in enumerate(script):
        w._count(ps, reads, b'jpg%d' % i, t0 + i / 4)


class Decide(unittest.TestCase):
    def test_a_moving_plate_read_twice_is_a_pass(self):
        w = watcher()
        ps = server.new_pass(1000, 'live')
        frames(w, ps, [[read('85450KBA', y=100)], [], [read('85450KBA', y=400)]])
        w._finish(ps)
        self.assertEqual([p['plate'] for p in w.passes.items], ['85450KBA'])
        self.assertEqual(w.passes.items[0]['votes'], 2)
        self.assertTrue(w.jobs.empty())

    def test_two_trucks_close_behind_each_other_are_two_passes(self):
        w = watcher()
        ps = server.new_pass(1000, 'live')
        frames(w, ps, [[read('85450KBA', y=100)], [read('85450KBA', y=500)], [], [],
                       [read('85159YAA', y=100)], [read('85159YAA', y=600)]])
        w._finish(ps)
        self.assertEqual(sorted(p['plate'] for p in w.passes.items), ['85159YAA', '85450KBA'])

    def test_a_misread_in_the_same_seconds_is_not_a_second_truck(self):
        w = watcher()
        ps = server.new_pass(1000, 'live')
        frames(w, ps, [[read('85450KBA', y=100)], [read('85430KBA', y=300)], [read('85450KBA', y=500)],
                       [read('85430KBA', y=600)], [read('85450KBA', y=700)]])
        w._finish(ps)
        self.assertEqual([p['plate'] for p in w.passes.items], ['85450KBA'])

    def test_a_truck_one_character_apart_at_another_time_is_its_own_pass(self):
        w = watcher()
        ps = server.new_pass(1000, 'live')
        frames(w, ps, [[read('10872HDA', y=100)], [read('10872HDA', y=500)], [], [], [], [], [], [], [],
                       [read('10873HDA', y=100)], [read('10873HDA', y=500)]])
        w._finish(ps)
        self.assertEqual(sorted(p['plate'] for p in w.passes.items), ['10872HDA', '10873HDA'])

    def test_a_parked_plate_is_not_a_pass_and_does_not_ask_for_the_recording(self):
        w = watcher()
        ps = server.new_pass(1000, 'live')
        frames(w, ps, [[read('10842HDA')], [read('10842HDA')], [read('10842HDA')]])
        w._finish(ps)
        self.assertEqual(w.passes.items, [])
        ps = server.new_pass(1100, 'live')  # later: the same truck still standing there, read once (and misread once)
        frames(w, ps, [[read('10842HDA')], [read('10843HDA', conf=0.3)]])
        w._finish(ps)
        self.assertTrue(w.jobs.empty())

    def test_a_plate_read_once_asks_for_the_recording(self):
        w = watcher()
        ps = server.new_pass(1000, 'live')
        ps['last'] = 1003
        frames(w, ps, [[], [read('85159YAA')], [read('85150VAA', conf=0.4)]])
        w._finish(ps)
        self.assertEqual(w.passes.items, [])
        self.assertEqual(w.jobs.get_nowait(), {'start': 1000, 'end': 1003, 'live': 3})

    def test_a_weak_plate_seen_only_at_low_confidence_asks_for_the_recording_too(self):
        w = watcher()
        ps = server.new_pass(1000, 'live')
        frames(w, ps, [[read('85159YAA', conf=0.3)], []])
        w._finish(ps)
        self.assertFalse(w.jobs.empty())

    def test_nothing_plate_like_does_not_ask_for_the_recording(self):
        w = watcher()
        ps = server.new_pass(1000, 'live')
        frames(w, ps, [[read('111111', conf=0.6)], [read('85159YAA', cut=True)], []])
        w._finish(ps)
        self.assertTrue(w.jobs.empty())

    def test_without_a_recording_there_is_no_re_read(self):
        w = watcher(can_reread=False)
        ps = server.new_pass(1000, 'live')
        frames(w, ps, [[read('85159YAA')]])
        w._finish(ps)
        self.assertTrue(w.jobs.empty())

    def test_a_pass_from_the_recording_is_reported_with_its_source(self):
        w = watcher()
        ps = server.new_pass(1000, 'recording')
        frames(w, ps, [[read('85159YAA', y=100)], [read('85159YAA', y=500)]])
        w._finish(ps)
        self.assertEqual(w.passes.items[0]['source'], 'recording')
        self.assertEqual(w.stats['rereads_found'], 1)
        ps = server.new_pass(1000, 'recording')
        frames(w, ps, [[read('85159YAA', y=100)]])
        w._finish(ps)
        self.assertEqual(len(w.passes.items), 1)
        self.assertTrue(w.jobs.empty(), 'a recording is never read again')

    def test_similar(self):
        self.assertTrue(server.similar('85450KBA', '85430KBA'))
        self.assertTrue(server.similar('85159YAA', '5159YAA'))
        self.assertFalse(server.similar('85450KBA', '85159YAA'))


@unittest.skipUnless(os.environ.get('READER_MODELS') and os.environ.get('READER_TEST_VIDEO'), 'needs the models and a video')
class Recording(unittest.TestCase):
    def test_a_pass_missed_live_is_read_from_the_recording(self):
        os.environ['READER_TEST_REC_4'] = os.environ['READER_TEST_VIDEO']
        w = server.Watcher(4, 'rtsp://none', server.Engine(), FakePasses())
        t = time.time()
        ps = w._read_recording({'start': t, 'end': t + 5, 'live': 1})
        w._finish(ps)
        self.assertTrue(w.passes.items, f'votes: {dict(ps["votes"])}')
        print('read from the video:', [(p['plate'], p['votes'], p['frames']) for p in w.passes.items])


if __name__ == '__main__':
    unittest.main()
