'use strict';
/** Uzbek plate validation and misread correction.  */

// 01A123BC (private) and 01123ABC (company).
const FORMATS = [/^(\d{2})[A-Z]\d{3}[A-Z]{2}$/, /^(\d{2})\d{3}[A-Z]{3}$/];
// 01 Tashkent city, 10 Tashkent region, 20 Sirdaryo, 25 Jizzakh, 30 Samarkand, 40 Fergana, 50 Namangan,
// 60 Andijan, 70 Kashkadarya, 75 Surkhandarya, 80 Bukhara, 85 Navoi, 90 Khorezm, 95 Karakalpakstan.
const REGIONS = new Set(['01', '10', '20', '25', '30', '40', '50', '60', '70', '75', '80', '85', '90', '95']);

/** True for a well-formed plate with a real region code. */
function isValid(plate) {
  for (const f of FORMATS) {
    const m = f.exec(plate);
    if (m) return REGIONS.has(m[1]);
  }
  return false;
}

/** Readable form: 85450KBA -> "85 450 KBA", 01A123BC -> "01 A 123 BC". Other reads unchanged. */
function pretty(plate) {
  const m = /^(\d{2})(\d{3})([A-Z]{3})$/.exec(plate) || /^(\d{2})([A-Z])(\d{3})([A-Z]{2})$/.exec(plate);
  return m ? m.slice(1).join(' ') : plate;
}

/** Uppercase, strip junk; null for unread plates ("UNKNOWN", empty). */
function normalize(raw) {
  if (!raw) return null;
  const p = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return !p || p === 'UNKNOWN' ? null : p;
}

/** Levenshtein edit distance. */
function distance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0)));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Snap a misread to a known plate, only when the read itself can't be a real plate.
 *
 * Fleets here have near-identical plates (10835HDA, 10863HDA, 10865HDA are three different trucks),
 * so a read that is already a valid plate is trusted as-is. Invalid reads -- bad region code
 * (05304RAA, 65159YAA) or partial (8594DBA, 304RAA, 01M39) -- are snapped only when exactly one
 * known plate is the closest match; ties are left alone.
 * @param {string} plate normalized read
 * @param {string[]} candidates known plates
 * @param {number} [maxDist]
 */
function correct(plate, candidates, maxDist = 2) {
  if (isValid(plate) || !candidates.length) return plate;
  if (plate.length >= 5) {
    const contains = candidates.filter((c) => c.includes(plate));
    if (contains.length === 1) return contains[0];
  }
  const scored = candidates
    .map((c) => [distance(plate, c), c])
    .sort((x, y) => x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
  const [bestD, best] = scored[0];
  if (bestD > maxDist || (scored.length > 1 && scored[1][0] === bestD)) return plate;
  return best;
}

module.exports = { REGIONS, isValid, pretty, normalize, distance, correct };
