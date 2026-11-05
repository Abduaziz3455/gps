// Hisobotlar: per-vehicle totals for a day range (dispatchers too), totals row, CSV and print.
// Also exports the date-range control and the per-vehicle table that the Tahlil page reuses.
import { get, qs, state } from '../api.js';
import { $, html, setHtml, icon, num, today, isDay, addDays, dayLabel, toastError, downloadCsv, sortRows, typeIcon, when } from '../ui.js';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// --- the section's tabs ----------------------------------------------------------------------------

const REPORT_TABS = [
  { path: 'tahlil', label: 'Umumiy', owner: true },
  { path: 'hisobot', label: 'Transportlar' },
  { path: 'reyslar', label: 'Reyslar' },
  { path: 'joylar', label: 'Joylar' },
];

/** Tahlil, Hisobot and Joylar are one section of the menu; each stays its own page with its own address. */
export function reportTabs(active) {
  return html`<nav class="tabs no-print" aria-label="Hisobot bo'limlari">${REPORT_TABS.filter((t) => !t.owner || state.isOwner)
    .map((t) => html`<a href="#/${t.path}" aria-current="${t.path === active ? 'page' : 'false'}">${t.label}</a>`)}</nav>`;
}

// --- date range ----------------------------------------------------------------------------------

export const PRESET_LABELS = { today: 'Bugun', yesterday: 'Kecha', d7: '7 kun', d30: '30 kun', month: 'Bu oy', lastMonth: "O'tgan oy" };

export function presetRange(key, t = today()) {
  switch (key) {
    case 'today': return { from: t, to: t };
    case 'yesterday': { const y = addDays(t, -1); return { from: y, to: y }; }
    case 'd7': return { from: addDays(t, -6), to: t };
    case 'd30': return { from: addDays(t, -29), to: t };
    case 'month': return { from: `${t.slice(0, 8)}01`, to: t };
    case 'lastMonth': { const end = addDays(`${t.slice(0, 8)}01`, -1); return { from: `${end.slice(0, 8)}01`, to: end }; }
    default: return { from: t, to: t };
  }
}

/** Range from the URL query (?from=&to=), or the default preset. */
export function rangeFromQuery(query, def) {
  const { from, to } = query || {};
  if (isDay(from) && isDay(to) && from <= to) return { from, to };
  return presetRange(def);
}

/** Rewrite the page's query without re-rendering (replaceState does not fire hashchange). */
export function replaceQuery(path, params) {
  const q = qs(params);
  history.replaceState(history.state, '', `#/${path}${q ? `?${q}` : ''}`);
}

export const rangeText = (r) => (r.from === r.to ? dayLabel(r.from, true) : `${dayLabel(r.from, r.from.slice(0, 4) !== r.to.slice(0, 4))} – ${dayLabel(r.to, true)}`);

/** Preset buttons (.seg) + two date inputs. onChange({from, to}) on every change. */
export function rangeControl(host, { presets, value, onChange }) {
  let cur = { ...value };
  host.classList.add('range');
  setHtml(host, html`
    <div class="seg" role="group" aria-label="Davr">${presets.map((k) => html`<button type="button" data-p="${k}" aria-pressed="false">${PRESET_LABELS[k]}</button>`)}</div>
    <div class="range-dates">
      <input type="date" data-from aria-label="Boshlanish sanasi" />
      <span class="muted" aria-hidden="true">–</span>
      <input type="date" data-to aria-label="Tugash sanasi" />
    </div>`);
  const fromEl = $('[data-from]', host), toEl = $('[data-to]', host);
  const sync = () => {
    const t = today();
    fromEl.value = cur.from; toEl.value = cur.to;
    fromEl.max = toEl.max = t;
    const match = presets.find((k) => { const p = presetRange(k, t); return p.from === cur.from && p.to === cur.to; });
    for (const b of host.querySelectorAll('[data-p]')) b.setAttribute('aria-pressed', String(b.dataset.p === match));
  };
  const set = (r) => {
    if (r.from === cur.from && r.to === cur.to) return;
    cur = r; sync(); onChange({ ...cur });
  };
  host.addEventListener('click', (e) => {
    const b = e.target.closest('[data-p]');
    if (b) set(presetRange(b.dataset.p));
  });
  const onDate = (which) => () => {
    let { from, to } = { from: fromEl.value, to: toEl.value };
    if (!DAY_RE.test(from) || !DAY_RE.test(to)) return;
    if (from > to) { if (which === 'from') to = from; else from = to; }
    set({ from, to });
    sync();
  };
  fromEl.addEventListener('change', onDate('from'));
  toEl.addEventListener('change', onDate('to'));
  sync();
  return { get: () => ({ ...cur }) };
}

// --- per-vehicle table -----------------------------------------------------------------------------

export const VCOLS = [
  { key: 'label', label: 'Transport', text: true },
  { key: 'trips', label: 'Reys', d: 0 },
  { key: 'km', label: 'Km', d: 1 },
  { key: 'engineHours', label: 'Motosoat', d: 1 },
  { key: 'idleShare', label: 'Salt %', d: 0 },
  { key: 'fuelUsed', label: "Yoqilg'i L", d: 1 },
  { key: 'fuelPer100', label: 'L/100 km', d: 1 },
  { key: 'refuelL', label: 'Quyildi L', d: 1 },
  { key: 'drainL', label: "To'kildi L", d: 1 },
  { key: 'maxSpeed', label: 'Max km/s', d: 0, title: 'Eng yuqori tezlik, km/soat' },
  { key: 'turnaroundMin', label: 'Aylanish daq', d: 0, title: "O'rtacha aylanish vaqti (chiqish → keyingi kirish), daqiqa" },
  { key: 'activeDays', label: 'Faol kunlar', d: 0, title: "Kamida 1 reys yoki 5 km bo'lgan kunlar" },
];

const overNorm = (r) => r.fuelNorm && r.fuelPer100 != null && r.fuelPer100 > r.fuelNorm * 1.15;
const sum = (rows, k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

/** Fleet totals for the footer; shares and averages are weighted, not summed. */
export function vehicleTotals(rows) {
  const eh = sum(rows, 'engineHours');
  const idleW = rows.reduce((a, r) => a + (r.idleShare != null ? r.idleShare * (r.engineHours || 0) : 0), 0);
  const fuelRows = rows.filter((r) => r.fuelUsed != null);
  const fuelKm = sum(fuelRows.filter((r) => r.km), 'km');
  const fuel = sum(fuelRows.filter((r) => r.km), 'fuelUsed');
  const ta = rows.filter((r) => r.turnaroundMin != null && r.trips);
  const taN = sum(ta, 'trips');
  const speeds = rows.map((r) => r.maxSpeed).filter((x) => x != null);
  return {
    trips: sum(rows, 'trips'), km: r1(sum(rows, 'km')), engineHours: r1(eh), idleShare: eh ? Math.round(idleW / eh) : null,
    fuelUsed: fuelRows.length ? r1(sum(fuelRows, 'fuelUsed')) : null, fuelPer100: fuelKm ? r1((fuel / fuelKm) * 100) : null,
    refuelL: r1(sum(rows, 'refuelL')), drainL: r1(sum(rows, 'drainL')), maxSpeed: speeds.length ? Math.max(...speeds) : null,
    turnaroundMin: taN ? Math.round(ta.reduce((a, r) => a + r.turnaroundMin * r.trips, 0) / taN) : null,
    activeDays: sum(rows, 'activeDays'), days: rows.length ? (rows[0].days || 0) * rows.length : 0,
  };
}

/**
 * Sortable per-vehicle table inside `host`. Header click sorts (aria-sort), row click opens the vehicle.
 * Returns { set(rows), rows(), csv(name) }.
 */
export function vehicleTable(host, { emptyText = "Bu oraliqda ma'lumot yo'q" } = {}) {
  let data = [];
  let sort = { key: 'trips', dir: 'desc' };

  const cell = (c, r) => {
    if (c.key === 'label') {
      return html`<td><div style="display:flex;align-items:center;gap:8px"><span class="muted">${typeIcon(r.type)}</span><div style="min-width:0">
        <div style="font-weight:650;white-space:nowrap">${r.label}</div>${r.gpsName && r.gpsName !== r.label ? html`<div class="small muted" style="white-space:nowrap">${r.gpsName}</div>` : ''}</div></div></td>`;
    }
    if (c.key === 'activeDays') return html`<td class="num">${num(r.activeDays)}<span class="muted">/${num(r.days)}</span></td>`;
    const v = r[c.key];
    let cls = 'num', title = '';
    if (c.key === 'fuelPer100' && overNorm(r)) { cls += ' warn-cell'; title = `Norma: ${num(r.fuelNorm, 1)} L/100 km (+${Math.round((r.fuelPer100 / r.fuelNorm - 1) * 100)}%)`; }
    if (c.key === 'drainL' && v > 0) { cls += ' warn-cell'; title = "Yoqilg'i to'kilgan"; }
    if (!v) cls += ' zero';
    return html`<td class="${cls}" title="${title || null}">${num(v, c.d)}</td>`;
  };

  const draw = () => {
    if (!data.length) { setHtml(host, html`<div class="empty">${emptyText}</div>`); return; }
    const rows = sortRows(data, sort.key, sort.dir);
    const t = vehicleTotals(data);
    const ariaSort = (c) => (c.key === sort.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
    setHtml(host, html`<div class="table-wrap"><table class="table vtable">
      <thead><tr>${VCOLS.map((c) => html`<th class="sortable${c.text ? '' : ' num'}" data-k="${c.key}" aria-sort="${ariaSort(c)}" tabindex="0" scope="col" title="${c.title || null}">${c.label}</th>`)}</tr></thead>
      <tbody>${rows.map((r) => html`<tr class="clickable" data-id="${r.id}" tabindex="0">${VCOLS.map((c) => cell(c, r))}</tr>`)}</tbody>
      <tfoot><tr>${VCOLS.map((c) => {
        if (c.key === 'label') return html`<td>Jami: ${rows.length} ta</td>`;
        if (c.key === 'activeDays') return html`<td class="num">${num(t.activeDays)}<span class="muted">/${num(t.days)}</span></td>`;
        return html`<td class="num">${num(t[c.key], c.d)}</td>`;
      })}</tr></tfoot>
    </table></div>`);
  };

  const toggle = (key) => {
    if (sort.key === key) sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
    else sort = { key, dir: key === 'label' ? 'asc' : 'desc' };
    draw();
    host.querySelector(`th[data-k="${key}"]`)?.focus();
  };
  const open = (tr) => { location.hash = `#/transport/${tr.dataset.id}`; };
  host.addEventListener('click', (e) => {
    const th = e.target.closest('th.sortable');
    if (th) return toggle(th.dataset.k);
    const tr = e.target.closest('tbody tr[data-id]');
    if (tr) open(tr);
    return undefined;
  });
  host.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const th = e.target.closest('th.sortable');
    const tr = e.target.closest('tbody tr[data-id]');
    if (th) { e.preventDefault(); toggle(th.dataset.k); } else if (tr && e.key === 'Enter') open(tr);
  });

  return {
    set(rows) { data = rows || []; draw(); },
    rows: () => data,
    csv(name) {
      const dec = (v, d) => (v == null ? '' : d ? String(v).replace('.', ',') : String(v));
      const header = ['Transport', 'GPS nomi', ...VCOLS.slice(1).map((c) => c.label), "L/100 km normasi"];
      const rows = sortRows(data, sort.key, sort.dir).map((r) => [r.label, r.gpsName, ...VCOLS.slice(1).map((c) => (c.key === 'activeDays' ? `${r.activeDays}/${r.days}` : dec(r[c.key], c.d))), dec(r.fuelNorm, 1)]);
      const t = vehicleTotals(data);
      rows.push(['Jami', '', ...VCOLS.slice(1).map((c) => (c.key === 'activeDays' ? `${t.activeDays}/${t.days}` : dec(t[c.key], c.d))), '']);
      downloadCsv(name, header, rows);
    },
  };
}

// --- page ------------------------------------------------------------------------------------------

export default {
  async render(main, { query }) {
    let range = rangeFromQuery(query, 'today');
    let seq = 0;
    let alive = true;

    setHtml(main, html`<div class="page report-page">
      ${reportTabs('hisobot')}
      <div class="page-head">
        <div>
          <h2 id="repTitle"></h2>
          <div class="small muted print-only" id="repMade"></div>
        </div>
        <span class="spacer"></span>
        <div id="repRange" class="no-print"></div>
        <div class="no-print" style="display:flex;gap:8px">
          <button class="btn" id="repCsv" type="button">${icon('download')}<span>CSV</span></button>
          <button class="btn" id="repPrint" type="button">${icon('print')}<span>Chop etish</span></button>
        </div>
      </div>
      <div class="card"><div id="repTable"><div class="empty"><div class="spinner" style="margin:auto"></div></div></div></div>
      <p class="small muted no-print" style="margin:0">Qatorni bosing — transport sahifasi ochiladi. Qizil: yoqilg'i to'kilgan yoki sarf normadan 15% dan ko'p.</p>
    </div>`);

    const tableHost = $('#repTable', main);
    const table = vehicleTable(tableHost);

    const load = async () => {
      const my = ++seq;
      $('#repTitle', main).textContent = `Hisobot: ${rangeText(range)}`;
      tableHost.classList.add('is-loading');
      try {
        const rows = await get(`/api/reports/vehicles?${qs(range)}`);
        if (!alive || my !== seq) return;
        table.set(rows);
        $('#repMade', main).textContent = `Tuzildi: ${when(Date.now())} · ${rows.length} ta transport`;
      } catch (e) {
        if (alive && my === seq) toastError(e);
      } finally {
        if (my === seq) tableHost.classList.remove('is-loading');
      }
    };

    rangeControl($('#repRange', main), {
      presets: ['today', 'yesterday', 'd7', 'month', 'lastMonth'],
      value: range,
      onChange: (r) => { range = r; replaceQuery('hisobot', range); load(); },
    });
    $('#repCsv', main).addEventListener('click', () => {
      if (!table.rows().length) return toastError(new Error("Eksport uchun ma'lumot yo'q"));
      return table.csv(`hisobot_${range.from}_${range.to}.csv`);
    });
    $('#repPrint', main).addEventListener('click', () => window.print());

    await load();
    return () => { alive = false; };
  },
};
