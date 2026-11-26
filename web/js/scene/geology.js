// Geology walls (subsurface brief, Stage 2): a section painted onto the slab
// walls from BGS 1:50 000 samples taken along each edge of the site. Screen
// only: print files never include it.
//
// What is data and what is drawn (the bundle's `labels` list the same):
//   data      unit extents along each wall; opencast coal resource extent;
//             borehole positions and depths; mine-plan seam names
//   assumed   superficial and sheet thicknesses (nominal); bedrock contacts
//             projected vertically
//   schematic seam count, spacing and thickness; rock patterns
import * as THREE from 'three';
import {
  SIDES, wallAtlas, profileAt, zBelow, depositThickness, depositPattern, sheetThickness, patternOf, unitColour,
  runs, seamLevels, distanceToSide,
} from './geology-math.js';
import { BOREHOLE_NEAR_M } from './subsurface-info.js';

const CW = 4096, SH = 512;                 // atlas: 4 strips of CW x SH
const FONT = 'DejaVu Sans, Helvetica, Arial, sans-serif';
const PIT_NEAR_M = 1000;
const LOOK_STYLE = {
  field: { softenTowards: [236, 230, 214], softenBy: 0.45, turf: '#5e6a3c', seams: '#15110e', coalTint: 'rgba(70,58,30,0.22)' },
};

// sub: the bundle's subsurface section; walls: the terrain-sides geometry
// (non-indexed, unscaled model mm); grid: model grid; zExag: the model's
// terrain exaggeration; palettes: PALETTES; evidence: EVIDENCE colours.
// labels: draw the coal-ground and borehole labels on the walls (off by
// default since 25 Nov 2026; the data and the drawing code stay).
export function createGeology({ sub, walls, grid, zExag, palettes, evidence, ink: inkDefault = '#221d18', labels = false }) {
  const W = sub?.walls;
  if (!W || !walls) return null;
  const pos = walls.attributes.position.array;
  const { uv, surf, zmin, zmax } = wallAtlas(pos, grid.Wmm, grid.Hmm);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', walls.attributes.position);
  geo.setAttribute('normal', walls.attributes.normal);
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(pos.length).fill(1), 3));
  const mesh = new THREE.Mesh(geo);
  mesh.name = 'geology-walls'; mesh.userData = { inkId: 2 }; mesh.receiveShadow = true;

  const mmPerM = grid.mmPerM, Wm = grid.Wmm / mmPerM, Hm = grid.Hmm / mmPerM;
  const textures = {}, materials = {};
  let labelsOn = !!labels, currentLook = null;

  // textScale: how much wider than on the model each texel will be shown,
  // relative to its height (1 on the model; the unfolded-walls diagram uses
  // its own vertical scale), so that lettering comes out upright.
  function paint(look, textScale = 1) {
    const P = palettes[look]?.geology || {}, S = { ...LOOK_STYLE.field, ...P }, ink = palettes[look]?.ink || inkDefault;
    const cv = document.createElement('canvas'); cv.width = CW; cv.height = SH * 4;
    const c = cv.getContext('2d');
    const dz = zmax - zmin;
    const yOf = (k, z) => k * SH + SH * (1 - (z - zmin) / dz);
    const sideLenM = k => (k % 2 === 0 ? Wm : Hm);
    // wall texels are not square: scale text widths so letters look upright
    const FX = k => (dz / SH) / ((k % 2 === 0 ? grid.Wmm : grid.Hmm) / CW) * textScale;
    const aspect = (k, x, y, fn) => { c.save(); c.translate(x, y); c.scale(FX(k), 1); fn(); c.restore(); };
    const colour = u => unitColour(u, { units: P.units, softenTowards: S.softenTowards, softenBy: S.softenBy });
    const nominal = sub.nominal_thickness_m;
    c.fillStyle = '#ece6d6'; c.fillRect(0, 0, CW, SH * 4);

    SIDES.forEach((side, k) => {
      const R = W.sides[side]; if (!R) return;
      const n = R.m.length, L = sideLenM(k), top = k * SH, bottom = top + SH;
      const tOf = i => Math.min(1, Math.max(0, R.m[i] / L));
      // sample i covers from halfway to its neighbours
      const xa = i => i <= 0 ? 0 : (tOf(i - 1) + tOf(i)) / 2 * CW, xb = i => i >= n - 1 ? CW : (tOf(i) + tOf(i + 1)) / 2 * CW;
      const iAt = x => { const t = x / CW; let best = 0; for (let i = 1; i < n; i++) if (Math.abs(tOf(i) - t) < Math.abs(tOf(best) - t)) best = i; return best; };
      const zs = x => profileAt(surf[k], x / CW);
      const unit = j => (j >= 0 ? W.units[j] : null);
      const cover = i => unit(R.artificial[i] >= 0 ? R.artificial[i] : R.superficial[i]);
      const coverM = i => (cover(i) ? depositThickness(cover(i).LEX_D, nominal) : 0);
      const coverBase = x => zBelow(zs(x), coverM(iAt(x)), mmPerM, zExag);
      const path = (xs, f) => { c.beginPath(); xs.forEach((x, j) => (j ? c.lineTo(x, f(x)) : c.moveTo(x, f(x)))); };
      const xsFrom = (a, b, step = 6) => { const out = []; for (let x = a; x < b; x += step) out.push(x); out.push(b); return out; };

      // 1. bedrock columns (contacts projected vertically). A sheet unit
      // takes its neighbouring host's column and is drawn as a band (2).
      const br = runs(R.bedrock);
      const isSheet = r => sheetThickness(unit(r.v), nominal) > 0;
      br.forEach((r, j) => {
        if (!isSheet(r)) return;
        for (let d = 1; d < br.length; d++) {
          const h = [br[j - d], br[j + d]].find(q => q && !isSheet(q));
          if (h) { r.host = h.v; break; }
        }
      });
      for (const r of br) {
        const u = unit(r.host ?? r.v), a = xa(r.i0), b = xb(r.i1);
        c.fillStyle = u ? colour(u) : '#ece6d6'; c.fillRect(a, top, b - a, SH);
        if (u) pattern(c, patternOf(u), a, b, top, bottom, ink);
      }
      c.strokeStyle = ink; c.lineWidth = 2; c.setLineDash([10, 6]);
      for (let j = 1; j < br.length; j++) {
        if ((br[j - 1].host ?? br[j - 1].v) === (br[j].host ?? br[j].v)) continue;
        const x = xa(br[j].i0); c.beginPath(); c.moveTo(x, top); c.lineTo(x, bottom); c.stroke();
      }
      c.setLineDash([]);

      // 2. sheets: a band of nominal thickness under the cover, tapered ends
      for (const r of br.filter(isSheet)) {
        const u = unit(r.v), T = sheetThickness(u, nominal), a = xa(r.i0), b = xb(r.i1), taper = Math.min(60, (b - a) * 0.25);
        const xs = xsFrom(Math.max(0, a - taper), Math.min(CW, b + taper), 8);
        const f = x => (x < a ? (x - (a - taper)) / taper : x > b ? ((b + taper) - x) / taper : 1);
        const tops = xs.map(x => [x, yOf(k, coverBase(x) - 0.5 * mmPerM * zExag)]);
        const bots = xs.map(x => [x, Math.min(bottom, yOf(k, coverBase(x) - (0.5 + T * Math.max(0.05, f(x))) * mmPerM * zExag))]);
        c.beginPath(); tops.forEach(([x, y], j) => (j ? c.lineTo(x, y) : c.moveTo(x, y)));
        bots.reverse().forEach(([x, y]) => c.lineTo(x, y)); c.closePath();
        c.fillStyle = colour(u); c.fill();
        c.save(); c.clip(); pattern(c, patternOf(u), a - taper, b + taper, top, bottom, ink); c.restore();
        c.strokeStyle = ink; c.lineWidth = 2; c.stroke();
      }

      // 5 (before cover, so cover sits on top). Coal: darken coal-bearing
      // ground below the cover, with schematic seams and a label.
      const coalFlag = R.m.map((_, i) => !!R.shallow_coal[i] || /coal/i.test(unit(R.bedrock[i])?.LEX_D || ''));
      const coalRuns = runs(coalFlag).filter(r => r.v);
      for (const r of coalRuns) {
        const a = xa(r.i0), b = xb(r.i1), xs = xsFrom(a, b);
        c.save();
        path(xs, x => yOf(k, coverBase(x))); c.lineTo(b, bottom); c.lineTo(a, bottom); c.closePath(); c.clip();
        c.fillStyle = S.coalTint; c.fillRect(a, top, b - a, SH);
        const zRef = Math.min(...xs.map(coverBase)), pxPerMm = SH / dz;
        for (const s of seamLevels(zRef, zmin, mmPerM, zExag)) {
          const y = yOf(k, s.z), th = Math.max(3, s.thick * pxPerMm);
          c.fillStyle = S.seams; c.fillRect(a, y - th / 2, b - a, th);
          c.fillStyle = 'rgba(245,238,220,0.85)'; c.fillRect(a, y + th / 2 + 1, b - a, 1.5);   // seat earth
        }
        c.restore();
        r.label = R.shallow_coal.slice(r.i0, r.i1 + 1).some(Boolean) ? 'COAL: BGS opencast coal resource' : 'COAL-BEARING STRATA';
        r.a = a; r.b = b; r.y = yOf(k, zRef) + 10 * mmPerM * zExag * SH / dz;
      }

      // 3. superficial and artificial cover from the surface down (nominal)
      const cr = runs(R.m.map((_, i) => (R.artificial[i] >= 0 ? R.artificial[i] : R.superficial[i])));
      for (const r of cr) {
        const u = unit(r.v); if (!u) continue;
        const a = xa(r.i0), b = xb(r.i1), xs = xsFrom(a, b);
        c.save();
        c.beginPath(); c.moveTo(a, top); c.lineTo(b, top);
        [...xs].reverse().forEach(x => c.lineTo(x, yOf(k, coverBase(x)))); c.closePath();
        c.fillStyle = colour(u); c.fill(); c.clip();
        pattern(c, depositPattern(u.LEX_D), a, b, top, bottom, ink);
        c.restore();
      }
      // base of cover, then the turf line
      c.strokeStyle = ink; c.lineWidth = 2;
      path(xsFrom(0, CW), x => yOf(k, coverBase(x))); c.stroke();
      c.fillStyle = S.turf;
      c.beginPath(); c.moveTo(0, top); c.lineTo(CW, top);
      for (const x of xsFrom(0, CW).reverse()) c.lineTo(x, yOf(k, zBelow(zs(x), 0.6, mmPerM, zExag)));
      c.closePath(); c.fill();

      // coal labels (on top of everything in the section)
      for (const r of coalRuns) {
        if (!labelsOn) break;
        c.font = `bold 22px ${FONT}`;
        const tw = Math.max(c.measureText(r.label).width, (c.font = `17px ${FONT}`, c.measureText('seam positions schematic').width)) + 16;
        const lx = Math.max(r.a + 8, Math.min(r.b - tw * FX(k) - 8, r.a + 18)), ly = Math.min(bottom - 60, r.y);
        if (tw * FX(k) > r.b - r.a) continue;            // too short a run to label
        aspect(k, lx, ly, () => {
          c.fillStyle = 'rgba(255,250,236,0.93)'; c.fillRect(0, -5, tw, 56);
          c.strokeStyle = S.seams; c.lineWidth = 2.5; c.strokeRect(0, -5, tw, 56);
          c.fillStyle = S.seams; c.textBaseline = 'top';
          c.font = `bold 22px ${FONT}`; c.fillText(r.label, 8, 0);
          c.font = `17px ${FONT}`; c.fillText('seam positions schematic', 8, 28);
        });
        r.panelX = lx + tw * FX(k) + 20; r.panelY = ly - 5; r.labelX = lx; r.labelBottom = ly + 61;
      }
      sideRuns[k] = coalRuns;
      sideDraw[k] = { aspect, FX, zs, yOf, top, bottom, L };
    });

    // 6. mine-plan seam panel: the nearest coal pit with plan seams within
    // 1 km of a wall that has a coal run; once per site.
    const panel = seamPanel();
    lastPanel = panel && { side: SIDES[panel.k], pit: panel.pit.name, plan: panel.plan.catalogue, d: Math.round(panel.d), x: panel.run.panelX, y: panel.run.panelY };
    if (panel && labelsOn) {              // a wall label: drawn only when wall labels are on
      const { k, run, plan, pit } = panel, D = sideDraw[k];
      const mine = (plan.mine_name || pit.name).toLowerCase().replace(/\b\w/g, ch => ch.toUpperCase());
      const title = `Mine plan ${plan.catalogue}: ${mine}${plan.year_abandoned ? `, abandoned ${plan.year_abandoned}` : ''}`;
      const sub1 = 'Seams named on the plan (BGS mine plans index)', sub2 = 'order and depths not shown';
      const names = [...new Set(plan.seams)];
      c.font = `bold 19px ${FONT}`; let w = c.measureText(title).width;
      c.font = `14px ${FONT}`; w = Math.max(w, c.measureText(sub1).width, c.measureText(sub2).width);
      c.font = `18px ${FONT}`; for (const nm of names) w = Math.max(w, c.measureText(`▬ ${nm}`).width);
      const pw = w + 24, ph = 32 + 2 * 18 + names.length * 23 + 12;
      let px = run.panelX ?? run.a + 8, py = run.panelY ?? run.y;
      if (px + pw * D.FX(k) > CW - 8 && run.labelX != null) { px = run.labelX; py = run.labelBottom + 8; }   // no room beside the label: below it
      px = Math.max(0, Math.min(CW - pw * D.FX(k) - 8, px)); py = Math.max(D.top + 4, Math.min(D.bottom - ph - 4, py));
      D.aspect(k, px, py, () => {
        const S = { ...LOOK_STYLE.field, ...(palettes[look]?.geology || {}) };
        c.fillStyle = S.seams; c.globalAlpha = 0.94; c.fillRect(0, 0, pw, ph); c.globalAlpha = 1;
        c.strokeStyle = '#f3e6c4'; c.lineWidth = 2; c.strokeRect(3, 3, pw - 6, ph - 6);
        c.textBaseline = 'top';
        c.fillStyle = '#fff7e3'; c.font = `bold 19px ${FONT}`; c.fillText(title, 12, 9);
        c.fillStyle = '#e9d8a8'; c.font = `14px ${FONT}`; c.fillText(sub1, 12, 33); c.fillText(sub2, 12, 51);
        c.fillStyle = '#fff7e3'; c.font = `18px ${FONT}`;
        names.forEach((nm, i) => c.fillText(`▬ ${nm}`, 12, 73 + i * 23));
      });
    }

    // 7. boreholes within 50 m of a wall: a red line to the recorded depth.
    // Deepest first, so where labels would overlap the deeper borehole keeps its label.
    const placed = [[], [], [], []];
    for (const bh of [...(sub.boreholes || [])].sort((a, b) => (b.length_m || 0) - (a.length_m || 0))) {
      if (!(bh.length_m > 0)) continue;
      let best = null;
      for (let k = 0; k < 4; k++) { const d = distanceToSide(k, bh.x, bh.y, Wm, Hm); if (!best || d.d < best.d) best = { ...d, k }; }
      if (best.d > BOREHOLE_NEAR_M) continue;
      const D = sideDraw[best.k], x = best.t * CW, z0 = D.zs(x);
      const y0 = D.yOf(best.k, z0), y1 = Math.min(D.bottom, D.yOf(best.k, zBelow(z0, bh.length_m, mmPerM, zExag)));
      const RED = evidence.borehole;
      c.lineCap = 'round';
      c.lineWidth = 9; c.strokeStyle = '#ffffff'; c.beginPath(); c.moveTo(x, y0); c.lineTo(x, y1); c.stroke();
      c.lineWidth = 5; c.strokeStyle = RED; c.stroke();
      c.lineCap = 'butt';
      c.fillStyle = RED; c.beginPath(); c.arc(x, y1, 7, 0, 7); c.fill();
      if (bh.length_m < 10 || !labelsOn) continue;      // label the deeper ones only, when labels are on
      const lines = [`BGS borehole ${bh.ref}`, `${bh.name || ''}${bh.year ? `, ${bh.year}` : ''}`.replace(/^, /, ''),
        `${+bh.length_m.toFixed(1)} m deep (${bh.ags ? 'AGS log' : 'scanned log, not read'})`].filter(Boolean);
      c.font = `bold 18px ${FONT}`; const w = Math.max(...lines.map(l => c.measureText(l).width)) + 14;
      const fx = D.FX(best.k), lx = x + 12 + w * fx > CW ? x - 12 - w * fx : x + 12;
      const ly = Math.min(D.bottom - lines.length * 22 - 10, y0 + (y1 - y0) * 0.45);
      const box = [Math.min(lx, lx + (w + 4) * fx) - 4, ly - 6, Math.max(lx, lx + (w + 4) * fx) + 4, ly + lines.length * 22 + 4];
      if (placed[best.k].some(b => box[0] < b[2] && b[0] < box[2] && box[1] < b[3] && b[1] < box[3])) continue;   // would cover another label
      placed[best.k].push(box);
      D.aspect(best.k, lx, ly, () => {
        c.fillStyle = 'rgba(255,255,255,0.93)'; c.fillRect(-4, -6, w + 4, lines.length * 22 + 10);
        c.strokeStyle = RED; c.lineWidth = 2; c.strokeRect(-4, -6, w + 4, lines.length * 22 + 10);
        c.fillStyle = RED; c.textBaseline = 'top';
        lines.forEach((l, i) => { c.font = `${i ? '' : 'bold '}18px ${FONT}`; c.fillText(l, 2, i * 22); });
      });
    }

    return cv;
  }
  const sideRuns = [], sideDraw = [];
  let lastPanel = null;

  function seamPanel() {
    let best = null;
    for (const pit of sub.pits || []) {
      if (pit.class !== 'coal') continue;
      const plan = [...(pit.plans || [])].filter(p => p.seams?.length).sort((a, b) => b.seams.length - a.seams.length)[0];
      if (!plan) continue;
      for (let k = 0; k < 4; k++) {
        const runsK = sideRuns[k] || []; if (!runsK.length) continue;
        const d = distanceToSide(k, pit.x, pit.y, Wm, Hm);
        if (d.d > PIT_NEAR_M) continue;
        const run = runsK.reduce((p, r) => (Math.abs((r.a + r.b) / 2 / CW - d.t) < Math.abs((p.a + p.b) / 2 / CW - d.t) ? r : p));
        // prefer a run long enough to carry its label (and so the panel), then the nearest
        const score = (run.panelX != null ? 0 : 1e6) + d.d;
        if (!best || score < best.score) best = { d: d.d, score, k, run, plan, pit };
      }
    }
    return best;
  }

  function texture(look) {
    if (!textures[look]) {
      const tex = new THREE.CanvasTexture(paint(look));
      tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
      textures[look] = tex;
    }
    return textures[look];
  }
  const geoLook = look => (palettes[look]?.geology ? look : 'field');
  // The atlas for a diagram at vertical exaggeration `vex` (true scale = 1):
  // a fresh canvas with 4 strips of CW x SH, south, east, north, west, each
  // spanning the slab from its base (zmin) to zmax.
  function atlas(look, vex = zExag) { const keep = lastPanel; try { return paint(geoLook(look), vex / zExag); } finally { lastPanel = keep; } }
  // A legend swatch (canvas) for a unit, drawn as the walls draw it.
  function swatch(unit, look, { cover = false, w = 44, h = 26 } = {}) {
    const P = palettes[geoLook(look)]?.geology || {}, S = { ...LOOK_STYLE.field, ...P }, ink = palettes[geoLook(look)]?.ink || inkDefault;
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const c = cv.getContext('2d');
    c.fillStyle = unitColour(unit, { units: P.units, softenTowards: S.softenTowards, softenBy: S.softenBy }); c.fillRect(0, 0, w, h);
    pattern(c, cover ? depositPattern(unit.LEX_D) : patternOf(unit), 0, w, 0, h, ink);
    c.strokeStyle = ink; c.lineWidth = 1.5; c.strokeRect(0.75, 0.75, w - 1.5, h - 1.5);
    return cv;
  }
  // Coal-bearing ground swatch: the tint and schematic seams.
  function coalSwatch(look, { w = 44, h = 26 } = {}) {
    const S = { ...LOOK_STYLE.field, ...(palettes[geoLook(look)]?.geology || {}) }, ink = palettes[geoLook(look)]?.ink || inkDefault;
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const c = cv.getContext('2d');
    c.fillStyle = '#d9cfa8'; c.fillRect(0, 0, w, h); c.fillStyle = S.coalTint; c.fillRect(0, 0, w, h);
    c.fillStyle = S.seams; for (const y of [5, 13, 20]) c.fillRect(0, y, w, 3);
    c.strokeStyle = ink; c.lineWidth = 1.5; c.strokeRect(0.75, 0.75, w - 1.5, h - 1.5);
    return cv;
  }
  function material(look) {
    if (!materials[look]) {
      const map = texture(palettes[look]?.geology ? look : 'field');
      materials[look] = new THREE.MeshBasicMaterial({ map, vertexColors: true });
    }
    return materials[look];
  }
  // Light or dark by which way each wall faces the sun .
  function shade(sun) {
    const n = geo.attributes.normal, col = geo.attributes.color, sl = Math.hypot(sun.x, sun.z) || 1;
    for (let i = 0; i < n.count; i++) {
      const d = (n.getX(i) * sun.x - n.getY(i) * sun.z) / sl;
      const v = 0.86 + 0.14 * THREE.MathUtils.smoothstep(d, -0.15, 0.15);
      col.setXYZ(i, v, v, v);
    }
    col.needsUpdate = true;
  }
  function setLook(look) { currentLook = look; mesh.material = material(look); }
  // Wall labels on or off: repaint (the textures are cached per look).
  function setLabels(on) {
    if (!!on === labelsOn) return;
    labelsOn = !!on;
    for (const m of Object.values(materials)) m.dispose();
    for (const t of Object.values(textures)) t.dispose();
    for (const k of Object.keys(materials)) delete materials[k];
    for (const k of Object.keys(textures)) delete textures[k];
    if (currentLook) setLook(currentLook);
  }
  function dispose() {
    for (const m of Object.values(materials)) m.dispose();
    for (const t of Object.values(textures)) t.dispose();
    geo.deleteAttribute('uv'); geo.deleteAttribute('color'); geo.dispose();   // position/normal belong to the walls
    mesh.removeFromParent();
  }
  return { mesh, setLook, setLabels, get labels() { return labelsOn; }, shade, dispose, atlas, swatch, coalSwatch, sub, surf, zmin, zmax, zExag, mmPerM, Wm, Hm, CW, SH,
    get panel() { return lastPanel; }, attribution: sub.attribution, nonCommercial: !!sub.nonCommercial };
}

// ---- rock patterns, drawn in canvas px and clipped by the caller ----
function pattern(c, kind, x0, x1, y0, y1, ink) {
  if (kind === 'plain' || x1 <= x0) return;
  c.save(); c.beginPath(); c.rect(x0, y0, x1 - x0, y1 - y0); c.clip();
  c.strokeStyle = ink; c.fillStyle = ink; c.globalAlpha = 0.5; c.lineWidth = 1.4;
  const dots = (sx, sy, r = 1) => { for (let y = y0 + sy / 2, row = 0; y < y1; y += sy, row++) for (let x = x0 + (row % 2) * sx / 2; x < x1; x += sx) { c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); } };
  const dashes = (gap, dash = [6, 5]) => { c.setLineDash(dash); for (let y = y0 + gap / 2; y < y1; y += gap) { c.beginPath(); c.moveTo(x0, y); c.lineTo(x1, y); c.stroke(); } c.setLineDash([]); };
  const marks = (fn, sx = 14, sy = 12) => { for (let y = y0 + sy / 2, row = 0; y < y1; y += sy, row++) for (let x = x0 + (row % 2) * sx / 2; x < x1; x += sx) fn(x, y); };
  const hash = (i) => Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
  switch (kind) {
    case 'cycles': case 'coalcycles': {
      // schematic cyclothem: thin bands of sandstone (dots) and mudstone (dashes)
      const band = 9;
      for (let y = y0, b = 0; y < y1; y += band, b++) {
        const r = hash(Math.floor(y / band));
        if (r < 0.45) { for (let x = x0 + (b % 2) * 4; x < x1; x += 8) { c.beginPath(); c.arc(x, y + band / 2, 0.9, 0, 7); c.fill(); } }
        else if (r < 0.85) { c.setLineDash([6, 5]); c.beginPath(); c.moveTo(x0, y + band / 2); c.lineTo(x1, y + band / 2); c.stroke(); c.setLineDash([]); }
      }
      break;
    }
    case 'limestone': {
      const bh = 8, bw = 18;
      for (let y = y0, row = 0; y < y1; y += bh, row++) {
        c.beginPath(); c.moveTo(x0, y); c.lineTo(x1, y); c.stroke();
        for (let x = x0 + (row % 2) * bw / 2; x < x1; x += bw) { c.beginPath(); c.moveTo(x, y); c.lineTo(x, y + bh); c.stroke(); }
      }
      break;
    }
    case 'igneous': marks((x, y) => { c.beginPath(); c.moveTo(x - 3, y - 3); c.lineTo(x + 3, y + 3); c.moveTo(x + 3, y - 3); c.lineTo(x - 3, y + 3); c.stroke(); }); break;
    case 'volcanic': marks((x, y) => { c.beginPath(); c.moveTo(x - 3.5, y - 3); c.lineTo(x, y + 3); c.lineTo(x + 3.5, y - 3); c.stroke(); }); break;
    case 'sandstone': dots(8, 8, 1); break;
    case 'mudstone': dashes(7); break;
    case 'conglomerate': marks((x, y) => { c.beginPath(); c.arc(x, y, 3, 0, 7); c.stroke(); }, 12, 10); break;
    case 'till': marks((x, y) => { const h = hash(x * 7.1 + y); c.beginPath(); c.ellipse(x + h * 5, y, 1.6 + h * 2, 1.2 + h, h * 3, 0, 7); c.stroke(); }, 11, 9); break;
    case 'gravel': dots(7, 6, 1.3); break;
    case 'alluvium': dashes(6, [3, 6]); break;
    case 'peat': dashes(5, [2, 3]); break;
    case 'made': marks((x, y) => { c.beginPath(); c.moveTo(x - 3, y); c.lineTo(x + 3, y); c.moveTo(x, y - 3); c.lineTo(x, y + 3); c.stroke(); }, 12, 10); break;
    default: break;
  }
  c.restore();
}
