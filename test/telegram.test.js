'use strict';
// Telegram against a local fake of the Bot API: alerts with photos to each recipient, retries and give-ups, moved
// groups, commands and who may use them, scheduled reports, and the gate's stages leading to an alert.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { open, helpers } = require('../src/db');
const bus = require('../src/bus');
const T = require('../src/time');
const { Gate } = require('../src/gate');
const { Tracker } = require('../src/cameras/tracker');
const plates = require('../src/cameras/plates');
const { Outbox, MAX_ATTEMPTS } = require('../src/notify/outbox');
const { TelegramClient, TelegramError, multipart } = require('../src/telegram/client');
const { Telegram } = require('../src/telegram');
const { gateCaption, duration } = require('../src/telegram/format');

/** A fake Bot API. `script(method, fields)` may answer differently; everything is recorded. */
function fakeTelegram(t) {
  const calls = [];
  const state = { script: null, nextFile: 1 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const method = req.url.split('/').pop();
      const body = Buffer.concat(chunks);
      const raw = body.toString('latin1');
      const fields = {};
      if (/multipart/.test(req.headers['content-type'])) {
        for (const m of raw.matchAll(/name="(\w+)"\r\n\r\n([\s\S]*?)\r\n--/g)) fields[m[1]] = Buffer.from(m[2], 'latin1').toString('utf8');
      } else Object.assign(fields, Object.fromEntries(new URLSearchParams(raw)));
      const files = [...raw.matchAll(/name="(\w+)"; filename="([^"]+)"/g)].map((m) => m[2]);
      calls.push({ method, fields, files, path: req.url, bytes: body.length });
      const custom = state.script?.(method, fields);
      if (custom) return res.end(JSON.stringify(custom));
      let result = true;
      if (method === 'getMe') result = { id: 1, username: 'test_bot' };
      if (method === 'getUpdates') return setTimeout(() => res.end(JSON.stringify({ ok: true, result: [] })), 20);
      if (method === 'sendMessage') result = { message_id: 1 };
      if (method === 'sendPhoto') result = { photo: [{ file_id: 'small' }, { file_id: `F${state.nextFile++}` }] };
      if (method === 'sendMediaGroup') result = JSON.parse(fields.media).map(() => ({ photo: [{ file_id: 'small' }, { file_id: `F${state.nextFile++}` }] }));
      if (method === 'getChat') result = { id: fields.chat_id, type: 'private', first_name: 'Ali' };
      res.end(JSON.stringify({ ok: true, result }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
    resolve({ url: `http://127.0.0.1:${server.address().port}`, calls, state, sent: (m) => calls.filter((c) => c.method === m) });
  }));
}

const NOLOG = {};

function rig(t, api, { chatIds = [], adminIds = ['100'], allVehicles = true, gps = null, reportTime = '22:00', reportTo = 'groups', miniApp = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-'));
  const db = open(':memory:');
  const h = helpers(db);
  h.run('INSERT INTO vehicles (id, name, updated_at) VALUES (1, ?, ?)', '85 450 KBA', Date.now());
  h.run('INSERT INTO vehicles (id, name, plate, updated_at) VALUES (2, ?, ?, ?)', '85 519 EBA', '10964DDA', Date.now());
  const config = {
    dataDir,
    yard: { lat: 41.2655, lng: 69.3418, radiusM: 150 },
    gps: { offlineMinutes: 30 },
    nvr: { cameras: [
      { channel: 4, name: 'ANPR-1', direction: 'in', contextChannel: 5, contextName: "Yo'l-2", topView: { from: -2, to: 2, expect: 0 } },
      { channel: 3, name: 'ANPR-2', direction: 'out', contextChannel: 6, contextName: "Yo'l-1", topView: { from: -2, to: 2, expect: 0 } },
    ], resolveAfterSec: 90, exitConfirmMin: 5, matchBeforeSec: 45, matchAfterSec: 90, pollSeconds: 60, catchupHours: 6, backfillDays: 0, keepPhotosDays: 0, topViewWorkers: 2 },
    telegram: { token: 'TESTTOKEN', apiBase: api.url, chatIds, adminIds, allVehicles, reportTime, reportTo, miniApp },
    publicOrigin: 'https://tbb.example',
  };
  const cap = Buffer.from([0xff, 0xd8, 1, 0xff, 0xd9]);
  const topView = { calls: 0, result: { jpeg: Buffer.from([0xff, 0xd8, 2, 0xff, 0xd9]), share: 0.3, t: 1, frames: 4, passes: 1 }, async ready() { return this.isReady !== false; }, async grab() { this.calls++; if (this.error) throw this.error; return this.result; }, stop() {} };
  const nvr = { captureImage: async () => cap, snapshot: async () => cap };
  const poller = { live: new Map(), openVisit: new Map() };
  let gate;
  const tracker = new Tracker(db, { fleetPlates: () => gate.fleetPlates() });
  gate = new Gate({ h, nvr, poller, config, tracker, plates, topView, log: NOLOG });
  const outbox = new Outbox({ h, log: NOLOG });
  const analytics = { rollup: async () => {} };
  const health = { addCheck() {}, summary: () => ({ problems: [] }) };
  const telegram = new Telegram({ h, config, gate, gps, poller, analytics, places: null, health, outbox, log: NOLOG });
  for (const [k, fn] of Object.entries(telegram.listeners)) bus.on(k, fn);
  t.after(() => {
    for (const [k, fn] of Object.entries(telegram.listeners)) bus.off(k, fn);
    telegram.tg.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  let n = 0;
  const capture = async (channel, time, plate) => {
    n++;
    const c = { channel, time, plate, name: `ch0${channel}_${n}_${plate || 'UNKNOWN'}`, uriPath: '/x' };
    const d = tracker.process(c, config.nvr.cameras.find((x) => x.channel === channel));
    if (d?.emit) await gate.onDecision(d, 'live');
    return h.get('SELECT * FROM gate_events WHERE capture_name = ?', c.name);
  };
  const settle = async (now = Date.now()) => {
    gate.resolvePending(now);
    gate.pumpTopViews(now);
    await Promise.all(gate.topRunning.values());
    gate.finalize(now);
  };
  return { h, gate, config, outbox, telegram, topView, poller, capture, settle, dataDir };
}

test('client: multipart body holds the fields and the file', () => {
  const m = multipart({ chat_id: '5', caption: 'salom' }, { p0: { filename: "Yo'l-2.jpg", data: Buffer.from('JPEG') } });
  const s = m.body.toString();
  assert.match(m.contentType, /^multipart\/form-data; boundary=/);
  assert.match(s, /name="chat_id"\r\n\r\n5\r\n/);
  assert.match(s, /name="p0"; filename="Yo_l-2\.jpg"\r\nContent-Type: image\/jpeg\r\n\r\nJPEG\r\n/);
});

test('client: the token never appears in an error', async (t) => {
  const c = new TelegramClient({ token: 'SECRET123', apiBase: 'http://127.0.0.1:9', retries: 1, log: NOLOG });
  t.after(() => c.close());
  await assert.rejects(c.getMe(), (e) => { assert.ok(!e.message.includes('SECRET123'), e.message); return e instanceof TelegramError; });
});

test('client: an address that fails to connect goes last, the one that worked first', async (t) => {
  const c = new TelegramClient({ token: 'x', apiBase: 'https://api.telegram.org', log: NOLOG });
  t.after(() => c.close());
  const lookup = (opts = {}) => new Promise((resolve) => c._lookup('nonexistent.invalid', opts, (err, a, f) => resolve(opts.all ? a : [a, f])));
  const [first, family] = await lookup();
  assert.equal(family, 4);
  c.badIps.set(first, Date.now());
  const [second] = await lookup();
  assert.notEqual(second, first);
  c.badIps.set(second, Date.now() + 1);
  const [third] = await lookup();
  assert.ok(![first, second].includes(third));
  c.goodIp = '149.154.167.99';
  c.badIps.clear();
  assert.equal((await lookup())[0], '149.154.167.99');
  assert.deepEqual(await lookup({ all: true }), [{ address: '149.154.167.99', family: 4 }]);
});

test('client: errors are classified from what Telegram says', async (t) => {
  const api = await fakeTelegram(t);
  const c = new TelegramClient({ token: 'x', apiBase: api.url, retries: 1, log: NOLOG });
  t.after(() => c.close());
  const answers = {
    blocked: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
    gone: { ok: false, error_code: 400, description: 'Bad Request: chat not found' },
    moved: { ok: false, error_code: 400, description: 'group upgraded', parameters: { migrate_to_chat_id: -100777 } },
    conflict: { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' },
    busy: { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 7 } },
  };
  for (const [k, a] of Object.entries(answers)) {
    api.state.script = () => a;
    const e = await c.sendText('x', 1).catch((x) => x);
    if (k === 'blocked' || k === 'gone') assert.equal(e.permanent, true, k);
    if (k === 'moved') assert.equal(e.moveTo, '-100777');
    if (k === 'conflict') assert.equal(e.conflict, true);
    if (k === 'busy') assert.equal(e.retryAfterMs, 7000);
  }
});

test('an entry: photo of the capture and the top view, one album for each recipient, uploaded once', async (t) => {
  const api = await fakeTelegram(t);
  const r = rig(t, api, { chatIds: ['-1001', '555'] });
  const ev = await r.capture(4, Date.now() - 20e3, '85450KBA');
  assert.equal(ev.top_view, 'pending');
  await r.settle();
  assert.equal(r.topView.calls, 1);
  const shown = r.gate.get(ev.id);
  assert.equal(shown.photos.length, 2);
  assert.equal(shown.photos[1].name, "Yo'l-2");
  assert.match(shown.photos[1].url, /\?v=top$/, 'the browser must not keep the old snapshot');

  // Not out yet: GPS has its first look at +90 s.
  assert.equal(r.h.get('SELECT COUNT(*) n FROM outbox').n, 0);
  await r.settle(ev.t + 110e3);
  assert.equal(r.h.get('SELECT COUNT(*) n FROM outbox').n, 2);
  await r.outbox.drain();
  const albums = api.sent('sendMediaGroup');
  assert.equal(albums.length, 2);
  assert.equal(albums[0].files.length, 2, 'first recipient: uploaded');
  assert.equal(albums[1].files.length, 0, 'second recipient: Telegram\'s copies');
  const media = JSON.parse(albums[0].fields.media);
  assert.match(media[0].caption, /KIRDI/);
  assert.match(media[0].caption, /85 450 KBA/);
  assert.deepEqual(JSON.parse(albums[1].fields.media).map((m) => m.media), ['F1', 'F2']);
  assert.equal(media[0].caption, JSON.parse(albums[1].fields.media)[0].caption);
  assert.equal(r.outbox.counts('telegram').sent, 2);
});

test('an alert waits for its top view, and goes without it when none can be had', async (t) => {
  const api = await fakeTelegram(t);
  const r = rig(t, api, { chatIds: ['555'] });
  const t0 = Date.now() - 200e3;
  const ev = await r.capture(4, t0, '85450KBA');
  r.topView.isReady = false; // not playable yet
  await r.settle();
  assert.equal(r.gate.get(ev.id).topView, 'pending');
  assert.equal(r.h.get('SELECT COUNT(*) n FROM outbox').n, 0, 'waits');
  r.topView.isReady = true;
  r.topView.result = { jpeg: null, frames: 18, passes: 0 };
  r.gate.topNext.clear();
  await r.settle();
  assert.equal(r.gate.get(ev.id).topView, 'none');
  await r.outbox.drain();
  assert.equal(api.sent('sendMediaGroup').length + api.sent('sendPhoto').length, 1);
});

test('top view: a failure is tried again; a third failure lets the alert go', async (t) => {
  const api = await fakeTelegram(t);
  const r = rig(t, api, { chatIds: ['555'] });
  const ev = await r.capture(4, Date.now() - 200e3, '85450KBA');
  r.topView.error = new Error('ffmpeg exit 1');
  for (let i = 1; i <= 3; i++) {
    r.gate.topNext.clear();
    await r.settle();
    assert.equal(r.topView.calls, i);
  }
  const row = r.h.get('SELECT top_view, top_view_note, alert_state FROM gate_events WHERE id = ?', ev.id);
  assert.equal(row.top_view, 'failed');
  assert.equal(row.alert_state, 'done');
  assert.match(row.top_view_note, /ffmpeg/);
});

test('a slow capture download can\'t overwrite a top view that finished first', async (t) => {
  const api = await fakeTelegram(t);
  const r = rig(t, api);
  const ev = await r.capture(4, Date.now() - 200e3, '85450KBA');
  r.gate.pumpTopViews();
  await Promise.all(r.gate.topRunning.values());
  assert.equal(r.gate.get(ev.id).topView, 'done');
  // The download that started at the capture ends now.
  await r.gate.fetchPhotos(ev.id, { capture: { channel: 4, time: Date.now() - 30e3, uriPath: '/x' }, camera: { name: 'ANPR-1', contextChannel: 5, contextName: "Yo'l-2" } });
  const photos = r.gate.get(ev.id).photos;
  assert.deepEqual(photos.map((p) => p.name), ['ANPR-1', "Yo'l-2"]);
  assert.match(photos[1].url, /\?v=top$/);
});

test('a vetoed maneuver: no top view read, no alert', async (t) => {
  const api = await fakeTelegram(t);
  const r = rig(t, api, { chatIds: ['555'] });
  const t0 = Date.now() - 6 * 60e3;
  r.poller.live.set(1, { id: 1, status: 'stopped', inYard: true, recordTime: t0 + 5 * 60e3 });
  const ev = await r.capture(3, t0, '85450KBA');
  r.gate.resolvePending();
  assert.equal(r.gate.get(ev.id).status, 'vetoed');
  await r.settle();
  assert.equal(r.topView.calls, 0);
  assert.equal(r.h.get('SELECT COUNT(*) n FROM outbox').n, 0);
  assert.equal(r.h.get('SELECT alert_state s FROM gate_events WHERE id = ?', ev.id).s, 'skipped');
});

test('an exit still inside the circle after moving is not a maneuver: alerted, counted', async (t) => {
  // 5 Nov 2026: seven real exits were vetoed because the trucks stood in the yard circle after the exit camera.
  const api = await fakeTelegram(t);
  const r = rig(t, api, { chatIds: ['555'] });
  const t0 = Date.now() - 6 * 60e3;
  r.poller.live.set(1, { id: 1, status: 'stopped', inYard: true, recordTime: t0 + 5 * 60e3 });
  const ins = r.h.db.prepare('INSERT INTO positions (vehicle_id, t, lat, lng, speed, status) VALUES (1, ?, ?, 69.3418, 5, ?)');
  ins.run(t0 - 60e3, 41.2655, 'moving');
  ins.run(t0, 41.2660, 'moving'); // 55 m
  ins.run(t0 + 60e3, 41.2662, 'stopped');
  const ev = await r.capture(3, t0, '85450KBA');
  r.gate.resolvePending();
  assert.equal(r.gate.get(ev.id).status, 'unconfirmed');
});

test('an exit that left the circle within the 5 minutes is confirmed, however late the tracker reported', async (t) => {
  const api = await fakeTelegram(t);
  const r = rig(t, api);
  const t0 = Date.now() - 6 * 60e3;
  r.poller.live.set(1, { id: 1, status: 'stopped', inYard: true, recordTime: t0 + 5 * 60e3 });
  r.h.run('INSERT INTO yard_visits (vehicle_id, enter_t, exit_t) VALUES (1, ?, ?)', t0 - 3600e3, t0 + 290e3);
  const ev = await r.capture(3, t0, '85450KBA');
  r.gate.resolvePending();
  assert.equal(r.gate.get(ev.id).status, 'confirmed');
});

test('outbox: a failure doesn\'t stop the others; retried with back-off; a blocked user is given up on and admins are told', async (t) => {
  const api = await fakeTelegram(t);
  const r = rig(t, api, { chatIds: ['-1001', '555'] });
  api.state.script = (m, f) => (m === 'sendMediaGroup' && f.chat_id === '555' ? { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } : null);
  const ev = await r.capture(4, Date.now() - 200e3, '85450KBA');
  await r.settle();
  await r.outbox.drain();
  const rows = r.h.all('SELECT target, status, last_error FROM outbox WHERE ref = ? ORDER BY id', ev.id);
  assert.deepEqual(rows.map((x) => x.status), ['sent', 'failed']);
  const told = r.h.get("SELECT target, payload FROM outbox WHERE kind = 'text'");
  assert.equal(told.target, '100');
  assert.match(told.payload, /555/);
});

test('outbox: temporary failures back off, then succeed; attempts are bounded', async (t) => {
  const api = await fakeTelegram(t);
  const r = rig(t, api);
  let down = true;
  const gaveUp = [];
  r.outbox.register('telegram', async () => { if (down) throw new Error('network'); });
  r.outbox.register('sms', async () => { throw Object.assign(new Error('blocked'), { permanent: true }); }, { onGiveUp: (row) => { gaveUp.push(row.target); } });
  r.outbox.enqueue({ channel: 'sms', target: '+998', kind: 'text' });
  const id = r.outbox.enqueue({ channel: 'telegram', target: '5', kind: 'text', payload: { text: 'x' } });
  await r.outbox.drain();
  let row = r.h.get('SELECT * FROM outbox WHERE id = ?', id);
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 1);
  assert.ok(row.next_attempt > Date.now() + 25e3, 'waits about 30 s');
  await r.outbox.drain();
  assert.equal(r.h.get('SELECT attempts a FROM outbox WHERE id = ?', id).a, 1, 'not retried before its time');
  down = false;
  await r.outbox.drain(row.next_attempt + 1);
  row = r.h.get('SELECT * FROM outbox WHERE id = ?', id);
  assert.equal(row.status, 'sent');
  assert.deepEqual(gaveUp, ['+998'], 'a second channel works alongside, with its own handler');
  assert.equal(r.outbox.backoffMs(100), 600e3, 'capped at 10 min');
  assert.ok(MAX_ATTEMPTS > 10);
  // dedupe: the same thing isn't queued twice
  assert.ok(r.outbox.enqueue({ channel: 'telegram', target: '6', kind: 'text', payload: {}, dedupe: 'a' }));
  assert.equal(r.outbox.enqueue({ channel: 'telegram', target: '6', kind: 'text', payload: {}, dedupe: 'a' }), null);
});

test('a group that became a supergroup is followed, and the alert resent there', async (t) => {
  const api = await fakeTelegram(t);
  const r = rig(t, api);
  r.telegram.recipients.add('-1001', 'group', 'TBB');
  api.state.script = (m, f) => (m === 'sendMediaGroup' && f.chat_id === '-1001' ? { ok: false, error_code: 400, description: 'upgraded', parameters: { migrate_to_chat_id: -100999 } } : null);
  await r.capture(4, Date.now() - 200e3, '85450KBA');
  await r.settle();
  await r.outbox.drain();
  await r.outbox.drain();
  assert.deepEqual(r.telegram.recipients.all(), ['-100999']);
  assert.equal(r.outbox.counts('telegram').sent, 1);
  assert.equal(api.sent('sendMediaGroup').at(-1).fields.chat_id, '-100999');
});

test('vehicles outside GPS: marked, or left out with TELEGRAM_ALL_VEHICLES=0', async (t) => {
  const api = await fakeTelegram(t);
  const on = rig(t, api, { chatIds: ['5'] });
  await on.capture(4, Date.now() - 200e3, '01A123BC');
  await on.settle();
  await on.outbox.drain();
  assert.match(JSON.parse(api.sent('sendMediaGroup')[0].fields.media)[0].caption, /GPS ro'yxatida yo'q/);
  const off = rig(t, api, { chatIds: ['5'], allVehicles: false });
  await off.capture(4, Date.now() - 200e3, '01A123BC');
  await off.settle();
  assert.equal(off.h.get('SELECT COUNT(*) n FROM outbox').n, 0);
});

test('an event older than the catch-up limit is not alerted', async (t) => {
  const api = await fakeTelegram(t);
  const r = rig(t, api, { chatIds: ['5'] });
  const ev = await r.capture(4, Date.now() - 7 * 3600e3, '01A123BC');
  await r.settle();
  assert.equal(r.h.get('SELECT alert_state s FROM gate_events WHERE id = ?', ev.id).s, 'skipped');
});

test('a caption reads like the old bot\'s', () => {
  const t0 = Date.parse('2026-10-12T13:10:09+05:00');
  const ev = { t: t0, direction: 'out', plate: '10870HDA', plateRaw: '10870HDA', plateValid: true, vehicleId: 3, vehicleLabel: '10 870 HDA', gpsName: '№33', staySeconds: 960, gap: false, identifiedBy: 'alias' };
  const g = { state: "✅ GPS: 13:10:04 da hovlidan yo'lga chiqdi", todayKm: 9.4, odometer: 19079 };
  assert.equal(gateCaption(ev, g), ['🔴 <b>CHIQDI</b>', "🔢 <b>10 870 HDA</b>  <i>(GPS'da: №33)</i>", '🕒 12.10.2026 13:10:09', '⏱ Ichkarida: 16 daqiqa',
    "✅ GPS: 13:10:04 da hovlidan yo'lga chiqdi", '📊 Bugun: 9.4 km', '🧭 Probeg: 19 079 km'].join('\n'));
  const entry = { t: t0, direction: 'in', plate: '85159YAA', plateRaw: '85159YAA', plateValid: true, vehicleId: 1, vehicleLabel: '85 159 YAA', gpsName: '85 159 YAA', staySeconds: null, gap: false };
  const trip = { state: '📡 GPS: harakatda', tripStart: t0 - 8100e3, tripKm: 18.94, tripFuel: 11.6, fuelEvents: [{ kind: 'refuel', litres: 102, t: t0 - 3600e3 }, { kind: 'drain', litres: 30, t: t0 - 1800e3 }], fuelLevel: 79, todayKm: 57.8, todayFuel: 35.1, odometer: 103433 };
  const text = gateCaption(entry, trip, { delayMs: 3600e3 });
  assert.match(text, /🛣 Reys: 18\.9 km, 2 soat 15 daqiqa, 11\.6 L sarflandi \(10:55 da chiqqan\)/);
  assert.match(text, /⛽ Quyildi: \+102 L \(12:10\)/);
  assert.match(text, /🚨 To'kildi: −30 L \(12:40\)/);
  assert.match(text, /⛽ Bakda: 79 L/);
  assert.match(text, /⏳ <i>Kechikkan xabar: 1 soat 0 daqiqa oldin<\/i>/);
  assert.equal(duration(59), '0 daqiqa');
  const unread = gateCaption({ t: t0, direction: 'out', plate: null, plateValid: false, vehicleId: 3, vehicleLabel: '№33', identifiedBy: 'gps', gap: true }, { state: 'x', yardSince: t0 - 600e3 });
  assert.match(unread, /🚛 <b>№33<\/b>  <i>\(raqam o'qilmadi, GPS bo'yicha aniqlandi\)<\/i>/);
  assert.match(unread, /⏱ Hududda: 10 daqiqa \(13:00 dan, GPS\)/);
  assert.ok(!/Kirishi qayd/.test(unread), 'GPS knows when it arrived');
  assert.match(gateCaption({ t: t0, direction: 'in', plate: null, plateValid: false, vehicleId: null, gap: false }, null), /🚛 Raqamsiz mashina\n🚫 <b>GPS bo'yicha aniqlanmadi<\/b>/);
  assert.match(gateCaption({ t: t0, direction: 'in', plate: 'A<B', plateRaw: 'A<B', plateValid: false, vehicleId: null, gap: false }, null), /A&lt;B/, 'HTML is escaped');
});

test('commands: who may do what', async (t) => {
  const api = await fakeTelegram(t);
  const r = rig(t, api);
  r.telegram.recipients.add('-500', 'group', 'TBB');
  const bot = r.telegram.bot;
  bot.me = { username: 'test_bot' };
  const reply = (chat) => api.sent('sendMessage').filter((c) => c.fields.chat_id === String(chat)).at(-1)?.fields.text;
  const say = (text, user, chat, type = 'private') => bot.handle({ text, from: { id: user }, chat: { id: chat, type, title: 'G' } });

  await say('/start', 7, 7);
  assert.match(reply(7), /Telegram ID raqamingiz: <code>7<\/code>/);
  await say('/bugun', 7, 7);
  assert.match(reply(7), /faqat administrator/);
  await say('/holat', 100, 100);
  assert.match(reply(100), /Tizim holati/);
  await say('/yordam', 100, 100);
  assert.match(reply(100), /mashina nazorati/);
  await say('/nimadir', 100, 100);
  assert.match(reply(100), /Bunday buyruq yo'q/);

  // In a connected group anyone may ask the group commands, nothing else.
  const before = api.calls.length;
  await say('/oluvchilar', 7, -500, 'supergroup');
  assert.equal(api.calls.length, before, 'silently ignored');
  await say('/hovli', 7, -500, 'supergroup');
  assert.match(reply(-500), /Hovlida/);
  // A group that isn't connected gets nothing.
  const quiet = api.calls.length;
  await say('/hovli', 7, -600, 'supergroup');
  assert.equal(api.calls.length, quiet);
  // Commands for another bot are left alone.
  await say('/holat@other_bot', 100, 100);
  assert.equal(api.calls.length, quiet);
  await say('/holat@TEST_bot', 100, 100);
  assert.ok(api.calls.length > quiet);
});

test('commands: connecting a group and adding a user', async (t) => {
  const api = await fakeTelegram(t);
  const r = rig(t, api, { chatIds: ['999'] });
  const bot = r.telegram.bot, rec = r.telegram.recipients;
  const reply = (chat) => api.sent('sendMessage').filter((c) => c.fields.chat_id === String(chat)).at(-1)?.fields.text;
  await bot.handle({ text: '/ulash', from: { id: 100 }, chat: { id: -700, type: 'supergroup', title: 'Hisobchi' } });
  assert.ok(rec.groups().includes('-700'));
  assert.match(reply(-700), /guruhi ulandi/);
  assert.ok(api.sent('setMyCommands').some((c) => /-700/.test(c.fields.scope)), 'group menu set');
  await bot.handle({ text: '/ulash', from: { id: 100 }, chat: { id: 100, type: 'private' } });
  assert.match(reply(100), /guruhga qo'shing/);
  await bot.handle({ text: '/qoshish 123', from: { id: 100 }, chat: { id: 100, type: 'private' } });
  assert.ok(rec.all().includes('123'));
  assert.match(reply(100), /Ali/);
  await bot.handle({ text: '/qoshish abc', from: { id: 100 }, chat: { id: 100, type: 'private' } });
  assert.match(reply(100), /Foydalanish/);
  await bot.handle({ text: '/oluvchilar', from: { id: 100 }, chat: { id: 100, type: 'private' } });
  assert.match(reply(100), /3 ta/);
  assert.match(reply(100), /\(\.env\)/);
  await bot.handle({ text: '/uzish 999', from: { id: 100 }, chat: { id: 100, type: 'private' } });
  assert.match(reply(100), /TELEGRAM_CHAT_IDS/);
  await bot.handle({ text: '/uzish 123', from: { id: 100 }, chat: { id: 100, type: 'private' } });
  assert.ok(!rec.all().includes('123'));
  await bot.handle({ text: '/uzish', from: { id: 100 }, chat: { id: -700, type: 'supergroup', title: 'Hisobchi' } });
  assert.ok(!rec.groups().includes('-700'));
  // Added and removed by Telegram itself:
  await bot.membership({ chat: { id: -800, type: 'group', title: 'Yangi' }, new_chat_member: { status: 'member' } });
  assert.match(reply(100), /Yangi.*guruhiga qo'shildi/s);
  rec.add('-800', 'group', 'Yangi');
  await bot.membership({ chat: { id: -800, type: 'group', title: 'Yangi' }, new_chat_member: { status: 'kicked' } });
  assert.ok(!rec.groups().includes('-800'));
});

test('a failing command answers politely and takes nothing down', async (t) => {
  const api = await fakeTelegram(t);
  const r = rig(t, api);
  r.telegram.bot.command({ name: 'bad', run: () => { throw new TypeError('boom'); } });
  await r.telegram.bot.handle({ text: '/bad', from: { id: 100 }, chat: { id: 100, type: 'private' } });
  assert.match(api.sent('sendMessage').at(-1).fields.text, /Xatolik yuz berdi \(TypeError\)/);
});

test('scheduled report: once a day, not before its time, never twice over a restart', async (t) => {
  const api = await fakeTelegram(t);
  const r = rig(t, api);
  r.telegram.recipients.add('-500', 'group', 'TBB');
  const at = (hms) => Date.parse(`2026-11-05T${hms}+05:00`);
  await r.telegram.schedule(at('21:59:00'));
  assert.equal(r.h.get('SELECT COUNT(*) n FROM outbox').n, 0);
  await r.telegram.schedule(at('22:00:00'));
  assert.deepEqual(r.h.all('SELECT target FROM outbox ORDER BY id').map((x) => x.target), ['100', '-500']);
  await r.telegram.schedule(at('22:30:00'));
  assert.equal(r.h.get('SELECT COUNT(*) n FROM outbox').n, 2, 'the mark holds');
  assert.equal(r.h.kvGet('tg_daily_report'), '2026-11-05');
  await r.telegram.schedule(Date.parse('2026-11-30T22:00:00+05:00'));
  assert.equal(r.h.kvGet('tg_monthly_report'), '2026-11', 'the last day of the month');
  assert.equal(r.h.get("SELECT COUNT(*) n FROM outbox WHERE dedupe = 'monthly:2026-11'").n, 2);
});

test('system alerts: admins always; groups for what touches them', async (t) => {
  const api = await fakeTelegram(t);
  const r = rig(t, api);
  r.telegram.recipients.add('-500', 'group', 'TBB');
  r.telegram.onAlert({ id: 1, type: 'system', severity: 'critical', title: "Zavodda internet yo'q", body: 'Tekshiring', data: { part: 'site' } });
  r.telegram.onAlert({ id: 2, type: 'system', severity: 'warning', title: 'Serverda joy tugayapti', data: { part: 'server' } });
  r.telegram.onAlert({ id: 3, type: 'speeding', severity: 'warning', title: 'Tezlik' });
  assert.deepEqual(r.h.all('SELECT ref, target FROM outbox ORDER BY id').map((x) => `${x.ref}:${x.target}`), ['1:100', '1:-500', '2:100']);
});

test('another program polling with the token shows up as a health problem', async (t) => {
  const api = await fakeTelegram(t);
  const r = rig(t, api);
  assert.deepEqual(r.telegram.problems(Date.now()), []);
  r.telegram.bot.conflict = Date.now();
  assert.equal(r.telegram.problems(Date.now())[0].key, 'telegram_conflict');
  r.telegram.bot.conflict = 0;
  r.outbox.enqueue({ channel: 'telegram', target: '5', kind: 'text', payload: { text: 'x' }, now: Date.now() - 11 * 60e3 });
  assert.equal(r.telegram.problems(Date.now())[0].key, 'telegram_stuck');
});

test('GPS details: trip, fuel and today, from yard visits and GoGPS', async (t) => {
  const api = await fakeTelegram(t);
  const gps = {
    mileage: async (ids, from) => [{ vehicleId: 1, periods: [{ mileage: from === T.dayStart(T.today()) ? 57.8 : 18.9, mileageEnd: 103433 }] }],
    fuel: async () => [{ vehicleId: 1, periods: [{ fuelConsumption: 11.6, fuelLevelStart: 100, fuelLevelEnd: 79 }] }],
    fuelInOut: async () => [{ vehicleId: 1, fuels: [{ event: 'FuelIn', startDate: T.localIso(Date.now() - 3600e3), valueFuel: 102 }] }],
  };
  const r = rig(t, api, { chatIds: ['5'], gps });
  const t0 = Date.now() - 200e3;
  r.h.run('INSERT INTO yard_visits (vehicle_id, enter_t, exit_t) VALUES (1, ?, ?)', t0 - 5 * 3600e3, t0 - 2 * 3600e3);
  await r.capture(4, t0, '85450KBA');
  await r.settle();
  await r.outbox.drain();
  const cap = JSON.parse(api.sent('sendMediaGroup')[0].fields.media)[0].caption;
  assert.match(cap, /🛣 Reys: 18\.9 km, 2 soat 0 daqiqa, 11\.6 L sarflandi/);
  assert.match(cap, /⛽ Quyildi: \+102 L/);
  assert.match(cap, /⛽ Bakda: 79 L/);
  assert.match(cap, /📊 Bugun: 57\.8 km, 11\.6 L/);
  assert.match(cap, /🧭 Probeg: 103 433 km/);
});

test('GPS state line: no samples because we were off is not "no signal"; a silent tracker is', async (t) => {
  const api = await fakeTelegram(t);
  const gps = { mileage: async () => [], fuel: async () => [], fuelInOut: async () => [] };
  const r = rig(t, api, { chatIds: ['5'], gps });
  const t0 = Date.now() - 20 * 60e3;
  const ev = { t: t0, direction: 'in', vehicleId: 1 };
  r.h.run("INSERT INTO positions (vehicle_id, t, lat, lng, speed, status) VALUES (1, ?, 41.3, 69.3, 0, 'stopped')", t0 - 3600e3);
  r.poller.live.set(1, { recordTime: Date.now() - 30e3, address: 'x' }); // the tracker is reporting now: the hole is ours
  assert.equal(r.telegram.details.stateLine(ev), null);
  r.poller.live.set(1, { recordTime: t0 - 3600e3, address: 'x' });       // silent all along
  assert.match(r.telegram.details.stateLine(ev), /signal yo'q/);
  // In the yard: since when.
  r.h.run("INSERT INTO positions (vehicle_id, t, lat, lng, speed, status) VALUES (1, ?, 41.2655, 69.3418, 0, 'stopped')", t0 - 60e3);
  r.h.run('INSERT INTO yard_visits (vehicle_id, enter_t) VALUES (1, ?)', t0 - 3600e3);
  assert.match(r.telegram.details.stateLine(ev), /📡 GPS: hovli hududida \(/);
  assert.match(r.telegram.details.stateLine({ ...ev, direction: 'out' }), /📡 GPS: hovli hududida \(/, 'no warning: trucks stand there after the camera');
});

test('an exit: a truck that has moved goes out at once; one that hasn\'t waits for the veto', async (t) => {
  const api = await fakeTelegram(t);
  const r = rig(t, api, { chatIds: ['5'] });
  const now = Date.now();
  const t0 = now - 150e3; // past the first look, before the 5 minutes are over
  r.poller.live.set(1, { id: 1, status: 'stopped', inYard: true, recordTime: now - 5e3 });
  r.poller.live.set(2, { id: 2, status: 'stopped', inYard: true, recordTime: now - 5e3 });
  const moved = await r.capture(3, t0, '85450KBA');
  const still = await r.capture(3, t0 + 1000, '10964DDA');
  const ins = r.h.db.prepare("INSERT INTO positions (vehicle_id, t, lat, lng, speed, status) VALUES (1, ?, ?, 69.3418, 5, 'moving')");
  ins.run(t0 - 30e3, 41.2655);
  ins.run(t0 + 30e3, 41.2661); // about 66 m
  await r.settle();
  assert.equal(r.gate.get(moved.id).status, 'pending', 'its confirmation is still open');
  assert.equal(r.h.get('SELECT alert_state s FROM gate_events WHERE id = ?', moved.id).s, 'done');
  assert.equal(r.h.get('SELECT alert_state s FROM gate_events WHERE id = ?', still.id).s, 'pending');
  assert.equal(r.outbox.counts('telegram').pending, 1);
});

test('GPS down: the alert still goes, and says so', async (t) => {
  const api = await fakeTelegram(t);
  const gps = { mileage: async () => { throw new Error('timeout'); }, fuel: async () => [], fuelInOut: async () => [] };
  const r = rig(t, api, { chatIds: ['5'], gps });
  await r.capture(4, Date.now() - 200e3, '85450KBA');
  await r.settle();
  await r.outbox.drain();
  assert.match(JSON.parse(api.sent('sendMediaGroup')[0].fields.media)[0].caption, /GPS ma'lumotlarini olib bo'lmadi/);
});

test('work survives a restart: a pending top view and a queued alert are picked up from the database', async (t) => {
  const api = await fakeTelegram(t);
  const r = rig(t, api, { chatIds: ['5'] });
  const ev = await r.capture(4, Date.now() - 200e3, '85450KBA');
  // "Restart": nothing in memory, only the row.
  r.gate.topRunning.clear();
  r.gate.topNext.clear();
  assert.equal(r.h.get('SELECT top_view v, alert_state a FROM gate_events WHERE id = ?', ev.id).v, 'pending');
  await r.settle();
  assert.equal(r.outbox.counts('telegram').pending, 1);
  await r.outbox.drain();
  assert.equal(r.outbox.counts('telegram').sent, 1);
});

test('mini app: the menu button, /app in private chats and groups, a link in every alert', async (t) => {
  const api = await fakeTelegram(t);
  const r = rig(t, api, { chatIds: ['-500'], miniApp: true });
  r.telegram.recipients.add('-500', 'group', 'TBB');
  const bot = r.telegram.bot;
  bot.me = { username: 'test_bot' };
  const last = (chat) => api.sent('sendMessage').filter((c) => c.fields.chat_id === String(chat)).at(-1)?.fields;
  const say = (text, user, chat, type = 'private') => bot.handle({ text, from: { id: user }, chat: { id: chat, type, title: 'G' } });

  // The button next to the message box, set once.
  await bot.menuButton();
  await bot.menuButton();
  const buttons = api.sent('setChatMenuButton');
  assert.equal(buttons.length, 1, 'not set again on every start');
  assert.deepEqual(JSON.parse(buttons[0].fields.menu_button), { type: 'web_app', text: 'Ochish', web_app: { url: 'https://tbb.example/tg/' } });

  // /app: anyone in a private chat gets the in-chat button; a connected group gets a t.me link; others nothing.
  await say('/app', 7, 7);
  assert.deepEqual(JSON.parse(last(7).reply_markup).inline_keyboard[0][0].web_app, { url: 'https://tbb.example/tg/' });
  await say('/app', 7, -500, 'supergroup');
  assert.equal(JSON.parse(last(-500).reply_markup).inline_keyboard[0][0].url, 'https://t.me/test_bot?startapp');
  const quiet = api.calls.length;
  await say('/app', 7, -600, 'supergroup');
  assert.equal(api.calls.length, quiet);
  await say('/yordam', 100, 100);
  assert.match(last(100).text, /\/app — ilovani ochish/);
  assert.ok(bot.menu(['public']).some(([c]) => c === 'app'), 'in the menu of every private chat');

  // A gate alert ends with a link to that pass in the app.
  const ev = await r.capture(4, Date.now() - 20e3, '85450KBA');
  await r.settle();
  await r.settle(ev.t + 110e3);
  await r.outbox.drain();
  const caption = JSON.parse(api.sent('sendMediaGroup')[0].fields.media)[0].caption;
  assert.ok(caption.endsWith(`📱 <a href="https://t.me/test_bot?startapp=e${ev.id}">Ilovada ochish</a>`), caption);

  // An outage message links to the alerts.
  r.telegram.onAlert({ id: 9, type: 'system', severity: 'critical', title: "Zavodda internet yo'q", data: { part: 'site' } });
  assert.match(JSON.parse(r.h.get('SELECT payload FROM outbox WHERE ref = 9').payload).text, /startapp=a">Ilovada ochish/);
});

test('mini app off: no /app, no links; a menu button set earlier is put back to Telegram\'s own', async (t) => {
  const api = await fakeTelegram(t);
  const r = rig(t, api, { chatIds: ['555'] });
  const bot = r.telegram.bot;
  bot.me = { username: 'test_bot' };
  r.h.kvSet('tg_menu_button', 'https://tbb.example/tg/');
  await bot.menuButton();
  assert.deepEqual(JSON.parse(api.sent('setChatMenuButton')[0].fields.menu_button), { type: 'default' });
  assert.equal(r.h.kvGet('tg_menu_button'), null);
  await bot.menuButton();
  assert.equal(api.sent('setChatMenuButton').length, 1);

  await bot.handle({ text: '/app', from: { id: 100 }, chat: { id: 100, type: 'private' } });
  assert.match(api.sent('sendMessage').at(-1).fields.text, /Bunday buyruq yo'q/);
  assert.equal(r.telegram.appLink('e1'), null);
  const ev = await r.capture(4, Date.now() - 20e3, '85450KBA');
  await r.settle();
  await r.settle(ev.t + 110e3);
  await r.outbox.drain();
  assert.doesNotMatch(JSON.parse(api.sent('sendMediaGroup')[0].fields.media)[0].caption, /t\.me|Ilovada/);
});
