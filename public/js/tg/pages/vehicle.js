// Mashina: one truck now (status, where, signal) and its day: numbers, track, trips, passes, fuel.
/* global L */
import { get, qs, state } from '../../api.js';
import { html, icon, setHtml, typeIcon, num, ago, hm, dur, today, addDays, dayLabel, STATUS, debounce } from '../../ui.js';
import { createMap, VehicleLayer } from '../../map.js';
import { eventRow, whereText, seg, wireSeg, timeRange } from '../parts.js';
import * as tg from '../telegram.js';

export default {
  async render(host, { params, query, setTitle }) {
    const id = Number(params[0]);
    let day = query.day === 'kecha' ? addDays(today(), -1) : today();
    const live = () => state.vehicles.get(id);
    if (!live()) {
      setHtml(host, html`<div class="tg-empty">Bu transport ro'yxatda yo'q</div>`);
      return null;
    }
    setTitle(live().label);

    setHtml(host, html`
      <section class="tg-card" data-now></section>
      ${seg([{ id: 'bugun', label: 'Bugun' }, { id: 'kecha', label: 'Kecha' }], day === today() ? 'bugun' : 'kecha')}
      <div class="tg-tiles three" data-nums></div>
      <div class="tg-minimap" data-map></div>
      <section class="tg-section"><h2 class="tg-h">Reyslar</h2><div data-trips></div></section>
      <section class="tg-section"><h2 class="tg-h">Darvozadan o'tishlar</h2><div data-gate></div></section>
      <section class="tg-section" data-fuel-box hidden><h2 class="tg-h">Yoqilg'i</h2><div data-fuel></div></section>`);
    const $ = (s) => host.querySelector(s);

    const drawNow = () => {
      const v = live();
      if (!v) return;
      setHtml($('[data-now]'), html`
        <div class="tg-sheet-head"><span class="tg-veh-icon ${v.status}">${typeIcon(v.type)}</span><div><b class="plate">${v.label}</b>
          <div class="small"><span class="status ${v.status}">${STATUS[v.status]}</span>${v.status === 'moving' ? ` · ${num(v.speed)} km/soat` : ''}${v.inYard ? ' · hovlida' : ''}</div></div></div>
        <div class="small">${icon('pin')} ${whereText(v) || "Joy noma'lum"}</div>
        <div class="small muted">Signal: ${ago(v.recordTime)}${v.gpsName && v.gpsName !== v.label ? ` · GPS'da: ${v.gpsName}` : ''}${v.cameraOnly ? ' · GPS trekeri yo\'q' : ''}</div>
        ${v.lat != null ? html`<div class="tg-actions row"><button class="btn tg-big" type="button" data-nav="y">Yandex</button><button class="btn tg-big" type="button" data-nav="g">Google</button></div>` : ''}`);
    };

    // The map: the day's track, its stops, and the truck where it is now.
    const { map, destroy } = createMap($('[data-map]'), { editPlaces: false, zoom: 13 });
    const trackLayer = L.layerGroup().addTo(map);
    const layer = new VehicleLayer(map, { filter: (v) => v.id === id });
    layer.select(id);

    const load = async () => {
      const range = qs({ from: day, to: day });
      const [days, track, trips, events] = await Promise.all([
        get(`/api/vehicles/${id}/days?${range}`),
        get(`/api/vehicles/${id}/track?${qs({ day })}`),
        get(`/api/trips?${qs({ from: day, to: day, vehicle: id })}`),
        get(`/api/vehicles/${id}/events?${range}`),
      ]);
      const d = days.find((x) => x.day === day) || {};
      setHtml($('[data-nums]'), html`
        <div class="tg-tile"><span class="tile-label">${icon('out')} Reys</span><b>${d.trips ?? 0}</b></div>
        <div class="tg-tile"><span class="tile-label">${icon('route')} Masofa</span><b>${num(d.km ?? 0)}<small> km</small></b></div>
        <div class="tg-tile"><span class="tile-label">${icon('clock')} Motor</span><b>${num(d.engineHours ?? 0, 1)}<small> soat</small></b></div>
        ${d.fuelUsed != null ? html`<div class="tg-tile"><span class="tile-label">${icon('fuel')} Sarf</span><b>${num(d.fuelUsed)}<small> L</small></b></div>` : ''}
        ${d.refuelL ? html`<div class="tg-tile"><span class="tile-label">${icon('fuel')} Quyildi</span><b>${num(d.refuelL)}<small> L</small></b></div>` : ''}
        ${d.drainL ? html`<div class="tg-tile bad"><span class="tile-label">${icon('alert')} To'kildi</span><b>${num(d.drainL)}<small> L</small></b></div>` : ''}`);

      trackLayer.clearLayers();
      const pts = track.points.map((p) => [p[1], p[2]]);
      if (pts.length > 1) L.polyline(pts, { color: '#2a78d6', weight: 4, opacity: 0.85 }).addTo(trackLayer);
      for (const s of track.stops) {
        L.marker([s.lat, s.lng], { icon: L.divIcon({ className: '', html: '<div class="stop-marker"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }), keyboard: false })
          .bindTooltip(`${timeRange(s.start, s.end)} · ${dur(((s.end || Date.now()) - s.start) / 1000)}`).addTo(trackLayer);
      }
      layer.sync();
      const v = live();
      const all = v?.lat != null && day === today() ? [...pts, [v.lat, v.lng]] : pts;
      if (all.length) map.fitBounds(L.latLngBounds(all), { padding: [24, 24], maxZoom: 15, animate: false });
      else if (v?.lat != null) map.setView([v.lat, v.lng], 14);

      const tripRow = (t) => {
        const to = t.destination ? t.destination.name || t.destination.address || '' : '';
        return html`<div class="tg-trip">
          <span class="tg-trip-time">${t.startT ? hm(t.startT) : '?'}–${t.endT ? hm(t.endT) : t.state === 'open' ? html`<span class="pill info">yo'lda</span>` : '?'}</span>
          <span class="tg-trip-main">${to || html`<span class="muted">${t.near ? 'zavod yonida' : 'manzil aniqlanmadi'}</span>`}
            <span class="small muted">${t.km != null ? `${num(t.km, 1)} km` : ''}${t.durationS ? ` · ${dur(t.durationS)}` : ''}${t.fuelUsed != null ? ` · ${num(t.fuelUsed)} L` : ''}</span></span>
          ${t.outEventId ? html`<a class="tg-trip-ev" href="#/e/${t.outEventId}" aria-label="Chiqish rasmi">${icon('camera')}</a>` : ''}
        </div>`;
      };
      setHtml($('[data-trips]'), trips.trips.length ? html`<div class="tg-list">${trips.trips.map(tripRow)}</div>` : html`<div class="tg-empty">Reys yo'q</div>`);
      const passes = events.gate.filter((g) => g.status !== 'vetoed');
      setHtml($('[data-gate]'), passes.length ? html`<div class="tg-list">${passes.map(eventRow)}</div>` : html`<div class="tg-empty">O'tish yo'q</div>`);
      $('[data-fuel-box]').hidden = !events.fuel.length;
      setHtml($('[data-fuel]'), html`<div class="tg-list">${events.fuel.map((f) => html`<div class="tg-trip"><span class="tg-trip-time">${hm(f.t)}</span>
        <span class="tg-trip-main">${f.kind === 'drain' ? html`<b class="bad-text">To'kildi −${num(f.litres)} L</b>` : `Quyildi +${num(f.litres)} L`}</span></div>`)}</div>`);
    };

    drawNow();
    await load();

    wireSeg(host, (v) => {
      day = v === 'kecha' ? addDays(today(), -1) : today();
      history.replaceState(null, '', `#/v/${id}${v === 'kecha' ? '?day=kecha' : ''}`);
      load().catch(() => {});
    });
    host.addEventListener('click', (e) => {
      const b = e.target.closest('[data-nav]');
      const v = live();
      if (!b || v?.lat == null) return;
      tg.openLink(b.dataset.nav === 'y' ? `https://yandex.uz/maps/?pt=${v.lng.toFixed(6)},${v.lat.toFixed(6)}&z=16&l=map`
        : `https://www.google.com/maps/search/?api=1&query=${v.lat.toFixed(6)},${v.lng.toFixed(6)}`);
    });

    const reload = debounce(() => { if (day === today()) load().catch(() => {}); }, 1500);
    const offs = [
      state.on('vehicles:changed', (ids) => { if (!ids || ids.includes(id)) { drawNow(); layer.sync([id]); } }),
      state.on('trips', reload),
      state.on('gate', (ev) => { if (ev.vehicleId === id) reload(); }),
      state.on('gate:update', (ev) => { if (ev.vehicleId === id) reload(); }),
    ];
    return () => { offs.forEach((off) => off()); destroy(); };
  },
};
