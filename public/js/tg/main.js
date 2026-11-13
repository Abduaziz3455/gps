// The Telegram mini app (docs/telegram-mini-app-plan.md): a small, mostly read-only TBB Dispatcher inside the bot.
// Same server, same API and live stream as the site; Telegram's signed data stands in for the password.
import { api, get, post, del, state, connectStream } from '../api.js';
import { $, $$, html, icon, setHtml, esc, when, modal, toastError } from '../ui.js';
import { loadPlaces } from '../places.js';
import * as tg from './telegram.js';

// Tabs in the bottom bar, then the screens opened from them. `path` is the first part of the address after #/.
const PAGES = [
  { path: 'bugun', title: 'Bugun', icon: 'home', tab: true, load: () => import('./pages/home.js') },
  { path: 'xarita', title: 'Xarita', icon: 'map', tab: true, load: () => import('./pages/map.js') },
  { path: 'darvoza', title: 'Darvoza', icon: 'gate', tab: true, load: () => import('./pages/gate.js') },
  { path: 'hisobot', title: 'Hisobot', icon: 'report', tab: true, load: () => import('./pages/report.js') },
  { path: 'ogohlantirish', title: 'Ogohlantirishlar', load: () => import('./pages/alerts.js') },
  { path: 'e', title: "O'tish", load: () => import('./pages/event.js') },
  { path: 'v', title: 'Transport', load: () => import('./pages/vehicle.js') },
];
const HOME = '#/bugun';

/** A t.me link's start parameter as an address in the app. */
function routeFor(param) {
  const m = /^([eva])(\d*)$/.exec(param || '');
  if (!m) return HOME;
  if (m[1] === 'a') return '#/ogohlantirish';
  return m[2] ? `#/${m[1]}/${m[2]}` : HOME;
}

// --- getting in -------------------------------------------------------------------------------------

async function boot() {
  tg.ready();
  tg.onTheme(applyTheme);
  const data = tg.initData();
  // Telegram's data is in the address now; the app's own addresses replace it.
  const first = routeFor(tg.startParam());
  history.replaceState(null, '', `${location.pathname}${location.hash.startsWith('#/') ? location.hash : first}`);
  if (!data) {
    return message("Telegram ichida oching", "Bu sahifa TBB Dispatcher botining ilovasi. Uni Telegramda botning «Ochish» tugmasi bilan oching.",
      [{ label: "Saytni ochish", href: '/' }]);
  }
  try {
    const r = await post('/api/auth/telegram', { initData: data });
    if (r.linked) return start();
    showLink(data, r.telegram?.name);
  } catch (e) {
    message(e.status === 0 ? "Server bilan aloqa yo'q" : 'Kirib bo\'lmadi', e.message, [{ label: 'Qayta urinish', onClick: () => location.reload() }]);
  }
}

function message(title, text, actions = []) {
  $('#boot').hidden = true;
  $('#app').hidden = true;
  $('#link').hidden = true;
  $('#message').hidden = false;
  $('#messageTitle').textContent = title;
  $('#messageText').textContent = text;
  const box = $('#messageActions');
  box.replaceChildren(...actions.map((a) => {
    const b = document.createElement(a.href ? 'a' : 'button');
    b.className = 'btn btn-primary btn-block tg-big';
    b.textContent = a.label;
    if (a.href) { b.href = a.href; b.addEventListener('click', (e) => { e.preventDefault(); tg.openLink(new URL(a.href, location.origin).href); }); } else b.type = 'button';
    if (a.onClick) b.addEventListener('click', a.onClick);
    return b;
  }));
}

/** First time on this Telegram account: the site's login and password, once. */
function showLink(data, name) {
  $('#boot').hidden = true;
  $('#message').hidden = true;
  $('#link').hidden = false;
  $('#linkWho').textContent = name ? `Telegram: ${name}` : '';
  const form = $('#linkForm');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = $('#linkError');
    err.hidden = true;
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      await post('/api/auth/telegram/link', { initData: data, username: form.username.value.trim(), password: form.password.value });
      form.password.value = '';
      tg.haptic('success');
      $('#link').hidden = true;
      await start();
    } catch (ex) {
      tg.haptic('error');
      err.textContent = ex.message;
      err.hidden = false;
    } finally { btn.disabled = false; }
  };
}

// --- the app ------------------------------------------------------------------------------------------

let started = false;

async function start() {
  state.me = await get('/api/me');
  $('#boot').hidden = true;
  $('#message').hidden = true;
  $('#app').hidden = false;
  if (started) return route();
  started = true;
  const u = state.me.user;
  $('#userBtn').textContent = (u.name || u.username).slice(0, 1).toUpperCase();
  $('#userBtn').onclick = userMenu;
  setHtml($('#bell'), html`${icon('bell')}<span id="bellCount" class="badge" hidden>0</span>`);
  setHtml($('#tabbar'), html`${PAGES.filter((p) => p.tab).map((p) => html`<a href="#/${p.path}" data-path="${p.path}">${icon(p.icon)}<span>${p.title}</span></a>`)}`);
  for (const a of $$('#tabbar a')) a.addEventListener('click', () => tg.haptic('select'));
  await Promise.all([loadVehicles(), loadPlaces().catch(() => {})]);
  connectStream();
  wireLive();
  window.addEventListener('hashchange', route);
  route();
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
  state.on('stats', () => loadVehicles().catch(() => {}));
  state.on('places', () => loadPlaces().catch(() => {}));
  let wasDown = false;
  state.on('stream', (ok) => {
    state.streamOk = ok;
    $('#live').classList.toggle('down', !ok);
    $('#live').title = ok ? 'Jonli aloqa' : 'Qayta ulanmoqda…';
    if (!ok) { wasDown = true; if (!lostAt) { lostAt = Date.now(); setTimeout(renderBanner, 16e3); } }
    else { lostAt = null; if (wasDown) { wasDown = false; loadVehicles().catch(() => {}); refreshAlerts(); } }
    renderBanner();
  });
  // A phone puts the app to sleep: everything may have changed when it wakes.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadVehicles().catch(() => {}); refreshAlerts(); } });
  state.on('alert', () => { state.unacked++; renderBell(); });
  state.on('alert:update', refreshAlerts);
  state.on('health', (h) => { state.health = h; renderBanner(); });
  state.on('unauthorized', reauth);
  window.addEventListener('online', renderBanner);
  window.addEventListener('offline', renderBanner);
  setInterval(() => get('/api/health').then((h) => { state.health = h; renderBanner(); }).catch(() => {}), 60e3);
  get('/api/health').then((h) => { state.health = h; renderBanner(); }).catch(() => {});
  refreshAlerts();
}

/** The session ended (it lasts a day, or the owner unlinked this account): Telegram's data gets a new one. */
let reauthing = null;
function reauth() {
  reauthing ||= post('/api/auth/telegram', { initData: tg.initData() })
    .then((r) => {
      if (r.linked) { route(); return; }
      message("Telegram hisobingiz uzilgan", "Ilovani qayta oching va saytdagi login va parol bilan kiring.", [{ label: 'Qayta ochish', onClick: () => location.reload() }]);
    })
    .catch((e) => message('Qaytadan kiring', e.message, [{ label: 'Qayta ochish', onClick: () => location.reload() }]))
    .finally(() => { setTimeout(() => { reauthing = null; }, 5000); });
}

async function refreshAlerts() {
  try {
    state.unacked = (await get('/api/alerts?state=open&limit=500')).length;
    renderBell();
  } catch { /* ignore */ }
}
function renderBell() {
  const b = $('#bellCount');
  if (!b) return;
  b.textContent = state.unacked > 99 ? '99+' : String(state.unacked);
  b.hidden = !state.unacked;
  state.emit('unacked', state.unacked);
}

let lostAt = null;
/** This phone offline > our server unreachable > what the server's own checks found. */
function renderBanner() {
  const el = $('#sysBanner');
  let items;
  if (!navigator.onLine) items = [{ cls: 'bad', title: "Telefoningizda internet yo'q", text: "Ma'lumotlar yangilanmayapti." }];
  else if (state.streamOk === false && lostAt && Date.now() - lostAt > 15e3) items = [{ cls: 'bad', title: "Server bilan aloqa yo'q", text: 'Qayta ulanmoqda…' }];
  else items = (state.health?.status?.problems || []).map((p) => ({ cls: p.severity === 'critical' ? 'bad' : 'warn', title: p.title, text: p.text, since: p.since }));
  el.hidden = !items.length;
  el.onclick = () => el.classList.toggle('open');
  setHtml(el, html`${items.slice(0, 2).map((i) => html`<div class="sys-item ${i.cls}">${icon('alert')}<div><b>${i.title}</b>${i.since ? html` <span class="sys-since">· ${when(i.since)} dan beri</span>` : ''}<div class="sys-text">${i.text}</div></div></div>`)}`);
}

function userMenu() {
  const u = state.me.user;
  const m = modal({
    title: u.name, size: 'modal-sm tg-sheet',
    body: html`<p class="muted" style="margin:0">${u.username} · ${u.role === 'owner' ? 'Rahbar' : 'Dispetcher'}${u.telegram ? html`<br>Telegram: ${u.telegram.name}` : ''}</p>
      <p class="small muted" style="margin:0">Bu ilovada ko'rish va ogohlantirishlarni belgilash mumkin. Tuzatishlar, tahlil, joylar va sozlamalar to'liq saytda.</p>
      <button class="btn btn-block tg-big" data-site type="button">${icon('map')} To'liq saytni ochish</button>
      <button class="btn btn-danger btn-block tg-big" data-unlink type="button">Telegramni uzish</button>`,
    foot: null,
  });
  m.body.querySelector('[data-site]').onclick = () => tg.openLink(`${location.origin}/`);
  m.body.querySelector('[data-unlink]').onclick = async () => {
    if (!await tg.confirm("Telegram hisobingiz uziladi. Ilovani keyingi safar ochganda login va parol kerak bo'ladi.")) return;
    try {
      await del('/api/me/telegram');
      tg.close();
      m.close();
      message('Telegram uzildi', "Ilovani qayta ochsangiz, login va parol so'raladi.");
    } catch (e) { toastError(e); }
  };
}

function applyTheme(scheme) {
  document.documentElement.dataset.theme = scheme === 'dark' ? 'dark' : 'light';
  state.emit('theme', document.documentElement.dataset.theme);
  const css = getComputedStyle(document.documentElement);
  tg.colors(css.getPropertyValue('--surface').trim() || 'bg_color', css.getPropertyValue('--bg').trim() || 'bg_color');
}

// --- screens ---------------------------------------------------------------------------------------

let cleanup = null;
let seq = 0;
const trail = []; // the screens opened on top of a tab, for Telegram's back button

async function route() {
  const n = ++seq;
  const hash = location.hash.replace(/^#\/?/, '') || 'bugun';
  const [pathPart, q = ''] = hash.split('?');
  const [path, ...params] = pathPart.split('/');
  const page = PAGES.find((p) => p.path === path) || PAGES[0];
  const key = `#/${hash}`;
  if (page.tab) trail.splice(0, trail.length, key);
  else if (trail.at(-2) === key) trail.pop();
  else if (trail.at(-1) !== key) trail.push(key);
  tg.back(page.tab ? null : () => { if (trail.length > 1) history.back(); else location.hash = HOME; });

  for (const a of $$('#tabbar a')) a.setAttribute('aria-current', a.dataset.path === path ? 'page' : 'false');
  $('#bell').setAttribute('aria-current', path === 'ogohlantirish' ? 'page' : 'false');
  $('#pageTitle').textContent = page.title;
  $('#modalRoot').innerHTML = '';
  try { cleanup?.(); } catch (e) { console.error(e); }
  cleanup = null;
  const main = $('#main');
  main.className = `tg-main page-${page.path}`;
  main.innerHTML = '<div class="tg-loading"><div class="spinner"></div></div>';
  try {
    const mod = await page.load();
    if (n !== seq) return;
    const host = document.createElement('div');
    host.className = 'tg-page';
    main.replaceChildren(host);
    main.scrollTop = 0;
    const done = await mod.default.render(host, {
      params, query: Object.fromEntries(new URLSearchParams(q)),
      setTitle: (t) => { $('#pageTitle').textContent = t; },
    });
    if (n !== seq) { try { done?.(); } catch (e) { console.error(e); } return; }
    cleanup = done;
  } catch (e) {
    console.error(e);
    if (n === seq) main.innerHTML = `<div class="tg-page"><div class="notice bad">Ochib bo'lmadi: ${esc(e.message)}</div></div>`;
  }
}

boot();
export { api };
