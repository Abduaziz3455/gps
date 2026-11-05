#!/bin/bash
# Moves the Telegram bot from the old Python program to this app, keeping its state. See START_PROJECT.md.
#   scripts/cutover-notifier.sh --check   looks only: changes nothing, stops nothing
#   scripts/cutover-notifier.sh           does it
set -euo pipefail

OLD=${OLD:-/opt/tbb_car_notifier}
APP=$(cd "$(dirname "$0")/.." && pwd)
# From the old config.toml. Only those whose GPS vehicle still exists are applied.
ALIASES="10964DDA=85 519 EBA,10840HDA=37,10863HDA=32,10865HDA=35,10872HDA=31,10870HDA=33"
NODE="node --disable-warning=ExperimentalWarning"
CHECK=0; [ "${1:-}" = "--check" ] && CHECK=1

say() { printf '%s\n' "$*"; }
die() { say "STOP: $*"; exit 1; }

cd "$APP"
[ -f "$OLD/.env" ] || die "no $OLD/.env"
[ -f "$OLD/data/events.db" ] || die "no $OLD/data/events.db"
[ -f .env ] || die "no $APP/.env"
docker compose ps app >/dev/null || die "docker compose doesn't work here"
grep -q '^TELEGRAM_BOT_TOKEN=' "$OLD/.env" || die "the old bot has no TELEGRAM_BOT_TOKEN"
grep -q '^TELEGRAM_BOT_TOKEN=' .env && die "this app already has a TELEGRAM_BOT_TOKEN: it was moved before?"

# A copy, because a stopped bot can leave a write-ahead log that a read-only reader must be able to use.
WORK=data/notifier-import
copy_state() {
  rm -rf "$WORK"; mkdir -p "$WORK"
  cp -a "$OLD"/data/events.db* "$WORK"/
  chown -R 1000:1000 "$WORK"
}
run_import() {
  local data=(); [ "${1:-}" = "--dry-run" ] && data=(-e DATA_DIR=/app/data/notifier-import/app)
  docker compose run --rm --no-deps -T -e TELEGRAM_BOT_TOKEN= "${data[@]}" -v "$OLD/data/alerts:/notifier-alerts:ro" app \
    $NODE scripts/import-notifier.js --db /app/data/notifier-import/events.db --alerts /notifier-alerts --aliases "$ALIASES" "$@"
}

say "Building the new image (the running app isn't touched yet)"
docker compose build

if [ "$CHECK" = 1 ]; then
  say "--- dry run on copies of both databases; both programs keep running, untouched"
  copy_state
  docker compose run --rm --no-deps -T -e TELEGRAM_BOT_TOKEN= app sh -c 'ffmpeg -version | head -1'
  mkdir -p "$WORK/app"; chown 1000:1000 "$WORK/app"
  docker compose run --rm --no-deps -T -e TELEGRAM_BOT_TOKEN= app $NODE -e \
    "new (require('node:sqlite').DatabaseSync)('/app/data/dispatcher.db').exec(\"VACUUM INTO '/app/data/notifier-import/app/dispatcher.db'\")"
  run_import --dry-run
  rm -rf "$WORK"
  say "--- check finished: nothing was changed"
  exit 0
fi

say "1/4 Stopping the old bot first: two programs with one token would send every alert twice"
(cd "$OLD" && docker compose stop)
say "2/4 Stopping the app and importing the bot's state"
docker compose stop app
copy_state
run_import
rm -f "$WORK"/events.db*; rmdir "$WORK"
say "3/4 Giving the app the bot's token and admins"
grep -E '^(TELEGRAM_BOT_TOKEN|ADMIN_IDS|TELEGRAM_CHAT_IDS)=' "$OLD/.env" >> .env
say "4/4 Starting the app"
docker compose up -d
say "Done. The old bot stays stopped, also after a reboot (its policy is unless-stopped). Check: docker compose logs --tail 50, then /holat and /oluvchilar in the bot."
