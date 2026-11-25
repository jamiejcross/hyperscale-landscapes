// Node tests for the geology legend, sources, caption and manifest (subsurface
// Stage 4), and for the offline viewer's module packing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  legendModel, sourceList, captionNote, nominalTable, minePlans, subsurfaceCounts, subsurfaceManifest, BOREHOLE_NEAR_M,
} from '../../web/js/scene/subsurface-info.js';
import { MODULES, rewrite } from '../../web/js/export/viewer.js';

const unit = (LEX_D, RCS_D, layer) => ({ LEX_D, RCS_D, layer });
const SUB = {
  fetched: '2026-11-25', attribution: 'Contains British Geological Survey materials © UKRI 2026', nonCommercial: true,
  nominal_thickness_m: { superficial: { till: 6, alluvium: 4 }, sheets: { sill: [20, 30], 'limestone bed': [4, 5] } },
  labels: { DATA: ['unit extents along walls'], ASSUMED: ['sheet thickness'], SCHEMATIC: ['seam count'] },
  sources: {
    geology_50k: { service: 'https://example/wms', versions: [{ version: '9.25', released: '31-03-2025' }], map_sheets: ['sc040'] },
    shallow_coal: 'https://example/coal', britpits: 'https://example/pits', boreholes: 'https://example/bh', mine_plans: 'https://example/plans',
  },
  walls: {
    step_m: 40,
    units: [unit('Pathhead Formation', 'Sedimentary rock cycles', 'bedrock'), unit('Limestone Coal Formation', 'Sedimentary rock cycles', 'bedrock'),
      unit('Midland Valley Sill-Complex', 'Quartz-microgabbro', 'bedrock'), unit('Till, Devensian', 'Diamicton', 'superficial'), unit('Made Ground', 'Artificial deposit', 'artificial')],
    sides: {
      south: { m: [0, 50, 100], bedrock: [0, 2, 0], superficial: [3, -1, -1], artificial: [-1, -1, -1], shallow_coal: [0, 0, 0] },
      east: { m: [0, 50], bedrock: [1, 1], superficial: [-1, -1], artificial: [-1, 4], shallow_coal: [0, 1] },
      north: { m: [0, 50, 100], bedrock: [0, 0, 0], superficial: [-1, -1, -1], artificial: [-1, -1, -1], shallow_coal: [0, 0, 0] },
      west: { m: [0, 50], bedrock: [0, 0], superficial: [-1, -1], artificial: [-1, -1], shallow_coal: [0, 0] },
    },
  },
  boreholes: [
    { ref: 'A1', length_m: 87, x: 10, y: 20, year: '1924' },          // 10 m from the west wall
    { ref: 'A2', length_m: 5, x: 50, y: 25 },                         // 25 m from the walls (south/north)
    { ref: 'A3', length_m: 0, x: 1, y: 1 },                           // no depth: not drawn
    { ref: 'A4', length_m: 30, x: 50, y: -80 },                       // 80 m outside: not drawn
  ],
  pits: [
    { name: 'Little Raith', class: 'coal', x: 0, y: 0, plans: [{ catalogue: '12948', mine_name: 'LITTLE RAITH', year_abandoned: '1939', seams: ['A'] }, { catalogue: '10729', mine_name: 'LITTLE RAITH', year_abandoned: '1932', seams: ['A', 'B'] }] },
    { name: 'Little Raith Quarries', class: 'coal', coal_by_stripped_name: true, x: 0, y: 0, plans: [{ catalogue: '10729', mine_name: 'LITTLE RAITH', seams: [] }] },
    { name: 'Camilla', class: 'unknown', x: 5, y: 5, plans: [] },
    { name: 'Dalzell Colliery', class: 'unknown', x: 5, y: 5, plans: [] },
  ],
};
const DIMS = { Wm: 100, Hm: 50 };

test('legend: units split into bedrock, sheets and cover, from the walls', () => {
  const L = legendModel(SUB, DIMS);
  assert.deepEqual(L.bedrock.map(e => e.unit.LEX_D), ['Pathhead Formation', 'Limestone Coal Formation']);
  assert.deepEqual(L.sheets.map(e => [e.unit.LEX_D, e.thickness]), [['Midland Valley Sill-Complex', 30]]);
  assert.deepEqual(L.cover.map(e => [e.label, e.thickness, e.artificial]), [['Till, Devensian', 6, false], ['Made Ground', 4, true]]);
  assert.equal(L.coal, true); assert.equal(L.opencast, true); assert.equal(L.madeGround, true);
  assert.deepEqual(L.sheetRanges, ['sills 20–30 m', 'limestone beds 4–5 m']);
});

test('legend: boreholes near the walls, pits by drawn class, plans once each', () => {
  const L = legendModel(SUB, DIMS);
  assert.deepEqual(L.boreholes.map(b => b.ref), ['A1', 'A2']);
  assert.ok(BOREHOLE_NEAR_M === 50);
  assert.deepEqual(L.pits, { coal: ['Little Raith', 'Dalzell Colliery'], unknown: ['Camilla'], quarry: ['Little Raith Quarries'] });
  assert.deepEqual(minePlans(SUB).map(p => [p.catalogue, p.mine, p.year]), [['10729', 'Little Raith', '1932'], ['12948', 'Little Raith', '1939']]);
});

test('sources, caption and nominal table come from the bundle', () => {
  const S = sourceList(SUB);
  assert.deepEqual(S.map(s => s.key), ['geology_50k', 'shallow_coal', 'britpits', 'boreholes', 'mine_plans']);
  assert.equal(S[0].name, 'BGS Geology 50k v9.25 (released 31-03-2025)');
  assert.equal(S[4].name, 'BGS Mine Plans index (plans 10729, 12948)');
  const c = captionNote(SUB);
  assert.ok(c.startsWith('Contains British Geological Survey materials © UKRI 2026 (non-commercial use only): BGS Geology 50k v9.25;'));
  assert.ok(c.includes('plans 10729, 12948') && c.includes('nominal') && c.includes('schematic'));
  assert.equal(captionNote({ ...SUB, nonCommercial: false }).includes('non-commercial'), false);
  assert.deepEqual(nominalTable(SUB), [['till', '6'], ['alluvium', '4'], ['sill', '20–30'], ['limestone bed', '4–5']]);
  const noPlans = sourceList({ ...SUB, pits: [] }).at(-1).name;
  assert.equal(noPlans, 'BGS Mine Plans index (no plan matched to a pit here)');
});

test('counts and manifest', () => {
  const c = subsurfaceCounts(SUB, legendModel(SUB, DIMS));
  assert.deepEqual(c.wall_samples, { south: 3, east: 2, north: 3, west: 2 });
  assert.deepEqual(c.pits, { coal: 2, unknown: 1, quarry: 1 });
  assert.equal(c.boreholes_on_walls, 2); assert.equal(c.boreholes_in_bundle, 4); assert.equal(c.coal_runs_on_walls, 1);
  const m = subsurfaceManifest(SUB, { name: 'Test', ...DIMS, zExag: 2, vex: 3.7, generated: new Date('2026-11-25') });
  assert.equal(m.schema, 'hyperscale-landscapes/subsurface-manifest@1');
  assert.equal(m.nonCommercial, true); assert.ok(m.notice.includes('non-commercial'));
  assert.deepEqual(m.mine_plans.map(p => p.catalogue), ['10729', '12948']);
  assert.deepEqual(m.scale, { model_terrain_exaggeration: 2, diagram_vertical_exaggeration: 3.7 });
  assert.equal(m.generated, '2026-11-25');
});

test('offline viewer: every relative import of a packed module is packed too', () => {
  const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web');
  for (const p of Object.values(MODULES)) {
    if (!p.startsWith('js/')) continue;
    const out = rewrite(fs.readFileSync(path.join(web, p), 'utf8'), p);    // throws on an unpacked import
    assert.ok(!/from\s*['"]\.\.?\//.test(out), `${p} still has a relative import`);
  }
  assert.throws(() => rewrite("import { x } from './nowhere.js';", 'js/scene/scene.js'), /not packed/);
});

test('offline viewer: every packed array starts on a 4-byte boundary', () => {
  const src = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/js/export/viewer.js'), 'utf8');
  assert.match(src, /if \(offset % 4\)/);     // the packer pads before each entry
});
