# TBB Dispatcher v2: architecture

Status: 5 Nov 2026. Replaces the single-file dashboard (`fleet-dashboard.html`) with a server-backed
application that joins the **GPS fleet** (GoGPS, `baku.gps.az`) with the **gate cameras** (Hikvision NVR
with two ANPR cameras at the plant's entry and exit). Everything lives in this repository, including the Telegram
bot, which used to be a separate Python program (`tbb_car_notifier`, section 7b).

## 1. Why a rewrite

| v1 | Problem | v2 |
|---|---|---|
| The browser logged in to GoGPS with the account's password, which `server.js` wrote into the HTML | **Anyone who opened tbb-gps.uz could read the GPS password** (view source). No users, no roles | The GPS password stays on the server. People log in with their own account and a role (owner / dispatcher) |
| Every open tab polled GoGPS itself (1 request/s limit shared by all tabs) | 3 dispatchers = 3× the load; reports stalled behind live polling | One server-side poller; browsers get updates over a live stream (SSE) |
| No database: history only from GoGPS reports on demand | No analytics, no trends, no trip counts | SQLite: position samples, gate events, yard visits, daily per-vehicle totals, alerts |
| No camera data | — | Gate events read from the NVR: plate, photos, GPS check, live yard board |
| No notifications | — | Web Push (browser / installed app on the phone) on entry and exit, plus alert rules |
| GPS `state` 0/1 treated as "moving" | Vehicles without signal since October showed as *harakatda* (moving) | Status mapping checked against live data (section 5) |
| Report ranges computed in UTC+4 (Baku) | "Today" was shifted by an hour in Tashkent | All day boundaries in Asia/Tashkent (UTC+5) |

The v1 file is kept in git history (commit `7724957` matches what runs on the site today).

## 2. System overview

```
 plant                                    tbb-gps.uz (5.182.26.55)                             people
 ┌──────────────────┐  ISAPI (digest)    ┌───────────────────────────────────────────────┐
 │ Hikvision NVR    │◄───────────────────│ camera pipeline                               │
 │  ANPR-1  entry   │  event stream,     │  NVR events + 60 s poll → plate rules →       │
 │  ANPR-2  exit    │  capture search,   │  in/out tracker → GPS match/confirm → photos  │   HTTPS (nginx)
 │  Yo'l-1/Yo'l-2   │  images, snapshots │                                               │◄──────────────► browsers,
 └──────────────────┘                    │ GPS poller  ──► baku.gps.az (1 req/s queue)   │   SSE live      phones (PWA)
                                         │  positions every 10 s → yard geofence visits  │   Web Push
                                         │ rollups: daily per-vehicle totals             │
                                         │ alert rules → Web Push + live stream          │
                                         │ SQLite data/dispatcher.db, photos data/photos │
                                         └───────────────────────────────────────────────┘
```

One Node 22 process, no build step. Dependencies: `web-push` (VAPID + payload encryption), `leaflet`
(served locally, no CDN) and `sharp` (shrinks camera photos 2560 → 1280 px, ~1.2 MB → ~0.2 MB). SQLite is
Node's built-in `node:sqlite`.

### Two independent signals for the gate, cross-checked

1. **Cameras**: the ANPR camera reads the plate; the camera decides the direction (ANPR-1 = in, ANPR-2 = out).
   The tracker rules are ported 1:1 from the notifier, where they were verified on 264 captures:
   misread correction, repeat window (20 min), same-pass window (60 s), gap flags, time inside.
2. **GPS geofence**: the server polls every vehicle every 10 s, so it sees each vehicle enter and leave a
   circle around the yard (default centre 41.2655, 69.3418, radius 150 m, from parked trucks' positions on
   3 Nov). These yard visits are stored on their own.

Combining them (each gate event is resolved 90 s after the capture, when GPS has caught up):

| Case | Resolution |
|---|---|
| Plate read, vehicle in the fleet | **Confirmed** when GPS shows it crossing the yard boundary within the window; **vetoed** when an exit capture is followed by the truck still parked in the yard 5 min later (trucks shuffling in the queue in front of the camera — seen on 12 Oct) |
| Plate read, plate differs from the GPS name | Matched by vehicle settings (owner sets the real plate), by "same digits and letters" (GPS has `10 870 HAD` for plate `10870HDA`), or learned from 3 consistent GPS departures, as in the notifier |
| No plate read at the exit | The one fleet vehicle that left the yard circle within −45…+90 s of the capture |
| Not a fleet vehicle | Kept as an **outside vehicle** (cement suppliers, visitors) with camera details only |

### What the server reads from the NVR

| Call | When |
|---|---|
| `GET /ISAPI/Event/notification/alertStream` | always connected; an ANPR event triggers a capture search on that camera |
| `POST /ISAPI/ContentMgmt/search` | on events, every 60 s as fallback, at start-up (catch-up), once for history (`CAMERA_BACKFILL_DAYS`, default 30, records only) |
| capture image, overview snapshot | right after a live event (the snapshot only shows the truck for ~1–2 min); history photos are fetched the first time someone opens them, then cached |
| recording of the overview camera, RTSP port 554 | the top view (section 2a), once a capture's recording is playable |

**An exit is vetoed only if the truck didn't move.** Standing in the yard circle 5 minutes after the exit camera isn't enough:
trucks often pass the camera and stand inside the circle for minutes, and a standing tracker reports rarely. On 5 Nov 2026
the first rule vetoed 7 of 18 real exits (the plate photo shows the truck leaving; GPS shows 69–228 m of movement or a late
crossing), while maneuvers moved 0–30 m. Now: confirmed if it crossed the boundary within the 5 minutes; vetoed if it moved
under 50 m from 2 min before to 5 min after the capture; otherwise unconfirmed, and it counts as a trip.

## 2a. Top view: the photo that shows the load

The overview cameras look down on the lane, but a live snapshot comes too late: by the time the event arrives the truck has
passed. So the picture comes from the camera's recording (`src/cameras/topview.js`). Everything below was measured on
5 Nov 2026 on 54 real captures, by comparing the frames with what the old bot sent. The old bot was right on most, and on
about one entry in four it sent an empty lane, a truck still far away, or the next truck.

| What the recordings showed | What the code does |
|---|---|
| The truck passes at very different moments: entries from before the capture to +6 s, exits −18…−4 s | Reads a wide window (entry −16…+20 s, exit −30…+4 s) and finds the moment in it |
| Often the truck is already in the first frame. Comparing with that frame makes the empty lane the "biggest change" (this was the empty pictures) | The background is the median of all frames: a truck covers a spot only briefly, and a truck standing still doesn't hide the next one |
| The window can hold the truck before or behind (at 15:32:00 the next truck's cab was sent) | Trucks are separate passes; the pass nearest the expected moment is taken |
| Sand or a tarpaulin on grey road is close in brightness, so the bed scores far below a bright cab | Compares colour. While the truck keeps driving forward, the frame after the cab is taken |
| Mixers often reverse through the picture | Forward is checked: for a reversing truck the frame near the best stays |
| Yo'l-2 also sees the public road | Only the lane counts (a polygon per camera, `topView.lane` in `src/config.js`) |
| Nothing there | Nothing is sent as if it showed the truck. The alert goes with the capture image and the live snapshot, if any |
| The NVR sometimes ends a stream early, without an error | A short read is tried again (3 tries) |
| Key frames every 2 s; the recording is served in real time, only the main stream is recorded | Key frames only: a fifth of the CPU of a full decode. Two reads at once peak at 167 MB in the production image |
| The NVR makes a recording playable in 2-minute steps, answering 400 before that | Asks every 15 s, up to 4 minutes past the end of the window |

ffmpeg runs as its own process: if it crashes or hangs, one picture is lost, not the server. At most `TOP_VIEW_WORKERS` (2) read
at once. Each event's state is in `gate_events.top_view`, so a restart carries on, and a failing camera shows up in system health.

## 3. Server modules

| Module | Job |
|---|---|
| `src/gps/client.js` | GoGPS client: login, token refresh on 401, **one queue at ≥ 1 s spacing**, retries with backoff |
| `src/gps/normalize.js` | Raw rows → `{id, lat, lng, speed, course, status, recordTime, address}`; status mapping (section 5) |
| `src/gps/poller.js` | `getlastdata` every 10 s for the fleet; vehicle list hourly; position samples; yard visits |
| `src/cameras/*` | NVR client (digest auth), plate rules, in/out tracker (ports of the notifier) |
| `src/gate.js` | Camera pipeline: captures → decisions → gate events → GPS resolution → photos → notifications |
| `src/analytics.js` | Daily per-vehicle totals (rollups) and every analytics query |
| `src/places.js` | Named places on the map and the visits (reys) to them (section 6a) |
| `src/trips.js` | The trip record: passes into trips, km, stops, destination (section 6b) |
| `src/platelinks.js` | The owner's decisions about plates no vehicle has, with the evidence for them (section 6c) |
| `src/rules.js` | Alert rules (section 7) |
| `src/push.js` | Web Push subscriptions, per-device preferences, delivery, dead-subscription cleanup |
| `src/cameras/topview.js` | The photo with the load, from the recording (section 2a) |
| `src/notify/outbox.js` | Durable delivery queue, per recipient. A new channel is one `register()` |
| `src/telegram/*` | The bot: API client, commands, recipients, alert format, scheduled reports (section 7b) |
| `src/reports.js` | Daily and monthly report, the yard and the camera-vs-GPS check as text |
| `src/gatedetails.js` | What GPS adds to a gate event: crossing, trip, fuel, today's km, odometer |
| `src/sse.js` | Live stream to browsers: positions, gate events, alerts, system health |
| `src/auth.js` | Users, roles, password hashing (scrypt), sessions (HttpOnly cookie), login throttling |
| `src/api.js` | JSON API with role checks |

### Data model (SQLite, `data/dispatcher.db`)

| Table | Size | Notes |
|---|---|---|
| `users`, `sessions` | people | role `owner` or `dispatcher`; sessions are hashed random tokens, 30 days |
| `vehicles` | 20 | synced from GPS hourly; the owner edits **type** (mixer / dump / excavator / other), the **real plate** when the GPS name differs, a display name and the fuel norm |
| `positions` | ~30k/day | a sample when the vehicle moved > 25 m, changed status, or every 2 min; kept 180 days. Track replay, speeding, distance checks |
| `yard_visits` | | GPS: vehicle entered / left the yard circle |
| `cam_sightings`, `cam_passes`, `cam_presence` | | raw NVR records and the tracker's state (as in the notifier) |
| `gate_events` | ~150/day | one per real pass: plate, vehicle, direction, status (pending / confirmed / unconfirmed / vetoed / outside), time inside, photos |
| `daily_stats` | 20/day | per vehicle and day: km, engine hours, idling, fuel used, refuels, drains, trips out/in, avg turnaround, yard time, max speed |
| `fuel_events` | | refuels and drains (GPS `fuelInOut`) |
| `places`, `place_visits` | | areas the owner named, and the stays in them, worked out from `positions` |
| `alerts` | | rule hits; acknowledged by a dispatcher |
| `push_subscriptions` | | per device: endpoint, keys, preferences |
| `outbox` | | what is being delivered, one row per recipient |
| `tg_recipients`, `tg_alerts` | | chats added with commands; each alert's text and Telegram's copies of its photos |
| `kv` | | VAPID keys, health, last rollups, Telegram offset and report marks |

### Rollups

`daily_stats` is computed per Tashkent day from three GoGPS reports (one request each for the whole fleet:
`mileageAndMotohours` with `sampling=86400`, `fuelConsumption`, `fuelInOut`) and the local tables (gate
events, positions). Today is recomputed every 10 minutes; past days once; the last 30 days are filled on
first start. Analytics pages read only from SQLite, so they are instant and don't touch the GPS limit.

## 4. Roles and pages

Two roles. The owner sees everything the dispatcher sees.

The menu has four items: Xarita, Darvoza, Transport and Hisobot. Tahlil, Hisobotlar and Joylar are tabs of Hisobot (Umumiy,
Transportlar, Joylar). Alerts open from the bell at the top, which shows the open count, and settings from the user menu.
Each page keeps its own address.

| Page | Dispatcher | Owner | What it shows |
|---|:-:|:-:|---|
| **Xarita** (live map) | ✓ | ✓ | All vehicles live; status filters and search; vehicle card (speed, address, signal age, today's km / trips, last gate event); follow mode; today's track; the yard on the map |
| **Darvoza** (gate & yard) | ✓ | ✓ | Live feed of entries/exits with photos and the GPS check; who is inside now and for how long; today's counts; filters; photo viewer |
| **Ogohlantirishlar** (alerts) | ✓ | ✓ | Rule hits (section 7), acknowledge, filter |
| **Transport** (vehicle page) | ✓ | ✓ | One vehicle over a date range: track replay with stops, gate events, daily km / fuel / trips, refuels and drains; average L/100 km and utilization over 14 days; the owner marks a stop as a place here |
| **Joylar** (places) | ✓ | ✓ | Trips to each named place for any range, which vehicles went, how long they stayed. The owner renames, resizes and deletes |
| **Tahlil** (analytics) | — | ✓ | At a glance: trips, km, fuel and utilization vs the previous period; daily trips or km; what needs attention (fuel drains, speeding, over-norm fuel, idle vehicles, outside vehicles); vehicles ranked by trips. The full table is in Hisobot |
| **Hisobotlar** (reports) | ✓ | ✓ | Daily and monthly tables per vehicle, CSV export |
| **Sozlamalar** (settings) | own notifications | ✓ | Users (create, reset password, disable, role), vehicles (type, plate), alert thresholds, yard, system health |

## 5. Live status

Checked on 3 Nov 2026 against `getlastdata` for all 20 vehicles:

| GoGPS `state` | Seen with | v2 status |
|---|---|---|
| 4 | speed 6–47 km/h | **Harakatda** (moving) |
| 2 | speed 0–9 | **Salt ishlamoqda** (idling: engine on, standing) |
| 3 | speed 0 | **To'xtagan** (parked) |
| 1 | last record 2–6 days old | **Signal yo'q** (no signal) |

Rule: no record for `OFFLINE_MINUTES` (30) → no signal, whatever the state; otherwise GoGPS's state decides
(it reported state 2 at 9 km/h, so speed does not override it); speed is used only when a row has no state
(> 5 km/h moving, > 0 idling, else parked). Inside the yard circle the card also says *Hovlida* (in the yard).

## 6. Analytics (owner)

Per day, per vehicle and for the fleet; ranges: today, yesterday, 7 / 30 days, this month, custom.

| Metric | Source | Why it matters |
|---|---|---|
| Trips (reys) = confirmed exits | cameras + GPS | the plant's output: deliveries made |
| Km driven, engine hours | GPS `mileageAndMotohours` | work done; maintenance planning |
| Utilization | vehicles with ≥ 1 trip or ≥ 5 km / vehicles with signal | idle fleet = unused capital |
| Idling share | `idlingTime / motohours` | fuel burned standing still |
| Fuel used, L/100 km, refuels | GPS `fuelConsumption`, `fuelInOut` (trucks with sensors) | cost; anomalies vs the vehicle's norm |
| **Fuel drains** | GPS `fuelInOut` | theft suspicion — always alerted |
| Turnaround (exit → next entry) | cameras | delivery cycle time |
| Time inside the yard (entry → exit) | cameras | loading queue |
| Outside vehicles | cameras | suppliers and visitors: count and time inside |
| Max speed, speeding | position samples | safety |
| Data health | positions, NVR, GPS | vehicles without signal, camera reads not matched to GPS |

The Tahlil page keeps to the headline: trips, km, fuel and utilization against the previous period, one daily
chart, and an attention list. Per-vehicle detail (engine hours, idling, turnaround, refuels, max speed) is in the
Hisobot table and on each vehicle's page.

The vehicle page's L/100 km and utilization come from the same query as the Hisobot row (`byVehicle`), over the 14
days ending on the chosen day. A single day's utilization would only ever be 0 or 100%.

## 6a. Places

The owner clicks a stop on a vehicle's track, names it and picks a radius (150 m by default, 50–2000 m). The point
itself stays where the truck stopped. The yard already has a name, so it can't be marked, and a point inside a place
opens that place instead.

| Rule | Why |
|---|---|
| A visit (reys) is one stay in the circle with **≥ 5 min standing** | The same rule as the stop marks on the map. Driving through or a traffic light doesn't count |
| Inside again within 20 min: the same visit | GPS drift at the edge of the circle, a truck shuffling on site |
| A longer gap: a new visit if the vehicle reported from elsewhere meanwhile; the same visit if it reported nothing | A quiet tracker is not a trip |
| A visit belongs to the day it began | A stay over midnight is one trip |

This counts arrivals at a place, from GPS. It is separate from the plant's trips (gate exits), which stay as they were.

`place_visits` is worked out from `positions` by bounding box, one day of samples at a time, giving way to other
requests in between. A new or resized place gets its whole history once; every 5 min the last 24 h are worked out again,
since records can arrive late. So today's counts can lag by up to 5 min. Nothing here writes to `positions` or runs in
the poller. Names appear in the live list and card, the vehicle's stops and timeline, and new alert texts; the GPS
address stays in the cards. On maps, places have their own layer under the trucks, in a passive grey.

**Suggested places.** Hourly, a background search goes through the last 30 days of visits and groups those within 150 m
of each other. A spot with ≥ 3 visits by ≥ 2 vehicles is suggested to the owner (one truck parked at its driver's home
doesn't qualify): the 20 busiest, listed on the Joylar page and not drawn on the maps. Clicking a row shows the spot on
that page's map. The owner names it, which makes it an ordinary place, or ignores it. Dispatchers don't see
suggestions. The yard's surroundings and named places are left out.

An ignored spot stays away for 7 days. After that it comes back if it got at least 3 visits by at least 2 trucks since it
was ignored, the bar for a new suggestion; visits from before don't count. Ignoring it again starts over. The 7 days
is a judgement call, not a measurement: production has too little history to measure it.
An ignore can be undone from the message that follows it, or later from the folded list of ignored spots on Joylar.

**Thresholds, checked on real data** (production, 3–4 Nov 2026: about 1.5 days, 20 trucks, 12.7k samples). Worth
measuring again once there are some weeks of data.

| Threshold | What the data showed | Decision |
|---|---|---|
| Default radius 150 m | Visits per site at 75 / 100 / 150 / 200 / 300 m: 7/8/8/8/7, 8/8/7/7/7, 5/5/5/5/5. Stops at a site spread 11–105 m from its centre | Kept |
| Yard radius 150 m | 51 stops within 150 m of its centre, none from 150 m to 1 km | Kept |
| 5 min standing | Stops away from the yard: 511 under 3 min, 21 at 3–5 min, 75 at 5 min or more | Kept |
| A stop is not a visit | Trucks flicker to "moving" while they stand: 166 pieces were 49 visits | Pieces within 20 min and 150 m are added up |
| Return gap | Same-spot returns: 54 within 10 min, 4 at 10–20 min, none at 20–90 min | 20 min (was 10) |
| Spot grouping 150 m | At 100 m the busiest site split (9 visits fell to 7); 200–300 m changed little (10–11) | Kept |
| Must span several days | The two busiest sites by vehicles (7 and 5 trucks) were each used on one day | Dropped |
| Minimum visits | ≥ 5 finds 3 sites, ≥ 3 finds 6, all with at least 2 trucks | 3, showing the 20 busiest |

## 6b. Trips

`src/trips.js`, the Reyslar page. One row per trip: left the yard, where it went, when it came back, km, fuel, photos of both
passes. Rows are worked out, never edited, so they can be deleted and rebuilt (`trips_version` in `kv` does that when the rules change).

**When it left and came back.** A trip runs from leaving the GPS circle to reaching it again, as the Telegram alerts count it. The camera's
time is used only when GPS has none. The circle and the gate are different moments: on 5 Nov 2026 a truck passed the exit camera and stood in
the circle for 5 h, and another reached the circle at 17:49 and the entry camera at 14:57 next day. So a camera pass joins the GPS crossing the
same way with no crossing the opposite way between them, however long ago (up to 12 h out, 24 h in), rather than one within a short window. Two
camera passes the same way are two passes: the one between them went unseen, and the row says "not recorded" instead of guessing.

Left out, or marked, because of what the real month showed:

| Case | Rule | Real example |
|---|---|---|
| Wobbling at the circle's edge | Out and back within 10 min with no camera pass: not a trip | out for 14 s |
| Stayed by the plant | Never farther than 1 km, or under 2 km with no stop away: flagged "Hovli yonida", left out of counts unless asked for | 0.2 km in 2 h |
| Days with no recordings | Over 24 h with 2+ stops on the plant's street: shown as an exit and a return, not one trip | 10-29 to 11-03, 491 km |
| Real long trip | Stays one trip | 49 h, 13 km, 1 stop there |

**Km and stops** come from GoGPS's moves and stops: positions came out 9% short (73.8 vs 80.7 km; the day's mileage report said 80.5). GoGPS takes about
48 s to answer for one day of the fleet, so `gps_segments` stores it: today every 15 min, past days once, slowly, on a third lane of the GPS client (`bulk`) so
it never delays an alert's report. Pages only read SQLite. Until the answer is in, km comes from positions and is shown with ≈. GoGPS has no coordinates in stops, so
a stop's point comes from `positions` (since 3 Nov 2026); older stops are told apart by address, with the plant's street learned from stops whose point is known.

**Where it went** is decided when a trip is read: the named place it stood at longest, else its longest stop away from the plant. So naming a place changes past
trips at once. Many trackers give only "Ташкент" as the address, so naming places is what makes this column useful.

**Fuel** is asked once per finished trip, only for a truck whose sensor reported that day (14 of 60 vehicle-days when written).

**The count differs from "Reys" on the other pages on purpose.** That one is max(exits, entries) from the cameras alone. On the real month: 747 trips against 694, and within 15% on 21 of the 22 days
the cameras recorded much. On days they recorded little it differs most: 33 trips against 0 on 4 Nov 2026. The page says so. Of the 747, 493 have both ends; the rest are mostly history from before the poller, when an unread exit left no trace.

## 6c. Unknown plates

`src/platelinks.js`, a card in Settings → Transportlar. Plates read often that no vehicle has count as outsiders, so their trips are missing from the reports (real: four plates
were 18% of all passes in 14 days). Regulars (4+ passes on 2+ days in 30 days) are listed for the owner, who decides once per plate, and can undo:

- **This GPS truck.** `plate_links` holds it rather than `vehicles.plate`, because setting `plate` turns off the "same digits and letters" match its usual reads rely on. Past passes move to the truck with status `history`.
- **Our truck, no GPS.** A vehicle of its own (`camera_only`, ids from 1e9), counted by the cameras alone: no GPS check to wait for, no GPS lines in Telegram, not on the live map, not "signal lost".
- **Not ours.** Stops asking, and learned matching can no longer claim it.

The suggestion comes from local records and stays quiet when unsure: which truck left the circle when the plate passed the exit camera (since the poller began), then which truck stood on the plant's
street at each pass (`gps_segments`, 90% of 10+ passes and 20 points ahead of the next truck). Checked on the 14 plates whose truck is known: 7 right, none wrong, 7 undecided. It found 10963DDA = 85 518 EBA (60 of 60, next 46).
Some trackers only ever report "Ташкент", so "may have no tracker" is never stated as fact.

## 7. Alerts and push notifications

| Rule | Default | Push |
|---|---|---|
| Gate entry / exit | every confirmed (or unconfirmable) pass | per device preference |
| Fuel drain | any drain reported by GPS | always |
| Speeding | > 80 km/h in 2 consecutive samples | yes |
| No GPS signal | > 30 min for a vehicle active in the last 7 days | once per outage |
| Long stop outside the yard | parked > 90 min outside the yard, 06:00–22:00 | yes |
| System health (section 7a) | a problem lasting ~3 min; recovery with the period | everyone |

Delivery is **Web Push** (VAPID): Chrome / Edge / Firefox on desktop and Android, and iPhone (iOS 16.4+) once
the site is added to the home screen (manifest + service worker included). Entry and exit notifications carry
the plate photo (Android/desktop) and open the event on tap. Open tabs get everything live with a toast.

Timing: entries are pushed right away; exits of fleet vehicles after GPS confirms the departure (usually
within a minute; vetoed maneuvers are never pushed); unread plates after the 90 s GPS match.

## 7a. System health: which link is broken

`src/health.js` checks every minute and names the broken link in plain words (Uzbek), so the person reading it
knows whom to call:

| What it sees | Message (short) | Who fixes it |
|---|---|---|
| This server can't reach the internet (1.1.1.1 / 8.8.8.8 don't answer) | "Dispatcher serverida internet yo'q" — not a plant problem | hosting provider |
| GoGPS refuses the login | "GPS tizimiga kirib bo'lmayapti" — password changed | owner: update `GPS_PASSWORD` |
| GoGPS doesn't answer, our internet works | "GPS xizmati javob bermayapti" | GoGPS |
| NVR port refused (the plant's router answered) | "NVR javob bermayapti" — NVR off/rebooting, or port forwarding changed | plant: NVR |
| Nothing answers; router probe (`SITE_ROUTER`) also silent | "Zavodda internet yo'q" — provider, Wi-Fi/router or power | plant: internet |
| Nothing answers; router answers | "NVR javob bermayapti" — NVR off, hung or unplugged | plant: NVR |
| Nothing answers, no router probe configured | "Zavoddagi kameralarga ulanib bo'lmayapti" — internet, power or NVR, internet first | plant |
| NVR refuses the password | "NVR parolni qabul qilmadi" | owner: update `NVR_PASSWORD` |
| NVR says a camera channel is offline | "ANPR-1 kamerasi o'chgan" — camera power/cable | plant: camera |
| GPS saw ≥ 3 trucks cross the gate in 90 min, the camera recorded none | "ANPR-2 kamerasi mashinalarni yozmayapti" — dirty/turned lens, ANPR off | plant: camera |
| Disk < 1 GB or < 5% | "Serverda joy tugayapti" | owner / hosting |
| This server was off (heartbeat gap > 3 min) | "Dispatcher tizimi ishlamay qoldi: 10:02–10:15", reported after restart | — |

Our server's own internet is checked first; while it is down nothing else is judged (and no push can be
sent; the recovery message carries the period). A problem is reported when it lasts 3 checks (~3 min) and is
closed with "✅ Tiklandi … Ishlamagan vaqt: 10:02–10:15" after 2 good checks; the closing also marks the outage
alert as seen. The banner over every page shows active problems; the app itself says when the *viewer's*
device is offline ("Qurilmangizda internet yo'q") or our server can't be reached ("Dispatcher serveri bilan
aloqa yo'q"). System messages go to everyone and ignore quiet hours (per-device switch "Tizim holati").

When this server is completely down nobody inside it can send anything: an outside uptime check on
`https://tbb-gps.uz/health` (START_PROJECT.md) covers that.

`/health` always answers 200 while the process runs, so a GPS outage never makes Docker restart the app. Its `gps`
field is true only if GoGPS answered within the last three polls and a minute (90 s at the usual 10 s poll). Its
`nvr` field still only says the NVR has answered at least once since the start.

## 7b. Telegram

The bot was a separate Python program reading the same NVR and GPS account. It is now part of this app. There is one gate
pipeline: the same events, decisions and photos reach the web page, the phone and Telegram.

```
capture → tracker → gate event ─┬─ 'gate' (page, push: entries at once)
                                ├─ GPS resolution ── top view ── 'gate:final' ──┐
                                                                                ├─ outbox ── Telegram
 health ('alert', system) · schedule (22:00, month end) · commands ─────────────┘
```

**How it is built to grow.** Each piece has one job and knows little of the others:

| To add | Do this |
|---|---|
| A bot command | One line in `src/telegram/commands.js`: name, who may use it, what it runs |
| A delivery channel (SMS, e-mail, ...) | `outbox.register('sms', send)` and subscribe to the bus. Queueing, retries and give-ups are there |
| Another reaction to a finished gate event | `bus.on('gate:final', ...)`. Writing to the database there joins the transaction that marks the event done |
| A self-check | `health.addCheck(part, label, fn)`: confirmation, recovery message and the Settings row come with it |
| A camera or different lane | `topView` on the camera (`CAMERAS_JSON`) |

**Exactly once.** An event is marked final and its deliveries queued in one transaction, each delivery with its own dedupe key.
Reports are queued together with their day's mark. So a crash can delay a message but neither lose nor repeat it. All pending work
(top views, finals, deliveries) lives in the database and carries on after a restart.

**Timing.** As with the old bot, an alert goes out when the top view is ready: 1.5–3 min after the capture, because the NVR makes
the recording playable in 2-minute steps. An exit whose truck hasn't moved 50 m yet waits up to 5 minutes for the veto; one that
has goes out right away. Later than 6 min, the alert says it is late. After an outage, events up to `CAMERA_CATCHUP_HOURS` (6) old are still alerted, marked late.

**Reports come from `daily_stats`**, the same numbers as the Hisobot page: `/bugun` refreshes today's first, `/oy` takes a second
instead of minutes. A vehicle's trips are `max(exits, entries)`, as everywhere in the app: the exit camera misses more plates.

**Moving from the old bot:** `scripts/import-notifier.js` and START_PROJECT.md. Its learned aliases are not imported, on purpose: the
evidence is noisy (it maps 10834HDA to the GPS vehicle named 10 870 HAD). Mixers are matched by the app's own "same digits and
letters" rule, which also gives them GPS details the old bot lacked.

### Map tiles must not hold up the GPS polls

On 5 Nov 2026 live GPS stopped for 12 minutes while the map was in heavy use, although GoGPS and our internet were
fine. Node resolves hosts at most 2 at a time, in one queue, and a request that gives up leaves its lookup in that
queue. Each tile could open a new connection, so about 2,300 tiles queued lookups at 570 ms each and the GPS polls
timed out behind them, for minutes after the tile requests had stopped. Three things prevent it now:

- `src/tiles.js`: at most 6 requests to the tile server at a time. Up to 200 wait for at most 10 s, then get a 503 and
  the map asks again. A tile the browser no longer wants leaves the line.
- `src/dnscache.js`: one lookup per host at a time. A known answer is used at once and refreshed in the background
  after 60 s; after an hour the resolver is waited for. If the resolver fails, the last answer keeps working.
- `docker-compose.yml`: the container uses 1.1.1.1 and 8.8.8.8 (about 60 ms) instead of the machine's Tailscale
  resolver (about 560 ms). The app has no Tailscale names to resolve; if one is ever added, this has to change.

## 8. Security

- GPS and NVR credentials, VAPID private key: server environment / database only. Nothing secret in the page.
- Passwords: scrypt with per-user salt; login throttled per IP; sessions in HttpOnly, `SameSite=Lax`,
  `Secure` cookies; state-changing requests must be JSON with a matching `Origin`.
- Role checks on every API route; photos only for logged-in users.
- The first owner account comes from `OWNER_USERNAME` / `OWNER_PASSWORD` on the first start; more with
  `npm run user`.

- The bot token and the RTSP login are server-only. Neither appears in logs or error messages: Telegram errors are reduced to a code,
  ffmpeg's messages have the URL removed.

**Action needed:** the live site has been publishing the GoGPS password in its HTML. Change the GoGPS
password after v2 is deployed. The NVR's ports 8008 and 554 are open to the internet: restrict them on the site router to 5.182.26.55.

## 9. Rollout

1. Deploy v2 (same server, `docker compose up -d --build`), log in as owner, create dispatcher accounts.
2. Check the map against GoGPS and the gate feed against the Telegram alerts for a day.
3. Set vehicle types and real plates in Settings → Vehicles.
4. Change the GoGPS password. Ask dispatchers to install the app on their phones and allow notifications.

## 10. Later

- Yard geofence in GoGPS itself; camera direction from the plate side (front/rear).
- Orders / deliveries: link trips to customers (the bot in `bot.txt` takes orders into Google Sheets).
- Driver assignments (`DriversVehiclesAssignments`) once drivers are entered in GoGPS.
- Maintenance reminders by engine hours / km.
