# Our own plate reader: plan

Status: built and live from 7 Nov 2026, modes A and B together (section 4): the `plate-reader` container
(`reader/`) and `src/cameras/ownreader.js`. Mode C (quiet measuring) was skipped: the cameras' plate pictures
stopped being stored on 6 Nov, so the backup was needed at once. Written 6 Nov 2026.

## Decision (7 Nov 2026)

Measured on the passes of 27 Oct – 6 Nov, which no model was trained on (section 9):

| Reader, after the app's own misread correction | Plates read exactly | Wrong valid plates per 100 passes |
|---|---|---|
| The cameras, as today | 98.1% | 0.78 |
| Our reader alone (the backup case) | 90.4% | 0.26 |
| Cameras, and our reader on the passes they read badly (mode A) | **99.2%** | 0.78 (no new errors) |

- **Pipeline:**
  - **Vehicle:** RF-DETR nano finds the vehicle.
  - **Plate:** the open-image-models YOLOv9 t-384 plate detector looks for the plate inside the vehicle at full resolution. When no vehicle is found, it looks in four zoomed quarters of the picture.
  - **Reading:** fast-plate-ocr `cct-s-v2`, fine-tuned on our own plates.
  - **Rules:** reads below 0.5 confidence are dropped. Every read then goes through the app's plate rules.
- **Global models without fine-tuning are not usable:** the best read 57%. Uzbekistan is not in their training data.
- **General OCR is not usable:**
  - PaddleOCR: 40%.
  - EasyOCR: 2%.
- **The Uzbek model (anpr-uz):** 70%, five wrong plates per 100, and its licence doesn't allow commercial use.
- **Build order unchanged:**
  1. Mode A first: it lifts reads from 98.1% to 99.2% with no new wrong plates.
  2. Then mode B as the backup when the cameras fail.

  Alone, our reader is better than the cameras at the exit (100% by day, 96% at night, against 98% and 94%), but weaker at the entry at night (70%). So it backs the cameras up; it doesn't replace them.
- **To fix during the build:**
  - The vehicle detector is slow on a server processor: about 0.5 s per picture on one core (section 9). Fine for mode A. For mode B, try OpenVINO or INT8 before going live.
  - Retrain the reader every few months with new passes, especially outside trucks.

## 1. Why

The two plate cameras (ANPR-1 at the entry, ANPR-2 at the exit) read plates themselves. The recorder stores each
read with a picture, and the app picks it up. When that chain breaks, the app is blind at the gate.

This happened on 6 Nov 2026. The recorder lost power at 17:22 and was back at 17:25. From then on it rejected every plate
picture (`vcaPicLengthOverFlow` in its log). The pictures themselves did not change: the recorder's own records show
about 1 MB for ANPR-2 and 0.2–0.8 MB for ANPR-1 throughout October. The recorder now refuses sizes it accepted before. In the same hours GPS showed 13 trucks going in or out, and no gate event was recorded for any of them.
Throughout, the cameras kept recording video, and their motion and vehicle detection kept working. Only the plate
pictures failed.

A reader of our own, working from the same cameras, would have kept the gate working. It can also read some of the
plates the cameras miss today.

**Goal:**
1. Backup: the gate keeps working when the cameras' own reading or picture storage fails.
2. Fewer unreadable plates: re-read the passes the camera couldn't read.
3. Later, only if measured better: our reader becomes the main one, or the two are combined.

**Not a goal:** replacing the plate cameras, or reading plates from the overview cameras (Yo'l-1, Yo'l-2). They look
down on the lane, and plates aren't readable from that angle.

## 2. Where we are: 30 days of passes (7 Oct – 6 Nov 2026)

| | Exit (ANPR-2, ch3) | Entry (ANPR-1, ch4) | Total |
|---|---|---|---|
| Passes | 981 | 889 | 1,870 |
| Plate unreadable or malformed | 181 (18%) | 62 (7%) | 243 (13%) |

- **Day and night:** 12% unreadable by day (07–19 h), 16% at night.
- **Kinds of unreadable read:**
  - Mostly no read at all: 179 of the 243.
  - The rest are partial reads with the region missing or letters taken as digits, like `P871110` or `8711A0`.
- **Misreads corrected:** 83 reads were corrected by the app's misread rules (`src/cameras/plates.js`).
- **How passes were matched to a fleet truck:**
  - Exact plate: 593.
  - Near match ("similar", one character off or digits and letters in a different place): 533.
  - Learned alias: 95.
  - 406 valid plates matched no truck (outside vehicles).

So the exit camera is the weak one, and many fleet reads only match because of the similar-plate rules. A second
reader has room to help there.

## 3. What we have to work with

### Cameras and recorder

| Item | What it means for this plan |
|---|---|
| Plate cameras: ANPR-1 (ch4, entry), ANPR-2 (ch3, exit). ANPR-2 is a Hikvision iDS-2CD7A46G0/P-IZHSY | Dedicated plate cameras with infrared at night. Their own capture picture is the best image we can get |
| The recorder stores a capture picture per read (`capture_uri`) | Mode A (section 4) can re-read it. Every one of the 1,870 passes has one |
| Video of ch3 and ch4 is recorded around the clock, main stream only | Mode B can take frames from it. It kept recording through the 6 Nov failure |
| Recordings become playable about 2 min after the fact, in 2-minute steps (measured, `docs/ARCHITECTURE.md` 2a) | Reading from the recording means an alert 2–4 min late. The live stream is faster |
| Key frames every 2 s | A truck crosses the plate camera's view in about 1–3 s. Key frames alone can miss the readable moment, so mode B must decode every frame for a few seconds |
| RTSP on port 554, ISAPI snapshots (`/ISAPI/Streaming/channels/<n>01/picture`) | Both are already used for the top view and the overview snapshot |
| The recorder's event stream also sends motion and vehicle detection events for ch3 and ch4 | These still arrived on 6 Nov, so they can trigger mode B when no capture follows |

### Server

The host has 4 x86-64 cores and 8 GB of memory, with about 2.3 GB free. It's shared with other live sites, and the app's container is
capped at 512 MB. So:
- Run the reader only for passes, never on continuous video.
- Use the processor only; there's no GPU.
- Run it in its own container with its own limits.

The top view already works this way: ffmpeg runs in its own process with a worker limit.

### The app's gate pipeline

The reader slots into what's already there:

- `NVR.searchCaptures()` returns captures, and `Tracker.process(capture, camera)` decides (`src/cameras/tracker.js`). It
  applies the repeat window (20 min), the same-pass window (60 s), and misread correction.
- `Gate.onDecision()` matches the plate to a truck (`matchPlate`: plate links, plate, similar, alias, learned). Then it
  resolves with GPS 90 s later, and sends the alert.
- `gate_events.identified_by` records how a truck was matched; `plate_raw` keeps what the camera read.
- Ground truth for testing: GPS boundary crossings, manual corrections by dispatchers, plate links set by the owner,
  and alias hits.

## 4. How it would work

There are three modes, built in this order. All of them use one reader service.

### The reader service

- **What it is:** a small separate program, probably in Python because the models are, in its own container, reachable only from the
  app on the same machine.
- **Interface:** `POST /read` takes one JPEG and answers `[{plate, confidence, box, chars: [{c, p}]}]`.
  `GET /health` answers whether the model is loaded.
- **Limits:**
  - 1 CPU, about 1 GB of memory.
  - At most 2 reads at a time; the rest wait in a short queue.
  - A read that takes over 10 s is dropped.
- **No outside connections:** the model files are inside the image.
- **Its output is only a suggestion:** the app normalises and validates it with the same code as camera reads
  (`plates.normalize`, `isValid`, `correct`), and matches it the same way.

### Mode A: re-read the camera's own picture

When the camera's read is empty, malformed, or matches no truck, the app sends the capture picture to the reader.

- **Why first:**
  - It's the best image we have, and it's already stored.
  - It costs one read per weak pass, about 40 a day.
  - It goes straight at the 13% that's unreadable.
- **The result goes into the same event:**
  - `plate_own` and `plate_own_conf` hold our reader's answer.
  - `identified_by = 'own'` is set when it is what matched the truck.
  - The camera's read stays in `plate_raw`.

### Mode B: backup when the camera's reading fails

Something passes the gate, but no capture follows within 30 s. The trigger can be any of:
- a vehicle detection or motion event on ch3 or ch4 from the recorder's event stream,
- a GPS boundary crossing,
- a health alert saying the camera is silent, or the recorder is rejecting plate pictures.

Then the app takes frames and reads them:
1. Live, for a fast alert: open the plate camera's RTSP main stream for about 5 s from the trigger. Take every
   frame, keep the 5–10 sharpest that have a plate in them, and read those. A plate read in at least 2 frames wins.
2. If live failed or came too late: the same from the recording, about 2–4 min later. Decode the full window
   (−5…+5 s around the trigger), not key frames only.

The reads become a capture of our own, `{name: 'own_<ch>_<t>', channel, time, plate, source: 'own'}`. It goes
through `Tracker.process()` like a camera capture, so the repeat and same-pass windows still work. If the camera's
capture shows up after all, the same-pass window merges the two instead of making a second event.

Alerts from mode B say so ("O'z modelimiz o'qidi", read by our own model), and show the frame that was read.

### Mode C: read every pass quietly (for measuring)

For two weeks, mode A runs on every pass, not only weak ones, and mode B runs on a sample, about 1 in 5. These
reads change nothing: they are only stored, and a report compares them with the camera and with GPS. That's how we learn whether
our reader is better before relying on it.

### When to switch over

| Situation | What the reader does |
|---|---|
| Normal | Mode A on weak reads only |
| A plate camera silent (health `camera_silent`), or the recorder rejecting plate pictures | Mode B for that camera until captures return |
| Our reader measured better than the camera (after section 6, step 4) | Both read every pass, and the stronger read decides |

A new health check for rejected plate pictures is part of this work. The recorder logs `Exception/vcaPicLengthOverFlow`,
and detections arriving with no capture show the same thing. On 6 Nov that would have given the real reason
within minutes. Today the app only learns of it from "the camera wrote nothing for 90 minutes".

## 5. What to look for in a model (for the research)

### Must have

- **Uzbek plates:** two formats, Latin letters, region codes 01–95 (`src/cameras/plates.js`):
  - private: `01 A 123 BC`
  - company: `01 123 ABC`

  Outside vehicles also bring Kazakh, Russian and other plates. Reading them is a bonus, not a must.
- **Our conditions:** trucks (high cabs), mixers, dirty plates, infrared at night (grey picture), and a slanted view
  from the gate camera.
- **Processor only:**
  - under about 300 ms per picture on one x86 core, detection and reading together,
  - under 500 MB of memory,
  - exportable to ONNX, or otherwise able to run without a GPU.
- **Runs offline:** no cloud calls, because plates and the yard's traffic shouldn't leave the server.
- **A licence that allows use in a commercial product we run.** Check each one: some popular detectors are AGPL, which
  has consequences for a service like ours.
- **A confidence per plate, ideally per character:** we need it to decide between two reads.

### Nice to have

- It can be fine-tuned on our own pictures. After step 2 we'll have about 2,000 labelled passes.
- Detection and reading are separate. Then the detector can also tell us where the plate is in a video frame,
  and pick the sharpest frame.
- It's maintained, with a recent release.

### Kinds of options to compare

| Kind | Examples to look at | Notes |
|---|---|---|
| Open-source two-stage: plate detector + plate OCR | YOLO-family plate detectors; fast-plate-ocr / fast-alpr; PaddleOCR (detection + recognition) | Most flexible, can be fine-tuned. Check each licence and how fast it runs on a processor |
| Older open-source ALPR | OpenALPR | Outdated, AGPL, no Uzbek format. Mainly a baseline |
| Commercial, run on our own server | Plate Recognizer (on-premise SDK) and similar | Usually strongest out of the box, with a yearly fee. Check that it runs fully offline and handles Uzbek plates |
| General vision models | Large OCR or vision-language models | Too heavy for this server, and too slow for live alerts. Only worth it for checking labels offline |

## 6. Steps

Each step ends with something we can look at, and only step 4 onward touches production.

### Step 1: test set (1–2 days)

A script on the Mac, `scripts/plates-dataset.js`, run against a copy of the database and the recorder:
- **Capture pictures:** the camera picture of every pass in the 30 days, 1,870 of them, while the recorder still has them.
  The recorder overwrites old data, so do this first.
- **Video:** 5 s of the plate camera around 200 passes, mixed: day and night, entry and exit, fleet and outside,
  read and unreadable. The 6 Nov evening goes in too, so mode B is tested on exactly the failure we had.
- **Labels:**
  - the plate the app settled on;
  - the matched truck and how it was matched;
  - whether GPS confirmed it.

  The 243 unreadable passes are labelled by hand where the picture allows. GPS often tells which truck it was.
- **Storage:** everything stays outside the repo (`~/plates-dataset/`). The repo is public, and plates and pictures of the yard don't belong there.

### Step 2: offline comparison (2–4 days, after your model research)

Run each candidate model on the test set on the Mac, with the same scoring for all:

| Measure | Why |
|---|---|
| Exact plate accuracy on passes the camera read correctly | Agreement with a known-good read |
| Share of camera-unreadable passes read correctly | The gain of mode A |
| Wrong but valid-looking plates, per 100 passes | The dangerous error: a plausible wrong plate can match the wrong truck. Must stay well under 1 |
| The same on video frames instead of capture pictures | Whether mode B is good enough |
| Day vs night, entry vs exit | Night and the exit camera are the weak spots today |
| Time and memory per picture, on one core | Whether it fits the server |

Before running, we agree on the decision rule. For example:
- **Worth building:** on video frames, at least 90% of fleet trucks read exactly, and fewer than 1 in 100 reads is a wrong valid plate.
- **Main reader:** only if it beats the camera on both measures.

### Step 3: the reader service, quiet mode (3–5 days of work, then 2 weeks of running)

- **Service:** the container from section 4.
- **App side:** `src/cameras/ownreader.js` holds modes A and C, and the frame grabbing for mode B. Frame grabbing reuses
  the ffmpeg process handling of `src/cameras/topview.js`.
- **Database:** new columns on `gate_events`: `plate_own`, `plate_own_conf`, `own_source` (capture | live | recording).
- **Report:** under Settings or Reports, compare the camera's read, our read and the GPS match for every pass.
- **Isolation:** nothing about alerts changes, and if the reader is down, the gate works exactly as today.
- **Tests:**
  - unit tests with a fake reader;
  - e2e with the mock recorder;
  - a throwaway production-image run with `--network none`, as for the top view.

### Step 4: backup live (2–3 days)

- **Switching:** mode B turns on per camera when its health alert says it is silent, or rejecting pictures. Mode A runs on every weak read.
- **Alerts:** they say when our reader made the read.
- **Rehearsal:** we test it by turning the camera's plate reading off for an hour, with you watching.

### Step 5, optional: combine the two readers

Only if step 2 and the quiet weeks show our reader is better on some passes, for example at night at the exit. Then the
two reads are combined per character by confidence, and our pictures are used to fine-tune the model.

## 7. Risks

| Risk | What we do about it |
|---|---|
| Video frames are worse than the camera's capture picture (motion blur, compression, night) | That's why mode A comes first, and why mode B is measured on video in step 2 before we rely on it |
| A wrong but valid plate matches the wrong truck | Our reads go through the same GPS check as camera reads, and reads with low confidence aren't matched. In mode B a plate must be read in at least 2 frames |
| The shared server gets slow | Work happens only per pass, the container has hard limits, there's a queue with a maximum, and it never decodes video continuously |
| The licence doesn't fit | Checked in the research, before step 2 |
| Plates and pictures leaking through the public repo | The test set is never committed, and logs carry no camera URLs or passwords (as today) |
| More to maintain | One service with one model and a health check. It can be switched off with one setting, `OWN_READER=0` |

## 8. Fix on site anyway

These don't need any of the above:
- **Find out why the recorder refuses plate pictures** it accepted before the power cut. The cameras' picture sizes
  did not change: ANPR-2 has sent about 1 MB per picture since October. Check the recorder's picture storage
  settings (quota for pictures, HDD state) and try a clean restart of the recorder. Lowering the cameras' picture
  quality is a workaround, not the fix.
- **A UPS** for the recorder, the cameras and the router.
- **The health check:**
  - Add the rejected-picture check from section 4.
  - Stop "camera silent" from reporting "recovered" when GPS simply saw too few crossings. That's not recovery: it
    happened at 22:01 on 6 Nov while the cameras were still failing.

## 9. Step 2: what was tested (6–7 Nov 2026)

### Test set

- **Pictures:** the full-size capture picture of every pass from 7 Oct to 6 Nov: 1,905 passes. The recorder still had 1,903 of the pictures.
- **Masking:** each picture's text strip, where the camera prints its own read, is cut off before any model sees it.
- **Labels:**
  - **1,503 auto-accepted:** the camera and at least one of our models read the same valid plate. 40 picked at random and checked by eye: 40 correct. One mistake was found later, a plate cut off at the picture edge, and corrected.
  - **400 read by eye,** blind, without the camera's or any model's answer:
    - 139 have a readable plate;
    - 143 have no plate in view. Many SANY mixers have no front plate, and headlights blind the camera at night;
    - 44 show the two-row plate of one regular truck, `10 871 PA`, which the app's plate formats don't cover;
    - 74 aren't readable even by eye, and are left out of the scores.

    These counts are after a recheck: 3 pictures I had marked "no plate" did have one, found by the tile
    detector, and 5 where only the camera saw a plate were moved to "not readable".
- **Split by time:**
  - Train: 7–26 Oct.
  - Test: 27 Oct – 6 Nov, 386 passes, never trained on.
- **Few plates:** only 39 different plates are in the training data, because the fleet repeats. "Unseen" below means plates that never appear in it.
- **Storage:** everything is in `~/plates-dataset/` on the Mac, outside the repo, with the scripts in `tools/`. The training crops are also on the GPU server, in `/root/plates`.

### Out of the box: 1,834 passes with a known answer, camera's raw read (labels before the recheck)

| Reader | Exact | Wrong valid per 100 | Notes |
|---|---|---|---|
| Camera | 94.1% | 0.44 | |
| anpr-uz (Uzbek, TPS-ResNet-BiLSTM) | 70.4% | 5.2 | CC-BY-NC: not usable commercially |
| fast-plate-ocr cct-s-v1 / cct-s-v2, global | 59% / 55–58% | 6.4 / 1.8–2.8 | Uzbekistan not among its 65 regions; misses the region code |
| fast-plate-ocr cct-xs, mobile-vit | 4–53% | | |
| PaddleOCR PP-OCRv5 mobile | 40% | 3.0 | general text OCR |
| EasyOCR | 2% | 2.1 | |

### Plate detection

- **The problem:** plates are 60–200 px wide in a 1920 or 2560 px picture. Shrunk whole to a detector's input, they are often too small.
- **Pictures with a plate box, out of 1,903:**
  - YOLOv9 plate detector on the whole picture: 1,139 (t-384), 1,294 (t-640), 1,309 (s-608).
  - Vehicle first (RF-DETR nano), then the plate detector inside each vehicle at full resolution: 1,624.
  - The same, plus four zoomed quarters when no vehicle is found (dark trucks at night): **1,741**. Chosen.
  - Always the whole picture plus quarters, with no vehicle detector: 1,546 (t-384), 1,585 (t-640). Too weak at the entry gate.

### Fine-tuning (cct-s-v2 from the global weights, on 1,149 real crops; A30 GPU, a few minutes)

Test period, after the app's misread correction (`plates.correct` against plates seen 3+ times before it):

| Reader | Exact | Wrong valid per 100 | Unseen plates | Exit day / night | Entry day / night |
|---|---|---|---|---|---|
| Camera | 98.1% | 0.78 | 32/33 ok, 1 wrong | 98% / 94% | 99% / 98% |
| **cct-s-v2 fine-tuned, real crops** | **90.4%** | **0.26** | 32/33 ok, 0 wrong | **100% / 96%** | 89% / 70% |
| Same + 6,000 synthetic plates | 88.8% | 2.07 | 31/33, 2 wrong | 96% / 94% | 89% / 70% |
| cct-xs-v2 + synthetic | 89.3% | 1.55 | 30/33, 2 wrong | 98% / 96% | 88% / 69% |
| **Camera, with ours on its weak reads (confidence ≥ 0.5)** | **99.2%** | 0.78 | 32/33 | 99% / 98% | 100% / 98% |

- **The synthetic plates made things worse:** more wrong reads. My rendered plates don't match the real font and layout closely enough.
- **xs is not worth it:** the reading step is already a small part of the time. Detection dominates.
- **Without the app's correction, the camera alone reads 93.1%.** Most of its misses are partial reads, like `10834H` or `873HDA`, which the app already snaps to the right truck.
- **Cut-off plates:** a plate cut off at the picture edge can make our reader guess the missing letters. The 0.5 confidence floor removes these.
- **What's left:** at the entry gate at night, the plate is often never found. A plate detector trained on our own pictures is the next step if that matters.

### Speed and memory (one thread, JPEG decode included, median per picture)

| | Decode | Vehicle | Plate | Reading | Total |
|---|---|---|---|---|---|
| Mac M4 Pro | 6 ms | 76 ms | 12 ms | 13 ms | 120 ms |
| AMD EPYC 7542 core, shared and busy host | 20 ms | 484 ms | 55 ms | 44 ms | 659 ms |

- **Memory:** about 420 MB.
- **On production:** expect 0.5–0.8 s per picture on one core of the Xeon at 2.0 GHz.
- **For mode A** (about 40 pictures a day): no problem.
- **For mode B** (5–10 frames per pass): 3–8 s per pass. Acceptable for a backup, but OpenVINO or INT8 for the vehicle detector should be tried first. The research reports about 3× from OpenVINO on Intel.

### Licences to confirm before step 3

- **fast-plate-ocr and open-image-models:** code is MIT. The licence of the pretrained weights is not stated (fast-plate-ocr issue #97, fast-alpr issue #50).
- **Our fine-tuned weights** derive from the fast-plate-ocr global weights.
- **The YOLOv9 plate detector** comes from a GPL-3.0 code line. GPL obligations apply when software is distributed, not when it runs on our own server. Still, confirm with the author or retrain the detector.
- **RF-DETR:** Apache 2.0.
- **anpr-uz:** CC-BY-NC. Excluded.

### Model files

- **Chosen reader:** `~/plates-dataset/models/s_real/s_real.onnx`, with its config `s_real.yaml`. 5 MB.
- **Detectors:** downloaded by open-image-models: `rf-detr-nano-384-coco` and `yolo-v9-t-384-license-plate-end2end`.

## 10. Live from 7 Nov 2026: how it runs and what was measured on production

- **Containers:** `tbb-plate-reader` (`reader/`) beside the app. Model files in `/root/gps-models` on the server, not in git.
- **The app** (`src/cameras/ownreader.js`) asks the reader for new passes every 3 s.
  - A pass waits 45 s for the camera's own capture. If none came, it becomes a gate event through the same tracker,
    matching, GPS check and alerts as a camera capture.
  - `gate_events.read_by` is `own`; the alert says "Raqamni o'z modelimiz videodan o'qidi".
  - A camera capture with an unreadable plate is re-read (`read_by` `own-reread`).
- **Watching:** each plate camera's sub stream (640×480) is decoded at 4 frames a second for motion. While
  something moves, the main stream (2560×1440) is read at 4 frames a second.
  - A plate counts when it is read the same in 2 or more frames, and moves at least 60 px across the picture.
  - Parked vehicles don't count: on recorded passes, plates moved 281 px or more.
- **Speed on production** (4-core Xeon, shared):
  - 0.35 s per read on 2 threads; the vehicle detector is run every 4th frame, which brings frames in between down to about 0.1 s.
  - About 10% of one core and 300 MB while idle; up to about 1 GB with both gates busy (limit 1.5 GB).
- **Check on production with the live code path:** the NVR's recordings of past passes were fed in as if they were the live stream:
  - 11 of 12 passes read right, 0 wrong. That's 9 passes in the main check plus 3 repeated after the last change.
  - The one miss was read right in an earlier run.
  - Unit tests: `test/ownreader.test.js`.
- **Switch it off:** `READER_URL=` in `.env`, then `docker compose up -d app`. The gate then runs on the cameras alone, as before.
