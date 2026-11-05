'use strict';
// Remembered DNS answers: one lookup per host at a time, and a slow or broken resolver stops nobody.
const test = require('node:test');
const assert = require('node:assert');
const dns = require('node:dns');
const http = require('node:http');
const { cachingLookup, install } = require('../src/dnscache');

/** A resolver that answers when told to. */
function resolver() {
  const pending = [];
  const fn = (host, options, cb) => { fn.calls.push({ host, options }); pending.push(cb); };
  fn.calls = [];
  fn.answer = (...args) => { for (const cb of pending.splice(0)) cb(...args); };
  return fn;
}
const clock = () => { const c = () => c.t; c.t = 1000; return c; };
const ask = (lookup, host = 'gps.example', options = {}) => new Promise((resolve, reject) => {
  lookup(host, options, (err, ...answer) => (err ? reject(err) : resolve(answer)));
});
const IP = ['1.2.3.4', 4];

test('many connections to one host at once: one lookup, and everyone gets the answer', async () => {
  const base = resolver();
  const lookup = cachingLookup(base);
  const all = Array.from({ length: 50 }, () => ask(lookup));
  assert.equal(base.calls.length, 1);
  base.answer(null, ...IP);
  for (const a of await Promise.all(all)) assert.deepEqual(a, IP);
});

test('different hosts and different kinds of question are separate', async () => {
  const base = resolver();
  const lookup = cachingLookup(base);
  const all = [ask(lookup, 'a.example'), ask(lookup, 'b.example'), ask(lookup, 'a.example', { all: true }), ask(lookup, 'a.example', { family: 4 })];
  assert.equal(base.calls.length, 4);
  base.answer(null, ...IP);
  await Promise.all(all);
});

test('a known answer comes at once, and is not asked for again while fresh', async () => {
  const base = resolver();
  const now = clock();
  const lookup = cachingLookup(base, { freshMs: 100, now });
  const first = ask(lookup);
  base.answer(null, ...IP);
  await first;
  now.t += 99;
  assert.deepEqual(await ask(lookup), IP);
  assert.equal(base.calls.length, 1);
});

test('an old answer is used right away while a newer one is fetched; nobody waits for the resolver', async () => {
  const base = resolver();
  const now = clock();
  const lookup = cachingLookup(base, { freshMs: 100, usableMs: 1000, now });
  const first = ask(lookup);
  base.answer(null, ...IP);
  await first;
  now.t += 500;
  assert.deepEqual(await ask(lookup), IP, 'the resolver has not answered yet');
  assert.deepEqual(await ask(lookup), IP);
  assert.equal(base.calls.length, 2, 'one refresh, however many ask');
  base.answer(null, '5.6.7.8', 4);
  await new Promise(setImmediate);
  assert.deepEqual(await ask(lookup), ['5.6.7.8', 4]);
});

test('the resolver breaks: the last answer keeps working, also long after, and a failed refresh does no harm', async () => {
  const base = resolver();
  const now = clock();
  const lookup = cachingLookup(base, { freshMs: 100, usableMs: 1000, now });
  const first = ask(lookup);
  base.answer(null, ...IP);
  await first;
  now.t += 500;
  await ask(lookup);
  base.answer(new Error('EAI_AGAIN'));
  await new Promise(setImmediate);
  now.t += 5000;
  const late = ask(lookup);
  assert.equal(base.calls.length, 3, 'too old to answer without asking');
  base.answer(new Error('EAI_AGAIN'));
  assert.deepEqual(await late, IP);
});

test('a host never resolved: the error reaches everyone waiting, and is not remembered', async () => {
  const base = resolver();
  const lookup = cachingLookup(base);
  const all = [ask(lookup), ask(lookup)];
  base.answer(new Error('ENOTFOUND'));
  for (const p of all) await assert.rejects(p, /ENOTFOUND/);
  const again = ask(lookup);
  assert.equal(base.calls.length, 2);
  base.answer(null, ...IP);
  assert.deepEqual(await again, IP);
});

test('the all: true form returns the list, and callers cannot change what is remembered', async () => {
  const base = resolver();
  const lookup = cachingLookup(base);
  const first = ask(lookup, 'a.example', { all: true });
  base.answer(null, [{ address: '1.1.1.1', family: 4 }]);
  const [list] = await first;
  list[0].address = 'changed';
  list.push({});
  assert.deepEqual((await ask(lookup, 'a.example', { all: true }))[0], [{ address: '1.1.1.1', family: 4 }]);
});

test('the other ways to call dns.lookup: no options, a family number, an address', async () => {
  const base = resolver();
  const lookup = cachingLookup(base);
  const noOptions = new Promise((resolve) => lookup('a.example', (err, address) => resolve(address)));
  base.answer(null, ...IP);
  assert.equal(await noOptions, '1.2.3.4');
  const family = new Promise((resolve) => lookup('b.example', 4, (err, address) => resolve(address)));
  assert.equal(base.calls.at(-1).options.family, 4);
  base.answer(null, ...IP);
  assert.equal(await family, '1.2.3.4');
  lookup('127.0.0.1', {}, () => {});
  lookup('127.0.0.1', {}, () => {});
  assert.equal(base.calls.filter((c) => c.host === '127.0.0.1').length, 2, 'an address is not a lookup worth remembering');
});

test('installed: fetch() really goes through it, one lookup for a burst of new connections', async (t) => {
  const server = http.createServer((req, res) => setTimeout(() => res.end('ok'), 30));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const real = dns.lookup;
  const seen = [];
  dns.lookup = function counted(host, options, cb) { seen.push(host); return real(host, options, cb); };
  const remove = install();
  t.after(() => { remove(); dns.lookup = real; server.closeAllConnections(); server.close(); });
  const url = `http://localhost:${server.address().port}/`;
  const all = await Promise.all(Array.from({ length: 20 }, () => fetch(url).then((r) => r.text())));
  assert.ok(all.every((x) => x === 'ok'));
  assert.deepEqual(seen, ['localhost']);
});

test('removing it puts dns.lookup back', () => {
  const before = dns.lookup;
  const remove = install();
  assert.notEqual(dns.lookup, before);
  remove();
  assert.equal(dns.lookup, before);
});
