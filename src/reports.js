'use strict';
/**
 * Texts for people outside the app: daily and monthly report, where the fleet is now, camera-vs-GPS check.
 * The numbers are the same daily_stats the Hisobot page shows, so the two always agree, and answering doesn't load
 * GoGPS (a month used to take minutes). HTML for Telegram, labels in Uzbek.
 */
const T = require('./time');
const { hm, hmOn } = T;
const { escape } = require('./telegram/format');
const { vehicleLabel, prettyPlate, haversineM, plateKey } = require('./gps/normalize');

const MONTHS = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul', 'Avgust', 'Sentyabr', 'Oktyabr', 'Noyabr', 'Dekabr'];
const num = (x) => x.toFixed(1).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const COUNTED = "('confirmed','unconfirmed','history')";
const NEAR_YARD_M = 500; // farther than this while standing, at a camera read: GPS has the truck somewhere else

/** Drop the city and country every GPS address ends with. */
function shortAddress(a) {
  for (const tail of [', Ташкент, Узбекистан', ', Узбекистан']) {
    if (a.endsWith(tail) && a !== tail.replace(/^, /, '')) return a.slice(0, -tail.length);
  }
  return a;
}

class Reports {
  constructor({ h, analytics, poller, gate, config, places = null, log = console }) {
    this.h = h;
    this.analytics = analytics;
    this.poller = poller;
    this.gate = gate;
    this.cfg = config;
    this.places = places;
    this.log = log;
  }

  /** Bold real plate, with the GPS name in italics when GPS knows the vehicle by another one. */
  name(v) {
    const label = vehicleLabel(v);
    return v.plate && plateKey(v.plate) !== plateKey(v.name) ? `<b>${escape(label)}</b> <i>(GPS'da: ${escape(v.name)})</i>` : `<b>${escape(label)}</b>`;
  }

  rows(from, to) {
    return this.h.all(`SELECT v.*, SUM(d.km) km, SUM(d.fuel_used) fuel_used, SUM(d.refuel_l) refuel_l, SUM(d.drain_l) drain_l,
      SUM(MAX(d.trips_out, d.trips_in)) trips, SUM(d.trips_in) trips_in
      FROM daily_stats d JOIN vehicles v ON v.id = d.vehicle_id AND v.active = 1
      WHERE d.day BETWEEN ? AND ? GROUP BY v.id ORDER BY km DESC`, from, to)
      .filter((r) => r.km >= 0.5 || r.refuel_l > 0 || r.drain_l > 0 || r.trips > 0 || r.trips_in > 0);
  }

  render(title, rows) {
    const out = [`📊 <b>${title}</b>`, ''];
    for (const r of rows) {
      const parts = [`${num(r.km)} km`];
      if (r.fuel_used != null) parts.push(`${num(r.fuel_used)} L sarf`);
      if (r.refuel_l) parts.push(`${num(r.refuel_l)} L quyildi`);
      if (r.drain_l) parts.push(`⚠️ ${num(r.drain_l)} L to'kildi`);
      if (r.trips) parts.push(`${r.trips} reys`);
      out.push(`🚛 ${this.name(r)} — ${parts.join(', ')}`);
    }
    if (!rows.length) out.push('Harakat qayd etilmagan.');
    const used = rows.filter((r) => r.fuel_used != null);
    const total = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
    out.push('', `📌 <b>Jami:</b> ${rows.length} ta mashina`, `🛣 Yurgan masofa: ${num(total('km'))} km`);
    if (used.length) out.push(`⛽ Yoqilg'i sarfi: ${num(used.reduce((a, r) => a + r.fuel_used, 0))} L (datchigi bor ${used.length} ta mashina)`);
    out.push(`⛽ Quyildi: ${num(total('refuel_l'))} L`);
    if (total('drain_l')) out.push(`⚠️ To'kildi: ${num(total('drain_l'))} L`);
    out.push(`🔁 Reyslar: ${total('trips')}`, '', '<i>km va yoqilg\'i GPS bo\'yicha, reyslar kamera bo\'yicha.</i>');
    return out.join('\n');
  }

  /** Today's numbers may be up to 10 minutes old: refresh them before answering. */
  async fresh(day) {
    const stale = day === T.today() || !this.h.get('SELECT 1 FROM daily_stats WHERE day = ? LIMIT 1', day);
    if (stale && this.analytics) await this.analytics.rollup(day);
  }

  async daily(day, now = Date.now()) {
    await this.fresh(day);
    const today = T.today(now);
    const dmy = `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(0, 4)}`;
    const notes = [];
    if (day === today) notes.push('bugun', `${hm(now)} holatiga`);
    else if (day === T.addDays(today, -1)) notes.push('kecha');
    return this.render(`Kunlik hisobot — ${dmy}${notes.length ? ` (${notes.join(', ')})` : ''}`, this.rows(day, day));
  }

  async monthly(year, month, now = Date.now()) {
    const from = `${year}-${String(month).padStart(2, '0')}-01`;
    const to = T.addDays(month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`, -1);
    const day = T.today(now);
    if (day >= from && day <= to) await this.fresh(day);
    const s = T.localIso(now);
    return this.render(`Oylik hisobot — ${MONTHS[month - 1]} ${year} (${s.slice(8, 10)}.${s.slice(5, 7)} ${s.slice(11, 16)} holatiga)`, this.rows(from, to));
  }

  /** Where every fleet vehicle is now, by GPS. */
  yard(now = Date.now()) {
    const atYard = [], away = [], silent = [];
    for (const v of this.h.all('SELECT * FROM vehicles WHERE active = 1 AND in_gps = 1 ORDER BY name')) {
      const p = this.poller?.live.get(v.id);
      if (!p || p.status === 'offline') { silent.push(vehicleLabel(v)); continue; }
      if (p.inYard) {
        const since = this.poller.openVisit.get(v.id)?.enter_t ?? p.recordTime;
        atYard.push({ since, text: `• ${this.name(v)} — ${now - since > 24 * 3600e3 ? "24 soatdan ko'proq" : `${hmOn(since, now)} dan beri`}` });
      } else if (p.status === 'moving') away.push(`• ${this.name(v)} — yo'lda`);
      else away.push(`• ${this.name(v)} — turibdi: ${escape(this.places?.at(p.lat, p.lng)?.name || shortAddress(p.address || ''))}`);
    }
    const out = [`🅿️ <b>Hovlida — ${atYard.length} ta</b> (GPS, ${hm(now)})`, ...atYard.sort((a, b) => a.since - b.since).map((x) => x.text),
      '', `🛣 <b>Tashqarida — ${away.length} ta</b>`, ...away];
    if (silent.length) out.push('', `📵 <b>Signal yo'q</b> (${this.cfg.gps.offlineMinutes} daqiqadan ortiq): ${escape(silent.join(', '))}`);
    return out.join('\n');
  }

  /**
   * Does each camera plate really belong to the GPS vehicle it is matched to? For every pass: did GPS see the vehicle
   * cross the yard boundary, and was it standing somewhere else at that moment (a misread or a wrong match)?
   */
  audit(days = 3, now = Date.now()) {
    const since = now - days * T.DAY;
    const before = this.cfg.nvr.matchBeforeSec * 1000, after = this.cfg.nvr.exitConfirmMin * 60e3;
    const y = this.cfg.yard;
    const stats = new Map();
    const rows = this.h.all(`SELECT g.*, v.name gps_name, v.plate v_plate, v.display, v.id vid FROM gate_events g JOIN vehicles v ON v.camera_only = 0 AND v.id = g.vehicle_id
      WHERE g.t >= ? AND g.plate IS NOT NULL AND g.status IN ${COUNTED} ORDER BY g.t`, since);
    for (const g of rows) {
      const st = stats.get(g.plate) || { plate: g.plate, gpsName: g.gps_name, alias: plateKey(g.gps_name) !== g.plate, exits: 0, confirmed: 0, offsets: [], entries: 0, mismatches: [] };
      stats.set(g.plate, st);
      if (g.direction === 'out') {
        st.exits++;
        const v = this.h.get('SELECT exit_t FROM yard_visits WHERE vehicle_id = ? AND exit_t BETWEEN ? AND ? ORDER BY ABS(exit_t - ?) LIMIT 1', g.vid, g.t - before, g.t + after, g.t);
        if (v) { st.confirmed++; st.offsets.push(Math.abs(v.exit_t - g.t) / 1000); }
      } else st.entries++;
      const p = this.h.get('SELECT t, lat, lng, status FROM positions WHERE vehicle_id = ? AND t BETWEEN ? AND ? ORDER BY ABS(t - ?) LIMIT 1', g.vid, g.t - 10 * 60e3, g.t + 2 * 60e3, g.t);
      if (p && p.status !== 'moving') {
        const m = haversineM(p.lat, p.lng, y.lat, y.lng);
        if (m > NEAR_YARD_M) {
          const s = T.localIso(g.t);
          st.mismatches.push(`${s.slice(8, 10)}.${s.slice(5, 7)} ${s.slice(11, 16)} ${g.direction === 'out' ? 'chiqish' : 'kirish'}: GPS bo'yicha hovlidan ${(m / 1000).toFixed(1)} km uzoqda`);
        }
      }
    }
    return [...stats.values()].sort((a, b) => Number(!a.mismatches.length) - Number(!b.mismatches.length) || Number(!a.alias) - Number(!b.alias) || a.plate.localeCompare(b.plate));
  }

  auditText(days = 3) {
    const rows = this.audit(days);
    const out = [`🔍 <b>Kamera va GPS tekshiruvi</b> (oxirgi ${days} kun)`, ''];
    for (const s of rows) {
      let line = `<b>${escape(prettyPlate(s.plate))}</b>${s.alias ? ` = GPS'da ${escape(s.gpsName)}` : ''}: ${s.exits} chiqish`;
      if (s.exits) {
        line += `, ${s.confirmed} tasini GPS tasdiqladi`;
        if (s.offsets.length) line += ` (o'rtacha ${Math.round(s.offsets.reduce((a, b) => a + b, 0) / s.offsets.length)} s farq)`;
      }
      out.push(`${s.mismatches.length ? '⚠️' : '✅'} ${line}; ${s.entries} kirish`);
      for (const m of s.mismatches.slice(-3)) out.push(`    ${escape(m)}`);
    }
    if (!rows.length) out.push("Bu davrda GPS ro'yxatidagi mashina kamerada ko'rinmagan.");
    out.push('', rows.some((s) => s.mismatches.length) ? "⚠️ Mos kelmaganlar bor: kamera raqami boshqa mashinaniki bo'lishi mumkin." : "👍 Hammasi mos: har bir raqam to'g'ri GPS mashinasiga tegishli.");
    out.push("<i>Chiqishda GPS mashinasi shu daqiqalarda hovli chegarasidan chiqqan bo'lsa, tasdiqlangan hisoblanadi. Ba'zi yuk mashinalari darvoza oldida to'xtaydi, ular tasdiqlanmaydi, lekin xato ham emas.</i>");
    return out.join('\n');
  }

  /** One warning line for the daily report, or null when every pairing checks out. */
  mismatchLine(days = 1) {
    const bad = this.audit(days).filter((s) => s.mismatches.length);
    if (!bad.length) return null;
    return `⚠️ Kamera va GPS mos kelmadi: ${bad.map((s) => `${prettyPlate(s.plate)} (${s.mismatches.length} marta)`).join(', ')}. Batafsil: /tekshir`;
  }
}

module.exports = { Reports, shortAddress };
