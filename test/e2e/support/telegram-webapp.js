'use strict';
/**
 * The mini app in a test browser: a stand-in for Telegram's telegram-web-app.js, with initData signed by the test bot
 * token, so the real login runs. What the page asks of Telegram is recorded on window.__tg.
 */
const { sign } = require('../../../src/telegram/webapp');

const TOKEN = 'TEST:TOKEN';
const SCRIPT = 'https://telegram.org/js/telegram-web-app.js';

function initData({ id = 555001, first = 'Ali', last = 'Valiyev', startParam = null, authDate = Math.floor(Date.now() / 1000), token = TOKEN } = {}) {
  const fields = { auth_date: authDate, query_id: 'AAE-test', user: { id, first_name: first, last_name: last, username: 'ali_test', language_code: 'uz' } };
  if (startParam) fields.start_param = startParam;
  return sign(fields, token);
}

function stub({ data = '', startParam = '', scheme = 'light' } = {}) {
  return `(() => {
    const rec = { back: false, opened: [], closed: false, confirms: [] };
    window.__tg = rec;
    let backFn = null;
    window.Telegram = { WebApp: {
      initData: ${JSON.stringify(data)}, initDataUnsafe: { start_param: ${JSON.stringify(startParam)} || undefined },
      version: '8.0', platform: 'ios', colorScheme: ${JSON.stringify(scheme)}, themeParams: {},
      isVersionAtLeast: () => true, ready() {}, expand() {}, disableVerticalSwipes() {}, onEvent() {},
      setHeaderColor() {}, setBackgroundColor() {}, setBottomBarColor() {},
      BackButton: { onClick(f) { backFn = f; }, offClick() { backFn = null; }, show() { rec.back = true; }, hide() { rec.back = false; } },
      HapticFeedback: { impactOccurred() {}, notificationOccurred() {}, selectionChanged() {} },
      showConfirm(text, cb) { rec.confirms.push(text); cb(true); },
      openLink(u) { rec.opened.push(u); },
      close() { rec.closed = true; },
    } };
    window.__tgBack = () => backFn && backFn();
  })();`;
}

/** Serve the stand-in instead of Telegram's script. Registered last, so it wins over the fixture that blocks the internet. */
async function routeTelegram(context, o = {}) {
  await context.route(SCRIPT, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: stub(o) }));
}

module.exports = { TOKEN, SCRIPT, initData, stub, routeTelegram };
