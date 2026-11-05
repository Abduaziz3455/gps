# Site survey: cameras, recognition quality, in/out accuracy

Survey dates: 9–12 Oct 2026. All numbers come from the NVR's stored ANPR captures,
**9 Oct 00:00 – 12 Oct 11:55 (≈3.5 days, 264 captures)**. Each capture was replayed through the
notifier's own logic, and individual capture images were checked by eye.

## 1. NVR and cameras

NVR: Hikvision **DS-7716NXI-K4** (16-channel AcuSense), firmware V4.83.013. It has 12 IP cameras
on its internal 192.168.88.x network, all online. ISAPI (HTTP digest auth) is reachable on the NVR's
web port, and RTSP on 554.

| Ch | Name | Model | Use for vehicle tracking |
|---|---|---|---|
| 4 | **ANPR-1** | iDS-2CD7A46G0/P-IZHSY (ANPR) | **Yes, entry plates.** Close-up of the entry lane. |
| 3 | **ANPR-2** | iDS-2CD7A46G0/P-IZHSY (ANPR) | **Yes, exit plates.** Faces vehicles leaving the yard. |
| 5 | **Yo'l-2** | DS-2CD1047G3H-LIU | Context: **wide view of the same lane as ANPR-1** |
| 6 | **Yo'l-1** | DS-2CD1047G3H-LIU | Context: **wide view of the same yard area as ANPR-2** |
| 8 | Beton nasos | DS-2CD1043G2-LIU | Second angle on the ANPR-2 / Yo'l-1 area (batching plant). Not used. |
| 10 | PTZ | DS-2DE4225IW-DE | Parked mixer fleet. It can move, so it is unreliable for fixed rules. Not used. |
| 1 | LABORATORIYA | IPC-C340 | Indoor lab. No. |
| 2 | PTZ-SHEBIN | DS-2DE4415IW-DE | Gravel/loader area. No. |
| 7, 9, 12 | XOVLI 2, XOVLI 1, Xovli3 | DS-2CD2043G2 / 1043G2 | Storage yards, loader. No. |
| 11 | ORQA TARAF | DS-2CD1023G0E-I | View blocked by tree branches. No. |

**The pairing is ANPR-1 ↔ Yo'l-2 and ANPR-2 ↔ Yo'l-1, not the reverse.** Simultaneous snapshots
show it:
- ANPR-1 and Yo'l-2 both show the lane between the high concrete wall (left) and the plant's stair
  grating (right). Yo'l-2 shows its full length.
- ANPR-2 and Yo'l-1 both show the yard under the batching plant, with the same trucks in frame at
  the same moment.

Both ANPR cameras face oncoming traffic, so they photograph the **front** plate.

## 2. Direction: which camera means "in" and which means "out"

The camera captures show a consistent pattern. A plate is read by **ANPR-1 first and by ANPR-2
about 5–20 minutes later**, which matches the mixer cycle (arrive, load, leave). Examples:

```
85450KBA  in 08:13 → out 08:21   in 13:29 → out 13:39   in 15:26 → out 15:34
10835HDA  in 14:31 → out 14:50   in 16:43 → out 17:46
```

So **ANPR-1 = entry and ANPR-2 = exit**. Over the survey period, time inside was minimum 5 min,
median 12 min, maximum 92 min. No implausible stays remained after the fixes below.

Live check on 12 Oct, 12:00–12:52: every live alert matched this pattern (10872HDA in 12:02 → out
12:22; 10964DDA in 12:22 → out 12:44), and every plate matched the image.

**Frame-by-frame check (12 Oct, 13:10).** Sub-stream frames from 15 s before to 12 s after each
capture, from the ANPR camera and its paired overview:
- **Entry, 10861HDA (ANPR-1 + Yo'l-2):** the truck appears at the far end of the lane in Yo'l-2 and
  drives toward the plant. ANPR-1 reads its front plate by the stair railing, then the truck turns
  into the yard.
- **Exit, 10870HDA (ANPR-2 + Yo'l-1):** the mixer sits in the loading bay under the batching plant
  (Yo'l-1) until ~6 s before the capture, then pulls out toward ANPR-2, which reads its front plate,
  and drives past.

This confirms ANPR-1 = in and ANPR-2 = out. The overview photos add useful context (the loading bay,
the lane) that the ANPR close-up lacks, so they stay attached to alerts.

The same clips showed a **re-capture of a vehicle still in view**: ANPR-1 read `A861HA` 16 s after
`10861HDA`, from the same truck maneuvering. The tracker now matches a partial read to a plate the
same camera read in the last 60 s (up to 3 character edits) and skips it as a repeat.

### 2b. Same pass or quick visit? (checked on images, 12 Oct)

A vehicle can show up on both cameras shortly one after the other. The images show two different
situations:

| Gap after ANPR-1 | Example | ANPR-2 image | Meaning |
|---|---|---|---|
| 9 s | 85942DBA (9 Oct 12:33) | not checked | one pass caught by both cameras |
| 18 s | 01M393YA (12 Oct 09:30) | light truck **facing** the camera | too short for a visit: maneuvering toward ANPR-2 right after entering |
| 50 s | 85304RAA (9 Oct 07:12) | **rear** of the dump truck, driving **away into the yard** | entering; ANPR-2 also reads rear plates |
| 78 s | 01M393YA (12 Oct 10:21) | light truck **facing** the camera | probably leaving; it passed ANPR-2 facing it again at 10:36 (maneuvering in the yard) |
| 98 s | 85W670JA (12 Oct 11:46) | van **facing** the camera, driving out | real quick visit (drop-off) |
| 166 s | 10N987NB (12 Oct 14:41) | not checked | quick visit (entry image: delivery light truck) |

Facing ANPR-2 does not by itself mean leaving: vehicles also turn toward it while maneuvering in
the yard.

So the same-pass window is **60 s** (it was 2 min, which wrongly dropped 85W670JA's exit). The
margin between 50 s and 78 s is narrow. The robust signal would be the camera's own direction (front
vs rear plate), which the NVR doesn't pass on (see section 7).

## 3. Plate recognition quality

| | ANPR-1 (entry) | ANPR-2 (exit) |
|---|---|---|
| Captures (day / night) | 91 (66 / 25) | 173 (134 / 39) |
| Plate read | **88 (97%)** | **73 (42%)** |
| Read is a valid Uzbek plate | 78 | 63 |
| Read invalid, corrected to a known plate | 5 | 7 |
| Read invalid, left as is | 5 | 3 |
| No plate read (`UNKNOWN`) | 3 | 100 (71 day / 29 night) |

What the images show:

- **Valid reads are reliable.** Every valid read checked by eye matched the plate in the image. That
  includes three fleet trucks with near-identical plates (10835HDA, 10863HDA, 10872HDA), all read
  correctly. ANPR-1 read 25 of 25 at night.
- **Misreads follow a pattern:** a wrong region code (`05450KBA`, `55450KBA` → 85450KBA;
  `65159YAA` → 85159YAA; `81304RAA` → 85304RAA) or dropped characters (`8594DBA` → 85942DBA,
  `304RAA` → 85304RAA, `01M39` → 01M393YA). Region-code validation catches all of these.
- **Most ANPR-2 `UNKNOWN`s are trucks with no plate.** In every daytime and night sample checked,
  these were new SANY mixers carrying only a windshield fleet number (31, 32, 33, 36, 37, 38, 39).
  Some have since received plates; SANY #38 is now 10835HDA.
- **ANPR-2 can't read plates at night.** Night captures of plated vehicles (a van, Shacman trucks)
  are too dark, and headlight glare covers the plate. ANPR-1 has no such problem, so this is an
  ANPR-2 exposure / IR / supplementary-light setting.

## 4. In/out pairing accuracy (after fixes)

| Outcome over 3.5 days (plated vehicles) | Count | Main cause |
|---|---|---|
| Clean entry → exit pair | **58** | (57 with the old 2-min same-pass window) |
| Entry, then another entry (exit missed) | 20 | Mostly at night: ANPR-2 can't read plates in the dark, or the exit was never captured |
| Exit with no entry before it | 9 | Mostly 85942DBA, whose entries ANPR-1 rarely captures |

## 5. Fixes made during the survey

1. **Over-correction (bug).** The first version snapped any read within 1–2 characters to a known
   plate, which merged different fleet trucks (10835HDA and 10863HDA became 10865HDA, 8 times).
   Now valid reads are never changed, and only invalid reads are snapped, when one known plate
   clearly matches. Result: 0 wrong merges.
2. **One pass counted as in and out.** A vehicle seen by both cameras seconds apart produced
   "in" and then "out" 12 s later. Now a sighting in the opposite direction within 60 s is skipped
   (first 2 min, shortened on 12 Oct after the image check in section 2b).
3. **Maneuvering repeats.** Same-direction repeats are now skipped for 20 min (was 3 min).
4. **Gap flag.** Alerts say when the matching entry or exit is missing, instead of hiding it.
5. **Wrong context photos.** Alerts attached both Yo'l snapshots. Now each alert attaches only the
   overview camera paired with the ANPR camera that saw the vehicle.

## 6. Known limitations and recommendations

| Issue | Effect | Recommendation |
|---|---|---|
| ANPR-1 saves a capture only when it finds a plate | Entries of plateless trucks are never recorded; only their exits are | Enable capture of vehicles without plates on ANPR-1 (camera ANPR settings), as ANPR-2 already does |
| ANPR-2 can't read plates at night | Most night exits go unrecognised, which causes the "exit missed" gaps | Check ANPR-2's day/night mode, IR / supplementary light and plate-exposure settings against ANPR-1, which reads well at night |
| Plateless SANY mixers | ~~Not identified~~ **Solved 12 Oct**: GPS exit timing identifies them, and they now have plates mapped to their GPS numbers (section 8) | Fleet-number OCR no longer needed |
| Telegram connectivity | The address DNS gives for api.telegram.org (149.154.166.110) accepts only about half of the connections from this network (2/6 full Bot API calls on 12 Oct); 149.154.167.220 answers 6/6 in ~0.4 s. IPv6 has no route. Bot replies took 10–20 s or failed. | Fixed 12 Oct 17:16: connect to the address that worked last, then DNS, then known Bot API addresses, 3 s each (the TLS certificate is still checked for api.telegram.org). Calls now average 0.7 s. Worth raising the bad route with the ISP. |
| NVR event stream has no chunked encoding or length | Generic HTTP stream readers (`requests.iter_content`) never hand over a message: before 12 Oct 13:36 every alert came from the 60 s fallback poll | Read with `raw.read1()` (done in `hikvision.anpr_events`) |
| NVR clock is set manually | Within 1 s of this machine today, but it will drift | Switch the NVR to NTP so capture times stay correct |
| Live event has no plate | ~5–30 s delay while the capture is fetched from the NVR | Acceptable. Overview snapshots are taken at alert time, so the vehicle may already have moved on |

## 7. Camera and NVR features in use

What the system relies on from the Hikvision equipment, as checked on the NVR on 12 Oct (`/ISAPI/Event/triggers`).

**Used**

| Feature | Where it runs | How we use it |
|---|---|---|
| **License plate recognition (ANPR)**, iDS-2CD7A46G0/P-IZHSY DeepinView cameras | On the cameras (ANPR-1 ch4, ANPR-2 ch3) | Detects the vehicle, reads the plate and takes the capture photo. This is the only plate recognition in the system; we do no OCR ourselves. |
| **Vehicle detection event** (`vehicledetection-3`, `vehicledetection-4`, linked to *record* + *notify surveillance center*) | Camera → NVR | The "notify center" link puts an `ANPR` event on the NVR's alert stream. That is our real-time trigger (~9 s after capture). |
| **Capture picture storage and search** | NVR | Every capture is stored as a picture record (track `<ch>03`). The plate is in the record name. We search these records and download the full 2560 px capture image for the alert. |
| **Snapshot** (main-stream JPEG) | NVR, from Yo'l-1 (ch6) / Yo'l-2 (ch5) | Overview photo attached to each alert. These are plain cameras; none of their smart features are used. |

**Available but not used**

| Feature | Why not (yet) |
|---|---|
| Vehicle color / type / brand from the ANPR camera (printed on the capture image) | Unreliable here: MAN and SANY trucks labelled "Chevrolet", "Toyota", "Benz", "Audi" |
| Direction of travel (the cameras count "Forward / Reverse", visible on the overlay) | The NVR's picture search and event stream don't include it. It's only reachable on the cameras themselves (192.168.88.x LAN), which this machine can't reach. It would replace the 60 s same-pass heuristic. |
| Allowlist / blocklist matching (`whiteList` / `blackList` triggers exist for 2 channels) | Could flag unknown vehicles on-camera. Not configured; the notifier tracks plates itself. |
| Line crossing / intrusion / region entrance-exit events on other cameras | Not needed for plate tracking |

## 8. GPS fleet (GoGPS), added 12 Oct

The fleet is tracked by GoGPS (`baku.gps.az`, API v3; the former `gogps_bot` used it for fuel reports).
The account has **20 vehicles**. 13 are named by plate (`85 450 KBA`, ...). 7 SANY mixers are named by
fleet number (`31`–`37`), the number on the placard behind their windshield.

What the API gives (all checked live):

| Data | Endpoint | Notes |
|---|---|---|
| Vehicle list | `vehicles/find` | names, models (`N/V`, `A/V` = mixers) |
| Move/stop timeline | `vehicles/moveStop` | **near real time**: the latest segment ends 10–40 s before "now"; 2 s for the whole fleet. Stops carry a reverse-geocoded address, no coordinates. |
| Mileage and odometer | `vehicles/mileageAndMotohours` | odometer (`mileageEnd`) only for periods that start at midnight |
| Fuel level and consumption | `vehicles/fuelConsumption` | **only 3 trucks have a working fuel sensor**: 85450KBA, 85159YAA, 85304RAA |
| Refuels / drains | `vehicles/fuelInOut` | event, litres, time, coordinates |
| Current position | `vehicles/getlastdata` | **broken**: "Массив пуст" (empty array) for every request shape tried |
| Raw track | `vehicles/export/history` | forbidden for this account |
| Geofences | `gis/find` | only 2 route zones, **no yard geofence** |

Single-vehicle calls take 0.5–2 s, so the GPS block of one alert costs about 5–8 s.

**The yard.** Without coordinates or a geofence, the yard is recognised by the stop address
**"Уйсозлар 2-й проезд"** (Uysozlar 2nd passage): 799 hours of fleet stops in 3.5 days. The address also
covers the street outside the gate. GPS can't tell "parked inside" from "parked by the gate".

### 8a. GPS against the cameras (9–12 Oct, 286 captures)

- **Exits (ANPR-2) line up with GPS departures to the second.** 85942DBA: 12:33:37 vs GPS 12:34:10,
  16:12:03 vs 16:11:59, 20:00:14 vs 20:00:25. Most plated exits fall within −41…+33 s. Window used: −45…+40 s.
- **Entries (ANPR-1) don't.** GPS registers the stop 0–12 minutes after the capture, because trucks
  creep through the yard. GPS is not used to identify entries.
- The three fuel-sensor trucks (85450KBA, 85159YAA, 85304RAA) pass ANPR-2 at the end of a long move
  and stop under the yard address 3–72 s later. They stay for hours, then leave without passing a
  camera. Most likely they unload, exit, and park on the street by the gate. For these exits GPS says
  "moving", which is neither a confirmation nor a contradiction.

### 8b. Plateless mixers identified by GPS (checked on photos)

On 9–11 Oct ANPR-2 captured ~100 plateless exits. With the exit window, about half match exactly one
GPS departure, almost all of them mixers 31–37. Photo check, ANPR-2 on 11 Oct:

| Capture | GPS match | Placard on photo |
|---|---|---|
| 09:34:24 | 31 at −7 s | **31** ✓ |
| 09:48:37 | 32 at +3 s | **32** ✓ |
| 18:17:11 | 33 at −6 s | **33** ✓ (night) |
| 09:18:14 | 31 at **−80 s** | **38** ✗: mixer 38 isn't in GPS. A wider window gives wrong matches. |

### 8c. The mixers got plates; GPS names ≠ plates

Plateless captures fell from 53 (9 Oct) to 38, 9 and then **0 on 12 Oct**, while GPS showed the mixers
working normally. On 12 Oct, 6 of 7 mixer departures had an ANPR-2 capture within 60 s, **with a
plate**. The mixers have been registered (Tashkent region, `108xxHDA`). Exits that coincide with
exactly one GPS departure, 10 Oct noon to 12 Oct:

| Plate | GPS vehicle | Coincidences | Check |
|---|---|---|---|
| 10840HDA | 37 | 4 of 5 exits | the 5th was a shuffle (8d) |
| 10863HDA | 32 | 3 of 3 | |
| 10865HDA | 35 | 3 of 3 | |
| 10872HDA | 31 | 3 of 3 | |
| 10870HDA | 33 | 1 of 1 | photo: a SANY mixer like 31–33, plate 10870HDA |
| 10964DDA | **85 519 EBA** | 4 of 4 | photo: a blue SHACMAN tractor. GPS still has it under an old plate. |

These are in `config.toml` `[gps.aliases]`. 10835HDA, 10861HDA and 10834HDA are probably mixers 34, 36
and 38. They have no match yet: 34 has no GPS signal, 38 isn't in GPS, and 36 hasn't left while one of
them passed. The notifier **learns new aliases by itself**. A plate read at the exit while exactly one
GPS vehicle leaves counts as a hit. After 3 hits (at least twice any other vehicle's) the plate becomes
that vehicle. Evidence is kept in the `alias_hits` table.

### 8d. GPS vetoes camera events (maneuvers)

12 Oct, mixer №37 (10840HDA) in the GPS timeline:

```
STOP  11.10 16:47 - 10:20:40   yard address
move        10:20:40-10:21:13  0.03 km     <- ANPR-2 read 10840HDA at 10:20:39 ("exit")
STOP        10:21:13-10:41:48  yard address
move        10:41:48-10:42:08  0.01 km     <- ANPR-1 read 10840HDA at 10:41:58 ("entry")
STOP        10:42:08-11:44:54  yard address
move        11:44:54-...       3.53 km     <- ANPR-2 at 11:44:59: the real exit
```

The truck shuffled a few metres in the queue, in view of the cameras, and never left. The cameras alone
report a false exit and a false entry. Rules now:
- **Exit veto**: GPS still has the vehicle parked at the yard 5 minutes after the capture
  (`exit_confirm_minutes`), and it moved less than 100 m.
- **Entry veto**: GPS has the vehicle in the yard continuously, and its entry for this stay was already
  alerted, with no exit since.

The 100 m threshold matters. On 12 Oct at 11:30:21, 85159YAA moved **0.16 km** past ANPR-2 and stopped
under the same address. That fits pulling out to park by the gate, so it is alerted. A first entry while
GPS shows the vehicle parked is not vetoed: 85942DBA waited at the gate 10 minutes (GPS "stopped") before
ANPR-1 read it entering on 9 Oct 15:59.

### 8e. Replay of 12 Oct with GPS (00:00–16:30)

- 44 camera events in the window: **27 alerted** (fleet), **2 vetoed** (№37's shuffles above), **15 not
  alerted** (other plates: 10835HDA ×4, 01M393YA ×3, 10834HDA, 10861HDA, 10N987NB, 85W670JA ×2 each).
- 16 of the 27 have a GPS ✅ line. These include every mixer exit and 85942DBA's exit, each to the
  second. A replay sees GPS data from after the event, so entries show "stopped in the yard at …". Live,
  at capture + 75 s, most entries show "📡 harakatda" (moving).
- No false "⚠️ elsewhere" or "⚠️ no movement" lines.
- Fuel and odometer figures match the GoGPS reports (e.g. 85450KBA refuel +102 L at 14:56).

### 8f. "The plate in the alert isn't the camera's" (12 Oct, 17:10)

Reported: alerts sometimes show `№31` or a completely different plate. Audit of every alert since the
GPS merge and of every camera read of a fleet truck since 10 Oct, against the GPS track:

- **The camera reads are correct.** Every alert showed exactly the camera's read. The second name was
  the vehicle's **GPS name**, which differs for 6 trucks: mixers 31–37 now carry 108xxHDA plates, and
  10964DDA is still `85 519 EBA` in GPS. The alert printed it as `🚛 85519EBA` (unsplit, before the
  readable-plate change), which looked like a different plate.
- **The pairings are right.** All 20 real exits of these 6 trucks match their GPS vehicle driving off
  the yard within 1–42 s (most within 10 s). The GPS vehicle was never stopped somewhere else at a capture.
- **Second source of confusion: time inside.** Mixers wait 15–25 min on the street before passing
  ANPR-1. 10872HDA (№31): GPS "at the yard address" from 16:20, entry camera 16:38:23, exit 16:54:45.
  The exit alert said `34 daqiqa (16:20 dan)` (GPS) instead of the 16 minutes between the cameras.

Changes:
- Alert shows `🔢 10 872 HDA  (GPS'da: №31)`.
- Time inside comes from the cameras when both entry and exit were captured. GPS is the fallback,
  labelled `⏱ Hududda: … (GPS)`.
- Monitoring: `/tekshir` (bot) and `python -m notifier audit` check every fleet plate read against
  the GPS track. Exits are confirmed when the GPS vehicle drove off within −45…+40 s. A read while GPS
  had the vehicle stopped at another address is flagged as a mismatch. The daily report gets a warning
  line when there was a mismatch that day.
  First run (11–12 Oct): 10 plates, 0 mismatches. 14 of the 15 alias exits were GPS-confirmed; the
  15th was №37's shuffle (8d).
