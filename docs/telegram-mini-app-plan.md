# Telegram mini app: plan

Status: built 13 Nov 2026, as planned below. How it works now: docs/ARCHITECTURE.md section 7c. Tests:
`test/webapp.test.js`, the mini app tests in `test/api.test.js` and `test/telegram.test.js`, and
`test/e2e/ui/tg.spec.js` (Chromium and iPhone WebKit). One addition to the plan: `sessions.via`, so unlinking ends the
mini app's sessions and leaves the site's alone. Written 13 Nov 2026.

A small version of TBB Dispatcher that opens inside the existing Telegram bot, for the owner and the dispatchers.
It answers "what is happening now" in a few taps: where the trucks are, who passed the gate, what needs attention,
today's numbers. Everything else stays on the full site. It runs on the same server, database and API as the site,
so the numbers always agree.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Who may open it | Only people with a site account. They log in once inside the mini app; after that it opens by itself | One list of people and one set of roles. Disabling a user on the site closes both doors |
| What it may change | Nothing, except acknowledging alerts | Corrections (gate events, plates, places, users) need the bigger screen and stay on the site |
| Language | Uzbek only | Same as the site and the bot |
| Where it runs | Telegram on phones and Telegram Desktop. Not Telegram Web in a browser | The site forbids being put in a frame, and browsers block the login cookie there. People in a browser use the site itself |
| How it stays logged in | The normal session cookie, renewed from Telegram's signed data at every open, valid 24 h | Every existing API route, photo and the live stream then work unchanged |
| Notifications | None of its own | The bot already sends the alerts |

## 1. Screens

Bottom bar: Bugun, Xarita, Darvoza, Hisobot. Alerts open from a bell at the top with the open count, as on the site.

| Screen | Shows | Actions | Existing API it reads |
|---|---|---|---|
| **Bugun** | Trucks moving / idling / parked / without signal; in the yard now (ours and outside); today's trips and km; open alerts; a banner when GPS, the NVR or a camera is down | Tap a number to open that list | `/api/today`, `/api/alerts?state=open`, `/api/health` |
| **Xarita** | All trucks live, the yard, named places | Search by plate or name, filter by status, tap a truck for its card | `/api/vehicles`, `/api/places`, `/api/tiles`, live stream |
| **Darvoza** | Latest entries and exits with the plate photo and the top view; a second tab with who is in the yard and for how long | Filter in / out / ours / outside, open photos full screen, load older | `/api/gate-events`, `/api/yard`, `/api/gate-events/:id/photo/:n` |
| **Mashina** (truck card, opened from the map, the gate or a report row) | Status, speed, where it is (place name or address), signal age, today's km and fuel, today's trips with times and destinations, today's track on a small map, last gate pass | Switch to yesterday, open the position in a maps app | `/api/vehicles`, `/api/trips?vehicle=`, `/api/vehicles/:id/track` |
| **Ogohlantirishlar** | Open alerts first: fuel drain, no signal, long stop, system problems | Acknowledge one or all; tap to open the truck | `/api/alerts`, `/api/alerts/:id/ack`, `/api/alerts/ack-all` |
| **Hisobot** | Per-truck table of km, fuel, refuels, drains and trips, with totals | Today / yesterday / this month; tap a row for the truck | `/api/reports/vehicles` |

Every screen updates live from the same stream as the site (`/api/stream`): positions every 10 s, gate events and
alerts as they happen.

**Not in the mini app:** analytics charts (Tahlil), the trip record with CSV (Reyslar), places management (Joylar),
users, vehicle settings, unknown plates, manual gate corrections, push settings, system details. A "To'liq sayt"
link in the user menu opens the site in the browser.

**Changed from the first outline:** "share a truck's location to a chat" became "open in a maps app". Telegram gives
a mini app no simple way to post into a chat; the maps link is one line.

## 2. Getting in

1. The person opens the mini app. Telegram hands the page a signed description of who they are (`initData`).
2. The page sends it to `POST /api/auth/telegram`. The server checks the signature with the bot token
   (HMAC-SHA256, the scheme in Telegram's documentation) and that it is under 24 h old.
3. **Telegram account already linked to a site user:** the server sets the session cookie and the app opens.
4. **Not linked:** the app shows the site's login form once. `POST /api/auth/telegram/link` checks the login and
   password (with the site's existing throttling), stores the person's Telegram id on their user, and opens the app.
5. A disabled user is refused. A password change does not unlink Telegram.

Unlinking: the person, from the mini app's user menu; the owner, from Settings → Users on the site, where each user
shows "Telegram: ulangan" or nothing.

One Telegram account links to one site user and the other way round. Linking a second Telegram account to a user
replaces the first.

Opened outside Telegram (no signed data), the page says it works inside Telegram and links to the site.

## 3. Changes to the bot

| Change | Detail |
|---|---|
| Menu button | In private chats the bot's menu button becomes "Ochish" and opens the mini app (`setChatMenuButton`, set at start) |
| `/app` command | Private chat: a button that opens the mini app. Group: a `t.me/<bot>?startapp` link |
| Link in every gate alert | One line at the end of the caption, "Ilovada ochish", linking to `t.me/<bot>?startapp=e<event id>`, which opens that pass with its photos. A link, not a button: alerts go out as photo albums, and Telegram allows no buttons on albums |
| Link in system and vehicle alerts | The same, opening the alerts screen or the truck (`startapp=a`, `startapp=v<vehicle id>`) |

The `startapp` links work only after the mini app is registered in BotFather (section 6), so the links are added only
when `TELEGRAM_MINI_APP=1` is set.

## 4. How it is built

Same style as the site: plain ES modules, no build step.

| Part | Where | What |
|---|---|---|
| Page | `public/tg/index.html`, `public/css/tg.css` | Loads Telegram's script and the app. Follows Telegram's light or dark mode with the site's existing colour tokens |
| App | `public/js/tg/main.js`, `public/js/tg/pages/*.js` | Shell, bottom bar, Telegram's back button and haptics, the `startapp` parameter. Reuses `public/js/api.js`, `ui.js`, `map.js`, `places.js` |
| Signature check | `src/telegram/webapp.js` | A pure function: `initData` and bot token in, Telegram user or an error out |
| Login and linking | `src/auth.js`, `src/api.js` | `telegramLogin`, `telegramLink`, `telegramUnlink`; the three routes; `telegramLinked` in the user view |
| Database | `src/db.js` | `users.telegram_id` (added column) with a unique index |
| Serving | `server.js`, `src/http.js` | `/tg/` serves the mini app page with its own content policy, which also allows `https://telegram.org` scripts. Every other page keeps today's policy |
| Bot | `src/telegram/client.js`, `commands.js`, `format.js`, `index.js` | `setChatMenuButton`, an optional keyboard on `sendText`, the `/app` command, the link line in captions |
| Site | `public/js/pages/settings.js` | Telegram state and "Uzish" per user |
| Config | `src/config.js`, `.env.example` | `TELEGRAM_MINI_APP` |

No change to nginx: `/tg/` goes through the existing `location /`.

**Security**
- The bot token is the signing key and never leaves the server. `initData` is never logged.
- The signature is compared in constant time; data older than 24 h is refused.
- Linking needs the site password and is throttled per IP and per Telegram id, like the login.
- After linking, whoever controls the Telegram account can open the app without a password. The owner should turn on
  Telegram's two-step verification; the owner can unlink anyone at any time.
- The repository is public: tests use a made-up token and made-up ids.

## 5. Order of work

Each step can be deployed by itself.

| Step | What | Done when |
|---|---|---|
| 1. Foundation | Signature check, login and linking routes, `telegram_id`, the `/tg/` page and shell, menu button, unlink on the site | Unit tests for the signature (valid, tampered, expired, wrong token); linking and unlinking through the API; the app opens in Telegram on a phone and shows the user's name |
| 2. Bugun, Darvoza, Ogohlantirishlar | The three screens people check most | A pass at the gate appears live with its photos; acknowledging an alert shows on the site at once |
| 3. Xarita and Mashina | Live map, truck card, today's track | Positions move every 10 s; the card's numbers match the site's vehicle page |
| 4. Hisobot and links | Report screen, `/app`, link lines in alerts | The report's totals match `/bugun`; a link in a group alert opens that pass |

Tests: unit tests beside the existing ones (`test/webapp.test.js`, additions to `test/telegram.test.js` and
`test/api.test.js`). End-to-end with Playwright in mock mode: the tests sign their own `initData` with a test token
and replace Telegram's script with a stub. A last check on a real phone against production, since only Telegram's
own clients show how the page really behaves.

## 6. Setup on the day (once)

1. BotFather → the bot → Bot Settings → Configure Mini App: enable it with the URL `https://tbb-gps.uz/tg/`.
2. `TELEGRAM_MINI_APP=1` in `.env`, then the usual `git pull && docker compose up -d --build`.
3. The owner opens the bot, presses "Ochish", logs in once. Then each dispatcher does the same.

## 7. Risks

| Risk | What we do |
|---|---|
| A phone can't load Telegram's script from telegram.org | The page shows "Telegram bilan aloqa yo'q" with a retry, and the link to the site |
| Telegram's in-app browser behaves differently per platform (iOS, Android, Desktop) | Checked on all three before step 2 is called done |
| The map is heavy in a small in-app browser | The same tile queue as the site (6 at a time); the truck card's map loads only when opened |
| People expect to fix things from it | The user menu says where: "Tuzatishlar to'liq saytda" |

## 8. Later, if the first version is used

- Gate corrections from the mini app.
- The bot sends a truck's location into the chat on request.
- A view-only role for everyone in the connected group, without accounts.
- Telegram Web in a browser (needs a different login method and a relaxed frame policy for `/tg/` only).
