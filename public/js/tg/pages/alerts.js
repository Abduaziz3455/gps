// Ogohlantirishlar: open ones first; mark one or all as seen. Everyone sees the same list as on the site.
import { get, post, state } from '../../api.js';
import { html, icon, setHtml, debounce, toastError } from '../../ui.js';
import { alertRow, wireAck, seg, wireSeg } from '../parts.js';
import * as tg from '../telegram.js';

export default {
  async render(host) {
    let which = 'open', list = [];
    setHtml(host, html`${seg([{ id: 'open', label: 'Ochiq' }, { id: 'all', label: 'Hammasi' }], which)}<div data-body></div>`);
    const body = host.querySelector('[data-body]');

    const draw = () => setHtml(body, html`
      ${which === 'open' && list.length > 1 ? html`<button class="btn btn-block tg-big" type="button" data-all>${icon('check')} Hammasini o'qildi deb belgilash</button>` : ''}
      ${list.length ? html`<div class="tg-list">${list.map(alertRow)}</div>` : html`<div class="tg-empty">${icon('check')} ${which === 'open' ? "Ochiq ogohlantirish yo'q" : "Ogohlantirish yo'q"}</div>`}`);
    const load = async () => { list = await get(`/api/alerts?${which === 'open' ? 'state=open&' : ''}limit=100`); draw(); };
    await load();

    wireSeg(host, (v) => { which = v; load().catch(toastError); });
    wireAck(body, () => load().catch(() => {}));
    body.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-all]');
      if (!b || !await tg.confirm(`${Math.max(state.unacked, list.length)} ta ogohlantirish o'qildi deb belgilansinmi?`)) return;
      b.disabled = true;
      try { await post('/api/alerts/ack-all'); tg.haptic('success'); await load(); } catch (err) { b.disabled = false; toastError(err); }
    });
    const reload = debounce(() => load().catch(() => {}), 500);
    const offs = [state.on('alert', reload), state.on('alert:update', reload)];
    return () => offs.forEach((off) => off());
  },
};
