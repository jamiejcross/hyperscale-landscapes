// Colour-blind check for the stylised looks' evidence colours.
//
//   node tools/palette_check.mjs            # table for field and guthrie
//
// Simulates protanopia, deuteranopia and tritanopia (Machado, Oliveira and
// Fernandes 2009, severity 1.0, applied in linear RGB) and measures colour
// difference with CIEDE2000. Requires dE >= 15 between every pair of evidence
// colours and dE >= 10 between each evidence colour and the three most common
// land colours, under normal vision and each simulation. Pure functions are
// exported for tests.
import { fileURLToPath } from 'node:url';
import { PALETTES, EVIDENCE } from '../web/js/scene/palettes.js';

export const MACHADO = {
  normal: null,
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
};

export function hexToRgb(h) {
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
  if (!m) throw new Error(`bad colour ${h}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const toLin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const toSrgb = c => { const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055; return Math.round(Math.min(1, Math.max(0, v)) * 255); };

export function simulate(rgb, kind) {
  const M = MACHADO[kind];
  if (!M) return rgb;
  const l = rgb.map(toLin);
  return M.map(row => toSrgb(row[0] * l[0] + row[1] * l[1] + row[2] * l[2]));
}

export function rgbToLab(rgb) {
  const [r, g, b] = rgb.map(toLin);
  const X = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const Y = (0.2126729 * r + 0.7151522 * g + 0.0721750 * b) / 1.0;
  const Z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883;
  const f = t => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

// CIEDE2000 (Sharma, Wu and Dalal 2005).
export function deltaE2000([L1, a1, b1], [L2, a2, b2]) {
  const rad = Math.PI / 180, deg = 180 / Math.PI;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const h = (b, a) => { if (a === 0 && b === 0) return 0; const v = Math.atan2(b, a) * deg; return v >= 0 ? v : v + 360; };
  const h1p = h(b1, a1p), h2p = h(b2, a2p);
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) { dhp = h2p - h1p; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360; }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(dhp * rad / 2);
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hbp = (h1p + h2p) / 2;
    else hbp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  }
  const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad)
    + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.20 * Math.cos((4 * hbp - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const RC = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const SL = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const SC = 1 + 0.045 * Cbp, SH = 1 + 0.015 * Cbp * T;
  const RT = -Math.sin(2 * dTheta * rad) * RC;
  return Math.sqrt((dLp / SL) ** 2 + (dCp / SC) ** 2 + (dHp / SH) ** 2 + RT * (dCp / SC) * (dHp / SH));
}

export function dE(hexA, hexB, kind = 'normal') {
  return deltaE2000(rgbToLab(simulate(hexToRgb(hexA), kind)), rgbToLab(simulate(hexToRgb(hexB), kind)));
}

// Evidence colours and the three most common land colours for a palette.
export function coloursFor(look) {
  const P = PALETTES[look];
  return {
    evidence: {
      residues: P.layers.residues, schools: P.layers.receptors,
      // coal ground, seams and pit squares/labels are one class
      coal: P.geology?.seams || EVIDENCE.coal, 'red line': EVIDENCE.redLine, borehole: EVIDENCE.borehole,
    },
    land: { farmland: P.landcover['landuse:farmland'], grass: P.landcover['landuse:grass'], 'base land': P.landBase },
  };
}

export const THRESHOLDS = { evidencePair: 15, evidenceLand: 10 };

export function check(look) {
  const { evidence, land } = coloursFor(look);
  const kinds = Object.keys(MACHADO), rows = [];
  const E = Object.entries(evidence), Lnd = Object.entries(land);
  for (let i = 0; i < E.length; i++) for (let j = i + 1; j < E.length; j++) {
    const v = Object.fromEntries(kinds.map(k => [k, dE(E[i][1], E[j][1], k)]));
    rows.push({ a: E[i][0], b: E[j][0], kind: 'evidence', min: Math.min(...Object.values(v)), need: THRESHOLDS.evidencePair, ...v });
  }
  for (const [n, c] of E) for (const [ln, lc] of Lnd) {
    const v = Object.fromEntries(kinds.map(k => [k, dE(c, lc, k)]));
    rows.push({ a: n, b: ln, kind: 'land', min: Math.min(...Object.values(v)), need: THRESHOLDS.evidenceLand, ...v });
  }
  return rows.map(r => ({ ...r, pass: r.min >= r.need }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const look of ['field', 'guthrie']) {
    const rows = check(look);
    console.log(`\n## ${look}: ${rows.filter(r => !r.pass).length} of ${rows.length} pairs below threshold`);
    console.log('| pair | normal | protan | deutan | tritan | min | need | |');
    console.log('|---|---|---|---|---|---|---|---|');
    for (const r of rows) {
      const f = v => v.toFixed(1);
      console.log(`| ${r.a} – ${r.b} | ${f(r.normal)} | ${f(r.protanopia)} | ${f(r.deuteranopia)} | ${f(r.tritanopia)} | ${f(r.min)} | ${r.need} | ${r.pass ? 'ok' : 'FAIL'} |`);
    }
  }
}
