'use strict';
/**
 * Web Push (VAPID). Each browser/phone that allows notifications registers a subscription with its own
 * preferences: entries, exits, fleet only, alerts, quiet hours. Gate events and alerts arrive on the bus.
 * Subscriptions the push service reports as gone (404/410) are deleted.
 */
const crypto = require('node:crypto');
const webpush = require('web-push');
const bus = require('./bus');
const T = require('./time');

const DEFAULT_PREFS = { gateIn: true, gateOut: true, onlyFleet: false, alerts: true, system: true, quietFrom: '', quietTo: '' };

class Push {
  constructor({ h, config, log = console, sender = null }) {
    this.h = h;
    this.cfg = config;
    this.log = log;
    let keys = process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
      ? { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY }
      : h.kvGet('vapid');
    if (!keys) {
      keys = webpush.generateVAPIDKeys();
      h.kvSet('vapid', keys);
    }
    this.publicKey = keys.publicKey;
    webpush.setVapidDetails(config.push.subject, keys.publicKey, keys.privateKey);
    this.send = sender || ((sub, payload, opts) => webpush.sendNotification(sub, payload, opts));
    this.imageSecret = h.kvGet('image_secret') || (() => { const s = crypto.randomBytes(32).toString('hex'); h.kvSet('image_secret', s); return s; })();
    this.sent = 0;
    this.failed = 0;
  }

  /** Short-lived signed URL for a notification image (the push service fetches it without our cookie). */
  imageSig(id, exp) {
    return crypto.createHmac('sha256', this.imageSecret).update(`${id}:${exp}`).digest('base64url').slice(0, 32);
  }
  imageUrl(id) {
    const exp = Date.now() + 24 * 3600e3;
    return `/api/push-image/${id}?exp=${exp}&sig=${this.imageSig(id, exp)}`;
  }
  checkImage(id, exp, sig) {
    if (!exp || Number(exp) < Date.now() || typeof sig !== 'string') return false;
    const want = Buffer.from(this.imageSig(id, Number(exp)));
    const got = Buffer.from(sig);
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  }

  subscribe(user, sub, prefs, ua) {
    if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) {
      const e = new Error("Noto'g'ri obuna"); e.status = 400; throw e;
    }
    const p = JSON.stringify({ ...DEFAULT_PREFS, ...cleanPrefs(prefs) });
    this.h.run(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, prefs, ua, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
      prefs = excluded.prefs, ua = excluded.ua, fails = 0`, user.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth, p, String(ua || '').slice(0, 200), Date.now());
    return this.get(sub.endpoint, user);
  }

  get(endpoint, user) {
    const r = this.h.get('SELECT * FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', endpoint, user.id);
    return r ? { endpoint: r.endpoint, prefs: JSON.parse(r.prefs), createdAt: r.created_at, lastOk: r.last_ok } : null;
  }

  updatePrefs(user, endpoint, prefs) {
    const cur = this.get(endpoint, user);
    if (!cur) { const e = new Error('Obuna topilmadi'); e.status = 404; throw e; }
    this.h.run('UPDATE push_subscriptions SET prefs = ? WHERE endpoint = ? AND user_id = ?',
      JSON.stringify({ ...cur.prefs, ...cleanPrefs(prefs) }), endpoint, user.id);
    return this.get(endpoint, user);
  }

  unsubscribe(user, endpoint) {
    this.h.run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', endpoint, user.id);
  }

  count() {
    return this.h.get('SELECT COUNT(*) n FROM push_subscriptions').n;
  }

  /** Deliver to every subscription that `want(prefs, role, row)` accepts. */
  async broadcast(payload, want) {
    const subs = this.h.all(`SELECT s.*, u.role FROM push_subscriptions s JOIN users u ON u.id = s.user_id AND u.disabled = 0`);
    const body = JSON.stringify(payload);
    const now = Date.now();
    await Promise.all(subs.map(async (s) => {
      const prefs = { ...DEFAULT_PREFS, ...JSON.parse(s.prefs) };
      if (!want(prefs, s.role, s) || (payload.kind !== 'test' && payload.kind !== 'system' && inQuiet(prefs, now))) return;
      try {
        await this.send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 3600, urgency: payload.urgency || 'normal' });
        this.sent++;
        this.h.run('UPDATE push_subscriptions SET last_ok = ?, fails = 0 WHERE id = ?', now, s.id);
      } catch (e) {
        this.failed++;
        if (e.statusCode === 404 || e.statusCode === 410) this.h.run('DELETE FROM push_subscriptions WHERE id = ?', s.id);
        else {
          this.h.run('UPDATE push_subscriptions SET fails = fails + 1 WHERE id = ?', s.id);
          this.log.warn?.(`push failed (${e.statusCode || e.message})`);
        }
      }
    }));
  }

  gatePayload(ev) {
    const head = ev.direction === 'in' ? '🟢 KIRDI' : '🔴 CHIQDI';
    const who = ev.vehicleLabel || ev.plateText || "Raqam o'qilmadi";
    const lines = [`${hhmm(ev.t)} · ${ev.camera}`];
    if (!ev.vehicleId) lines.push(ev.plateValid ? "GPS ro'yxatida yo'q" : (ev.note || 'Aniqlanmadi'));
    if (ev.staySeconds) lines.push(`Ichkarida: ${duration(ev.staySeconds)}`);
    if (ev.status === 'unconfirmed') lines.push('⚠️ ' + (ev.note || 'GPS tasdiqlamadi'));
    return {
      title: `${head} · ${who}`,
      body: lines.join('\n'),
      tag: `gate-${ev.id}`,
      url: `/#/darvoza?event=${ev.id}`,
      image: ev.photos.length ? this.imageUrl(ev.id) : undefined,
      kind: 'gate',
      urgency: 'high',
    };
  }

  start() {
    bus.on('gate:notify', (ev) => {
      const payload = this.gatePayload(ev);
      this.broadcast(payload, (p) => (ev.direction === 'in' ? p.gateIn : p.gateOut) && (!p.onlyFleet || ev.vehicleId)).catch(() => {});
    });
    bus.on('alert', (a) => {
      if (a.silent) return;
      const payload = { title: a.severity === 'info' ? a.title : `${a.severity === 'critical' ? '🚨' : '⚠️'} ${a.title}`, body: a.body || '', tag: `alert-${a.id}`, url: `/#/ogohlantirish?id=${a.id}`, kind: 'alert', urgency: a.severity === 'critical' ? 'high' : 'normal' };
      // System problems (cameras, internet, GPS) go to everyone who keeps "system" on; quiet hours don't apply to them.
      const sys = a.type === 'system';
      if (sys) Object.assign(payload, { kind: 'system', tag: `system-${a.data?.problem || a.id}` }); // recovery replaces the outage notice
      this.broadcast(payload, (p) => (sys ? p.system : p.alerts)).catch(() => {});
    });
  }
}

function cleanPrefs(p = {}) {
  const out = {};
  for (const k of ['gateIn', 'gateOut', 'onlyFleet', 'alerts', 'system']) if (k in p) out[k] = !!p[k];
  for (const k of ['quietFrom', 'quietTo']) if (k in p) out[k] = /^([01]\d|2[0-3]):[0-5]\d$/.test(p[k]) ? p[k] : '';
  return out;
}

function inQuiet(p, now) {
  if (!p.quietFrom || !p.quietTo) return false;
  const m = T.minuteOfDay(now), a = T.parseHm(p.quietFrom), b = T.parseHm(p.quietTo);
  return a <= b ? m >= a && m < b : m >= a || m < b;
}

function hhmm(ms) {
  return T.localIso(ms).slice(11, 16);
}
function duration(s) {
  const m = Math.round(s / 60), h = Math.floor(m / 60);
  return h ? `${h} soat ${m % 60} daqiqa` : `${m} daqiqa`;
}

module.exports = { Push, DEFAULT_PREFS, inQuiet, cleanPrefs };
