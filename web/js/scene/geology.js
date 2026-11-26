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
// Wall labels in the signposts' style (pits.js labelTexture), at half its size.
const SIGN = { h: 56, pad: 10, name: 22, note: 15, border: 2.5, sw: 30 };
const PALE = 'rgba(255,250,236,0.97)', COAL = '#15110e', EDGE = '#f3e6c4', CREAM = '#fff7e3', CREAM2 = '#e9d8a8', NOTE = '#5a5248';
function signWidth(c, s) {
  c.font = `bold ${SIGN.name}px ${FONT}`; const a = c.measureText(s.name).width;
  c.font = `${SIGN.note}px ${FONT}`; const b = s.note ? c.measureText(s.note).width : 0;
  return Math.ceil(Math.max(a, b)) + 2 * SIGN.pad + (s.swatch ? SIGN.sw + 8 : 0);
}
// s: { name, note, dark, edge, nameColour, swatch(x, y, w, h) }, drawn at (0, 0)
function drawSign(c, s, w) {
  const h = SIGN.h, dark = !!s.dark, B = SIGN.border;
  c.fillStyle = dark ? COAL : PALE; c.fillRect(0, 0, w, h);
  c.strokeStyle = s.edge || (dark ? EDGE : COAL); c.lineWidth = B; c.strokeRect(B / 2, B / 2, w - B, h - B);
  let tx = SIGN.pad;
  if (s.swatch) { s.swatch(tx, (h - SIGN.sw) / 2, SIGN.sw, SIGN.sw); tx += SIGN.sw + 8; }
  c.textBaseline = 'alphabetic';
  c.fillStyle = s.nameColour || (dark ? CREAM : COAL); c.font = `bold ${SIGN.name}px ${FONT}`; c.fillText(s.name, tx, s.note ? 25 : 36);
  if (s.note) { c.fillStyle = dark ? CREAM2 : NOTE; c.font = `${SIGN.note}px ${FONT}`; c.fillText(s.note, tx, 46); }
}
const showOf = v => (v && typeof v === 'object' ? { geology: !!v.geology, bgs: !!v.bgs } : { geology: !!v, bgs: !!v });
const LOOK_STYLE = {
  field: { softenTowards: [236, 230, 214], softenBy: 0.45, turf: '#5e6a3c', seams: '#15110e', coalTint: 'rgba(70,58,30,0.22)' },
};

// sub: the bundle's subsurface section; walls: the terrain-sides geometry
// (non-indexed, unscaled model mm); grid: model grid; zExag: the model's
// terrain exaggeration; palettes: PALETTES; evidence: EVIDENCE colours.
// labels: which wall labels to draw, { geology, bgs } (the two legend
// toggles, JC 26 Nov 2026): geology = the legend's units; bgs = the records
// (mine-plan panel, deeper boreholes). A boolean sets both.
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
  let show = showOf(labels), currentLook = null;

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

      sideRuns[k] = coalRuns;
      sideDraw[k] = { aspect, FX, zs, yOf, top, bottom, L, br, cr, isSheet, unit, xa, xb, coverBase, colour, coalRuns };
    });

    // 7. boreholes within 50 m of a wall: a red line to the recorded depth
    // (always drawn: it is the record itself). Deepest first, so where labels
    // would overlap the deeper borehole keeps its label.
    const RED = evidence.borehole, holes = [];
    for (const bh of [...(sub.boreholes || [])].sort((a, b) => (b.length_m || 0) - (a.length_m || 0))) {
      if (!(bh.length_m > 0)) continue;
      let best = null;
      for (let k = 0; k < 4; k++) { const d = distanceToSide(k, bh.x, bh.y, Wm, Hm); if (!best || d.d < best.d) best = { ...d, k }; }
      if (best.d > BOREHOLE_NEAR_M) continue;
      const D = sideDraw[best.k], x = best.t * CW, z0 = D.zs(x);
      const y0 = D.yOf(best.k, z0), y1 = Math.min(D.bottom, D.yOf(best.k, zBelow(z0, bh.length_m, mmPerM, zExag)));
      c.lineCap = 'round';
      c.lineWidth = 9; c.strokeStyle = '#ffffff'; c.beginPath(); c.moveTo(x, y0); c.lineTo(x, y1); c.stroke();
      c.lineWidth = 5; c.strokeStyle = RED; c.stroke();
      c.lineCap = 'butt';
      c.fillStyle = RED; c.beginPath(); c.arc(x, y1, 7, 0, 7); c.fill();
      if (bh.length_m >= 10) holes.push({ bh, k: best.k, x, y0, y1 });       // the deeper ones get a label
    }

    // 8. Wall labels, in the signposts' style (pits.js): a pale sign with an
    // ink edge, a bold name and a grey second line; coal on a dark sign.
    // "Geology" labels the legend's units (rocks, sheets, deposits, coal-
    // bearing ground); "British Geological Survey" labels the records (the
    // mine-plan panel and the deeper boreholes). No two labels overlap.
    const placed = [[], [], [], []];
    const free = (k, b) => !placed[k].some(q => b[0] < q[2] && q[0] < b[2] && b[1] < q[3] && q[1] < b[3]);
    const surfY = (k, a, b) => { const D = sideDraw[k]; let y = D.top; for (let x = Math.max(0, a); x <= Math.min(CW, b); x += 8) y = Math.max(y, D.yOf(k, D.zs(x))); return y; };
    // a sign inside [a, b] on side k, at the first free height from y down (at most `reach` px lower)
    function put(k, a, b, y, s, { x: want, reach = Infinity } = {}) {
      const D = sideDraw[k]; if (!D) return null;
      const w = signWidth(c, s), ww = w * D.FX(k), h = SIGN.h;
      if (ww > b - a - 8) return null;                  // too short a run to label
      const x = Math.max(a + 4, Math.min(b - ww - 4, want ?? (a + b) / 2 - ww / 2));
      const y0 = Math.max(y, surfY(k, x, x + ww) + 6);
      for (let yy = y0; yy <= Math.min(D.bottom - h - 4, y0 + reach); yy += h / 2) {
        const box = [x - 4, yy - 4, x + ww + 4, yy + h + 4];
        if (!free(k, box)) continue;
        placed[k].push(box); D.aspect(k, x, yy, () => drawSign(c, s, w)); return box;
      }
      return null;
    }
    const swatchOf = (u, kind) => (x, y, w, h) => {
      c.fillStyle = colourOf(u); c.fillRect(x, y, w, h);
      c.save(); c.beginPath(); c.rect(x, y, w, h); c.clip(); pattern(c, kind, x, x + w, y, y + h, ink); c.restore();
      c.strokeStyle = ink; c.lineWidth = 1.5; c.strokeRect(x, y, w, h);
    };
    const colourOf = u => unitColour(u, { units: P.units, softenTowards: S.softenTowards, softenBy: S.softenBy });
    const coalSw = (x, y, w, h) => {
      c.fillStyle = '#d9cfa8'; c.fillRect(x, y, w, h); c.fillStyle = S.coalTint; c.fillRect(x, y, w, h);
      c.fillStyle = S.seams; for (const f of [0.2, 0.5, 0.78]) c.fillRect(x, y + f * h - 2, w, 4);
      c.strokeStyle = EDGE; c.lineWidth = 1.5; c.strokeRect(x, y, w, h);
    };

    // coal-bearing ground first: the mine-plan panel sits beside it
    if (show.geology) SIDES.forEach((_, k) => {
      for (const r of sideDraw[k]?.coalRuns || []) {
        const opencast = W.sides[SIDES[k]].shallow_coal.slice(r.i0, r.i1 + 1).some(Boolean);
        const box = put(k, r.a, r.b, r.y, { name: 'Coal-bearing ground', dark: true, swatch: coalSw,
          note: `${opencast ? 'BGS Shallow Coal: opencast coal resource area' : 'Coal named in the BGS bedrock unit'}; seams schematic` },
        { x: r.a + 18, reach: SIGN.h * 2 })
          // a short run: let the sign run past its ends rather than leave the coal unnamed
          || put(k, Math.max(0, r.a - 600), Math.min(CW, r.b + 600), r.y, { name: 'Coal-bearing ground', dark: true, swatch: coalSw,
            note: `${opencast ? 'BGS opencast coal resource' : 'Coal named in the BGS bedrock unit'}; seams schematic` }, { x: r.a, reach: SIGN.h * 2 });
        if (box) { r.panelX = box[2] + 16; r.panelY = box[1] + 4; r.labelX = box[0] + 4; r.labelBottom = box[3]; }
      }
    });

    // 6. mine-plan seam panel: the nearest coal pit with plan seams within
    // 1 km of a wall that has a coal run; once per site.
    const panel = seamPanel();
    lastPanel = panel && { side: SIDES[panel.k], pit: panel.pit.name, plan: panel.plan.catalogue, d: Math.round(panel.d), x: panel.run.panelX, y: panel.run.panelY };
    if (panel && show.bgs) {
      const { k, run, plan, pit } = panel, D = sideDraw[k];
      const mine = (plan.mine_name || pit.name).toLowerCase().replace(/\b\w/g, ch => ch.toUpperCase());
      const title = `Mine plan ${plan.catalogue}: ${mine}${plan.year_abandoned ? `, abandoned ${plan.year_abandoned}` : ''}`;
      const sub1 = 'Seams named on the plan (BGS mine plans index)', sub2 = 'order and depths not shown';
      const names = [...new Set(plan.seams)];
      c.font = `bold ${SIGN.name}px ${FONT}`; let w = c.measureText(title).width;
      c.font = `${SIGN.note}px ${FONT}`; w = Math.max(w, c.measureText(sub1).width, c.measureText(sub2).width);
      c.font = `17px ${FONT}`; for (const nm of names) w = Math.max(w, c.measureText(`▬ ${nm}`).width);
      const pw = w + 2 * SIGN.pad, ph = 10 + 26 + 2 * 19 + names.length * 22 + 10;
      let px = run.panelX ?? run.a + 8, py = run.panelY ?? run.y;
      if (px + pw * D.FX(k) > CW - 8 && run.labelX != null) { px = run.labelX; py = run.labelBottom + 8; }   // no room beside the label: below it
      px = Math.max(0, Math.min(CW - pw * D.FX(k) - 8, px)); py = Math.max(D.top + 4, Math.min(D.bottom - ph - 4, py));
      placed[k].push([px - 4, py - 4, px + pw * D.FX(k) + 4, py + ph + 4]);
      D.aspect(k, px, py, () => {
        c.fillStyle = COAL; c.fillRect(0, 0, pw, ph);
        c.strokeStyle = EDGE; c.lineWidth = SIGN.border; c.strokeRect(SIGN.border / 2, SIGN.border / 2, pw - SIGN.border, ph - SIGN.border);
        c.textBaseline = 'alphabetic';
        c.fillStyle = CREAM; c.font = `bold ${SIGN.name}px ${FONT}`; c.fillText(title, SIGN.pad, 30);
        c.fillStyle = CREAM2; c.font = `${SIGN.note}px ${FONT}`; c.fillText(sub1, SIGN.pad, 52); c.fillText(sub2, SIGN.pad, 71);
        c.fillStyle = CREAM; c.font = `17px ${FONT}`;
        names.forEach((nm, i) => c.fillText(`▬ ${nm}`, SIGN.pad, 96 + i * 22));
      });
    }

    // borehole labels beside their lines
    if (show.bgs) for (const { bh, k, x, y0, y1 } of holes) {
      const s = { name: `BGS borehole ${bh.ref}`, edge: RED, nameColour: RED,
        note: [[bh.name, bh.year].filter(Boolean).join(', '), `${+bh.length_m.toFixed(1)} m deep (${bh.ags ? 'AGS log' : 'scanned log, not read'})`].filter(Boolean).join('; ') };
      const D = sideDraw[k], ww = signWidth(c, s) * D.FX(k);
      const lx = x + 14 + ww > CW ? x - 14 - ww : x + 14;
      put(k, 0, CW, y0 + (y1 - y0) * 0.35, s, { x: lx, reach: SIGN.h * 1.5 });
    }

    // the legend's units, each once per wall on its longest run: deposits
    // (at the top), sheets, then bedrock
    if (show.geology) SIDES.forEach((_, k) => {
      const D = sideDraw[k]; if (!D) return;
      const longest = (rs, keyOf) => {
        const by = new Map();
        for (const r of rs) { const j = keyOf(r); if (j == null || j < 0 || !D.unit(j)?.LEX_D) continue; const a = D.xa(r.i0), b = D.xb(r.i1); if (!by.has(j) || b - a > by.get(j).b - by.get(j).a) by.set(j, { a, b, u: D.unit(j) }); }
        return [...by.values()].sort((p, q) => (q.b - q.a) - (p.b - p.a));
      };
      for (const { a, b, u } of longest(D.cr, r => r.v)) {
        const kind = u.layer === 'artificial' ? 'Artificial ground' : 'Superficial deposit';
        put(k, a, b, D.top, { name: u.LEX_D, note: `${u.RCS_D || kind}; thickness assumed`, swatch: swatchOf(u, depositPattern(u.LEX_D)) });
      }
      for (const { a, b, u } of longest(D.br.filter(D.isSheet), r => r.v)) {
        const m = (a + b) / 2;
        put(k, a, b, D.yOf(k, D.coverBase(m) - 0.5 * mmPerM * zExag) + 4, { name: u.LEX_D, note: `${u.RCS_D ? `${u.RCS_D}; ` : ''}sheet, thickness assumed`, swatch: swatchOf(u, patternOf(u)) });
      }
      for (const { a, b, u } of longest(D.br.filter(r => !D.isSheet(r)), r => r.v)) {
        const m = (a + b) / 2;
        put(k, a, b, D.yOf(k, D.coverBase(m)) + 14, { name: u.LEX_D, note: u.RCS_D || 'Bedrock (BGS)', swatch: swatchOf(u, patternOf(u)) });
      }
    });

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
    const next = showOf(on);
    if (next.geology === show.geology && next.bgs === show.bgs) return;
    show = next;
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
  return { mesh, setLook, setLabels, get labels() { return { ...show }; }, shade, dispose, atlas, swatch, coalSwatch, sub, surf, zmin, zmax, zExag, mmPerM, Wm, Hm, CW, SH,
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
