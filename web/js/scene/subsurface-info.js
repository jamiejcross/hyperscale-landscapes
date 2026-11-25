// What the geology walls and pits show, worked out from the bundle's
// subsurface section (subsurface brief, Stage 4): the legend, the source
// list for captions and the manifest. Everything here is generated from the
// data; nothing about a site is hard-coded. Pure functions (the imports have
// no imports of their own), so Node can test this file directly.
import { SIDES, sheetThickness, depositThickness, distanceToSide, runs } from './geology-math.js';
import { displayClass } from './pits-math.js';

export const BOREHOLE_NEAR_M = 50;          // boreholes this close to a wall are drawn on it

// Display names for the bundle's source keys (the keys and URLs come from the data).
const SOURCE_NAMES = {
  geology_50k: 'BGS Geology 50k', shallow_coal: 'BGS Shallow Coal (opencast coal resource areas)',
  britpits: 'BGS BritPits (mines and quarries)', boreholes: 'BGS Borehole Index', mine_plans: 'BGS Mine Plans index',
};

const title = s => String(s || '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

// Mine plans matched to the pits in the bundle, one per catalogue number.
export function minePlans(sub) {
  const out = new Map();
  for (const p of sub?.pits || []) for (const pl of p.plans || []) {
    if (!pl.catalogue || out.has(pl.catalogue)) continue;
    out.set(pl.catalogue, { catalogue: String(pl.catalogue), mine: title(pl.mine_name || p.name), year: pl.year_abandoned || null, seams: pl.seams?.length || 0 });
  }
  return [...out.values()].sort((a, b) => a.catalogue.localeCompare(b.catalogue, 'en', { numeric: true }));
}

// The legend: which units, sheets, deposits, coal, boreholes and pits the
// walls and the surface actually show. Wm, Hm: the model's size in metres.
export function legendModel(sub, { Wm, Hm } = {}) {
  const W = sub?.walls; if (!W) return null;
  const nominal = sub.nominal_thickness_m || {};
  const units = W.units || [];
  const used = { bedrock: new Set(), cover: new Set() };
  let coal = false, opencast = false;
  for (const side of SIDES) {
    const R = W.sides?.[side]; if (!R) continue;
    R.bedrock?.forEach((j, i) => {
      if (j >= 0) used.bedrock.add(j);
      if (R.shallow_coal?.[i]) { coal = opencast = true; }
      if (j >= 0 && /coal/i.test(units[j]?.LEX_D || '')) coal = true;
    });
    for (const k of ['superficial', 'artificial']) R[k]?.forEach(j => { if (j >= 0) used.cover.add(j); });
  }
  const label = u => [u.LEX_D, u.RCS_D].filter(Boolean).join(' — ');
  const bedrock = [], sheets = [], cover = [];
  for (const j of [...used.bedrock].sort((a, b) => a - b)) {
    const u = units[j], T = sheetThickness(u, nominal);
    (T ? sheets : bedrock).push({ unit: u, index: j, label: label(u), ...(T ? { thickness: T } : {}) });
  }
  for (const j of [...used.cover].sort((a, b) => a - b)) {
    const u = units[j];
    cover.push({ unit: u, index: j, label: u.LEX_D, thickness: depositThickness(u.LEX_D, nominal), artificial: u.layer === 'artificial' });
  }
  // boreholes drawn on a wall: within BOREHOLE_NEAR_M and with a recorded depth
  const boreholes = [];
  if (Wm && Hm) for (const b of sub.boreholes || []) {
    if (!(b.length_m > 0)) continue;
    const d = Math.min(...[0, 1, 2, 3].map(k => distanceToSide(k, b.x, b.y, Wm, Hm).d));
    if (d <= BOREHOLE_NEAR_M) boreholes.push({ ref: b.ref, name: b.name, year: b.year, depth: b.length_m, log: b.ags ? 'AGS log' : 'scanned log, not read' });
  }
  const pits = { coal: [], unknown: [], quarry: [] };
  for (const p of sub.pits || []) { const c = displayClass(p); if (pits[c] && !pits[c].includes(p.name)) pits[c].push(p.name); }
  const ranges = Object.entries(nominal.sheets || {}).map(([k, v]) => `${k}s ${[].concat(v).join('–')} m`);
  return { bedrock, sheets, cover, coal, opencast, boreholes, pits, plans: minePlans(sub), sheetRanges: ranges,
    madeGround: cover.some(c => c.artificial || /made ground|infilled|landscaped|worked ground/i.test(c.label)),
    labels: sub.labels || {} };
}

// Source list, from the bundle's sources section.
export function sourceList(sub) {
  const S = sub?.sources || {}, out = [];
  for (const [k, v] of Object.entries(S)) {
    let name = SOURCE_NAMES[k] || k;
    if (k === 'geology_50k') {
      const vs = (v.versions || []).map(x => `v${x.version}${x.released ? ` (released ${x.released})` : ''}`);
      if (vs.length) name += ` ${vs.join(', ')}`;
    }
    if (k === 'mine_plans') {
      const cats = minePlans(sub).map(p => p.catalogue);
      name += cats.length ? ` (plan${cats.length > 1 ? 's' : ''} ${cats.join(', ')})` : ' (no plan matched to a pit here)';
    }
    out.push({ key: k, name, url: typeof v === 'string' ? v : v.service || null, ...(v.map_sheets ? { sheets: v.map_sheets } : {}) });
  }
  return out;
}

// One line for image captions: the BGS attribution, the NC notice and the
// sources, with what is nominal or schematic.
export function captionNote(sub) {
  if (!sub) return '';
  const nc = sub.nonCommercial ? ' (non-commercial use only)' : '';
  const src = sourceList(sub).map(s => s.name.replace(/ \(released [^)]*\)/g, '')).join('; ');
  return `${sub.attribution}${nc}: ${src}. Superficial and sheet thicknesses nominal; coal seams schematic`;
}

// The nominal-thickness table, as rows of [what, metres].
export function nominalTable(sub) {
  const n = sub?.nominal_thickness_m || {}, rows = [];
  for (const [k, v] of Object.entries(n.superficial || {})) rows.push([k, String(v)]);
  for (const [k, v] of Object.entries(n.sheets || {})) rows.push([k, [].concat(v).join('–')]);
  return rows;
}

// Counts of what the walls and surface show.
export function subsurfaceCounts(sub, legend) {
  const sides = Object.fromEntries(SIDES.map(s => [s, sub?.walls?.sides?.[s]?.m?.length || 0]));
  const pits = { coal: 0, unknown: 0, quarry: 0 };
  for (const p of sub?.pits || []) { const c = displayClass(p); if (c in pits) pits[c]++; }
  const coalRuns = SIDES.reduce((n, s) => {
    const R = sub?.walls?.sides?.[s]; if (!R) return n;
    const u = sub.walls.units || [];
    return n + runs(R.m.map((_, i) => !!R.shallow_coal?.[i] || /coal/i.test(u[R.bedrock[i]]?.LEX_D || ''))).filter(r => r.v).length;
  }, 0);
  return {
    wall_samples: sides, sample_step_m: sub?.walls?.step_m ?? null,
    bedrock_units: legend?.bedrock.length ?? 0, sheets: legend?.sheets.length ?? 0, superficial_units: legend?.cover.length ?? 0,
    coal_runs_on_walls: coalRuns, boreholes_in_bundle: sub?.boreholes?.length || 0, boreholes_on_walls: legend?.boreholes.length ?? 0,
    pits, mine_plans: legend?.plans.length ?? 0,
  };
}

// The manifest written beside the unfolded-walls export.
export function subsurfaceManifest(sub, { name = '', Wm, Hm, zExag, vex, generated = new Date() } = {}) {
  const legend = legendModel(sub, { Wm, Hm });
  return {
    schema: 'hyperscale-landscapes/subsurface-manifest@1',
    name, generated: generated.toISOString().slice(0, 10), fetched: sub?.fetched || null,
    attribution: sub?.attribution || null, nonCommercial: !!sub?.nonCommercial,
    notice: sub?.nonCommercial ? `${sub.attribution}. BGS 1:50 000 geology is licensed for non-commercial use only; commercial reuse needs a BGS licence.` : null,
    sources: sourceList(sub), mine_plans: legend?.plans || [],
    nominal_thickness_m: sub?.nominal_thickness_m || {},
    labels: sub?.labels || {},
    scale: { model_terrain_exaggeration: zExag ?? null, diagram_vertical_exaggeration: vex ?? null },
    counts: subsurfaceCounts(sub, legend),
  };
}
