# Deploy TBB Dispatcher v2

Server: Debian with nginx and Docker (`ssh icalluz`, tbb-gps.uz, 5.182.26.55), shared with other sites. The code is in `/root/gps`.

## 1. Before you start

- The NVR must be reachable from this server: `curl -s -o /dev/null -w '%{http_code}\n' http://<NVR_HOST>/ISAPI/System/deviceInfo`
  must print `401` (= it answers and wants a password). If it times out, allow 5.182.26.55 on the site router.

## 2. Get the code

```bash
cd /root/gps
```

```bash
git fetch origin && git checkout main && git pull
```

## 3. Configure

```bash
cp .env.example .env && nano .env
```

Fill in `GPS_LOGIN`, `GPS_PASSWORD`, `NVR_HOST`, `NVR_PASSWORD`, `OWNER_USERNAME`, `OWNER_PASSWORD`
(the first owner account; 8+ characters), `PUBLIC_ORIGIN=https://tbb-gps.uz`.

```bash
mkdir -p data && sudo chown -R 1000:1000 data && chmod 600 .env
```

## 4. Start

```bash
docker compose up -d --build
```

```bash
docker compose logs -f
```

Expect: `GPS fleet: 20 vehicles`, `camera history: importing 30 days`, then `rollup ... done` for 30 days.
The rollups take **about 25 minutes**: GoGPS needs 45-55 s per day for its reports. The live map and gate work
meanwhile; Tahlil and Hisobot fill in from the oldest day to the newest. If the NVR is unreachable, the camera
import waits and runs by itself as soon as it answers.

```bash
curl -s http://127.0.0.1:8090/health
```

## 5. nginx

The new config adds the live-stream location (no buffering).

First point the DNS of `tbb-gps.uz` and `www` to this server. The config won't load without a certificate, and the
certificate needs port 80 to answer for these names, so on a new server start with a temporary plain-HTTP site that
serves `/.well-known/acme-challenge/` from `/var/www/certbot`, then:

```bash
certbot certonly --webroot -w /var/www/certbot -d tbb-gps.uz -d www.tbb-gps.uz
```

```bash
cp nginx.conf /etc/nginx/sites-available/tbb-gps.uz && ln -sf /etc/nginx/sites-available/tbb-gps.uz /etc/nginx/sites-enabled/tbb-gps.uz && nginx -t && systemctl reload nginx
```

## 6. After the switch

1. Log in at https://tbb-gps.uz as the owner. Settings → Users: create the dispatchers' accounts.
2. Settings → Vehicles: set each truck's type and, where GoGPS names it differently, its real plate
   (suggestions appear once the cameras have seen it).
3. **Change the GoGPS password** (v1 published it in the page source), then update `GPS_PASSWORD` here and restart.
4. Phones: open the site, add it to the Home Screen (iPhone: Share → Add to Home Screen), Settings →
   Notifications → Turn on.
5. Remove `OWNER_PASSWORD` from `.env`.
6. Optional, recommended: an outside uptime check, for the one case the server can't report itself (it is
   completely down). Any free monitor (UptimeRobot, Better Stack…) on `https://tbb-gps.uz/health`
   every 5 minutes, alerting to Telegram or SMS.
7. Optional: set `SITE_ROUTER` in `.env` (a port the plant router itself answers on), so the app can tell
   "plant internet down" from "NVR off".

## Moving the Telegram bot here

Once, when the old Python bot in `/opt/tbb_car_notifier` hands over. Do it outside rush hours if you can; alerts for whatever passes
meanwhile are sent afterwards (up to 6 h, marked late), none are lost, none go twice. Takes about 2 minutes.

After `git pull` in `/root/gps`:

```bash
scripts/cutover-notifier.sh --check   # changes nothing: everything in place, and what would be imported
```

```bash
scripts/cutover-notifier.sh           # stops the old bot, imports its state, starts the app with Telegram
```

Check: `docker compose logs --tail 50`, then `/holat` and `/oluvchilar` in the bot (the same group and user as before), and the next
truck at the gate. Settings → System shows Telegram and the top views for the last 24 h.

The old bot's folder stays as it was; keep it for a few days. **To go back:**

```bash
cd /root/gps && sed -i '/^TELEGRAM_BOT_TOKEN=/d;/^ADMIN_IDS=/d' .env && docker compose up -d
```

```bash
cd /opt/tbb_car_notifier && docker compose start
```

The bot then catches up by itself (up to 6 h).

## Telegram mini app

The app inside the bot (README.md, docs/telegram-mini-app-plan.md). The page and its login work as soon as the code is
deployed; these steps make the bot offer it.

1. In Telegram, @BotFather → the bot → Bot Settings → Configure Mini App → Enable, with the address
   `https://tbb-gps.uz/tg/`. This also makes the `t.me/<bot>?startapp` links in alerts work.
2. In `.env`: `TELEGRAM_MINI_APP=1` (and `PUBLIC_ORIGIN=https://tbb-gps.uz`, already there), then `docker compose up -d`.
3. Open the bot in a private chat: the button next to the message box says **Ochish**. Log in once with the site login.
   Each dispatcher does the same on their phone.

To stop offering it: remove `TELEGRAM_MINI_APP`, `docker compose up -d`; the button goes back to Telegram's own. Settings →
Users shows who has linked Telegram, with **Uzish** to remove it.

## Everyday

| | |
|---|---|
| Logs | `docker compose logs -f` |
| Update | `git pull && docker compose up -d --build` |
| Users from the shell | `docker compose exec app npm run user -- list` (also `add`, `password`, `disable`) |
| Backup | copy `data/dispatcher.db` (and `data/photos/` if wanted); `sqlite3 data/dispatcher.db ".backup /root/backup.db"` while running |

Only one instance may run (it polls GoGPS and the NVR).
