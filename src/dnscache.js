'use strict';
/**
 * DNS answers, remembered, for every outgoing connection in this process.
 *
 * Node asks the system resolver for each new connection, at most 2 lookups at a time, in one queue. A request that
 * gives up leaves its lookup in that queue. So with a slow resolver a burst of connections to one host makes every
 * other host wait behind it: on 2026-11-05 map tiles held up the GPS polls for 12 minutes, at 570 ms a lookup.
 *
 * Here each host gets at most one lookup at a time, and an answer we already have is used at once while a newer one
 * is fetched in the background. If the resolver fails, the last answer keeps working. fetch() has no option for this,
 * and everything below it ends up at dns.lookup, so that is what gets wrapped.
 */
const dns = require('node:dns');
const net = require('node:net');
const util = require('node:util');

const FRESH_MS = 60_000; // no need to ask again
const USABLE_MS = 3_600_000; // old, but answer with it right away and ask in the background; older than this, wait for the resolver

function cachingLookup(base, { freshMs = FRESH_MS, usableMs = USABLE_MS, now = Date.now } = {}) {
  const known = new Map(); // key -> {at, answer}
  const asking = new Map(); // key -> callbacks waiting for the one lookup in progress

  const ask = (hostname, options, key, callback) => {
    const waiting = asking.get(key);
    if (waiting) return void waiting.push(callback);
    const callbacks = [callback];
    asking.set(key, callbacks);
    base(hostname, options, (err, ...answer) => {
      asking.delete(key);
      if (!err) known.set(key, { at: now(), answer });
      const last = known.get(key);
      for (const cb of callbacks) {
        if (err && last) cb(null, ...copy(last.answer));
        else if (err) cb(err);
        else cb(null, ...copy(answer));
      }
    });
  };

  return function lookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    const opts = typeof options === 'number' ? { family: options } : options || {};
    if (typeof hostname !== 'string' || !hostname || net.isIP(hostname)) return base(hostname, options, callback); // nothing to remember
    const key = [hostname, opts.family, opts.hints, opts.all, opts.order, opts.verbatim].join('|');
    const hit = known.get(key);
    const age = hit ? now() - hit.at : Infinity;
    if (age >= usableMs) return void ask(hostname, opts, key, callback);
    process.nextTick(callback, null, ...copy(hit.answer));
    if (age >= freshMs) ask(hostname, opts, key, () => {});
  };
}

const copy = ([address, family]) => (Array.isArray(address) ? [address.map((a) => ({ ...a }))] : [address, family]);

/** Replaces dns.lookup in this process. Returns a function that puts the original back. */
function install(options) {
  const base = dns.lookup;
  const wrapped = cachingLookup(base, options);
  wrapped[util.promisify.custom] = base[util.promisify.custom];
  dns.lookup = wrapped;
  return () => { dns.lookup = base; };
}

module.exports = { cachingLookup, install };
