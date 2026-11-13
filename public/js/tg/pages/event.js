// One pass through the gate: every photo, who it was, when, what GPS said. Telegram alerts link here.
import { get, state } from '../../api.js';
import { html, icon, setHtml, hms, dayLabel, dayOf, dur, num, lightbox, GATE_STATUS } from '../../ui.js';
import { evLabel } from '../parts.js';

const BY = { plate: 'raqam bo\'yicha', alias: 'sozlangan raqam bo\'yicha', similar: "o'xshash raqam bo'yicha", learned: "GPS chiqishlaridan o'rganilgan", gps: "GPS bo'yicha (raqam o'qilmadi)" };

export default {
  async render(host, { params, setTitle }) {
    const id = Number(params[0]);
    let ev;
    try { ev = await get(`/api/gate-events/${id}`); } catch (e) {
      setHtml(host, html`<div class="tg-empty">${e.status === 404 ? "Bu o'tish topilmadi (o'chirilgan bo'lishi mumkin)" : e.message}</div>`);
      return null;
    }
    const draw = () => {
      setTitle(ev.direction === 'in' ? 'Kirdi' : 'Chiqdi');
      const [statusText, statusCls] = GATE_STATUS[ev.status] || [ev.status, ''];
      setHtml(host, html`
        <div class="tg-photos">${ev.photos.length ? ev.photos.map((p) => html`<button type="button" class="tg-photo" data-src="${p.url}"><img src="${p.url}" alt="${p.name}"><span>${p.name}</span></button>`) : html`<div class="tg-empty">${icon('camera')} Rasm yo'q</div>`}</div>
        <section class="tg-card">
          <div class="tg-ev-head big"><span class="tg-dir ${ev.direction}">${ev.direction === 'in' ? 'KIRDI' : 'CHIQDI'}</span><b class="plate">${evLabel(ev)}</b></div>
          <dl class="tg-dl">
            <dt>Vaqt</dt><dd>${dayLabel(dayOf(ev.t))}, ${hms(ev.t)}</dd>
            <dt>Kamera</dt><dd>${ev.camera}</dd>
            ${ev.plateText && ev.vehicleLabel && ev.plateText !== ev.vehicleLabel ? html`<dt>Raqam</dt><dd class="plate">${ev.plateText}</dd>` : ''}
            ${ev.plateRaw && ev.plateRaw !== ev.plate ? html`<dt>O'qildi</dt><dd class="plate">${ev.plateRaw}</dd>` : ''}
            <dt>Transport</dt><dd>${ev.vehicleId ? html`<a href="#/v/${ev.vehicleId}">${ev.vehicleLabel}</a>${ev.identifiedBy && ev.identifiedBy !== 'plate' ? html` <span class="muted small">(${BY[ev.identifiedBy] || ev.identifiedBy})</span>` : ''}` : ev.plateValid ? "Begona: GPS ro'yxatida yo'q" : 'Aniqlanmadi'}</dd>
            ${ev.vehicleId ? html`<dt>GPS</dt><dd><span class="pill ${statusCls}">${statusText}</span>${ev.note ? html`<div class="small muted">${ev.note}</div>` : ''}</dd>` : ''}
            ${ev.staySeconds != null ? html`<dt>Ichkarida</dt><dd>${dur(ev.staySeconds)}</dd>` : ''}
            ${ev.gap ? html`<dt>Eslatma</dt><dd class="small">${ev.direction === 'in' ? 'Oldingi chiqishi qayd etilmagan' : 'Kirishi qayd etilmagan'}</dd>` : ''}
            ${ev.readBy && ev.readBy !== 'camera' ? html`<dt>O'qigan</dt><dd class="small">Bizning dastur${ev.readConf != null ? ` (${num(ev.readConf * 100)}%)` : ''}</dd>` : ''}
          </dl>
        </section>
        ${ev.vehicleId ? html`<a class="btn btn-primary btn-block tg-big" href="#/v/${ev.vehicleId}">${icon('truck')} Transport sahifasi</a>` : ''}`);
    };
    draw();
    host.addEventListener('click', (e) => { const p = e.target.closest('[data-src]'); if (p) lightbox(p.dataset.src); });
    // The GPS check and the top view arrive a minute or two after the pass.
    const off = state.on('gate:update', (u) => { if (u.id === id) { ev = u; draw(); } });
    return off;
  },
};
