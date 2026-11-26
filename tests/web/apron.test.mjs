// Node tests for the context apron's pure parts (scene/apron-math.js), on a
// real bundle's context section (Auchtertool) and on small synthetic grids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { decodeContextGrid, apronMesh, landFade, edgeBlend, lineFade, distOutside, contextFeatures, centroid, cullLabels, contextShade } from '../../web/js/scene/apron-math.js';

const bundle = JSON.parse(gunzipSync(readFileSync(new URL('../../data/sites/auchtertool-cato.bundle.json.gz', import.meta.url))));
const E = bundle.context.elevation;
const M_PER_DEG_LAT = 111320;
const bb = bundle.bbox, mlon = M_PER_DEG_LAT * Math.cos((bb.min_lat + bb.max_lat) / 2 * Math.PI / 180);
const Wm = (bb.max_lon - bb.min_lon) * mlon, Hm = (bb.max_lat - bb.min_lat) * M_PER_DEG_LAT;
const mmPerM = 200 / Math.max(Wm, Hm), Wmm = Wm * mmPerM, Hmm = Hm * mmPerM;
const lin = (a, b, n) => Array.from({ length: n }, (_, i) => i === n - 1 ? b : a + (b - a) * i / (n - 1));

function build(edgeZ = () => 7) {
  const z = decodeContextGrid(E);
  return apronMesh({ E, z, mm: { mmPerM, base: 5, zExag: 2, minM: 60 }, Wmm, Hmm,
    edge: { xs: lin(0, Wmm, 301), ys: lin(0, Hmm, 271) }, edgeZ });
}

test('the decoded grid matches the bundle size and the stated offset range', () => {
  const z = decodeContextGrid(E);
  assert.equal(z.length, E.w * E.h);
  const lo = Math.min(...z), hi = Math.max(...z);
  assert.ok(lo > -5 && hi < 400 && hi > lo, `${lo}..${hi}`);
});

test('no apron triangle lies inside the model, and every one faces up', () => {
  const m = build(), P = m.positions, I = m.indices;
  for (let t = 0; t < I.length; t += 3) {
    const [a, b, c] = [I[t], I[t + 1], I[t + 2]].map(i => [P[3 * i], P[3 * i + 1]]);
    const cx = (a[0] + b[0] + c[0]) / 3, cy = (a[1] + b[1] + c[1]) / 3;
    assert.ok(!(cx > 1e-6 && cx < Wmm - 1e-6 && cy > 1e-6 && cy < Hmm - 1e-6), `triangle ${t / 3} inside at ${cx},${cy}`);
    assert.ok((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) >= 0);
  }
});

test('the apron shares the model edge exactly: each boundary segment once, at the edge heights', () => {
  const m = build((x, y) => 5 + x * 0.01 + y * 0.02), P = m.positions, I = m.indices;
  const inner = new Set(m.inner);
  for (const i of inner) {
    const x = P[3 * i], y = P[3 * i + 1];
    assert.ok(Math.min(Math.abs(x), Math.abs(x - Wmm), Math.abs(y), Math.abs(y - Hmm)) < 1e-4);
    assert.ok(Math.abs(P[3 * i + 2] - (5 + x * 0.01 + y * 0.02)) < 1e-4);
  }
  assert.equal(inner.size, 2 * (301 - 1) + 2 * (271 - 1));
  const edges = new Map();
  for (let t = 0; t < I.length; t += 3) for (const [a, b] of [[I[t], I[t + 1]], [I[t + 1], I[t + 2]], [I[t + 2], I[t]]]) {
    if (!inner.has(a) || !inner.has(b)) continue;
    const k = a < b ? `${a},${b}` : `${b},${a}`; edges.set(k, (edges.get(k) || 0) + 1);
  }
  assert.equal(edges.size, inner.size);                    // a closed loop round the model
  for (const n of edges.values()) assert.equal(n, 1);
});

test('the apron covers the padded area less the model (area check)', () => {
  const m = build(), P = m.positions, I = m.indices, x = m.extent;
  let A = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = 3 * I[t], b = 3 * I[t + 1], c = 3 * I[t + 2];
    A += ((P[b] - P[a]) * (P[c + 1] - P[a + 1]) - (P[b + 1] - P[a + 1]) * (P[c] - P[a])) / 2;
  }
  const want = (x.x1 - x.x0) * (x.y1 - x.y0) - Wmm * Hmm;
  assert.ok(Math.abs(A - want) / want < 1e-6, `${A} vs ${want}`);
});

test('heights follow the model mapping and are held above the ground plane', () => {
  const z = decodeContextGrid(E);
  const m = apronMesh({ E, z, mm: { mmPerM, base: 5, zExag: 2, minM: 200 }, Wmm, Hmm, edge: { xs: [0, Wmm], ys: [0, Hmm] }, edgeZ: () => 5, floor: 0.3 });
  let lo = Infinity; for (let i = 2; i < m.positions.length; i += 3) lo = Math.min(lo, m.positions[i]);
  assert.ok(lo >= 0.3 - 1e-6 && m.stats.clamped > 0);
});

test('fades: land none at the edge to 0.88 at the pad; edge blend over the first 20%; lines at most 45%', () => {
  assert.equal(landFade(0, 100), 0);
  assert.equal(edgeBlend(0, 100), 0); assert.equal(edgeBlend(20, 100), 1); assert.ok(edgeBlend(10, 100) > 0 && edgeBlend(10, 100) < 1);
  assert.ok(Math.abs(landFade(100, 100) - 0.88) < 1e-9 && Math.abs(landFade(1e6, 100) - 0.88) < 1e-9);
  assert.equal(lineFade(0, 100), 0);
  assert.ok(Math.abs(lineFade(100, 100) - 0.45) < 1e-9);
  assert.equal(distOutside(5, 5, 10, 10), 0);
  assert.equal(distOutside(13, 14, 10, 10), 5);
});

test('context features: names outside the model only, once each', () => {
  const toMm = (lon, lat) => [(lon - bb.min_lon) * mlon * mmPerM, (lat - bb.min_lat) * M_PER_DEG_LAT * mmPerM];
  const { vectors: V, names } = contextFeatures(bundle.context.osm.elements, toMm, Wmm, Hmm);
  assert.ok(V.roads.length > 10 && V.powerLines.length > 0);
  for (const n of names) assert.ok(distOutside(n.x, n.y, Wmm, Hmm) > 0, n.name);
  assert.equal(new Set(names.map(n => `${n.kind}|${n.name}`)).size, names.length);
  assert.ok(names.some(n => /Mossmorran/i.test(n.name)) || names.some(n => n.kind === 'village'), JSON.stringify(names.slice(0, 5)));
});

test('centroid of a square ring, and labels culled when they overlap', () => {
  assert.deepEqual(centroid([0, 0, 2, 0, 2, 2, 0, 2]), [1, 1]);
  const keep = cullLabels([{ x: 100, y: 100, w: 60, h: 20, rank: 1, ok: true }, { x: 110, y: 105, w: 60, h: 20, rank: 0, ok: true },
    { x: 300, y: 100, w: 60, h: 20, rank: 2, ok: true }, { x: 500, y: 100, w: 60, h: 20, rank: 0, ok: false }]);
  assert.deepEqual(keep, [false, true, true, false]);
});

test('hillshade of a flat grid is the flat grey', () => {
  const e = { w: 4, h: 3, dx_m: 20, dy_m: 20 };
  assert.ok(contextShade(new Float32Array(12).fill(50), e).every(v => v === 236));
});

