// The context apron (screen only; docs/claude-code-prompt-context-apron-sections.md,
// stage 2): pure functions, no Three.js and no DOM, so Node tests can run them.
//
// The apron is CONTEXT: coarse Copernicus terrain and the main infrastructure in
// a band round the model, drawn beside it and faded toward the background. It is
// never printed. Frame: model mm (x east, y north, z up), as the print mesh.

// ---- the context grid (bundle.context.elevation, int16-dm-rowdelta) ----
// Metres, row 0 at the north edge, vertex-registered.
export function decodeContextGrid(E) {
  const bin = typeof atob === 'function' ? Uint8Array.from(atob(E.data), c => c.charCodeAt(0)) : Uint8Array.from(Buffer.from(E.data, 'base64'));
  const d = new Int16Array(bin.buffer, bin.byteOffset, E.w * E.h), z = new Float32Array(E.w * E.h);
  for (let r = 0; r < E.h; r++) {
    let acc = 0;
    for (let c = 0; c < E.w; c++) { acc += d[r * E.w + c]; z[r * E.w + c] = acc / 10; }
  }
  return z;
}

export const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// Distance (same units as the arguments) from (x, y) to the model rectangle; 0 inside.
export const distOutside = (x, y, Wmm, Hmm) => Math.hypot(Math.max(0, -x, x - Wmm), Math.max(0, -y, y - Hmm));
// How far the land has faded toward the background at distance d outside the
// model: none at the edge (the land runs on from the model), 50% at the pad.
export const LAND_FADE_MAX = 0.5;      // JC, 26 Nov 2026: much lighter haze (was 0.88); the land stays legible
export const landFade = (d, pad) => LAND_FADE_MAX * smoothstep(0, pad, d);
// The first stretch of the apron blends from the model's own land colour at
// its edge into the apron's landscape colour (a fraction of the pad).
// None (JC, 26 Nov 2026): no colour from the model bleeds out. It was 0.2, then 0.04, then 0.01;
// the edge colour is a coarse (96 px) sample of the drape, so buildings, roads and water were averaged and carried out.
export const EDGE_BLEND = 0;
export const edgeBlend = (d, pad) => (EDGE_BLEND > 0 ? smoothstep(0, EDGE_BLEND * pad, d) : 1);
// Lines and symbols fade more weakly (at most 45%).
export const LINE_FADE_MAX = 0.45;
export const lineFade = (d, pad) => LINE_FADE_MAX * smoothstep(0, pad, d);

const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
// The look's land colour, desaturated `desat` toward its own grey (Rec. 709 luma).
export function desaturate(hex, desat = 0.35) {
  const [r, g, b] = rgb(hex), y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return [r, g, b].map(v => v + (y - v) * desat);
}
export const mixRGB = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
export { rgb as hexRGB };

// ---- the mesh ----
// E: bundle.context.elevation; z: its decoded metres; mm: { mmPerM, base, zExag,
// minM } (the model's own terrain mapping: z = base + (e - minM) * zExag * mmPerM,
// sea clamped to 0 m as the model does); Wmm, Hmm: the model; edge: { xs, ys }
// the model's own boundary vertex positions along x (south and north edges) and
// y (west and east), each from 0 to the far side; edgeZ(x, y): the displayed
// model height on its edge; floor: lowest height kept (mm, above the ground plane).
//
// Grid cells inside the model and one ring of cells round it are left out; a
// strip joins that ring to the model's boundary vertices, so apron and model
// share the edge exactly (no seam, no step, no T-junctions).
export function apronMesh({ E, z, mm, Wmm, Hmm, edge, edgeZ, floor = 0.3 }) {
  const { w, h } = E, pc = E.pad_cells_x, pr = E.pad_cells_y, mcx = E.model_cells_x, mcy = E.model_cells_y;
  if (!(pc >= 2 && pr >= 2)) throw new Error('context pad too narrow for the apron');
  const k = mm.zExag * mm.mmPerM;
  const X = c => (E.x0_m + c * E.dx_m) * mm.mmPerM, Y = r => (E.y_top_m - r * E.dy_m) * mm.mmPerM;
  const ex0 = X(0), ex1 = X(w - 1), ey0 = Y(h - 1), ey1 = Y(0);
  const pos = [], uv = [], idx = [], inner = [];
  let clamped = 0;
  const push = (x, y, zz) => { pos.push(x, y, zz); uv.push((x - ex0) / (ex1 - ex0), (y - ey0) / (ey1 - ey0)); return pos.length / 3 - 1; };
  // grid vertices, made on demand (none inside the left-out area)
  const gv = new Int32Array(w * h).fill(-1);
  const g = (c, r) => {
    const q = r * w + c;
    if (gv[q] < 0) {
      let zz = mm.base + (Math.max(0, z[q]) - mm.minM) * k;
      if (zz < floor) { zz = floor; clamped++; }
      gv[q] = push(X(c), Y(r), zz);
    }
    return gv[q];
  };
  const tri = (a, b, c) => {
    // keep every triangle facing up (+z)
    const cr = (pos[3 * b] - pos[3 * a]) * (pos[3 * c + 1] - pos[3 * a + 1]) - (pos[3 * b + 1] - pos[3 * a + 1]) * (pos[3 * c] - pos[3 * a]);
    if (cr >= 0) idx.push(a, b, c); else idx.push(a, c, b);
  };
  const c0 = pc - 1, c1 = pc + mcx + 1, r0 = pr - 1, r1 = pr + mcy + 1;   // the ring round the model (inclusive)
  for (let r = 0; r < h - 1; r++) for (let c = 0; c < w - 1; c++) {
    if (c >= c0 && c < c1 && r >= r0 && r < r1) continue;
    const a = g(c, r), b = g(c + 1, r), d = g(c + 1, r + 1), e = g(c, r + 1);
    tri(a, b, d); tri(a, d, e);
  }
  // the model's boundary vertices (shared at the corners)
  const iv = new Map();
  const ivert = (x, y) => {
    const key = `${x.toFixed(4)},${y.toFixed(4)}`;
    if (!iv.has(key)) { const i = push(x, y, edgeZ(x, y)); iv.set(key, i); inner.push(i); }
    return iv.get(key);
  };
  const xs = edge.xs, ys = edge.ys, rev = a => [...a].reverse();
  const side = (outer, innerPts) => {
    // outer: [[c, r], ...] corner to corner; innerPts: [[x, y], ...] corner to corner
    const P = outer.map(([c, r]) => g(c, r)), Q = innerPts.map(([x, y]) => ivert(x, y));
    const t = (L, i) => i / (L.length - 1);
    const along = (L, get) => { const d = [0]; for (let i = 1; i < L.length; i++) d.push(d[i - 1] + Math.hypot(get(L[i])[0] - get(L[i - 1])[0], get(L[i])[1] - get(L[i - 1])[1])); return d.map(v => v / d[d.length - 1]); };
    const tp = along(P, i => [pos[3 * i], pos[3 * i + 1]]), tq = along(Q, i => [pos[3 * i], pos[3 * i + 1]]);
    void t;
    let i = 0, j = 0;
    while (i < P.length - 1 || j < Q.length - 1) {
      if (j === Q.length - 1 || (i < P.length - 1 && tp[i + 1] <= tq[j + 1])) { tri(P[i], P[i + 1], Q[j]); i++; }
      else { tri(P[i], Q[j + 1], Q[j]); j++; }
    }
  };
  const range = (a, b) => { const o = []; for (let v = a; a <= b ? v <= b : v >= b; v += a <= b ? 1 : -1) o.push(v); return o; };
  side(range(c0, c1).map(c => [c, r1]), xs.map(x => [x, 0]));               // south
  side(range(r1, r0).map(r => [c1, r]), ys.map(y => [Wmm, y]));             // east
  side(range(c1, c0).map(c => [c, r0]), rev(xs).map(x => [x, Hmm]));        // north
  side(range(r0, r1).map(r => [c0, r]), rev(ys).map(y => [0, y]));          // west
  return {
    positions: new Float32Array(pos), uvs: new Float32Array(uv), indices: new Uint32Array(idx), inner: new Uint32Array(inner),
    extent: { x0: ex0, x1: ex1, y0: ey0, y1: ey1 },
    stats: { triangles: idx.length / 3, vertices: pos.length / 3, clamped, edgeVertices: inner.length },
  };
}

// Hillshade of the context grid (the carto look's baked relief, without its
// contours): grey 0-255 per grid vertex, light from the north-west 45° up,
// slopes x2, flat ground at HILLSHADE.flat (as contours.js reliefCanvas).
export function contextShade(z, E, { min = 200, max = 250, flat = 236 } = {}) {
  const { w, h, dx_m: dx, dy_m: dy } = E, out = new Uint8ClampedArray(w * h);
  const L = [-1, 1, Math.SQRT2].map(v => v / 2), ex = 2;
  const at = (c, r) => Math.max(0, z[Math.min(h - 1, Math.max(0, r)) * w + Math.min(w - 1, Math.max(0, c))]);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const gx = (at(c + 1, r) - at(c - 1, r)) / (2 * dx), gy = (at(c, r - 1) - at(c, r + 1)) / (2 * dy);
    const n = [-gx * ex, -gy * ex, 1], l = Math.hypot(...n);
    const lam = Math.max(0, (n[0] * L[0] + n[1] * L[1] + n[2] * L[2]) / l);
    out[r * w + c] = Math.min(max, Math.max(min, flat + 22 * (lam - L[2]) / (1 - L[2] + 1e-6)));
  }
  return out;
}

// ---- the context features, in model mm ----
// elements: bundle.context.osm.elements (Overpass-shaped); toMm(lon, lat) -> [x, y].
// Lines keep their whole geometry: the painter clips them at the model edge.
// Names: places (nodes) and named industrial, quarry and landfill areas, each
// once, placed at the node or the area's centroid; none whose point is inside
// the model (that area belongs to the model).
const ROADS = /^(motorway|trunk|primary|secondary|tertiary|unclassified)(_link)?$/;
export function contextFeatures(elements, toMm, Wmm, Hmm) {
  const V = { roads: [], rail: [], railDisused: [], powerLines: [], waterways: [], lakes: [], pipelines: [], footprints: [], landuse: [] };
  const names = [];
  const line = geom => { const p = []; for (const q of geom) { const [x, y] = toMm(q.lon, q.lat); p.push(+x.toFixed(2), +y.toFixed(2)); } return p; };
  const ringsOf = e => e.type === 'way' ? [line(e.geometry || [])] : (e.members || []).filter(m => m.geometry?.length).map(m => line(m.geometry));
  const closed = e => { const g = e.geometry || []; return g.length > 3 && g[0].lat === g[g.length - 1].lat && g[0].lon === g[g.length - 1].lon; };
  const inside = (x, y) => x >= 0 && y >= 0 && x <= Wmm && y <= Hmm;
  for (const e of elements || []) {
    const t = e.tags || {};
    if (e.type === 'node') {
      if (t.place && t.name) { const [x, y] = toMm(e.lon, e.lat); if (!inside(x, y)) names.push({ name: t.name, kind: t.place, x, y }); }
      continue;
    }
    const area = e.type === 'relation' || closed(e);
    if (t.highway && ROADS.test(t.highway) && e.type === 'way' && t.tunnel !== 'yes') V.roads.push({ k: t.highway, p: line(e.geometry) });
    else if (t.railway === 'rail' && e.type === 'way' && t.tunnel !== 'yes') V.rail.push({ k: 'rail', p: line(e.geometry) });
    else if (t.railway === 'disused' && e.type === 'way') V.railDisused.push({ k: 'rail', p: line(e.geometry) });
    else if ((t.power === 'line' || t.power === 'minor_line') && e.type === 'way') V.powerLines.push({ k: t.power, p: line(e.geometry) });
    else if (t.waterway && e.type === 'way' && t.tunnel !== 'culvert') V.waterways.push({ k: t.waterway, p: line(e.geometry) });
    else if (t.natural === 'water' && area) V.lakes.push({ rings: ringsOf(e) });
    else if (t.man_made === 'pipeline' && e.type === 'way') V.pipelines.push({ p: line(e.geometry), substance: t.substance || null });
    else if (t.building && area) V.footprints.push({ rings: ringsOf(e) });
    else if (t.landuse && area) {
      const rings = ringsOf(e);
      V.landuse.push({ k: t.landuse, rings });
      if (t.name) {
        const c = centroid(rings[0] || []);
        if (c && !inside(c[0], c[1])) names.push({ name: t.name, kind: t.landuse, x: c[0], y: c[1] });
      }
    }
  }
  // one label per name and kind (an area mapped in pieces keeps its largest... first piece)
  const seen = new Set(), uniq = [];
  for (const n of names) { const key = `${n.kind}|${n.name}`; if (!seen.has(key)) { seen.add(key); uniq.push(n); } }
  return { vectors: V, names: uniq };
}
// Area centroid of a ring [x0, y0, x1, y1, ...] (vertex mean for degenerate rings).
export function centroid(r) {
  const n = r.length / 2; if (n < 1) return null;
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, x0 = r[2 * i], y0 = r[2 * i + 1], x1 = r[2 * j], y1 = r[2 * j + 1], f = x0 * y1 - x1 * y0;
    a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-9) { let sx = 0, sy = 0; for (let i = 0; i < n; i++) { sx += r[2 * i]; sy += r[2 * i + 1]; } return [sx / n, sy / n]; }
  return [cx / (3 * a), cy / (3 * a)];
}

// The second line of a context label: what the name is (from its OSM tag).
export const NAME_NOTES = { town: 'town', village: 'village', hamlet: 'hamlet', industrial: 'industrial area',
  quarry: 'quarry', landfill: 'landfill' };

// Labels laid out in screen space: those that would overlap a label already
// placed are dropped (places first, then by size of settlement), so the result
// never stacks. items: [{ x, y (px, the label's bottom centre), w, h, rank }].
export function cullLabels(items, pad = 4) {
  const order = items.map((_, i) => i).sort((a, b) => items[a].rank - items[b].rank);
  const placed = [], keep = new Array(items.length).fill(false);
  for (const i of order) {
    const it = items[i]; if (!it.ok) continue;
    const b = [it.x - it.w / 2 - pad, it.y - it.h - pad, it.x + it.w / 2 + pad, it.y + pad];
    if (placed.some(p => b[0] < p[2] && p[0] < b[2] && b[1] < p[3] && p[1] < b[3])) continue;
    placed.push(b); keep[i] = true;
  }
  return keep;
}
export const NAME_RANK = { town: 0, industrial: 1, quarry: 2, landfill: 2, village: 3, hamlet: 4 };

