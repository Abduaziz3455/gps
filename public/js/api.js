// API client + live stream (SSE) + shared state.

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, headers: { Accept: 'application/json' }, credentials: 'same-origin' };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(path, opts); } catch { throw new ApiError("Server bilan aloqa yo'q", 0); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/auth/login') {
    state.emit('unauthorized');
  }
  if (!res.ok) throw new ApiError(data.error || `Xatolik (${res.status})`, res.status);
  return data;
}

export const get = (p) => api(p);
export const post = (p, body = {}) => api(p, { method: 'POST', body });
export const patch = (p, body = {}) => api(p, { method: 'PATCH', body });
export const del = (p) => api(p, { method: 'DELETE' });
export const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();

/** Tiny observable app state shared by the pages. */
class State {
  constructor() { this.listeners = new Map(); this.me = null; this.vehicles = new Map(); this.places = []; this.commonPlaces = []; this.ignoredPlaces = []; this.health = null; this.unacked = 0; }
  on(ev, fn) { if (!this.listeners.has(ev)) this.listeners.set(ev, new Set()); this.listeners.get(ev).add(fn); return () => this.listeners.get(ev)?.delete(fn); }
  emit(ev, data) { for (const fn of this.listeners.get(ev) || []) { try { fn(data); } catch (e) { console.error(e); } } }
  get isOwner() { return this.me?.user.role === 'owner'; }
}
export const state = new State();

/** Server-sent events with automatic reconnect; re-emits each event on `state`. */
export function connectStream() {
  let es = null, retry = 2000;
  const open = () => {
    es = new EventSource('/api/stream');
    for (const ev of ['hello', 'positions', 'vehicles', 'places', 'trips', 'stats', 'gate', 'gate:update', 'alert', 'alert:update', 'health']) {
      es.addEventListener(ev, (e) => { retry = 2000; state.emit(ev, JSON.parse(e.data)); });
    }
    es.onopen = () => state.emit('stream', true);
    es.onerror = () => {
      state.emit('stream', false);
      if (es.readyState === EventSource.CLOSED) {
        // The server refused the stream. If the session has ended, this request takes the app back to the login form.
        api('/api/me').catch(() => {});
        setTimeout(open, retry);
        retry = Math.min(retry * 2, 30000);
      }
    };
  };
  open();
  return () => es?.close();
}
