// Pure helpers for the geology walls (subsurface brief, Stage 2). No imports,
// so Node can test this file directly.
//
// The slab walls are mapped into a 4-strip atlas, one strip per side, each
// read left to right as seen from outside: south west->east, east
// south->north, north east->west, west north->south (as the bundle's wall
// samples run). Strip k sits at v in [(3 - k)/4, (4 - k)/4], bottom of the
// slab at the strip's low edge (the canvas texture is drawn with flipY).

export const SIDES = ['south', 'east', 'north', 'west'];

// Side index of a point (print mm), by the nearest edge.
export function sideOf(x, y, W, H) {
  const d = [y, W - x, H - y, x];
  let k = 0; for (let i = 1; i < 4; i++) if (d[i] < d[k]) k = i;
  return k;
}
// Fraction along side k, left to right seen from outside.
export const alongOf = (k, x, y, W, H) => [x / W, y / H, 1 - x / W, 1 - y / H][k];
// Atlas v for side k at height fraction f (0 = slab bottom, 1 = top).
export const atlasV = (k, f) => (3 - k + f) / 4;

// UVs for non-indexed wall triangles (positions: flat xyz), side by each
// triangle's centroid so a triangle never straddles two strips; plus the
// top-surface profile per side: the highest wall z per bin, gaps filled by
// linear interpolation.
export function wallAtlas(positions, W, H, bins = 1024) {
  const N = positions.length / 3;
  let zmin = Infinity, zmax = -Infinity;
  for (let i = 0; i < N; i++) { const z = positions[3 * i + 2]; if (z < zmin) zmin = z; if (z > zmax) zmax = z; }
  const dz = zmax - zmin || 1, uv = new Float32Array(N * 2);
  const surf = SIDES.map(() => new Float32Array(bins).fill(NaN));
  for (let i = 0; i < N; i += 3) {
    const cx = (positions[3 * i] + positions[3 * i + 3] + positions[3 * i + 6]) / 3;
    const cy = (positions[3 * i + 1] + positions[3 * i + 4] + positions[3 * i + 7]) / 3;
    const k = sideOf(cx, cy, W, H);
    for (let j = i; j < i + 3; j++) {
      const x = positions[3 * j], y = positions[3 * j + 1], z = positions[3 * j + 2];
      const t = Math.min(1, Math.max(0, alongOf(k, x, y, W, H)));
      uv[2 * j] = t; uv[2 * j + 1] = atlasV(k, (z - zmin) / dz);
      const b = Math.round(t * (bins - 1));
      if (!(surf[k][b] >= z)) surf[k][b] = z;
    }
  }
  for (const s of surf) fillGaps(s, zmin);
  return { uv, surf, zmin, zmax };
}

// Fill NaN gaps linearly between known values; ends take the nearest value.
export function fillGaps(s, fallback = 0) {
  let prev = -1;
  for (let i = 0; i < s.length; i++) {
    if (Number.isNaN(s[i])) continue;
    if (prev < 0) for (let j = 0; j < i; j++) s[j] = s[i];
    else for (let j = prev + 1; j < i; j++) s[j] = s[prev] + (s[i] - s[prev]) * (j - prev) / (i - prev);
    prev = i;
  }
  if (prev < 0) s.fill(fallback);
  else for (let j = prev + 1; j < s.length; j++) s[j] = s[prev];
  return s;
}

// Profile height at fraction t (linear between bins).
export function profileAt(s, t) {
  const f = Math.min(1, Math.max(0, t)) * (s.length - 1), i = Math.floor(f), a = f - i;
  return i >= s.length - 1 ? s[s.length - 1] : s[i] * (1 - a) + s[i + 1] * a;
}

// Depth: the walls are unscaled model mm, where 1 m of height is
// mmPerM x zExag mm (the on-screen height slider scales the whole model, so it
// needs no repaint). Model z at `m` metres below a surface at zs:
export const zBelow = (zs, m, mmPerM, zExag) => zs - m * mmPerM * zExag;
export const metresBetween = (zTop, zBot, mmPerM, zExag) => (zTop - zBot) / (mmPerM * zExag);

// Superficial and artificial deposits: nominal thickness class (metres from
// the bundle's nominal_thickness_m). Deposits outside the listed classes use
// OTHER_SUPERFICIAL_M, also nominal.
export const OTHER_SUPERFICIAL_M = 4;
export function depositClass(lexD = '') {
  const s = lexD.toLowerCase();
  if (/made ground|infilled|landscaped|worked ground|disturbed/.test(s)) return 'made ground';
  if (/peat/.test(s)) return 'peat';
  if (/till|diamicton/.test(s)) return 'till';
  if (/glaciofluvial/.test(s)) return 'glaciofluvial';
  if (/alluvi/.test(s)) return 'alluvium';
  return null;
}
export const depositThickness = (lexD, nominal) => nominal?.superficial?.[depositClass(lexD)] ?? OTHER_SUPERFICIAL_M;

// Sheets: thin units drawn as bands of nominal thickness rather than as
// vertical columns (sills, named limestone beds). Returns metres or 0.
export function sheetThickness(unit, nominal) {
  if (!unit) return 0;
  const n = nominal?.sheets || {}, name = unit.LEX_D || '', rock = unit.RCS_D || '';
  if (/\bsills?\b|sill-complex/i.test(name)) return Math.max(...(n.sill || [20]));
  if (/limestone$/i.test(name) && /^limestone$/i.test(rock)) return Math.max(...(n['limestone bed'] || [4]));
  return 0;
}

// Fill pattern from the BGS rock description (RCS_D) and unit name.
export function patternOf(unit) {
  const name = unit?.LEX_D || '', r = unit?.RCS_D || '';
  if (/coal/i.test(name)) return 'coalcycles';
  if (/cycles/i.test(r)) return 'cycles';
  if (/limestone/i.test(r)) return 'limestone';
  if (/gabbro|dolerite|basalt(?!ic tuff)|microgranite|granite/i.test(r) && !/tuff|lava/i.test(r)) return 'igneous';
  if (/tuff|lava|volcanic/i.test(r)) return 'volcanic';
  if (/sandstone/i.test(r)) return 'sandstone';
  if (/mudstone|siltstone/i.test(r)) return 'mudstone';
  if (/conglomerate/i.test(r)) return 'conglomerate';
  return 'plain';
}
export function depositPattern(lexD) {
  const c = depositClass(lexD);
  return c === 'till' ? 'till' : c === 'made ground' ? 'made' : c === 'peat' ? 'peat' : /gravel|glaciofluvial|beach/i.test(lexD || '') ? 'gravel' : 'alluvium';
}

// Colour: BGS RGB softened towards a paper colour; a per-look override (keyed
// by LEX_D, case-insensitive, else a key the name starts with, else the same
// first word for deposits) wins.
export function unitColour(unit, { units = {}, softenTowards = [236, 230, 214], softenBy = 0.45 } = {}) {
  const name = (unit?.LEX_D || '').toLowerCase(), keys = Object.keys(units);
  const hit = keys.find(k => k.toLowerCase() === name) || keys.find(k => name.startsWith(k.toLowerCase()))
    || (unit?.layer !== 'bedrock' ? keys.find(k => k.split(/[ ,]/)[0].toLowerCase() === name.split(/[ ,]/)[0]) : null);
  if (hit) return units[hit];
  const rgb = [unit?.BGSRED, unit?.BGSGREEN, unit?.BGSBLUE].map(v => +v || 200);
  return `rgb(${rgb.map((v, i) => Math.round(v * (1 - softenBy) + softenTowards[i] * softenBy)).join(',')})`;
}

// Runs of equal values along a side: [{v, i0, i1}].
export function runs(values) {
  const out = [];
  values.forEach((v, i) => { if (out.length && out.at(-1).v === v) out.at(-1).i1 = i; else out.push({ v, i0: i, i1: i }); });
  return out;
}

// Schematic coal seams under a level `zRef` (model z): [{z, thick}] in model
// mm, 0.7-2 m thick and 9-13 m apart, down to `zFloor`. Deterministic.
export function seamLevels(zRef, zFloor, mmPerM, zExag, first = 4) {
  const k = mmPerM * zExag, out = [];
  for (let m = first, j = 0; zRef - m * k > zFloor; j++) {
    out.push({ z: zRef - m * k, thick: (0.7 + ((j * 37) % 14) / 10) * k });
    m += 9 + ((j * 7) % 5);
  }
  return out;
}

// Plan-position distance (m) from a point to side k of a W x H (m) box.
export function distanceToSide(k, x, y, W, H) {
  const seg = [[0, 0, W, 0], [W, 0, W, H], [W, H, 0, H], [0, H, 0, 0]][k];
  const [ax, ay, bx, by] = seg, dx = bx - ax, dy = by - ay;
  const t = Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return { d: Math.hypot(x - ax - t * dx, y - ay - t * dy), t };   // t: fraction along the side, left to right from outside
}
