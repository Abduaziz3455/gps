// Joylar: the places marked on the map and how many trips (reys) trucks made to each, for any range.
// Everyone reads; the owner changes a place here and marks new ones on a vehicle's track.
/* global L */
import { get, qs, state } from '../api.js';
import { $, $$, html, setHtml, icon, typeIcon, num, dur, when, toastError, downloadCsv } from '../ui.js';
import { createMap } from '../map.js';
import { RADIUS, distanceM, ignoreSpot, placePanel, restoreSpot } from '../places.js';
import { rangeControl, rangeFromQuery, rangeText, replaceQuery, reportTabs } from './reports.js';

const stay = (min) => (min == null ? '—' : dur(min * 60));

export default {
  async render(main, { query }) {
    let range = rangeFromQuery(query, 'd30');
    let rows = [];
    let selected = Number(query.place) || null;
    let seq = 0, alive = true, fitted = false;

    setHtml(main, html`<div class="page">
      ${reportTabs('joylar')}
      <div class="page-head">
        <div class="small muted" id="plRange"></div>
        <span class="spacer"></span>
        <div id="plRangeCtl"></div>
        <button class="btn" id="plCsv" type="button">${icon('download')}<span>CSV</span></button>
      </div>
      <div class="pl-grid">
        <div class="grid" style="gap:16px">
          <section class="card"><div id="plTable"><div class="empty"><div class="spinner" style="margin:auto"></div></div></div></section>
          <section class="card" id="plDetail" hidden></section>
          <section class="card" id="plSuggest" hidden></section>
          <details class="card pl-ignored" id="plIgnored" hidden></details>
        </div>
        <section class="card pl-map-card" id="plMapCard"><div class="pl-map" id="plMap"></div></section>
      </div>
    </div>`);

    const { map, destroy } = createMap($('#plMap', main), { zoom: 11 });
    // Show where it is and keep the surroundings: close enough to see a 150 m circle, no closer.
    const focus = (p) => map.setView([p.lat, p.lng], Math.max(map.getZoom(), 13));
    const fitAll = () => {
      if (!state.places.length) return;
      map.fitBounds(L.latLngBounds(state.places.map((p) => [p.lat, p.lng])).pad(0.2), { maxZoom: 14 });
    };

    const remember = () => replaceQuery('joylar', { ...range, place: selected });

    const drawTable = () => {
      setHtml($('#plTable', main), rows.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Joy</th><th class="num">Reys</th><th class="num">Transport</th><th class="num">O'rtacha turish</th><th>Oxirgi</th></tr></thead>
        <tbody>${rows.map((p) => html`<tr class="clickable${p.id === selected ? ' pl-selected' : ''}" data-id="${p.id}" tabindex="0">
          <td><b>${p.name}</b><div class="small muted">${num(p.radiusM)} m radius</div></td>
          <td class="num">${p.computing ? html`<span class="muted small">hisoblanmoqda…</span>` : p.trips}</td>
          <td class="num">${p.computing ? '' : p.vehicles}</td>
          <td class="num">${p.computing ? '' : stay(p.avgStayMin)}</td>
          <td class="nowrap">${p.lastAt ? when(p.lastAt) : '—'}</td></tr>`)}</tbody></table></div>`
        : html`<div class="empty">Hali joy belgilanmagan.<br>${state.isOwner ? html`Transport sahifasida xaritadagi to'xtash nuqtasini bosing: <a href="#/transport">Transport</a>` : 'Joylarni rahbar belgilaydi.'}</div>`);
    };

    const drawDetail = async () => {
      const box = $('#plDetail', main);
      const p = rows.find((x) => x.id === selected);
      if (!p) { box.hidden = true; return; }
      box.hidden = false;
      const my = ++seq;
      try {
        const list = await get(`/api/places/${p.id}/vehicles?${qs(range)}`);
        if (!alive || my !== seq) return;
        setHtml(box, html`<div class="card-head"><h3>${p.name}</h3><span class="small muted">qaysi transport necha marta</span><span class="spacer"></span>
          ${state.isOwner ? html`<button class="btn btn-sm" id="plEdit" type="button">Tahrirlash</button>` : ''}</div>
          ${list.length ? html`<div class="table-wrap"><table class="table">
            <thead><tr><th>Transport</th><th class="num">Reys</th><th class="num">O'rtacha turish</th><th>Oxirgi</th></tr></thead>
            <tbody>${list.map((v) => html`<tr class="clickable" data-v="${v.id}"><td class="nowrap">${typeIcon(v.type)} <b>${v.label}</b></td><td class="num">${v.trips}</td><td class="num">${stay(v.avgStayMin)}</td><td class="nowrap">${when(v.lastAt)}</td></tr>`)}</tbody>
          </table></div>` : html`<div class="empty">${rangeText(range)}: bu joyga transport bormagan</div>`}`);
        const edit = $('#plEdit', box);
        if (edit) edit.onclick = () => placePanel({ host: $('#plMapCard', main), map, lat: p.lat, lng: p.lng, place: p });
      } catch (e) { if (alive && my === seq) toastError(e); }
    };

    /** Spots trucks often stop at: the owner looks at one on this map, then names it or says it doesn't matter. */
    let preview = null;
    const clearPreview = () => { preview?.remove(); preview = null; };
    const yardKm = (c) => { const y = state.me.yard; return `${num(distanceM(c.lat, c.lng, y.lat, y.lng) / 1000, 1)} km`; };
    const drawSuggestions = () => {
      clearPreview();
      const box = $('#plSuggest', main);
      const list = state.commonPlaces;
      box.hidden = !list.length;
      if (!list.length) return;
      setHtml(box, html`<div class="card-head"><h3>Tavsiya etilgan joylar</h3><span class="small muted">qatorni bosing: joy xaritada ko'rinadi</span></div>
        <div class="table-wrap"><table class="table"><thead><tr><th class="num">Tashrif</th><th class="num">Transport</th><th class="num">Hovlidan</th><th></th></tr></thead>
        <tbody>${list.map((c, i) => html`<tr class="clickable" data-c="${i}" tabindex="0"><td class="num"><b>${c.visits}</b> marta</td><td class="num">${c.vehicles}</td><td class="num nowrap">${yardKm(c)}</td>
          <td class="right nowrap"><button class="btn btn-sm btn-ghost" type="button" data-ignore>E'tiborsiz qoldirish</button> <button class="btn btn-sm" type="button" data-name>Nomlash</button></td></tr>`)}</tbody></table></div>`);
    };

    /** The spots the owner ignored, folded away: only the owner has it, and only when there are some. */
    const drawIgnored = () => {
      const box = $('#plIgnored', main);
      const list = state.ignoredPlaces;
      box.hidden = !list.length;
      if (!list.length) { box.open = false; return; }
      const count = (v) => (v == null ? '—' : v);
      setHtml(box, html`<summary>E'tiborsiz qoldirilganlar (${list.length})</summary>
        <p class="small muted pl-ignored-note">Transportlar bu yerga qatnashda davom etsa, 7 kundan keyin o'zi yana taklif qilinadi.</p>
        <div class="table-wrap"><table class="table"><thead><tr><th class="num">Tashrif</th><th class="num">Transport</th><th class="num">Hovlidan</th><th>Qachon</th><th></th></tr></thead>
        <tbody>${list.map((c, i) => html`<tr class="clickable" data-ig="${i}"><td class="num"><b>${count(c.visits)}</b> marta</td><td class="num">${count(c.vehicles)}</td><td class="num nowrap">${yardKm(c)}</td><td class="nowrap">${c.at ? when(c.at) : '—'}</td>
          <td class="right"><button class="btn btn-sm" type="button" data-restore>Qaytarish</button></td></tr>`)}</tbody></table></div>`);
    };

    const showSpot = (c, row) => {
      for (const r of $$('tr[data-c], tr[data-ig]', main)) r.classList.toggle('pl-selected', r === row);
      clearPreview();
      preview = L.circle([c.lat, c.lng], { radius: RADIUS.def, className: 'place-draft', interactive: false }).addTo(map);
      focus({ ...c, radiusM: RADIUS.def });
    };

    const load = async () => {
      drawSuggestions();
      drawIgnored();
      $('#plRange', main).textContent = rangeText(range);
      try {
        rows = await get(`/api/places/stats?${qs(range)}`);
        if (!alive) return;
        if (selected && !rows.some((p) => p.id === selected)) { selected = null; remember(); }
        drawTable();
        await drawDetail();
      } catch (e) { if (alive) toastError(e); }
    };

    const select = (id) => {
      selected = id;
      remember();
      drawTable();
      drawDetail();
      const p = rows.find((x) => x.id === id);
      if (p) focus(p);
    };

    rangeControl($('#plRangeCtl', main), {
      presets: ['today', 'yesterday', 'd7', 'd30', 'month'],
      value: range,
      onChange: (r) => { range = r; remember(); load(); },
    });
    $('#plCsv', main).addEventListener('click', () => {
      if (!rows.length) return toastError(new Error("Eksport uchun ma'lumot yo'q"));
      return downloadCsv(`joylar_${range.from}_${range.to}.csv`, ['Joy', 'Radius, m', 'Reys', 'Transport', "O'rtacha turish, daq"],
        rows.map((p) => [p.name, p.radiusM, p.trips, p.vehicles, p.avgStayMin ?? '']));
    });
    const table = $('#plTable', main);
    table.addEventListener('click', (e) => { const r = e.target.closest('tr[data-id]'); if (r) select(Number(r.dataset.id)); });
    table.addEventListener('keydown', (e) => { const r = e.target.closest('tr[data-id]'); if (r && e.key === 'Enter') select(Number(r.dataset.id)); });
    $('#plDetail', main).addEventListener('click', (e) => { const r = e.target.closest('tr[data-v]'); if (r) location.hash = `#/transport/${r.dataset.v}`; });

    $('#plSuggest', main).addEventListener('click', async (e) => {
      const row = e.target.closest('tr[data-c]');
      const c = row && state.commonPlaces[Number(row.dataset.c)];
      if (!c) return;
      if (e.target.closest('[data-ignore]')) {
        try { await ignoreSpot(c.lat, c.lng); } catch (ex) { toastError(ex); }
      } else if (e.target.closest('[data-name]')) {
        clearPreview();
        placePanel({ host: $('#plMapCard', main), map, lat: c.lat, lng: c.lng, common: c, note: `${c.days} kunda ${c.vehicles} ta transport ${c.visits} marta to'xtagan` });
      } else showSpot(c, row);
    });
    $('#plIgnored', main).addEventListener('click', async (e) => {
      const row = e.target.closest('tr[data-ig]');
      const c = row && state.ignoredPlaces[Number(row.dataset.ig)];
      if (!c) return;
      if (e.target.closest('[data-restore]')) {
        try { await restoreSpot(c.lat, c.lng); } catch (ex) { toastError(ex); }
      } else showSpot(c, row);
    });
    $('#plSuggest', main).addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('tr[data-c]')) e.target.click(); });

    const off = state.on('places:changed', () => load());
    await load();
    if (alive && !fitted) {
      fitted = true;
      const p = rows.find((x) => x.id === selected);
      if (p) focus(p); else fitAll();
    }
    return () => { alive = false; off(); destroy(); };
  },
};
