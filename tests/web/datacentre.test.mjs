// Node tests for the proposed data centre (brief v2): line style from evidence,
// heights, clipping, extent placement, the reversible terrain cut, and the
// print solids (run: node --test tests/web).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeGrid } from '../../web/js/geom/model.js';
import { planDatacentre, datacentrePrintMesh, polysMm } from '../../web/js/geom/datacentre-plan.js';
import { lineStyle, datacentreAvailable, placeExtents, cutTerrain, restoreTerrain, captionLine, DASH_M } from '../../web/js/scene/datacentre-math.js';

const bbox = { minLat: 56.00, maxLat: 56.01, minLon: -3.02, maxLon: -3.00 };
const grid = makeGrid(bbox, { printSize: 200, maxCols: 600, cellMm: 0.5 });
const flat = () => 10;
const tilted = (x, y) => 10 + 0.05 * x;
// a lon/lat square (side in degrees) round a centre
const sq = (lon, lat, dl = 0.002, dt = 0.001) => ({ type: 'Polygon', coordinates: [[[lon - dl, lat - dt], [lon + dl, lat - dt], [lon + dl, lat + dt], [lon - dl, lat + dt], [lon - dl, lat - dt]]] });
const site = (over = {}) => ({
  red_line: { ref: '26/00001/PPP', evidence: 'documented', geometry: sq(-3.01, 56.005, 0.006, 0.003) },
  buildings: [
    { name: 'A', kind: 'building', evidence: 'documented', height_m: 28, source: 'drawing', geometry: sq(-3.012, 56.005) },
    { name: 'B', kind: 'building', evidence: 'indicative', height_m: 15, source: 'layout', geometry: sq(-3.006, 56.005) },
  ],
  zones: [], ...over,
});

test('documented features are solid, everything else dashed', () => {
  assert.equal(lineStyle('documented'), 'solid');
  assert.equal(lineStyle('indicative'), 'dashed');
  assert.equal(lineStyle(undefined), 'dashed');
  const plan = planDatacentre(site(), grid, flat);
  assert.deepEqual(plan.items.map(i => i.style), ['solid', 'dashed']);
  assert.ok(Math.abs(plan.dashMm - DASH_M * grid.mmPerM) < 1e-9);
});

test('heights come from height_m at true scale, on a platform at the median ground', () => {
  const plan = planDatacentre(site(), grid, tilted);
  for (const it of plan.items) {
    assert.ok(Math.abs(it.top - it.level - it.heightM * grid.mmPerM) < 1e-9);
    assert.ok(it.low <= it.level && it.level <= it.high);
  }
  assert.deepEqual(plan.items.map(i => i.heightM), [28, 15]);
});

test('features outside the model are dropped and counted; those across the edge are clipped', () => {
  const m = site();
  m.buildings.push({ name: 'far', kind: 'building', evidence: 'documented', height_m: 20, source: 's', geometry: sq(-2.9, 56.005) });
  m.buildings.push({ name: 'edge', kind: 'building', evidence: 'documented', height_m: 20, source: 's', geometry: sq(-3.0, 56.005) });
  const plan = planDatacentre(m, grid, flat);
  assert.equal(plan.outside, 1);
  const edge = plan.items.find(i => i.name === 'edge');
  for (const [x, y] of edge.polys[0][0]) assert.ok(x > 0 && x < grid.Wmm && y > 0 && y < grid.Hmm);
});

test('nothing is drawn without a sourced height or area', () => {
  assert.equal(datacentreAvailable(null).ok, false);
  assert.equal(datacentreAvailable({ red_line: site().red_line, buildings: [], zones: [] }).ok, false);
  assert.equal(datacentreAvailable({ buildings: [{ height_m: 15 }] }).ok, true);
  assert.equal(datacentreAvailable({ extent: { area_m2: 65000, height_m: 15 } }).ok, true);
  const plan = planDatacentre({ buildings: [{ name: 'x', evidence: 'documented', geometry: sq(-3.01, 56.005) }], zones: [] }, grid, flat);
  assert.equal(plan.items.length, 0);
});

test('extents sit inside the red line, do not overlap, take the flattest ground, and are the same every run', () => {
  const red = polysMm(sq(-3.01, 56.005, 0.006, 0.003), grid);
  const bumpy = (x, y) => 10 + (x < grid.Wmm / 2 ? 3 * Math.sin(x * 2) : 0);    // the east half is flat
  const area = 20000 * grid.mmPerM ** 2;
  const a = placeExtents(red, { areaMm2: area, count: 2, gapMm: 1, stepMm: 1 }, bumpy);
  const b = placeExtents(red, { areaMm2: area, count: 2, gapMm: 1, stepMm: 1 }, bumpy);
  assert.equal(a.length, 2);
  assert.deepEqual(a, b);
  const box = r => [Math.min(...r.map(p => p[0])), Math.min(...r.map(p => p[1])), Math.max(...r.map(p => p[0])), Math.max(...r.map(p => p[1]))];
  const [A, B] = a.map(e => box(e.ring));
  assert.ok(A[2] <= B[0] || B[2] <= A[0] || A[3] <= B[1] || B[3] <= A[1], 'overlap');
  const R = box(red[0][0]);
  for (const e of a) {
    const [x0, y0, x1, y1] = box(e.ring);
    assert.ok(x0 >= R[0] && y0 >= R[1] && x1 <= R[2] && y1 <= R[3]);
    assert.ok(x0 >= grid.Wmm / 2 - 1, 'placed on the flat half');
    assert.ok(Math.abs((x1 - x0) * (y1 - y0) - area) / area < 1e-9);
  }
  assert.ok(a[0].relief <= a[1].relief);
  assert.deepEqual(placeExtents(red, { areaMm2: 1e9, count: 1, stepMm: 1 }, flat), []);   // too big: none
});

test('a stated extent is placed only for a site with no drawn buildings', () => {
  const m = site({ buildings: [], extent: { area_m2: 30000, height_m: 15, count: 1, stage: 'screening' } });
  const plan = planDatacentre(m, grid, flat);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].kind, 'extent');
  assert.equal(plan.items[0].style, 'dashed');
  assert.match(captionLine(m, plan, { zExag: 2 }), /extent placed by us from the stated footprint \(30,000 m², screening stage\); no layout published \(dashed\)/);
  assert.equal(planDatacentre({ ...m, buildings: site().buildings }, grid, flat).items.every(i => i.kind === 'building'), true);
});

test('the terrain cut lowers only vertices inside a platform and above it, and is undone exactly', () => {
  const plan = planDatacentre(site(), grid, tilted);
  const P = new Float32Array(3 * 200 * 100);
  let k = 0;
  for (let j = 0; j < 100; j++) for (let i = 0; i < 200; i++) { const x = grid.Wmm * i / 199, y = grid.Hmm * j / 99; P[k++] = x; P[k++] = y; P[k++] = tilted(x, y); }
  const orig = P.slice();
  const changed = cutTerrain(P, plan.items);
  assert.ok(changed.length > 0);
  for (let i = 0; i < changed.length; i += 2) {
    const v = changed[i];
    const it = plan.items.find(t => P[v] === Math.fround(t.level));
    assert.ok(it, 'lowered to a platform level');
    assert.ok(orig[v] > P[v]);
  }
  restoreTerrain(P, changed);
  assert.deepEqual(P, orig);
});

test('print solids are watertight boxes from below the ground to the roof', () => {
  const plan = planDatacentre(site(), grid, tilted);
  const m = datacentrePrintMesh(plan);
  const e = new Map();
  for (let t = 0; t < m.indices.length; t += 3) for (let q = 0; q < 3; q++) {
    const a = m.indices[t + q], b = m.indices[t + (q + 1) % 3];
    e.set(`${a},${b}`, (e.get(`${a},${b}`) || 0) + 1);
  }
  for (const [ab, n] of e) { const [a, b] = ab.split(','); assert.equal(n, 1); assert.equal(e.get(`${b},${a}`), 1); }
  let zmax = -Infinity, zmin = Infinity;
  for (let i = 2; i < m.positions.length; i += 3) { zmax = Math.max(zmax, m.positions[i]); zmin = Math.min(zmin, m.positions[i]); }
  assert.ok(Math.abs(zmax - Math.max(...plan.items.map(i => i.top))) < 1e-4);
  assert.ok(zmin < Math.min(...plan.items.map(i => i.low)));
});

test('every drawn site in data/sites gives a plan with its caption', () => {
  for (const id of ['larbert', 'south-gyle', 'chapelcross', 'greenock', 'auchtertool-cato', 'ravenscraig', 'coldstream', 'westerhill', 'duns']) {
    const p = JSON.parse(readFileSync(new URL(`../../data/sites/${id}.geojson`, import.meta.url))).properties, b = p.model_bbox;
    const g = makeGrid({ minLat: b.min_lat, maxLat: b.max_lat, minLon: b.min_lon, maxLon: b.max_lon }, { printSize: 200, maxCols: 600, cellMm: 0.5 });
    const plan = planDatacentre(p.massing, g, flat);
    assert.ok(plan.items.length + plan.zones.length > 0, id);
    for (const it of plan.items) assert.ok(it.source, `${id}: ${it.name} has a source`);
    assert.match(captionLine(p.massing, plan), /^Proposed data centre \(/);
  }
});
