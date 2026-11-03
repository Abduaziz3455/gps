// Darvoza: live feed of entries/exits with photos and the GPS check, who is inside now, manual corrections.
import { get, patch, qs, state } from '../api.js';
import { $, $$, html, setHtml, icon, hms, when, dur, today, dayLabel, GATE_STATUS, modal, lightbox, toast, toastError, debounce, esc } from '../ui.js';

const HOW = {
  plate: "Raqam bo'yicha", alias: 'Biriktirilgan haqiqiy raqam', similar: "O'xshash raqam (GPS'dagi nomi farq qiladi)",
  learned: "O'rganilgan: GPS chiqish vaqtlari mos keldi", gps: "GPS bo'yicha (raqam o'qilmagan)", manual: "Qo'lda biriktirilgan",
};
const LONG_INSIDE_S = 2 * 3600;

export default {
  async render(main, { query }) {
    const f = { direction: '', kind: '', day: today(), plate: '', all: false };
    let events = [];
    let more = true;
    main.innerHTML = String(html`
      <div class="page">
        <div class="tiles" id="gTiles"></div>
        <div class="gate">
          <section class="card">
            <div class="card-head">
              <h2>Hodisalar</h2>
              <div class="seg" id="segDir" role="group" aria-label="Yo'nalish">
                <button data-v="" aria-pressed="true">Hammasi</button><button data-v="in" aria-pressed="false">Kirish</button><button data-v="out" aria-pressed="false">Chiqish</button>
              </div>
              <div class="seg" id="segKind" role="group" aria-label="Turi">
                <button data-v="" aria-pressed="true">Barchasi</button><button data-v="fleet" aria-pressed="false">Avtopark</button><button data-v="outside" aria-pressed="false">Begona</button>
              </div>
              <span class="spacer"></span>
              <input type="search" id="gPlate" placeholder="Raqam" aria-label="Raqam bo'yicha qidirish" style="width:130px" />
              <input type="date" id="gDay" aria-label="Kun" />
              <label class="check small"><input type="checkbox" id="gAll" /> Bekor qilinganlar</label>
            </div>
            <div class="feed" id="feed"></div>
            <div class="card-body" style="text-align:center"><button class="btn btn-sm" id="moreBtn" hidden>Yana yuklash</button></div>
          </section>
          <aside class="grid" style="gap:16px">
            <section class="card">
              <div class="card-head"><h2>Hozir hovlida</h2><span class="spacer"></span><span class="muted small" id="insideCount"></span></div>
              <div id="inside"></div>
            </section>
            <section class="card">
              <div class="card-head"><h3>GPS bo'yicha hovlida</h3><span class="muted small">kamera kirishi yozilmagan</span></div>
              <div id="gpsOnly"></div>
            </section>
          </aside>
        </div>
      </div>`);
    const feed = $('#feed', main);
    $('#gDay', main).value = f.day;
    $('#gDay', main).max = today();

    const evHtml = (ev, isNew = false) => {
      const [stText, stCls] = GATE_STATUS[ev.status] || [ev.status, ''];
      const title = ev.vehicleLabel || ev.plateText || "Raqam o'qilmadi";
      const sub = [
        ev.vehicleLabel && ev.plateText && ev.plateText.replace(/\s/g, '') !== ev.vehicleLabel.replace(/\s/g, '') ? `Kamera: ${ev.plateText}` : '',
        !ev.vehicleId && ev.plateValid ? "GPS ro'yxatida yo'q" : '',
        ev.staySeconds ? `Ichkarida: ${dur(ev.staySeconds)}` : '',
        ev.note || '',
      ].filter(Boolean).join(' · ');
      return html`<div class="ev ${ev.status === 'vetoed' ? 'vetoed' : ''} ${isNew ? 'new' : ''}" data-id="${ev.id}" role="button" tabindex="0">
        ${ev.photos.length ? html`<img class="ev-thumb" loading="lazy" alt="" src="${ev.photos[0].url}">` : html`<div class="ev-thumb"></div>`}
        <div class="ev-main">
          <div class="ev-line"><span class="dir ${ev.direction}">${ev.direction === 'in' ? 'KIRDI' : 'CHIQDI'}</span><span class="ev-title">${title}</span>
            <span class="pill ${stCls}">${stText}</span></div>
          <div class="ev-sub">${sub || ev.camera}</div>
        </div>
        <div class="ev-time">${hms(ev.t)}<small>${ev.camera}</small></div></div>`;
    };

    const passesFilters = (ev) => (!f.direction || ev.direction === f.direction) && (!f.kind || (f.kind === 'fleet') === !!ev.vehicleId)
      && (f.all || ev.status !== 'vetoed') && (!f.plate || `${ev.plate || ''}${ev.plateRaw || ''}`.includes(f.plate.toUpperCase().replace(/\s/g, '')));
    const matches = (ev) => f.day === today() && passesFilters(ev);

    async function load(append = false) {
      const params = { from: f.day, to: f.day, direction: f.direction, kind: f.kind, plate: f.plate, status: f.all ? 'all' : '', limit: 60 };
      if (append && events.length) params.before = events[events.length - 1].t;
      try {
        const rows = await get(`/api/gate-events?${qs(params)}`);
        events = append ? events.concat(rows) : rows;
        more = rows.length >= 60; // a page can run over: the server keeps events of the same second together
        renderFeed();
      } catch (e) { toastError(e); }
    }
    function renderFeed() {
      setHtml(feed, events.length ? html`${events.map((e) => evHtml(e))}` : html`<div class="empty">${dayLabel(f.day)}: hodisa yo'q</div>`);
      $('#moreBtn', main).hidden = !more;
    }

    async function loadSide() {
      try {
        const [y, t] = await Promise.all([get('/api/yard'), get('/api/today')]);
        renderTiles(t);
        const now = Date.now();
        const insideRow = (x) => {
          const s = x.since ? (now - x.since) / 1000 : null;
          return html`<div class="inside-row ${s > LONG_INSIDE_S ? 'long' : ''}">
            <div><b>${x.vehicleId ? html`<a href="#/transport/${x.vehicleId}">${x.label}</a>` : x.label}</b>
              <div class="small muted">${x.fleet ? 'Avtopark' : 'Begona'}${x.since ? ` · ${when(x.since)} dan` : ''}${x.gpsInYard ? ' · GPS ✓' : x.fleet && x.gpsInYard === null ? " · GPS signal yo'q" : ''}</div></div>
            <div class="dur" data-since="${x.since || ''}">${s != null ? dur(s) : '—'}</div></div>`;
        };
        $('#insideCount', main).textContent = `${y.inside.length} ta`;
        setHtml($('#inside', main), y.inside.length ? html`${y.inside.map(insideRow)}` : html`<div class="empty">Hovli bo'sh (kameralar bo'yicha)</div>`);
        setHtml($('#gpsOnly', main), y.gpsOnly.length ? html`${y.gpsOnly.map(insideRow)}` : html`<div class="empty small">Yo'q</div>`);
      } catch (e) { /* side panel is best effort */ }
    }
    function renderTiles(t) {
      setHtml($('#gTiles', main), html`
        <div class="tile"><span class="tile-label">${icon('in')} Bugun kirdi</span><span class="tile-value">${t.tripsIn}</span><span class="tile-sub">avtopark transportlari</span></div>
        <div class="tile"><span class="tile-label">${icon('out')} Bugun chiqdi</span><span class="tile-value">${t.tripsOut}</span><span class="tile-sub">GPS bilan aniqlanganlar</span></div>
        <div class="tile"><span class="tile-label">${icon('home')} Hozir hovlida</span><span class="tile-value">${t.insideFleet}</span><span class="tile-sub">+ ${t.insideOutside} begona</span></div>
        <div class="tile"><span class="tile-label">${icon('truck')} Begona mashinalar</span><span class="tile-value">${t.outsideIn}</span><span class="tile-sub">bugun kirgan</span></div>`);
    }

    async function openEvent(id) {
      let ev;
      try { ev = await get(`/api/gate-events/${id}`); } catch (e) { return toastError(e); }
      const [stText, stCls] = GATE_STATUS[ev.status] || [ev.status, ''];
      const vehicles = [...state.vehicles.values()].sort((a, b) => a.label.localeCompare(b.label));
      const body = html`
        <div class="photos">${ev.photos.length ? ev.photos.map((p) => html`<figure><img src="${p.url}" alt="${p.name}"><figcaption>${p.name}</figcaption></figure>`) : html`<div class="empty">Rasm yo'q</div>`}</div>
        <dl class="kv">
          <dt>Vaqt</dt><dd>${dayLabel(new Date(ev.t).toLocaleDateString('en-CA', { timeZone: 'Asia/Tashkent' }))}, ${hms(ev.t)}</dd>
          <dt>Kamera</dt><dd>${ev.camera} (${ev.direction === 'in' ? 'kirish' : 'chiqish'})</dd>
          <dt>Raqam</dt><dd>${ev.plateText ? html`<span class="plate-chip">${ev.plateText}</span>` : "o'qilmadi"} ${ev.plateRaw && ev.plateRaw !== ev.plate ? html`<span class="muted small">(kamera o'qidi: ${ev.plateRaw})</span>` : ''}</dd>
          <dt>Transport</dt><dd>${ev.vehicleId ? html`<a href="#/transport/${ev.vehicleId}">${ev.vehicleLabel}</a> <span class="muted small">GPS: ${ev.gpsName}</span>` : 'Avtoparkda emas / aniqlanmadi'}</dd>
          ${ev.identifiedBy ? html`<dt>Aniqlandi</dt><dd>${HOW[ev.identifiedBy] || ev.identifiedBy}</dd>` : ''}
          <dt>Holat</dt><dd><span class="pill ${stCls}">${stText}</span> ${ev.note || ''}</dd>
          ${ev.staySeconds ? html`<dt>Ichkarida</dt><dd>${dur(ev.staySeconds)}</dd>` : ''}
          ${ev.gap ? html`<dt>Eslatma</dt><dd>${ev.direction === 'in' ? 'Oldingi chiqishi qayd etilmagan' : 'Kirishi qayd etilmagan'}</dd>` : ''}
        </dl>
        <div class="card" style="box-shadow:none"><div class="card-body form-row">
          <label class="field"><span>To'g'ri transport</span>
            <select id="evVehicle"><option value="">— Avtoparkda emas —</option>${vehicles.map((v) => html`<option value="${v.id}" ${v.id === ev.vehicleId ? 'selected' : ''}>${v.label}${v.gpsName !== v.label ? ` (GPS: ${v.gpsName})` : ''}</option>`)}</select></label>
          <button class="btn" id="evSave">${icon('check')}<span>Saqlash</span></button>
        </div></div>`;
      const m = modal({ title: `${ev.direction === 'in' ? 'Kirish' : 'Chiqish'}: ${ev.vehicleLabel || ev.plateText || "raqam o'qilmagan"}`, body,
        foot: html`<button class="btn ${ev.status === 'vetoed' ? '' : 'btn-danger'}" id="evHide">${icon('eyeOff')}<span>${ev.status === 'vetoed' ? 'Qaytarish' : "Noto'g'ri hodisa (yashirish)"}</span></button><span style="flex:1"></span><button class="btn" data-close>Yopish</button>` });
      $$('.photos img', m.el).forEach((img) => img.addEventListener('click', () => lightbox(img.src)));
      $('#evSave', m.el).onclick = async () => {
        const v = $('#evVehicle', m.el).value;
        try { await patch(`/api/gate-events/${ev.id}`, { vehicleId: v ? Number(v) : null }); toast({ title: 'Saqlandi', kind: 'good', timeout: 2500 }); m.close(); } catch (e) { toastError(e); }
      };
      $('#evHide', m.el).onclick = async () => {
        try { await patch(`/api/gate-events/${ev.id}`, { hidden: ev.status !== 'vetoed' }); m.close(); } catch (e) { toastError(e); }
      };
    }

    // --- wiring ---
    const seg = (id, key) => $(id, main).addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      f[key] = b.dataset.v;
      $$(`${id} button`, main).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      load();
    });
    seg('#segDir', 'direction');
    seg('#segKind', 'kind');
    $('#gDay', main).addEventListener('change', (e) => { f.day = e.target.value || today(); load(); });
    $('#gAll', main).addEventListener('change', (e) => { f.all = e.target.checked; load(); });
    $('#gPlate', main).addEventListener('input', debounce((e) => { f.plate = e.target.value.trim(); load(); }, 300));
    $('#moreBtn', main).onclick = () => load(true);
    feed.addEventListener('click', (e) => { const r = e.target.closest('.ev'); if (r) openEvent(Number(r.dataset.id)); });
    feed.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const r = e.target.closest('.ev');
      if (r) { e.preventDefault(); openEvent(Number(r.dataset.id)); }
    });

    const sideSoon = debounce(loadSide, 800);
    const offs = [
      state.on('gate', (ev) => {
        if (matches(ev)) {
          events.unshift(ev);
          feed.querySelector('.empty')?.remove();
          feed.insertAdjacentHTML('afterbegin', String(evHtml(ev, true)));
        }
        sideSoon();
      }),
      state.on('gate:update', (ev) => {
        const i = events.findIndex((x) => x.id === ev.id);
        if (i >= 0) {
          const node = feed.querySelector(`.ev[data-id="${CSS.escape(String(ev.id))}"]`);
          if (passesFilters(ev)) {
            events[i] = ev;
            if (node) node.outerHTML = String(evHtml(ev));
          } else {
            // e.g. just hidden, or reassigned while the feed shows outside vehicles only
            events.splice(i, 1);
            node?.remove();
            if (!events.length) renderFeed();
          }
        }
        sideSoon();
      }),
    ];
    const tick = setInterval(() => {
      const now = Date.now();
      for (const d of $$('.dur[data-since]', main)) if (d.dataset.since) d.textContent = dur((now - Number(d.dataset.since)) / 1000);
    }, 30e3);
    const sideTimer = setInterval(loadSide, 120e3);

    await Promise.all([load(), loadSide()]);
    if (query.event) openEvent(Number(query.event));
    void esc;
    return () => { offs.forEach((o) => o()); clearInterval(tick); clearInterval(sideTimer); };
  },
};
