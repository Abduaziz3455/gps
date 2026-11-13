// Bugun: the fleet right now, the yard, today's numbers, what needs attention, the latest passes.
import { get, state } from '../../api.js';
import { html, icon, setHtml, num, debounce, STATUS } from '../../ui.js';
import { eventRow, alertRow, wireAck, statusCounts } from '../parts.js';

export default {
  async render(host) {
    let today = null, alerts = [], events = [];

    const draw = () => {
      const c = statusCounts();
      const t = today || {};
      setHtml(host, html`
        <section class="tg-section">
          <h2 class="tg-h">Avtopark hozir</h2>
          <div class="tg-tiles four">
            ${['moving', 'idle', 'stopped', 'offline'].map((s) => html`<a class="tg-tile" href="#/xarita?status=${s}"><span class="status ${s}">${STATUS[s]}</span><b>${c[s]}</b></a>`)}
          </div>
        </section>
        <section class="tg-section">
          <h2 class="tg-h">Bugun</h2>
          <div class="tg-tiles three">
            <a class="tg-tile" href="#/darvoza?tab=hovli"><span class="tile-label">${icon('home')} Hovlida</span><b>${t.insideFleet ?? '—'}</b><span class="small muted">+ ${t.insideOutside ?? 0} begona</span></a>
            <a class="tg-tile" href="#/darvoza?dir=out"><span class="tile-label">${icon('out')} Chiqdi</span><b>${t.tripsOut ?? '—'}</b><span class="small muted">reys</span></a>
            <a class="tg-tile" href="#/darvoza?dir=in"><span class="tile-label">${icon('in')} Kirdi</span><b>${t.tripsIn ?? '—'}</b><span class="small muted">qaytdi</span></a>
          </div>
          <a class="tg-wide" href="#/hisobot"><span>${icon('route')} Yurgan masofa</span><b>${num(t.km ?? 0)} km</b>${t.fuel != null ? html`<span class="muted">· ${num(t.fuel)} L</span>` : ''}<span class="tg-chev">›</span></a>
        </section>
        <section class="tg-section">
          <div class="tg-h-row"><h2 class="tg-h">Ogohlantirishlar</h2><a href="#/ogohlantirish">${state.unacked ? `Hammasi (${state.unacked})` : 'Tarix'}</a></div>
          ${alerts.length ? html`<div class="tg-list">${alerts.map(alertRow)}</div>` : html`<div class="tg-empty">${icon('check')} Ochiq ogohlantirish yo'q</div>`}
        </section>
        <section class="tg-section">
          <div class="tg-h-row"><h2 class="tg-h">Darvoza</h2><a href="#/darvoza">Hammasi</a></div>
          ${events.length ? html`<div class="tg-list">${events.map(eventRow)}</div>` : html`<div class="tg-empty">Bugun hali o'tish yo'q</div>`}
        </section>`);
    };

    const load = async () => {
      [today, alerts, events] = await Promise.all([
        get('/api/today'),
        get('/api/alerts?state=open&limit=3'),
        get('/api/gate-events?limit=5'),
      ]);
      draw();
    };
    await load();
    wireAck(host, load);

    const reload = debounce(() => load().catch(() => {}), 800);
    const offs = ['gate', 'gate:update', 'stats', 'alert', 'alert:update', 'trips'].map((e) => state.on(e, reload));
    offs.push(state.on('vehicles:changed', debounce(draw, 400)));
    return () => offs.forEach((off) => off());
  },
};
