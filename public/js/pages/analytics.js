// Tahlil (owner): KPIs vs the previous period, daily trends, gate load heatmap, turnaround distribution,
// per-vehicle ranking and outside vehicles. The chosen range lives in the URL (#/tahlil?from=&to=).
import { get, qs } from '../api.js';
import { $, html, setHtml, icon, esc, num, dur, when, dayLabel, shortDay, WEEKDAYS, toastError } from '../ui.js';
import { barChart, heatmap, responsive } from '../charts.js';
import { rangeFromQuery, rangeControl, replaceQuery, rangeText, vehicleTable } from './reports.js';

// good: 1 = higher is better, -1 = lower is better (costs, waiting), 0 = neutral. pp: show change in percentage points.
const KPIS = [
  { k: 'trips', label: 'Reyslar', unit: 'ta', good: 1 },
  { k: 'km', label: 'Masofa', unit: 'km', good: 1 },
  { k: 'engineHours', label: 'Motosoat', unit: 'soat', good: 1 },
  { k: 'utilization', label: 'Foydalanish', unit: '%', pp: true, good: 1, sub: (c) => `${num(c.activeVehicleDays)} faol transport-kun · ${num(c.vehiclesTotal)} ta transport` },
  { k: 'turnaroundMin', label: 'Aylanish vaqti', unit: 'daq', good: -1, sub: () => "Chiqish → keyingi kirish, o'rtacha" },
  { k: 'yardMin', label: "Hovlida o'rtacha", unit: 'daq', good: -1, sub: () => 'Kirish → chiqish (yuklash navbati)' },
  { k: 'idleShare', label: 'Salt ishlash', unit: '%', pp: true, good: -1, sub: () => 'Motosoatning turib ishlagan qismi' },
  { k: 'fuelUsed', label: "Yoqilg'i", unit: 'L', good: -1, sub: (c, p) => `${num(c.fuelPer100, 1)} L/100 km · oldin ${num(p.fuelPer100, 1)}` },
  { k: 'drains', label: "To'kish", unit: 'ta', good: -1, sub: (c) => `Jami ${num(c.drainL, 0)} L to'kilgan` },
  { k: 'outsideVisits', label: 'Begona mashinalar', unit: 'ta', good: 0, sub: (c) => `${num(c.outsidePlates)} ta turli raqam` },
];

const TURN_LABELS = [...Array.from({ length: 12 }, (_, i) => `${i * 30}–${i * 30 + 30}`), '6 soat+'];

const weekday = (day) => WEEKDAYS[(new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7];

function deltaHtml(cur, prev, { pp, good }) {
  if (cur == null || prev == null) return html`<span class="delta flat">—</span>`;
  let diff, text;
  if (pp) {
    diff = cur - prev;
    text = `${num(Math.abs(diff))} p.p.`;
  } else {
    if (prev === 0) return cur === 0 ? html`<span class="delta flat">0%</span>` : html`<span class="delta flat" title="Oldingi davrda 0">yangi</span>`;
    diff = ((cur - prev) / Math.abs(prev)) * 100;
    if (Math.abs(diff) < 0.5) diff = 0;
    text = `${num(Math.abs(diff), Math.abs(diff) < 10 && diff !== 0 ? 1 : 0)}%`;
  }
  const arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '±';
  const cls = diff === 0 || !good ? 'flat' : (diff > 0) === (good > 0) ? 'up' : 'down';
  const verdict = cls === 'up' ? 'yaxshilandi' : cls === 'down' ? 'yomonlashdi' : "o'zgarish";
  return html`<span class="delta ${cls}" title="Oldingi davrga nisbatan: ${verdict}">${arrow} ${text}</span>`;
}

function tileHtml(def, cur, prev) {
  const v = cur[def.k], p = prev[def.k];
  const unit = def.unit === 'ta' ? '' : def.unit;
  const val = (x) => (x == null ? '—' : `${num(x)}${unit && x != null ? (unit === '%' ? '%' : ` ${unit}`) : ''}`);
  return html`<div class="tile">
    <div class="tile-label">${def.label}</div>
    <div class="tile-value">${v == null ? '—' : num(v)}${v != null && unit ? html`<small>${unit}</small>` : ''}</div>
    <div class="tile-sub">${deltaHtml(v, p, def)} <span>· oldin: ${val(p)}</span></div>
    ${def.sub ? html`<div class="tile-sub" title="${def.sub(cur, prev)}">${def.sub(cur, prev)}</div>` : ''}
  </div>`;
}

const chartCard = (id, title, extra = '') => html`<section class="card">
  <div class="card-head"><h3>${title}</h3><span class="spacer"></span>${extra}</div>
  <div class="card-body"><div id="${id}"></div></div></section>`;

export default {
  async render(main, { query }) {
    let range = rangeFromQuery(query, 'd7');
    let direction = '';
    let seq = 0, hseq = 0;
    let alive = true;
    const disposers = new Map();

    setHtml(main, html`<div class="page">
      <div class="page-head">
        <div>
          <h2>Tahlil</h2>
          <div class="small muted" id="anRange"></div>
        </div>
        <span class="spacer"></span>
        <div id="anRangeCtl"></div>
      </div>
      <div id="anBody" class="an-body">
        <div class="tiles" id="anKpis">${KPIS.map((d) => html`<div class="tile"><div class="tile-label">${d.label}</div><div class="tile-value muted">…</div><div class="tile-sub">&nbsp;</div></div>`)}</div>
        <div class="grid grid-2">
          ${chartCard('chTrips', 'Kunlik reyslar')}
          ${chartCard('chKm', 'Kunlik masofa, km')}
          ${chartCard('chActive', 'Faol transportlar')}
          ${chartCard('chTurn', 'Aylanish vaqti taqsimoti', html`<span class="small muted">daqiqa, reyslar soni</span>`)}
          <section class="card span-all">
            <div class="card-head"><h3>Darvoza yuklamasi: hafta kuni × soat</h3><span class="spacer"></span>
              <div class="seg" id="hmDir" role="group" aria-label="Yo'nalish">
                <button type="button" data-d="" aria-pressed="true">Hammasi</button>
                <button type="button" data-d="in" aria-pressed="false">Kirish</button>
                <button type="button" data-d="out" aria-pressed="false">Chiqish</button>
              </div>
            </div>
            <div class="card-body"><div id="chHeat"></div></div>
          </section>
        </div>
        <section class="card">
          <div class="card-head"><h3>Transportlar reytingi</h3><span class="small muted">qatorni bosing — transport sahifasi</span><span class="spacer"></span>
            <button class="btn btn-sm" id="anCsv" type="button">${icon('download')}<span>CSV</span></button></div>
          <div id="anTable"><div class="empty">Yuklanmoqda…</div></div>
        </section>
        <section class="card">
          <div class="card-head"><h3>Begona mashinalar</h3><span class="small muted">GPS ro'yxatida yo'q, kamera o'qigan raqamlar</span></div>
          <div id="anOut"><div class="empty">Yuklanmoqda…</div></div>
        </section>
      </div>
    </div>`);

    const body = $('#anBody', main);
    const table = vehicleTable($('#anTable', main));

    const draw = (key, el, fn) => {
      disposers.get(key)?.();
      disposers.delete(key);
      if (!fn) return;
      disposers.set(key, responsive(el, fn));
    };
    const empty = (key, el, text = "Bu oraliqda ma'lumot yo'q") => { draw(key, el, null); setHtml(el, html`<div class="empty">${text}</div>`); };

    const bars = (key, series, field, unit, digits = 0) => {
      const el = $(`#${key}`, main);
      if (!series.length || series.every((s) => !s[field])) return empty(key, el);
      const data = series.map((s) => ({
        label: shortDay(s.day), value: s[field] || 0,
        tip: `<b>${esc(dayLabel(s.day, true))}, ${esc(weekday(s.day))}</b><br>${esc(num(s[field], digits))} ${esc(unit)}`,
      }));
      return draw(key, el, () => barChart(el, data, { height: 200, unit, valueLabels: data.length <= 14 }));
    };

    const drawHeat = (grid) => {
      const el = $('#chHeat', main);
      if (!grid.flat().some(Boolean)) return empty('chHeat', el, "Bu oraliqda darvoza hodisalari yo'q");
      return draw('chHeat', el, () => heatmap(el, grid, { unit: "o'tish" }));
    };

    const drawTurn = (buckets) => {
      const el = $('#chTurn', main);
      if (!buckets.some(Boolean)) return empty('chTurn', el, "Aylanish ma'lumoti yo'q");
      const total = buckets.reduce((a, b) => a + b, 0);
      const data = buckets.map((v, i) => ({
        label: TURN_LABELS[i], value: v,
        tip: `<b>${esc(i === 12 ? '6 soatdan ortiq' : `${TURN_LABELS[i]} daqiqa`)}</b><br>${v} reys · ${Math.round((v / total) * 100)}%`,
      }));
      return draw('chTurn', el, () => barChart(el, data, { height: 200, unit: 'reys', valueLabels: true }));
    };

    const drawOutsiders = (list) => {
      const el = $('#anOut', main);
      if (!list.length) return setHtml(el, html`<div class="empty">Bu oraliqda begona mashinalar kelmagan</div>`);
      return setHtml(el, html`<div class="table-wrap" style="max-height:420px"><table class="table">
        <thead><tr><th scope="col">Raqam</th><th class="num" scope="col">Kelishlar</th><th class="num" scope="col" title="Hovlida o'rtacha turish vaqti">O'rt. turish</th><th class="num" scope="col">Oxirgi marta</th></tr></thead>
        <tbody>${list.map((o) => html`<tr><td><span class="plate-chip">${o.plate}</span></td><td class="num">${num(o.visits)}</td>
          <td class="num nowrap">${o.stayMin == null ? '—' : dur(o.stayMin * 60)}</td><td class="num nowrap">${when(o.lastT)}</td></tr>`)}</tbody>
      </table></div>`);
    };

    const loadHeat = async () => {
      const my = ++hseq;
      try {
        const grid = await get(`/api/analytics/heatmap?${qs({ ...range, direction })}`);
        if (alive && my === hseq) drawHeat(grid);
      } catch (e) { if (alive) toastError(e); }
    };

    const load = async () => {
      const my = ++seq;
      ++hseq;
      body.classList.add('is-loading');
      const q = qs(range);
      try {
        const [ov, series, vehicles, grid, turn, outsiders] = await Promise.all([
          get(`/api/analytics/overview?${q}`), get(`/api/analytics/series?${q}`), get(`/api/analytics/vehicles?${q}`),
          get(`/api/analytics/heatmap?${qs({ ...range, direction })}`), get(`/api/analytics/turnaround?${q}`), get(`/api/analytics/outsiders?${q}`),
        ]);
        if (!alive || my !== seq) return;
        $('#anRange', main).textContent = `${rangeText(range)} · ${ov.days} kun · taqqoslash: ${rangeText(ov.previousRange)}`;
        setHtml($('#anKpis', main), html`${KPIS.map((d) => tileHtml(d, ov.current, ov.previous))}`);
        bars('chTrips', series, 'trips', 'reys');
        bars('chKm', series, 'km', 'km');
        bars('chActive', series, 'active', 'ta transport');
        drawTurn(turn);
        drawHeat(grid);
        table.set(vehicles);
        drawOutsiders(outsiders);
      } catch (e) {
        if (alive && my === seq) toastError(e);
      } finally {
        if (my === seq) body.classList.remove('is-loading');
      }
    };

    rangeControl($('#anRangeCtl', main), {
      presets: ['today', 'yesterday', 'd7', 'd30', 'month'],
      value: range,
      onChange: (r) => { range = r; replaceQuery('tahlil', range); load(); },
    });
    $('#hmDir', main).addEventListener('click', (e) => {
      const b = e.target.closest('[data-d]');
      if (!b || b.dataset.d === direction) return;
      direction = b.dataset.d;
      for (const x of $('#hmDir', main).children) x.setAttribute('aria-pressed', String(x === b));
      loadHeat();
    });
    $('#anCsv', main).addEventListener('click', () => {
      if (!table.rows().length) return toastError(new Error("Eksport uchun ma'lumot yo'q"));
      return table.csv(`tahlil_${range.from}_${range.to}.csv`);
    });

    await load();
    return () => {
      alive = false;
      for (const d of disposers.values()) d();
      disposers.clear();
    };
  },
};
