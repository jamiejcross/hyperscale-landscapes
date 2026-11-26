// Node tests for the stylised palettes and the colour check (run: node --test tests/web).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PALETTES, LANDCOVER_CLASSES, brushStrokes, seedFrom, layerSwatch } from '../../web/js/scene/palettes.js';
import { deltaE2000, check } from '../../tools/palette_check.mjs';

test('every field land-cover class has a guthrie entry', () => {
  for (const k of Object.keys(PALETTES.field.landcover)) assert.ok(PALETTES.guthrie.landcover[k], k);
  for (const k of LANDCOVER_CLASSES) assert.ok(PALETTES.field.landcover[k] && PALETTES.guthrie.landcover[k], k);
});

test('both palettes have the same keys at the top level used by scene.js', () => {
  for (const k of ['landBase', 'layers', 'roof', 'water', 'walls', 'channel', 'ink', 'background', 'overlays', 'props']) {
    assert.ok(PALETTES.field[k] !== undefined && PALETTES.guthrie[k] !== undefined, k);
  }
});

test('brushwork is deterministic for a seed and differs between seeds', () => {
  const a = brushStrokes(4096, 2048, seedFrom('auchtertool-cato'));
  const b = brushStrokes(4096, 2048, seedFrom('auchtertool-cato'));
  const c = brushStrokes(4096, 2048, seedFrom('south-gyle'));
  assert.equal(a.length, 16000);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.slice(0, 10), c.slice(0, 10));
  assert.ok(a.every(s => Math.abs(s.angle) <= 0.45 && s.len >= 8 && s.len <= 36 && s.width >= 3 && s.width <= 10));
});

test('brushwork count scales with drape area', () => {
  assert.equal(brushStrokes(2048, 1024, 1).length, 4000);
});

test('layer swatches follow the look', () => {
  assert.equal(layerSwatch('residues', 'guthrie', '#000000'), '#9a6050');
  assert.equal(layerSwatch('terrain', 'field', '#000000'), '#d6d09a');
  assert.equal(layerSwatch('residues', 'unknown-look', '#123456'), '#123456');
});

test('CIEDE2000 matches Sharma, Wu and Dalal (2005) reference pairs', () => {
  const pairs = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
  ];
  for (const [a, b, want] of pairs) assert.ok(Math.abs(deltaE2000(a, b) - want) < 1e-4, `${want} got ${deltaE2000(a, b)}`);
});

test('colour check produces a row for every pair', () => {
  const rows = check('guthrie');
  assert.equal(rows.length, 10 + 15);   // 5 evidence colours: 10 pairs, plus 5 x 3 land
});

test('evidence colours pass the colour-blind check in every look (Anthropogenic: also against its darkest relief)', () => {
  assert.ok(check('anthropogenic').some(r => /darkest relief/.test(r.b)));
  for (const look of ['field', 'guthrie', 'anthropogenic']) assert.deepEqual(check(look).filter(r => !r.pass).map(r => `${r.a}-${r.b}`), [], look);
});
