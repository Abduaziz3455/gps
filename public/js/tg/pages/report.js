// Hisobot: per truck km, fuel and trips for today, yesterday or this month. The same numbers as /bugun and the site.
import { get, qs, state } from '../../api.js';
import { html, icon, setHtml, num, today, addDays, dayLabel, MONTHS, debounce, toastError } from '../../ui.js';
import { seg, wireSeg } from '../parts.js';

const PERIODS = [{ id: 'bugun', label: 'Bugun' }, { id: 'kecha', label: 'Kecha' }, { id: 'oy', label: 'Shu oy' }];

function range(p) {
  const t = today();
  if (p === 'kecha') { const d = addDays(t, -1); return { from: d, to: d, title: dayLabel(d) }; }
  if (p === 'oy') return { from: `${t.slice(0, 8)}01`, to: t, title: `${MONTHS[Number(t.slice(5, 7)) - 1]} ${t.slice(0, 4)}` };
  return { from: t, to: t, title: dayLabel(t) };
}

export default {
  async render(host, { query }) {
    let period = PERIODS.some((p) => p.id === query.p) ? query.p : 'bugun';
    setHtml(host, html`${seg(PERIODS, period)}<div data-body></div>`);
    const body = host.querySelector('[data-body]');

    const load = async () => {
      const r = range(period);
      const rows = (await get(`/api/reports/vehicles?${qs({ from: r.from, to: r.to })}`))
        .filter((x) => x.km >= 0.5 || x.trips > 0 || x.refuelL > 0 || x.drainL > 0)
        .sort((a, b) => b.trips - a.trips || b.km - a.km);
      const sum = (k) => rows.reduce((a, x) => a + (x[k] || 0), 0);
      const fuelRows = rows.filter((x) => x.fuelUsed != null);
      setHtml(body, html`
        <p class="small muted tg-note">${r.title}${period === 'bugun' ? " · har 10 daqiqada yangilanadi" : ''}</p>
        <div class="tg-tiles three">
          <div class="tg-tile"><span class="tile-label">${icon('out')} Reyslar</span><b>${sum('trips')}</b></div>
          <div class="tg-tile"><span class="tile-label">${icon('route')} Masofa</span><b>${num(sum('km'))}<small> km</small></b></div>
          <div class="tg-tile"><span class="tile-label">${icon('truck')} Ishlagan</span><b>${rows.length}<small> ta</small></b></div>
          ${fuelRows.length ? html`<div class="tg-tile"><span class="tile-label">${icon('fuel')} Sarf</span><b>${num(fuelRows.reduce((a, x) => a + x.fuelUsed, 0))}<small> L</small></b></div>` : ''}
          ${sum('refuelL') ? html`<div class="tg-tile"><span class="tile-label">${icon('fuel')} Quyildi</span><b>${num(sum('refuelL'))}<small> L</small></b></div>` : ''}
          ${sum('drainL') ? html`<div class="tg-tile bad"><span class="tile-label">${icon('alert')} To'kildi</span><b>${num(sum('drainL'))}<small> L</small></b></div>` : ''}
        </div>
        ${rows.length ? html`<div class="tg-list">${rows.map((x) => html`<a class="tg-rep" href="#/v/${x.id}${period === 'kecha' ? '?day=kecha' : ''}">
          <b class="plate">${x.label}</b>
          <span class="tg-rep-nums"><span><b>${x.trips}</b> reys</span><span><b>${num(x.km)}</b> km</span>${x.fuelUsed != null ? html`<span><b>${num(x.fuelUsed)}</b> L</span>` : ''}</span>
          ${x.refuelL || x.drainL ? html`<span class="small">${x.refuelL ? `⛽ +${num(x.refuelL)} L ` : ''}${x.drainL ? html`<b class="bad-text">⚠️ −${num(x.drainL)} L to'kildi</b>` : ''}</span>` : ''}
        </a>`)}</div>` : html`<div class="tg-empty">Harakat qayd etilmagan</div>`}
        <p class="small muted tg-note">km va yoqilg'i GPS bo'yicha, reyslar kamera bo'yicha.</p>`);
    };
    await load();
    wireSeg(host, (v) => { period = v; history.replaceState(null, '', `#/hisobot${v === 'bugun' ? '' : `?p=${v}`}`); load().catch(toastError); });
    const reload = debounce(() => { if (period !== 'kecha') load().catch(() => {}); }, 1000);
    const off = state.on('stats', reload);
    return off;
  },
};
