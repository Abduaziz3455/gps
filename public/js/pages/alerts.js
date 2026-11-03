// Ogohlantirishlar: rule hits (fuel drain, speeding, no signal, long stop, system), acknowledge, filter, live.
// ?id=<n> highlights one alert (push notifications open it this way).
import { get, post, state, qs } from '../api.js';
import { $, $$, html, setHtml, icon, when, toast, toastError, confirmDialog, debounce } from '../ui.js';
import { replaceQuery } from './reports.js';

export const ALERT_TYPES = {
  fuel_drain: "Yoqilg'i to'kilishi",
  speeding: 'Tezlik',
  no_signal: "Signal yo'q",
  long_stop: "Uzoq to'xtash",
  system: 'Tizim',
};
const SEVERITY = { critical: ['alert', 'Muhim'], warning: ['alert', 'Ogohlantirish'], info: ['info', "Ma'lumot"] };

const rowHtml = (a) => {
  const [ic, sevLabel] = SEVERITY[a.severity] || SEVERITY.info;
  return html`<article class="arow${a.ackedAt ? ' acked' : ''}" data-id="${a.id}" tabindex="-1" aria-label="${a.title}">
    <span class="sev ${a.severity}" title="${sevLabel}" role="img" aria-label="${sevLabel}">${icon(ic)}</span>
    <div class="arow-main">
      <div class="arow-title">${a.title}</div>
      ${a.body ? html`<div class="arow-body">${a.body}</div>` : ''}
      <div class="arow-meta">
        <span class="pill${a.severity === 'critical' ? ' bad' : a.severity === 'warning' ? ' warn' : ' info'}">${ALERT_TYPES[a.type] || a.type}</span>
        ${a.vehicleId ? html`<a href="#/transport/${a.vehicleId}">${icon('truck')}<span>${a.vehicleLabel || `#${a.vehicleId}`}</span></a>` : ''}
      </div>
    </div>
    <div class="arow-side">
      <span class="num" title="${new Date(a.t).toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent' })}">${when(a.t)}</span>
      ${a.ackedAt
        ? html`<span class="small muted">${icon('check')} Ko'rdi: ${a.ackedBy || '—'}<br>${when(a.ackedAt)}</span>`
        : html`<button class="btn btn-sm" type="button" data-ack="${a.id}">${icon('check')}<span>Ko'rildi</span></button>`}
    </div>
  </article>`;
};

export default {
  async render(main, { query }) {
    const types = Object.keys(ALERT_TYPES);
    let filter = {
      state: query.state === 'all' ? 'all' : 'open',
      type: types.includes(query.type) ? query.type : '',
    };
    let focusId = query.id ? Number(query.id) : null;
    let list = [];
    let alive = true;
    let seq = 0;
    let scrolled = false;
    let first = true; // the ?id= fallback to "Hammasi" applies to the first load only

    setHtml(main, html`<div class="page">
      <div class="page-head">
        <div class="seg" id="alState" role="group" aria-label="Holat">
          <button type="button" data-s="open" aria-pressed="false">Ochiq</button>
          <button type="button" data-s="all" aria-pressed="false">Hammasi</button>
        </div>
        <select id="alType" aria-label="Turi">
          <option value="">Barcha turlar</option>
          ${types.map((t) => html`<option value="${t}">${ALERT_TYPES[t]}</option>`)}
        </select>
        <span class="small muted" id="alCount"></span>
        <span class="spacer"></span>
        <button class="btn" id="alAckAll" type="button">${icon('check')}<span>Hammasini ko'rildi deb belgilash</span></button>
      </div>
      <section class="card"><div class="alist" id="alList"><div class="empty"><div class="spinner" style="margin:auto"></div></div></div></section>
    </div>`);

    const listEl = $('#alList', main);
    const syncControls = () => {
      for (const b of $$('#alState button', main)) b.setAttribute('aria-pressed', String(b.dataset.s === filter.state));
      $('#alType', main).value = filter.type;
    };
    const syncUrl = () => replaceQuery('ogohlantirish', { state: filter.state === 'all' ? 'all' : '', type: filter.type, id: focusId || '' });

    const renderList = () => {
      const open = list.filter((a) => !a.ackedAt).length;
      $('#alCount', main).textContent = filter.state === 'open' ? `${list.length} ta ochiq` : `${list.length} ta · ${open} ta ochiq`;
      $('#alAckAll', main).disabled = !open;
      if (!list.length) {
        setHtml(listEl, html`<div class="empty">${filter.state === 'open' ? "Ochiq ogohlantirishlar yo'q. Hammasi joyida." : "Ogohlantirishlar yo'q"}</div>`);
        return;
      }
      setHtml(listEl, html`${list.map(rowHtml)}`);
      if (focusId) {
        const row = listEl.querySelector(`[data-id="${focusId}"]`);
        if (row) {
          row.classList.add('focus');
          if (!scrolled) {
            scrolled = true;
            requestAnimationFrame(() => { row.scrollIntoView({ block: 'center' }); row.focus({ preventScroll: true }); });
          }
        }
      }
    };

    const matches = (a) => (filter.state !== 'open' || !a.ackedAt) && (!filter.type || a.type === filter.type);

    const load = async () => {
      const my = ++seq;
      listEl.classList.add('is-loading');
      try {
        let rows = await get(`/api/alerts?${qs({ state: filter.state === 'open' ? 'open' : '', type: filter.type, limit: 300 })}`);
        // A linked alert that is already acknowledged is not in the open list: show all instead.
        if (first && focusId && filter.state === 'open' && !rows.some((a) => a.id === focusId)) {
          const all = await get(`/api/alerts?${qs({ type: filter.type, limit: 300 })}`);
          if (all.some((a) => a.id === focusId)) { filter.state = 'all'; rows = all; syncControls(); syncUrl(); }
        }
        if (!alive || my !== seq) return;
        first = false;
        list = rows;
        renderList();
      } catch (e) {
        if (alive && my === seq) { toastError(e); setHtml(listEl, html`<div class="empty">Yuklab bo'lmadi: ${e.message}</div>`); }
      } finally {
        if (my === seq) listEl.classList.remove('is-loading');
      }
    };
    const reload = debounce(() => { if (alive) load(); }, 300);

    $('#alState', main).addEventListener('click', (e) => {
      const b = e.target.closest('[data-s]');
      if (!b || b.dataset.s === filter.state) return;
      filter.state = b.dataset.s;
      focusId = null;
      syncControls(); syncUrl(); load();
    });
    $('#alType', main).addEventListener('change', (e) => {
      filter.type = e.target.value;
      focusId = null;
      syncUrl(); load();
    });
    listEl.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-ack]');
      if (!b) return;
      b.disabled = true;
      try {
        const a = await post(`/api/alerts/${b.dataset.ack}/ack`);
        const i = list.findIndex((x) => x.id === a.id);
        if (i >= 0) {
          if (filter.state === 'open') list.splice(i, 1); else list[i] = a;
        }
        renderList();
      } catch (ex) { b.disabled = false; toastError(ex); }
    });
    $('#alAckAll', main).addEventListener('click', async () => {
      const n = list.filter((a) => !a.ackedAt).length;
      if (!await confirmDialog("Hammasini ko'rildi deb belgilash", `Barcha ochiq ogohlantirishlar (${n} ta ko'rinib turibdi) ko'rildi deb belgilanadi. Davom etasizmi?`, 'Belgilash')) return;
      try {
        const r = await post('/api/alerts/ack-all');
        toast({ title: `${r.acked} ta ogohlantirish ko'rildi deb belgilandi`, kind: 'good', timeout: 4000 });
        load();
      } catch (ex) { toastError(ex); }
    });

    const offs = [
      state.on('alert', (a) => {
        if (!alive || !matches(a) || list.some((x) => x.id === a.id)) return;
        list.unshift(a);
        renderList();
        listEl.querySelector(`[data-id="${a.id}"]`)?.classList.add('new');
      }),
      state.on('alert:update', reload),
    ];

    syncControls();
    await load();
    return () => { alive = false; offs.forEach((off) => off()); };
  },
};
