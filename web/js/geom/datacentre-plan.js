// Proposed data centres (brief v2): the plan of what to draw for a site, in
// print millimetres, from its properties.massing, and the solids added to the
// print file when the user asks for them. Uses the print geometry (model.js),
// so it is not packed into the offline viewer: the viewer receives the plan.
import { extrude, concat, clipRing, MM } from './model.js';
import { pointInPolygon, polygonsOf, ringArea } from '../geo.js';
import { DASH_M, GAP_M, EXTENT_GAP_M, EXTENT_STEP_M, lineStyle, groundUnder, placeExtents, labelPoint } from '../scene/datacentre-math.js';

// Polygons ([outer, ...holes] of [x, y] mm) for a lon/lat geometry, clipped to
// the plate inside the terrain-only edge margin (as the OSM buildings are).
export function polysMm(geometry, grid, edge = MM.edge) {
  const out = [];
  const ok = r => r.length >= 3 && Math.abs(ringArea(r)) >= 0.01;
  const inRect = r => r.every(([x, y]) => x > edge && y > edge && x < grid.Wmm - edge && y < grid.Hmm - edge);
  for (const rings of polygonsOf(geometry)) {
    const mm = rings.map(r => r.map(([lon, lat]) => grid.mm(lon, lat)));
    const holes = mm.slice(1).filter(r => inRect(r) && ok(r));
    for (const piece of clipRing(mm[0], edge, edge, grid.Wmm - edge, grid.Hmm - edge).filter(ok)) {
      out.push([piece, ...holes.filter(h => pointInPolygon(h[0][0], h[0][1], [piece]))]);
    }
  }
  return out;
}

// The plan: what to draw for a site, in print mm.
//   items: buildings and placed extents, each { name, kind, evidence, style,
//          heightM, polys, level, low, high, top, source, basis }
//   zones: parameter zones { name, evidence, heightM, polys, centre }
export function planDatacentre(massing, grid, zAt, { buildingExag = 1 } = {}) {
  const mmPerM = grid.mmPerM, step = Math.max(grid.dx, 5 * mmPerM);
  const items = [], zones = [], notes = [];
  let outside = 0;
  for (const b of massing?.buildings || []) {
    if (!Number.isFinite(b.height_m) || !b.geometry) continue;
    const polys = polysMm(b.geometry, grid);
    if (!polys.length) { outside++; continue; }
    const g = groundUnder(polys, zAt, step);
    items.push({ name: b.name, kind: 'building', evidence: b.evidence, style: lineStyle(b.evidence), heightM: b.height_m,
      polys, ...g, top: g.level + b.height_m * buildingExag * mmPerM, source: b.source, basis: b.height_basis });
  }
  for (const z of massing?.zones || []) {
    if (!z.geometry) continue;
    const polys = polysMm(z.geometry, grid);
    if (!polys.length) continue;
    let best = polys[0];
    for (const p of polys) if (Math.abs(ringArea(p[0])) > Math.abs(ringArea(best[0]))) best = p;
    zones.push({ name: z.name, evidence: z.evidence, style: lineStyle(z.evidence), heightM: z.height_m ?? null, polys, centre: labelPoint(best) });
  }
  const e = massing?.extent;
  if (e && !items.length && massing.red_line?.geometry && Number.isFinite(e.area_m2) && Number.isFinite(e.height_m)) {
    const red = polysMm(massing.red_line.geometry, grid);
    const placed = placeExtents(red, { areaMm2: e.area_m2 * mmPerM * mmPerM, count: e.count || 1, gapMm: EXTENT_GAP_M * mmPerM, stepMm: EXTENT_STEP_M * mmPerM }, zAt);
    if (!placed.length) notes.push('the stated footprint does not fit inside the red line on the model');
    placed.forEach((p, i) => {
      const polys = [[p.ring]];
      const g = groundUnder(polys, zAt, step);
      items.push({ name: placed.length > 1 ? `extent ${i + 1}` : 'extent', kind: 'extent', evidence: 'indicative', style: 'dashed', heightM: e.height_m,
        polys, ...g, top: g.level + e.height_m * buildingExag * mmPerM, source: e.source, basis: e.quote });
    });
  }
  return { items, zones, notes, outside, mmPerM, dashMm: DASH_M * mmPerM, gapMm: GAP_M * mmPerM };
}

// Print solids: buried as the OSM buildings are, roof flat (the screen ones are
// built in scene/datacentre.js, from the lowest ground to the roof).
export function printSolid(it) { return concat(it.polys.map(rings => extrude(rings, it.low - MM.buildingBury, it.top))); }
export function datacentrePrintMesh(plan) { return concat(plan.items.map(printSolid)); }

