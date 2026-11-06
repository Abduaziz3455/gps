// App shell: login, role-aware navigation, hash router, live stream, header widgets.
import { api, get, post, state, connectStream } from './api.js';
import { $, $$, html, icon, setHtml, toast, hm, hms, when, esc } from './ui.js';
import { loadPlaces } from './places.js';

// `nav`: in the sidebar and the phone's bottom bar. `section`: a tab of that page (reportTabs in pages/reports.js).
// The rest have their own way in at the top of the screen: the bell for alerts, the user menu for settings.
const PAGES = [
  { path: 'xarita', title: 'Jonli xarita', label: 'Xarita', icon: 'map', nav: true, load: () => import('./pages/live.js') },
  { path: 'darvoza', title: 'Darvoza va hovli', label: 'Darvoza', icon: 'gate', nav: true, load: () => import('./pages/gate.js') },
  { path: 'ogohlantirish', title: 'Ogohlantirishlar', load: () => import('./pages/alerts.js') },
  { path: 'transport', title: 'Transport', label: 'Transport', icon: 'truck', nav: true, load: () => import('./pages/vehicle.js') },
  { path: 'joylar', title: 'Hisobotlar', section: 'hisobot', load: () => import('./pages/places.js') },
  { path: 'reyslar', title: 'Hisobotlar', section: 'hisobot', load: () => import('./pages/trips.js') },
  { path: 'tahlil', title: 'Hisobotlar', section: 'hisobot', load: () => import('./pages/analytics.js'), owner: true },
  { path: 'hisobot', title: 'Hisobotlar', label: 'Hisobot', icon: 'report', nav: true, load: () => import('./pages/reports.js') },
  { path: 'sozlamalar', title: 'Sozlamalar', load: () => import('./pages/settings.js') },
];

let cleanup = null;
let routeSeq = 0; // the latest navigation; pages that finish loading after it are dropped
let stopStream = null;

async function boot() {
  registerSW();
  try {
    state.me = await get('/api/me');
    await startApp();
  } catch (e) {
    if (e.status === 401) showLogin();
    else { $('#boot').innerHTML = `<span>Server bilan aloqa yo'q. <a href="">Qayta urinish</a></span>`; }
  }
}

function showLogin() {
  $('#boot').hidden = true;
  $('#app').hidden = true;
  $('#login').hidden = false;
  const form = $('#loginForm');
  form.username.focus(); // the autofocus attribute does nothing here: the form was hidden when the page loaded
  const showPw = $('#showPw');
  showPw.onchange = () => { form.password.type = showPw.checked ? 'text' : 'password'; };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = $('#loginError');
    err.hidden = true;
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      await post('/api/auth/login', { username: form.username.value.trim(), password: form.password.value });
      state.me = await get('/api/me');
      form.password.value = '';
      form.password.type = 'password';
      showPw.checked = false;
      $('#login').hidden = true;
      await startApp();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally { btn.disabled = false; }
  };
}

async function startApp() {
  const { user } = state.me;
  $('#boot').hidden = true;
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#userName').textContent = user.name;
  $('#userAvatar').textContent = (user.name || user.username).slice(0, 1).toUpperCase();
  $('#userRole').textContent = `${user.username} · ${user.role === 'owner' ? 'Rahbar' : 'Dispetcher'}`;
  setHtml($('#bell'), html`${icon('bell')}<span id="bellCount" class="badge" hidden>0</span>`);
  setHtml($('#themeBtn'), icon('theme'));
  setHtml($('#logoutBtn'), html`${icon('logout')}<span>Chiqish</span>`);
  buildNav();
  wireHeader();
  await loadVehicles();
  await loadPlaces().catch(() => {}); // the app works without them
  stopStream?.();
  stopStream = connectStream();
  wireLive();
  refreshAlertsCount();
  window.addEventListener('hashchange', route);
  route();
  setInterval(tickClock, 1000);
  tickClock();
}

function buildNav() {
  const pages = PAGES.filter((p) => p.nav);
  // Reports open on their first tab, which is the owner's overview.
  const target = (p) => (p.path === 'hisobot' && state.isOwner ? 'tahlil' : p.path);
  const link = (p) => html`<a href="#/${target(p)}" data-path="${p.path}" title="${p.label}">${icon(p.icon)}<span>${p.label}</span></a>`;
  setHtml($('#nav'), html`${pages.map(link)}`);
  setHtml($('#tabbar'), html`${pages.map(link)}`);
}

function wireHeader() {
  $('#themeBtn').onclick = () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('tbb_theme', root.dataset.theme); } catch { /* ignore */ }
    state.emit('theme', root.dataset.theme);
  };
  const drop = $('#userDrop'), btn = $('#userBtn');
  btn.onclick = (e) => { e.stopPropagation(); drop.hidden = !drop.hidden; btn.setAttribute('aria-expanded', String(!drop.hidden)); };
  document.addEventListener('click', () => { drop.hidden = true; btn.setAttribute('aria-expanded', 'false'); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !drop.hidden) { drop.hidden = true; btn.setAttribute('aria-expanded', 'false'); btn.focus(); }
  });
  $('#logoutBtn').onclick = async () => {
    try { await post('/api/auth/logout'); } catch { /* ignore */ }
    location.hash = '';
    location.reload();
  };
  state.on('unauthorized', () => { if (!$('#app').hidden) location.reload(); });
}

async function loadVehicles() {
  const list = await get('/api/vehicles');
  state.vehicles = new Map(list.map((v) => [v.id, v]));
  state.emit('vehicles:changed', null);
}

function wireLive() {
  state.on('positions', (list) => {
    for (const p of list) {
      const cur = state.vehicles.get(p.id);
      if (cur) state.vehicles.set(p.id, { ...cur, ...p });
    }
    state.emit('vehicles:changed', list.map((p) => p.id));
  });
  state.on('vehicles', () => loadVehicles().catch(() => {}));
  // Today's trips and km on the map card come with the vehicle list, so reload it when they change.
  state.on('stats', () => loadVehicles().catch(() => {}));
  // Updates sent while the stream was down (a phone asleep, the network gone) are lost: load the list again when it's back,
  // and every 5 minutes anyway, in case a change got by without telling anyone.
  let streamWasDown = false;
  state.on('stream', (ok) => {
    if (!ok) streamWasDown = true;
    else if (streamWasDown) { streamWasDown = false; loadVehicles().catch(() => {}); }
  });
  setInterval(() => { if (!document.hidden) loadVehicles().catch(() => {}); }, 5 * 60e3);
  state.on('places', () => loadPlaces().catch(() => {}));
  state.on('gate', (ev) => {
    if (ev.status === 'vetoed') return;
    const head = ev.direction === 'in' ? 'KIRDI' : 'CHIQDI';
    toast({ title: `${ev.direction === 'in' ? '🟢' : '🔴'} ${head} · ${ev.vehicleLabel || ev.plateText || "Raqam o'qilmadi"}`,
      body: `${hms(ev.t)} · ${ev.camera}${ev.vehicleId ? '' : ev.plateValid ? " · GPS ro'yxatida yo'q" : ''}`, kind: ev.direction, href: `#/darvoza?event=${ev.id}` });
  });
  state.on('alert', (a) => {
    state.unacked++;
    renderBadges();
    toast({ title: a.title, body: a.body, kind: a.severity === 'critical' ? 'bad' : '', href: '#/ogohlantirish', timeout: a.severity === 'critical' ? 0 : 8000 });
  });
  state.on('alert:update', () => refreshAlertsCount());
  state.on('health', (h) => renderHealth(h));
  state.on('stream', (ok) => {
    state.streamOk = ok;
    if (ok) streamLostAt = null; else if (!streamLostAt) { streamLostAt = Date.now(); setTimeout(renderBanner, 16e3); }
    renderHealth(state.health);
  });
  window.addEventListener('online', renderBanner);
  window.addEventListener('offline', renderBanner);
  setInterval(() => get('/api/health').then(renderHealth).catch(() => renderBanner()), 60e3);
  get('/api/health').then(renderHealth).catch(() => {});
}

async function refreshAlertsCount() {
  try {
    const list = await get('/api/alerts?state=open&limit=500');
    state.unacked = list.length;
    renderBadges();
  } catch { /* ignore */ }
}
function renderBadges() {
  const b = $('#bellCount');
  if (!b) return;
  b.textContent = state.unacked > 99 ? '99+' : String(state.unacked);
  b.hidden = !state.unacked;
}

const STATE_DOT = { ok: 'ok', warn: 'warn', bad: 'bad' };

/** Sidebar status box + the banner over every page. Problems are worded by the server (src/health.js). */
function renderHealth(h) {
  if (h) state.health = h;
  h = state.health;
  const row = (label, cls, title) => html`<div class="health-row" title="${title}"><span class="dot ${cls}"></span><span>${label}</span></div>`;
  const rows = [row('Jonli aloqa', state.streamOk === false ? 'bad' : 'ok', state.streamOk === false ? 'Qayta ulanmoqda…' : 'Ulangan')];
  for (const p of h?.status?.parts || []) {
    rows.push(row(p.state === 'ok' ? p.label : `${p.label} — ${p.state === 'warn' ? 'muammo bor' : 'ishlamayapti'}`, STATE_DOT[p.state] || '', p.detail || p.text));
  }
  if (!h?.status) {
    if (!h?.gps) rows.push(row('GPS ulanmagan', '', ''));
    if (!h?.nvr) rows.push(row('Kameralar ulanmagan', '', ''));
  }
  // All well: one calm line, with the details on hover. Otherwise only what needs attention.
  const problems = rows.filter((r) => !/class="dot ok"/.test(String(r)));
  setHtml($('#healthBox'), problems.length ? html`${problems}` : row('Tizim ishlayapti', 'ok', 'Jonli aloqa, server, GPS, zavod interneti va kameralar ishlayapti'));
  renderBanner();
}

let streamLostAt = null;
/** Banner: this device offline > our server unreachable > problems the server found. */
function renderBanner() {
  const el = $('#sysBanner');
  if (!el) return;
  let items = [];
  if (!navigator.onLine) {
    items = [{ cls: 'bad', title: "Qurilmangizda internet yo'q", text: "Wi-Fi yoki mobil internetni tekshiring. Ma'lumotlar yangilanmayapti." }];
  } else if (state.streamOk === false && streamLostAt && Date.now() - streamLostAt > 15e3) {
    items = [{ cls: 'bad', title: "Dispatcher serveri bilan aloqa yo'q", text: "Sizning internetingiz ishlayapti, lekin server javob bermayapti: server o'chgan yoki qayta ishga tushmoqda. Qayta ulanmoqda…" }];
  } else {
    items = (state.health?.status?.problems || []).map((p) => ({ cls: p.severity === 'critical' ? 'bad' : 'warn', title: p.title, text: p.text, since: p.since }));
  }
  el.hidden = !items.length;
  el.onclick = () => el.classList.toggle('open'); // phones show one line of the text; a tap shows all of it
  setHtml(el, html`${items.slice(0, 3).map((i) => html`<div class="sys-item ${i.cls}">${icon('alert')}<div><b>${i.title}</b>${i.since ? html` <span class="sys-since">· ${when(i.since)} dan beri</span>` : ''}<div class="sys-text">${i.text}</div></div></div>`)}`);
}

function tickClock() {
  $('#clock').textContent = hm(Date.now()) + ' · Toshkent';
}

async function route() {
  const seq = ++routeSeq;
  const hash = location.hash.replace(/^#\/?/, '') || 'xarita';
  const [pathPart, query = ''] = hash.split('?');
  const [path, ...rest] = pathPart.split('/');
  let page = PAGES.find((p) => p.path === path) || PAGES[0];
  if (page.owner && !state.isOwner) page = PAGES[0];
  for (const a of $$('#nav a, #tabbar a')) a.setAttribute('aria-current', a.dataset.path === (page.section || page.path) ? 'page' : 'false');
  $('#bell').setAttribute('aria-current', page.path === 'ogohlantirish' ? 'page' : 'false');
  $('#pageTitle').textContent = page.title;
  document.title = `${page.title} · TBB Dispatcher`;
  $('#modalRoot').innerHTML = '';
  try { cleanup?.(); } catch (e) { console.error(e); }
  cleanup = null;
  const main = $('#main');
  main.innerHTML = '<div class="boot" style="position:absolute"><div class="spinner"></div></div>';
  try {
    const mod = await page.load();
    if (seq !== routeSeq) return;
    // Each page draws into its own box: one that's left mid-load writes to a box no longer on screen.
    const host = document.createElement('div');
    host.style.display = 'contents';
    main.replaceChildren(host);
    main.scrollTop = 0;
    const done = await mod.default.render(host, { params: rest, query: Object.fromEntries(new URLSearchParams(query)), setTitle: (t) => { $('#pageTitle').textContent = t; } });
    if (seq !== routeSeq) { try { done?.(); } catch (e) { console.error(e); } return; }
    cleanup = done;
  } catch (e) {
    console.error(e);
    if (seq === routeSeq) main.innerHTML = `<div class="page"><div class="notice bad">Sahifani ochib bo'lmadi: ${esc(e.message)}</div></div>`;
  }
}

function registerSW() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.type === 'open' && e.data.url) location.hash = e.data.url.replace(/^\/?#/, '#');
  });
}

boot();
export { api };
