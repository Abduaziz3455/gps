// Pieces several mini app screens draw: a gate pass, an alert, a truck, a period switch.
import { post, state } from '../api.js';
import { html, icon, typeIcon, hm, when, dur, num, STATUS, GATE_STATUS, ago, toastError } from '../ui.js';
import { nameAt } from '../places.js';
import * as tg from './telegram.js';

export const evLabel = (ev) => ev.vehicleLabel || ev.plateText || ev.plate || "Raqam o'qilmadi";

/** One pass through the gate: photo, direction, who, when, GPS check. Opens the pass. */
export function eventRow(ev) {
  const [statusText, statusCls] = GATE_STATUS[ev.status] || [ev.status, ''];
  const showStatus = ev.status !== 'history' && ev.status !== 'outside';
  const photo = ev.photos?.[0]?.url;
  return html`<a class="tg-ev" href="#/e/${ev.id}" data-id="${ev.id}">
    ${photo ? html`<img class="tg-thumb" src="${photo}" loading="lazy" alt="">` : html`<span class="tg-thumb none">${icon('camera')}</span>`}
    <span class="tg-ev-main">
      <span class="tg-ev-head"><span class="tg-dir ${ev.direction}">${ev.direction === 'in' ? 'KIRDI' : 'CHIQDI'}</span><b class="plate">${evLabel(ev)}</b></span>
      <span class="small muted">${when(ev.t)}${ev.staySeconds != null ? ` · ichkarida ${dur(ev.staySeconds)}` : ''}${!ev.vehicleId ? (ev.plateValid ? " · GPS ro'yxatida yo'q" : '') : ''}</span>
    </span>
    ${!ev.vehicleId ? html`<span class="pill">Begona</span>` : showStatus ? html`<span class="pill ${statusCls}">${statusText}</span>` : ''}
  </a>`;
}

const SEV = { critical: 'bad', warning: 'warn', info: '' };

/** One alert, with its acknowledge button while it is open. */
export function alertRow(a) {
  return html`<div class="tg-alert ${SEV[a.severity] || ''}${a.ackedAt ? ' done' : ''}" data-id="${a.id}">
    <span class="tg-alert-icon">${icon(a.type === 'fuel_drain' ? 'fuel' : a.type === 'system' ? 'alert' : a.type === 'long_stop' ? 'clock' : 'info')}</span>
    <div class="tg-alert-main">
      <b>${a.title}</b>
      ${a.body ? html`<div class="small tg-alert-body">${a.body}</div>` : ''}
      <div class="small muted">${when(a.t)}${a.ackedAt ? html` · ✓ ${a.ackedBy || "o'qildi"}` : ''}${a.vehicleId ? html` · <a href="#/v/${a.vehicleId}">transport</a>` : ''}</div>
    </div>
    ${a.ackedAt ? '' : html`<button class="btn btn-sm" type="button" data-ack="${a.id}" aria-label="O'qildi">${icon('check')}</button>`}
  </div>`;
}

/** The acknowledge buttons in `root`. */
export function wireAck(root, after) {
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-ack]');
    if (!b) return;
    b.disabled = true;
    try {
      await post(`/api/alerts/${b.dataset.ack}/ack`);
      tg.haptic('success');
      after?.();
    } catch (err) { b.disabled = false; toastError(err); }
  });
}

/** A GPS address without the city and country every one of them ends with (as the bot's reports do). */
export function shortAddress(a = '') {
  for (const tail of [', Ташкент, Узбекистан', ', Узбекистан']) if (a.endsWith(tail) && a.length > tail.length) return a.slice(0, -tail.length);
  return a;
}

/** Where a truck is, in the words people use. */
export const whereText = (v) => (v.lat == null ? '' : nameAt(v.lat, v.lng) || shortAddress(v.address || ''));

/** One truck: status, where, today's numbers. Opens the truck. */
export function vehicleRow(v) {
  return html`<a class="tg-veh" href="#/v/${v.id}">
    <span class="tg-veh-icon ${v.status}">${typeIcon(v.type)}</span>
    <span class="tg-veh-main">
      <b class="plate">${v.label}</b>
      <span class="small muted">${STATUS[v.status] || v.status}${v.status === 'moving' ? ` · ${num(v.speed)} km/soat` : ''}${v.status === 'offline' ? ` · ${ago(v.recordTime)}` : ''} · ${whereText(v) || '—'}</span>
    </span>
    <span class="tg-veh-side small"><b>${v.today?.trips ?? 0}</b> reys<br>${num(v.today?.km ?? 0)} km</span>
  </a>`;
}

/** Status counts of the trucks GoGPS tracks (not camera-only ones, nor ones removed from GoGPS). */
export function statusCounts() {
  const c = { moving: 0, idle: 0, stopped: 0, offline: 0 };
  for (const v of state.vehicles.values()) if (v.inGps && c[v.status] !== undefined) c[v.status]++;
  return c;
}

/** Buttons that choose one of `options` [{id, label}]; calls onPick(id). */
export function seg(options, current) {
  return html`<div class="seg tg-seg" role="group">${options.map((o) => html`<button type="button" data-v="${o.id}" aria-pressed="${o.id === current}">${o.label}</button>`)}</div>`;
}
export function wireSeg(root, onPick) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('.tg-seg button');
    if (!b || b.getAttribute('aria-pressed') === 'true') return;
    for (const x of b.parentElement.children) x.setAttribute('aria-pressed', String(x === b));
    tg.haptic('select');
    onPick(b.dataset.v, b.parentElement);
  });
}

/** Text for matching plates and names: "85 159 yaa" and "85159YAA" are the same. */
export const plateKeyOf = (s) => String(s || '').toUpperCase().replace(/[^0-9A-ZА-ЯЁЎҚҒҲ]/g, '');

export const timeRange = (a, b) => `${hm(a)}–${b ? hm(b) : '…'}`;
