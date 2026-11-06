'use strict';
/**
 * Health monitor: finds WHICH link is broken and says so in plain words, then says when it is back.
 *
 * Every minute it looks at each link between the plant and the people:
 *
 *   our server ── internet ──┬── GoGPS (baku.gps.az) ── trucks' trackers
 *                            └── plant internet / router ── NVR ── cameras (ANPR-1, ANPR-2, Yo'l-1, Yo'l-2)
 *
 *   1. our server's internet   TCP to well-known hosts (1.1.1.1, 8.8.8.8). Down: everything else is unknowable,
 *                              so only this is reported (and the push service can't be reached either: the
 *                              message goes out on recovery, with the period).
 *   2. GoGPS                   the poller's last success and error (wrong password vs service down).
 *   3. NVR                     deviceInfo every minute, and the kind of failure:
 *                                refused   -> the plant's router answered, nothing behind the port: NVR off/rebooting
 *                                             or the router's port forwarding changed
 *                                timeout   -> nothing answers: plant internet / router / power down, or NVR off.
 *                                             With SITE_ROUTER (host:port of the router itself) the two are told apart.
 *                                401       -> NVR password changed
 *   4. cameras                 the NVR's channel status (camera unplugged / off), and "reads nothing": GPS saw
 *                              trucks cross the yard boundary but the plate camera recorded none of them.
 *   5. our system              the server was down (no heartbeat), disk almost full.
 *
 * A problem is reported after it lasts CONFIRM_CHECKS checks (~3 min, so a blip isn't an alarm); recovery after
 * 2 good checks, with the outage period. Messages go to everyone (dispatchers need to know the cameras are blind).
 */
const fs = require('node:fs');
const net = require('node:net');
const bus = require('./bus');
const T = require('./time');

const CHECK_MS = Math.max(5, Number(process.env.HEALTH_CHECK_SECONDS) || 60) * 1000;
const CONFIRM_CHECKS = 3;
const RECOVER_CHECKS = 2;
const SILENT_WINDOW_MS = 90 * 60e3;
const SILENT_MIN_CROSSINGS = 3;
const ALIVE_EVERY_MS = 30e3;
const DOWN_AFTER_MS = 3 * 60e3;

/** TCP connect within `ms`. Resolves {ok, code}. */
function tcpProbe(host, port, ms = 5000) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok, code) => { s.destroy(); resolve({ ok, code }); };
    s.setTimeout(ms, () => done(false, 'ETIMEDOUT'));
    s.once('connect', () => done(true));
    s.once('error', (e) => done(false, e.code || 'ERROR'));
  });
}

function parseHostPort(s, defPort) {
  if (!s) return null;
  const m = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(String(s).replace(/^\w+:\/\//, '').replace(/\/.*$/, ''));
  return m ? { host: m[1], port: Number(m[2] || defPort) } : null;
}

/** NVR error -> kind. */
function nvrErrorKind(e) {
  if (!e) return null;
  if (e.status === 401 || e.status === 403) return 'auth';
  if (e.status) return 'http';
  const code = e.code || '';
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns';
  if (/timed out|ETIMEDOUT/i.test(`${code} ${e.message}`)) return 'timeout';
  if (['EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'EPIPE'].includes(code)) return 'unreachable';
  return 'unreachable';
}

/** GPS error text -> kind. */
/** Has GoGPS answered lately? Three missed polls and a minute of slack. */
function gpsFresh(lastOk, pollSeconds, now = Date.now()) {
  return !!lastOk && now - lastOk < 3 * Math.max(10e3, pollSeconds * 1000) + 60e3;
}

function gpsErrorKind(msg) {
  if (!msg) return null;
  if (/login failed|not authorized|HTTP 401|HTTP 403/i.test(msg)) return 'auth';
  return 'down';
}

const CAM_ROLE = { in: 'kirish', out: 'chiqish' };

/**
 * Observations -> problems (pure; tested). Each problem: {key, part, severity, title, text}.
 * obs: {internet: bool, gps: null|{ok, error}, nvr: null|{ok, kind, status}, router: null|bool,
 *       cameras: [{channel, name, role, offline, silent: null|{crossings}}], diskFreeBytes, diskFreeShare}
 */
function diagnose(obs) {
  const out = [];
  if (obs.internet === false) {
    out.push({
      key: 'server_internet', part: 'server', severity: 'critical',
      title: "Dispatcher serverida internet yo'q",
      text: "Server internetga chiqa olmayapti, shuning uchun GPS va kameralardan ma'lumot kelmayapti. Bu zavod yoki kamera muammosi emas: server joylashgan xosting tarmog'ini tekshirish kerak.",
    });
    return out;
  }
  if (obs.gps && !obs.gps.ok) {
    out.push(gpsErrorKind(obs.gps.error) === 'auth'
      ? { key: 'gps_auth', part: 'gps', severity: 'critical', title: 'GPS tizimiga kirib bo\'lmayapti',
        text: "baku.gps.az login yoki parolni qabul qilmadi. Parol o'zgargan bo'lsa, serverdagi .env faylida GPS_PASSWORD ni yangilang. Hozir mashinalar joylashuvi yangilanmayapti." }
      : { key: 'gps_down', part: 'gps', severity: 'critical', title: 'GPS xizmati javob bermayapti',
        text: "baku.gps.az (GoGPS) javob bermayapti. Bizning internet ishlayapti, muammo GPS xizmati tomonida. Mashinalar joylashuvi yangilanmayapti; xizmat tiklanganda o'zi davom etadi." });
  }
  if (obs.nvr && !obs.nvr.ok) {
    const k = obs.nvr.kind;
    if (k === 'auth') {
      out.push({ key: 'nvr_auth', part: 'nvr', severity: 'critical', title: "Kamera tizimi (NVR) parolni qabul qilmadi",
        text: "NVR ishlayapti, lekin login yoki parol noto'g'ri. NVR paroli o'zgargan bo'lsa, serverdagi .env faylida NVR_PASSWORD ni yangilang. Hozir kamera yozuvlari kelmayapti." });
    } else if (k === 'dns') {
      out.push({ key: 'nvr_dns', part: 'nvr', severity: 'critical', title: 'NVR manzili topilmadi',
        text: "Sozlamadagi NVR manzili (NVR_HOST) topilmadi. Manzilni tekshiring." });
    } else if (k === 'http') {
      out.push({ key: 'nvr_error', part: 'nvr', severity: 'critical', title: 'Kamera tizimi (NVR) xato bilan javob bermoqda',
        text: `NVR ga ulanildi, lekin u xato qaytardi (HTTP ${obs.nvr.status}). NVR ni qayta yoqib ko'ring.` });
    } else if (k === 'refused' || obs.router === true) {
      out.push({ key: 'nvr_down', part: 'nvr', severity: 'critical', title: 'Kamera yozuv qurilmasi (NVR) javob bermayapti',
        text: k === 'refused'
          ? "Zavod interneti ishlayapti (router javob berdi), lekin NVR ga ulanib bo'lmadi. NVR o'chgan yoki qayta yuklanayotgan bo'lishi mumkin, yoki routerdagi port yo'naltirish o'zgargan. NVR ni tekshiring."
          : "Zavod interneti ishlayapti (router javob berdi), lekin NVR javob bermayapti. NVR o'chgan, osilib qolgan yoki tarmoq kabeli uzilgan bo'lishi mumkin. NVR ni qayta yoqib ko'ring." });
    } else if (obs.router === false) {
      out.push({ key: 'site_internet', part: 'site', severity: 'critical', title: "Zavodda internet yo'q",
        text: "Zavoddagi router internetdan javob bermayapti: internet (provayder yoki Wi-Fi/router) ishlamayapti yoki elektr o'chgan. Kameralarga ulanib bo'lmaydi. Provayder va routerni tekshiring." });
    } else {
      out.push({ key: 'site_unreachable', part: 'site', severity: 'critical', title: "Zavoddagi kameralarga ulanib bo'lmayapti",
        text: "Zavoddan hech qanday javob yo'q. Eng ko'p uchraydigan sabablar: zavod interneti (Wi-Fi/router yoki provayder) ishlamayapti, elektr o'chgan yoki NVR o'chgan. Avval zavoddagi internetni tekshiring." });
    }
  }
  if (obs.nvr && obs.nvr.ok) {
    for (const c of obs.cameras || []) {
      const what = `${c.name}${c.role ? ` (${c.role})` : ''}`;
      if (c.offline) {
        out.push({ key: `camera_offline:${c.channel}`, part: 'camera', severity: c.anpr ? 'critical' : 'warning', title: `${what} kamerasi o'chgan`,
          text: `NVR ishlayapti, lekin ${what} kamerasi unga ulanmagan: kamera o'chgan, elektr yoki tarmoq kabeli uzilgan.${c.anpr ? ' Shu darvozadagi mashinalar qayd etilmayapti.' : ''}` });
      } else if (c.silent) {
        out.push({ key: `camera_silent:${c.channel}`, part: 'camera', severity: 'warning', title: `${what} kamerasi mashinalarni yozmayapti`,
          text: `Oxirgi 90 daqiqada GPS bo'yicha ${c.silent.crossings} ta mashina ${c.role === 'kirish' ? 'kirdi' : 'chiqdi'}, kamera esa birortasini qayd etmadi. Kamera linzasi iflos, burilib qolgan yoki raqam aniqlash o'chgan bo'lishi mumkin.${c.silent.own ? ` Bu vaqtda o'z modelimiz videodan ${c.silent.own} ta mashinani o'qidi: darvoza qayd etishda davom etyapti, lekin kamera yoki NVR ni tekshirish kerak.` : ''}` });
      }
    }
  }
  if (obs.diskFreeBytes != null && (obs.diskFreeBytes < 1024 ** 3 || obs.diskFreeShare < 0.05)) {
    out.push({ key: 'disk_low', part: 'server', severity: 'warning', title: 'Serverda joy tugayapti',
      text: `Diskda ${(obs.diskFreeBytes / 1024 ** 3).toFixed(1)} GB bo'sh joy qoldi. Joy tugasa, tizim yangi ma'lumotlarni saqlay olmaydi. Diskni kengaytirish yoki eski rasmlarni o'chirish kerak.` });
  }
  return out;
}

const PART_LABEL = { server: 'Server', gps: 'GPS', site: 'Zavod interneti', nvr: 'Kamera tizimi (NVR)', camera: 'Kameralar' };

class Health {
  constructor({ h, config, poller, gate, rules, log = console, probe = tcpProbe }) {
    this.h = h;
    this.cfg = config;
    this.poller = poller;
    this.gate = gate;
    this.rules = rules;
    this.log = log;
    this.probe = probe;
    this.active = new Map(); // key -> {problem, since, fails, oks, raised}
    this.last = null; // last observations
    this.channelStatusAt = 0;
    this.offline = new Set();
    this.timers = [];
    this.internetHosts = String(process.env.INTERNET_PROBES || '1.1.1.1:443,8.8.8.8:53').split(',').map((s) => parseHostPort(s.trim(), 443)).filter(Boolean);
    this.router = parseHostPort(process.env.SITE_ROUTER, 80);
    this.checks = []; // other parts report their own problems here: () => [{key, part, severity, title, text}]
    this.partLabels = new Map();
  }

  /** A part of the system that watches itself. Its problems are confirmed, reported and closed like any other. */
  addCheck(part, label, fn) {
    this.partLabels.set(part, label);
    this.checks.push(fn);
  }

  async observe(now = Date.now()) {
    const obs = { at: now };
    const results = await Promise.all(this.internetHosts.map((x) => this.probe(x.host, x.port, 5000)));
    obs.internet = results.some((r) => r.ok);
    if (this.poller) {
      const fresh = gpsFresh(this.poller.lastOk, this.cfg.gps.pollSeconds, now);
      obs.gps = { ok: fresh || (!this.poller.lastError && now - (this.started || now) < 3 * 60e3), error: this.poller.lastError, lastOk: this.poller.lastOk };
    } else obs.gps = null;
    if (this.gate) {
      const nvr = this.gate.nvr;
      try {
        await (nvr.ping ? nvr.ping() : nvr.deviceInfo());
        obs.nvr = { ok: true };
      } catch (e) {
        obs.nvr = { ok: false, kind: nvrErrorKind(e), status: e.status || null, message: e.message };
      }
      obs.nvr.lastOk = nvr.lastOk || null;
      if (!obs.nvr.ok && this.router) obs.router = (await this.probe(this.router.host, this.router.port, 5000)).ok;
      else obs.router = null;
      obs.cameras = obs.nvr.ok ? await this.cameraState(now) : [];
    } else obs.nvr = null;
    try {
      const st = fs.statfsSync(this.cfg.dataDir);
      obs.diskFreeBytes = st.bavail * st.bsize;
      obs.diskFreeShare = st.blocks ? st.bavail / st.blocks : 1;
    } catch { obs.diskFreeBytes = null; }
    return obs;
  }

  /** Per configured camera: offline (NVR channel status, every 5 min) and "reads nothing" (GPS cross-check). */
  async cameraState(now) {
    const cams = [];
    for (const c of this.cfg.nvr.cameras) {
      cams.push({ channel: c.channel, name: c.name, role: CAM_ROLE[c.direction], anpr: true, direction: c.direction });
      if (c.contextChannel) cams.push({ channel: c.contextChannel, name: c.contextName || `ch${c.contextChannel}`, role: null, anpr: false });
    }
    if (now - this.channelStatusAt >= 5 * 60e3 && this.gate.nvr.channelStatus) {
      try {
        const st = await this.gate.nvr.channelStatus();
        this.offline = new Set(Object.entries(st).filter(([, online]) => online === false).map(([id]) => Number(id)));
        this.channelStatusAt = now;
      } catch { /* older firmware: no channel status; the GPS cross-check still works */ }
    }
    const [wa, wb] = this.cfg.rules.workHours.split('-').map(T.parseHm);
    const m = T.minuteOfDay(now);
    const workTime = m >= wa + 90 && m < wb; // a full 90-min window inside working hours
    for (const c of cams) {
      c.offline = this.offline.has(c.channel);
      c.silent = null;
      if (!c.anpr || c.offline || !workTime) continue;
      const from = now - SILENT_WINDOW_MS, to = now - 2 * 60e3; // GPS runs behind; leave the last minutes out
      const col = c.direction === 'in' ? 'enter_t' : 'exit_t';
      const crossings = this.h.get(`SELECT COUNT(*) n FROM yard_visits WHERE ${col} BETWEEN ? AND ? ${c.direction === 'in' ? 'AND approx = 0' : ''}`, from, to).n;
      if (crossings < SILENT_MIN_CROSSINGS) continue;
      // Only the camera's own captures count: our reader covering for it (own_...) is not the camera working.
      const n = (own) => this.h.get(`SELECT COUNT(*) n FROM cam_sightings WHERE channel = ? AND time BETWEEN ? AND ? AND name ${own ? '' : 'NOT '}LIKE 'own\\_%' ESCAPE '\\'`, c.channel, from - 2 * 60e3, now).n;
      if (n(false) === 0) c.silent = { crossings, own: n(true) };
    }
    return cams;
  }

  /** One round: observe, diagnose, raise new problems, announce recoveries. */
  async check(now = Date.now()) {
    const obs = await this.observe(now);
    this.last = obs;
    const problems = diagnose(obs);
    for (const fn of this.checks) {
      try { problems.push(...fn(now)); } catch (e) { this.log.warn?.(`health check: ${e.message}`); }
    }
    const seen = new Set();
    for (const p of problems) {
      seen.add(p.key);
      const a = this.active.get(p.key) || { since: this.sinceFor(p, obs, now), fails: 0, oks: 0, raised: false };
      a.problem = p;
      a.fails++;
      a.oks = 0;
      this.active.set(p.key, a);
      const need = p.key.startsWith('camera_silent') || p.key === 'disk_low' ? 1 : CONFIRM_CHECKS;
      if (!a.raised && a.fails >= need) {
        a.raised = true;
        this.raise(p, a.since, now);
      }
    }
    for (const [key, a] of this.active) {
      if (seen.has(key)) continue;
      // "Server internet down" hides the others; while it lasts, don't count them as recovered.
      if (problems.some((p) => p.key === 'server_internet') && key !== 'server_internet') continue;
      a.oks++;
      if (a.oks >= RECOVER_CHECKS || !a.raised) {
        this.active.delete(key);
        if (a.raised) this.recover(a.problem, a.since, now - (a.oks - 1) * CHECK_MS);
      }
    }
    bus.emit('health');
    return problems;
  }

  /** Start of the outage: the component's last success when known, else the first failed check. */
  sinceFor(p, obs, now) {
    const last = p.part === 'gps' ? obs.gps?.lastOk : (p.part === 'nvr' || p.part === 'site') ? obs.nvr?.lastOk : null;
    return last && last < now ? last : now;
  }

  raise(p, since, now) {
    this.rules.raise({
      key: `system:${p.key}:${since}`, type: 'system', severity: p.severity, t: now, title: p.title,
      body: `${p.text}\n${T.localIso(since).slice(11, 16)} dan beri.`, data: { part: p.part, problem: p.key, since },
    });
    this.log.warn?.(`health: ${p.key}: ${p.title}`);
  }

  recover(p, since, end) {
    const mins = Math.max(1, Math.round((end - since) / 60e3));
    const period = `${fmt(since, end)}–${fmt(end, end)} (${mins < 60 ? `${mins} daqiqa` : `${Math.floor(mins / 60)} soat ${mins % 60} daqiqa`})`;
    const extra = p.part === 'nvr' || p.part === 'site' || p.part === 'server'
      ? " Uzilish paytidagi darvoza o'tishlari kameralardan qayta yuklab olinadi (6 soatgacha)." : '';
    this.rules.raise({
      key: `recovered:${p.key}:${since}`, type: 'system', severity: 'info', t: end, title: `✅ Tiklandi: ${PART_LABEL[p.part] || this.partLabels.get(p.part) || p.title}`,
      body: `${p.title} — muammo hal bo'ldi. Ishlamagan vaqt: ${period}.${extra}`, data: { part: p.part, problem: p.key, since, end, recovered: true },
    });
    // The problem is over: close its alert and the recovery note, so the bell only counts what is still wrong.
    this.h.run('UPDATE alerts SET acked_at = ? WHERE key IN (?, ?) AND acked_at IS NULL', end, `system:${p.key}:${since}`, `recovered:${p.key}:${since}`);
    bus.emit('alert:update', null);
    this.log.info?.(`health: ${p.key} recovered after ${mins} min`);
  }

  /** Our own downtime: the heartbeat in the database stopped while the server was off. */
  checkOwnDowntime(now = Date.now()) {
    const alive = this.h.kvGet('alive_at');
    if (alive && now - alive > DOWN_AFTER_MS) {
      const mins = Math.round((now - alive) / 60e3);
      this.rules.raise({
        key: `system:server_down:${alive}`, type: 'system', severity: 'warning', t: now,
        title: 'Dispatcher tizimi ishlamay qoldi',
        body: `Tizim ${fmt(alive, now)} dan ${fmt(now, now)} gacha (${mins} daqiqa) ishlamadi: server o'chgan, qayta yuklangan yoki dastur to'xtagan. Endi ishlayapti. Shu vaqtdagi darvoza o'tishlari kameralardan qayta yuklab olinadi (6 soatgacha).`,
        data: { part: 'server', problem: 'server_down', since: alive, end: now },
      });
    }
    this.h.kvSet('alive_at', now);
  }

  /** Plain-language state of each part, for the header and the settings page. */
  summary(now = Date.now()) {
    const parts = [];
    const obs = this.last;
    const activeParts = new Map();
    for (const a of this.active.values()) if (a.raised || a.fails >= 2) activeParts.set(a.problem.part, a);
    const item = (id, label, a, okText) => parts.push(a
      ? { id, label, state: a.problem.severity === 'warning' ? 'warn' : 'bad', text: a.problem.title, detail: a.problem.text, since: a.since }
      : { id, label, state: 'ok', text: okText });
    item('server', 'Server', activeParts.get('server'), 'Ishlayapti');
    if (this.poller) item('gps', 'GPS', activeParts.get('gps'), this.poller.lastOk ? `Yangilandi ${Math.round((now - this.poller.lastOk) / 1000)} s oldin` : 'Ulanmoqda…');
    if (this.gate) {
      item('site', 'Zavod interneti', activeParts.get('site'), 'Ishlayapti');
      item('nvr', 'Kamera tizimi (NVR)', activeParts.get('nvr'), 'Ishlayapti');
      item('camera', 'Kameralar', activeParts.get('camera'), 'Ishlayapti');
    }
    for (const [part, label] of this.partLabels) item(part, label, activeParts.get(part), 'Ishlayapti');
    const problems = [...this.active.values()].filter((a) => a.raised).map((a) => ({ key: a.problem.key, part: a.problem.part, severity: a.problem.severity, title: a.problem.title, text: a.problem.text, since: a.since }));
    return { checkedAt: obs?.at || null, parts, problems };
  }

  start() {
    this.started = Date.now();
    this.checkOwnDowntime();
    const alive = () => { this.h.kvSet('alive_at', Date.now()); this.timers[0] = setTimeout(alive, ALIVE_EVERY_MS); };
    this.timers[0] = setTimeout(alive, ALIVE_EVERY_MS);
    const loop = async () => {
      try { await this.check(); } catch (e) { this.log.warn?.(`health check failed: ${e.message}`); }
      this.timers[1] = setTimeout(loop, CHECK_MS);
    };
    this.timers[1] = setTimeout(loop, Math.min(45e3, CHECK_MS)); // let the poller and the NVR connect first
  }

  stop() { this.timers.forEach(clearTimeout); }
}

/** HH:MM, with the date when it isn't the same day as `now`. */
const fmt = (ms, now = Date.now()) => (T.dayOf(ms) === T.dayOf(now) ? T.localIso(ms).slice(11, 16) : T.localIso(ms).slice(5, 16).replace('T', ' ').replace(/^(\d\d)-(\d\d)/, '$2.$1'));

module.exports = { Health, diagnose, nvrErrorKind, gpsErrorKind, gpsFresh, tcpProbe, parseHostPort, CONFIRM_CHECKS };
