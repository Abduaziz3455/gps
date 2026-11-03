'use strict';
const { test, expect } = require('../support/fixtures');
const { Api } = require('../support/api');
const { uid, alert } = require('../support/seed');

const mk = (owner, o = {}) => owner.post('/api/users', { username: `u${uid()}`, role: 'dispatcher', password: 'password-1', ...o });

test.describe('creating users', () => {
  test('a valid user appears in the list, and can log in', async ({ owner, server }) => {
    const username = `new.user_${uid()}-1`;
    const r = await mk(owner, { username, name: 'Ali Valiyev' });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ username, name: 'Ali Valiyev', role: 'dispatcher', disabled: false, lastLoginAt: null });
    expect(JSON.stringify(r.data)).not.toMatch(/hash|password/i);
    expect((await owner.get('/api/users')).data.some((u) => u.username === username)).toBe(true);
    expect((await new Api(server.url).login(username, 'password-1')).status).toBe(200);
  });

  test('no name given: the login is used as the name', async ({ owner }) => {
    const username = `n${uid()}`;
    expect((await mk(owner, { username })).data.name).toBe(username);
  });

  test('a long name is cut to 80 characters', async ({ owner }) => {
    expect((await mk(owner, { name: 'x'.repeat(200) })).data.name.length).toBe(80);
  });

  for (const [name, username] of [['too short', 'ab'], ['too long', 'a'.repeat(33)], ['space', 'ab cd'], ['Cyrillic', 'алиев'], ['HTML', '<b>x</b>'], ['quote', "a'b"], ['empty', ''], ['missing', undefined], ['null', null]]) {
    test(`invalid login is refused: ${name}`, async ({ owner }) => {
      expect((await mk(owner, { username })).status).toBe(400);
    });
  }

  for (const [name, body] of [
    ['login as a number', { username: 12345 }],
    ['login as an array', { username: ['abc123'] }],
    ['name as a number', { name: 12345 }],
    ['name as an object', { name: { a: 1 } }],
    ['role as an array', { role: ['owner'] }],
    ['password as an array', { password: ['password-1'] }],
  ]) {
    test(`wrong types are a client error, not a server error: ${name}`, async ({ owner }) => {
      expect((await mk(owner, body)).status).toBeLessThan(500);
    });
  }

  for (const [name, body] of [['null', 'null'], ['a number', '5'], ['an array', '[]']]) {
    test(`body that isn't an object is a client error: ${name}`, async ({ owner }) => {
      const r = await owner.call('POST', '/api/users', { rawBody: body, headers: { 'content-type': 'application/json' } });
      expect(r.status).toBeLessThan(500);
    });
  }

  test('unknown role: 400', async ({ owner }) => {
    expect((await mk(owner, { role: 'admin' })).status).toBe(400);
  });

  test('short password: 400; exactly 8 characters: accepted', async ({ owner }) => {
    expect((await mk(owner, { password: '1234567' })).status).toBe(400);
    expect((await mk(owner, { password: '12345678' })).status).toBe(200);
  });

  test('duplicate login: 409, including another case', async ({ owner }) => {
    const username = `dup${uid()}`;
    await mk(owner, { username });
    expect((await mk(owner, { username })).status).toBe(409);
    expect((await mk(owner, { username: username.toUpperCase() })).status, 'the column is COLLATE NOCASE').toBe(409);
  });
});

test.describe('updating users', () => {
  test('name and role change', async ({ owner }) => {
    const { data } = await mk(owner);
    const r = await owner.patch(`/api/users/${data.id}`, { name: 'Yangi Ism', role: 'owner' });
    expect(r.data).toMatchObject({ name: 'Yangi Ism', role: 'owner' });
  });

  test('a refused update changes nothing at all', async ({ owner, server }) => {
    const { data } = await mk(owner, { name: 'Oldin' });
    const r = await owner.patch(`/api/users/${data.id}`, { name: 'Keyin', password: 'short' });
    expect(r.status).toBe(400);
    expect(server.get('SELECT name FROM users WHERE id = ?', data.id).name, 'the name must not change when the request is refused').toBe('Oldin');
  });

  test('an unknown role is refused', async ({ owner }) => {
    const { data } = await mk(owner);
    expect((await owner.patch(`/api/users/${data.id}`, { role: 'root' })).status).toBe(400);
  });

  test('unknown id: 404. Bad id: 400', async ({ owner }) => {
    expect((await owner.patch('/api/users/999999', { name: 'x' })).status).toBe(404);
    expect((await owner.patch('/api/users/abc', { name: 'x' })).status).toBe(400);
    expect((await owner.patch('/api/users/1.5', { name: 'x' })).status).toBe(400);
  });

  test('a password reset by the owner signs that user out', async ({ owner, server }) => {
    const { data } = await mk(owner, { username: `rs${uid()}` });
    const c = new Api(server.url);
    await c.login(data.username, 'password-1');
    expect((await owner.patch(`/api/users/${data.id}`, { password: 'reset-password-1' })).status).toBe(200);
    expect((await c.get('/api/me')).status).toBe(401);
    expect((await new Api(server.url).login(data.username, 'reset-password-1')).status).toBe(200);
  });

  test('disable: signed out at once. Enable: can log in again', async ({ owner, server }) => {
    const { data } = await mk(owner, { username: `dt${uid()}` });
    const c = new Api(server.url);
    await c.login(data.username, 'password-1');
    await owner.patch(`/api/users/${data.id}`, { disabled: true });
    expect((await c.get('/api/me')).status).toBe(401);
    await owner.patch(`/api/users/${data.id}`, { disabled: false });
    expect((await new Api(server.url).login(data.username, 'password-1')).status).toBe(200);
  });

  test('nobody can disable themselves', async ({ owner }) => {
    const me = (await owner.get('/api/me')).data.user;
    const second = await mk(owner, { role: 'owner' });
    expect(second.status).toBe(200);
    expect((await owner.patch(`/api/users/${me.id}`, { disabled: true })).status).toBe(400);
    await owner.del(`/api/users/${second.data.id}`);
  });
});

test.describe('the last owner is protected', () => {
  test('cannot be demoted, disabled or deleted; a second owner makes it possible', async ({ owner, server }) => {
    server.run("UPDATE users SET disabled = 1 WHERE role = 'owner' AND username != 'owner'");
    const me = (await owner.get('/api/me')).data.user;
    expect((await owner.patch(`/api/users/${me.id}`, { role: 'dispatcher' })).status).toBe(400);
    expect((await owner.get('/api/me')).data.user.role).toBe('owner');
    const second = (await mk(owner, { role: 'owner', username: `o${uid()}` })).data;
    const c = new Api(server.url);
    await c.login(second.username, 'password-1');
    // the other owner may now demote the first... but the first must stay for the rest of the suite
    expect((await c.patch(`/api/users/${me.id}`, { role: 'dispatcher' })).status).toBe(200);
    expect((await c.patch(`/api/users/${me.id}`, { role: 'owner' })).status).toBe(200);
    await owner.del(`/api/users/${second.id}`);
  });

  test('an owner cannot delete themselves', async ({ owner }) => {
    const me = (await owner.get('/api/me')).data.user;
    expect((await owner.del(`/api/users/${me.id}`)).status).toBe(400);
  });
});

test.describe('deleting users', () => {
  test('gone from the list, the session dies, the login is free again', async ({ owner, server }) => {
    const { data } = await mk(owner, { username: `del${uid()}` });
    const c = new Api(server.url);
    await c.login(data.username, 'password-1');
    expect((await owner.del(`/api/users/${data.id}`)).status).toBe(200);
    expect((await owner.get('/api/users')).data.some((u) => u.id === data.id)).toBe(false);
    expect((await c.get('/api/me')).status).toBe(401);
    expect(server.get('SELECT COUNT(*) n FROM sessions WHERE user_id = ?', data.id).n, 'sessions removed with the user').toBe(0);
    expect((await mk(owner, { username: data.username })).status).toBe(200);
  });

  test('push subscriptions go with the user', async ({ owner, server }) => {
    const { data } = await mk(owner, { username: `dp${uid()}` });
    const c = new Api(server.url);
    await c.login(data.username, 'password-1');
    await c.post('/api/push/subscribe', { subscription: { endpoint: `https://127.0.0.1:1/${uid()}`, keys: { p256dh: 'x', auth: 'y' } } });
    await owner.del(`/api/users/${data.id}`);
    expect(server.get('SELECT COUNT(*) n FROM push_subscriptions WHERE user_id = ?', data.id).n).toBe(0);
  });

  test('alerts that user acknowledged survive and still read sensibly', async ({ owner, server }) => {
    const { data } = await mk(owner, { username: `da${uid()}` });
    const c = new Api(server.url);
    await c.login(data.username, 'password-1');
    const id = alert(server, { type: 'speeding' });
    await c.post(`/api/alerts/${id}/ack`);
    expect((await owner.del(`/api/users/${data.id}`)).status).toBe(200);
    const row = (await owner.get('/api/alerts?limit=500')).data.find((a) => a.id === id);
    expect(row.ackedAt).toBeTruthy();
  });

  test('unknown id: 404. Bad id: 400', async ({ owner }) => {
    expect((await owner.del('/api/users/999999')).status).toBe(404);
    expect((await owner.del('/api/users/abc')).status).toBe(400);
  });
});

test('a name with HTML is stored as text, and returned as text', async ({ owner }) => {
  const name = '<img src=x onerror=alert(1)>';
  expect((await mk(owner, { name })).data.name).toBe(name);
});
