# Deploy TBB Dispatcher v2

Server: Ubuntu with nginx and Docker (tbbdispatcher.uz, 38.242.242.133). Takes over from v1 in the same folder.

## 1. Before you start

- The NVR must be reachable from this server: `curl -s -o /dev/null -w '%{http_code}\n' http://<NVR_HOST>/ISAPI/System/deviceInfo`
  must print `401` (= it answers and wants a password). If it times out, allow 38.242.242.133 on the site router.
- GoGPS login and the NVR password: the same values as in the notifier's `.env` on the `icall` server.

## 2. Get the code

```bash
cd /root/tbb_dispatcher
```

```bash
git fetch origin && git checkout main && git pull
```

## 3. Configure

```bash
cp .env.example .env && nano .env
```

Fill in `GPS_LOGIN`, `GPS_PASSWORD`, `NVR_HOST`, `NVR_PASSWORD`, `OWNER_USERNAME`, `OWNER_PASSWORD`
(the first owner account; 8+ characters), `PUBLIC_ORIGIN=https://tbbdispatcher.uz`.

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

Expect: `GPS fleet: 20 vehicles`, `camera history: importing 30 days`, then `rollup ... done` for 30 days
(a few minutes: GoGPS allows one request per second).

```bash
curl -s http://127.0.0.1:8090/health
```

## 5. nginx

The new config adds the live-stream location (no buffering). Certificates stay where certbot put them.

```bash
cp nginx.conf /etc/nginx/sites-available/tbbdispatcher.uz && nginx -t && systemctl reload nginx
```

## 6. After the switch

1. Log in at https://tbbdispatcher.uz as the owner. Settings → Users: create the dispatchers' accounts.
2. Settings → Vehicles: set each truck's type and, where GoGPS names it differently, its real plate
   (suggestions appear once the cameras have seen it).
3. **Change the GoGPS password** (v1 published it in the page source), then update `GPS_PASSWORD` here and in the
   notifier's `.env` on `icall`, and restart both.
4. Phones: open the site, add it to the Home Screen (iPhone: Share → Add to Home Screen), Settings →
   Notifications → Turn on.
5. Remove `OWNER_PASSWORD` from `.env`.
6. Optional, recommended: an outside uptime check, for the one case the server can't report itself (it is
   completely down). Any free monitor (UptimeRobot, Better Stack…) on `https://tbbdispatcher.uz/health`
   every 5 minutes, alerting to Telegram or SMS.
7. Optional: set `SITE_ROUTER` in `.env` (a port the plant router itself answers on), so the app can tell
   "plant internet down" from "NVR off".

## Everyday

| | |
|---|---|
| Logs | `docker compose logs -f` |
| Update | `git pull && docker compose up -d --build` |
| Users from the shell | `docker compose exec app npm run user -- list` (also `add`, `password`, `disable`) |
| Backup | copy `data/dispatcher.db` (and `data/photos/` if wanted); `sqlite3 data/dispatcher.db ".backup /root/backup.db"` while running |

Only one instance may run (it polls GoGPS and the NVR).
