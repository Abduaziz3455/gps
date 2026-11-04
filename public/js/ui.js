// Shared UI helpers: safe HTML templating, icons, formatting (Tashkent time), toasts, modals, CSV.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
/** Mark a string as already-safe HTML. */
export const raw = (s) => new Raw(String(s));
/** Tagged template: interpolations are escaped unless raw(); arrays are joined. */
export function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => { out += render(v) + strings[i + 1]; });
  return raw(out);
}
function render(v) {
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  if (v === null || v === undefined || v === false) return '';
  return esc(v);
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function el(markup) {
  const t = document.createElement('template');
  t.innerHTML = String(markup).trim();
  return t.content.firstElementChild;
}
export function setHtml(node, markup) { node.innerHTML = String(markup); return node; }

// --- icons (24x24 stroke) ---
const P = {
  map: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z"/><path d="M9 4v14M15 6v14"/>',
  gate: '<path d="M3 21V8l9-5 9 5v13"/><path d="M7 21v-8h10v8M7 17h10"/>',
  bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  truck: '<path d="M3 6h11v10H3zM14 9h4l3 3v4h-7"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  report: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8Z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  theme: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  route: '<circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h8.5a3.5 3.5 0 0 0 0-7h-9a3.5 3.5 0 0 1 0-7H16"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  home: '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/>',
  pin: '<path d="M12 21s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12Z"/><circle cx="12" cy="9" r="2.5"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  in: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/>',
  out: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  camera: '<path d="M4 7h3l2-3h6l2 3h3v13H4z"/><circle cx="12" cy="13" r="4"/>',
  fuel: '<path d="M4 21V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v16M3 21h13M15 9h2a2 2 0 0 1 2 2v6a1.5 1.5 0 0 0 3 0V8l-3-3"/><path d="M7 7h5"/>',
  alert: '<path d="M12 3 2 20h20Z"/><path d="M12 10v4M12 17.5v.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  print: '<path d="M6 9V3h12v6M6 18H4v-7h16v7h-2M8 14h8v7H8z"/>',
  eyeOff: '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 22 12a14 14 0 0 1-3 3.8M6.6 6.6A14 14 0 0 0 2 12s4 7 10 7a9.6 9.6 0 0 0 4.4-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  speed: '<path d="M12 14l4-4M3.5 17a9 9 0 1 1 17 0"/>',
  mixer: '<path d="M2 16V9h5l2-3h4v10"/><path d="M13 8.5 21 6v7l-8 3"/><circle cx="6" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
  dump: '<path d="M2 16v-5h5V7h3v9"/><path d="M10 9l11-3-1 8H10"/><circle cx="6" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
  excavator: '<path d="M3 19h11v-4H3zM5 15v-4h5l2 4"/><path d="M12 11 17 4l4 5-2 2-2-2"/><circle cx="5.5" cy="19" r="1.5"/><circle cx="11.5" cy="19" r="1.5"/>',
  car: '<path d="M3 15v-3l2-5h14l2 5v3H3Z"/><circle cx="7" cy="16.5" r="1.8"/><circle cx="17" cy="16.5" r="1.8"/><path d="M3 12h18"/>',
};
export function icon(name, cls = '') {
  return raw(`<span class="i ${cls}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${P[name] || P.info}</svg></span>`);
}
export const typeIcon = (type) => icon({ mixer: 'mixer', dump: 'dump', excavator: 'excavator', car: 'car' }[type] || 'truck');

// --- time (Asia/Tashkent) ---
const TZ = 'Asia/Tashkent';
const fTime = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const fTimeS = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const fDay = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
export const MONTHS = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentyabr', 'oktyabr', 'noyabr', 'dekabr'];
export const WEEKDAYS = ['Du', 'Se', 'Ch', 'Pa', 'Ju', 'Sh', 'Ya'];

export const hm = (ms) => (ms ? fTime.format(ms) : '—');
export const hms = (ms) => (ms ? fTimeS.format(ms) : '—');
/** 'YYYY-MM-DD' of the Tashkent day containing `ms`. */
export const dayOf = (ms = Date.now()) => fDay.format(ms);
export const today = () => dayOf(Date.now());
/** A real calendar day: '2026-13-45' matches the pattern but isn't one. Same rule as the server (src/time.js). */
export function isDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s) || s < '2000' || s >= '2101') return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
export function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function dayLabel(day, withYear = false) {
  const [y, m, d] = day.split('-').map(Number);
  return `${d}-${MONTHS[m - 1]}${withYear ? ` ${y}` : ''}`;
}
export const shortDay = (day) => { const [, m, d] = day.split('-'); return `${d}.${m}`; };
/** "14:05" today, "02.11 14:05" otherwise. */
export function when(ms) {
  if (!ms) return '—';
  return dayOf(ms) === today() ? hm(ms) : `${shortDay(dayOf(ms))} ${hm(ms)}`;
}
export function ago(ms, now = Date.now()) {
  if (!ms) return "ma'lumot yo'q";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s} s oldin`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} daq oldin`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} soat oldin`;
  return `${Math.floor(h / 24)} kun oldin`;
}
/** Seconds -> "1 soat 05 daq" / "12 daq". */
export function dur(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} daq`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} soat ${String(m % 60).padStart(2, '0')} daq`;
  return `${Math.floor(h / 24)} kun ${h % 24} soat`;
}
export function num(x, digits = 0) {
  if (x == null || !Number.isFinite(Number(x))) return '—';
  return Number(x).toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits }).replace(/,/g, '.');
}

// --- statuses ---
export const STATUS = {
  moving: 'Harakatda', idle: 'Salt ishlamoqda', stopped: "To'xtagan", offline: "Signal yo'q",
};
export const GATE_STATUS = {
  pending: ['Tekshirilmoqda', 'info'], confirmed: ['GPS tasdiqladi', 'good'], unconfirmed: ['GPS tasdiqlamadi', 'warn'],
  vetoed: ['Bekor qilingan', ''], outside: ['Begona', ''], history: ['GPS tekshiruvisiz', ''],
};
export const statusHtml = (s) => html`<span class="status ${s}">${STATUS[s] || s}</span>`;

// --- toasts ---
export function toast({ title, body = '', kind = '', href = null, timeout = 6000, action = null }) {
  const t = el(`<div class="toast ${esc(kind)}" role="status"${href ? ` data-href="${esc(href)}"` : ''}>
    <div class="toast-title">${esc(title)}</div><button class="icon-btn" aria-label="Yopish">${icon('close')}</button>
    ${body ? `<div class="toast-body">${esc(body)}</div>` : ''}${action ? `<button class="btn btn-sm toast-action" type="button">${esc(action.label)}</button>` : ''}</div>`);
  const close = () => t.remove();
  t.querySelector('.toast-action')?.addEventListener('click', (e) => { e.stopPropagation(); close(); action.onClick(); });
  t.querySelector('button').addEventListener('click', (e) => { e.stopPropagation(); close(); });
  if (href) t.addEventListener('click', () => { location.hash = href.replace(/^\/?#/, '#'); close(); });
  $('#toasts').prepend(t);
  while ($('#toasts').children.length > 4) $('#toasts').lastElementChild.remove();
  if (timeout) setTimeout(close, timeout);
  return t;
}
export const toastError = (e) => toast({ title: 'Xatolik', body: e?.message || String(e), kind: 'bad', timeout: 8000 });

// --- modal ---
export function modal({ title, body = '', foot = '', size = '' }) {
  const back = el(`<div class="modal-backdrop" role="presentation"><div class="modal ${esc(size)}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Yopish">${icon('close')}</button></div>
    <div class="modal-body"></div>${foot !== null ? '<div class="modal-foot"></div>' : ''}</div></div>`);
  const m = back.querySelector('.modal');
  const bodyEl = m.querySelector('.modal-body'), footEl = m.querySelector('.modal-foot');
  if (body instanceof Node) bodyEl.append(body); else bodyEl.innerHTML = String(body);
  if (footEl) { if (foot instanceof Node) footEl.append(foot); else if (foot) footEl.innerHTML = String(foot); else footEl.remove(); }
  const prev = document.activeElement;
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'Tab') {
      // Keep the keyboard inside the dialog (aria-modal): the page behind it can't be used.
      const items = $$('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])', m).filter((x) => x.offsetParent !== null);
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1], cur = document.activeElement;
      if (!m.contains(cur) || (e.shiftKey && cur === first) || (!e.shiftKey && cur === last)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    }
  };
  back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', onKey);
  $('#modalRoot').append(back);
  (m.querySelector('[autofocus]') || m.querySelector('button, input, select'))?.focus();
  return { el: m, body: bodyEl, foot: footEl, close };
}
export function confirmDialog(title, text, okLabel = 'Tasdiqlash', danger = false) {
  return new Promise((resolve) => {
    const m = modal({ title, body: html`<p style="margin:0">${text}</p>`, size: 'modal-sm',
      foot: html`<button class="btn" data-close>Bekor qilish</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${okLabel}</button>` });
    m.foot.querySelector('[data-ok]').addEventListener('click', () => { m.close(); resolve(true); });
    m.foot.querySelector('[data-close]').addEventListener('click', () => resolve(false));
  });
}
export function lightbox(src) {
  const b = el(`<div class="lightbox" role="dialog" aria-label="Rasm"><img alt="" src="${esc(src)}"></div>`);
  const close = () => { b.remove(); document.removeEventListener('keydown', k, true); };
  // Capture phase: Escape closes the photo only, not the dialog it was opened from.
  const k = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  b.addEventListener('click', close);
  document.addEventListener('keydown', k, true);
  document.body.append(b);
}

// --- CSV ---
export function downloadCsv(name, header, rows) {
  const cell = (v) => {
    let s = String(v ?? '');
    // A cell starting like a formula would run in Excel; negative numbers are left alone.
    if (/^[=+@\t\r]|^-(?!\d)/.test(s)) s = `'${s}`;
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = '﻿' + [header, ...rows].map((r) => r.map(cell).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Debounce helper. */
export function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

/** Sortable table header helper: returns sorted copy. */
export function sortRows(rows, key, dir) {
  const m = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = a[key], y = b[key];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * m;
  });
}
