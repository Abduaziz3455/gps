# TBB Dispatcher v2: architecture

Status: 3 Nov 2026. Replaces the single-file dashboard (`fleet-dashboard.html`) with a server-backed
application that joins the **GPS fleet** (GoGPS, `baku.gps.az`) with the **gate cameras** (Hikvision NVR
with two ANPR cameras at the plant's entry and exit). Everything lives in this repository. The Telegram
notifier (`tbb_car_notifier`) is not changed and keeps running on its own server; both read the same NVR
and the same GPS account independently.

## 1. Why a rewrite

| v1 | Problem | v2 |
|---|---|---|
| The browser logged in to GoGPS with the account's password, which `server.js` wrote into the HTML | **Anyone who opened tbbdispatcher.uz could read the GPS password** (view source). No users, no roles | The GPS password stays on the server. People log in with their own account and a role (owner / dispatcher) |
| Every open tab polled GoGPS itself (1 request/s limit shared by all tabs) | 3 dispatchers = 3× the load; reports stalled behind live polling | One server-side poller; browsers get updates over a live stream (SSE) |
| No database: history only from GoGPS reports on demand | No analytics, no trends, no trip counts | SQLite: position samples, gate events, yard visits, daily per-vehicle totals, alerts |
| No camera data | — | Gate events read from the NVR: plate, photos, GPS check, live yard board |
| No notifications | — | Web Push (browser / installed app on the phone) on entry and exit, plus alert rules |
| GPS `state` 0/1 treated as "moving" | Vehicles without signal since October showed as *harakatda* (moving) | Status mapping checked against live data (section 5) |
| Report ranges computed in UTC+4 (Baku) | "Today" was shifted by an hour in Tashkent | All day boundaries in Asia/Tashkent (UTC+5) |

The v1 file is kept in git history (commit `7724957` matches what runs on the site today).

## 2. System overview

```
 plant                                    tbb-gps.uz (38.242.242.133)                          people
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

The notifier's "top view from the recording" (RTSP decode, ~180 MB RAM per frame) is not ported: the live
overview snapshot is attached instead.

## 3. Server modules

| Module | Job |
|---|---|
| `src/gps/client.js` | GoGPS client: login, token refresh on 401, **one queue at ≥ 1 s spacing**, retries with backoff |
| `src/gps/normalize.js` | Raw rows → `{id, lat, lng, speed, course, status, recordTime, address}`; status mapping (section 5) |
| `src/gps/poller.js` | `getlastdata` every 10 s for the fleet; vehicle list hourly; position samples; yard visits |
| `src/cameras/*` | NVR client (digest auth), plate rules, in/out tracker (ports of the notifier) |
| `src/gate.js` | Camera pipeline: captures → decisions → gate events → GPS resolution → photos → notifications |
| `src/analytics.js` | Daily per-vehicle totals (rollups) and every analytics query |
| `src/rules.js` | Alert rules (section 7) |
| `src/push.js` | Web Push subscriptions, per-device preferences, delivery, dead-subscription cleanup |
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
| `alerts` | | rule hits; acknowledged by a dispatcher |
| `push_subscriptions` | | per device: endpoint, keys, preferences |
| `kv` | | VAPID keys, health, last rollups |

### Rollups

`daily_stats` is computed per Tashkent day from three GoGPS reports (one request each for the whole fleet:
`mileageAndMotohours` with `sampling=86400`, `fuelConsumption`, `fuelInOut`) and the local tables (gate
events, positions). Today is recomputed every 10 minutes; past days once; the last 30 days are filled on
first start. Analytics pages read only from SQLite, so they are instant and don't touch the GPS limit.

## 4. Roles and pages

Two roles. The owner sees everything the dispatcher sees.

| Page | Dispatcher | Owner | What it shows |
|---|:-:|:-:|---|
| **Xarita** (live map) | ✓ | ✓ | All vehicles live; status filters and search; vehicle card (speed, address, signal age, today's km / trips, last gate event); follow mode; today's track; the yard on the map |
| **Darvoza** (gate & yard) | ✓ | ✓ | Live feed of entries/exits with photos and the GPS check; who is inside now and for how long; today's counts; filters; photo viewer |
| **Ogohlantirishlar** (alerts) | ✓ | ✓ | Rule hits (section 7), acknowledge, filter |
| **Transport** (vehicle page) | ✓ | ✓ | One vehicle over a date range: track replay with stops, gate events, daily km / fuel / trips, refuels and drains |
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

## 8. Security

- GPS and NVR credentials, VAPID private key: server environment / database only. Nothing secret in the page.
- Passwords: scrypt with per-user salt; login throttled per IP; sessions in HttpOnly, `SameSite=Lax`,
  `Secure` cookies; state-changing requests must be JSON with a matching `Origin`.
- Role checks on every API route; photos only for logged-in users.
- The first owner account comes from `OWNER_USERNAME` / `OWNER_PASSWORD` on the first start; more with
  `npm run user`.

**Action needed:** the live site has been publishing the GoGPS password in its HTML. Change the GoGPS
password after v2 is deployed (and in the notifier's `.env`, which uses the same account). If the NVR's
port is restricted to the notifier server's IP (planned in the notifier's TODO), also allow 38.242.242.133.

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
