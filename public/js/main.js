// App shell: login, role-aware navigation, hash router, live stream, header widgets.
import { api, get, post, state, connectStream } from './api.js';
import { $, $$, html, icon, setHtml, toast, hm, hms, ago, esc } from './ui.js';

const PAGES = [
  { path: 'xarita', title: 'Jonli xarita', label: 'Xarita', icon: 'map', load: () => import('./pages/live.js') },
  { path: 'darvoza', title: 'Darvoza va hovli', label: 'Darvoza', icon: 'gate', load: () => import('./pages/gate.js') },
  { path: 'ogohlantirish', title: 'Ogohlantirishlar', label: 'Ogohlantirish', icon: 'bell', load: () => import('./pages/alerts.js'), badge: true },
  { path: 'transport', title: 'Transport', label: 'Transport', icon: 'truck', load: () => import('./pages/vehicle.js') },
  { path: 'tahlil', title: 'Tahlil', label: 'Tahlil', icon: 'chart', load: () => import('./pages/analytics.js'), owner: true },
  { path: 'hisobot', title: 'Hisobotlar', label: 'Hisobot', icon: 'report', load: () => import('./pages/reports.js') },
  { path: 'sozlamalar', title: 'Sozlamalar', label: 'Sozlamalar', icon: 'settings', load: () => import('./pages/settings.js') },
];

let cleanup = null;
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
  buildNav();
  wireHeader();
  await loadVehicles();
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
  const pages = PAGES.filter((p) => !p.owner || state.isOwner);
  const link = (p) => html`<a href="#/${p.path}" data-path="${p.path}">${icon(p.icon)}<span>${p.label}</span>${p.badge ? html`<span class="badge nav-badge" data-badge hidden>0</span>` : ''}</a>`;
  setHtml($('#nav'), html`${pages.map(link)}`);
  const mobile = pages.filter((p) => ['xarita', 'darvoza', 'ogohlantirish', 'tahlil', 'hisobot', 'sozlamalar'].includes(p.path)).slice(0, 5);
  setHtml($('#tabbar'), html`${mobile.map(link)}`);
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
  state.on('stream', (ok) => { state.streamOk = ok; renderHealth(state.health); });
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
  for (const b of [$('#bellCount'), ...$$('[data-badge]')]) {
    if (!b) continue;
    b.textContent = state.unacked > 99 ? '99+' : String(state.unacked);
    b.hidden = !state.unacked;
  }
}

function renderHealth(h) {
  if (h) state.health = h;
  h = state.health;
  const now = Date.now();
  const row = (label, cls, title) => html`<div class="health-row" title="${title}"><span class="dot ${cls}"></span><span>${label}</span></div>`;
  const rows = [];
  rows.push(row('Jonli aloqa', state.streamOk === false ? 'bad' : 'ok', state.streamOk === false ? 'Qayta ulanmoqda…' : 'Ulangan'));
  if (h?.gps) { const age = h.gps.lastOk ? now - h.gps.lastOk : Infinity; rows.push(row(`GPS · ${h.gps.lastOk ? ago(h.gps.lastOk) : "yo'q"}`, age < 60e3 ? 'ok' : age < 300e3 ? 'warn' : 'bad', h.gps.error || 'GoGPS')); }
  else rows.push(row('GPS ulanmagan', '', ''));
  if (h?.nvr) { const age = h.nvr.lastOk ? now - h.nvr.lastOk : Infinity; rows.push(row(`Kameralar · ${h.nvr.lastOk ? ago(h.nvr.lastOk) : "yo'q"}`, age < 120e3 ? 'ok' : age < 600e3 ? 'warn' : 'bad', h.nvr.error || 'NVR')); }
  else rows.push(row('Kameralar ulanmagan', '', ''));
  setHtml($('#healthBox'), html`${rows}`);
}

function tickClock() {
  $('#clock').textContent = hm(Date.now()) + ' · Toshkent';
}

async function route() {
  const hash = location.hash.replace(/^#\/?/, '') || 'xarita';
  const [pathPart, query = ''] = hash.split('?');
  const [path, ...rest] = pathPart.split('/');
  let page = PAGES.find((p) => p.path === path) || PAGES[0];
  if (page.owner && !state.isOwner) page = PAGES[0];
  for (const a of $$('#nav a, #tabbar a')) a.setAttribute('aria-current', a.dataset.path === page.path ? 'page' : 'false');
  $('#pageTitle').textContent = page.title;
  document.title = `${page.title} · TBB Dispatcher`;
  $('#modalRoot').innerHTML = '';
  try { cleanup?.(); } catch (e) { console.error(e); }
  cleanup = null;
  const main = $('#main');
  main.innerHTML = '<div class="boot" style="position:absolute"><div class="spinner"></div></div>';
  try {
    const mod = await page.load();
    main.innerHTML = '';
    main.scrollTop = 0;
    cleanup = await mod.default.render(main, { params: rest, query: Object.fromEntries(new URLSearchParams(query)), setTitle: (t) => { $('#pageTitle').textContent = t; } });
  } catch (e) {
    console.error(e);
    main.innerHTML = `<div class="page"><div class="notice bad">Sahifani ochib bo'lmadi: ${esc(e.message)}</div></div>`;
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
