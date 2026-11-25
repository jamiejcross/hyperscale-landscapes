// Node tests for the screen-only terrain (Anthropogenic, Stage 1) and the
// slab-border edge extraction (Stage 3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gridStep, smoothTerrain, bilinear, gridMesh, liftWalls, borderEdges } from '../../web/js/scene/screenterrain.js';

// A flat 20 x 20 cell surface at z = 10 (cell 0.3 mm), with a channel cut
// 1 mm deep along x = 3 mm and a hole (no vertices) at x = 4.5 mm; every
// vertex is listed twice, as the print mesh repeats seam vertices.
function synthetic() {
  const P = [];
  for (let j = 0; j <= 20; j++) for (let i = 0; i <= 20; i++) {
    const x = i * 0.3, y = j * 0.3;
    if (i === 15) continue;                                   // the hole
    const z = i === 10 ? 9 : 10;                              // the channel
    P.push(x, y, z, x, y, z);
  }
  return new Float32Array(P);
}

test('grid step: median gap between distinct x values, despite duplicated vertices', () => {
  const P = synthetic();
  assert.ok(Math.abs(gridStep(P) - 0.3) < 1e-6);
  // a naive estimate from the vertex count would be wrong here
  const naive = 6 / (Math.sqrt(P.length / 3) - 1);
  assert.ok(Math.abs(naive - 0.3) > 0.05);
});

test('a cut channel and a hole come back flat', () => {
  const T = smoothTerrain(synthetic());
  assert.deepEqual([T.nx, T.ny], [21, 21]);
  assert.ok(T.stats.holesFilled === 21, `filled ${T.stats.holesFilled}`);
  for (let k = 0; k < T.heights.length; k++) assert.ok(Math.abs(T.heights[k] - 10) < 1e-5, `node ${k}: ${T.heights[k]}`);
  assert.equal(T.stats.maxDzMm < 1e-5, true);
});

test('bilinear sampling hits the grid nodes exactly and interpolates between them', () => {
  const S = Float32Array.from([0, 1, 2, 3, 4, 5]);           // 3 x 2 nodes
  const f = bilinear(S, 3, 2, 10, 20, 0.5);
  for (let j = 0; j < 2; j++) for (let i = 0; i < 3; i++) assert.equal(f(10 + i * 0.5, 20 + j * 0.5), S[j * 3 + i]);
  assert.equal(f(10.25, 20), 0.5);
  assert.equal(f(10.25, 20.25), 2);
});

test('grid mesh is regular, indexed and UV-mapped from plan position', () => {
  const T = smoothTerrain(synthetic());
  const m = gridMesh(T, 6, 6);
  assert.equal(m.positions.length, 21 * 21 * 3);
  assert.equal(m.indices.length, 20 * 20 * 6);
  assert.equal(m.uvs[2 * 440], 1); assert.equal(m.uvs[2 * 440 + 1], 1);
});

test('wall tops move to the smoothed height; the bottom edge stays', () => {
  const T = smoothTerrain(synthetic());
  // one wall quad on the south edge, from z = 0 to the old top at 9.5
  const W = new Float32Array([0, 0, 0, 3, 0, 0, 3, 0, 9.5, 0, 0, 0, 3, 0, 9.5, 0, 0, 9.5,
    3, 3, 0, 3, 3.3, 0, 3, 3.3, 9.5]);                            // an internal wall, not kept
  const r = liftWalls(W, T.sample, T);
  assert.deepEqual([...r.keep], [1, 1, 0]);
  for (const i of [2, 5, 11]) assert.equal(r.positions[i], 0);
  for (const i of [8, 14, 17]) assert.ok(Math.abs(r.positions[i] - 10) < 1e-5);
});

test('slab border on a box: 12 edges (creases), no face diagonals', () => {
  const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const P = [];
  for (const [a, b, c, d] of quads) for (const k of [a, b, c, a, c, d]) P.push(...v[k]);
  const seg = borderEdges(new Float32Array(P));
  assert.equal(seg.length / 6, 12);
  // an open strip (one wall): its outline, 4 edges
  const strip = new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1]);
  assert.equal(borderEdges(strip).length / 6, 4);
});
