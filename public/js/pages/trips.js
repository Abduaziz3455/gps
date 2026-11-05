// Reyslar: one row per trip. Left the yard, where it went, when it came back, km, fuel. A row opens the gate photos and stops.
import { get, qs, state } from '../api.js';
import { $, $$, html, setHtml, icon, typeIcon, num, dur, hm, hms, when, dayLabel, modal, lightbox, toastError, downloadCsv, debounce } from '../ui.js';
import { rangeControl, rangeFromQuery, rangeText, replaceQuery, reportTabs } from './reports.js';

const SRC = { gps: 'GPS bo\'yicha', camera: 'Kamera bo\'yicha' };

/** The city and country every GPS address ends with say nothing here. */
export function shortAddress(a) {
  if (!a) return '';
  for (const tail of [', Ташкент, Узбекистан', ', Узбекистан']) {
    if (a.endsWith(tail) && a !== tail.slice(2)) return a.slice(0, -tail.length);
  }
  return a;
}

const destText = (d) => (d ? d.name || shortAddress(d.address) || "Manzil noma'lum" : '');
const kmText = (t) => (t.km == null ? '—' : `${t.kmSrc === 'positions' ? '≈' : ''}${num(t.km, 1)}`);

export default {
  async render(main, { query }) {
    let range = rangeFromQuery(query, 'today');
    let vehicle = Number(query.vehicle) || null;
    let place = Number(query.place) || null;
    let near = query.near === '1';
    let data = { trips: [], totals: {}, destinations: [], nearCount: 0 };
    let seq = 0, alive = true;

    setHtml(main, html`<div class="page report-page">
      ${reportTabs('reyslar')}
      <div class="page-head">
        <div><h2 id="trTitle"></h2><div class="small muted print-only" id="trMade"></div></div>
        <span class="spacer"></span>
        <div id="trRange" class="no-print"></div>
        <div class="no-print" style="display:flex;gap:8px">
          <button class="btn" id="trCsv" type="button">${icon('download')}<span>CSV</span></button>
          <button class="btn" id="trPrint" type="button">${icon('print')}<span>Chop etish</span></button>
        </div>
      </div>
      <div class="form-row no-print tr-filters">
        <label class="field"><span>Transport</span><select id="trVehicle"></select></label>
        <label class="field"><span>Joy</span><select id="trPlace"></select></label>
        <label class="check small"><input type="checkbox" id="trNear" /> <span id="trNearText"></span></label>
      </div>
      <div class="tiles" id="trTiles"></div>
      <section class="card"><div id="trTable"><div class="empty"><div class="spinner" style="margin:auto"></div></div></div></section>
      <section class="card no-print" id="trDest" hidden></section>
      <p class="small muted no-print" style="margin:0">Reys hovlidan chiqqandan qaytib kelgangacha hisoblanadi: GPS bor bo'lsa uning vaqti, bo'lmasa kamera vaqti.
        Shu sababli "Transportlar" bo'limidagi reys soni (faqat kameralar bo'yicha) bundan farq qilishi mumkin. ≈ — taxminiy masofa: GPS hisoboti hali kelmagan.</p>
    </div>`);

    const table = $('#trTable', main);

    const remember = () => replaceQuery('reyslar', { ...range, vehicle, place, near: near ? 1 : null });

    const drawFilters = () => {
      const vs = [...state.vehicles.values()].sort((a, b) => a.label.localeCompare(b.label));
      setHtml($('#trVehicle', main), html`<option value="">Hammasi</option>${vs.map((v) => html`<option value="${v.id}" ${v.id === vehicle ? 'selected' : ''}>${v.label}</option>`)}`);
      setHtml($('#trPlace', main), html`<option value="">Hammasi</option>${state.places.map((p) => html`<option value="${p.id}" ${p.id === place ? 'selected' : ''}>${p.name}</option>`)}`);
      $('#trNear', main).checked = near;
    };

    const manyDays = () => range.from !== range.to;
    const timeText = (ms) => (manyDays() ? when(ms) : hm(ms));
    const startCell = (t) => (t.startT ? html`<span title="${SRC[t.startSrc] || ''}">${timeText(t.startT)}</span>` : html`<span class="muted">qayd etilmagan</span>`);
    const endCell = (t) => {
      if (t.endT) return html`<span title="${SRC[t.endSrc] || ''}">${t.day === new Date(t.endT).toLocaleDateString('en-CA', { timeZone: 'Asia/Tashkent' }) ? hm(t.endT) : when(t.endT)}</span>`;
      return t.state === 'open' ? html`<span class="pill info">Yo'lda</span>` : html`<span class="muted">qayd etilmagan</span>`;
    };
    const destCell = (t) => {
      if (t.near) return html`<span class="pill">Hovli yonida</span>`;
      if (!t.destination) return t.state === 'done' ? html`<span class="muted">to'xtamagan</span>` : html`<span class="muted">—</span>`;
      const d = t.destination;
      return html`${d.name ? html`<b>${d.name}</b>` : html`<span>${destText(d)}</span>`} <span class="muted small nowrap">${dur(d.seconds)}</span>`;
    };

    const draw = () => {
      const { trips, totals: x, destinations, nearCount } = data;
      setHtml($('#trTiles', main), html`
        <div class="tile"><span class="tile-label">Reyslar</span><span class="tile-value" id="trCount">${x.trips ?? 0}</span><span class="tile-sub">${x.vehicles ?? 0} ta transport</span></div>
        <div class="tile"><span class="tile-label">Masofa</span><span class="tile-value">${num(x.km, 0)}</span><span class="tile-sub">km</span></div>
        <div class="tile"><span class="tile-label">O'rtacha reys</span><span class="tile-value">${x.avgDurationS != null ? dur(x.avgDurationS) : '—'}</span><span class="tile-sub">${x.complete ?? 0} ta to'liq reys</span></div>
        <div class="tile"><span class="tile-label">Yoqilg'i</span><span class="tile-value">${x.fuelUsed != null ? num(x.fuelUsed, 0) : '—'}</span><span class="tile-sub">L, datchigi borlar</span></div>`);
      $('#trNearText', main).textContent = `Hovli yonidagilar ham (${nearCount})`;
      setHtml(table, trips.length ? html`<div class="table-wrap"><table class="table" id="trRows">
        <thead><tr><th>Transport</th>${manyDays() ? html`<th>Kun</th>` : ''}<th>Chiqdi</th><th>Qaytdi</th><th class="num tr-m-hide">Vaqt</th><th class="num">Km</th><th class="num tr-m-hide">Yoqilg'i, L</th><th>Qayerga</th></tr></thead>
        <tbody>${trips.map((t) => html`<tr class="clickable${t.near ? ' muted' : ''}" data-id="${t.id}" data-state="${t.state}" tabindex="0">
          <td class="nowrap"><span class="muted">${typeIcon(t.type)}</span> <b>${t.label}</b></td>
          ${manyDays() ? html`<td class="nowrap">${dayLabel(t.day)}</td>` : ''}
          <td class="nowrap">${startCell(t)}</td><td class="nowrap">${endCell(t)}</td>
          <td class="num nowrap tr-m-hide">${t.durationS != null ? dur(t.durationS) : '—'}</td>
          <td class="num">${kmText(t)}</td>
          <td class="num tr-m-hide${t.drainL > 0 ? ' warn-cell' : ''}">${t.fuelUsed != null ? num(t.fuelUsed, 1) : '—'}</td>
          <td>${destCell(t)}</td></tr>`)}</tbody>
      </table></div>${data.truncated ? html`<div class="small muted card-body">Ro'yxat juda uzun: faqat oxirgilari ko'rsatildi. Oraliqni qisqartiring.</div>` : ''}`
        : html`<div class="empty">${rangeText(range)}: reys yo'q</div>`);
      const box = $('#trDest', main);
      box.hidden = !destinations.length;
      if (destinations.length) {
        setHtml(box, html`<div class="card-head"><h3>Qayerga ko'p borilgan</h3>${state.isOwner && destinations.some((d) => !d.placeId) ? html`<span class="small muted">Manzilni nomlash uchun: Transport sahifasi → xaritadagi to'xtash nuqtasi</span>` : ''}</div>
          <div class="table-wrap"><table class="table"><thead><tr><th>Joy</th><th class="num">Reys</th><th class="num">Transport</th><th class="num">O'rtacha km</th><th class="num">O'rtacha turish</th></tr></thead>
          <tbody>${destinations.map((d) => html`<tr><td>${d.name ? html`<b>${d.name}</b>` : shortAddress(d.address) || "Manzil noma'lum"}</td><td class="num">${d.trips}</td><td class="num">${d.vehicles}</td><td class="num">${num(d.avgKm, 1)}</td><td class="num nowrap">${dur(d.avgStayMin * 60)}</td></tr>`)}</tbody></table></div>`);
      }
    };

    const load = async () => {
      const my = ++seq;
      $('#trTitle', main).textContent = `Reyslar: ${rangeText(range)}`;
      table.classList.add('is-loading');
      try {
        const r = await get(`/api/trips?${qs({ ...range, vehicle, place, near: near ? 1 : null })}`);
        if (!alive || my !== seq) return;
        data = r;
        draw();
        $('#trMade', main).textContent = `Tuzildi: ${when(Date.now())} · ${r.totals.trips} ta reys`;
      } catch (e) {
        if (alive && my === seq) toastError(e);
      } finally {
        if (my === seq) table.classList.remove('is-loading');
      }
    };

    const openTrip = async (id) => {
      const t = data.trips.find((x) => x.id === id);
      if (!t) return;
      const events = await Promise.all([t.outEventId, t.inEventId].map((e) => (e ? get(`/api/gate-events/${e}`).catch(() => null) : null)));
      const [evOut, evIn] = events;
      const side = (title, ev) => (ev ? html`<div><h4 class="tr-side">${title} · ${hms(ev.t)}</h4><div class="photos">${ev.photos.map((p) => html`<figure><img src="${p.url}" alt="${p.name}"><figcaption>${p.name}</figcaption></figure>`)}</div></div>`
        : html`<div><h4 class="tr-side">${title}</h4><div class="empty small">Kamera yozuvi yo'q</div></div>`);
      const stops = t.stops.filter((s) => !s.atYard);
      const day = t.day;
      const m = modal({
        title: `${t.label}: ${dayLabel(day)}`,
        body: html`
          <dl class="kv">
            <dt>Chiqdi</dt><dd>${t.startT ? html`${when(t.startT)} <span class="muted small">${SRC[t.startSrc] || ''}</span>` : 'qayd etilmagan'}</dd>
            <dt>Qaytdi</dt><dd>${t.endT ? html`${when(t.endT)} <span class="muted small">${SRC[t.endSrc] || ''}</span>` : t.state === 'open' ? "Hali yo'lda" : 'qayd etilmagan'}</dd>
            ${t.durationS != null ? html`<dt>Vaqt</dt><dd>${dur(t.durationS)}</dd>` : ''}
            <dt>Masofa</dt><dd>${t.km != null ? html`${kmText(t)} km${t.kmSrc === 'positions' ? html` <span class="muted small">taxminiy</span>` : ''}` : "ma'lumot yo'q"}</dd>
            ${t.fuelUsed != null ? html`<dt>Yoqilg'i</dt><dd>${num(t.fuelUsed, 1)} L</dd>` : ''}
            ${t.refuelL > 0 ? html`<dt>Quyildi</dt><dd>${num(t.refuelL, 1)} L</dd>` : ''}
            ${t.drainL > 0 ? html`<dt>To'kildi</dt><dd class="warn-cell">${num(t.drainL, 1)} L</dd>` : ''}
            ${t.near ? html`<dt>Eslatma</dt><dd>Hovli yonida qolgan: yetkazib berish emas</dd>` : ''}
          </dl>
          ${stops.length ? html`<h4 class="tr-side">To'xtashlar</h4><div class="table-wrap"><table class="table" id="trStops"><tbody>${stops.map((s) => html`<tr><td class="nowrap">${hm(s.startT)}–${hm(s.endT)}</td><td class="num nowrap">${dur(s.seconds)}</td><td>${s.place ? html`<b>${s.place.name}</b>` : shortAddress(s.address) || "Manzil noma'lum"}</td></tr>`)}</tbody></table></div>` : ''}
          <div class="grid grid-2 tr-photos">${side('Chiqish kamerasi', evOut)}${side('Kirish kamerasi', evIn)}</div>`,
        foot: html`<a class="btn" href="#/transport/${t.vehicleId}?day=${day}">${icon('map')}<span>Xaritada ko'rish</span></a><span style="flex:1"></span><button class="btn" data-close>Yopish</button>`,
      });
      $$('.photos img', m.el).forEach((img) => img.addEventListener('click', () => lightbox(img.src)));
      $$('a.btn', m.el).forEach((a) => a.addEventListener('click', () => m.close()));
    };

    rangeControl($('#trRange', main), {
      presets: ['today', 'yesterday', 'd7', 'month', 'lastMonth'],
      value: range,
      onChange: (r) => { range = r; remember(); load(); },
    });
    $('#trVehicle', main).addEventListener('change', (e) => { vehicle = Number(e.target.value) || null; remember(); load(); });
    $('#trPlace', main).addEventListener('change', (e) => { place = Number(e.target.value) || null; remember(); load(); });
    $('#trNear', main).addEventListener('change', (e) => { near = e.target.checked; remember(); load(); });
    $('#trPrint', main).addEventListener('click', () => window.print());
    $('#trCsv', main).addEventListener('click', () => {
      if (!data.trips.length) return toastError(new Error("Eksport uchun ma'lumot yo'q"));
      const dec = (v) => (v == null ? '' : String(v).replace('.', ','));
      return downloadCsv(`reyslar_${range.from}_${range.to}.csv`,
        ['Kun', 'Transport', 'GPS nomi', 'Chiqdi', 'Qaytdi', 'Vaqt, daq', 'Km', "Yoqilg'i, L", 'Quyildi, L', "To'kildi, L", 'Qayerga', 'Turish, daq', 'Holat'],
        data.trips.map((t) => [t.day, t.label, t.gpsName, t.startT ? when(t.startT) : '', t.endT ? when(t.endT) : '', t.durationS != null ? Math.round(t.durationS / 60) : '', dec(t.km), dec(t.fuelUsed), dec(t.refuelL), dec(t.drainL),
          destText(t.destination), t.destination ? Math.round(t.destination.seconds / 60) : '', t.near ? 'Hovli yonida' : { done: "To'liq", open: "Yo'lda", no_exit: 'Chiqishi qayd etilmagan', no_return: 'Qaytishi qayd etilmagan' }[t.state]]));
    });
    const onRow = (e) => { const r = e.target.closest('tr[data-id]'); if (r) openTrip(Number(r.dataset.id)).catch(toastError); };
    table.addEventListener('click', onRow);
    table.addEventListener('keydown', (e) => { if (e.key === 'Enter') onRow(e); });

    const soon = debounce(() => { if (alive) load(); }, 1500);
    const offs = [state.on('trips', soon), state.on('places:changed', () => { drawFilters(); soon(); }), state.on('vehicles', () => drawFilters())];
    drawFilters();
    await load();
    return () => { alive = false; offs.forEach((o) => o()); };
  },
};
