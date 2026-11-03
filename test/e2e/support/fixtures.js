'use strict';
/**
 * `test` for API specs: a server per worker, signed-in clients, and a check after every test that the server is
 *  still alive (one crash shouldn't look like dozens of unrelated failures).
 * `uiTest` adds the browser: no external requests, no uncaught page errors, no console errors.
 */
const base = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { TestServer, ACCOUNTS } = require('./server');
const { Api } = require('./api');

const test = base.test.extend({
  server: [async ({}, use, workerInfo) => {
    const s = new TestServer({ name: `w${workerInfo.workerIndex}` }).seedFrom(process.env.E2E_TEMPLATE_DIR);
    await s.start();
    await use(s);
    await s.destroy();
  }, { scope: 'worker', timeout: 180_000 }],

  baseURL: async ({ server }, use) => { await use(server.url); },

  anon: async ({ server }, use) => { await use(new Api(server.url)); },
  owner: async ({ server }, use) => {
    const a = new Api(server.url);
    const r = await a.login(ACCOUNTS.owner.username, ACCOUNTS.owner.password);
    if (r.status !== 200) throw new Error(`owner login failed: ${r.status} ${r.text}`);
    await use(a);
  },
  dispatcher: async ({ server }, use) => {
    const a = new Api(server.url);
    const r = await a.login(ACCOUNTS.dispatcher.username, ACCOUNTS.dispatcher.password);
    if (r.status !== 200) throw new Error(`dispatcher login failed: ${r.status} ${r.text}`);
    await use(a);
  },

  serverStaysUp: [async ({ server }, use) => {
    await use();
    if (!server.alive) throw new Error(`The server process died during this test (exit ${server.exitCode}):\n${server.log.slice(-1200)}`);
  }, { auto: true }],
});

const isLocal = (u) => u.hostname === '127.0.0.1' || u.hostname === 'localhost';
const isTile = (u) => u.pathname.startsWith('/api/tiles/');

/** The browser side, usable with any server fixture (real.spec.js and the resilience specs bring their own). */
const browserFixtures = {
  externalRequests: [async ({ context }, use, testInfo) => {
    const blocked = [];
    const tile = fs.readFileSync(path.join(process.env.E2E_TMP, 'tile.png'));
    await context.route(isTile, (route) => route.fulfill({ status: 200, contentType: 'image/png', body: tile }));
    await context.route((u) => !isLocal(u) && !['data:', 'blob:'].includes(u.protocol), (route) => {
      const u = new URL(route.request().url());
      blocked.push(u.href);
      return route.abort();
    });
    await use(blocked);
    if (!testInfo.annotations.some((a) => a.type === 'allow-external')) base.expect(blocked, 'the app must not call anything but its own server and map tiles').toEqual([]);
  }, { auto: true }],

  page: async ({ page }, use, testInfo) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(`uncaught: ${e.message}`));
    page.on('console', (m) => {
      // Failed requests are logged as console errors by the browser; those the tests assert on themselves.
      if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_REFUSED/.test(m.text())) errors.push(`console: ${m.text()}`);
    });
    await use(page);
    if (!testInfo.annotations.some((a) => a.type === 'allow-errors')) base.expect(errors, 'no uncaught errors or console errors').toEqual([]);
  },

  /** Open the app signed in as that role. */
  signIn: async ({ page, context, server }, use) => {
    await use(async (role, hash = 'xarita') => {
      const a = new Api(server.url);
      const acc = typeof role === 'string' ? ACCOUNTS[role] : role;
      const r = await a.login(acc.username, acc.password);
      if (r.status !== 200) throw new Error(`login as ${acc.username} failed: ${r.status} ${r.text}`);
      await context.addCookies([{ name: 'tbb_session', value: a.token, url: server.url, httpOnly: true, sameSite: 'Lax' }]);
      await page.goto(`${server.url}/#/${hash}`);
      await page.locator('#app').waitFor({ state: 'visible' });
      return a;
    });
  },
};
const uiTest = test.extend(browserFixtures);

module.exports = { test, uiTest, expect: base.expect, browserFixtures };
