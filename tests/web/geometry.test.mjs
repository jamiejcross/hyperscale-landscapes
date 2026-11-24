// Node tests for the browser geometry (run: node --test tests/web).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slabFromMask, extrude, concat, clipRing } from '../../web/js/geom/model.js';
import { classify, status } from '../../web/js/data/overpass.js';

// Watertight = every edge used exactly twice, once in each direction.
function watertight({ indices: I }) {
  const e = new Map();
  for (let t = 0; t < I.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = I[t + k], b = I[t + (k + 1) % 3];
    e.set(`${a},${b}`, (e.get(`${a},${b}`) || 0) + 1);
  }
  for (const [k, n] of e) { const [a, b] = k.split(','); if (n !== 1 || e.get(`${b},${a}`) !== 1) return false; }
  return true;
}
function volume({ positions: P, indices: I }) {
  let v = 0;
  for (let t = 0; t < I.length; t += 3) {
    const [a, b, c] = [3 * I[t], 3 * I[t + 1], 3 * I[t + 2]];
    v += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
  }
  return v;
}
const grid = { nx: 6, ny: 5, cx: 5, cy: 4, dx: 1, dy: 1, Hmm: 4 };

test('slab from an L-shaped mask is watertight with positive volume', () => {
  const m = new Uint8Array(20);
  [0, 1, 2, 5, 10, 15, 16].forEach(k => m[k] = 1);
  const s = slabFromMask(grid, m, () => 2, () => 0);
  assert.ok(watertight(s));
  assert.ok(Math.abs(volume(s) - 7 * 2) < 1e-6);
});

test('slab with a hole (ring of cells) is watertight', () => {
  const m = new Uint8Array(20).fill(1); m[6] = 0; m[7] = 0;
  const s = slabFromMask(grid, m, v => 1 + (v % 3) * 0.1, () => -1);
  assert.ok(watertight(s));
  assert.ok(volume(s) > 0);
});

test('extrude: either winding, with a hole, gives a closed positive solid', () => {
  const cw = [[0, 0], [0, 10], [10, 10], [10, 0]];
  const hole = [[3, 3], [7, 3], [7, 7], [3, 7]];
  const s = extrude([cw, hole], 0, 2);
  assert.ok(watertight(s));
  assert.ok(Math.abs(volume(s) - (100 - 16) * 2) < 1e-4);
  const both = concat([s, extrude([[[20, 0], [25, 0], [25, 5], [20, 5]]], 0, 1)]);
  assert.ok(watertight(both));
});

test('classification matches the Python tier on shared cases', () => {
  assert.deepEqual(classify({ power: 'substation' }), ['power', 'substation']);
  assert.deepEqual(classify({ power: 'generator', 'generator:source': 'wind' }), ['power', 'generator:wind']);
  assert.deepEqual(classify({ power: 'plant', 'plant:storage': 'battery' }), ['power', 'battery']);
  assert.deepEqual(classify({ power: 'construction', construction: 'substation' }), ['power', 'substation']);
  assert.deepEqual(classify({ man_made: 'spoil_heap' }), ['residues', 'man_made:spoil_heap']);
  assert.deepEqual(classify({ amenity: 'school' }), ['receptors', 'school']);
  assert.equal(classify({ building: 'house' }), null);
  assert.equal(status({ railway: 'abandoned' }), 'disused');
  assert.equal(status({ 'proposed:power': 'substation' }), 'proposed');
});

test('diagonal-only contacts are bridged so slabs stay watertight', async () => {
  const { fixDiagonals } = await import('../../web/js/geom/model.js');
  const m = new Uint8Array(20);
  [0, 6, 12, 8, 14].forEach(k => m[k] = 1);              // a staircase + a second diagonal pair
  const taken = new Uint8Array(20); taken[1] = 1;        // one bridging cell belongs to another layer
  fixDiagonals(m, 5, 4, taken);
  assert.equal(m[1], 0, 'never takes a cell owned by another layer');
  const s = slabFromMask(grid, m, () => 1, () => 0);
  assert.ok(watertight(s));
});

test('clipRing splits an outline that leaves the margin and comes back', () => {
  // Both legs of a U cross the margin line y = 1.
  const U = [[0, 0], [1.5, 0], [1.5, 3], [2.5, 3], [2.5, 0], [4, 0], [4, 4], [0, 4]];
  const out = clipRing(U, 1, 1, 10, 10);
  assert.equal(out.length, 1);                       // the bridge at the top keeps it one piece
  const W = clipRing([[2, -1], [3, 3], [4, -1], [5, 3], [6, -1]], -10, 0, 10, 10);
  assert.equal(W.length, 2);                         // a W crossing y = 0 becomes two pieces
  for (const r of W) {
    assert.ok(r.every(([, y]) => y >= 0));
    assert.ok(watertight(extrude([r], 0, 1)));
  }
  assert.equal(clipRing([[0, 0], [0.5, 0], [0.5, 0.5]], 1, 1, 10, 10).length, 0);
});
