// Leaflet helpers: themed base map, the yard circle, vehicle markers.
/* global L */
import { state } from './api.js';
import { esc } from './ui.js';

// OpenStreetMap tiles in both themes; the dark theme darkens them with a CSS filter (.map-dark), since the
// free dark tile services now require API keys.
const TILES = { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', attr: '&copy; OpenStreetMap', sub: 'abc', max: 19 };

export const isDark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
};

/** Map with theme-following tiles and the yard circle. Returns {map, destroy}. */
export function createMap(node, { center, zoom = 12 } = {}) {
  const yard = state.me?.yard;
  const map = L.map(node, { zoomControl: true, attributionControl: true, preferCanvas: false })
    .setView(center || (yard ? [yard.lat, yard.lng] : [41.31, 69.28]), zoom);
  L.tileLayer(TILES.url, { attribution: TILES.attr, subdomains: TILES.sub, maxZoom: TILES.max }).addTo(map);
  const setTiles = () => node.classList.toggle('map-dark', isDark());
  setTiles();
  if (yard) {
    L.circle([yard.lat, yard.lng], { radius: yard.radiusM, color: '#2a78d6', weight: 2, dashArray: '6 6', fillOpacity: 0.08, interactive: false }).addTo(map);
    L.marker([yard.lat, yard.lng], { icon: L.divIcon({ className: '', html: `<div class="vm-label" style="top:0;position:relative;transform:translateX(-50%)">${esc(yard.name || 'Hovli')}</div>`, iconSize: [0, 0] }), interactive: false, keyboard: false }).addTo(map);
  }
  const off = state.on('theme', setTiles);
  const mq = matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener?.('change', setTiles);
  const ro = new ResizeObserver(() => map.invalidateSize());
  ro.observe(node);
  return {
    map,
    destroy() { off(); mq.removeEventListener?.('change', setTiles); ro.disconnect(); map.remove(); },
  };
}

const TYPE_PATHS = {
  mixer: '<path d="M2 16V9h5l2-3h4v10"/><path d="M13 8.5 21 6v7l-8 3"/><circle cx="6" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
  dump: '<path d="M2 16v-5h5V7h3v9"/><path d="M10 9l11-3-1 8H10"/><circle cx="6" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
  excavator: '<path d="M3 19h11v-4H3zM5 15v-4h5l2 4"/><path d="M12 11 17 4l4 5-2 2-2-2"/>',
  car: '<path d="M3 15v-3l2-5h14l2 5v3H3Z"/><circle cx="7" cy="16.5" r="1.8"/><circle cx="17" cy="16.5" r="1.8"/>',
  other: '<path d="M3 6h11v10H3zM14 9h4l3 3v4h-7"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
};

function markerHtml(v, selected) {
  const svg = TYPE_PATHS[v.type] || TYPE_PATHS.other;
  return `<div class="vm ${esc(v.status)}${selected ? ' selected' : ''}" title="${esc(v.label)}">
    <div class="vm-pulse"></div>
    <div class="vm-arrow" style="transform:rotate(${Math.round(v.course || 0)}deg)"></div>
    <div class="vm-body"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${svg}</svg></div>
    <div class="vm-label">${esc(v.label)}</div></div>`;
}

/** Keeps one marker per vehicle in sync with state.vehicles. */
export class VehicleLayer {
  constructor(map, { onClick, filter = () => true } = {}) {
    this.map = map;
    this.onClick = onClick;
    this.filter = filter;
    this.markers = new Map();
    this.selected = null;
  }

  sync(ids = null) {
    const list = ids ? ids.map((id) => state.vehicles.get(id)).filter(Boolean) : [...state.vehicles.values()];
    if (!ids) for (const id of this.markers.keys()) if (!state.vehicles.has(id)) { this.markers.get(id).remove(); this.markers.delete(id); }
    for (const v of list) {
      const show = v.lat != null && this.filter(v);
      let m = this.markers.get(v.id);
      if (!show) { if (m) { m.remove(); this.markers.delete(v.id); } continue; }
      const key = `${v.status}|${Math.round(v.course / 10)}|${v.label}|${v.type}|${this.selected === v.id}`;
      if (!m) {
        m = L.marker([v.lat, v.lng], { icon: L.divIcon({ className: '', html: markerHtml(v, this.selected === v.id), iconSize: [40, 40], iconAnchor: [20, 20] }), zIndexOffset: v.status === 'moving' ? 500 : 0, keyboard: false });
        m.on('click', () => this.onClick?.(v.id));
        m._key = key;
        m.addTo(this.map);
        this.markers.set(v.id, m);
      } else {
        animateTo(m, v.lat, v.lng);
        if (m._key !== key) { m.setIcon(L.divIcon({ className: '', html: markerHtml(v, this.selected === v.id), iconSize: [40, 40], iconAnchor: [20, 20] })); m._key = key; }
        m.setZIndexOffset(this.selected === v.id ? 1000 : v.status === 'moving' ? 500 : 0);
      }
    }
  }

  select(id) {
    const prev = this.selected;
    this.selected = id;
    this.sync([prev, id].filter((x) => x != null));
  }

  fit(padding = 40) {
    const pts = [...this.markers.values()].map((m) => m.getLatLng());
    if (pts.length) this.map.fitBounds(L.latLngBounds(pts), { padding: [padding, padding], maxZoom: 15 });
  }

  clear() { for (const m of this.markers.values()) m.remove(); this.markers.clear(); }
}

function animateTo(marker, lat, lng, ms = 900) {
  const from = marker.getLatLng();
  if (Math.abs(from.lat - lat) < 1e-7 && Math.abs(from.lng - lng) < 1e-7) return;
  if (document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) { marker.setLatLng([lat, lng]); return; }
  cancelAnimationFrame(marker._anim);
  const start = performance.now();
  const step = (now) => {
    if (!marker._map) return; // map closed meanwhile
    const k = Math.min(1, (now - start) / ms);
    marker.setLatLng([from.lat + (lat - from.lat) * k, from.lng + (lng - from.lng) * k]);
    if (k < 1) marker._anim = requestAnimationFrame(step);
  };
  marker._anim = requestAnimationFrame(step);
}
