// Screen-only terrain for looks that ask for it (Anthropogenic; brief Stage 1).
//
// The print terrain mesh has channels cut along watercourses and holes that
// the print files fill with the water and base meshes. Seen on screen these
// read as fins, teeth and holes, and smoothing the vertex heights does not
// remove them (they come from the holes and internal walls, not from bumpy
// heights). So a separate regular mesh is built from the print mesh's own
// heights instead:
//   1. grid step = median gap between distinct vertex x values;
//   2. each cell takes the MAXIMUM z of the vertices that round into it
//      (channel cuts only go down, so max ignores them);
//   3. empty cells (the channel holes) are filled from their 8 neighbours;
//   4. a 3x3 closing (max, then min) shuts narrow notches;
//   5. a (2r+1)^2 mean, radius r (default 1);
//   6. a regular indexed mesh over the grid nodes, sampled bilinearly.
// The outer walls' top vertices are then moved to the smoothed height so the
// slab stays sealed. The print mesh, 3MF and STL are never touched.
//
// Pure functions on typed arrays (no imports), so Node can test this file.

// Median gap between distinct x values (rounded to 1e-4 mm). Counting
// vertices would be wrong: the print mesh repeats vertices along seams.
export function gridStep(positions) {
  const xs = new Set();
  for (let i = 0; i < positions.length; i += 3) xs.add(Math.round(positions[i] * 1e4));
  const s = [...xs].sort((a, b) => a - b), gaps = [];
  for (let i = 1; i < s.length; i++) { const d = (s[i] - s[i - 1]) / 1e4; if (d > 1e-3) gaps.push(d); }
  gaps.sort((a, b) => a - b);
  return gaps.length ? gaps[gaps.length >> 1] : null;
}

function bounds(P) {
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i], y = P[i + 1];
    if (x < xmin) xmin = x; if (x > xmax) xmax = x; if (y < ymin) ymin = y; if (y > ymax) ymax = y;
  }
  return { xmin, xmax, ymin, ymax };
}

const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];

// 3x3 neighbourhood reduce (max or min), ignoring NaN.
function filter3(A, NX, NY, f) {
  const out = new Float32Array(A.length);
  for (let iy = 0; iy < NY; iy++) for (let ix = 0; ix < NX; ix++) {
    let v = A[iy * NX + ix];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const jx = ix + dx, jy = iy + dy;
      if (jx < 0 || jy < 0 || jx >= NX || jy >= NY) continue;
      const w = A[jy * NX + jx];
      if (!Number.isNaN(w)) v = Number.isNaN(v) ? w : f(v, w);
    }
    out[iy * NX + ix] = v;
  }
  return out;
}

// positions: the print terrain's top-surface vertices (x, y, z mm, z up).
// opts: { cell (mm; detected if absent), radius (mean radius in cells, default 1) }
export function smoothTerrain(positions, { cell = null, radius = 1 } = {}) {
  const P = positions, b = bounds(P);
  cell ||= gridStep(P) || 0.3;
  const NX = Math.round((b.xmax - b.xmin) / cell) + 1, NY = Math.round((b.ymax - b.ymin) / cell) + 1;
  // 2. max z per node
  const raw = new Float32Array(NX * NY).fill(NaN);
  for (let i = 0; i < P.length; i += 3) {
    const ix = Math.round((P[i] - b.xmin) / cell), iy = Math.round((P[i + 1] - b.ymin) / cell);
    if (ix < 0 || iy < 0 || ix >= NX || iy >= NY) continue;
    const k = iy * NX + ix;
    if (!(raw[k] >= P[i + 2])) raw[k] = P[i + 2];
  }
  // 3. fill the holes (at least 2 filled neighbours; up to 12 passes)
  const G = Float32Array.from(raw);
  let empty = 0; for (const v of raw) if (Number.isNaN(v)) empty++;
  for (let it = 0; it < 12; it++) {
    const next = Float32Array.from(G); let left = 0;
    for (let k = 0; k < G.length; k++) {
      if (!Number.isNaN(G[k])) continue;
      const ix = k % NX, iy = (k / NX) | 0; let s = 0, n = 0;
      for (const [dx, dy] of N8) {
        const jx = ix + dx, jy = iy + dy;
        if (jx < 0 || jy < 0 || jx >= NX || jy >= NY) continue;
        const v = G[jy * NX + jx]; if (!Number.isNaN(v)) { s += v; n++; }
      }
      if (n >= 2) next[k] = s / n; else left++;
    }
    G.set(next);
    if (!left) break;
  }
  let unfilled = 0; for (let k = 0; k < G.length; k++) if (Number.isNaN(G[k])) { unfilled++; G[k] = 0; }
  // 4. closing: 3x3 max then 3x3 min
  const closed = filter3(filter3(G, NX, NY, Math.max), NX, NY, Math.min);
  // 5. mean of radius r
  const r = Math.max(0, Math.round(radius)), S = new Float32Array(NX * NY);
  for (let iy = 0; iy < NY; iy++) for (let ix = 0; ix < NX; ix++) {
    let s = 0, n = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const jx = ix + dx, jy = iy + dy;
      if (jx < 0 || jy < 0 || jx >= NX || jy >= NY) continue;
      s += closed[jy * NX + jx]; n++;
    }
    S[iy * NX + ix] = s / n;
  }
  // Report: change against the print surface, leaving out channel cells
  // (holes, and cells the closing raised by more than 0.05 mm).
  let maxD = 0, sumD = 0, nD = 0, channel = 0;
  for (let k = 0; k < S.length; k++) {
    if (Number.isNaN(raw[k]) || closed[k] - raw[k] > 0.05) { channel++; continue; }
    const d = Math.abs(S[k] - raw[k]); maxD = Math.max(maxD, d); sumD += d; nD++;
  }
  const sample = bilinear(S, NX, NY, b.xmin, b.ymin, cell);
  return {
    cell, nx: NX, ny: NY, ...b, heights: S, sample,
    stats: { grid: [NX, NY], cellMm: cell, holesFilled: empty - unfilled, unfilled, channelCells: channel, maxDzMm: maxD, meanDzMm: nD ? sumD / nD : 0, radius: r },
  };
}

// Bilinear height between grid nodes (node i at x0 + i * cell); exact at nodes.
export function bilinear(S, NX, NY, x0, y0, cell) {
  return (x, y) => {
    const fx = Math.min(NX - 1, Math.max(0, (x - x0) / cell)), fy = Math.min(NY - 1, Math.max(0, (y - y0) / cell));
    const ix = Math.min(NX - 2, Math.floor(fx)), iy = Math.min(NY - 2, Math.floor(fy));
    const tx = fx - ix, ty = fy - iy, at = (i, j) => S[j * NX + i];
    if (NX < 2 || NY < 2) return S[0];
    return at(ix, iy) * (1 - tx) * (1 - ty) + at(ix + 1, iy) * tx * (1 - ty) + at(ix, iy + 1) * (1 - tx) * ty + at(ix + 1, iy + 1) * tx * ty;
  };
}

// 6. A regular mesh over the grid nodes, clamped to the model's extent.
// UVs from plan position (u = x / Wmm, v = y / Hmm).
export function gridMesh(T, Wmm, Hmm) {
  const { nx, ny, xmin, ymin, xmax, ymax, cell, sample } = T;
  const pos = new Float32Array(nx * ny * 3), uv = new Float32Array(nx * ny * 2), idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = Math.min(xmax, xmin + i * cell), y = Math.min(ymax, ymin + j * cell), k = j * nx + i;
    pos[3 * k] = x; pos[3 * k + 1] = y; pos[3 * k + 2] = sample(x, y);
    uv[2 * k] = x / Wmm; uv[2 * k + 1] = y / Hmm;
  }
  let t = 0;
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
    idx[t++] = a; idx[t++] = b; idx[t++] = d; idx[t++] = a; idx[t++] = d; idx[t++] = c;
  }
  return { positions: pos, uvs: uv, indices: idx };
}

// 7. Wall tops follow the smoothed surface: keep only triangles within `eps`
// of the outer bbox edge (none of the print mesh's internal walls), and move
// every vertex above the bottom edge to the smoothed height (at least 0.2 mm
// above the bottom), so the slab stays sealed. Returns new positions and the
// kept-triangle mask (1 per triangle).
export function liftWalls(wallPositions, sample, T, eps = 0.4) {
  const P = wallPositions, out = Float32Array.from(P), keep = new Uint8Array(P.length / 9);
  let zmin = Infinity; for (let i = 2; i < P.length; i += 3) zmin = Math.min(zmin, P[i]);
  let moved = 0;
  for (let t = 0; t < keep.length; t++) {
    const o = 9 * t, cx = (P[o] + P[o + 3] + P[o + 6]) / 3, cy = (P[o + 1] + P[o + 4] + P[o + 7]) / 3;
    keep[t] = cx - T.xmin < eps || T.xmax - cx < eps || cy - T.ymin < eps || T.ymax - cy < eps ? 1 : 0;
  }
  for (let i = 0; i < P.length; i += 3) {
    if (P[i + 2] - zmin < 0.05) continue;                       // the bottom edge stays
    const x = Math.min(T.xmax, Math.max(T.xmin, P[i])), y = Math.min(T.ymax, Math.max(T.ymin, P[i + 1]));
    out[i + 2] = Math.max(zmin + 0.2, sample(x, y)); moved++;
  }
  return { positions: out, keep, moved, zmin };
}

// Slab border (Stage 3): edges of a triangle soup that are boundary edges
// (used once) or creases (face normals' dot product < `crease`), as line
// segments [x0, y0, z0, x1, y1, z1, ...]. `keep` (optional) masks triangles.
export function borderEdges(P, { crease = 0.5, keep = null } = {}) {
  const key = i => `${Math.round(P[i] * 200)},${Math.round(P[i + 1] * 200)},${Math.round(P[i + 2] * 200)}`;
  const E = new Map();
  for (let t = 0; t < P.length / 9; t++) {
    if (keep && !keep[t]) continue;
    const a = 9 * t, b = a + 3, c = a + 6;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz); if (!l) continue;
    nx /= l; ny /= l; nz /= l;
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const kp = key(p), kq = key(q), k = kp < kq ? `${kp}|${kq}` : `${kq}|${kp}`;
      const e = E.get(k);
      if (e) { e.n++; e.dot = Math.min(e.dot, e.nx * nx + e.ny * ny + e.nz * nz); }
      else E.set(k, { p, q, n: 1, nx, ny, nz, dot: 1 });
    }
  }
  const seg = [];
  for (const e of E.values()) if (e.n === 1 || e.dot < crease) seg.push(P[e.p], P[e.p + 1], P[e.p + 2], P[e.q], P[e.q + 1], P[e.q + 2]);
  return new Float32Array(seg);
}
