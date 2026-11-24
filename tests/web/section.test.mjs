// Node tests for the cross-section maths (run: node --test tests/web/*.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSection, sectionSVG } from '../../web/js/export/section.js';

// A flat 100 m plain with a 20 m hill in the middle of a ~1.1 km box.
const bbox = { minLat: 56.0, maxLat: 56.01, minLon: -3.01, maxLon: -2.99 };
const elev = { sample: (lon) => 100 + 20 * Math.exp(-(((lon + 3.0) / 0.002) ** 2)) };
const sq = (lon, lat, d) => [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]];
const osm = {
  buildings: [{ geometry: { type: 'Polygon', coordinates: sq(-3.005, 56.005, 0.0002) }, tags: { height: '12' } }],
  water: [], roads: [],
  waterways: [{ kind: 'river', tags: { name: 'Test Water' }, geometry: { type: 'LineString', coordinates: [[-2.995, 56.0], [-2.995, 56.01]] } }],
  features: [{ layer: 'power', kind: 'line', status: 'existing', tags: { voltage: '275000' },
    geometry: { type: 'LineString', coordinates: [[-2.993, 56.0], [-2.993, 56.01]] } }],
};
const line = [[-3.009, 56.005], [-2.991, 56.005]];

test('section finds what the line crosses, at the right distances', () => {
  const s = computeSection({ line, bbox, elev, osm });
  assert.ok(Math.abs(s.length - 0.018 * 111320 * Math.cos(56.005 * Math.PI / 180)) < 2);
  assert.equal(s.items.buildings.length, 1);
  const b = s.items.buildings[0];
  assert.ok(Math.abs((b.top - b.base) - 12) < 1e-6, 'building drawn at its OSM height');
  const river = s.items.points.find(p => p.kind === 'water');
  const power = s.items.points.find(p => p.kind === 'power');
  assert.equal(river.label, 'Test Water');
  assert.equal(power.label, 'Power line 275 kV');
  assert.ok(river.s < power.s);
  assert.ok(s.zMax > 119 && s.zMin < 101, 'true elevations sampled');
});

test('the SVG states the vertical scale', () => {
  const s = computeSection({ line, bbox, elev, osm });
  const caption = { title: 'T', disclosure: 'D', sources: 'S', footer: 'F' };
  const colours = { water: '#00f', power: '#f90', receptors: '#0af', residues: '#c7a', rail: '#000', road: '#555' };
  assert.match(sectionSVG(s, { vex: 1, caption, colours }), /true \(×1, not exaggerated\)/);
  assert.match(sectionSVG(s, { vex: 5, caption, colours }), /exaggerated ×5/);
});
