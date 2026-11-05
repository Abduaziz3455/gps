'use strict';
/**
 * Durable delivery queue. Anything sent to people outside the app goes through here, one row per recipient:
 * a network outage or a restart loses nothing, nothing waits on the sender, and a recipient that can't be reached
 * doesn't hold up the others.
 *
 * A channel is one function: `send(row)` delivers or throws. It may throw an error with
 *   permanent: true     retrying won't help (blocked the bot, chat gone): give up now
 *   moveTo: <target>    the recipient has a new address: send there right away
 * A new channel (SMS, e-mail, ...) is one more register() and the same table. `onGiveUp` hears about a recipient that
 * can't be reached, so whoever runs the channel can tell someone.
 */
const MAX_ATTEMPTS = 20; // back-off capped at 10 min: keeps trying for about 2.5 hours
const POLL_MS = 15e3;

class Outbox {
  constructor({ h, log = console }) {
    this.h = h;
    this.log = log;
    this.channels = new Map();
    this.timer = null;
    this.stopped = true;
    this.running = false;
  }

  /** @param {{onGiveUp?: (row: object, error: Error) => void}} [o] */
  register(channel, send, { onGiveUp = null } = {}) { this.channels.set(channel, { send, onGiveUp }); }

  /**
   * Queue one delivery. With `dedupe`, the same channel + target + dedupe is queued once, ever.
   * Synchronous, so it can share a transaction with what caused it.
   * @returns {number|null} the row id, or null when it was queued before
   */
  enqueue({ channel, target, kind, ref = null, payload = null, dedupe = null, now = Date.now() }) {
    const r = this.h.run(`INSERT OR IGNORE INTO outbox (channel, target, kind, ref, payload, dedupe, next_attempt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      channel, String(target), kind, ref, payload === null ? null : JSON.stringify(payload), dedupe, now, now);
    if (!r.changes) return null;
    this.wake();
    return Number(r.lastInsertRowid);
  }

  wake() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._loop(), 0);
  }

  backoffMs(attempts) { return Math.min(30e3 * 2 ** (attempts - 1), 600e3); }

  /** Send everything that is due, oldest first. Each row is on its own. */
  async drain(now = Date.now()) {
    const due = this.h.all("SELECT * FROM outbox WHERE status = 'pending' AND next_attempt <= ? ORDER BY id LIMIT 20", now);
    let sent = 0;
    for (const row of due) {
      const channel = this.channels.get(row.channel);
      if (!channel) continue; // nobody handles this channel in this run: it stays queued
      const started = Date.now();
      try {
        await channel.send({ ...row, payload: row.payload ? JSON.parse(row.payload) : null });
        this.h.run("UPDATE outbox SET status = 'sent', sent_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?", Date.now(), row.id);
        sent++;
        this.log.info?.(`delivered ${row.channel} ${row.kind}${row.ref ? ` #${row.ref}` : ''} to ${row.target} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
      } catch (e) {
        this._failed(row, e);
      }
    }
    return { sent, more: due.length === 20 };
  }

  _failed(row, e) {
    if (e.moveTo) {
      this.h.run('UPDATE outbox SET target = ?, next_attempt = ? WHERE id = ?', String(e.moveTo), Date.now(), row.id);
      this.log.info?.(`${row.channel}: ${row.target} moved to ${e.moveTo}`);
      return;
    }
    const attempts = row.attempts + 1;
    const giveUp = e.permanent || attempts >= MAX_ATTEMPTS;
    const delay = e.retryAfterMs || this.backoffMs(attempts);
    this.h.run('UPDATE outbox SET attempts = ?, next_attempt = ?, last_error = ?, status = ? WHERE id = ?',
      attempts, Date.now() + delay, String(e.message || e).slice(0, 500), giveUp ? 'failed' : 'pending', row.id);
    this.log.warn?.(`${row.channel} ${row.kind}${row.ref ? ` #${row.ref}` : ''} to ${row.target} failed (attempt ${attempts}${giveUp ? ', giving up' : `, retry in ${Math.round(delay / 1000)} s`}): ${e.message}`);
    if (giveUp) {
      try { this.channels.get(row.channel)?.onGiveUp?.({ ...row, attempts }, e); } catch (x) { this.log.warn?.(`outbox: ${x.message}`); }
    }
  }

  async _loop() {
    if (this.stopped || this.running) return;
    this.running = true;
    let more = false;
    try { ({ more } = await this.drain()); } catch (e) { this.log.warn?.(`outbox: ${e.message}`); }
    this.running = false;
    if (this.stopped) return;
    this.timer = setTimeout(() => this._loop(), more ? 0 : POLL_MS);
  }

  start() {
    this.stopped = false;
    this.timer = setTimeout(() => this._loop(), 0);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  /** {pending, sent, failed} for one channel. */
  counts(channel) {
    const out = { pending: 0, sent: 0, failed: 0 };
    for (const r of this.h.all('SELECT status, COUNT(*) n FROM outbox WHERE channel = ? GROUP BY status', channel)) out[r.status] = r.n;
    return out;
  }

  oldestPending(channel) {
    return this.h.get("SELECT MIN(created_at) t FROM outbox WHERE channel = ? AND status = 'pending'", channel)?.t ?? null;
  }

  /** Forget finished deliveries older than `before`. */
  prune(before) {
    return this.h.run("DELETE FROM outbox WHERE status != 'pending' AND created_at < ?", before).changes;
  }
}

module.exports = { Outbox, MAX_ATTEMPTS };
