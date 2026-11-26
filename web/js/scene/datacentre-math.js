// Proposed data centres from the planning record (data-centre brief v2, "calm"):
// the pure part. Plans what to draw from a site's properties.massing, in print
// millimetres, with no three.js, so Node can test it.
//
// What is drawn comes only from the record:
//   documented  (solid line)  council red line, building outlines from a full
//                             application or siting plan, parameter zones
//   indicative  (dashed line) illustrative layouts, and extents placed by us
//                             from a stated footprint where no layout is published
import { pointInPolygon, ringArea } from '../geo.js';

export const DASH_M = 7, GAP_M = 5;           // brief v2: dash 7 m, gap 5 m (world units)
export const EXTENT_ASPECT = 1.5;             // assumed: a placed extent is 1.5 : 1 (long side east-west first)
export const EXTENT_GAP_M = 20;               // assumed: spacing between placed extents
export const EXTENT_STEP_M = 15;              // search step for placing extents

export const lineStyle = evidence => (evidence === 'documented' ? 'solid' : 'dashed');

// Does the site have enough in its record to draw anything (v1 §1c)?
// A building or zone with a height, or a stated extent (area and height).
export function datacentreAvailable(massing) {
  if (!massing) return { ok: false, reason: 'No planning record for this site yet' };
  const hasH = f => Number.isFinite(f?.height_m);
  if ((massing.buildings || []).some(hasH) || (massing.zones || []).some(hasH)) return { ok: true };
  const e = massing.extent;
  if (e && Number.isFinite(e.area_m2) && Number.isFinite(e.height_m)) return { ok: true };
  return { ok: false, reason: 'No published building area or height for this site yet' };
}

export const bboxOf = polys => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of polys) for (const [x, y] of p[0]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0, y0, x1, y1];
};
const inPolys = (x, y, polys) => polys.some(p => pointInPolygon(x, y, p));
// True where (x, y) (print mm) falls inside one of the plan's buildings or extents.
export const insideItems = (items, x, y) => items.some(it => inPolys(x, y, it.polys));

// Ground under a footprint: the median (the platform level), the lowest and the
// highest, from the vertices and a grid of samples inside (step mm).
export function groundUnder(polys, zAt, step) {
  const zs = [];
  for (const p of polys) for (const [x, y] of p[0]) zs.push(zAt(x, y));
  const [x0, y0, x1, y1] = bboxOf(polys);
  for (let y = y0 + step / 2; y < y1; y += step) for (let x = x0 + step / 2; x < x1; x += step) if (inPolys(x, y, polys)) zs.push(zAt(x, y));
  zs.sort((a, b) => a - b);
  return { level: zs[Math.floor(zs.length / 2)], low: zs[0], high: zs.at(-1) };
}

// Extents of a stated footprint (area in mm², `count` of them) placed on the
// flattest ground inside the red line: a window slides over the red line in
// steps, each position fully inside is scored by relief (max - min of a 7 x 5
// sample), and the flattest are kept greedily without overlapping. Deterministic
// (ties by x, then y). Returns [] when none fits.
export function placeExtents(redPolys, { areaMm2, count = 1, aspect = EXTENT_ASPECT, gapMm = 0, stepMm }, zAt) {
  if (!redPolys.length || !(areaMm2 > 0)) return [];
  const [X0, Y0, X1, Y1] = bboxOf(redPolys);
  for (const [w, h] of [[Math.sqrt(areaMm2 * aspect), Math.sqrt(areaMm2 / aspect)], [Math.sqrt(areaMm2 / aspect), Math.sqrt(areaMm2 * aspect)], [Math.sqrt(areaMm2), Math.sqrt(areaMm2)]]) {
    const cands = [];
    const nEdge = Math.max(2, Math.ceil(Math.max(w, h) / stepMm));
    for (let y = Y0; y + h <= Y1; y += stepMm) for (let x = X0; x + w <= X1; x += stepMm) {
      // corners and centre first (cheap rejection), then the whole edge
      const quick = [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x + w / 2, y + h / 2]];
      if (!quick.every(([px, py]) => inPolys(px, py, redPolys))) continue;
      let inside = true;
      for (let k = 1; k < nEdge && inside; k++) {
        const t = k / nEdge;
        for (const [px, py] of [[x + w * t, y], [x + w * t, y + h], [x, y + h * t], [x + w, y + h * t]]) if (!inPolys(px, py, redPolys)) { inside = false; break; }
      }
      if (!inside) continue;
      let lo = Infinity, hi = -Infinity;
      for (let j = 0; j < 5; j++) for (let i = 0; i < 7; i++) { const z = zAt(x + w * i / 6, y + h * j / 4); lo = Math.min(lo, z); hi = Math.max(hi, z); }
      cands.push({ x, y, w, h, relief: hi - lo });
    }
    if (cands.length < count) continue;
    cands.sort((a, b) => a.relief - b.relief || a.x - b.x || a.y - b.y);
    const kept = [];
    for (const c of cands) {
      if (kept.some(k => c.x < k.x + k.w + gapMm && k.x < c.x + c.w + gapMm && c.y < k.y + k.h + gapMm && k.y < c.y + c.h + gapMm)) continue;
      kept.push(c);
      if (kept.length === count) break;
    }
    if (kept.length === count) return kept.map(({ x, y, w, h, relief }) => ({ ring: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], relief }));
  }
  return [];
}

// A point well inside a ring for its label: the centroid if inside, else the
// inside sample farthest from the edge on a coarse grid.
export function labelPoint(poly) {
  const r = poly[0];
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < r.length; i++) {
    const [x0, y0] = r[i], [x1, y1] = r[(i + 1) % r.length], f = x0 * y1 - x1 * y0;
    a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  }
  if (a) { cx /= 3 * a; cy /= 3 * a; if (pointInPolygon(cx, cy, poly)) return [cx, cy]; }
  const [x0, y0, x1, y1] = bboxOf([poly]);
  let best = r[0], bd = -1;
  for (let j = 1; j < 16; j++) for (let i = 1; i < 16; i++) {
    const x = x0 + (x1 - x0) * i / 16, y = y0 + (y1 - y0) * j / 16;
    if (!pointInPolygon(x, y, poly)) continue;
    let d = Infinity;
    for (const [px, py] of r) d = Math.min(d, Math.hypot(px - x, py - y));
    if (d > bd) { bd = d; best = [x, y]; }
  }
  return best;
}

// Lower terrain vertices inside the platforms to the platform level (screen
// only). positions: a Float32Array of x, y, z (print mm, z up), changed in
// place. Returns the changes, [index, old z] pairs, so restoreTerrain can undo them.
export function cutTerrain(positions, items) {
  const changed = [];
  const boxes = items.map(it => bboxOf(it.polys));
  for (let k = 0; k < positions.length; k += 3) {
    const x = positions[k], y = positions[k + 1], z = positions[k + 2];
    for (let i = 0; i < items.length; i++) {
      const [x0, y0, x1, y1] = boxes[i], it = items[i];
      if (x < x0 || x > x1 || y < y0 || y > y1 || z <= it.level) continue;
      if (!inPolys(x, y, it.polys)) continue;
      changed.push(k + 2, z); positions[k + 2] = it.level;
      break;
    }
  }
  return changed;
}
export function restoreTerrain(positions, changed) {
  for (let i = changed.length - 2; i >= 0; i -= 2) positions[changed[i]] = changed[i + 1];
}

// Segments (flat x, y, z pairs) for a ring at height z, closed.
export function ringSegments(ring, z) {
  const out = [];
  for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; out.push(a[0], a[1], z, b[0], b[1], z); }
  return out;
}

// The caption line for a site (screen and saved images; never the print).
export function captionLine(massing, plan, { zExag, inPrint = false } = {}) {
  if (!massing) return null;
  const rl = massing.red_line, parts = [];
  const ref = rl?.ref ? ` (${rl.ref})` : '';
  if (rl) parts.push(`application boundary from the council's public-access map (solid red line)`);
  const docB = plan.items.filter(i => i.kind === 'building' && i.evidence === 'documented');
  const indB = plan.items.filter(i => i.kind === 'building' && i.evidence !== 'documented');
  const ext = plan.items.filter(i => i.kind === 'extent');
  if (docB.length) parts.push(`${docB.length} building outline${docB.length > 1 ? 's' : ''} from the application drawings (solid)`);
  if (indB.length) parts.push(`${indB.length} building position${indB.length > 1 ? 's' : ''} indicative, from the developer's illustrative layout (dashed)`);
  if (plan.zones.length) parts.push(`height-parameter zones from the parameter plan (tint, solid edge)`);
  if (ext.length) {
    const e = massing.extent;
    parts.push(`extent placed by us from the stated footprint (${fmt(e.area_m2)} m²${e.count > 1 ? ` × ${e.count}` : ''}, ${e.stage || 'stated'} stage); no layout published (dashed)`);
  }
  const hs = [...new Set(plan.items.map(i => i.heightM))].sort((a, b) => a - b);
  if (hs.length) parts.push(`heights ${hs.length > 1 ? `${hs[0]}–${hs.at(-1)}` : `~${hs[0]}`} m from the record`);
  if (plan.outside) parts.push(`${plan.outside} further building${plan.outside > 1 ? 's' : ''} in the record lie${plan.outside > 1 ? '' : 's'} outside the model area`);
  if (/PAN$/.test(rl?.ref || '') && ext.length) parts.push('the red line is from the pre-application notice, a different stage from the stated footprint');
  if (zExag) parts.push(`terrain ×${zExag}, buildings true height on level platforms`);
  if (inPrint) parts.push('included in the print file');
  return `Proposed data centre${ref}: ${parts.join('; ')}. Contains OS data © Crown copyright and database right 2026.`;
}
const fmt = n => Math.round(n).toLocaleString('en-GB');
