// Darvoza: the passes as they happen (with photos), and who is in the yard now and for how long.
import { get, qs, state } from '../../api.js';
import { html, icon, setHtml, when, dur, debounce, toastError } from '../../ui.js';
import { eventRow, seg, wireSeg } from '../parts.js';

const FILTERS = [{ id: 'all', label: 'Hammasi' }, { id: 'in', label: 'Kirdi' }, { id: 'out', label: 'Chiqdi' }, { id: 'outside', label: 'Begona' }];
const PAGE = 30;

export default {
  async render(host, { query }) {
    let tab = query.tab === 'hovli' ? 'hovli' : 'oqim';
    let filter = ['in', 'out'].includes(query.dir) ? query.dir : 'all';
    let events = [], more = false, yard = null;

    setHtml(host, html`
      ${seg([{ id: 'oqim', label: "O'tishlar" }, { id: 'hovli', label: 'Hovlida' }], tab)}
      <div data-body></div>`);
    const body = host.querySelector('[data-body]');

    const params = (extra = {}) => qs({
      limit: PAGE, direction: ['in', 'out'].includes(filter) ? filter : undefined, kind: filter === 'outside' ? 'outside' : undefined, ...extra,
    });
    const fits = (ev) => ev.status !== 'vetoed' && (filter === 'all' || (filter === 'outside' ? !ev.vehicleId : ev.direction === filter));

    const drawFeed = () => setHtml(body, html`
      <div class="tg-chips">${FILTERS.map((f) => html`<button type="button" class="tg-chip" data-f="${f.id}" aria-pressed="${f.id === filter}">${f.label}</button>`)}</div>
      ${events.length ? html`<div class="tg-list">${events.map(eventRow)}</div>` : html`<div class="tg-empty">O'tish yo'q</div>`}
      ${more ? html`<button class="btn btn-block tg-big" type="button" data-more>Yana ko'rsatish</button>` : ''}`);

    const drawYard = () => {
      const fleet = yard.inside.filter((x) => x.fleet), outside = yard.inside.filter((x) => !x.fleet);
      const row = (x) => html`<a class="tg-yard" href="${x.vehicleId ? `#/v/${x.vehicleId}` : x.event ? `#/e/${x.event.id}` : '#/darvoza?tab=hovli'}">
        <b class="plate">${x.label}</b><span class="small muted">${x.since ? `${when(x.since)} dan` : ''}${x.fleet && x.gpsInYard === false ? ' · GPS hovlida emas' : ''}</span>
        <span class="tg-yard-dur">${x.since ? dur((Date.now() - x.since) / 1000) : '—'}</span></a>`;
      setHtml(body, html`
        <section class="tg-section"><h2 class="tg-h">Avtopark · ${fleet.length + yard.gpsOnly.length}</h2>
          ${fleet.length ? html`<div class="tg-list">${fleet.map(row)}</div>` : html`<div class="tg-empty">Hovlida avtopark transporti yo'q</div>`}
          ${yard.gpsOnly.length ? html`<p class="small muted tg-note">${icon('info')} GPS bo'yicha hovlida, kamera kirganini ko'rmagan:</p>
            <div class="tg-list">${yard.gpsOnly.map((x) => row({ ...x, label: x.label, since: x.since, fleet: true }))}</div>` : ''}
        </section>
        <section class="tg-section"><h2 class="tg-h">Begona · ${outside.length}</h2>
          ${outside.length ? html`<div class="tg-list">${outside.map(row)}</div>` : html`<div class="tg-empty">Begona transport yo'q</div>`}
        </section>`);
    };

    const loadFeed = async () => { const list = await get(`/api/gate-events?${params()}`); events = list; more = list.length >= PAGE; drawFeed(); };
    const loadYard = async () => { yard = await get('/api/yard'); drawYard(); };
    const load = () => (tab === 'hovli' ? loadYard() : loadFeed());
    await load();

    wireSeg(host, (v) => { tab = v; history.replaceState(null, '', `#/darvoza${tab === 'hovli' ? '?tab=hovli' : ''}`); load().catch(toastError); });
    body.addEventListener('click', async (e) => {
      const f = e.target.closest('[data-f]');
      if (f) { filter = f.dataset.f; await loadFeed().catch(toastError); return; }
      const m = e.target.closest('[data-more]');
      if (m) {
        m.disabled = true;
        try {
          const older = await get(`/api/gate-events?${params({ before: events.at(-1).t })}`);
          events = events.concat(older.filter((x) => !events.some((y) => y.id === x.id)));
          more = older.length >= PAGE;
          drawFeed();
        } catch (err) { m.disabled = false; toastError(err); }
      }
    });

    const yardTick = setInterval(() => { if (tab === 'hovli' && yard) drawYard(); }, 60e3); // the durations grow
    const reloadYard = debounce(() => { if (tab === 'hovli') loadYard().catch(() => {}); }, 1000);
    const offs = [
      state.on('gate', (ev) => {
        reloadYard();
        if (tab !== 'oqim' || !fits(ev) || events.some((x) => x.id === ev.id)) return;
        events.unshift(ev);
        drawFeed();
      }),
      state.on('gate:update', (ev) => {
        reloadYard();
        if (tab !== 'oqim') return;
        const i = events.findIndex((x) => x.id === ev.id);
        if (i < 0) return;
        if (fits(ev)) events[i] = ev; else events.splice(i, 1);
        drawFeed();
      }),
    ];
    return () => { clearInterval(yardTick); offs.forEach((off) => off()); };
  },
};
