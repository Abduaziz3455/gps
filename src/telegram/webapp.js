'use strict';
/**
 * The mini app (docs/telegram-mini-app-plan.md): who opened it, from the data Telegram signs with the bot's token.
 *
 * Telegram hands the page `initData`, a query string with the user, the time it was signed and a hash. The hash is
 * HMAC-SHA256 over the other fields (sorted, `key=value` lines) with the key HMAC-SHA256("WebAppData", bot token).
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * Pure functions: nothing here logs initData, which works as a password for as long as it is fresh.
 */
const crypto = require('node:crypto');

const MAX_AGE_S = 24 * 3600;
const FUTURE_SLACK_S = 60; // the phone's clock doesn't sign it, Telegram's does; a minute covers our own clock

class InitDataError extends Error {
  constructor(message) { super(message); this.status = 401; }
}

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** initData as Telegram would sign it. For tests, and for nothing else. */
function sign(fields, token) {
  const pairs = Object.entries(fields).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]);
  const check = pairs.slice().sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const hash = hmac(hmac('WebAppData', token), check).toString('hex');
  return new URLSearchParams([...pairs, ['hash', hash]]).toString();
}

/**
 * @returns {{id: string, name: string, username: string|null, startParam: string|null, authDate: number}}
 * @throws InitDataError (status 401) when it isn't Telegram's, is too old, or names no user
 */
function verify(initData, token, { now = Date.now(), maxAgeS = MAX_AGE_S } = {}) {
  if (!token) throw new InitDataError('Telegram ulanmagan');
  if (typeof initData !== 'string' || !initData || initData.length > 8192) throw new InitDataError("Telegram ma'lumoti yo'q");
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) throw new InitDataError("Telegram ma'lumoti noto'g'ri");
  const pairs = [...params].filter(([k]) => k !== 'hash');
  if (new Set(pairs.map(([k]) => k)).size !== pairs.length) throw new InitDataError("Telegram ma'lumoti noto'g'ri");
  const check = pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const expected = hmac(hmac('WebAppData', token), check);
  if (!crypto.timingSafeEqual(expected, Buffer.from(hash, 'hex'))) throw new InitDataError("Telegram ma'lumoti tasdiqlanmadi");

  const authDate = Number(params.get('auth_date'));
  const ageS = now / 1000 - authDate;
  if (!Number.isFinite(authDate) || ageS < -FUTURE_SLACK_S) throw new InitDataError("Telegram ma'lumoti noto'g'ri");
  if (ageS > maxAgeS) throw new InitDataError("Ilova uzoq vaqt ochiq turdi: uni yopib, qaytadan oching");

  let user;
  try { user = JSON.parse(params.get('user') || 'null'); } catch { user = null; }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) throw new InitDataError("Telegram foydalanuvchisi aniqlanmadi");
  const name = [user.first_name, user.last_name].filter((s) => typeof s === 'string' && s).join(' ').slice(0, 80);
  return {
    id: String(user.id),
    name: name || (typeof user.username === 'string' ? user.username : String(user.id)),
    username: typeof user.username === 'string' ? user.username : null,
    startParam: params.get('start_param'),
    authDate: authDate * 1000,
  };
}

module.exports = { verify, sign, InitDataError, MAX_AGE_S };
