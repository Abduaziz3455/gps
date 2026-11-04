// Transport: one vehicle, one day — track and stops on the map, a timeline of gate passes, stops and fuel,
// the day's totals, and the last 14 days as charts.
/* global L */
import { get, state } from '../api.js';
import { $, html, setHtml, icon, typeIcon, statusHtml, hm, when, dur, num, today, isDay, addDays, dayLabel, shortDay, ago, toastError, esc } from '../ui.js';
import { createMap } from '../map.js';
import { barChart, responsive } from '../charts.js';
import { placeAt, inYard, nameAt, placePanel, closePanelOf } from '../places.js';

/** The period's averages, by the same rules as the Tahlil page. Null: the numbers couldn't be loaded. */
function periodTiles(s, from, to) {
  if (!s) return '';
  const span = `${s.days} kun: ${shortDay(from)}–${shortDay(to)}`;
  const over = s.fuelNorm && s.fuelPer100 != null && s.fuelPer100 > s.fuelNorm * 1.15;
  return html`
    <div class="tile" id="tileFuel100"><span class="tile-label">O'rtacha yoqilg'i sarfi</span>
      <span class="tile-value">${s.fuelPer100 != null ? num(s.fuelPer100, 1) : '—'}<small>L/100 km</small></span>
      <span class="tile-sub">${s.fuelPer100 != null ? html`${span} · ${num(s.fuelUsed, 1)} L${s.fuelNorm ? html` · <span class="${over ? 'delta down' : ''}">norma ${num(s.fuelNorm, 1)}</span>` : ''}` : `${span} · yoqilg'i ma'lumoti yo'q`}</span></div>
    <div class="tile" id="tileUse" title="Kamida 1 reys yoki 5 km bo'lgan kunlar"><span class="tile-label">Foydalanish</span>
      <span class="tile-value">${s.utilization ?? '—'}<small>%</small></span>
      <span class="tile-sub">${span} · ${s.activeDays} kun ishladi</span></div>`;
}

export default {
  async render(main, { params, query, setTitle }) {
    const id = Number(params[0]);
    if (!id || !state.vehicles.has(id)) return picker(main);
    const v0 = state.vehicles.get(id);
    setTitle(`Transport: ${v0.label}`);
    let day = isDay(query.day) ? query.day : today();
    const vehicles = [...state.vehicles.values()].sort((a, b) => a.label.localeCompare(b.label));

    main.innerHTML = String(html`
      <div class="page">
        <div class="page-head">
          <select id="vSel" aria-label="Transport">${vehicles.map((v) => html`<option value="${v.id}" ${v.id === id ? 'selected' : ''}>${v.label}</option>`)}</select>
          <div class="day-nav">
            <button class="icon-btn" id="prevDay" title="Oldingi kun" aria-label="Oldingi kun">‹</button>
            <input type="date" id="vDay" aria-label="Kun" />
            <button class="icon-btn" id="nextDay" title="Keyingi kun" aria-label="Keyingi kun">›</button>
          </div>
          <span class="spacer"></span>
          <span id="vLive"></span>
          <a class="btn btn-sm" href="#/xarita?v=${id}">${icon('map')}<span>Jonli xaritada</span></a>
        </div>
        <div class="vpage">
          <div class="grid" style="gap:16px">
            <section class="card map-card" id="vmapCard"><div class="vmap" id="vmap"></div></section>
            <div class="tiles" id="dayTiles" style="grid-template-columns:repeat(auto-fill,minmax(140px,1fr))"></div>
            <div class="tiles grid-2" id="avgTiles"></div>
            <div class="grid grid-2">
              <section class="card"><div class="card-head"><h3>Masofa, km</h3><span class="muted small">oxirgi 14 kun</span></div><div class="card-body"><div id="chKm"></div></div></section>
              <section class="card"><div class="card-head"><h3>Reyslar</h3><span class="muted small">oxirgi 14 kun</span></div><div class="card-body"><div id="chTrips"></div></div></section>
            </div>
          </div>
          <aside class="grid" style="gap:16px">
            <section class="card" id="infoCard"></section>
            <section class="card" id="placesCard" hidden></section>
            <section class="card"><div class="card-head"><h2>Kun xronologiyasi</h2><span class="spacer"></span><span class="muted small" id="tlCount"></span></div><div class="timeline" id="timeline"></div></section>
          </aside>
        </div>
      </div>`);
    $('#vDay', main).value = day;
    $('#vDay', main).max = today();

    const { map, destroy } = createMap($('#vmap', main), { zoom: 12 });
    const layer = L.layerGroup().addTo(map);
    const stopsLayer = L.layerGroup().addTo(map);
    let disposers = [];
    let shownStops = [];
    let items = []; // the timeline's rows, for the names to follow a change of places
    let track = null;

    /** "10:05–10:40 (35 daq)". A stop still going on when the day's samples end only runs until "now" on today's page. */
    function stopSpan(s) {
      const last = track?.points?.[track.points.length - 1]?.[0];
      const open = !s.end && day === today();
      const end = s.end || (open ? Date.now() : last || s.start);
      return `${hm(s.start)}–${open ? 'hozir' : hm(end)} (${dur((end - s.start) / 1000)})`;
    }

    /** The owner marks a stop as a place, or changes the place it is already in. The yard already has a name. */
    function openPanel(s) {
      const place = placeAt(s.lat, s.lng);
      placePanel({
        host: $('#vmapCard', main), map, lat: place?.lat ?? s.lat, lng: place?.lng ?? s.lng, place,
        note: `To'xtash ${stopSpan(s)}`,
      });
    }

    function drawStops() {
      stopsLayer.clearLayers();
      for (const s of shownStops) {
        const where = nameAt(s.lat, s.lng);
        const canMark = state.isOwner && !inYard(s.lat, s.lng);
        const m = L.marker([s.lat, s.lng], { icon: L.divIcon({ className: '', html: '<div class="stop-marker"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }) })
          .bindTooltip(`To'xtash ${stopSpan(s)}${where ? ` · ${esc(where)}` : ''}${canMark ? `<br><span class="small">Bosing: ${where ? 'joyni tahrirlash' : 'joy sifatida belgilash'}</span>` : ''}`)
          .addTo(stopsLayer);
        if (canMark) m.on('click', () => openPanel(s));
      }
    }

    async function renderPlacesCard() {
      const box = $('#placesCard', main);
      if (!state.places.length) { box.hidden = true; return; }
      const from = addDays(day, -13), asked = day;
      const list = await get(`/api/vehicles/${id}/places?from=${from}&to=${day}`).catch(() => null);
      if (!list || asked !== day || !box.isConnected) return;
      box.hidden = false;
      setHtml(box, html`<div class="card-head"><h2>Joylar</h2><span class="muted small">oxirgi 14 kun</span><span class="spacer"></span><a class="small" href="#/joylar">Barchasi</a></div>
        ${list.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Joy</th><th class="num">Reys</th><th>Oxirgi</th></tr></thead>
          <tbody>${list.map((p) => html`<tr><td><a href="#/joylar?place=${p.id}">${p.name}</a></td><td class="num">${p.trips}</td><td class="nowrap">${when(p.lastAt)}</td></tr>`)}</tbody></table></div>`
        : html`<div class="empty">Belgilangan joylarga bormagan</div>`}`);
    }

    function renderLive() {
      const v = state.vehicles.get(id);
      const place = placeAt(v.lat, v.lng);
      setHtml($('#vLive', main), html`${statusHtml(v.status)} <span class="muted small">${ago(v.recordTime)}</span>`);
      setHtml($('#infoCard', main), html`
        <div class="card-head"><h2>Hozirgi holat</h2></div>
        <div class="card-body"><dl class="kv">
          <dt>GPS nomi</dt><dd>${v.gpsName}</dd>
          ${v.plate ? html`<dt>Raqam</dt><dd><span class="plate-chip">${v.plate}</span></dd>` : ''}
          <dt>Holat</dt><dd>${statusHtml(v.status)}${v.status === 'moving' ? ` · ${Math.round(v.speed)} km/soat` : ''}${v.inYard ? ' · hovlida' : ''}</dd>
          ${place ? html`<dt>Joy</dt><dd><b>${place.name}</b></dd>` : ''}
          <dt>Manzil</dt><dd>${v.address || '—'}</dd>
          <dt>Oxirgi signal</dt><dd>${when(v.recordTime)}</dd>
        </dl></div>`);
    }

    async function load() {
      history.replaceState(null, '', `#/transport/${id}?day=${day}`);
      $('#nextDay', main).disabled = day >= today();
      layer.clearLayers();
      closePanelOf(map);
      shownStops = [];
      drawStops();
      setHtml($('#timeline', main), html`<div class="empty">Yuklanmoqda…</div>`);
      const from14 = addDays(day, -13);
      const [trackData, events, days, summary] = await Promise.all([
        get(`/api/vehicles/${id}/track?day=${day}`),
        get(`/api/vehicles/${id}/events?from=${day}&to=${day}`),
        get(`/api/vehicles/${id}/days?from=${from14}&to=${day}`),
        get(`/api/vehicles/${id}/summary?from=${from14}&to=${day}`).catch(() => null), // extra: the page works without it
      ]).catch((e) => { toastError(e); return [null, null, null, null]; });
      track = trackData;
      if (!track) {
        setHtml($('#timeline', main), html`<div class="empty">Yuklab bo'lmadi</div>`);
        return;
      }
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
      shownStops = track.stops;
      drawStops();
      renderPlacesCard();
      setHtml($('#avgTiles', main), periodTiles(summary, from14, day));
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
      items = [
        ...events.gate.filter((g) => g.status !== 'vetoed').map((g) => ({ t: g.t, cls: g.direction, text: html`<b>${g.direction === 'in' ? 'Hovliga kirdi' : 'Hovlidan chiqdi'}</b> <a href="#/darvoza?event=${g.id}" class="small">rasm</a>${g.staySeconds ? html`<div class="small muted">ichkarida ${dur(g.staySeconds)}</div>` : ''}` })),
        ...events.fuel.map((f) => ({ t: f.t, cls: 'fuel', text: html`<b>${f.kind === 'refuel' ? `Yoqilg'i quyildi +${Math.round(f.litres)} L` : `Yoqilg'i to'kildi −${Math.round(f.litres)} L`}</b>` })),
        ...events.alerts.map((a) => ({ t: a.t, cls: '', text: html`${icon('alert')} ${a.title}<div class="small muted">${a.body || ''}</div>` })),
      ];
      renderTimeline();
      const mine = items;
      try {
        const st = await get(`/api/vehicles/${id}/stops?day=${day}`);
        if (mine !== items) return; // another day was chosen meanwhile
        for (const s of st.stops) if ((s.duration || 0) >= 300) items.push({ t: s.start, cls: '', stop: s });
        for (const mv of st.moves) if ((mv.km || 0) >= 1) items.push({ t: mv.start, cls: 'move', text: html`Harakat ${num(mv.km, 1)} km<div class="small muted">${dur(mv.duration)}</div>` });
        renderTimeline();
      } catch { /* GoGPS report optional */ }
    }

    /** A GoGPS stop has no coordinates: it stood where our own samples put the truck in the middle of the stop. */
    function stopName(s) {
      const mid = s.start + ((s.end || s.start) - s.start) / 2;
      let at = null;
      for (const p of track?.points || []) { if (p[0] > mid) break; at = p; }
      return at && at[0] >= s.start - 5 * 60e3 ? nameAt(at[1], at[2]) : null;
    }

    const stopText = (s) => {
      const name = stopName(s);
      return html`To'xtash ${dur(s.duration)}<div class="small muted">${name ? html`<b>${name}</b>` : (s.address || '').split(',').slice(0, 2).join(',')}</div>`;
    };

    function renderTimeline() {
      items.sort((a, b) => a.t - b.t);
      $('#tlCount', main).textContent = `${items.length} ta`;
      setHtml($('#timeline', main), items.length ? html`${items.map((x) => html`<div class="tl-item"><span class="tl-time">${hm(x.t)}</span><span class="tl-dot ${x.cls}"></span><div>${x.stop ? stopText(x.stop) : x.text}</div></div>`)}`
        : html`<div class="empty">${dayLabel(day)}: ma'lumot yo'q</div>`);
    }

    $('#vSel', main).onchange = (e) => { location.hash = `#/transport/${e.target.value}?day=${day}`; };
    $('#vDay', main).onchange = (e) => { day = e.target.value || today(); load(); };
    $('#prevDay', main).onclick = () => { day = addDays(day, -1); $('#vDay', main).value = day; load(); };
    $('#nextDay', main).onclick = () => { if (day < today()) { day = addDays(day, 1); $('#vDay', main).value = day; load(); } };
    const off = state.on('vehicles:changed', (ids) => { if (!ids || ids.includes(id)) renderLive(); });
    // A place changed: new names and counts, without moving the map or reloading the day.
    const offPlaces = state.on('places:changed', () => { renderLive(); drawStops(); renderPlacesCard(); if (items.length) renderTimeline(); });
    renderLive();
    await load();
    return () => { off(); offPlaces(); disposers.forEach((f) => f()); destroy(); };
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
