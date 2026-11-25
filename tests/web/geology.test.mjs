// Node tests for the geology-wall and 3D-prop maths (run: node --test tests/web).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sideOf, alongOf, atlasV, wallAtlas, fillGaps, profileAt, zBelow, metresBetween, depositClass, depositThickness,
  sheetThickness, patternOf, unitColour, runs, seamLevels, distanceToSide,
} from '../../web/js/scene/geology-math.js';
import { heightSampler, spanPoints, clipSegment, drawTrunk, yawForBearing, rng } from '../../web/js/scene/props-math.js';

const W = 100, H = 50;

test('sides and along-fractions run left to right as seen from outside', () => {
  assert.equal(sideOf(50, 1, W, H), 0);       // south
  assert.equal(sideOf(99, 25, W, H), 1);      // east
  assert.equal(sideOf(50, 49, W, H), 2);      // north
  assert.equal(sideOf(1, 25, W, H), 3);       // west
  assert.equal(alongOf(0, 10, 0, W, H), 0.1); // south: west -> east
  assert.equal(alongOf(1, W, 10, W, H), 0.2); // east: south -> north
  assert.equal(alongOf(2, 10, H, W, H), 0.9); // north: east -> west
  assert.equal(alongOf(3, 0, 10, W, H), 0.8); // west: north -> south
});

test('atlas strips: south on top of the canvas (flipY), bottom of slab at the low v', () => {
  assert.equal(atlasV(0, 0), 0.75); assert.equal(atlasV(0, 1), 1);
  assert.equal(atlasV(3, 0), 0); assert.equal(atlasV(3, 1), 0.25);
  // canvas row y = k*SH + SH*(1 - f) maps to v = 1 - y/(4 SH)
  const SH = 512;
  for (const k of [0, 1, 2, 3]) for (const f of [0, 0.3, 1]) assert.ok(Math.abs(atlasV(k, f) - (1 - (k * SH + SH * (1 - f)) / (4 * SH))) < 1e-12);
});

test('wall UVs put each triangle in one strip; profile takes the top of the wall', () => {
  // one south wall quad (2 triangles) from x 0..100, z 0..10 at x=0 rising to 20 at x=100,
  // and a triangle on the east wall whose centroid is nearest the east edge
  const pos = new Float32Array([
    0, 0, 0, 100, 0, 0, 100, 0, 20,
    0, 0, 0, 100, 0, 20, 0, 0, 10,
    100, 0, 0, 100, 50, 0, 100, 50, 15,
  ]);
  const { uv, surf, zmin, zmax } = wallAtlas(pos, W, H, 11);
  assert.equal(zmin, 0); assert.equal(zmax, 20);
  for (let j = 0; j < 6; j++) assert.ok(uv[2 * j + 1] >= 0.75 && uv[2 * j + 1] <= 1, `south vertex ${j}`);
  for (let j = 6; j < 9; j++) assert.ok(uv[2 * j + 1] >= 0.5 && uv[2 * j + 1] <= 0.75, `east vertex ${j}`);
  assert.equal(surf[0][0], 10); assert.equal(surf[0][10], 20);
  assert.equal(surf[0][5], 15);                       // linear between the two known bins
  assert.equal(surf[2][3], 0);                        // a side with no wall falls back to zmin
});

test('gap filling and profile interpolation are linear', () => {
  const s = fillGaps(Float32Array.from([NaN, 2, NaN, NaN, 8, NaN]));
  assert.deepEqual([...s], [2, 2, 4, 6, 8, 8]);
  assert.equal(profileAt(Float32Array.from([0, 10]), 0.25), 2.5);
  assert.equal(profileAt(Float32Array.from([0, 10]), 1), 10);
});

test('depth maths: metres to model mm through mmPerM and the terrain exaggeration', () => {
  const mmPerM = 150 / 3000, zExag = 2;            // 150 mm print of 3 km
  assert.ok(Math.abs(zBelow(12, 10, mmPerM, zExag) - 11) < 1e-12);    // 10 m = 1 mm at x2
  assert.ok(Math.abs(metresBetween(12, 11, mmPerM, zExag) - 10) < 1e-9);
});

test('deposits: nominal thickness classes', () => {
  const nominal = { superficial: { till: 6, glaciofluvial: 5, alluvium: 4, peat: 2, 'made ground': 3 } };
  assert.equal(depositClass('Till, Devensian'), 'till');
  assert.equal(depositClass('Glaciofluvial ice contact deposits'), 'glaciofluvial');
  assert.equal(depositClass('Made Ground'), 'made ground');
  assert.equal(depositClass('Infilled Ground'), 'made ground');
  assert.equal(depositThickness('Alluvium', nominal), 4);
  assert.equal(depositThickness('Peat', nominal), 2);
  assert.equal(depositThickness('Raised marine deposits, Devensian', nominal), 4);   // other: nominal default
});

test('sheets, patterns and colours', () => {
  const nominal = { sheets: { sill: [20, 30], 'limestone bed': [4, 5] } };
  assert.equal(sheetThickness({ LEX_D: 'Midland Valley Sill-Complex', RCS_D: 'Quartz-microgabbro' }, nominal), 30);
  assert.equal(sheetThickness({ LEX_D: 'Blackhall Limestone', RCS_D: 'Limestone' }, nominal), 5);
  assert.equal(sheetThickness({ LEX_D: 'Lower Limestone Formation', RCS_D: 'Sedimentary rock cycles, Clackmannan Group type' }, nominal), 0);
  assert.equal(patternOf({ LEX_D: 'Limestone Coal Formation', RCS_D: 'Sedimentary rock cycles' }), 'coalcycles');
  assert.equal(patternOf({ LEX_D: 'Kinghorn Volcanic Formation', RCS_D: 'Basaltic tuff and basaltic lava' }), 'volcanic');
  assert.equal(patternOf({ LEX_D: 'X Sill', RCS_D: 'Microgabbro' }), 'igneous');
  assert.equal(unitColour({ LEX_D: 'Pathhead Formation', BGSRED: '224', BGSGREEN: '224', BGSBLUE: '148' }), 'rgb(229,227,178)');
  const units = { 'Midland Valley Sill-complex': '#6e6c4c', Till: '#9c7f61', 'Glaciofluvial Deposits': '#b5996f' };
  assert.equal(unitColour({ LEX_D: 'Midland Valley Sill-Complex', layer: 'bedrock' }, { units }), '#6e6c4c');   // case-insensitive
  assert.equal(unitColour({ LEX_D: 'Till, Devensian', layer: 'superficial' }, { units }), '#9c7f61');             // prefix
  assert.equal(unitColour({ LEX_D: 'Glaciofluvial ice contact deposits', layer: 'superficial' }, { units }), '#b5996f');  // first word
});

test('runs, seams and distances', () => {
  assert.deepEqual(runs([1, 1, 2, -1, -1]), [{ v: 1, i0: 0, i1: 1 }, { v: 2, i0: 2, i1: 2 }, { v: -1, i0: 3, i1: 4 }]);
  const s = seamLevels(10, 0, 0.05, 2);            // 1 m = 0.1 mm
  assert.ok(s.length >= 5 && s.every(q => q.z < 10 && q.z > 0));
  for (let i = 1; i < s.length; i++) { const gap = (s[i - 1].z - s[i].z) / 0.1; assert.ok(gap >= 9 - 1e-9 && gap <= 13 + 1e-9, `gap ${gap}`); }
  assert.ok(s.every(q => q.thick / 0.1 >= 0.7 - 1e-9 && q.thick / 0.1 <= 2 + 1e-9));
  assert.deepEqual(distanceToSide(2, 25, 40, 100, 50), { d: 10, t: 0.75 });   // north wall runs east -> west
  assert.deepEqual(distanceToSide(3, -5, 10, 100, 50), { d: 5, t: 0.8 });
});

test('props: heights on the model grid, sag, clipping, trunks, yaw', () => {
  const grid = { nx: 3, ny: 2, dx: 10, dy: 10, Hmm: 10 };
  const z = Float32Array.from([0, 10, 20, 100, 110, 120]);   // row 0 is the north edge (y = 10)
  const at = heightSampler(grid, z);
  assert.equal(at(0, 10), 0); assert.equal(at(5, 10), 5); assert.ok(Math.abs(at(0, 0) - 100) < 0.02); assert.equal(at(5, 5), 55);   // edges are clamped just inside the grid
  const p = spanPoints([0, 0, 10], [100, 0, 10], 0.02, 4);
  assert.equal(p[2][2], 10 - 2);                    // 2% of a 100 mm span at mid-span
  assert.equal(p[0][2], 10); assert.equal(p[4][2], 10);
  assert.deepEqual(clipSegment([-10, 5, 0], [10, 5, 2], 100, 50), [[0, 5, 1], [10, 5, 2]]);
  assert.equal(clipSegment([-10, 5, 0], [-1, 5, 0], 100, 50), null);
  assert.equal(drawTrunk(15000, 3), true); assert.equal(drawTrunk(15001, 7.9), false); assert.equal(drawTrunk(20000, 8), true);
  assert.equal(yawForBearing(90), -Math.PI / 2);
  const a = rng(7), b = rng(7); assert.equal(a(), b());
});
