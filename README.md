# TBB Dispatcher

Fleet control for the TBB concrete plant: a live map of every truck (GoGPS), the gate cameras (Hikvision ANPR:
who came in, who left, with a photo of the plate and one from above showing the load), analytics for the owner, push
notifications on phones, and the Telegram bot.

Design and reasoning: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Deployment: [START_PROJECT.md](START_PROJECT.md).

## What it does

The menu has four items: Xarita, Darvoza, Transport and Hisobot. Tahlil, Hisobot and Joylar below are tabs of Hisobot, alerts open from the bell, settings from the user menu.

| Page | Who | |
|---|---|---|
| **Xarita** | everyone | Live positions every 10 s, status (moving / idling / parked / no signal), search and filters, vehicle card with today's trips and km, follow mode, today's track, the yard on the map |
| **Darvoza** | everyone | Live entries and exits with the plate photo and overview snapshot, GPS check of each pass, who is in the yard now and for how long, outside vehicles, manual corrections |
| **Ogohlantirishlar** | everyone | Fuel drains, no GPS signal, long stops outside the yard, NVR/GPS outages; acknowledge |
| **Transport** | everyone | One vehicle's day: track, stops, gate passes, fuel events; last 14 days, with average L/100 km and utilization |
| **Reyslar** | everyone | One row per trip: left, came back, km, fuel, where it went, photos of both passes, CSV. Works from cameras and GPS together (docs/ARCHITECTURE.md, 6b). |
| **Joylar** | everyone / owner | Places named on the map, from a stop on a truck's track or a spot suggested because trucks often stop there (the owner names or ignores it): trips to each, which trucks, how long. Their names replace addresses on the map and in lists |
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
src/cameras/         NVR client (digest auth), plate rules, in/out tracker, top view from the recording (ffmpeg)
src/gate.js          camera pipeline: captures -> gate events -> GPS confirm/identify -> photos -> notify
src/notify/          durable delivery queue, one row per recipient, for any channel
src/telegram/        the bot: client, commands, recipients, alert format, scheduled reports, mini app login
src/reports.js       daily / monthly report, yard and camera-vs-GPS check as text
src/analytics.js     daily per-vehicle rollups + analytics queries
src/rules.js         alert rules        src/push.js   Web Push        src/auth.js   users, roles, sessions
src/api.js           JSON API + live stream (SSE)
src/tiles.js         map tiles: this server fetches them from OpenStreetMap for the browser, a few at a time
src/dnscache.js      remembered DNS answers, so a burst to one host can't hold up the others
public/              the app (index.html, css/, js/pages/*, sw.js); public/tg/ + js/tg/: the Telegram mini app
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

## Telegram

With `TELEGRAM_BOT_TOKEN` and `ADMIN_IDS` in `.env`, every entry and exit goes to the recipients with the plate photo and the top view.

| Who | How | Gets |
|---|---|---|
| Groups | add the bot, an admin sends `/ulash@<bot>` there (`/uzish` stops it) | alerts, the 22:00 and month-end reports, outage messages; everyone in the group can use `/bugun`, `/kecha`, `/hovli` |
| Users | they press Start, an admin sends `/qoshish <id>` (`/uzish <id>`), or `TELEGRAM_CHAT_IDS` | alerts |
| Admins | `ADMIN_IDS` | all commands, reports and every health message |

Commands: `/bugun` `/kecha` `/oy` `/hovli` `/tekshir` `/holat` `/oluvchilar` `/ulash` `/uzish` `/qoshish` `/yordam` `/id`.

Only one program may use a bot token at a time; the app reports it in system health if another one does. ffmpeg must be installed
for the top view (the Docker image has it). Without it, alerts go with the other photos.

### Mini app

A small version of the app inside the bot, for the owner and dispatchers on their phones: **Bugun** (the fleet now,
the yard, today's numbers, open alerts, the latest passes), **Xarita** (live map with search and status filter, or a
list), **Darvoza** (passes with photos; who is in the yard and for how long), **Hisobot** (today, yesterday, this
month), alerts from the bell, and a page per truck and per pass. Only acknowledging alerts changes anything; the rest
is on the site.

People open it with the bot's **Ochish** button (or `/app`) and log in once with their site login and password; after
that it opens without a password. The owner sees and removes these links in Settings → Users. Every gate alert ends
with **Ilovada ochish**, which opens that pass. Setup: START_PROJECT.md; design: docs/telegram-mini-app-plan.md.
