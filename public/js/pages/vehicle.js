// Transport: one vehicle, one day — track and stops on the map, a timeline of gate passes, stops and fuel,
// the day's totals, and the last 14 days as charts.
/* global L */
import { get, state } from '../api.js';
import { $, html, setHtml, icon, typeIcon, statusHtml, hm, when, dur, num, today, addDays, dayLabel, shortDay, ago, toastError, esc } from '../ui.js';
import { createMap } from '../map.js';
import { barChart, responsive } from '../charts.js';

export default {
  async render(main, { params, query, setTitle }) {
    const id = Number(params[0]);
    if (!id || !state.vehicles.has(id)) return picker(main);
    const v0 = state.vehicles.get(id);
    setTitle(`Transport: ${v0.label}`);
    let day = /^\d{4}-\d{2}-\d{2}$/.test(query.day || '') ? query.day : today();
    const vehicles = [...state.vehicles.values()].sort((a, b) => a.label.localeCompare(b.label));

    main.innerHTML = String(html`
      <div class="page">
        <div class="page-head">
          <select id="vSel" aria-label="Transport">${vehicles.map((v) => html`<option value="${v.id}" ${v.id === id ? 'selected' : ''}>${v.label}</option>`)}</select>
          <button class="icon-btn" id="prevDay" title="Oldingi kun" aria-label="Oldingi kun">‹</button>
          <input type="date" id="vDay" aria-label="Kun" />
          <button class="icon-btn" id="nextDay" title="Keyingi kun" aria-label="Keyingi kun">›</button>
          <span class="spacer"></span>
          <span id="vLive"></span>
          <a class="btn btn-sm" href="#/xarita?v=${id}">${icon('map')}<span>Jonli xaritada</span></a>
        </div>
        <div class="vpage">
          <div class="grid" style="gap:16px">
            <section class="card"><div class="vmap" id="vmap"></div></section>
            <div class="tiles" id="dayTiles" style="grid-template-columns:repeat(auto-fill,minmax(140px,1fr))"></div>
            <div class="grid grid-2">
              <section class="card"><div class="card-head"><h3>Masofa, km</h3><span class="muted small">oxirgi 14 kun</span></div><div class="card-body"><div id="chKm"></div></div></section>
              <section class="card"><div class="card-head"><h3>Reyslar</h3><span class="muted small">oxirgi 14 kun</span></div><div class="card-body"><div id="chTrips"></div></div></section>
            </div>
          </div>
          <aside class="grid" style="gap:16px">
            <section class="card" id="infoCard"></section>
            <section class="card"><div class="card-head"><h2>Kun xronologiyasi</h2><span class="spacer"></span><span class="muted small" id="tlCount"></span></div><div class="timeline" id="timeline"></div></section>
          </aside>
        </div>
      </div>`);
    $('#vDay', main).value = day;
    $('#vDay', main).max = today();

    const { map, destroy } = createMap($('#vmap', main), { zoom: 12 });
    const layer = L.layerGroup().addTo(map);
    let disposers = [];

    function renderLive() {
      const v = state.vehicles.get(id);
      setHtml($('#vLive', main), html`${statusHtml(v.status)} <span class="muted small">${ago(v.recordTime)}</span>`);
      setHtml($('#infoCard', main), html`
        <div class="card-head">${typeIcon(v.type)}<h2>${v.label}</h2></div>
        <div class="card-body"><dl class="kv">
          <dt>GPS nomi</dt><dd>${v.gpsName}</dd>
          ${v.plate ? html`<dt>Raqam</dt><dd><span class="plate-chip">${v.plate}</span></dd>` : ''}
          <dt>Holat</dt><dd>${statusHtml(v.status)}${v.status === 'moving' ? ` · ${Math.round(v.speed)} km/soat` : ''}${v.inYard ? ' · hovlida' : ''}</dd>
          <dt>Manzil</dt><dd>${v.address || '—'}</dd>
          <dt>Oxirgi signal</dt><dd>${when(v.recordTime)}</dd>
        </dl></div>`);
    }

    async function load() {
      history.replaceState(null, '', `#/transport/${id}?day=${day}`);
      $('#nextDay', main).disabled = day >= today();
      layer.clearLayers();
      setHtml($('#timeline', main), html`<div class="empty">Yuklanmoqda…</div>`);
      const from14 = addDays(day, -13);
      const [track, events, days] = await Promise.all([
        get(`/api/vehicles/${id}/track?day=${day}`),
        get(`/api/vehicles/${id}/events?from=${day}&to=${day}`),
        get(`/api/vehicles/${id}/days?from=${from14}&to=${day}`),
      ]).catch((e) => { toastError(e); return [null, null, null]; });
      if (!track) return;
      // map
      const pts = track.points.map((p) => [p[1], p[2]]);
      if (pts.length > 1) {
        L.polyline(pts, { color: '#2a78d6', weight: 4, opacity: 0.85 }).addTo(layer);
        L.circleMarker(pts[0], { radius: 6, color: '#fff', weight: 2, fillColor: '#0ca30c', fillOpacity: 1 }).bindTooltip(`Boshlanish ${hm(track.points[0][0])}`).addTo(layer);
        L.circleMarker(pts[pts.length - 1], { radius: 6, color: '#fff', weight: 2, fillColor: '#d03b3b', fillOpacity: 1 }).bindTooltip(`Oxirgi nuqta ${hm(track.points[track.points.length - 1][0])}`).addTo(layer);
        map.fitBounds(L.latLngBounds(pts), { padding: [30, 30] });
      } else {
        const v = state.vehicles.get(id);
        if (v.lat != null) map.setView([v.lat, v.lng], 14);
      }
      for (const s of track.stops) {
        L.marker([s.lat, s.lng], { icon: L.divIcon({ className: '', html: '<div class="stop-marker"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }) })
          .bindTooltip(`To'xtash ${hm(s.start)}–${s.end ? hm(s.end) : 'hozir'} (${dur(((s.end || Date.now()) - s.start) / 1000)})`).addTo(layer);
      }
      // day tiles
      const d = days.find((x) => x.day === day) || {};
      setHtml($('#dayTiles', main), html`
        <div class="tile"><span class="tile-label">Reyslar</span><span class="tile-value">${d.trips ?? 0}</span><span class="tile-sub">${d.firstOut ? `birinchi chiqish ${hm(d.firstOut)}` : '—'}</span></div>
        <div class="tile"><span class="tile-label">Masofa</span><span class="tile-value">${num(d.km, 1)}<small>km</small></span><span class="tile-sub">${d.odometer ? `probeg ${num(d.odometer)} km` : ''}</span></div>
        <div class="tile"><span class="tile-label">Motosoat</span><span class="tile-value">${num(d.engineHours, 1)}<small>soat</small></span><span class="tile-sub">salt: ${num(d.idleHours, 1)} soat</span></div>
        <div class="tile"><span class="tile-label">Yoqilg'i</span><span class="tile-value">${d.fuelUsed != null ? num(d.fuelUsed, 1) : '—'}<small>L</small></span><span class="tile-sub">${d.refuelL ? `quyildi ${num(d.refuelL)} L` : ''}${d.drainL ? ` · to'kildi ${num(d.drainL)} L` : ''}</span></div>
        <div class="tile"><span class="tile-label">Maks. tezlik</span><span class="tile-value">${d.maxSpeed != null ? Math.round(d.maxSpeed) : '—'}<small>km/s</small></span><span class="tile-sub">${d.turnaroundMin ? `aylanish ${d.turnaroundMin} daq` : ''}</span></div>`);
      // charts
      disposers.forEach((f) => f());
      const lbl = (x) => ({ label: shortDay(x.day), dim: x.day !== day && false });
      disposers = [
        responsive($('#chKm', main), () => barChart($('#chKm', main), days.map((x) => ({ ...lbl(x), value: x.km, tip: `<b>${esc(dayLabel(x.day))}</b>: ${num(x.km, 1)} km` })), { height: 170, unit: 'km' })),
        responsive($('#chTrips', main), () => barChart($('#chTrips', main), days.map((x) => ({ ...lbl(x), value: x.trips, tip: `<b>${esc(dayLabel(x.day))}</b>: ${x.trips} reys` })), { height: 170, unit: 'reys', valueLabels: true })),
      ];
      // timeline: gate passes + fuel + GPS stops (the GoGPS report, loaded after)
      const items = [
        ...events.gate.filter((g) => g.status !== 'vetoed').map((g) => ({ t: g.t, cls: g.direction, text: html`<b>${g.direction === 'in' ? 'Hovliga kirdi' : 'Hovlidan chiqdi'}</b> <a href="#/darvoza?event=${g.id}" class="small">rasm</a>${g.staySeconds ? html`<div class="small muted">ichkarida ${dur(g.staySeconds)}</div>` : ''}` })),
        ...events.fuel.map((f) => ({ t: f.t, cls: 'fuel', text: html`<b>${f.kind === 'refuel' ? `Yoqilg'i quyildi +${Math.round(f.litres)} L` : `Yoqilg'i to'kildi −${Math.round(f.litres)} L`}</b>` })),
        ...events.alerts.map((a) => ({ t: a.t, cls: '', text: html`${icon('alert')} ${a.title}<div class="small muted">${a.body || ''}</div>` })),
      ];
      renderTimeline(items);
      try {
        const st = await get(`/api/vehicles/${id}/stops?day=${day}`);
        for (const s of st.stops) if ((s.duration || 0) >= 300) items.push({ t: s.start, cls: '', text: html`To'xtash ${dur(s.duration)}<div class="small muted">${(s.address || '').split(',').slice(0, 2).join(',')}</div>` });
        for (const mv of st.moves) if ((mv.km || 0) >= 1) items.push({ t: mv.start, cls: 'move', text: html`Harakat ${num(mv.km, 1)} km<div class="small muted">${dur(mv.duration)}</div>` });
        renderTimeline(items);
      } catch { /* GoGPS report optional */ }
    }

    function renderTimeline(items) {
      items.sort((a, b) => a.t - b.t);
      $('#tlCount', main).textContent = `${items.length} ta`;
      setHtml($('#timeline', main), items.length ? html`${items.map((x) => html`<div class="tl-item"><span class="tl-time">${hm(x.t)}</span><span class="tl-dot ${x.cls}"></span><div>${x.text}</div></div>`)}`
        : html`<div class="empty">${dayLabel(day)}: ma'lumot yo'q</div>`);
    }

    $('#vSel', main).onchange = (e) => { location.hash = `#/transport/${e.target.value}?day=${day}`; };
    $('#vDay', main).onchange = (e) => { day = e.target.value || today(); load(); };
    $('#prevDay', main).onclick = () => { day = addDays(day, -1); $('#vDay', main).value = day; load(); };
    $('#nextDay', main).onclick = () => { if (day < today()) { day = addDays(day, 1); $('#vDay', main).value = day; load(); } };
    const off = state.on('vehicles:changed', (ids) => { if (!ids || ids.includes(id)) renderLive(); });
    renderLive();
    await load();
    return () => { off(); disposers.forEach((f) => f()); destroy(); };
  },
};

function picker(main) {
  const vs = [...state.vehicles.values()].sort((a, b) => a.label.localeCompare(b.label));
  main.innerHTML = String(html`<div class="page"><div class="card"><div class="card-head"><h2>Transportni tanlang</h2></div>
    <div class="table-wrap"><table class="table"><thead><tr><th>Transport</th><th>Holat</th><th class="num">Bugun reys</th><th class="num">Bugun km</th><th>Oxirgi signal</th></tr></thead>
    <tbody>${vs.map((v) => html`<tr class="clickable" data-id="${v.id}"><td>${typeIcon(v.type)} <b>${v.label}</b> ${v.gpsName !== v.label ? html`<span class="muted small">${v.gpsName}</span>` : ''}</td>
      <td>${statusHtml(v.status)}</td><td class="num">${v.today.trips}</td><td class="num">${num(v.today.km, 1)}</td><td>${ago(v.recordTime)}</td></tr>`)}</tbody></table></div></div></div>`);
  main.querySelector('tbody').addEventListener('click', (e) => { const r = e.target.closest('tr'); if (r) location.hash = `#/transport/${r.dataset.id}`; });
  return () => {};
}
