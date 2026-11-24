// Browser model builder.
//
// The Python pipeline works with exact polygons (Shapely, triangle,
// manifold3d).  The browser has none of those, so it works on a print-space
// grid instead:
//
//   1. Terrain heights are sampled at every grid vertex (mm, z up).
//   2. Every overlay layer (water, roads, power, rail, residues) is drawn
//      onto a canvas the size of the grid, giving a per-cell mask.
//   3. Overlap priority is resolved per cell (water > roads > power > rail >
//      residues; buildings punch through everything), so no two printed
//      parts occupy the same cell.
//   4. Each mask becomes a watertight draped slab: a top surface over the
//      masked cells, a buried bottom, and walls wherever a masked cell meets
//      an unmasked one.  Same idea as the Python road slabs, at grid
//      resolution.
//   5. Buildings, pylons and the insert are exact extruded solids.
//
// The result is lower resolution than the Python tier (edges follow the
// grid) and has no valley carving; the UI says so.
import earcut from '../../vendor/earcut.js';
import { makeProjection, pointInPolygon, polygonsOf, ringArea } from '../geo.js';
import { RECEPTOR_BUILDINGS } from '../data/overpass.js';

// Print-millimetre constants, matching the Python tier where they overlap.
export const MM = {
  base: 5.0, bury: 1.5, minStrip: 0.8, minRoad: 0.6,
  raise: { water: 0.3, roads: 0.5, power: 0.4, powerLine: 0.35, rail: 0.4, railDisused: 0.25, residues: 0.3 },
  peg: 1.2, turbinePeg: 1.4, outline: 0.6, pointDisc: 1.6,
  buildingMin: 0.6, buildingBury: 1.0,
  clearance: 0.2, recessDepth: 2.0, floorMin: 1.0,
  engrave: 0.4,
  waterDepth: 0.8,      // terrain is cut this far below sea and loch level
  riverSink: 0.25,      // rivers sit this far below their banks
};

const ROAD_WIDTHS = {
  motorway: 14, motorway_link: 8, trunk: 12, trunk_link: 7, primary: 10, primary_link: 6,
  secondary: 8, secondary_link: 5, tertiary: 7, tertiary_link: 5, residential: 6,
  unclassified: 5, living_street: 4, service: 3.5, pedestrian: 4, footway: 1.5,
  cycleway: 2, path: 1.2, track: 3,
};
export const ROAD_PROFILES = {
  'major-only': new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']),
  'major-residential': new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street', 'service', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']),
};
const WATERWAY_WIDTHS = { river: 30, canal: 15, stream: 4, drain: 2, ditch: 2 };
const POWER_AREAS = new Set(['substation', 'plant', 'generator', 'battery', 'switch', 'transformer', 'converter', 'compensator']);

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------
export function makeGrid(bbox, opts) {
  const proj = makeProjection(bbox);
  const mmPerM = opts.printSize / Math.max(proj.widthM, proj.heightM);
  const Wmm = proj.widthM * mmPerM, Hmm = proj.heightM * mmPerM;
  const nx = Math.min(opts.maxCols, Math.round(Wmm / opts.cellMm)) + 1;
  const dx = Wmm / (nx - 1);
  const ny = Math.max(2, Math.round(Hmm / dx)) + 1;
  const dy = Hmm / (ny - 1);
  return { proj, mmPerM, Wmm, Hmm, nx, ny, dx, dy, cx: nx - 1, cy: ny - 1,
    // lon/lat -> print mm
    mm: (lon, lat) => { const [x, y] = proj.toXY(lon, lat); return [x * mmPerM, y * mmPerM]; } };
}

function sampleHeights(grid, elev, opts) {
  const { nx, ny, dx, dy, Hmm, proj, mmPerM } = grid;
  const e = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const [lon, lat] = proj.toLonLat(i * dx / mmPerM, (Hmm - j * dy) / mmPerM);
    e[j * nx + i] = elev.sample(lon, lat);
  }
  const sea = new Uint8Array(nx * ny);
  let min = Infinity, max = -Infinity;
  for (let k = 0; k < e.length; k++) {
    if (e[k] <= 0) { sea[k] = 1; e[k] = 0; }                     // bathymetry clamped to sea level
    min = Math.min(min, e[k]); max = Math.max(max, e[k]);
  }
  const z = new Float32Array(nx * ny);
  const k = opts.zExag * mmPerM;
  for (let i = 0; i < e.length; i++) z[i] = opts.base + (e[i] - min) * k;
  return { z, e, sea, elevMin: min, elevMax: max };
}

// Bilinear terrain height (mm) at print coordinates.
function zSampler(grid, z) {
  const { nx, ny, dx, dy, Hmm } = grid;
  return (x, y) => {
    const fi = Math.min(Math.max(x / dx, 0), nx - 1.0001), fj = Math.min(Math.max((Hmm - y) / dy, 0), ny - 1.0001);
    const i = Math.floor(fi), j = Math.floor(fj), a = fi - i, b = fj - j;
    const v = (ii, jj) => z[jj * nx + ii];
    return (1 - a) * (1 - b) * v(i, j) + a * (1 - b) * v(i + 1, j) + (1 - a) * b * v(i, j + 1) + a * b * v(i + 1, j + 1);
  };
}

// ---------------------------------------------------------------------------
// Rasterising features onto the grid
// ---------------------------------------------------------------------------
function canvasFor(grid) {
  const c = new OffscreenCanvas(grid.cx, grid.cy);
  const g = c.getContext('2d', { willReadFrequently: true });
  // 1 px = 1 cell; draw in print mm with north up.
  g.setTransform(1 / grid.dx, 0, 0, -1 / grid.dy, 0, grid.Hmm / grid.dy);
  g.fillStyle = g.strokeStyle = '#fff';
  g.lineCap = 'butt'; g.lineJoin = 'miter';
  return { c, g };
}

function maskOf({ c, g }) {
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const m = new Uint8Array(c.width * c.height);
  for (let k = 0; k < m.length; k++) m[k] = d[4 * k + 3] > 110 ? 1 : 0;
  return m;
}

function path(g, grid, coords) {
  coords.forEach(([lon, lat], k) => { const [x, y] = grid.mm(lon, lat); k ? g.lineTo(x, y) : g.moveTo(x, y); });
}
function fillPolys(cv, grid, geometry) {
  const { g } = cv;
  for (const rings of polygonsOf(geometry)) {
    g.beginPath(); rings.forEach(r => { path(g, grid, r); g.closePath(); }); g.fill('evenodd');
  }
}
function strokeLine(cv, grid, geometry, widthMm) {
  const { g } = cv;
  g.lineWidth = widthMm;
  const lines = geometry.type === 'LineString' ? [geometry.coordinates]
    : geometry.type === 'MultiLineString' ? geometry.coordinates
    : polygonsOf(geometry).flat();
  for (const l of lines) { g.beginPath(); path(g, grid, l); g.stroke(); }
}
function disc(cv, grid, [lon, lat], dMm) {
  const [x, y] = grid.mm(lon, lat);
  cv.g.beginPath(); cv.g.arc(x, y, dMm / 2, 0, 2 * Math.PI); cv.g.fill();
}
function square(cv, grid, [lon, lat], sideMm) {
  const [x, y] = grid.mm(lon, lat);
  cv.g.fillRect(x - sideMm / 2, y - sideMm / 2, sideMm, sideMm);
}

// ---------------------------------------------------------------------------
// Watertight slab from a cell mask
// ---------------------------------------------------------------------------
export function slabFromMask(grid, mask, topAt, botAt) {
  const { nx, cx, cy } = grid;
  const tId = new Int32Array(nx * grid.ny).fill(-1), bId = new Int32Array(nx * grid.ny).fill(-1);
  const pos = [], idx = [];
  const vert = (ids, v, top) => {
    if (ids[v] < 0) {
      const i = v % nx, j = (v - i) / nx;
      ids[v] = pos.length / 3;
      pos.push(i * grid.dx, grid.Hmm - j * grid.dy, top ? topAt(v) : botAt(v));
    }
    return ids[v];
  };
  const on = (i, j) => i >= 0 && j >= 0 && i < cx && j < cy && mask[j * cx + i];
  for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
    if (!mask[j * cx + i]) continue;
    const a = j * nx + i, b = a + 1, c = a + nx + 1, d = a + nx;   // NW, NE, SE, SW
    const [ta, tb, tc, td] = [a, b, c, d].map(v => vert(tId, v, true));
    const [ba, bb, bc, bd] = [a, b, c, d].map(v => vert(bId, v, false));
    idx.push(td, tc, tb, td, tb, ta);           // top, anticlockwise from above
    idx.push(bd, bb, bc, bd, ba, bb);           // bottom, reversed
    // walls on edges walked anticlockwise (P -> Q): S d->c, E c->b, N b->a, W a->d
    const edges = [[!on(i, j + 1), d, c], [!on(i + 1, j), c, b], [!on(i, j - 1), b, a], [!on(i - 1, j), a, d]];
    for (const [need, P, Q] of edges) {
      if (!need) continue;
      const Pt = vert(tId, P, true), Qt = vert(tId, Q, true), Pb = vert(bId, P, false), Qb = vert(bId, Q, false);
      idx.push(Qt, Pb, Qb, Qt, Pt, Pb);
    }
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

// Cells that touch only at a corner make a non-manifold edge (four wall
// faces share one vertical edge).  Bridge each such contact by filling one
// of the two free cells where no other layer has it; otherwise drop one of
// the touching cells.  Repeat until no diagonal-only contacts remain.
export function fixDiagonals(mask, cx, cy, taken = null) {
  let changed = true, passes = 0;
  const free = k => !mask[k] && (!taken || !taken[k]);
  while (changed && passes++ < 20) {
    changed = false;
    for (let j = 0; j < cy - 1; j++) for (let i = 0; i < cx - 1; i++) {
      const a = j * cx + i, b = a + 1, c = a + cx, d = a + cx + 1;   // a b / c d
      const diag1 = mask[a] && mask[d] && !mask[b] && !mask[c];
      const diag2 = mask[b] && mask[c] && !mask[a] && !mask[d];
      if (!diag1 && !diag2) continue;
      const [x, y] = diag1 ? [b, c] : [a, d];
      if (free(x)) mask[x] = 1;
      else if (free(y)) mask[y] = 1;
      else mask[diag1 ? d : c] = 0;
      changed = true;
    }
  }
  return mask;
}

// Vertex whose every existing neighbouring cell is in the mask.
function vertexAllIn(grid, mask) {
  const { nx, ny, cx, cy } = grid;
  const v = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    let any = false, all = true;
    for (const [ci, cj] of [[i - 1, j - 1], [i, j - 1], [i - 1, j], [i, j]]) {
      if (ci < 0 || cj < 0 || ci >= cx || cj >= cy) continue;
      any = true; if (!mask[cj * cx + ci]) all = false;
    }
    v[j * nx + i] = any && all ? 1 : 0;
  }
  return v;
}

// Sea from OpenStreetMap coastlines. Coastlines are drawn as a barrier that
// divides the grid into regions; each region is then classed as sea or land
// by sampling both sides of every coastline (by OSM convention the land is
// on the left of a coastline way).  Returns null when no coastline is mapped
// here, or when the result fails a sanity check.
export function seaFromCoastlines(grid, coastlines, H, report = {}) {
  if (!coastlines.length) return null;
  const { cx, cy, dx, dy, Hmm } = grid;
  const cv = canvasFor(grid);
  // Clipped coastlines can stop just short of the edge of the model, which
  // would let the fill run round the end. Extend ends near the edge outwards.
  const near = 0.04 * Math.max(grid.Wmm, grid.Hmm), far = 2 * Math.hypot(grid.Wmm, grid.Hmm);
  const edgeDist = ([x, y]) => Math.min(x, y, grid.Wmm - x, Hmm - y);
  const lines = coastlines.map(c => {
    const p = c.geometry.coordinates.map(([lon, lat]) => grid.mm(lon, lat));
    const ext = (a, b) => {          // extend from b through a, beyond the edge
      const L = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
      return [a[0] + (a[0] - b[0]) / L * far, a[1] + (a[1] - b[1]) / L * far];
    };
    if (p.length >= 2 && edgeDist(p[0]) < near) p.unshift(ext(p[0], p[1]));
    if (p.length >= 2 && edgeDist(p.at(-1)) < near) p.push(ext(p.at(-1), p.at(-2)));
    return p;
  });
  // A barrier at least three cells wide, counting any coverage at all, so a
  // 4-connected region can never slip through an anti-aliased diagonal.
  cv.g.lineWidth = 3 * Math.max(dx, dy);
  for (const p of lines) { cv.g.beginPath(); p.forEach(([x, y], k) => k ? cv.g.lineTo(x, y) : cv.g.moveTo(x, y)); cv.g.stroke(); }
  const bd = cv.g.getImageData(0, 0, cx, cy).data;
  const barrier = new Uint8Array(cx * cy);
  for (let k = 0; k < barrier.length; k++) barrier[k] = bd[4 * k + 3] > 0 ? 1 : 0;
  // Label the regions the barrier divides the grid into.
  const comp = new Int32Array(cx * cy).fill(-1);
  let nComp = 0;
  for (let k0 = 0; k0 < comp.length; k0++) {
    if (barrier[k0] || comp[k0] >= 0) continue;
    const stack = [k0]; comp[k0] = nComp;
    while (stack.length) {
      const k = stack.pop(), i = k % cx, j = (k - i) / cx;
      for (const [ii, jj] of [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]]) {
        if (ii < 0 || jj < 0 || ii >= cx || jj >= cy) continue;
        const kk = jj * cx + ii;
        if (!barrier[kk] && comp[kk] < 0) { comp[kk] = nComp; stack.push(kk); }
      }
    }
    nComp++;
  }
  // Each region votes: points just right of a coastline (sea, by OSM
  // convention) count +1, points just left (land) count -1.  A region is
  // sea only if it wins, so a few stray samples across a narrow pier or
  // harbour cannot flood the land.
  const votes = new Float64Array(nComp);
  const cellAt = (x, y) => {
    const i = Math.floor(x / dx), j = Math.floor((Hmm - y) / dy);
    return i < 0 || j < 0 || i >= cx || j >= cy ? -1 : j * cx + i;
  };
  const off = 3.5 * Math.max(dx, dy);
  for (const p of lines) {
    for (let n = 0; n < p.length - 1; n++) {
      const [x0, y0] = p[n], [x1, y1] = p[n + 1], L = Math.hypot(x1 - x0, y1 - y0);
      if (!L) continue;
      const rx = (y1 - y0) / L, ry = -(x1 - x0) / L;          // right-hand normal (y up)
      const steps = Math.max(1, Math.ceil(L / (2 * dx)));
      for (let s = 0; s < steps; s++) {
        const t = (s + 0.5) / steps, x = x0 + t * (x1 - x0), y = y0 + t * (y1 - y0);
        const kr = cellAt(x + rx * off, y + ry * off), kl = cellAt(x - rx * off, y - ry * off);
        if (kr >= 0 && comp[kr] >= 0) votes[comp[kr]] += 1;
        if (kl >= 0 && comp[kl] >= 0) votes[comp[kl]] -= 1;
      }
    }
  }
  const sea = new Uint8Array(cx * cy);
  for (let k = 0; k < sea.length; k++) if (comp[k] >= 0 && votes[comp[k]] > 0) sea[k] = 1;
  // The coastline is the high-water line: barrier cells touching sea join it.
  for (let k = 0; k < sea.length; k++) if (barrier[k]) {
    const i = k % cx, j = (k - i) / cx;
    if ((i > 0 && sea[k - 1]) || (i < cx - 1 && sea[k + 1]) || (j > 0 && sea[k - cx]) || (j < cy - 1 && sea[k + cx])) sea[k] = 2;
  }
  // Sanity check: sea should be low. If the filled side is mostly well above
  // sea level the fill went the wrong way (a broken or clipped coastline).
  const hs = [];
  for (let k = 0; k < sea.length; k += 7) if (sea[k]) {
    const i = k % cx, j = (k - i) / cx; hs.push(H.e[j * grid.nx + i]);
  }
  hs.sort((a, b) => a - b);
  const median = hs.length ? hs[hs.length >> 1] : 0;
  if (!hs.length || median > 8) {
    report.warnings?.push(`Coastline fill rejected (median height of 'sea' ${median.toFixed(1)} m); using elevation instead.`);
    return null;
  }
  report.sea = { source: 'OpenStreetMap coastline', cells: sea.reduce((a, b) => a + (b ? 1 : 0), 0) };
  for (let k = 0; k < sea.length; k++) sea[k] = sea[k] ? 1 : 0;
  return sea;
}

// Per-vertex water surface height (mm).  Sea: sea level.  Lochs, ponds and
// reservoirs: level, at the lowest ground on their shore.  Rivers and burns:
// following the ground, a little below their banks.
function waterLevels(grid, water, sea, lakes, H, zAt, opts, report) {
  const { nx, ny, cx, cy, mmPerM } = grid;
  const zSea = opts.base + (0 - H.elevMin) * opts.zExag * mmPerM;
  const cellLevel = new Float32Array(cx * cy).fill(NaN);
  for (let k = 0; k < cellLevel.length; k++) if (water[k] && sea[k]) cellLevel[k] = zSea;
  let nLakes = 0;
  for (const w of lakes) {
    for (const rs of polygonsOf(w.geometry)) {
      const rings = rs.map(r => r.map(([lon, lat]) => grid.mm(lon, lat)));
      let lvl = Infinity, minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
      for (const [x, y] of rings[0]) {
        lvl = Math.min(lvl, zAt(x, y));
        minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y);
      }
      const i0 = Math.max(0, Math.floor(minx / grid.dx)), i1 = Math.min(cx - 1, Math.ceil(maxx / grid.dx));
      const j0 = Math.max(0, Math.floor((grid.Hmm - maxy) / grid.dy)), j1 = Math.min(cy - 1, Math.ceil((grid.Hmm - miny) / grid.dy));
      let hit = false;
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const k = j * cx + i;
        if (!water[k] || sea[k]) continue;
        if (pointInPolygon((i + 0.5) * grid.dx, grid.Hmm - (j + 0.5) * grid.dy, rings)) {
          cellLevel[k] = Number.isNaN(cellLevel[k]) ? lvl : Math.min(cellLevel[k], lvl); hit = true;
        }
      }
      if (hit) nLakes++;
    }
  }
  const Wv = new Float32Array(nx * ny).fill(Infinity);
  for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
    const k = j * cx + i;
    if (!water[k]) continue;
    for (const v of [j * nx + i, j * nx + i + 1, (j + 1) * nx + i, (j + 1) * nx + i + 1]) {
      const lvl = Number.isNaN(cellLevel[k]) ? H.z[v] - MM.riverSink : cellLevel[k];
      if (lvl < Wv[v]) Wv[v] = lvl;
    }
  }
  const nSea = sea.reduce((a, b) => a + b, 0);
  report.water = { lakes: nLakes, seaCells: nSea, ...(nSea ? { seaLevelMm: +zSea.toFixed(2) } : {}) };
  return Wv;
}

// Vertex is "in" a mask if any of its (up to four) cells is.
function vertexTouches(grid, mask) {
  const { nx, ny, cx, cy } = grid;
  const v = new Uint8Array(nx * ny);
  for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) if (mask[j * cx + i]) {
    const a = j * nx + i; v[a] = v[a + 1] = v[a + nx] = v[a + nx + 1] = 1;
  }
  return v;
}

// ---------------------------------------------------------------------------
// Solids
// ---------------------------------------------------------------------------
// Extrude a polygon (print mm rings, first = outer) between z0 and z1.
export function extrude(rings, z0, z1) {
  const rs = rings.map((r, k) => {
    let rr = r.slice();
    if (rr.length > 1 && rr[0][0] === rr.at(-1)[0] && rr[0][1] === rr.at(-1)[1]) rr.pop();
    const cw = ringArea(rr) > 0;   // outer must be anticlockwise, holes clockwise
    if ((k === 0) === cw) rr.reverse();
    return rr;
  }).filter(r => r.length >= 3);
  if (!rs.length) return null;
  const flat = [], holes = [];
  rs.forEach((r, k) => { if (k) holes.push(flat.length / 2); r.forEach(p => flat.push(p[0], p[1])); });
  const tris = earcut(flat, holes);
  if (!tris.length) return null;
  const n = flat.length / 2, pos = new Float32Array(n * 6), idx = [];
  for (let k = 0; k < n; k++) {
    pos.set([flat[2 * k], flat[2 * k + 1], z0], 3 * k);
    pos.set([flat[2 * k], flat[2 * k + 1], z1], 3 * (n + k));
  }
  for (let t = 0; t < tris.length; t += 3) {
    let [p, q, r] = [tris[t], tris[t + 1], tris[t + 2]];
    // Orient each cap triangle explicitly: anticlockwise from above for the top.
    const cross = (flat[2 * q] - flat[2 * p]) * (flat[2 * r + 1] - flat[2 * p + 1])
                - (flat[2 * q + 1] - flat[2 * p + 1]) * (flat[2 * r] - flat[2 * p]);
    if (cross < 0) [q, r] = [r, q];
    idx.push(n + p, n + q, n + r, p, r, q);
  }
  // Walls: rings are anticlockwise (outer) / clockwise (holes), so the solid
  // is always on the left of P -> Q and the outward side on the right.
  let start = 0;
  for (const r of rs) {
    for (let k = 0; k < r.length; k++) {
      const P = start + k, Q = start + (k + 1) % r.length;
      idx.push(n + Q, P, Q, n + Q, n + P, P);
    }
    start += r.length;
  }
  return { positions: pos, indices: new Uint32Array(idx) };
}

function box(x, y, side, z0, z1) {
  const h = side / 2;
  return extrude([[[x - h, y - h], [x + h, y - h], [x + h, y + h], [x - h, y + h]]], z0, z1);
}

export function concat(meshes) {
  meshes = meshes.filter(m => m && m.indices.length);
  let nv = 0, ni = 0;
  for (const m of meshes) { nv += m.positions.length; ni += m.indices.length; }
  const positions = new Float32Array(nv), indices = new Uint32Array(ni);
  let ov = 0, oi = 0;
  for (const m of meshes) {
    positions.set(m.positions, ov);
    for (let k = 0; k < m.indices.length; k++) indices[oi + k] = m.indices[k] + ov / 3;
    ov += m.positions.length; oi += m.indices.length;
  }
  return { positions, indices };
}

// ---------------------------------------------------------------------------
// Labels (engraved, mirrored, on the underside)
// ---------------------------------------------------------------------------
function labelMask(grid, lines) {
  const { Wmm, Hmm } = grid;
  const cv = canvasFor(grid);
  const g = cv.g;
  // Draw in a "reading" frame, then mirror in x so it reads from below.
  g.save();
  g.transform(-1, 0, 0, -1, Wmm, Hmm);         // undo the north-up flip, mirror x
  g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  const margin = 6, usable = Wmm - 2 * margin;
  let y = margin;
  for (const [text, cap] of lines) {
    const size = cap / 0.72;                    // cap height ≈ 0.72 em
    g.font = `bold ${size}px system-ui, -apple-system, "Segoe UI", Arial, sans-serif`;
    const words = text.split(' '); let line = '';
    const out = [];
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (g.measureText(test).width > usable && line) { out.push(line); line = w; } else line = test;
    }
    if (line) out.push(line);
    for (const l of out) {
      y += cap;
      if (y > Hmm - margin - 16) break;
      g.fillText(l, Wmm / 2, y, usable);
      y += cap * 0.6;
    }
  }
  // North arrow (bottom left) and scale bar (bottom right).
  const s = 12, ax = margin + 6, ay = Hmm - margin - 2;
  g.beginPath(); g.moveTo(ax, ay - s); g.lineTo(ax - 0.38 * s, ay - 0.1 * s); g.lineTo(ax, ay - 0.25 * s); g.lineTo(ax + 0.38 * s, ay - 0.1 * s); g.closePath(); g.fill();
  g.font = `bold ${0.45 * s / 0.72}px system-ui, sans-serif`; g.fillText('N', ax, ay + 0.5);
  const mPerMm = 1 / grid.mmPerM;
  let metres = [2000, 1000, 500, 250, 200, 100, 50, 20, 10].find(m => m / mPerMm <= Math.min(50, usable * 0.4)) || 10;
  const len = metres / mPerMm, bx = Wmm - margin - len;
  g.fillRect(bx, ay - 1.2, len, 1.2); g.fillRect(bx, ay - 3, 0.8, 3); g.fillRect(bx + len - 0.8, ay - 3, 0.8, 3);
  g.font = `bold ${3.6 / 0.72}px system-ui, sans-serif`;
  g.fillText(metres >= 1000 ? `${metres / 1000} km` : `${metres} m`, bx + len / 2, ay - 4.5);
  g.restore();
  return maskOf(cv);
}

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------
export function buildModel({ bbox, elev, osm, opts }) {
  const grid = makeGrid(bbox, opts);
  const { nx, cx, cy, mmPerM } = grid;
  const H = sampleHeights(grid, elev, opts);
  const zAt = zSampler(grid, H.z);
  const minW = MM.minStrip;
  const report = { features: {}, warnings: [] };

  // ---- Buildings (and their footprint mask) ----
  const receptorAreas = osm.features.filter(f => f.layer === 'receptors').flatMap(f => polygonsOf(f.geometry))
    .map(rs => rs.map(r => r.map(([lon, lat]) => grid.mm(lon, lat))));
  const receptorPoints = osm.features.filter(f => f.layer === 'receptors' && f.geometry.type === 'Point')
    .map(f => grid.mm(...f.geometry.coordinates));
  const bCanvas = canvasFor(grid);
  const footprints = [];
  for (const b of osm.buildings) {
    const rings = b.geometry.coordinates.map(r => r.map(([lon, lat]) => grid.mm(lon, lat)));
    const outer = rings[0];
    const inside = outer.some(([x, y]) => x >= 0 && y >= 0 && x <= grid.Wmm && y <= grid.Hmm);
    if (!inside || Math.abs(ringArea(outer)) < 0.04) continue;      // < 0.2 x 0.2 mm
    // clip to the plate by clamping (buildings at the edge are rare and small)
    const clamped = rings.map(r => r.map(([x, y]) => [Math.min(Math.max(x, 0), grid.Wmm), Math.min(Math.max(y, 0), grid.Hmm)]));
    let cxm = 0, cym = 0; outer.forEach(([x, y]) => { cxm += x; cym += y; }); cxm /= outer.length; cym /= outer.length;
    const t = b.tags || {};
    const receptor = b.receptor || RECEPTOR_BUILDINGS.has(t.building) || receptorAreas.some(rs => pointInPolygon(cxm, cym, rs))
      || receptorPoints.some(([px, py]) => pointInPolygon(px, py, clamped));
    footprints.push({ rings: clamped, tags: t, receptor, centre: [cxm, cym] });
    fillPolys(bCanvas, grid, { type: 'Polygon', coordinates: b.geometry.coordinates });
  }
  const buildingMask = maskOf(bCanvas);

  // ---- Overlay masks ----
  const layerCanvas = {};
  const cv = id => (layerCanvas[id] ||= canvasFor(grid));
  // water
  for (const w of osm.water) fillPolys(cv('water'), grid, w.geometry);
  for (const w of osm.waterways) {
    const width = WATERWAY_WIDTHS[w.kind] ?? 4;
    strokeLine(cv('water'), grid, w.geometry, Math.max(width * mmPerM, w.kind === 'river' || w.kind === 'canal' ? minW : MM.minRoad));
  }
  // roads
  const profile = ROAD_PROFILES[opts.roads] || ROAD_PROFILES['major-residential'];
  let nRoads = 0;
  for (const r of osm.roads) {
    if (!profile.has(r.kind)) continue;
    let w = ROAD_WIDTHS[r.kind] ?? 5;
    const tw = parseFloat(r.tags.width); if (!Number.isNaN(tw)) w = tw;
    strokeLine(cv('roads'), grid, r.geometry, Math.max(w * mmPerM, MM.minRoad)); nRoads++;
  }
  // power, rail, residues
  const pegs = [];
  for (const f of osm.features) {
    const g = f.geometry;
    const key = `${f.kind}${f.status === 'existing' ? '' : ` (${f.status})`}`;
    (report.features[f.layer] ||= {})[key] = (report.features[f.layer][key] || 0) + 1;
    if (f.layer === 'power') {
      if ((f.kind === 'line' || f.kind === 'minor_line') && g.type === 'LineString') {
        strokeLine(cv('powerLine'), grid, g, Math.max((f.kind === 'line' ? 10 : 6) * mmPerM, f.kind === 'line' ? 1.0 : minW));
      } else if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
        if (f.status === 'proposed' || f.status === 'construction') strokeLine(cv('power'), grid, g, MM.outline);
        else fillPolys(cv('power'), grid, g);
      } else if (g.type === 'Point') {
        if (POWER_AREAS.has(f.kind)) square(cv('power'), grid, g.coordinates, Math.max(25 * mmPerM, 2));
        else if (opts.pegs && f.kind === 'tower') pegs.push({ at: g.coordinates, side: MM.peg, h: clamp((parseFloat(f.tags.height) || 30) * opts.buildingExag * mmPerM, 1.5, 4) });
        else if (opts.pegs && f.kind.startsWith('generator:wind')) pegs.push({ at: g.coordinates, side: MM.turbinePeg, h: clamp((parseFloat(f.tags.height) || 80) * opts.buildingExag * mmPerM, 2, 6) });
      }
    } else if (f.layer === 'rail' && g.type === 'LineString') {
      if (['tram', 'subway'].includes(f.kind) || f.status === 'proposed') continue;
      const w = Math.max((['rail', 'preserved'].includes(f.kind) ? 6 : 4) * mmPerM, minW);
      strokeLine(cv(f.status === 'disused' ? 'railDisused' : 'rail'), grid, g, w);
    } else if (f.layer === 'residues') {
      if (g.type === 'Point') disc(cv('residues'), grid, g.coordinates, MM.pointDisc);
      else if (g.type !== 'LineString') fillPolys(cv('residues'), grid, g);
    }
  }
  for (const p of pegs) square(cv('pegcut'), grid, p.at, p.side * 1.5);

  // ---- Insert footprint and recess ----
  let insert = null, recess = null;
  if (opts.footprint) {
    const rc = canvasFor(grid);
    fillPolys(rc, grid, opts.footprint);
    strokeLine(rc, grid, opts.footprint, 2 * (MM.clearance + 0.5 * grid.dx));   // grow by the clearance
    recess = maskOf(rc);
  }

  // ---- Resolve overlap priority per cell ----
  const masks = {};
  const order = ['water', 'roads', 'power', 'powerLine', 'rail', 'railDisused', 'residues'];
  const taken = new Uint8Array(cx * cy);
  const pegcut = layerCanvas.pegcut ? maskOf(layerCanvas.pegcut) : null;
  for (let k = 0; k < taken.length; k++) {
    if (buildingMask[k]) taken[k] = 2;                   // buildings punch through overlays
    if (recess && recess[k]) taken[k] = 3;
    if (pegcut && pegcut[k] && !taken[k]) taken[k] = 4;
  }
  // Sea: from OSM coastlines where mapped, otherwise from elevation <= 0.
  let seaCells = seaFromCoastlines(grid, osm.coastlines || [], H, report);
  if (seaCells) {
    // Second check: buildings do not stand in the sea.
    let bIn = 0, bAll = 0;
    for (let k = 0; k < seaCells.length; k++) if (buildingMask[k]) { bAll++; if (seaCells[k]) bIn++; }
    if (bAll && bIn / bAll > 0.05) {
      report.warnings.push(`Coastline fill rejected (${Math.round(100 * bIn / bAll)}% of building cells fell in the sea); using elevation instead.`);
      delete report.sea; seaCells = null;
    }
  }
  if (!seaCells) {
    seaCells = new Uint8Array(cx * cy);
    for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
      const a = j * nx + i;
      if (H.sea[a] && H.sea[a + 1] && H.sea[a + nx] && H.sea[a + nx + 1]) seaCells[j * cx + i] = 1;
    }
  }
  for (const id of order) {
    let m = layerCanvas[id] ? maskOf(layerCanvas[id]) : new Uint8Array(cx * cy);
    if (id === 'water') for (let k = 0; k < m.length; k++) m[k] |= seaCells[k];
    for (let k = 0; k < m.length; k++) {
      if (!m[k]) continue;
      if (taken[k]) { m[k] = 0; continue; }
      taken[k] = 1;
    }
    // Filling a diagonal gap claims the cell, so mark any new cells as taken.
    const before = m.slice();
    fixDiagonals(m, cx, cy, taken);
    for (let k = 0; k < m.length; k++) if (m[k] && !before[k]) taken[k] = 1;
    masks[id] = m;
  }

  // ---- Water levels: sea and lochs are level; rivers sit below their banks ----
  const zTop = Float32Array.from(H.z);
  const W = waterLevels(grid, masks.water, seaCells, osm.water, H, zAt, opts, report);
  {
    // Cut the terrain under water so the water fills a hollow, flush at the shore.
    const all = vertexAllIn(grid, masks.water);
    const floorMin = MM.floorMin + (opts.labels ? MM.engrave : 0);
    for (let v = 0; v < all.length; v++) if (all[v]) zTop[v] = Math.max(Math.min(zTop[v], W[v] - MM.waterDepth), floorMin);
  }

  // ---- Terrain top with the recess ----
  let floor = null;
  const zBefore = Float32Array.from(zTop);   // the land as it is today, without the recess
  if (recess) {
    const rv = vertexTouches(grid, recess);
    let lo = Infinity, hi = -Infinity;
    for (let v = 0; v < rv.length; v++) if (rv[v]) { lo = Math.min(lo, H.z[v]); hi = Math.max(hi, H.z[v]); }
    floor = Math.max(lo - MM.recessDepth, MM.floorMin + (opts.labels ? MM.engrave : 0));
    for (let v = 0; v < rv.length; v++) if (rv[v]) zTop[v] = floor;
    // The insert: exact footprint, from the floor to the stated height above the highest ground.
    const rings = polygonsOf(opts.footprint).map(rs => rs.map(r => r.map(([lon, lat]) => grid.mm(lon, lat))));
    const top = hi + Math.max(opts.insertHeight * opts.buildingExag * mmPerM, 1);
    insert = concat(rings.map(rs => extrude(rs, floor, top)));
    report.insert = {
      heightMm: +(top - floor).toFixed(2), floorMm: +floor.toFixed(2),
      recessDepthMm: +(lo - floor).toFixed(2), clearanceMm: MM.clearance,
      note: 'Browser build: no magnet holes (use the Python tool for those).',
    };
  }

  // ---- Land ----
  const full = new Uint8Array(cx * cy).fill(1);
  let botLand = () => 0;
  if (opts.labels) {
    const lm = labelMask(grid, opts.labels);
    const lv = vertexTouches(grid, lm);
    botLand = v => (lv[v] ? MM.engrave : 0);
  }
  const land = slabFromMask(grid, full, v => zTop[v], botLand);
  // For 'before' views only (never printed): the land without the recess.
  const landBefore = recess ? slabFromMask(grid, full, v => zBefore[v], botLand) : null;

  // ---- Overlay slabs ----
  const slab = (id, raise) => masks[id] ? slabFromMask(grid, masks[id], v => H.z[v] + raise, v => H.z[v] - MM.bury) : null;
  const layers = {
    terrain: land,
    water: masks.water ? slabFromMask(grid, masks.water, v => W[v], v => W[v] - MM.waterDepth - 0.3) : null,
    roads: slab('roads', MM.raise.roads),
    power: concat([slab('power', MM.raise.power), slab('powerLine', MM.raise.powerLine)]),
    rail: slab('rail', MM.raise.rail),
    railDisused: slab('railDisused', MM.raise.railDisused),   // printed with 'rail', drawn in its own colour
    residues: slab('residues', MM.raise.residues),
  };

  // ---- Buildings and receptors ----
  const bl = [], rl = [], cleared = [];
  let inRecess = 0;
  for (const f of footprints) {
    if (recess) {
      const ci = Math.floor(f.centre[0] / grid.dx), cj = Math.floor((grid.Hmm - f.centre[1]) / grid.dy);
      if (ci >= 0 && cj >= 0 && ci < cx && cj < cy && recess[cj * cx + ci]) { inRecess++; f.cleared = true; }
    }
    const outer = f.rings[0];
    let lo = Infinity, hi = -Infinity;
    for (const [x, y] of outer) { const z = zAt(x, y); lo = Math.min(lo, z); hi = Math.max(hi, z); }
    const t = f.tags;
    let h = parseFloat(t.height);
    if (Number.isNaN(h)) h = (parseFloat(t['building:levels']) || 2) * 3;
    const m = extrude(f.rings, lo - MM.buildingBury, hi + Math.max(h * opts.buildingExag * mmPerM, MM.buildingMin));
    if (m) (f.cleared ? cleared : f.receptor ? rl : bl).push(m);
  }
  layers.buildings = concat(bl);
  layers.receptors = concat(rl);
  // pegs on top of the power layer
  const pegMeshes = pegs.map(p => {
    const [x, y] = grid.mm(...p.at);
    const m = p.side;   // keep the whole peg on the plate
    if (x < m || y < m || x > grid.Wmm - m || y > grid.Hmm - m) return null;
    const z0 = zAt(x, y) - MM.bury;
    return box(x, y, p.side, z0, zAt(x, y) + p.h);
  });
  layers.power = concat([layers.power, ...pegMeshes]);

  report.counts = { buildings: bl.length, receptors: rl.length, roads: nRoads, pegs: pegMeshes.filter(Boolean).length, buildingsInRecess: inRecess };
  report.grid = { cols: nx, rows: grid.ny, cellMm: +grid.dx.toFixed(3) };
  report.elevation = { minM: H.elevMin, maxM: H.elevMax };
  // `before`: what the site looks like today, for before/after views (not printed).
  const before = recess ? { terrain: landBefore, buildings: concat(cleared) } : null;
  return { grid, layers, insert, before, report, heights: H.z };
}

function clamp(v, a, b) { return Math.min(Math.max(v, a), b); }

// ---------------------------------------------------------------------------
// Group layers into print objects by preset
// ---------------------------------------------------------------------------
// Shells that touch (a road beside a power strip, terraced houses) share
// exact vertex positions; importers that weld by position then make
// non-manifold edges.  Push repeated positions ~0.5 µm apart, which survives
// the 3MF's 4-decimal coordinates (same fix as the Python tier's
// nudge_duplicate_vertices).
export function nudgeDuplicates(mesh, eps = 0.0005) {
  const P = mesh.positions, seen = new Map();
  for (let k = 0; k < P.length; k += 3) {
    const key = `${Math.round(P[k] * 1e4)},${Math.round(P[k + 1] * 1e4)},${Math.round(P[k + 2] * 1e4)}`;
    const n = seen.get(key) || 0;
    if (n) { P[k] += eps * n; P[k + 1] += eps * n; }
    seen.set(key, n + 1);
  }
  return mesh;
}

const SUBLAYERS = { rail: ['rail', 'railDisused'] };
export function printObjects(model, preset) {
  return preset.objects.map(o => ({
    name: o.name, slot: o.slot, colour: o.colour, layers: o.layers,
    mesh: nudgeDuplicates(concat(o.layers.flatMap(l => SUBLAYERS[l] || [l]).map(l => model.layers[l]).filter(Boolean))),
  }));
}

// Suggested filament-change heights for single-extruder printers.
export function pauseHeights(model, base) {
  const out = [{ zMm: base, changeTo: 'land' }];
  for (const id of ['water', 'roads']) {
    const m = model.layers[id];
    if (!m || !m.positions.length) continue;
    const zs = [];
    for (let k = 2; k < m.positions.length; k += 3) zs.push(m.positions[k]);
    zs.sort((a, b) => a - b);
    out.push({ zMm: +zs[Math.floor(zs.length * 0.75)].toFixed(2), changeTo: id });
  }
  return out.sort((a, b) => a.zMm - b.zMm);
}
