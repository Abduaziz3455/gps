// Places: named areas on the map. Which place a point is in, and the panel that marks or edits one.
/* global L */
import { del, get, patch, post, state } from './api.js';
import { $, confirmDialog, debounce, el, html, icon, toast } from './ui.js';

export const RADIUS = { min: 50, max: 2000, def: 150 };

export function distanceM(aLat, aLng, bLat, bLng) {
  const r = Math.PI / 180;
  const x = Math.sin(((bLat - aLat) * r) / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(((bLng - aLng) * r) / 2) ** 2;
  return 2 * 6371e3 * Math.asin(Math.sqrt(x));
}

/** The place containing this point (the nearest centre when circles overlap), or null. */
export function placeAt(lat, lng) {
  if (lat == null || lng == null) return null;
  let best = null, bestD = Infinity;
  for (const p of state.places) {
    const d = distanceM(lat, lng, p.lat, p.lng);
    if (d <= p.radiusM && d < bestD) { best = p; bestD = d; }
  }
  return best;
}

export function inYard(lat, lng) {
  const y = state.me?.yard;
  return !!y && lat != null && distanceM(lat, lng, y.lat, y.lng) <= y.radiusM;
}

/** The name people use for this point: the yard's, a place's, or null when it only has an address. */
export function nameAt(lat, lng) {
  if (inYard(lat, lng)) return state.me.yard.name;
  return placeAt(lat, lng)?.name || null;
}

export async function loadPlaces() {
  [state.places, state.commonPlaces] = await Promise.all([get('/api/places'), state.isOwner ? get('/api/places/common') : []]);
  state.emit('places:changed');
}

let openPanel = null; // one at a time, on any map

/** Close the panel if it is on this map (leaving the page or the day). */
export function closePanelOf(map) { if (openPanel?.map === map) openPanel.close(); }

/**
 * The panel over a map for naming a spot, or changing a place: name and size, with the circle drawn live.
 * `host` is the positioned box around the map. `common`: a suggested spot, which can also be ignored.
 * Saving tells every open page through `places`.
 */
export function placePanel({ host, map, lat, lng, place = null, common = null, note = '' }) {
  openPanel?.close();
  const radius0 = place?.radiusM ?? RADIUS.def;
  const box = el(html`<form class="place-panel" novalidate aria-label="${place ? 'Joyni tahrirlash' : 'Yangi joy'}">
    <div class="place-panel-head">
      <h3>${place ? 'Joyni tahrirlash' : common ? 'Tavsiya etilgan joy' : 'Yangi joy'}</h3>
      <button type="button" class="icon-btn" data-cancel aria-label="Yopish">${icon('close')}</button>
    </div>
    ${note ? html`<div class="small muted">${note}</div>` : ''}
    <label class="field"><span>Nomi</span><input name="name" maxlength="60" autocomplete="off" placeholder="Masalan: Sergeli obyekti" value="${place?.name || ''}" /></label>
    <div class="field">
      <label for="placeRadius"><span>Hudud radiusi, metr</span></label>
      <div class="place-radius">
        <input type="range" data-range min="${RADIUS.min}" max="${RADIUS.max}" step="10" value="${radius0}" aria-label="Radius" />
        <input type="number" id="placeRadius" data-num min="${RADIUS.min}" max="${RADIUS.max}" step="10" value="${radius0}" />
      </div>
    </div>
    <p class="form-error" data-error hidden></p>
    <div class="place-panel-foot">
      ${place ? html`<button type="button" class="btn btn-sm btn-danger" data-delete>O'chirish</button>` : ''}
      ${common ? html`<button type="button" class="btn btn-sm btn-ghost" data-hide>E'tiborsiz qoldirish</button>` : ''}
      <span class="spacer"></span>
      ${common ? '' : html`<button type="button" class="btn btn-sm" data-cancel>Bekor qilish</button>`}
      <button type="submit" class="btn btn-sm btn-primary">Saqlash</button>
    </div>
  </form>`);
  host.append(box);
  const nameEl = box.elements.name, rangeEl = $('[data-range]', box), numEl = $('[data-num]', box), errEl = $('[data-error]', box);
  const circle = L.circle([lat, lng], { radius: radius0, className: 'place-draft', interactive: false }).addTo(map);

  /** The map stays as the user left it. It only moves, or zooms out, when the circle would not be seen. Never zooms in. */
  const fit = () => {
    // The panel covers the map's right side, except on phones, where it sits under the map.
    const covered = getComputedStyle(box).position === 'absolute' ? box.offsetWidth + 20 : 0;
    const size = map.getSize();
    const seen = L.latLngBounds(map.containerPointToLatLng([0, 0]), map.containerPointToLatLng([size.x - covered, size.y]));
    const b = circle.getBounds();
    if (seen.contains(b)) return;
    map.setView([lat, lng], Math.min(map.getZoom(), map.getBoundsZoom(b, false, L.point(covered + 80, 80))));
  };
  const fitSoon = debounce(() => { if (box.isConnected) fit(); }, 350); // once the size has settled, not on every step
  const close = () => {
    circle.remove();
    box.remove();
    if (openPanel?.close === close) openPanel = null;
  };
  openPanel = { map, close };
  const fail = (e) => { errEl.textContent = e.message; errEl.hidden = false; };
  const setRadius = (v) => { if (v >= RADIUS.min && v <= RADIUS.max) circle.setRadius(v); }; // half-typed numbers are ignored

  rangeEl.addEventListener('input', () => { numEl.value = rangeEl.value; setRadius(Number(rangeEl.value)); fitSoon(); });
  numEl.addEventListener('input', () => { rangeEl.value = numEl.value; setRadius(Number(numEl.value)); fitSoon(); });
  box.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  for (const b of box.querySelectorAll('[data-cancel]')) b.addEventListener('click', close);

  const saved = (title, body) => {
    toast({ title, body, kind: 'good' });
    close();
    state.emit('places'); // this page now; the live stream brings it to the others
  };
  box.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.hidden = true;
    const body = { name: nameEl.value, radiusM: Number(numEl.value) };
    const btn = box.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const r = place ? await patch(`/api/places/${place.id}`, body) : await post('/api/places', { ...body, lat, lng });
      saved(`Saqlandi: ${r.name}`, r.computing ? 'Reyslar hisoblanmoqda…' : '');
    } catch (ex) { fail(ex); btn.disabled = false; }
  });
  $('[data-delete]', box)?.addEventListener('click', async () => {
    if (!await confirmDialog("Joyni o'chirish", `"${place.name}" va uning reyslar statistikasi o'chiriladi.`, "O'chirish", true)) return;
    try {
      await del(`/api/places/${place.id}`);
      saved(`O'chirildi: ${place.name}`, '');
    } catch (ex) { fail(ex); }
  });

  $('[data-hide]', box)?.addEventListener('click', async () => {
    try {
      await post('/api/places/common/hide', { lat, lng });
      saved('Bu joy boshqa taklif qilinmaydi', '');
    } catch (ex) { fail(ex); }
  });

  fit();
  nameEl.focus({ preventScroll: true });
  box.scrollIntoView({ block: 'nearest' });
}
