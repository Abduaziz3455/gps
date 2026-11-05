'use strict';
/**
 * Telegram texts (HTML, Uzbek labels) for gate events. The format is the one people already know from the notifier:
 * KIRDI = came in, CHIQDI = left. Pure functions.
 */
const T = require('../time');
const { prettyPlate, plateKey } = require('../gps/normalize');

const escape = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

/** "2 soat 15 daqiqa" / "16 daqiqa". */
function duration(seconds) {
  const m = Math.floor(seconds / 60);
  const h = Math.floor(m / 60);
  return h ? `${h} soat ${m % 60} daqiqa` : `${m} daqiqa`;
}

const hms = (ms) => T.localIso(ms).slice(11, 19);
const { hm, hmOn } = T;
const dmy = (ms) => { const s = T.localIso(ms); return `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)} ${s.slice(11, 19)}`; };
const space = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

function plateLine(ev) {
  if (ev.identifiedBy === 'gps' && ev.vehicleLabel) return `🚛 <b>${escape(ev.vehicleLabel)}</b>  <i>(raqam o'qilmadi, GPS bo'yicha aniqlandi)</i>`;
  if (!ev.plate) return '🚛 Raqamsiz mashina';
  if (!ev.plateValid) return `🔢 <b>${escape(ev.plate)}</b>  ⚠️ <i>noaniq</i>`;
  let line = `🔢 <b>${escape(prettyPlate(ev.plate))}</b>`;
  if (ev.plateRaw && ev.plateRaw !== ev.plate) line += `  <i>(o'qildi: ${escape(ev.plateRaw)})</i>`;
  if (ev.vehicleId && ev.gpsName && plateKey(ev.gpsName) !== ev.plate) line += `  <i>(GPS'da: ${escape(ev.gpsName)})</i>`;
  return line;
}

function gpsLines(ev, g) {
  const t = ev.t;
  const out = [];
  if (g.state) out.push(escape(g.state));
  if (g.yardSince && ev.staySeconds == null) out.push(`⏱ Hududda: ${duration((t - g.yardSince) / 1000)} (${hmOn(g.yardSince, t)} dan, GPS)`);
  if (g.tripStart) {
    let trip = `🛣 Reys: ${(g.tripKm ?? 0).toFixed(1)} km, ${duration((t - g.tripStart) / 1000)}`;
    if (g.tripFuel != null) trip += `, ${g.tripFuel.toFixed(1)} L sarflandi`;
    out.push(`${trip} (${hmOn(g.tripStart, t)} da chiqqan)`);
  }
  for (const e of g.fuelEvents || []) {
    out.push(e.kind === 'refuel' ? `⛽ Quyildi: +${Math.round(e.litres)} L (${hm(e.t)})` : `🚨 To'kildi: −${Math.round(e.litres)} L (${hm(e.t)})`);
  }
  if (g.fuelLevel != null) out.push(`⛽ Bakda: ${Math.round(g.fuelLevel)} L`);
  if (g.todayKm != null) out.push(`📊 Bugun: ${g.todayKm.toFixed(1)} km${g.todayFuel != null ? `, ${g.todayFuel.toFixed(1)} L` : ''}`);
  if (g.odometer) out.push(`🧭 Probeg: ${space(g.odometer)} km`);
  if (g.error) out.push("⚠️ <i>GPS ma'lumotlarini olib bo'lmadi</i>");
  return out;
}

/**
 * The caption of a gate alert.
 * @param {object} ev  API shape of the gate event (src/gate.js view)
 * @param {object|null} g  GPS details (src/gatedetails.js), null without GPS
 * @param {{delayMs?: number|null}} [o]  delayMs: shown when the alert goes out late
 */
function gateCaption(ev, g, { delayMs = null } = {}) {
  const lines = [ev.direction === 'in' ? '🟢 <b>KIRDI</b>' : '🔴 <b>CHIQDI</b>', plateLine(ev)];
  if (!ev.vehicleId) lines.push(ev.plate && ev.plateValid ? "🚫 <b>GPS ro'yxatida yo'q</b>" : "🚫 <b>GPS bo'yicha aniqlanmadi</b>");
  lines.push(`🕒 ${dmy(ev.t)}`);
  // Time inside comes from the cameras at the gate: GPS counts the queue on the street as "at the yard".
  if (ev.staySeconds != null) lines.push(`⏱ Ichkarida: ${duration(ev.staySeconds)}`);
  const gpsKnows = g && (g.yardSince || g.tripStart);
  if (ev.gap && !gpsKnows) lines.push(ev.direction === 'in' ? 'ℹ️ <i>Oldingi chiqishi qayd etilmagan</i>' : 'ℹ️ <i>Kirishi qayd etilmagan</i>');
  if (g) lines.push(...gpsLines(ev, g));
  if (delayMs != null) lines.push(`⏳ <i>Kechikkan xabar: ${duration(delayMs / 1000)} oldin</i>`);
  return lines.join('\n');
}

/** A system alert (src/health.js) as a message. */
function systemText(a) {
  const icon = a.severity === 'info' ? '' : a.severity === 'critical' ? '🚨 ' : '⚠️ ';
  return `${icon}<b>${escape(a.title)}</b>${a.body ? `\n${escape(a.body)}` : ''}`;
}

module.exports = { escape, duration, gateCaption, systemText, hms, dmy, space };
