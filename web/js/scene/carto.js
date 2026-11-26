// The Anthropogenic look's painted surface (brief Stage 2): one drape that
// carries the land cover, baked relief, brushwork, woodland symbols, water,
// routes, residues and building footprints, for an unlit terrain material
// (like a printed relief map). Screen only: nothing here reaches a print file.
//
// Nothing painted stands for a feature that is not in the data: woodland
// crowns are symbols (at canopy-model tree tops where the site bundle has
// them, else on a grid inside OSM woods), brushwork is a texture, and every
// line and footprint is an OSM feature from the model's own vectors.
//
// The planning steps (recolouring, crown placement, height sampling) are pure
// functions; paintCarto() needs a 2D canvas.
import { brushStrokes, paintBrushwork, prng } from './palettes.js';

// Haze (stage 5): fog from near to far, as multiples of the camera-target distance.
export const hazeRange = (distance, C) => [distance * C.fogNear, distance * C.fogFar];

// ---- recolouring: nearest source colour, else base land ----
// map: [[srcRGB, dstRGB], ...] with the base land first. A pixel further than
// sqrt(maxD2) from every source colour (stray anti-aliased edges, JPEG noise)
// becomes base land rather than a random class.
export function recolourData(d, map, maxD2 = 900) {
  const memo = new Map(), base = map[0][1];
  for (let i = 0; i < d.length; i += 4) {
    const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    let out = memo.get(key);
    if (!out) {
      let best = Infinity; out = base;
      for (const [s, t] of map) {
        const e = (d[i] - s[0]) ** 2 + (d[i + 1] - s[1]) ** 2 + (d[i + 2] - s[2]) ** 2;
        if (e < best) { best = e; out = t; }
      }
      if (best > maxD2) out = base;
      memo.set(key, out);
    }
    d[i] = out[0]; d[i + 1] = out[1]; d[i + 2] = out[2];
  }
  return d;
}

// ---- heights in metres from the model's height grid ----
// heights: buildModel's grid (mm, row 0 north); relief: { base, zExag, minM }.
// Catmull-Rom between nodes, so the baked hillshade shows no grid facets.
export function heightMetres(grid, heights, { base, zExag, minM }) {
  const { nx, ny, dx, dy, Hmm, mmPerM } = grid, k = zExag * mmPerM;
  const at = (i, j) => heights[Math.min(ny - 1, Math.max(0, j)) * nx + Math.min(nx - 1, Math.max(0, i))];
  const cr = (p0, p1, p2, p3, t) => p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  return (xM, yM) => {
    const fi = Math.min(nx - 1, Math.max(0, xM * mmPerM / dx)), fj = Math.min(ny - 1, Math.max(0, (Hmm - yM * mmPerM) / dy));
    const i = Math.floor(fi), j = Math.floor(fj), tx = fi - i, ty = fj - j;
    const row = jj => cr(at(i - 1, jj), at(i, jj), at(i + 1, jj), at(i + 2, jj), tx);
    const z = cr(row(j - 1), row(j), row(j + 1), row(j + 2), ty);
    return (z - base) / k + minM;
  };
}

// ---- woodland crowns ----
const CONIFERS = new Set(['spruce', 'scots_pine']);
function inRing(x, y, r) {      // r: flat [x0, y0, x1, y1, ...]
  let c = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
const inRings = (x, y, rings) => inRing(x, y, rings[0]) && !rings.slice(1).some(h => inRing(x, y, h));
function ringBox(r) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < r.length; i += 2) { x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i]); y0 = Math.min(y0, r[i + 1]); y1 = Math.max(y1, r[i + 1]); }
  return [x0, y0, x1, y1];
}

// The crowns to draw, in model mm: [{x, y, r (m), conifer, tone (0-1), h (m)}],
// sorted north to south (southern crowns overlap northern ones).
// woods: vectors.woods; rows: vectors.treeRows; trees: decodeTrees() output
// (metres) or null; C: the carto palette; mmPerM; seed.
export function crownPlan({ woods = [], rows = [], trees = null, C, mmPerM, Wmm, Hmm, seed = 1 }) {
  const r = prng((seed ^ 0x9e3779b9) >>> 0), out = [];
  const onPlate = (x, y) => x >= 0 && y >= 0 && x <= Wmm && y <= Hmm;
  let canopy = 0, grid = 0, row = 0;
  // 1. canopy-model trees (real tops, real crown radii)
  const tx = [], ty = [];
  if (trees?.count) {
    for (let i = 0; i < trees.count; i++) {
      const x = trees.x[i] * mmPerM, y = trees.y[i] * mmPerM;
      if (!onPlate(x, y)) continue;
      const arch = trees.archetypes[trees.archetype[i]];
      out.push({ x, y, r: Math.max(1.2, trees.crownR[i]), conifer: CONIFERS.has(arch), tone: r(), h: trees.h[i], src: 'canopy' });
      tx.push(x); ty.push(y); canopy++;
    }
  }
  // 2. woods with no canopy-model tree inside get crowns on a jittered hex grid
  const sp = C.crownSpacingM * mmPerM;
  for (const w of woods) {
    const R = w.rings, [x0, y0, x1, y1] = ringBox(R[0]);
    if (tx.length && tx.some((x, i) => x >= x0 && x <= x1 && ty[i] >= y0 && ty[i] <= y1 && inRings(x, ty[i], R))) continue;
    const p = w.leaf === 'needleleaved' ? C.conifer.needleleaved : w.leaf === 'broadleaved' ? C.conifer.broadleaved : C.conifer.other;
    let n = 0;
    for (let y = y0; y < y1; y += sp * 0.87, n++) for (let x = x0 + (n % 2) * sp / 2; x < x1; x += sp) {
      const px = x + (r() - 0.5) * sp * 2 * C.crownJitter, py = y + (r() - 0.5) * sp * 2 * C.crownJitter;
      const conifer = r() < p, tone = r(), size = r();
      if (!onPlate(px, py) || !inRings(px, py, R)) continue;
      out.push({ x: px, y: py, r: conifer ? null : C.broadR[0] + size * (C.broadR[1] - C.broadR[0]), conifer, tone,
        h: conifer ? C.coniferH[0] + size * (C.coniferH[1] - C.coniferH[0]) : null, src: 'grid' });
      grid++;
    }
  }
  // 3. OSM tree rows, as strings of small crowns (only when there is no canopy model)
  if (!canopy) {
    const step = C.rowStepM * mmPerM;
    for (const l of rows) {
      const p = l.p;
      for (let i = 2; i < p.length; i += 2) {
        const ax = p[i - 2], ay = p[i - 1], bx = p[i], by = p[i + 1], L = Math.hypot(bx - ax, by - ay), m = Math.max(1, Math.floor(L / step));
        for (let j = 0; j < m; j++) {
          const x = ax + (bx - ax) * j / m, y = ay + (by - ay) * j / m;
          if (onPlate(x, y)) { out.push({ x, y, r: C.rowR, conifer: false, tone: r() * 0.33, h: null, src: 'row' }); row++; }
        }
      }
    }
  }
  out.sort((a, b) => b.y - a.y);        // north (high y) first
  return { crowns: out, counts: { canopy, grid, row } };
}

// ---- painting ----
// canvas: the drape (its size sets the scale); o: {
//   base: the land-cover / satellite / contour canvas, baseKind ('landcover'
//   recolours it), recolourMap (for landcover), relief: canvas or null,
//   sea: canvas (alpha mask, north up) or null, vectors, Wmm, Hmm, mmPerM,
//   C: the carto palette, ink, trees (decoded) or null, seed,
//   show: { brushwork, relief, crowns, water, roads, rail, residues, buildings, receptors, generation, storage, transmission } }
export function paintCarto(canvas, o) {
  const t0 = performance.now();
  const { C, vectors: V = {}, Wmm, Hmm, mmPerM, ink, show = {} } = o;
  const W = canvas.width, H = canvas.height, g = canvas.getContext('2d');
  const k = W / Wmm, pxPerM = k * mmPerM, s = W / C.drapePx;      // s: line widths are given at 6144 px
  const X = x => x * k, Y = y => H - y * k;
  const on = key => show[key] !== false;
  const ringPath = rings => { for (const r of rings) { for (let i = 0; i < r.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, X(r[i]), Y(r[i + 1])); g.closePath(); } };
  const linePath = p => { for (let i = 0; i < p.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, X(p[i]), Y(p[i + 1])); };

  // 1. land cover, enlarged nearest-neighbour (recoloured at its own size)
  g.save();
  g.imageSmoothingEnabled = o.baseKind !== 'landcover';
  if (o.base) g.drawImage(o.base, 0, 0, W, H); else { g.fillStyle = o.landBase || '#bba886'; g.fillRect(0, 0, W, H); }
  g.restore();
  // 2. relief: hillshade and faint contours, multiplied in
  if (o.relief && on('relief')) {
    g.save(); g.globalCompositeOperation = 'multiply'; g.globalAlpha = C.reliefAlpha;
    g.imageSmoothingQuality = 'high'; g.drawImage(o.relief, 0, 0, W, H); g.restore();
  }
  // 3. brushwork (a texture, not data)
  if (on('brushwork')) paintBrushwork(g, brushStrokes(W, H, o.seed, C.brushScale * s));
  // 4. woodland, lineless: soft contact shadow (blurred at low resolution), tint, crowns
  const woods = V.woods || [];
  if (woods.length) {
    const sh = woodShadow(woods, { Wmm, Hmm, mmPerM, C });
    if (sh) { g.save(); g.imageSmoothingQuality = 'high'; g.drawImage(sh, 0, 0, W, H); g.restore(); }
    g.fillStyle = C.woodBase;
    for (const w of woods) { g.beginPath(); ringPath(w.rings); g.fill('evenodd'); }
  }
  let plan = { crowns: [], counts: { canopy: 0, grid: 0, row: 0 } };
  if (on('crowns')) {
    plan = crownPlan({ woods, rows: V.treeRows, trees: o.trees, C, mmPerM, Wmm, Hmm, seed: o.seed });
    drawCrowns(g, plan.crowns, { X, Y, pxPerM, C });
  }
  // 5. water, lineless (the sea from the height data, lochs and waterways from OSM)
  if (on('water')) paintWater(g, { vectors: V, sea: o.sea, Wmm, mmPerM, colour: C.water, riverM: C.riverM, streamM: C.streamM });
  // 6. routes: crisp, cased
  g.lineCap = g.lineJoin = 'round';
  const major = /^(motorway|trunk|primary|secondary)/;
  if (on('roads')) for (const pass of [0, 1]) for (const r of V.roads || []) {
    const big = major.test(r.k || ''); g.beginPath(); linePath(r.p);
    g.strokeStyle = pass ? C.roadFill : ink; g.lineWidth = (pass ? C.roadWidth : C.roadCasing)[big ? 0 : 1] * s; g.stroke();
  }
  if (on('rail')) {
    g.save(); g.setLineDash(C.rail.map(v => v * s)); g.strokeStyle = ink; g.lineWidth = C.railWidth * s; g.lineCap = 'butt';
    for (const r of V.rail || []) { g.beginPath(); linePath(r.p); g.stroke(); }
    g.globalAlpha = 0.55;                                  // disused lines: the same dash, fainter
    for (const r of V.railDisused || []) { g.beginPath(); linePath(r.p); g.stroke(); }
    g.restore();
  }
  // (power lines: not painted on the ground; glyphs.js strings wires between the pylon tops)
  // 7. residues: rust fill, 45° hatch and an edge
  if (on('residues')) for (const f of V.residues || []) {
    const outline = () => { g.beginPath(); if (f.disc) g.arc(X(f.disc[0]), Y(f.disc[1]), f.disc[2] / 2 * k, 0, Math.PI * 2); else ringPath(f.rings); };
    outline(); g.fillStyle = C.residueFill; g.fill('evenodd');
    g.save(); g.clip('evenodd'); g.strokeStyle = C.residue; g.lineWidth = C.residueHatch[0] * s;
    const step = C.residueHatch[1] * s;
    g.beginPath(); for (let d = -H; d < W; d += step) { g.moveTo(d, 0); g.lineTo(d + H, H); } g.stroke();
    g.restore();
    outline(); g.strokeStyle = C.residue; g.lineWidth = C.residueEdge * s; g.stroke();
  }
  // 8. buildings, receptors and substations in plan: contact shadows, then fills with an ink edge
  const feet = (V.footprints || []).filter(f => (f.r ? on('receptors') : on('buildings')));
  const subs = (V.powerAreas || []).filter(f => (f.g ? on(f.g) : on('transmission')) && on('power'));   // by electricity group
  const shape = f => { g.beginPath(); if (f.sq) { const [x, y, a] = f.sq; g.rect(X(x - a / 2), Y(y + a / 2), a * k, a * k); } else ringPath(f.rings); };
  const off = C.footShadowM * pxPerM;
  g.save(); g.translate(off, -off); g.fillStyle = C.footShadow;
  for (const f of [...subs, ...feet]) { shape(f); g.fill('evenodd'); }
  g.restore();
  g.strokeStyle = ink; g.lineWidth = C.footEdge * s; g.lineJoin = 'miter';
  for (const f of subs) { shape(f); g.fillStyle = C.substation; g.fill('evenodd'); g.stroke(); }
  for (const f of feet) { shape(f); g.fillStyle = f.r ? C.receptor : C.building; g.fill('evenodd'); g.stroke(); }
  return { ms: performance.now() - t0, crowns: plan.counts, size: [W, H] };
}

// Contact shadow under the woods: the polygons offset north-east (light from
// the south-west) and blurred, drawn at 1 px per metre and enlarged.
function woodShadow(woods, { Wmm, Hmm, mmPerM, C }) {
  const w = Math.max(8, Math.round(Wmm / mmPerM)), h = Math.max(8, Math.round(Hmm / mmPerM)), k = w / Wmm;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  const dx = C.woodShadowM, dy = -C.woodShadowM;          // px = metres here
  g.fillStyle = '#000';
  for (const wd of woods) {
    g.beginPath();
    for (const r of wd.rings) { for (let i = 0; i < r.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, r[i] * k + dx, h - r[i + 1] * k + dy); g.closePath(); }
    g.fill('evenodd');
  }
  const img = g.getImageData(0, 0, w, h), a = new Float32Array(w * h);
  for (let i = 0; i < a.length; i++) a[i] = img.data[4 * i + 3] / 255;
  const b = boxBlur(boxBlur(a, w, h, Math.round(C.woodBlurM / 2)), w, h, Math.round(C.woodBlurM / 2));
  const m = /rgba?\(([^)]+)\)/.exec(C.woodShadow)[1].split(',').map(Number);
  for (let i = 0; i < b.length; i++) { const d = img.data; d[4 * i] = m[0]; d[4 * i + 1] = m[1]; d[4 * i + 2] = m[2]; d[4 * i + 3] = Math.round(b[i] * (m[3] ?? 1) * 255); }
  g.putImageData(img, 0, 0);
  return c;
}
function boxBlur(a, W, H, r) {
  if (r < 1) return a;
  const t = new Float32Array(a.length), o = new Float32Array(a.length), n = 2 * r + 1;
  for (let j = 0; j < H; j++) { let s = 0; const row = j * W;
    for (let i = -r; i <= r; i++) s += a[row + Math.min(Math.max(i, 0), W - 1)];
    for (let i = 0; i < W; i++) { t[row + i] = s / n; s += a[row + Math.min(i + r + 1, W - 1)] - a[row + Math.max(i - r, 0)]; } }
  for (let i = 0; i < W; i++) { let s = 0;
    for (let j = -r; j <= r; j++) s += t[Math.min(Math.max(j, 0), H - 1) * W + i];
    for (let j = 0; j < H; j++) { o[j * W + i] = s / n; s += t[Math.min(j + r + 1, H - 1) * W + i] - t[Math.max(j - r, 0) * W + i]; } }
  return o;
}

function drawCrowns(g, crowns, { X, Y, pxPerM, C }) {
  const TAU = Math.PI * 2;
  for (const c of crowns) {
    const x = X(c.x), y = Y(c.y);
    if (c.conifer) {                     // a spire with a lit left flank
      const h = (c.h ? Math.min(Math.max(c.h, C.coniferH[0]), C.coniferH[1] * 1.6) : C.coniferH[0]) * pxPerM;
      const w = c.r && c.src === 'canopy' ? Math.min(c.r * pxPerM, h * C.coniferW) : h * C.coniferW;
      g.fillStyle = 'rgba(30,24,12,0.35)'; g.beginPath(); g.ellipse(x + w * 0.5, y + w * 0.15, w * 0.9, w * 0.45, -0.5, 0, TAU); g.fill();
      g.fillStyle = C.coniferFill; g.beginPath(); g.moveTo(x, y - h); g.lineTo(x + w, y); g.lineTo(x - w, y); g.closePath(); g.fill();
      g.fillStyle = C.coniferLit; g.beginPath(); g.moveTo(x, y - h); g.lineTo(x - w, y); g.lineTo(x - w * 0.15, y); g.closePath(); g.fill();
    } else {                             // a disc, shaded lower right, lit upper left
      const r = c.r * pxPerM;
      g.fillStyle = C.crownShadow; g.beginPath(); g.ellipse(x + r * 0.55, y + r * 0.35, r * 1.05, r * 0.8, 0, 0, TAU); g.fill();
      g.fillStyle = C.broad[Math.min(C.broad.length - 1, Math.floor(c.tone * C.broad.length))]; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
      g.fillStyle = C.broadLit; g.beginPath(); g.arc(x - r * 0.3, y - r * 0.3, r * 0.48, 0, TAU); g.fill();
    }
  }
}

// Water, lineless, onto a drape (Anthropogenic, and Guthrie and Field with
// painted water): the sea mask (canvas or null), lochs and ponds (vectors.lakes)
// filled, rivers and canals at riverM and other waterways at streamM metres wide.
export function paintWater(g, { vectors: V = {}, sea = null, Wmm, mmPerM, colour, riverM = 6, streamM = 3.2 }) {
  const W = g.canvas.width, H = g.canvas.height, k = W / Wmm, pxPerM = k * mmPerM;
  const X = x => x * k, Y = y => H - y * k;
  g.save();
  if (sea) { g.imageSmoothingQuality = 'high'; g.drawImage(sea, 0, 0, W, H); }
  g.fillStyle = g.strokeStyle = colour; g.lineCap = g.lineJoin = 'round';
  for (const l of V.lakes || []) {
    g.beginPath();
    for (const r of l.rings) { for (let i = 0; i < r.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, X(r[i]), Y(r[i + 1])); g.closePath(); }
    g.fill('evenodd');
  }
  for (const w of V.waterways || []) {
    g.beginPath();
    for (let i = 0; i < w.p.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, X(w.p[i]), Y(w.p[i + 1]));
    g.lineWidth = (/^(river|canal)$/.test(w.k) ? riverM : streamM) * pxPerM; g.stroke();
  }
  g.restore();
}

// Sea mask (alpha, north up) from a height sampler: water colour where the
// ground is at or below 0 m. pxPerM: resolution. Null when there is no sea.
export function seaCanvas(sampleM, wM, hM, colour, pxPerM = 0.5) {
  const w = Math.max(4, Math.round(wM * pxPerM)), h = Math.max(4, Math.round(hM * pxPerM));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'), img = g.createImageData(w, h), d = img.data;
  const [R, G, B] = [1, 3, 5].map(i => parseInt(colour.slice(i, i + 2), 16));
  let any = false;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (sampleM((i + 0.5) / w * wM, (h - j - 0.5) / h * hM) > 0.01) continue;
    const q = 4 * (j * w + i); d[q] = R; d[q + 1] = G; d[q + 2] = B; d[q + 3] = 255; any = true;
  }
  if (!any) return null;
  g.putImageData(img, 0, 0);
  return c;
}

// ---- glyph positions (Stage 4; drawn by glyphs.js) ----
// Where the symbols stand, in model mm, and how tall (mm).
// props: the bundle's props section (metres from the SW corner) or null;
// vectors: buildModel's vectors (powerPoints in mm) used when there are no props.
export function glyphPoints({ props, vectors, mmPerM, Wmm, Hmm, C }) {
  const onPlate = (x, y) => x >= 0 && y >= 0 && x <= Wmm && y <= Hmm;
  const out = [], assumed = { pylonHeight: 0, turbineHeight: 0 };
  const sup = props?.supports, tb = props?.turbines;
  if (sup || tb) {
    for (const s of sup || []) {
      const x = s.x * mmPerM, y = s.y * mmPerM; if (!onPlate(x, y)) continue;
      const h = Number.isFinite(s.height) && s.height > 0 ? s.height : (assumed.pylonHeight++, C.pylonM);
      out.push({ kind: s.kind === 'pole' ? 'pole' : 'pylon', x, y, hMm: h * C.glyphScale * mmPerM });
    }
    for (const t of tb || []) {
      const x = t.x * mmPerM, y = t.y * mmPerM; if (!onPlate(x, y)) continue;
      const ok = t.hub_height > 0 && t.rotor_diameter > 0;
      if (!ok) assumed.turbineHeight++;
      out.push({ kind: 'turbine', x, y, hMm: (ok ? t.hub_height + t.rotor_diameter / 2 : C.turbineM) * mmPerM });
    }
  } else {
    for (const p of vectors?.powerPoints || []) {
      if (!onPlate(p.x, p.y)) continue;
      if (p.k === 'wind') { if (!(p.h > 0)) assumed.turbineHeight++; out.push({ kind: 'turbine', x: p.x, y: p.y, hMm: (p.h > 0 ? p.h : C.turbineM) * mmPerM }); }
      else { if (!(p.h > 0)) assumed.pylonHeight++; out.push({ kind: p.k === 'pole' ? 'pole' : 'pylon', x: p.x, y: p.y, hMm: (p.h > 0 ? p.h : C.pylonM) * C.glyphScale * mmPerM }); }
    }
  }
  const counts = { pylon: 0, pole: 0, turbine: 0 };
  for (const p of out) counts[p.kind]++;
  // Wires: consecutive vertices of each power line that both stand on a pylon or pole.
  const lines = sup || tb ? (props?.lines || []).map(L => L.xy.map(([x, y]) => [x * mmPerM, y * mmPerM])) : (vectors?.powerLines || []).map(l => l.p);
  const wires = glyphWires(out, lines, Math.max(0.05, 2 * mmPerM));
  return { points: out, counts, assumed, wires };
}

// Pairs of indices into `points` (pylons and poles only) joined by a span of
// one of `lines` (each a list of [x, y] mm). A vertex counts as on a support
// within `tol` mm. Spans whose ends are not both supports are left out.
export function glyphWires(points, lines, tol) {
  const cell = new Map(), key = (i, j) => `${i},${j}`;
  points.forEach((p, i) => {
    if (p.kind === 'turbine') return;
    const k = key(Math.floor(p.x / tol), Math.floor(p.y / tol));
    if (!cell.has(k)) cell.set(k, []);
    cell.get(k).push(i);
  });
  const find = (x, y) => {
    const ci = Math.floor(x / tol), cj = Math.floor(y / tol);
    let best = -1, bd = tol * tol;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const i of cell.get(key(ci + a, cj + b)) || []) {
      const d = (points[i].x - x) ** 2 + (points[i].y - y) ** 2;
      if (d <= bd) { bd = d; best = i; }
    }
    return best;
  };
  const out = [], seen = new Set();
  for (const L of lines) {
    let prev = -1;
    for (const [x, y] of L) {
      const i = find(x, y);
      if (i >= 0 && prev >= 0 && i !== prev) {
        const k = prev < i ? `${prev}-${i}` : `${i}-${prev}`;
        if (!seen.has(k)) { seen.add(k); out.push([prev, i]); }
      }
      prev = i;
    }
  }
  return out;
}
