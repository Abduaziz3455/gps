# End-to-end tests

Every test drives the real `server.js` as a separate process, over HTTP and in real browsers.

```bash
npm install
npx playwright install chromium firefox webkit
```

## Simulator: `npm run test:e2e`

About 5 minutes. Safe to run anywhere, at any time.

| Project | Covers |
|---|---|
| `api` | Every route: who may call it, inputs, limits, calculations, push, live stream, static files |
| `ui` | Every page in Chromium, as owner and as dispatcher |
| `mobile` | The main tasks by touch on a phone |
| `resilience` | Malformed requests, each kind of outage and its recovery, restarts, first run, production settings, the `npm run user` tool, losing the connection |
| `firefox`, `webkit`, `iphone` | The main path on the other browser engines |

How it is kept safe and repeatable:

- Servers run from a copy of the app **without `.env`**, in a temp folder, so they cannot reach the real GPS or NVR.
- Each worker gets its own server, cloned from a template seeded once at the start.
- Map tiles are stubbed, and any other request to an outside address fails the test.

A failing test here means a bug, unless the test itself is wrong. There are no retries, on purpose.

## Real systems: `npm run test:e2e:real`

About 10 minutes. Uses `GPS_*` and `NVR_*` from `.env`, through one local server with a throwaway database.

- It only reads from GoGPS and the NVR. The test server starts with no push subscriptions, so no phone is notified.
- It adds to the load on the GoGPS account while it runs: live polling plus the report import, shared with whatever else uses that account. The import takes about 50 s per day, so it does not wait for all 30 days.
- The NVR only answers from IPs the plant router allows. **Run this on the production server to test the cameras**; elsewhere the camera tests are skipped and the app's behaviour during an outage is tested instead.

## Results

In `test/e2e/.output/` (not committed): `report/` is the HTML report (`npx playwright show-report test/e2e/.output/report`), `results*.json` the raw results, `artifacts/` holds traces of failed tests.

The output can contain the NVR's address and live fleet data after a real run. Don't share it publicly.

## Useful commands

```bash
npx playwright test --project=api                 # one project
npx playwright test crash                         # files matching a word
npx playwright test -g "last owner"               # tests matching a title
```
