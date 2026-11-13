// Xarita: every truck live, a search and status filter, a card for the one tapped, or the same trucks as a list.
import { state } from '../../api.js';
import { $, html, icon, setHtml, typeIcon, num, ago, STATUS, debounce } from '../../ui.js';
import { createMap, VehicleLayer } from '../../map.js';
import { vehicleRow, whereText, statusCounts, plateKeyOf } from '../parts.js';
import * as tg from '../telegram.js';

const STATUSES = ['moving', 'idle', 'stopped', 'offline'];

export default {
  async render(host, { query }) {
    let status = STATUSES.includes(query.status) ? query.status : '';
    let text = '';
    let view = query.view === 'list' ? 'list' : 'map';
    let selected = null;

    setHtml(host, html`
      <div class="tg-mapbar">
        <label class="tg-search">${icon('search')}<input type="search" placeholder="Raqam yoki nom" aria-label="Qidirish" enterkeyhint="search"></label>
        <div class="seg tg-seg" data-view role="group"><button type="button" data-v="map" aria-pressed="${view === 'map'}">${icon('map')}</button><button type="button" data-v="list" aria-pressed="${view === 'list'}" aria-label="Ro'yxat">${icon('report')}</button></div>
      </div>
      <div class="tg-chips" data-chips></div>
      <div class="tg-mapwrap"><div class="tg-map" data-map></div><div class="tg-sheet" data-sheet hidden></div></div>
      <div class="tg-list tg-vlist" data-list hidden></div>`);

    const match = (v) => (!status || v.status === status)
      && (!text || plateKeyOf(v.label).includes(text) || plateKeyOf(v.gpsName || '').includes(text) || plateKeyOf(v.plate || '').includes(text));

    const { map, destroy } = createMap(host.querySelector('[data-map]'), { editPlaces: false });
    const layer = new VehicleLayer(map, { onClick: (id) => select(id), filter: match });
    layer.sync();

    const chips = () => {
      const c = statusCounts();
      setHtml(host.querySelector('[data-chips]'), html`<button type="button" class="tg-chip" aria-pressed="${!status}" data-s="">Hammasi</button>${STATUSES.map((s) => html`<button type="button" class="tg-chip" aria-pressed="${status === s}" data-s="${s}"><span class="status ${s}"></span>${STATUS[s]} <b>${c[s]}</b></button>`)}`);
    };

    const sheet = () => {
      const box = host.querySelector('[data-sheet]');
      const v = selected != null ? state.vehicles.get(selected) : null;
      box.hidden = !v || view !== 'map';
      if (!v) return;
      setHtml(box, html`
        <div class="tg-sheet-head"><span class="tg-veh-icon ${v.status}">${typeIcon(v.type)}</span><div><b class="plate">${v.label}</b><div class="small"><span class="status ${v.status}">${STATUS[v.status]}</span>${v.status === 'moving' ? ` · ${num(v.speed)} km/soat` : ''}</div></div>
          <button class="icon-btn" type="button" data-close aria-label="Yopish">${icon('close')}</button></div>
        <div class="small">${icon('pin')} ${whereText(v) || "Joy noma'lum"}</div>
        <div class="small muted">Signal: ${ago(v.recordTime)}${v.gpsName && v.gpsName !== v.label ? ` · GPS'da: ${v.gpsName}` : ''}</div>
        <div class="tg-facts"><span><b>${v.today?.trips ?? 0}</b> reys</span><span><b>${num(v.today?.km ?? 0)}</b> km</span>${v.today?.fuelLevel != null ? html`<span><b>${num(v.today.fuelLevel)}</b> L bakda</span>` : ''}</div>
        <div class="tg-actions row"><a class="btn btn-primary tg-big" href="#/v/${v.id}">Batafsil</a>${v.lat != null ? html`<button class="btn tg-big" type="button" data-nav>${icon('route')} Yo'l</button>` : ''}</div>`);
    };

    const list = () => {
      const box = host.querySelector('[data-list]');
      const rows = [...state.vehicles.values()].filter((v) => v.inGps || v.cameraOnly).filter(match)
        .sort((a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || a.label.localeCompare(b.label));
      setHtml(box, rows.length ? html`${rows.map(vehicleRow)}` : html`<div class="tg-empty">Topilmadi</div>`);
    };

    const show = () => {
      host.querySelector('.tg-mapwrap').hidden = view !== 'map';
      host.querySelector('[data-list]').hidden = view !== 'list';
      if (view === 'list') list(); else { map.invalidateSize(); sheet(); }
    };

    function select(id) {
      selected = id;
      layer.select(id);
      tg.haptic('light');
      sheet();
      const v = state.vehicles.get(id);
      if (v?.lat != null) map.panTo([v.lat, v.lng], { animate: true });
    }

    const refilter = () => {
      chips();
      layer.sync();
      if (view === 'list') list();
      if (selected != null && !match(state.vehicles.get(selected) || {})) { selected = null; layer.select(null); sheet(); }
    };

    host.addEventListener('click', (e) => {
      const chip = e.target.closest('.tg-chip');
      if (chip) { status = chip.dataset.s; tg.haptic('select'); refilter(); if (status && view === 'map') layer.fit(48); return; }
      const vb = e.target.closest('[data-view] button');
      if (vb) { view = vb.dataset.v; for (const b of vb.parentElement.children) b.setAttribute('aria-pressed', String(b === vb)); tg.haptic('select'); show(); return; }
      if (e.target.closest('[data-close]')) { selected = null; layer.select(null); sheet(); return; }
      if (e.target.closest('[data-nav]')) {
        const v = state.vehicles.get(selected);
        if (v) navigate(v);
      }
    });
    const input = host.querySelector('input');
    input.addEventListener('input', debounce(() => { text = plateKeyOf(input.value); refilter(); }, 200));
    map.on('click', () => { if (selected != null) { selected = null; layer.select(null); sheet(); } });

    chips();
    show();
    // The opening view, once the screen has its final size: the yard and the trucks working around it, or the chosen status.
    requestAnimationFrame(() => { map.invalidateSize(); if (status) layer.fit(48, false); else layer.fitWork(40); });

    const offs = [
      state.on('vehicles:changed', (ids) => { layer.sync(ids || undefined); if (selected != null && (!ids || ids.includes(selected))) sheet(); }),
      state.on('vehicles:changed', debounce(() => { chips(); if (view === 'list') list(); }, 500)),
    ];
    return () => { offs.forEach((off) => off()); destroy(); };
  },
};

/** The truck's spot in a maps app: Yandex (most used here) and Google, the person picks. */
function navigate(v) {
  const at = `${v.lat.toFixed(6)},${v.lng.toFixed(6)}`;
  const m = document.createElement('div');
  m.className = 'tg-pick';
  setHtml(m, html`<button class="btn btn-block tg-big" type="button" data-y>Yandex Xaritalar</button><button class="btn btn-block tg-big" type="button" data-g>Google Maps</button><button class="btn btn-ghost btn-block" type="button" data-x>Bekor qilish</button>`);
  const close = () => m.remove();
  m.querySelector('[data-y]').onclick = () => { tg.openLink(`https://yandex.uz/maps/?pt=${v.lng.toFixed(6)},${v.lat.toFixed(6)}&z=16&l=map`); close(); };
  m.querySelector('[data-g]').onclick = () => { tg.openLink(`https://www.google.com/maps/search/?api=1&query=${at}`); close(); };
  m.querySelector('[data-x]').onclick = close;
  $('#modalRoot').append(m);
}
