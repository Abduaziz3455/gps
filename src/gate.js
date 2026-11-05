'use strict';
/**
 * Camera pipeline: NVR captures -> plate rules and in/out tracker ->
 * gate events -> GPS match/confirmation -> photos -> notifications.
 *
 * The GPS side is the poller's yard visits (vehicle inside the circle around the yard, polled every 10 s,
 * timed by the tracker's own record time). Each gate event waits `resolveAfterSec` for GPS to catch up
 * (GPS data runs 10-40 s behind), then:
 *   - exit of a fleet vehicle: confirmed when it left the yard circle around the capture; vetoed when it is
 *     still parked inside `exitConfirmMin` later (trucks shuffling in the queue in front of the camera);
 *   - entry of a fleet vehicle: confirmed when it entered the circle around the capture;
 *   - no plate read: the one fleet vehicle that crossed the circle in the matching direction at that moment;
 *   - a valid plate that isn't in the fleet, at the exit: counts as evidence that the plate belongs to the
 *     vehicle that left right then (learned after 3 consistent exits); else "outside".
 * Entries are notified at once; exits and unread plates once resolved (vetoed ones never).
 *
 * Two more stages run from the database, so a restart picks up where it stopped:
 *   top view    the photo with the vehicle under the overview camera, read from the recording (src/cameras/topview.js).
 *               It replaces the live snapshot when ready; the page updates by itself.
 *   final       GPS has decided and the top view is settled: 'gate:final' goes out, once, for whatever needs the whole
 *               story (Telegram alerts). A subscriber that writes to the database joins that transaction.
 */
const fs = require('node:fs');
const path = require('node:path');
const bus = require('./bus');
const { plateKey, similarPlate, prettyPlate, vehicleLabel, vehicleType, haversineM } = require('./gps/normalize');
const { dayOf } = require('./time');

let sharp = null;
try { sharp = require('sharp'); } catch { /* optional: photos are stored full size without it */ }

const LEARN_HITS = 3;
const FRESH_MS = 2 * 60e3; // the overview snapshot only shows the vehicle for a minute or two
const NOTIFY_MAX_AGE_MS = 15 * 60e3; // older (catch-up after downtime) events are recorded, not pushed
const HISTORY_DONE = 'camera_history_done'; // kv: when the first-run camera import succeeded
const PLAYABLE_WAIT_MS = 4 * 60e3; // the NVR makes a recording playable within 2 min; past this give up waiting
const PLAYABLE_POLL_MS = 15e3;
const TOP_VIEW_TRIES = 3;
const VETO_MOVED_M = 50; // moved less than this around an exit capture: a maneuver. Real ones moved 0-30 m, real exits 69 m or more (5 Nov 2026)

class Gate {
  constructor({ h, nvr, poller, config, cameras, tracker, plates, topView = null, log = console }) {
    this.h = h;
    this.nvr = nvr;
    this.poller = poller;
    this.cfg = config;
    this.ncfg = config.nvr;
    this.cameras = new Map(config.nvr.cameras.map((c) => [c.channel, c]));
    this.tracker = tracker;
    this.plates = plates;
    this.topView = topView;
    this.topRunning = new Map(); // event id -> running job
    this.topNext = new Map(); // event id -> don't ask the NVR again before this time
    this.log = log;
    this.photoDir = path.join(config.dataDir, 'photos');
    this.searchOk = true;
    this.lastError = null;
    this.timers = [];
    this.abort = new AbortController();
    void cameras;
  }

  // --- vehicle matching ------------------------------------------------------------------------

  vehicles() {
    return this.h.all('SELECT * FROM vehicles');
  }

  /** Learned plate -> vehicle id, from exits where exactly one vehicle left the yard. */
  learnedAliases(vs) {
    const taken = new Set(vs.filter((v) => v.plate).map((v) => v.id));
    const byPlate = new Map();
    for (const r of this.h.all('SELECT plate, vehicle_id, hits FROM alias_hits ORDER BY hits DESC')) {
      if (!byPlate.has(r.plate)) byPlate.set(r.plate, []);
      byPlate.get(r.plate).push(r);
    }
    const out = new Map();
    for (const [plate, rows] of byPlate) {
      const [best, second] = rows;
      if (best.hits >= LEARN_HITS && best.hits >= 2 * (second?.hits || 0) && !taken.has(best.vehicle_id)) {
        out.set(plate, best.vehicle_id);
        taken.add(best.vehicle_id);
      }
    }
    return out;
  }

  /** Fleet vehicle for a plate read: {vehicle, how} or null. */
  matchPlate(plate, vs = this.vehicles()) {
    if (!plate) return null;
    let v = vs.find((x) => x.plate && plateKey(x.plate) === plate);
    if (v) return { vehicle: v, how: 'alias' };
    v = vs.find((x) => plateKey(x.name) === plate);
    if (v) return { vehicle: v, how: 'plate' };
    const similar = vs.filter((x) => !x.plate && similarPlate(plateKey(x.name), plate));
    if (similar.length === 1) return { vehicle: similar[0], how: 'similar' };
    const learned = this.learnedAliases(vs).get(plate);
    if (learned) return { vehicle: vs.find((x) => x.id === learned), how: 'learned' };
    return null;
  }

  /** Plates the tracker may snap misreads to. */
  fleetPlates() {
    const vs = this.vehicles();
    const out = [];
    for (const v of vs) {
      if (v.plate) out.push(plateKey(v.plate));
      const k = plateKey(v.name);
      if (this.plates.isValid(k)) out.push(k);
    }
    for (const p of this.learnedAliases(vs).keys()) out.push(p);
    return [...new Set(out)];
  }

  // --- ingest ----------------------------------------------------------------------------------

  /**
   * Process every not-yet-seen capture on `channels` since `since`.
   * mode 'live': events are resolved against GPS and notified; 'history': recorded only (backfill).
   */
  async sync(channels, since, mode = 'live') {
    const caps = [];
    let ok = true;
    for (const ch of channels) {
      try {
        const list = await this.nvr.searchCaptures(ch, since, Date.now() + 60e3);
        caps.push(...list.filter((c) => c.time >= since));
      } catch (e) {
        ok = false;
        this.lastError = `ch${ch}: ${this.safeError(e)}`;
        this.log.warn?.(`capture search on ch${ch} failed: ${e.message}`);
      }
    }
    this.searchOk = ok;
    if (ok) this.lastError = null;
    // History goes in oldest first across cameras, so a partial answer waits for the retry.
    if (mode === 'history' && !ok) return 0;
    caps.sort((a, b) => a.time - b.time);
    let n = 0;
    for (const cap of caps) {
      const cam = this.cameras.get(cap.channel);
      if (!cam) continue;
      const d = this.tracker.process(cap, cam);
      if (!d) continue;
      n++;
      if (d.emit) await this.onDecision(d, mode);
    }
    return n;
  }

  /** An NVR error for people to read: network errors carry the plant's address, which stays on the server. */
  safeError(e) {
    let msg = String(e?.message || e);
    try {
      const { hostname } = new URL(this.ncfg.host);
      if (hostname) msg = msg.split(hostname).join('NVR');
    } catch { /* no host configured */ }
    return msg.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, 'NVR');
  }

  async onDecision(d, mode) {
    const cap = d.capture;
    const now = Date.now();
    const m = d.valid ? this.matchPlate(d.plate) : null;
    let status, resolveAt = null;
    if (mode === 'history') status = m || !d.valid ? 'history' : 'outside';
    else if (m && d.direction === 'in') status = 'pending';
    else if (!m && d.valid && d.direction === 'in') status = 'outside';
    else status = 'pending';
    if (status === 'pending') resolveAt = cap.time + this.ncfg.resolveAfterSec * 1000;
    const live = mode !== 'history';
    const topView = live && this.topView && d.camera.topView && d.camera.contextChannel ? 'pending' : null;
    const r = this.h.run(`INSERT OR IGNORE INTO gate_events (capture_name, t, direction, camera, channel, plate, plate_raw,
      plate_valid, vehicle_id, identified_by, status, stay_s, gap, capture_uri, resolve_at, created_at, top_view, alert_state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    cap.name, cap.time, d.direction, d.camera.name, cap.channel, d.plate, d.raw, d.valid ? 1 : 0,
    m?.vehicle.id ?? null, m?.how ?? null, status, d.staySeconds ?? null, d.gap ? 1 : 0, cap.uriPath || null, resolveAt, now,
    topView, live ? 'pending' : null);
    if (!r.changes) return;
    const id = Number(r.lastInsertRowid);
    if (mode === 'history') return;

    if (now - cap.time <= FRESH_MS + this.ncfg.pollSeconds * 1000) await this.fetchPhotos(id, d).catch((e) => this.log.warn?.(`photos for ${cap.name}: ${e.message}`));
    const ev = this.get(id);
    bus.emit('gate', ev);
    // Entries of known vehicles and outside vehicles go out at once; the rest after GPS resolution.
    if (ev.status === 'outside' || (ev.direction === 'in' && ev.vehicleId)) this.notify(id);
  }

  async fetchPhotos(id, d) {
    const photos = [];
    const cap = d.capture;
    const day = dayOf(cap.time);
    const dir = path.join(this.photoDir, day);
    fs.mkdirSync(dir, { recursive: true });
    const save = async (name, buf, i) => {
      const file = `${day}/${id}_${i}.jpg`;
      fs.writeFileSync(path.join(this.photoDir, file), await shrink(buf));
      photos.push({ name, file });
    };
    try { await save(d.camera.name, await this.nvr.captureImage(cap), 1); } catch (e) { this.log.warn?.(`capture image: ${e.message}`); }
    if (d.camera.contextChannel && Date.now() - cap.time <= FRESH_MS) {
      try { await save(d.camera.contextName || `ch${d.camera.contextChannel}`, await this.nvr.snapshot(d.camera.contextChannel), 2); } catch (e) { this.log.warn?.(`snapshot: ${e.message}`); }
    }
    // On a slow line the top view can be there first: it stays, and takes the snapshot's place.
    const now = JSON.parse(this.h.get('SELECT photos FROM gate_events WHERE id = ?', id).photos || '[]').filter((p) => p.v);
    const kept = photos.filter((p) => !now.some((x) => x.name === p.name));
    this.h.run('UPDATE gate_events SET photos = ? WHERE id = ?', JSON.stringify([...kept, ...now]), id);
  }

  /** Photo file for the API. History events get their capture image from the NVR the first time. */
  async photoFile(id, n) {
    const row = this.h.get('SELECT * FROM gate_events WHERE id = ?', id);
    if (!row) return null;
    const photos = JSON.parse(row.photos || '[]');
    if (photos[n]) return path.join(this.photoDir, photos[n].file);
    if (n === 0 && row.capture_uri && this.nvr) {
      const day = dayOf(row.t);
      fs.mkdirSync(path.join(this.photoDir, day), { recursive: true });
      const file = `${day}/${id}_1.jpg`;
      const buf = await this.nvr.captureImage({ channel: row.channel, time: row.t, name: row.capture_name, uriPath: row.capture_uri, plate: row.plate_raw });
      fs.writeFileSync(path.join(this.photoDir, file), await shrink(buf));
      this.h.run('UPDATE gate_events SET photos = ? WHERE id = ?', JSON.stringify([{ name: row.camera, file }]), id);
      return path.join(this.photoDir, file);
    }
    return null;
  }

  // --- GPS resolution --------------------------------------------------------------------------

  /** Vehicles whose yard visit ended (kind 'exit') or started ('enter') within [from, to]. */
  crossings(kind, from, to) {
    const col = kind === 'exit' ? 'exit_t' : 'enter_t';
    const extra = kind === 'enter' ? 'AND approx = 0' : '';
    return this.h.all(`SELECT DISTINCT vehicle_id FROM yard_visits WHERE ${col} BETWEEN ? AND ? ${extra}`, from, to).map((r) => r.vehicle_id);
  }

  /** Metres a vehicle covered from 2 min before a capture until `afterMs` after it, from the position samples. */
  movedAround(vehicleId, t, afterMs) {
    const ps = this.h.all('SELECT lat, lng FROM positions WHERE vehicle_id = ? AND t BETWEEN ? AND ? ORDER BY t', vehicleId, t - 2 * 60e3, t + afterMs);
    let m = 0;
    for (let i = 1; i < ps.length; i++) m += haversineM(ps[i - 1].lat, ps[i - 1].lng, ps[i].lat, ps[i].lng);
    return m;
  }

  resolvePending(now = Date.now()) {
    const due = this.h.all("SELECT * FROM gate_events WHERE status = 'pending' AND resolve_at <= ? ORDER BY t", now);
    for (const row of due) {
      try { this.resolve(row, now); } catch (e) { this.log.warn?.(`resolve ${row.id}: ${e.message}`); }
    }
  }

  resolve(row, now) {
    const t = row.t;
    const before = this.ncfg.matchBeforeSec * 1000, after = this.ncfg.matchAfterSec * 1000;
    const exitConfirm = this.ncfg.exitConfirmMin * 60e3;
    const live = row.vehicle_id ? this.poller?.live.get(row.vehicle_id) : null;
    const set = (status, note = null, extra = {}) => {
      const vid = extra.vehicleId !== undefined ? extra.vehicleId : row.vehicle_id;
      const how = extra.how !== undefined ? extra.how : row.identified_by;
      this.h.run('UPDATE gate_events SET status = ?, status_note = ?, vehicle_id = ?, identified_by = ?, resolve_at = NULL WHERE id = ?',
        status, note, vid, how, row.id);
      const ev = this.get(row.id);
      bus.emit('gate:update', ev);
      if (status !== 'vetoed' && !row.notified) this.notify(row.id);
      return ev;
    };
    const later = (ms) => this.h.run('UPDATE gate_events SET resolve_at = ? WHERE id = ?', now + ms, row.id);
    const gpsFresh = live && live.status !== 'offline' && live.recordTime && live.recordTime >= t;

    if (row.direction === 'out') {
      if (row.vehicle_id) {
        // Trucks often pass the exit camera and leave the circle minutes later, so the whole window counts.
        if (this.crossings('exit', t - before, t + exitConfirm).includes(row.vehicle_id)) return set('confirmed', "GPS: hovlidan chiqdi");
        if (live && live.status !== 'offline' && live.inYard) {
          if (now - t < exitConfirm) return later(30e3);
          // Trucks often pass the exit camera and stand in the yard circle for minutes (paperwork, tarpaulin), and a
          // standing tracker reports rarely. So being in the circle isn't a veto: only not having moved is.
          if (this.movedAround(row.vehicle_id, t, exitConfirm) >= VETO_MOVED_M) return set('unconfirmed', "GPS: chiqqan, lekin hovli yonida turibdi");
          return set('vetoed', `GPS: ${Math.round(exitConfirm / 60e3)} daqiqadan keyin ham hovlida turibdi`);
        }
        if (!gpsFresh && now - t < exitConfirm) return later(30e3);
        return set('unconfirmed', gpsFresh ? "GPS: hovli chegarasida kesib o'tish ko'rinmadi" : "GPS ma'lumoti yo'q");
      }
      if (now - t < after + 15e3) return later(15e3);
      let cands = this.crossings('exit', t - before, t + after);
      if (row.plate_valid && row.plate) {
        // A clean read that isn't a fleet plate: evidence for an alias when exactly one vehicle left.
        if (cands.length === 1) {
          this.h.run(`INSERT INTO alias_hits (plate, vehicle_id, hits, last) VALUES (?, ?, 1, ?)
            ON CONFLICT(plate, vehicle_id) DO UPDATE SET hits = hits + 1, last = excluded.last`, row.plate, cands[0], t);
          const m = this.matchPlate(row.plate);
          if (m) return set('confirmed', "GPS: hovlidan chiqdi", { vehicleId: m.vehicle.id, how: m.how });
        }
        return set('outside', "GPS ro'yxatida yo'q");
      }
      if (row.plate && cands.length > 1) {
        const vs = this.vehicles().filter((v) => cands.includes(v.id));
        const close = vs.filter((v) => { const k = plateKey(v.plate || v.name); return k.includes(row.plate) || this.plates.distance(row.plate, k) <= 3; });
        if (close.length) cands = close.map((v) => v.id);
      }
      if (cands.length === 1) return set('confirmed', "Raqam o'qilmadi, GPS bo'yicha aniqlandi", { vehicleId: cands[0], how: 'gps' });
      return set('outside', cands.length ? `Aniqlab bo'lmadi: bir vaqtda ${cands.length} ta mashina chiqdi` : "GPS bo'yicha aniqlanmadi");
    }

    // entries
    if (row.vehicle_id) {
      if (this.crossings('enter', t - 2 * 60e3, t + 10 * 60e3).includes(row.vehicle_id)) return set('confirmed', 'GPS: hovliga kirdi');
      const open = this.poller?.openVisit.get(row.vehicle_id);
      if (open && open.enter_t < t - 5 * 60e3) {
        const lastIn = this.h.get("SELECT MAX(t) t FROM gate_events WHERE vehicle_id = ? AND direction = 'in' AND id != ? AND t < ? AND status IN ('confirmed','unconfirmed','history')", row.vehicle_id, row.id, t)?.t;
        const lastOut = this.h.get("SELECT MAX(t) t FROM gate_events WHERE vehicle_id = ? AND direction = 'out' AND t < ? AND status IN ('confirmed','unconfirmed','history')", row.vehicle_id, t)?.t;
        if (lastIn && lastIn >= open.enter_t && (!lastOut || lastOut < lastIn)) return set('vetoed', 'GPS: hovlidan chiqmagan, kirish allaqachon qayd etilgan');
      }
      if (now - t < 10 * 60e3 && !(live && live.inYard)) return later(30e3);
      return set(live && live.inYard ? 'confirmed' : 'unconfirmed', live && live.inYard ? 'GPS: hovlida' : "GPS: hovliga kirish ko'rinmadi");
    }
    if (now - t < 3 * 60e3) return later(20e3);
    const cands = this.crossings('enter', t - 60e3, t + 3 * 60e3);
    if (cands.length === 1) return set('confirmed', "Raqam o'qilmadi, GPS bo'yicha aniqlandi", { vehicleId: cands[0], how: 'gps' });
    return set('outside', row.plate ? "GPS ro'yxatida yo'q" : "Raqam o'qilmadi");
  }

  // --- top view --------------------------------------------------------------------------------

  /** Start top view jobs that are due. Runs often; each job runs on its own. */
  pumpTopViews(now = Date.now()) {
    if (!this.topView) return;
    const free = this.ncfg.topViewWorkers - this.topRunning.size;
    if (free <= 0) return;
    const rows = this.h.all("SELECT * FROM gate_events WHERE top_view = 'pending' ORDER BY t LIMIT 50");
    let started = 0;
    for (const row of rows) {
      if (started >= free) break;
      if (this.topRunning.has(row.id) || (this.topNext.get(row.id) || 0) > now) continue;
      const cam = this.cameras.get(row.channel);
      if (row.status === 'vetoed' || !cam?.topView || !cam.contextChannel) {
        this.h.run("UPDATE gate_events SET top_view = NULL WHERE id = ?", row.id);
        continue;
      }
      if (now < row.t + cam.topView.to * 1000) continue; // it isn't over yet
      started++;
      const job = this.runTopView(row, cam)
        .catch((e) => this.log.warn?.(`top view ${row.id}: ${e.message}`))
        .finally(() => { this.topRunning.delete(row.id); });
      this.topRunning.set(row.id, job);
    }
  }

  async runTopView(row, cam) {
    const end = row.t + cam.topView.to * 1000;
    if (!await this.topView.ready(cam.contextChannel, end)) {
      if (Date.now() - end < PLAYABLE_WAIT_MS) {
        this.topNext.set(row.id, Date.now() + PLAYABLE_POLL_MS);
        return;
      }
      return this.topViewDone(row.id, 'failed', 'yozuv tayyor bo\'lmadi');
    }
    let shot;
    try {
      shot = await this.topView.grab(cam, row.t, { final: row.top_view_tries + 1 >= TOP_VIEW_TRIES });
    } catch (e) {
      const tries = row.top_view_tries + 1;
      const note = this.safeError(e);
      this.log.warn?.(`top view ch${cam.contextChannel} of event ${row.id} failed (${tries}/${TOP_VIEW_TRIES}): ${note}`);
      if (tries < TOP_VIEW_TRIES) {
        this.h.run('UPDATE gate_events SET top_view_tries = ? WHERE id = ?', tries, row.id);
        this.topNext.set(row.id, Date.now() + PLAYABLE_POLL_MS);
        return;
      }
      return this.topViewDone(row.id, 'failed', note);
    }
    if (!shot.jpeg) {
      this.log.info?.(`top view ch${cam.contextChannel} of event ${row.id}: no vehicle in ${shot.frames} frames`);
      return this.topViewDone(row.id, 'none');
    }
    this.log.info?.(`top view ch${cam.contextChannel} of event ${row.id}: vehicle at ${shot.t >= 0 ? '+' : ''}${Math.round(shot.t)} s, ${Math.round(shot.share * 100)}% of the lane, ${shot.passes} pass(es) in ${shot.frames} frames`);
    await this.saveTopView(row, cam, shot.jpeg);
    this.topViewDone(row.id, 'done');
  }

  /** The top view takes the live snapshot's place, after the capture image. */
  async saveTopView(row, cam, jpeg) {
    // A catch-up event has no photos yet: the capture image goes first.
    if (JSON.parse(row.photos || '[]').length === 0 && row.capture_uri) await this.photoFile(row.id, 0).catch((e) => this.log.warn?.(`capture image: ${this.safeError(e)}`));
    const day = dayOf(row.t);
    fs.mkdirSync(path.join(this.photoDir, day), { recursive: true });
    const file = `${day}/${row.id}_top.jpg`;
    fs.writeFileSync(path.join(this.photoDir, file), jpeg);
    const name = cam.contextName || `ch${cam.contextChannel}`;
    const before = JSON.parse(this.h.get('SELECT photos FROM gate_events WHERE id = ?', row.id).photos || '[]');
    for (const p of before) if (p.name === name && p.file !== file) fs.rmSync(path.join(this.photoDir, p.file), { force: true });
    const photos = [...before.filter((p) => p.name !== name), { name, file, v: 'top' }];
    this.h.run('UPDATE gate_events SET photos = ? WHERE id = ?', JSON.stringify(photos), row.id);
  }

  topViewDone(id, state, note = null) {
    this.topNext.delete(id);
    this.h.run('UPDATE gate_events SET top_view = ?, top_view_note = ? WHERE id = ?', state, note, id);
    const ev = this.get(id);
    if (ev) bus.emit('gate:update', ev);
  }

  /** Top views of the last hours, for the status page and the health check. */
  topViewStats(sinceMs = Date.now() - 24 * 3600e3) {
    const out = { done: 0, none: 0, failed: 0, pending: 0 };
    for (const r of this.h.all('SELECT top_view s, COUNT(*) n FROM gate_events WHERE t >= ? AND top_view IS NOT NULL GROUP BY top_view', sinceMs)) out[r.s] = r.n;
    return out;
  }

  // --- final -----------------------------------------------------------------------------------

  /**
   * Events whose story is complete go out on 'gate:final', once.
   * An entry waits for GPS only until the first look: its confirmation can take 10 minutes and adds nothing. A repeat
   * entry is vetoed at that first look, so it doesn't get through. Neither does an exit wait once the truck has moved:
   * that can't be a maneuver any more, and only its confirmation is still open.
   */
  finalize(now = Date.now()) {
    const settled = (row) => {
      if (row.status !== 'pending') return true;
      if (!row.vehicle_id || now - row.t < (this.ncfg.resolveAfterSec + 15) * 1000) return false;
      return row.direction === 'in' || this.movedAround(row.vehicle_id, row.t, now - row.t) >= VETO_MOVED_M;
    };
    for (const row of this.h.all("SELECT * FROM gate_events WHERE alert_state = 'pending' ORDER BY t")) {
      if (row.status === 'vetoed' || now - row.t > this.ncfg.catchupHours * 3600e3) {
        this.h.run("UPDATE gate_events SET alert_state = 'skipped' WHERE id = ?", row.id);
        continue;
      }
      if (row.top_view === 'pending' || !settled(row)) continue;
      try {
        this.h.tx(() => {
          this.h.run("UPDATE gate_events SET alert_state = 'done' WHERE id = ?", row.id);
          bus.emit('gate:final', this.get(row.id));
        });
      } catch (e) {
        this.log.warn?.(`final ${row.id}: ${e.message}`); // stays pending: tried again next round
      }
    }
  }

  notify(id) {
    const ev = this.get(id);
    if (!ev || Date.now() - ev.t > NOTIFY_MAX_AGE_MS) return;
    this.h.run('UPDATE gate_events SET notified = 1 WHERE id = ?', id);
    bus.emit('gate:notify', ev);
  }

  // --- views -----------------------------------------------------------------------------------

  get(id) {
    const row = this.h.get('SELECT * FROM gate_events WHERE id = ?', id);
    return row ? view(row, this.h) : null;
  }

  // --- running ---------------------------------------------------------------------------------

  async start() {
    const channels = [...this.cameras.keys()];
    const last = this.tracker.lastSightingTime();
    const now = Date.now();
    // Sightings without the mark: a database from before the mark existed, its import already ran.
    this.historyPending = last == null && this.ncfg.backfillDays > 0 && !this.h.kvGet(HISTORY_DONE);
    if (this.historyPending) {
      await this.importHistory(channels);
    } else if (last != null) {
      const since = Math.max(last, now - this.ncfg.catchupHours * 3600e3) - 5 * 60e3;
      const n = await this.sync(channels, since, 'live').catch(() => 0);
      this.log.info?.(`camera catch-up: ${n} new captures`);
    }
    this.pollFrom = Date.now();
    this._listen();
    const poll = async () => {
      if (this.abort.signal.aborted) return;
      if (this.historyPending) {
        await this.importHistory(channels);
      } else {
        const from = Math.max(this.pollFrom, Date.now() - this.ncfg.catchupHours * 3600e3) - 5 * 60e3;
        await this.sync(channels, from, 'live').catch(() => {});
        if (this.searchOk) this.pollFrom = Date.now();
      }
      this.timers[0] = setTimeout(poll, this.ncfg.pollSeconds * 1000);
    };
    this.timers[0] = setTimeout(poll, this.ncfg.pollSeconds * 1000);
    const resolveLoop = () => {
      try {
        this.resolvePending();
        this.pumpTopViews();
        this.finalize();
      } catch (e) {
        this.log.warn?.(`gate loop: ${e.message}`);
      }
      this.timers[1] = setTimeout(resolveLoop, 5000);
    };
    resolveLoop();
    const cleanup = () => { this.cleanupPhotos(); this.timers[2] = setTimeout(cleanup, 6 * 3600e3); };
    this.timers[2] = setTimeout(cleanup, 60e3);
  }

  /**
   * The first-run import. Done only once every camera has answered: if the NVR is down it stays pending and each
   * poll tries again. Until then live captures wait, so the import can't arrive after, and out of order with, them.
   */
  async importHistory(channels) {
    const since = Date.now() - this.ncfg.backfillDays * 86400e3;
    if (!this.historyAnnounced) this.log.info?.(`camera history: importing ${this.ncfg.backfillDays} days`);
    this.historyAnnounced = true;
    const n = await this.sync(channels, since, 'history').catch((e) => {
      this.searchOk = false;
      this.log.warn?.(`history import failed: ${e.message}`);
      return 0;
    });
    if (!this.searchOk) return;
    this.historyPending = false;
    this.h.kvSet(HISTORY_DONE, Date.now());
    this.pollFrom = Date.now();
    this.log.info?.(`camera history: ${n} captures`);
    bus.emit('gate:history', { since, captures: n });
  }

  _listen() {
    const loop = async () => {
      while (!this.abort.signal.aborted) {
        try {
          await this.nvr.anprEvents((ch) => {
            if (!this.cameras.has(ch) || this.historyPending) return; // the import will include this capture
            // The record lands on the NVR a few seconds after the event: retry briefly.
            (async () => {
              for (let i = 0; i < 5; i++) {
                await sleep(2000);
                if (await this.sync([ch], Date.now() - 5 * 60e3, 'live').catch(() => 0)) break;
              }
            })();
          }, { signal: this.abort.signal });
        } catch (e) {
          if (!this.abort.signal.aborted) this.log.warn?.(`NVR event stream dropped: ${e.message}`);
        }
        await sleep(5000);
      }
    };
    loop();
  }

  stop() {
    this.abort.abort();
    this.timers.forEach(clearTimeout);
    this.topView?.stop();
  }

  cleanupPhotos() {
    const keep = this.ncfg.keepPhotosDays;
    if (!keep || !fs.existsSync(this.photoDir)) return;
    const cutoff = dayOf(Date.now() - keep * 86400e3);
    for (const d of fs.readdirSync(this.photoDir)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < cutoff) fs.rmSync(path.join(this.photoDir, d), { recursive: true, force: true });
    }
  }

  health() {
    return {
      enabled: true,
      lastOk: this.nvr.lastOk || null,
      lastStream: this.nvr.lastStream || null,
      searchOk: this.searchOk,
      error: this.lastError,
      lastCapture: this.tracker.lastSightingTime(),
    };
  }
}

async function shrink(buf) {
  if (!sharp) return buf;
  try {
    const img = sharp(buf);
    const meta = await img.metadata();
    if (Math.max(meta.width || 0, meta.height || 0) <= 1280) return buf;
    return await img.resize(1280, 1280, { fit: 'inside' }).jpeg({ quality: 80 }).toBuffer();
  } catch {
    return buf; // never lose a photo over this
  }
}

/** API shape of a gate event. */
function view(row, h) {
  const v = row.vehicle_id ? h.get('SELECT * FROM vehicles WHERE id = ?', row.vehicle_id) : null;
  const photos = JSON.parse(row.photos || '[]');
  const nPhotos = photos.length || (row.capture_uri ? 1 : 0);
  return {
    id: row.id,
    t: row.t,
    direction: row.direction,
    camera: row.camera,
    plate: row.plate,
    plateText: row.plate ? (row.plate_valid ? prettyPlate(row.plate) : row.plate) : null,
    plateRaw: row.plate_raw,
    plateValid: !!row.plate_valid,
    vehicleId: row.vehicle_id,
    vehicleLabel: v ? vehicleLabel(v) : null,
    gpsName: v ? v.name : null,
    vehicleType: v ? vehicleType(v) : null,
    identifiedBy: row.identified_by,
    status: row.status,
    note: row.status_note,
    staySeconds: row.stay_s,
    gap: !!row.gap,
    topView: row.top_view,
    photos: Array.from({ length: nPhotos }, (_, i) => ({ name: photos[i]?.name || row.camera, url: `/api/gate-events/${row.id}/photo/${i}${photos[i]?.v ? `?v=${photos[i].v}` : ''}` })),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { Gate, view, shrink };
