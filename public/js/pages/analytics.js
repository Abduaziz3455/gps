// Tahlil (owner): the few numbers an owner checks at a glance. Four headline numbers against the previous
// period, one daily chart, a short "needs attention" list, and vehicles ranked by trips. The full per-vehicle
// table lives in Hisobot. The chosen period is kept in the URL (#/tahlil?from=&to=).
import { get, qs } from '../api.js';
import { $, html, setHtml, icon, typeIcon, esc, num, dayLabel, shortDay, toastError } from '../ui.js';
import { barChart, responsive } from '../charts.js';
import { presetRange, rangeFromQuery, replaceQuery, rangeText, reportTabs, PRESET_LABELS } from './reports.js';

const PRESETS = ['today', 'd7', 'd30', 'month'];

// good: 1 = more is better, -1 = less is better. pp: change in percentage points (for shares).
const KPIS = [
  { k: 'trips', label: 'Reyslar', good: 1 },
  { k: 'km', label: 'Masofa', unit: 'km', good: 1 },
  { k: 'fuelUsed', label: "Yoqilg'i", unit: 'L', good: -1, sub: (c) => (c.fuelPer100 != null ? `${num(c.fuelPer100, 1)} L/100 km` : '') },
  { k: 'utilization', label: 'Foydalanish', unit: '%', pp: true, good: 1 },
];

function delta(cur, prev, { pp, good }) {
  if (cur == null || prev == null) return '';
  let d;
  if (pp) d = cur - prev;
  else if (prev === 0) return '';
  else d = ((cur - prev) / Math.abs(prev)) * 100;
  if (Math.abs(d) < 0.5) return html`<span class="delta flat">o'zgarmadi</span>`;
  const cls = (d > 0) === (good > 0) ? 'up' : 'down';
  return html`<span class="delta ${cls}">${d > 0 ? '▲' : '▼'} ${num(Math.abs(d))}${pp ? ' p.p.' : '%'}</span>`;
}

function tile(def, cur, prev) {
  const v = cur[def.k];
  return html`<div class="tile">
    <div class="tile-label">${def.label}</div>
    <div class="tile-value">${v == null ? '—' : num(v)}${v != null && def.unit ? html`<small>${def.unit}</small>` : ''}</div>
    <div class="tile-sub">${delta(v, prev[def.k], def)} ${def.sub?.(cur) || ''}</div>
  </div>`;
}

/** Only what needs a look; empty means all is well. */
function attention(c, vehicles) {
  const items = [];
  if (c.drains) items.push({ sev: 'bad', text: `Yoqilg'i to'kildi: ${c.drains} marta, jami ${num(c.drainL)} L`, href: '#/ogohlantirish?state=all&type=fuel_drain' });
  const over = vehicles.filter((v) => v.fuelNorm && v.fuelPer100 > v.fuelNorm * 1.15);
  if (over.length) items.push({ sev: 'warn', text: `Yoqilg'i normadan ko'p: ${over.map((v) => v.label).join(', ')}` });
  const idle = vehicles.filter((v) => !v.trips && v.km < 5);
  if (idle.length) items.push({ sev: '', text: `Ishlamagan: ${idle.length} ta transport (${idle.slice(0, 4).map((v) => v.label).join(', ')}${idle.length > 4 ? '…' : ''})` });
  if (c.outsideVisits) items.push({ sev: '', text: `Begona mashinalar ${c.outsideVisits} marta kirdi (${c.outsidePlates} ta raqam)`, href: `#/darvoza` });
  if (!items.length) return html`<div class="empty">${icon('check')} Diqqat talab qiladigan narsa yo'q</div>`;
  return html`<ul class="att-list">${items.map((i) => html`<li class="att ${i.sev}">
    ${icon(i.sev === 'bad' || i.sev === 'warn' ? 'alert' : 'info')}<span>${i.text}</span>${i.href ? html`<a href="${i.href}">Ko'rish</a>` : ''}</li>`)}</ul>`;
}

export default {
  async render(main, { query }) {
    let range = rangeFromQuery(query, 'd7');
    let metric = 'trips';
    let series = [];
    let seq = 0, alive = true, dispose = null;

    setHtml(main, html`<div class="page">
      ${reportTabs('tahlil')}
      <div class="page-head">
        <div class="small muted" id="anRange"></div>
        <span class="spacer"></span>
        <div class="seg" id="anPreset" role="group" aria-label="Davr">${PRESETS.map((k) => html`<button type="button" data-p="${k}" aria-pressed="false">${PRESET_LABELS[k]}</button>`)}</div>
      </div>
      <div class="tiles an-tiles" id="anKpis"></div>
      <div class="grid an-grid">
        <section class="card">
          <div class="card-head"><h3 id="chTitle">Kunlik reyslar</h3><span class="spacer"></span>
            <div class="seg" id="anMetric" role="group" aria-label="Ko'rsatkich">
              <button type="button" data-m="trips" aria-pressed="true">Reyslar</button><button type="button" data-m="km" aria-pressed="false">Km</button>
            </div></div>
          <div class="card-body"><div id="anChart"></div></div>
        </section>
        <section class="card">
          <div class="card-head"><h3>Diqqat</h3></div>
          <div id="anAtt"></div>
        </section>
      </div>
      <section class="card">
        <div class="card-head"><h3>Transportlar</h3><span class="small muted">reyslar bo'yicha</span><span class="spacer"></span>
          <a class="btn btn-sm" id="anFull" href="#/hisobot">To'liq jadval</a></div>
        <div id="anTable"></div>
      </section>
    </div>`);

    const drawChart = () => {
      const el = $('#anChart', main);
      dispose?.();
      $('#chTitle', main).textContent = metric === 'trips' ? 'Kunlik reyslar' : 'Kunlik masofa, km';
      if (!series.some((s) => s[metric])) { dispose = null; return setHtml(el, html`<div class="empty">Bu davrda ma'lumot yo'q</div>`); }
      const unit = metric === 'trips' ? 'reys' : 'km';
      const data = series.map((s) => ({ label: shortDay(s.day), value: s[metric] || 0, tip: `<b>${esc(dayLabel(s.day))}</b>: ${esc(num(s[metric]))} ${unit}` }));
      dispose = responsive(el, () => barChart(el, data, { height: 220, unit, valueLabels: data.length <= 14 }));
    };

    const drawTable = (vehicles) => {
      const rows = vehicles.filter((v) => v.trips || v.km >= 1);
      const max = Math.max(1, ...rows.map((v) => v.trips));
      setHtml($('#anTable', main), rows.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Transport</th><th class="num">Reys</th><th class="an-barcol" aria-hidden="true"></th><th class="num">Km</th><th class="num">Ishlagan kun</th></tr></thead>
        <tbody>${rows.map((v) => html`<tr class="clickable" data-id="${v.id}">
          <td class="nowrap">${typeIcon(v.type)} <b>${v.label}</b></td><td class="num">${v.trips}</td>
          <td class="an-barcol"><span class="an-bar" style="width:${Math.round((v.trips / max) * 100)}%"></span></td>
          <td class="num">${num(v.km)}</td><td class="num">${v.activeDays}/${v.days}</td></tr>`)}</tbody></table></div>`
        : html`<div class="empty">Bu davrda ishlagan transport yo'q</div>`);
    };

    const load = async () => {
      const my = ++seq;
      const q = qs(range);
      for (const b of $('#anPreset', main).children) { const p = presetRange(b.dataset.p); b.setAttribute('aria-pressed', String(p.from === range.from && p.to === range.to)); }
      $('#anFull', main).href = `#/hisobot?${q}`;
      try {
        const [ov, s, vehicles] = await Promise.all([get(`/api/analytics/overview?${q}`), get(`/api/analytics/series?${q}`), get(`/api/analytics/vehicles?${q}`)]);
        if (!alive || my !== seq) return;
        $('#anRange', main).textContent = `${rangeText(range)} · oldingi ${ov.days} kunga nisbatan`;
        setHtml($('#anKpis', main), html`${KPIS.map((d) => tile(d, ov.current, ov.previous))}`);
        series = s;
        drawChart();
        setHtml($('#anAtt', main), attention(ov.current, vehicles));
        drawTable(vehicles);
      } catch (e) { if (alive && my === seq) toastError(e); }
    };

    $('#anPreset', main).addEventListener('click', (e) => {
      const b = e.target.closest('[data-p]');
      if (!b) return;
      range = presetRange(b.dataset.p);
      replaceQuery('tahlil', range);
      load();
    });
    $('#anMetric', main).addEventListener('click', (e) => {
      const b = e.target.closest('[data-m]');
      if (!b || b.dataset.m === metric) return;
      metric = b.dataset.m;
      for (const x of $('#anMetric', main).children) x.setAttribute('aria-pressed', String(x === b));
      drawChart();
    });
    $('#anTable', main).addEventListener('click', (e) => { const r = e.target.closest('tr[data-id]'); if (r) location.hash = `#/transport/${r.dataset.id}`; });

    await load();
    return () => { alive = false; dispose?.(); };
  },
};
