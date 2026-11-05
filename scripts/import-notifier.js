'use strict';
/**
 * One-time move from the old Python bot (tbb_car_notifier) to this app. Run it with both programs stopped:
 *
 *   node --disable-warning=ExperimentalWarning scripts/import-notifier.js --db /path/events.db [--alerts /path/alerts] [--dry-run]
 *
 * What carries over, so the bot simply goes on:
 *   recipients and moved groups   who gets alerts
 *   update offset                 commands already answered aren't answered again
 *   report marks                  today's 22:00 report doesn't go out twice
 *   alerts it hadn't finished     captures after its last one, its held alerts and its unsent queue
 *   vehicle aliases               config.toml plates whose GPS vehicle still exists
 *   photos and decisions          (--alerts) the load photos in the history, and exits it alerted but this app had vetoed
 *
 * What doesn't: the tracker's state (this app tracks the same NVR itself) and its learned aliases, whose evidence is
 * too noisy to trust: it maps 10834HDA to the GPS vehicle named 10 870 HAD.
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const T = require('../src/time');

const TZ = '+05:00'; // the old bot stored naive Tashkent time
const CATCHUP_HOURS = 6;
const MARK = 'notifier_imported';
const toEpoch = (s) => Date.parse(`${s}${TZ}`);

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') out.dryRun = true;
    else if (argv[i] === '--force') out.force = true;
    else if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[++i];
  }
  return out;
}

/** "113350_out_85450KBA" in a dated folder -> {t, direction}. */
function parseAlertFolder(day, name) {
  const m = /^(\d{2})(\d{2})(\d{2})_(in|out)_/.exec(name);
  return m ? { t: toEpoch(`${day}T${m[1]}:${m[2]}:${m[3]}`), direction: m[4] } : null;
}

/**
 * @param {{legacy: DatabaseSync, h: object, photoDir: string, alertsDir?: string, aliases?: Record<string,string>,
 *   now?: number, dryRun?: boolean, cameras?: object[], log?: (s: string) => void}} o
 * @returns {object} what was done, for the report
 */
function importNotifier({ legacy, h, photoDir, alertsDir, aliases = {}, now = Date.now(), dryRun = false, cameras = [], log = () => {} }) {
  const q = (sql, ...a) => legacy.prepare(sql).all(...a);
  const kv = Object.fromEntries(q('SELECT k, v FROM kv').map((r) => [r.k, r.v]));
  const report = { recipients: 0, moved: 0, aliases: [], relinked: 0, catchUp: 0, held: 0, queued: 0, photos: 0, vetoesReversed: 0, days: new Set() };
  const topViewCams = new Set(cameras.filter((c) => c.topView && c.contextChannel).map((c) => c.channel));

  const work = () => {
    // --- who gets what ---
    for (const r of q('SELECT chat_id, kind, title, added FROM recipients')) {
      h.run(`INSERT INTO tg_recipients (chat_id, kind, title, added_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET kind = excluded.kind, title = excluded.title`, r.chat_id, r.kind, r.title, toEpoch(r.added) || now);
      report.recipients++;
    }
    for (const [k, v] of Object.entries(kv)) {
      if (k.startsWith('migrated:')) { h.kvSet(`tg_moved:${k.slice('migrated:'.length)}`, v); report.moved++; }
    }

    // --- where it stopped ---
    if (kv.telegram_offset) h.kvSet('tg_offset', Number(kv.telegram_offset));
    if (kv.daily_report) h.kvSet('tg_daily_report', kv.daily_report);
    if (kv.monthly_report) h.kvSet('tg_monthly_report', kv.monthly_report);

    // --- alerts it hadn't finished ---
    const last = q('SELECT MAX(time) t FROM sightings')[0].t;
    const cutoff = Math.max(last ? toEpoch(last) : 0, now - CATCHUP_HOURS * 3600e3);
    const pendAlert = (row) => {
      h.run("UPDATE gate_events SET alert_state = 'pending', top_view = ? WHERE id = ?",
        topViewCams.has(row.channel) && row.top_view !== 'done' ? 'pending' : row.top_view, row.id);
    };
    for (const row of h.all("SELECT id, channel, top_view FROM gate_events WHERE t > ? AND status NOT IN ('vetoed','history') AND alert_state IS NULL", cutoff)) {
      pendAlert(row);
      report.catchUp++;
    }
    for (const { name } of q('SELECT name FROM held')) {
      const row = h.get('SELECT id, channel, top_view FROM gate_events WHERE capture_name = ?', name);
      if (row) { pendAlert(row); report.held++; }
    }
    for (const r of q("SELECT alert_dir, chat_id FROM outbox WHERE status = 'pending'")) {
      // Inside the bot's container its data was at /app/data; here the alerts folder was given by path.
      const folder = alertsDir ? path.join(alertsDir, ...r.alert_dir.split('/').slice(-2)) : r.alert_dir;
      if (!fs.existsSync(path.join(folder, 'caption.txt')) || !r.chat_id) continue;
      const keep = path.join(path.dirname(photoDir), 'notifier-queue', path.basename(folder));
      if (!dryRun) fs.mkdirSync(keep, { recursive: true });
      const photos = fs.readdirSync(folder).filter((f) => f.endsWith('.jpg')).sort().map((f) => {
        if (!dryRun) fs.copyFileSync(path.join(folder, f), path.join(keep, f));
        return { name: f.replace(/^\d+_/, '').replace(/\.jpg$/, ''), file: path.join(keep, f) };
      });
      const payload = JSON.stringify({ text: fs.readFileSync(path.join(folder, 'caption.txt'), 'utf8'), photos });
      h.run(`INSERT OR IGNORE INTO outbox (channel, target, kind, payload, dedupe, next_attempt, created_at) VALUES ('telegram', ?, 'legacy', ?, ?, ?, ?)`,
        r.chat_id, payload, `legacy:${path.basename(folder)}`, now, now);
      report.queued++;
    }

    // --- plates known under another GPS name ---
    const { plateKey } = require('../src/gps/normalize');
    const vehicles = h.all('SELECT id, name, plate FROM vehicles');
    for (const [plate, gpsName] of Object.entries(aliases)) {
      const v = vehicles.find((x) => plateKey(x.name) === plateKey(gpsName));
      if (!v || v.plate || vehicles.some((x) => x.plate === plate || plateKey(x.name) === plate)) continue;
      h.run('UPDATE vehicles SET plate = ? WHERE id = ?', plate, v.id);
      report.aliases.push(`${plate} = ${v.name}`);
      // Its passes so far were taken for an outside vehicle: they are this truck's, and count as its trips.
      for (const row of h.all('SELECT id, t, status FROM gate_events WHERE plate = ? AND vehicle_id IS NULL', plate)) {
        h.run(`UPDATE gate_events SET vehicle_id = ?, identified_by = 'alias', status = CASE status WHEN 'outside' THEN 'unconfirmed' ELSE status END,
          status_note = CASE status WHEN 'outside' THEN NULL ELSE status_note END WHERE id = ?`, v.id, row.id);
        report.relinked++;
        report.days.add(T.dayOf(row.t));
      }
    }

    // --- its archive: load photos, and what it knew that this app had wrong ---
    if (alertsDir && fs.existsSync(alertsDir)) {
      for (const day of fs.readdirSync(alertsDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))) {
        for (const name of fs.readdirSync(path.join(alertsDir, day))) {
          const a = parseAlertFolder(day, name);
          if (!a) continue;
          const row = h.get('SELECT * FROM gate_events WHERE direction = ? AND t BETWEEN ? AND ? ORDER BY ABS(t - ?) LIMIT 1', a.direction, a.t - 2000, a.t + 2000, a.t);
          if (!row) continue;
          // The bot sent this exit with a truck in the photo; the app's old rule had vetoed it for standing in the circle.
          if (row.status === 'vetoed' && a.direction === 'out' && row.vehicle_id && !/^Qo'lda/.test(row.status_note || '')) {
            h.run("UPDATE gate_events SET status = 'unconfirmed', status_note = ? WHERE id = ?", 'GPS: chiqqan, lekin hovli yonida turibdi', row.id);
            report.vetoesReversed++;
            report.days.add(day);
          }
          const second = fs.readdirSync(path.join(alertsDir, day, name)).find((f) => /^2_.*\.jpg$/.test(f));
          const photos = JSON.parse(row.photos || '[]');
          if (!second || photos.some((p) => p.v === 'top')) continue;
          const file = `${day}/${row.id}_top.jpg`;
          if (!dryRun) {
            fs.mkdirSync(path.join(photoDir, day), { recursive: true });
            fs.copyFileSync(path.join(alertsDir, day, name, second), path.join(photoDir, file));
          }
          const label = second.replace(/^2_/, '').replace(/\.jpg$/, '').replace(/_/g, "'");
          h.run('UPDATE gate_events SET photos = ?, top_view = ? WHERE id = ?', JSON.stringify([...photos.filter((p) => p.name !== label), { name: label, file, v: 'top' }]), 'done', row.id);
          report.photos++;
        }
      }
    }
    h.kvSet(MARK, { at: now, lastSighting: last, cutoff });
  };

  if (dryRun) {
    // Everything is counted on the real data, inside a transaction that is then undone. Files are left alone.
    h.db.exec('BEGIN');
    try { work(); } finally { h.db.exec('ROLLBACK'); }
  } else h.tx(work);
  log(`${dryRun ? '[dry run] ' : ''}recipients ${report.recipients}, moved groups ${report.moved}, offset ${kv.telegram_offset ?? '-'}, daily report ${kv.daily_report ?? '-'}, monthly ${kv.monthly_report ?? '-'}`);
  log(`alerts to send: ${report.catchUp} after its last capture, ${report.held} held, ${report.queued} queued`);
  log(`aliases: ${report.aliases.join(', ') || 'none'} (${report.relinked} past passes linked); photos ${report.photos}; vetoes reversed ${report.vetoesReversed} (days: ${[...report.days].join(', ') || '-'})`);
  return report;
}

if (require.main === module) {
  const o = args(process.argv.slice(2));
  if (!o.db) { console.error('Usage: import-notifier.js --db <events.db> [--alerts <dir>] [--aliases "PLATE=GPS name,..."] [--dry-run] [--force]'); process.exit(2); }
  const config = require('../src/config');
  const { open, helpers } = require('../src/db');
  const legacy = new DatabaseSync(o.db, { readOnly: true });
  const db = open(path.join(config.dataDir, 'dispatcher.db'));
  const h = helpers(db);
  if (h.kvGet(MARK) && !o.force && !o.dryRun) { console.error(`Already imported at ${new Date(h.kvGet(MARK).at).toISOString()}. --force to run again.`); process.exit(1); }
  const aliases = Object.fromEntries(String(o.aliases || '').split(',').filter(Boolean).map((p) => p.split('=').map((x) => x.trim())));
  const r = importNotifier({ legacy, h, photoDir: path.join(config.dataDir, 'photos'), alertsDir: o.alerts, aliases, dryRun: !!o.dryRun, cameras: config.nvr.cameras, log: (s) => console.log(s) });
  if (r.days.size && !o.dryRun) {
    // Trip counts of the days whose vetoes were reversed (no GoGPS requests).
    const { Analytics } = require('../src/analytics');
    const analytics = new Analytics({ h, gps: null, config, log: console });
    (async () => { for (const day of r.days) await analytics.rollup(day, { withGps: false }); console.log(`trip counts recomputed for ${r.days.size} days`); db.close(); })();
  } else db.close();
}

module.exports = { importNotifier, parseAlertFolder, MARK };
