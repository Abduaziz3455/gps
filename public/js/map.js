// Leaflet helpers: themed base map, the yard circle, vehicle markers.
/* global L */
import { state } from './api.js';
import { esc, icon } from './ui.js';

// OpenStreetMap tiles in both themes; the dark theme darkens them with a CSS filter (.map-dark), since the
// free dark tile services now require API keys.
// Tiles come through our own server (src/tiles.js): OpenStreetMap blocks browser requests without a Referer, and
// browsers, extensions and privacy settings can all strip it.
const TILES = { url: '/api/tiles/{z}/{x}/{y}', attr: '&copy; OpenStreetMap', max: 19 };

export const isDark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
};

const NEAR_ZOOM = 16; // from here parked trucks are far enough apart to show their labels
const YARD_MIN_RADIUS_PX = 24; // the marker keeps the yard this big on screen; 150 m is about 5 px at city zoom

/** The yard's true area, plus a marker that keeps it findable, and its name over the trucks, at any zoom. */
function drawYard(map, yard) {
  const at = [yard.lat, yard.lng];
  L.circle(at, { radius: yard.radiusM, className: 'yard-area', interactive: false }).addTo(map);
  const pin = (html, zIndexOffset) => L.marker(at, { icon: L.divIcon({ className: '', iconSize: [0, 0], html }), interactive: false, keyboard: false, zIndexOffset }).addTo(map);
  const halo = pin('<div class="yard-mark"><div class="yard-halo"></div></div>', -1000);
  const label = pin(`<div class="yard-mark"><div class="yard-label">${icon('home')}<span>${esc(yard.name)}</span></div></div>`, 900);
  const update = () => {
    const centre = map.latLngToContainerPoint(at);
    const edge = map.latLngToContainerPoint([yard.lat + yard.radiusM / 111320, yard.lng]);
    const r = Math.abs(centre.y - edge.y);
    halo.getElement().querySelector('.yard-halo').hidden = r >= YARD_MIN_RADIUS_PX;
    label.getElement().querySelector('.yard-label').style.setProperty('--yard-r', `${Math.max(r, YARD_MIN_RADIUS_PX)}px`);
  };
  map.on('zoomend', update);
  update();
}

/** Working trucks are drawn over parked ones; the selected one over everything. */
const markerZ = (v, selected) => (selected ? 1000 : { moving: 500, idle: 400, stopped: 100 }[v.status] || 0);

/** Map with theme-following tiles and the yard circle. Returns {map, destroy}. */
export function createMap(node, { center, zoom = 12 } = {}) {
  const yard = state.me?.yard;
  const map = L.map(node, { zoomControl: true, attributionControl: true, preferCanvas: false })
    .setView(center || (yard ? [yard.lat, yard.lng] : [41.31, 69.28]), zoom);
  L.tileLayer(TILES.url, { attribution: TILES.attr, maxZoom: TILES.max }).addTo(map);
  const setTiles = () => node.classList.toggle('map-dark', isDark());
  setTiles();
  if (yard) drawYard(map, yard);
  const setZoom = () => node.classList.toggle('map-near', map.getZoom() >= NEAR_ZOOM);
  map.on('zoomend', setZoom);
  setZoom();
  const off = state.on('theme', setTiles);
  const mq = matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener?.('change', setTiles);
  const ro = new ResizeObserver(() => map.invalidateSize());
  ro.observe(node);
  return {
    map,
    destroy() {
      off(); mq.removeEventListener?.('change', setTiles); ro.disconnect();
      // Leaving mid-zoom: Leaflet's pending zoom-end timer would run on the removed map.
      map._animatingZoom = false; // its zoom-end timer returns early when no zoom is in progress
      map.stop();
      map.remove();
    },
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

const BODY_R = { moving: 18, idle: 16, stopped: 11, offline: 10 }; // radius of each marker in .vm-body, px

function circleHits(c, r, box) {
  const dx = c.x - Math.max(box.l, Math.min(c.x, box.r));
  const dy = c.y - Math.max(box.t, Math.min(c.y, box.b));
  return dx * dx + dy * dy < r * r;
}

/** Keeps one marker per vehicle in sync with state.vehicles. */
export class VehicleLayer {
  constructor(map, { onClick, filter = () => true } = {}) {
    this.map = map;
    this.onClick = onClick;
    this.filter = filter;
    this.markers = new Map();
    this.selected = null;
    map.on('zoomend', () => this.declutter());
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
        m = L.marker([v.lat, v.lng], { icon: L.divIcon({ className: '', html: markerHtml(v, this.selected === v.id), iconSize: [40, 40], iconAnchor: [20, 20] }), zIndexOffset: markerZ(v, this.selected === v.id), keyboard: false });
        m.on('click', () => this.onClick?.(v.id));
        m._key = key;
        m.addTo(this.map);
        this.markers.set(v.id, m);
      } else {
        animateTo(m, v.lat, v.lng);
        if (m._key !== key) { m.setIcon(L.divIcon({ className: '', html: markerHtml(v, this.selected === v.id), iconSize: [40, 40], iconAnchor: [20, 20] })); m._key = key; }
        m.setZIndexOffset(markerZ(v, this.selected === v.id));
      }
    }
    this.declutter();
  }

  /**
   * Labels that would land on another label, or on a working truck, step aside; hover or tap still shows them.
   * Working trucks choose first, so the labels that stay are the ones that matter. Works from the sizes the CSS
   * draws: measuring every label would force a layout on each update.
   */
  declutter() {
    const near = this.map.getZoom() >= NEAR_ZOOM;
    const items = [];
    for (const [id, m] of this.markers) {
      const v = state.vehicles.get(id);
      const vm = m.getElement()?.querySelector('.vm');
      if (!v || !vm) continue;
      const p = this.map.latLngToContainerPoint(m.getLatLng());
      items.push({ v, vm, p, active: v.status === 'moving' || v.status === 'idle', rank: id === this.selected ? -1 : markerZ(v) * -1 });
    }
    items.sort((a, b) => a.rank - b.rank);
    const placed = [];
    const yard = state.me?.yard;
    if (yard) {
      const y = this.map.latLngToContainerPoint([yard.lat, yard.lng]);
      const w = yard.name.length * 7 + 34;
      placed.push({ l: y.x - w / 2, r: y.x + w / 2, t: y.y - YARD_MIN_RADIUS_PX - 30, b: y.y - YARD_MIN_RADIUS_PX - 3 });
    }
    const body = (i) => BODY_R[i.v.status] || 10;
    for (const i of items) {
      const top = i.active ? 20 : 12;
      const w = i.v.label.length * 6.7 + 12;
      const box = { l: i.p.x - w / 2, r: i.p.x + w / 2, t: i.p.y + top, b: i.p.y + top + 17 };
      const onLabel = placed.some((o) => box.l < o.r && o.l < box.r && box.t < o.b && o.t < box.b);
      const onTruck = items.some((o) => o !== i && (o.active || !i.active) && circleHits(o.p, body(o), box));
      const wanted = i.active || near;
      const show = wanted && (i.v.id === this.selected || !(onLabel || onTruck));
      i.vm.classList.toggle('no-label', !show);
      if (show) placed.push(box);
    }
  }

  select(id) {
    const prev = this.selected;
    this.selected = id;
    this.sync([prev, id].filter((x) => x != null));
  }

  fit(padding = 48, animate = true) {
    const pts = [...this.markers.values()].map((m) => m.getLatLng());
    const yard = state.me?.yard;
    if (pts.length && yard) pts.push(L.latLng(yard.lat, yard.lng));
    if (pts.length) this.map.fitBounds(L.latLngBounds(pts), { padding: [padding, padding], maxZoom: 15, animate });
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
