// Node tests for the Anthropogenic look's painted surface (planning steps only;
// the painting itself needs a canvas and is checked in tools/shoot.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recolourData, crownPlan, heightMetres, hazeRange, glyphPoints } from '../../web/js/scene/carto.js';
import { PALETTES } from '../../web/js/scene/palettes.js';
import { parseView, STYLES } from '../../web/js/urlstate.js';

const C = PALETTES.anthropogenic.carto;

test('recolour: nearest palette colour, off-palette pixels fall back to base land', () => {
  const map = [[[187, 168, 134], [1, 1, 1]], [[200, 0, 0], [2, 2, 2]]];      // base first
  const d = new Uint8ClampedArray([187, 168, 134, 255, 205, 3, 2, 255, 0, 255, 0, 255]);
  recolourData(d, map, 900);
  assert.deepEqual([...d.slice(0, 3)], [1, 1, 1]);
  assert.deepEqual([...d.slice(4, 7)], [2, 2, 2]);                 // within 30 of red
  assert.deepEqual([...d.slice(8, 11)], [1, 1, 1]);                // green: far from all -> base land
});

const wood = { rings: [[10, 10, 30, 10, 30, 30, 10, 30]], leaf: null };
test('crowns: same seed gives the same crowns; another seed differs', () => {
  const a = crownPlan({ woods: [wood], C, mmPerM: 0.1, Wmm: 50, Hmm: 50, seed: 7 });
  const b = crownPlan({ woods: [wood], C, mmPerM: 0.1, Wmm: 50, Hmm: 50, seed: 7 });
  const c = crownPlan({ woods: [wood], C, mmPerM: 0.1, Wmm: 50, Hmm: 50, seed: 8 });
  assert.ok(a.crowns.length > 100);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.crowns.slice(0, 5), c.crowns.slice(0, 5));
  for (let i = 1; i < a.crowns.length; i++) assert.ok(a.crowns[i].y <= a.crowns[i - 1].y);   // north first
  assert.ok(a.crowns.every(k => k.x >= 10 && k.x <= 30 && k.y >= 10 && k.y <= 30));
});

test('crowns: canopy-model trees replace the grid in woods that contain them', () => {
  const trees = { count: 1, x: [200], y: [200], h: [12], crownR: [3], archetype: [0], archetypes: ['broadleaf'] };
  const p = crownPlan({ woods: [wood, { rings: [[40, 40, 45, 40, 45, 45, 40, 45]] }], trees, C, mmPerM: 0.1, Wmm: 50, Hmm: 50, seed: 1 });
  assert.equal(p.counts.canopy, 1);
  assert.ok(p.crowns.filter(k => k.src === 'grid').every(k => k.x >= 40));    // only the wood without a canopy tree
  assert.equal(p.counts.row, 0);
});

test('height grid back to metres', () => {
  const grid = { nx: 2, ny: 2, dx: 10, dy: 10, Hmm: 10, mmPerM: 0.1 };
  const f = heightMetres(grid, new Float32Array([5, 5, 5, 5.4]), { base: 5, zExag: 2, minM: 30 });
  assert.equal(f(0, 100), 30);                                   // NW node
  assert.ok(Math.abs(f(100, 0) - 32) < 1e-5);                    // SE node: 0.4 mm / (2 x 0.1) = 2 m above 30
});

test('fog distances follow the camera distance', () => {
  const [n, f] = hazeRange(200, C);
  assert.ok(Math.abs(n - 110) < 1e-9 && Math.abs(f - 350) < 1e-9);
});

test('glyphs: recorded heights x1.3, defaults flagged as assumed', () => {
  const g = glyphPoints({ props: { supports: [{ x: 10, y: 10, height: 40, kind: 'tower' }, { x: 20, y: 20, kind: 'pole' }], turbines: [{ x: 30, y: 30 }] },
    mmPerM: 0.1, Wmm: 50, Hmm: 50, C });
  assert.deepEqual(g.counts, { pylon: 1, pole: 1, turbine: 1 });
  assert.ok(Math.abs(g.points[0].hMm - 40 * 1.3 * 0.1) < 1e-9);
  assert.deepEqual(g.assumed, { pylonHeight: 1, turbineHeight: 1 });
});

test('URL: ?style=anthropogenic round-trips', () => {
  assert.ok(STYLES.includes('anthropogenic'));
  assert.equal(parseView('?style=anthropogenic').style, 'anthropogenic');
});
