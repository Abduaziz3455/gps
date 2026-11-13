'use strict';
// End-to-end suite. See test/e2e/README.md.
//   npm run test:e2e        simulator: API, UI, resilience, cross-browser (never touches real systems)
//   npm run test:e2e:real   the real GoGPS + NVR from .env, one local server, throwaway database
const { defineConfig, devices } = require('@playwright/test');

const OUT = 'test/e2e/.output';
const REAL = process.env.E2E_REAL === '1';

const desktop = { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } };

const simulated = [
  { name: 'api', testDir: 'test/e2e/api' },
  { name: 'ui', testDir: 'test/e2e/ui', testIgnore: /(mobile|smoke)\.spec/, use: desktop },
  { name: 'mobile', testDir: 'test/e2e/ui', testMatch: /mobile\.spec/, use: { ...devices['Pixel 7'] } },
  { name: 'resilience', testDir: 'test/e2e/resilience', use: desktop },
  // Smoke on the other engines: iPhones (WebKit) are a primary target of the app.
  { name: 'firefox', testDir: 'test/e2e/ui', testMatch: /smoke\.spec/, use: { ...devices['Desktop Firefox'] } },
  { name: 'webkit', testDir: 'test/e2e/ui', testMatch: /smoke\.spec/, use: { ...devices['Desktop Safari'] } },
  { name: 'iphone', testDir: 'test/e2e/ui', testMatch: /(smoke|tg)\.spec/, use: { ...devices['iPhone 14'] } }, // tg: Telegram's iPhone app is WebKit too
];

module.exports = defineConfig({
  globalSetup: require.resolve('./test/e2e/support/global-setup.js'),
  globalTeardown: require.resolve('./test/e2e/support/global-teardown.js'),
  outputDir: `${OUT}/artifacts`,
  fullyParallel: false,
  retries: 0, // a flaky pass would hide a real bug; failures are reported as they are
  workers: REAL ? 1 : 3, // each worker has its own server cloned from the seeded template
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { outputFolder: `${OUT}/report`, open: 'never' }], ['json', { outputFile: `${OUT}/results${REAL ? '-real' : ''}.json` }]],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure', actionTimeout: 15_000, navigationTimeout: 30_000 },
  projects: REAL ? [{ name: 'real', testDir: 'test/e2e/real', use: desktop, timeout: 300_000 }] : simulated,
});
