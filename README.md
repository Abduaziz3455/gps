# TBB Dispatcher

Fleet control for the TBB concrete plant: a live map of every truck (GoGPS), the gate cameras (Hikvision ANPR:
who came in, who left, with photos), analytics for the owner, and push notifications on phones.

Design and reasoning: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Deployment: [START_PROJECT.md](START_PROJECT.md).

## What it does

| Page | Who | |
|---|---|---|
| **Xarita** | everyone | Live positions every 10 s, status (moving / idling / parked / no signal), search and filters, vehicle card with today's trips and km, follow mode, today's track, the yard on the map |
| **Darvoza** | everyone | Live entries and exits with the plate photo and overview snapshot, GPS check of each pass, who is in the yard now and for how long, outside vehicles, manual corrections |
| **Ogohlantirishlar** | everyone | Fuel drains, speeding, no GPS signal, long stops outside the yard, NVR/GPS outages; acknowledge |
| **Transport** | everyone | One vehicle's day: track, stops, gate passes, fuel events; last 14 days |
| **Tahlil** | owner | KPIs vs the previous period, trips/km/active vehicles per day, gate traffic heatmap, turnaround, per-vehicle ranking, outside vehicles |
| **Hisobot** | everyone | Per-vehicle table for any range, CSV, print |
| **Sozlamalar** | everyone / owner | Push notifications for this device, password; owner: users, vehicles (type, real plate), system health |

System health: the app checks every minute whether our server's internet, GoGPS, the plant's internet, the NVR
and each camera work, and says in plain words which one broke (and when it is back, with the period).

Push notifications: entry/exit (per device: entries, exits, fleet only, quiet hours) and alerts. On iPhone the
site must be added to the Home Screen first (iOS 16.4+).

## How it is built

One Node 22 process (`server.js`), SQLite (`node:sqlite`), plain ES modules in the browser (no build step).

```
server.js            wiring + static files
src/gps/             GoGPS client (1 req/s queue), normalisation, live poller (positions, yard visits)
src/cameras/         NVR client (digest auth), plate rules and in/out tracker (ported from tbb_car_notifier)
src/gate.js          camera pipeline: captures -> gate events -> GPS confirm/identify -> photos -> notify
src/analytics.js     daily per-vehicle rollups + analytics queries
src/rules.js         alert rules        src/push.js   Web Push        src/auth.js   users, roles, sessions
src/api.js           JSON API + live stream (SSE)
public/              the app (index.html, css/, js/pages/*, sw.js)
src/mock/sim.js      simulated GPS + NVR for development (MOCK=1)
```

## Run locally

```bash
npm install
```

```bash
MOCK=1 NODE_ENV=development npm start
```

Open http://localhost:8090 and log in as `owner` / `owner12345` or `dispatcher` / `dispatcher123` (demo data:
the real fleet's names on simulated routes; the first start imports 30 simulated days).

Against the real systems: copy `.env.example` to `.env`, fill in GPS, NVR and the first owner account, then
`npm start`.

```bash
npm test
```

## The Telegram notifier

`tbb_car_notifier` keeps running unchanged on its own server and keeps sending Telegram alerts. This app reads
the same NVR and GoGPS account independently.
