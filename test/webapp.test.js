'use strict';
// The mini app's login: Telegram's signed initData (src/telegram/webapp.js) checked against the bot token.
const test = require('node:test');
const assert = require('node:assert');
const { verify, sign, MAX_AGE_S } = require('../src/telegram/webapp');

const TOKEN = '123456:TEST-token';
const now = Date.UTC(2026, 10, 13, 8, 0, 0);
const user = { id: 555001, first_name: 'Ali', last_name: 'Valiyev', username: 'ali_test' };
const fields = (o = {}) => ({ auth_date: Math.floor(now / 1000) - 60, query_id: 'AAE1', user, ...o });

test('initData signed with the bot token is accepted', () => {
  const tg = verify(sign(fields({ start_param: 'e42' }), TOKEN), TOKEN, { now });
  assert.deepEqual(tg, { id: '555001', name: 'Ali Valiyev', username: 'ali_test', startParam: 'e42', authDate: now - 60e3 });
});

test('the order of the fields does not matter, Telegram sorts them for the hash', () => {
  const data = sign(fields(), TOKEN);
  const reordered = new URLSearchParams([...new URLSearchParams(data)].reverse()).toString();
  assert.equal(verify(reordered, TOKEN, { now }).id, '555001');
});

test('a known example: the hash Telegram computes for these fields', () => {
  // Computed independently: HMAC-SHA256(key = HMAC-SHA256("WebAppData", token), "auth_date=1\nuser={\"id\":7}")
  const crypto = require('node:crypto');
  const key = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const hash = crypto.createHmac('sha256', key).update('auth_date=1\nuser={"id":7}').digest('hex');
  const data = `auth_date=1&user=${encodeURIComponent('{"id":7}')}&hash=${hash}`;
  assert.equal(verify(data, TOKEN, { now: 2000, maxAgeS: 10 }).id, '7');
});

test('refused: changed fields, another bot, no hash, repeated fields', () => {
  const data = sign(fields(), TOKEN);
  const other = data.replace('555001', '555002');
  assert.throws(() => verify(other, TOKEN, { now }), { status: 401, message: /tasdiqlanmadi/ });
  assert.throws(() => verify(data, '999:OTHER', { now }), { status: 401 });
  assert.throws(() => verify(data.replace(/&?hash=[0-9a-f]+/, ''), TOKEN, { now }), { status: 401 });
  assert.throws(() => verify(`${data}&user=${encodeURIComponent(JSON.stringify({ id: 1 }))}`, TOKEN, { now }), { status: 401 });
  assert.throws(() => verify('', TOKEN, { now }), { status: 401 });
  assert.throws(() => verify(undefined, TOKEN, { now }), { status: 401 });
  assert.throws(() => verify(data, '', { now }), { status: 401 }, 'no bot token: nothing can be checked');
});

test('refused: older than a day, or from the future', () => {
  const old = sign(fields({ auth_date: Math.floor(now / 1000) - MAX_AGE_S - 5 }), TOKEN);
  assert.throws(() => verify(old, TOKEN, { now }), { status: 401, message: /qaytadan oching/ });
  const future = sign(fields({ auth_date: Math.floor(now / 1000) + 600 }), TOKEN);
  assert.throws(() => verify(future, TOKEN, { now }), { status: 401 });
  const slightly = sign(fields({ auth_date: Math.floor(now / 1000) + 30 }), TOKEN);
  assert.equal(verify(slightly, TOKEN, { now }).id, '555001', 'clocks a little apart are fine');
});

test('refused: signed, but no usable user', () => {
  for (const u of [null, { first_name: 'x' }, { id: -5 }, { id: 'abc' }]) {
    const data = sign({ auth_date: Math.floor(now / 1000), user: u }, TOKEN);
    assert.throws(() => verify(data, TOKEN, { now }), { status: 401 }, JSON.stringify(u));
  }
  const broken = sign({ auth_date: Math.floor(now / 1000), user: '{not json' }, TOKEN);
  assert.throws(() => verify(broken, TOKEN, { now }), { status: 401 });
});

test('a user with only a username or only an id still gets a name', () => {
  assert.equal(verify(sign(fields({ user: { id: 9, username: 'boss' } }), TOKEN), TOKEN, { now }).name, 'boss');
  assert.equal(verify(sign(fields({ user: { id: 9 } }), TOKEN), TOKEN, { now }).name, '9');
});
