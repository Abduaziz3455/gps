// Small SVG charts: bars (one series). Thin marks, recessive grid, hover tooltips.
// One measure per chart (no dual axes); colours from CSS tokens (--bar, --seq-1..7).
import { esc } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';

function niceMax(v) {
  if (!v || v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
const fmtTick = (v) => (v >= 1000 ? `${(v / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 }).replace(',', '.')}k` : String(Math.round(v * 10) / 10));

function tooltip(container) {
  let tip = container.querySelector('.tooltip');
  if (!tip) { tip = document.createElement('div'); tip.className = 'tooltip'; tip.hidden = true; container.append(tip); }
  return {
    show(x, y, htmlStr) { tip.innerHTML = htmlStr; tip.style.left = `${x}px`; tip.style.top = `${y}px`; tip.hidden = false; },
    hide() { tip.hidden = true; },
  };
}

/**
 * Bar chart. data: [{label, value, tip?}], opts: {height, unit, labelEvery, highlight(i)}.
 * Bars are 4px-rounded at the data end, anchored to the baseline, with a 2px gap.
 */
export function barChart(container, data, { height = 200, unit = '', labelEvery = 0, valueLabels = false } = {}) {
  container.classList.add('chart');
  container.innerHTML = '';
  const width = Math.max(260, container.clientWidth || 600);
  const pad = { l: 40, r: 8, t: 12, b: 26 };
  const w = width - pad.l - pad.r, h = height - pad.t - pad.b;
  const max = niceMax(Math.max(0, ...data.map((d) => d.value || 0)));
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('height', height);
  svg.setAttribute('role', 'img');
  const ticks = 4;
  let s = '';
  for (let i = 0; i <= ticks; i++) {
    const y = pad.t + h - (h * i) / ticks;
    s += `<line class="grid-line" x1="${pad.l}" x2="${pad.l + w}" y1="${y}" y2="${y}"/>`;
    s += `<text class="axis-text" x="${pad.l - 6}" y="${y + 4}" text-anchor="end">${fmtTick((max * i) / ticks)}</text>`;
  }
  const n = data.length || 1;
  const slot = w / n;
  const bw = Math.max(2, Math.min(36, slot - 2));
  const every = labelEvery || Math.ceil(n / Math.max(1, Math.floor(w / 46)));
  data.forEach((d, i) => {
    const v = Math.max(0, d.value || 0);
    const bh = (v / max) * h;
    const x = pad.l + slot * i + (slot - bw) / 2;
    const y = pad.t + h - bh;
    const r = Math.min(4, bw / 2, bh);
    const path = bh > 0 ? `M${x},${pad.t + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${pad.t + h} Z` : '';
    s += `<g class="col" data-i="${i}"><rect class="bar-hit" x="${pad.l + slot * i}" y="${pad.t}" width="${slot}" height="${h}"/>${path ? `<path class="bar${d.dim ? ' dim' : ''}" d="${path}"/>` : ''}</g>`;
    if (valueLabels && v > 0 && bw >= 18) s += `<text class="axis-text" x="${x + bw / 2}" y="${y - 4}" text-anchor="middle">${fmtTick(v)}</text>`;
    if (i % every === 0) s += `<text class="axis-text" x="${pad.l + slot * i + slot / 2}" y="${height - 8}" text-anchor="middle">${esc(d.label)}</text>`;
  });
  svg.innerHTML = s;
  container.append(svg);
  const tip = tooltip(container);
  svg.addEventListener('mousemove', (e) => {
    const g = e.target.closest('g.col');
    if (!g) return tip.hide();
    const i = Number(g.dataset.i), d = data[i];
    const scale = container.clientWidth / width;
    const x = (pad.l + slot * i + slot / 2) * scale;
    const y = (pad.t + h - (Math.max(0, d.value || 0) / max) * h) * scale;
    tip.show(x, y, d.tip || `<b>${esc(d.label)}</b>: ${esc(fmtTick(d.value || 0))}${unit ? ' ' + esc(unit) : ''}`);
  });
  svg.addEventListener('mouseleave', () => tip.hide());
  return svg;
}

/** Re-render on container resize (debounced). Returns a disposer. */
export function responsive(container, draw) {
  let w = container.clientWidth, t;
  const ro = new ResizeObserver(() => {
    if (Math.abs(container.clientWidth - w) < 8) return;
    w = container.clientWidth;
    clearTimeout(t);
    t = setTimeout(draw, 120);
  });
  ro.observe(container);
  draw();
  return () => ro.disconnect();
}
