'use strict';
// The real server.js as a process, the simulated NVR and GPS, and a fake api.telegram.org: camera capture to delivered
// album, commands, Telegram outages, restarts, and taking over from the old bot's state.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { test, uiTest, expect } = require('../support/fixtures');
const { TestServer, FakeTelegram, sleep, baseEnv, sandboxApp, ACCOUNTS } = require('../support/server');
const { Api } = require('../support/api');
const { gateEvent, FLEET } = require('../support/seed');

// Plates in these tests are ones no simulated vehicle has: the simulator keeps running, and its trucks pass the gate meanwhile.
const ADMIN = 100, GROUP = -1001234567890, USER = 7654321;

async function boot(tg, { name = 'tg', env = {}, seed = true } = {}) {
  const s = new TestServer({ name, env: { TELEGRAM_BOT_TOKEN: 'TEST:TOKEN', TELEGRAM_API_BASE: tg.url, ADMIN_IDS: String(ADMIN), TELEGRAM_CHAT_IDS: `${GROUP},${USER}`, GPS_SETTLE_SECONDS: '0', HEALTH_CHECK_SECONDS: '5', ...env } });
  if (seed) s.seedFrom(process.env.E2E_TEMPLATE_DIR);
  await s.start();
  return s;
}

/** A capture that has just happened: a row as the gate writes it, waiting for its top view and its alert. */
function liveEvent(s, o = {}) {
  const id = gateEvent(s, { t: Date.now() - 30e3, direction: 'in', plate: '85901ZZA', vehicleId: FLEET.fuel, status: 'pending', by: 'plate', ...o });
  s.run("UPDATE gate_events SET top_view = 'pending', alert_state = 'pending', resolve_at = ? WHERE id = ?", Date.now(), id);
  return id;
}

let tg;
test.beforeEach(async () => { tg = await new FakeTelegram().start(); });
test.afterEach(async () => { await tg.stop(); });

test('capture to Telegram: both photos, the same caption for every recipient, uploaded only once', async () => {
  const s = await boot(tg);
  try {
    const id = liveEvent(s);
    await expect.poll(() => tg.alerts().filter((a) => /85 901 ZZA/.test(a.caption)).length, { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
    const mine = tg.alerts().filter((a) => /85 901 ZZA/.test(a.caption)).slice(0, 2);
    expect(new Set(mine.map((a) => a.chat))).toEqual(new Set([String(GROUP), String(USER)]));
    expect(mine.map((a) => a.photos)).toEqual([2, 2]);
    expect(mine[0].uploaded).toBe(2);
    expect(mine[1].uploaded).toBe(0);
    expect(mine[0].caption).toBe(mine[1].caption);
    expect(mine[0].caption).toContain('🟢 <b>KIRDI</b>');

    // The web page gets the same top view, as a new address so a browser can't keep showing the old snapshot.
    const a = new Api(s.url);
    await a.login(ACCOUNTS.owner.username, ACCOUNTS.owner.password);
    const ev = (await a.get(`/api/gate-events/${id}`)).data;
    expect(ev.topView).toBe('done');
    expect(ev.photos.at(-1).url).toContain('?v=top');
    const img = await fetch(`${s.url}${ev.photos.at(-1).url}`, { headers: { Cookie: `tbb_session=${a.token}` } });
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/jpeg');
    expect(s.alive).toBe(true);
  } finally { await s.destroy(); }
});

test('a vehicle outside GPS: marked; once delivered it stays delivered', async () => {
  const s = await boot(tg);
  try {
    const id = liveEvent(s, { plate: '01Z901ZA', vehicleId: null, status: 'outside', by: null });
    await expect.poll(() => tg.alerts().filter((a) => /01 Z 901 ZA/.test(a.caption)).length, { timeout: 60_000 }).toBe(2);
    expect(tg.alerts().find((a) => /01 Z 901 ZA/.test(a.caption)).caption).toContain("GPS ro'yxatida yo'q");
    // Delivered is final: another few rounds change nothing.
    await sleep(8000);
    expect(tg.alerts().filter((a) => /01 Z 901 ZA/.test(a.caption)).length).toBe(2);
    expect(s.get('SELECT alert_state a FROM gate_events WHERE id = ?', id).a).toBe('done');
  } finally { await s.destroy(); }
});

test('a Telegram outage loses nothing: queued, then delivered in order, once', async () => {
  const s = await boot(tg);
  try {
    tg.down = true;
    const id = liveEvent(s, { plate: '85902ZZA', vehicleId: FLEET.fuel2 });
    await expect.poll(() => s.get("SELECT COUNT(*) n FROM outbox WHERE status = 'pending' AND ref = ?", id).n, { timeout: 60_000 }).toBe(2);
    await expect.poll(() => s.get('SELECT MAX(attempts) a FROM outbox WHERE ref = ?', id).a, { timeout: 60_000 }).toBeGreaterThanOrEqual(1);
    tg.down = false;
    // Back-off is 30 s after the first failure.
    await expect.poll(() => tg.alerts().filter((a) => /85 902 ZZA/.test(a.caption)).length, { timeout: 90_000 }).toBe(2);
    await sleep(3000);
    expect(tg.alerts().filter((a) => /85 902 ZZA/.test(a.caption)).length).toBe(2);
    expect(s.get("SELECT COUNT(*) n FROM outbox WHERE status = 'pending' AND ref = ?", id).n).toBe(0);
  } finally { await s.destroy(); }
});

test('a restart in the middle: a waiting top view and a queued alert carry on, nothing goes twice', async () => {
  const s = await boot(tg);
  try {
    const done = liveEvent(s, { plate: '10Z902ZA', vehicleId: null, status: 'outside', by: null });
    await expect.poll(() => tg.alerts().filter((a) => /10 Z 902 ZA/.test(a.caption)).length, { timeout: 60_000 }).toBe(2);

    s.setFail('top_view_late'); // the recording isn't playable yet: the next event waits
    const waiting = liveEvent(s, { plate: '30Z903ZA', vehicleId: null, status: 'outside', by: null });
    await expect.poll(() => s.get('SELECT top_view v FROM gate_events WHERE id = ?', waiting).v, { timeout: 20_000 }).toBe('pending');
    await sleep(6000);
    expect(tg.alerts().filter((a) => /30 Z 903 ZA/.test(a.caption)).length).toBe(0);

    await s.stop();
    s.clearFail();
    await s.start();
    await expect.poll(() => tg.alerts().filter((a) => /30 Z 903 ZA/.test(a.caption)).length, { timeout: 60_000 }).toBe(2);
    expect(tg.alerts().filter((a) => /10 Z 902 ZA/.test(a.caption)).length).toBe(2);
    expect(s.get('SELECT top_view v FROM gate_events WHERE id = ?', done).v).toBe('done');
  } finally { await s.destroy(); }
});

test('no top view to be had: the alert goes with what there is; broken ffmpeg neither stops alerts nor the server', async () => {
  const s = await boot(tg);
  try {
    s.setFail('top_view_empty');
    const a = liveEvent(s, { plate: '40Z904ZA', vehicleId: null, status: 'outside', by: null });
    await expect.poll(() => tg.alerts().filter((x) => /40 Z 904 ZA/.test(x.caption)).length, { timeout: 60_000 }).toBe(2);
    expect(s.get('SELECT top_view v FROM gate_events WHERE id = ?', a).v).toBe('none');
    s.setFail('top_view_broken');
    const b = liveEvent(s, { plate: '20Z905ZA', vehicleId: null, status: 'outside', by: null });
    await expect.poll(() => s.get('SELECT top_view v FROM gate_events WHERE id = ?', b).v, { timeout: 90_000 }).toBe('failed');
    await expect.poll(() => tg.alerts().filter((x) => /20 Z 905 ZA/.test(x.caption)).length, { timeout: 30_000 }).toBe(2);
    expect(s.alive).toBe(true);
  } finally { s.clearFail(); await s.destroy(); }
});

test('commands over Telegram: reports, the yard, recipients; strangers get only their id', async () => {
  const s = await boot(tg);
  try {
    const reply = (chat, re) => tg.sent('sendMessage').filter((c) => c.fields.chat_id === String(chat) && re.test(c.fields.text));
    await expect.poll(() => tg.sent('getMe').length, { timeout: 20_000 }).toBeGreaterThan(0);
    await expect.poll(() => tg.sent('setMyCommands').length, { timeout: 20_000 }).toBeGreaterThan(1);

    tg.say('/bugun');
    await expect.poll(() => reply(ADMIN, /Kunlik hisobot/).length, { timeout: 60_000 }).toBe(1);
    expect(reply(ADMIN, /Tayyorlanmoqda/).length).toBe(1);
    expect(reply(ADMIN, /Kunlik hisobot/)[0].fields.text).toMatch(/Jami:/);
    tg.say('/oy');
    await expect.poll(() => reply(ADMIN, /Oylik hisobot/).length, { timeout: 60_000 }).toBe(1);
    tg.say('/hovli');
    await expect.poll(() => reply(ADMIN, /Hovlida — \d+ ta/).length, { timeout: 20_000 }).toBe(1);
    tg.say('/tekshir');
    await expect.poll(() => reply(ADMIN, /Kamera va GPS tekshiruvi/).length, { timeout: 30_000 }).toBe(1);
    tg.say('/holat');
    await expect.poll(() => reply(ADMIN, /Tizim holati/).length, { timeout: 20_000 }).toBe(1);

    tg.say('/start', { user: 7, chat: 7 });
    await expect.poll(() => reply(7, /<code>7<\/code>/).length, { timeout: 20_000 }).toBe(1);
    tg.say('/bugun', { user: 7, chat: 7 });
    await expect.poll(() => reply(7, /faqat administrator/).length, { timeout: 20_000 }).toBe(1);

    tg.say('/ulash', { chat: -500, type: 'supergroup', title: 'Hisobchi' });
    await expect.poll(() => reply(-500, /guruhi ulandi/).length, { timeout: 20_000 }).toBe(1);
    expect(s.get('SELECT title FROM tg_recipients WHERE chat_id = ?', '-500').title).toBe('Hisobchi');
    tg.say('/kecha', { user: 7, chat: -500, type: 'supergroup' });
    await expect.poll(() => reply(-500, /Kunlik hisobot/).length, { timeout: 30_000 }).toBe(1);
    // The offset is kept: a restart doesn't answer anything again.
    await expect.poll(() => s.kv('tg_offset'), { timeout: 10_000 }).toBeGreaterThanOrEqual(1000);
    const before = tg.sent('sendMessage').length;
    await s.restart();
    await sleep(3000);
    expect(tg.sent('sendMessage').length).toBe(before);
  } finally { await s.destroy(); }
});

test('an outage reaches admins and groups, and its end says for how long', async () => {
  const s = await boot(tg, { env: { HEALTH_CHECK_SECONDS: '5' } });
  try {
    tg.say('/ulash', { chat: GROUP, type: 'supergroup', title: 'TBB' });
    s.setFail('site');
    await expect.poll(() => tg.sent('sendMessage').filter((c) => /Zavod|kameralarga ulanib/.test(c.fields.text)).map((c) => c.fields.chat_id).sort().join(), { timeout: 60_000 })
      .toContain(String(ADMIN));
    expect(tg.sent('sendMessage').filter((c) => /Zavod|kameralarga ulanib/.test(c.fields.text)).map((c) => c.fields.chat_id)).toContain(String(GROUP));
    s.clearFail();
    await expect.poll(() => tg.sent('sendMessage').filter((c) => /Tiklandi/.test(c.fields.text) && c.fields.chat_id === String(GROUP)).length, { timeout: 60_000 }).toBe(1);
    expect(tg.sent('sendMessage').find((c) => /Tiklandi/.test(c.fields.text)).fields.text).toMatch(/Ishlamagan vaqt/);
  } finally { s.clearFail(); await s.destroy(); }
});

test('another program polling with the token is reported, and nothing crashes', async () => {
  tg.answer = (m) => (m === 'getUpdates' ? { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' } : null);
  const s = await boot(tg);
  try {
    await s.waitForLog(/another program is polling/, 30_000);
    await expect.poll(() => tg.sent('sendMessage').filter((c) => /boshqa dasturda/.test(c.fields.text)).length, { timeout: 60_000 }).toBeGreaterThan(0);
    expect(s.alive).toBe(true);
  } finally { await s.destroy(); }
});

uiTest('on the page: Settings shows Telegram, and the gate dialog shows the top view', async ({ page, context }) => {
  const s = await boot(tg);
  try {
    const id = liveEvent(s, { plate: '85903ZZA', vehicleId: FLEET.fuel, status: 'confirmed' });
    await expect.poll(() => tg.alerts().filter((a) => /85 903 ZZA/.test(a.caption)).length, { timeout: 60_000 }).toBe(2);
    const a = new Api(s.url);
    await a.login(ACCOUNTS.owner.username, ACCOUNTS.owner.password);
    await context.addCookies([{ name: 'tbb_session', value: a.token, url: s.url, httpOnly: true, sameSite: 'Lax' }]);
    await page.goto(`${s.url}/#/darvoza?event=${id}`);
    await page.locator('.photos figure').nth(1).waitFor();
    await expect(page.locator('.photos figcaption').nth(1)).toHaveText("Yo'l-2");
    await expect.poll(() => page.locator('.photos img').nth(1).evaluate((i) => i.complete && i.naturalWidth > 0)).toBe(true);
    await page.goto(`${s.url}/#/sozlamalar`);
    await page.getByRole('tab', { name: /Tizim/ }).or(page.getByRole('button', { name: /Tizim/ })).first().click();
    const card = page.locator('#sysTelegram');
    await expect(card).toContainText('Ishlayapti');
    await expect(card).toContainText('Yuborilgan');
    await expect(card).toContainText('ta olindi');
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'test/e2e/.output/screenshots/settings-telegram.png', fullPage: false });
  } finally { await s.destroy(); }
});

test('without a token: no Telegram, and the rest of the app is the same', async () => {
  const s = new TestServer({ name: 'notg', env: { TELEGRAM_API_BASE: tg.url } }).seedFrom(process.env.E2E_TEMPLATE_DIR);
  await s.start();
  try {
    await s.waitForLog(/TELEGRAM_BOT_TOKEN not set/, 10_000);
    const a = new Api(s.url);
    await a.login(ACCOUNTS.owner.username, ACCOUNTS.owner.password);
    expect((await a.get('/api/system')).data.telegram).toBeNull();
    await sleep(2000);
    expect(tg.calls.length).toBe(0);
  } finally { await s.destroy(); }
});

test('taking over from the old bot: the import, then the same recipients, no second report, and what it hadn\'t sent goes out', async () => {
  // First the app runs without Telegram, as production does today.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
  const s = new TestServer({ name: 'takeover', env: { GPS_SETTLE_SECONDS: '0', TELEGRAM_API_BASE: tg.url } }).seedFrom(process.env.E2E_TEMPLATE_DIR);
  await s.start();
  try {
    const now = Date.now();
    const iso = (ms) => new Date(ms + 5 * 3600e3).toISOString().slice(0, 19);
    const sentBefore = gateEvent(s, { t: now - 400e3, direction: 'in', plate: '85902ZZA', vehicleId: FLEET.fuel2, status: 'confirmed' });
    const missed = gateEvent(s, { t: now - 60e3, direction: 'in', plate: '85901ZZA', vehicleId: FLEET.fuel, status: 'confirmed' });
    await s.stop();

    const file = path.join(dir, 'events.db');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE sightings (name TEXT PRIMARY KEY, channel INT, camera TEXT, time TEXT, plate TEXT);
      CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE held (name TEXT PRIMARY KEY, due TEXT, decision TEXT);
      CREATE TABLE recipients (chat_id TEXT PRIMARY KEY, kind TEXT, title TEXT, added TEXT);
      CREATE TABLE outbox (id INTEGER PRIMARY KEY, created TEXT, alert_dir TEXT, chat_id TEXT, status TEXT, attempts INT, next_attempt TEXT, last_error TEXT, sent_at TEXT);
      INSERT INTO recipients VALUES ('${GROUP}', 'group', 'Hisobchilar', '2026-10-12T18:31:28'), ('${USER}', 'user', 'Ali', '2026-10-12T19:23:52');
      INSERT INTO kv VALUES ('telegram_offset', '530483517'), ('daily_report', '${new Date(now + 5 * 3600e3).toISOString().slice(0, 10)}'), ('monthly_report', '2026-10');
      INSERT INTO sightings VALUES ('last', 4, 'ANPR-1', '${iso(now - 200e3)}', 'X');`);
    old.close();
    const env = { ...baseEnv(), DATA_DIR: s.dataDir, MOCK: '1', TZ: 'Asia/Tashkent' };
    const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/import-notifier.js', '--db', file, '--aliases', '10964DDA=85 519 EBA'], { cwd: sandboxApp(), env, encoding: 'utf8' });
    expect(out).toMatch(/recipients 2/);
    // Twice is refused.
    expect(() => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/import-notifier.js', '--db', file], { cwd: sandboxApp(), env, stdio: 'pipe' })).toThrow(/Already imported|Command failed/);

    // REPORT_TIME in the past: the report would be due right away, if the old bot's mark hadn't come along.
    Object.assign(s.extraEnv, { TELEGRAM_BOT_TOKEN: 'TEST:TOKEN', ADMIN_IDS: String(ADMIN), REPORT_TIME: '00:00' });
    await s.start();
    await expect.poll(() => tg.alerts().filter((a) => /85 901 ZZA/.test(a.caption)).map((a) => a.chat).sort().join(), { timeout: 90_000 }).toBe([String(GROUP), String(USER)].sort().join());
    expect(tg.alerts().filter((a) => /85 902 ZZA/.test(a.caption)).length, 'the old bot already sent this one').toBe(0);
    expect(tg.lastOffset).toBe(530483517);
    await sleep(12_000); // the schedule's first round is at 10 s
    expect(tg.sent('sendMessage').filter((c) => /Kunlik hisobot/.test(c.fields.text)).length, 'today\'s report was already sent by the old bot').toBe(0);
    expect(s.get('SELECT alert_state a FROM gate_events WHERE id = ?', sentBefore).a).toBeNull();
    expect(s.get('SELECT alert_state a FROM gate_events WHERE id = ?', missed).a).toBe('done');
  } finally {
    await s.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
