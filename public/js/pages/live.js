// Jonli xarita: every vehicle live, status filters, search, vehicle card with today's numbers and track.
/* global L */
import { get, state } from '../api.js';
import { $, $$, html, setHtml, icon, typeIcon, statusHtml, ago, when, num, hm, today, STATUS, debounce, esc } from '../ui.js';
import { createMap, VehicleLayer } from '../map.js';

const ORDER = { moving: 0, idle: 1, stopped: 2, offline: 3 };
const SHORT = { moving: 'Harakatda', idle: 'Salt', stopped: "To'xtagan", offline: "Signal yo'q" };
const FILTER_KEY = 'tbb_live_filter';

export default {
  async render(main, { query }) {
    let filter = null;
    try { filter = sessionStorage.getItem(FILTER_KEY) || null; } catch { /* ignore */ }
    let search = '';
    let selected = query.v ? Number(query.v) : null;
    let follow = false;
    let track = null;

    main.innerHTML = String(html`
      <div class="live">
        <section class="live-side" aria-label="Transportlar">
          <div class="live-filters" id="fchips"></div>
          <div class="live-search">
            <input id="vsearch" type="search" placeholder="Raqam yoki nom bo'yicha qidirish" aria-label="Qidirish" />
          </div>
          <div class="vlist" id="vlist" role="listbox" aria-label="Transportlar ro'yxati"></div>
        </section>
        <section class="map-wrap">
          <div class="map" id="map"></div>
          <div class="map-tools">
            <button class="btn btn-sm" id="fitBtn" title="Barcha transportlar">${icon('fit')}<span>Hammasi</span></button>
            <button class="btn btn-sm" id="yardBtn" title="Hovli">${icon('home')}<span>Hovli</span></button>
          </div>
          <aside class="drawer" id="drawer" hidden></aside>
        </section>
      </div>`);

    const { map, destroy } = createMap($('#map', main));
    const layer = new VehicleLayer(map, { onClick: (id) => select(id, false), filter: (v) => !filter || v.status === filter });
    layer.sync();
    let fitted = false;
    if (!selected && layer.markers.size) { layer.fit(40, false); fitted = true; }

    const list = $('#vlist', main);
    const chips = $('#fchips', main);
    const drawer = $('#drawer', main);

    function counts() {
      const c = { moving: 0, idle: 0, stopped: 0, offline: 0 };
      for (const v of state.vehicles.values()) c[v.status]++;
      return c;
    }

    function renderChips() {
      const c = counts();
      setHtml(chips, html`${Object.keys(ORDER).map((k) => html`
        <button class="fchip" data-f="${k}" aria-pressed="${filter === k}" title="${STATUS[k]}"><b>${c[k]}</b><span class="status ${k}">${SHORT[k]}</span></button>`)}`);
    }

    function visible() {
      const q = search.trim().toLowerCase().replace(/\s+/g, '');
      return [...state.vehicles.values()]
        .filter((v) => !filter || v.status === filter)
        .filter((v) => !q || `${v.label} ${v.gpsName} ${v.plate || ''}`.toLowerCase().replace(/\s+/g, '').includes(q))
        .sort((a, b) => ORDER[a.status] - ORDER[b.status] || (b.speed || 0) - (a.speed || 0) || a.label.localeCompare(b.label));
    }

    function rowHtml(v) {
      const meta = v.status === 'offline' ? `Oxirgi signal: ${ago(v.recordTime)}` : (v.inYard ? 'Hovlida' : (v.address || '').split(',').slice(0, 2).join(','));
      return html`<button class="vrow" role="option" data-id="${v.id}" aria-selected="${selected === v.id}">
        <span class="vicon">${typeIcon(v.type)}</span>
        <span class="vname">${v.label}</span>
        <span class="vmeta">${statusHtml(v.status)} · ${meta}</span>
        <span class="vright">
          ${v.status === 'moving' ? html`<span class="speed">${Math.round(v.speed)} km/s</span>` : v.inYard ? html`<span class="yard-tag">Hovlida</span>` : ''}
          <span>${v.today.trips} reys · ${num(v.today.km)} km</span>
        </span></button>`;
    }

    function renderList() {
      const vs = visible();
      setHtml(list, vs.length ? html`${vs.map(rowHtml)}` : html`<div class="empty">Transport topilmadi</div>`);
    }

    function renderDrawer() {
      const v = state.vehicles.get(selected);
      if (!v) { drawer.hidden = true; return; }
      drawer.hidden = false;
      const fuel = v.today.fuelLevel != null ? html`<div><b>${num(v.today.fuelLevel)} L</b><span>Bakda</span></div>` : html`<div><b>${v.today.fuel != null ? num(v.today.fuel, 1) : '—'}</b><span>Yoqilg'i, L</span></div>`;
      setHtml(drawer, html`
        <div class="drawer-head">
          <span class="vicon" style="width:38px;height:38px;border-radius:10px;background:var(--surface-2);display:grid;place-items:center">${typeIcon(v.type)}</span>
          <div style="flex:1;min-width:0">
            <h2>${v.label}</h2>
            <div class="small muted">${v.gpsName !== v.label ? `GPS'da: ${v.gpsName}` : v.model || ''}</div>
          </div>
          <button class="icon-btn" id="dClose" aria-label="Yopish">${icon('close')}</button>
        </div>
        <div class="drawer-body">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${statusHtml(v.status)}${v.inYard ? html`<span class="yard-tag">Hovlida</span>` : ''}
            ${v.status === 'moving' ? html`<span class="pill info">${Math.round(v.speed)} km/soat</span>` : ''}</div>
          <dl class="kv">
            <dt>Manzil</dt><dd>${v.address || '—'}</dd>
            <dt>Signal</dt><dd>${when(v.recordTime)} (${ago(v.recordTime)})</dd>
            ${v.lastGate ? html`<dt>Darvoza</dt><dd><a href="#/darvoza?event=${v.lastGate.id}">${v.lastGate.direction === 'in' ? 'Kirdi' : 'Chiqdi'} ${when(v.lastGate.t)}</a></dd>` : ''}
          </dl>
          <div class="mini-stats">
            <div><b>${v.today.trips}</b><span>Bugun reys</span></div>
            <div><b>${num(v.today.km, 1)}</b><span>Bugun km</span></div>
            ${fuel}
          </div>
          <div class="drawer-actions">
            <button class="btn btn-sm" id="dFollow" aria-pressed="${follow}">${icon('target')}<span>${follow ? 'Kuzatilmoqda' : 'Kuzatish'}</span></button>
            <button class="btn btn-sm" id="dTrack" aria-pressed="${!!track}">${icon('route')}<span>${track ? "Izni yashirish" : 'Bugungi iz'}</span></button>
            <a class="btn btn-sm btn-primary" href="#/transport/${v.id}">Batafsil</a>
          </div>
          <div id="trackInfo" class="small muted"></div>
        </div>`);
      $('#dClose', drawer).onclick = () => select(null);
      $('#dFollow', drawer).onclick = () => { follow = !follow; if (follow && v.lat != null) map.panTo([v.lat, v.lng]); renderDrawer(); };
      $('#dTrack', drawer).onclick = () => toggleTrack(v.id);
      if (track) $('#trackInfo', drawer).textContent = track.info;
    }

    async function toggleTrack(id) {
      if (track) { track.layer.remove(); track = null; renderDrawer(); return; }
      try {
        const t = await get(`/api/vehicles/${id}/track?day=${today()}`);
        const g = L.layerGroup();
        const pts = t.points.map((p) => [p[1], p[2]]);
        if (pts.length > 1) L.polyline(pts, { color: '#2a78d6', weight: 4, opacity: 0.85 }).addTo(g);
        for (const s of t.stops) {
          L.marker([s.lat, s.lng], { icon: L.divIcon({ className: '', html: '<div class="stop-marker"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }) })
            .bindTooltip(`To'xtash: ${hm(s.start)}–${s.end ? hm(s.end) : 'hozir'}`).addTo(g);
        }
        g.addTo(map);
        track = { layer: g, vehicle: id, info: pts.length > 1 ? `Bugun: ${t.points.length} nuqta, ${t.stops.length} to'xtash (5 daq+)` : "Bugun uchun iz yo'q" };
        if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] });
      } catch (e) { track = null; }
      renderDrawer();
    }

    function select(id, fromList = true) {
      if (track && track.vehicle !== id) { track.layer.remove(); track = null; }
      selected = id;
      follow = false;
      layer.select(id);
      for (const r of $$('.vrow', list)) r.setAttribute('aria-selected', String(Number(r.dataset.id) === id));
      const v = state.vehicles.get(id);
      if (v && v.lat != null) map.setView([v.lat, v.lng], Math.max(map.getZoom(), fromList ? 14 : map.getZoom()), { animate: true });
      history.replaceState(null, '', id ? `#/xarita?v=${id}` : '#/xarita');
      renderDrawer();
    }

    chips.addEventListener('click', (e) => {
      const b = e.target.closest('.fchip');
      if (!b) return;
      filter = filter === b.dataset.f ? null : b.dataset.f;
      try { if (filter) sessionStorage.setItem(FILTER_KEY, filter); else sessionStorage.removeItem(FILTER_KEY); } catch { /* ignore */ }
      renderChips(); renderList(); layer.sync();
    });
    list.addEventListener('click', (e) => { const r = e.target.closest('.vrow'); if (r) select(Number(r.dataset.id)); });
    $('#vsearch', main).addEventListener('input', debounce((e) => { search = e.target.value; renderList(); }, 120));
    $('#fitBtn', main).onclick = () => layer.fit();
    $('#yardBtn', main).onclick = () => { const y = state.me.yard; map.setView([y.lat, y.lng], 17); };

    const refreshRows = debounce(() => { renderChips(); renderList(); if (selected) renderDrawer(); }, 300);
    const off = state.on('vehicles:changed', (ids) => {
      layer.sync(ids || null);
      if (!fitted && layer.markers.size) { layer.fit(40, false); fitted = true; }
      if (follow && selected && (!ids || ids.includes(selected))) {
        const v = state.vehicles.get(selected);
        if (v?.lat != null) map.panTo([v.lat, v.lng], { animate: true });
      }
      refreshRows();
    });
    // Ages ("3 daq oldin") tick even without new data.
    const tick = setInterval(() => { if (selected) renderDrawer(); }, 30e3);

    renderChips();
    renderList();
    if (selected) select(selected);
    void esc;

    return () => { off(); clearInterval(tick); destroy(); };
  },
};
