// Pure helpers for the 3D props (trees, turbines, pylons, lines). No imports,
// so Node can test this file directly.

// Height (print mm, z up) at print coordinates, bilinear on the model's own
// height grid (row 0 is the north edge), as geom/model.js samples it.
export function heightSampler({ nx, ny, dx, dy, Hmm }, z) {
  return (x, y) => {
    const fi = Math.min(Math.max(x / dx, 0), nx - 1.0001), fj = Math.min(Math.max((Hmm - y) / dy, 0), ny - 1.0001);
    const i = Math.floor(fi), j = Math.floor(fj), a = fi - i, b = fj - j;
    const v = (ii, jj) => z[jj * nx + ii];
    return (1 - a) * (1 - b) * v(i, j) + a * (1 - b) * v(i + 1, j) + (1 - a) * b * v(i, j + 1) + a * b * v(i + 1, j + 1);
  };
}

// Rotation about z (radians, counter-clockwise, model x east / y north) that
// turns local +Y to face a compass bearing (degrees clockwise from north).
export const yawForBearing = deg => -deg * Math.PI / 180;

// Points along a power-line span from a to b ([x, y, z]), sagging `sag`
// (a fraction of the horizontal span) at mid-span; a parabola, which is
// indistinguishable from a catenary at a 2% sag.
export function spanPoints(a, b, sag = 0.02, n = 8) {
  const span = Math.hypot(b[0] - a[0], b[1] - a[1]), out = [];
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t - 4 * sag * span * t * (1 - t)]);
  }
  return out;
}

// Small seeded generator (mulberry32) for colour jitter and rotation.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Above this many trees, trunks are dropped for trees under 8 m (performance).
export const TRUNK_LIMIT = 15000, TRUNK_MIN_M = 8;
export const drawTrunk = (count, hM) => count <= TRUNK_LIMIT || hM >= TRUNK_MIN_M;

// Clip segment p-q ([x, y, z]) to the rectangle 0..W x 0..H in plan
// (Liang-Barsky; z interpolated). Returns [p', q'] or null if outside.
export function clipSegment(p, q, W, H) {
  const dx = q[0] - p[0], dy = q[1] - p[1];
  let t0 = 0, t1 = 1;
  for (const [pk, qk] of [[-dx, p[0]], [dx, W - p[0]], [-dy, p[1]], [dy, H - p[1]]]) {
    if (pk === 0) { if (qk < 0) return null; continue; }
    const r = qk / pk;
    if (pk < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
    else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  const at = t => p.map((v, i) => v + (q[i] - v) * t);
  return [at(t0), at(t1)];
}
