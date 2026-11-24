// Node tests for the field style's ink edge rules (run: node --test tests/web).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { edgeStrength, EDGE, ringRadius, outlineScale } from '../../web/js/scene/ink-math.js';

const deg = a => Math.cos(a * Math.PI / 180);

test('an object change is a full-strength edge', () => {
  assert.equal(edgeStrength({ idChange: true }), 1);
});

test('a depth discontinuity is a full-strength edge; a flat plane is none', () => {
  assert.equal(edgeStrength({ depth2: 0.2 }), 1);
  assert.equal(edgeStrength({ depth2: 0 }), 0);
  assert.equal(edgeStrength({ depth2: EDGE.depthLow * 0.9 }), 0);
});

test('creases: sharp folds at 0.8, gentle terrain folds get no ink', () => {
  assert.equal(edgeStrength({ cosAngle: deg(90) }), EDGE.creaseStrength);
  assert.equal(edgeStrength({ cosAngle: deg(60) }), EDGE.creaseStrength);
  assert.equal(edgeStrength({ cosAngle: deg(30) }), 0);
  assert.equal(edgeStrength({ cosAngle: deg(40) }), 0);
});

test('edges combine with max, not sum', () => {
  assert.equal(edgeStrength({ idChange: true, depth2: 1, cosAngle: 0 }), 1);
  assert.equal(edgeStrength({ cosAngle: 0, depth2: 0 }), EDGE.creaseStrength);
});

test('line width is in CSS px at any pixel ratio', () => {
  assert.equal(ringRadius(1.8, 1), 0.9);
  assert.equal(ringRadius(1.8, 2), 1.8);
  // ring radius in outline-target texels, per CSS px of line, is the same at 1x, 1.5x, 2x and 4x
  const perCss = pr => ringRadius(1.8, pr) * outlineScale(pr) / Math.max(pr, 2);
  for (const pr of [1, 1.5, 2, 4]) assert.ok(Math.abs(perCss(pr) - 0.9) < 1e-9, `pr ${pr}`);
});

test('the outline target has at least 2 samples per CSS pixel', () => {
  for (const pr of [1, 1.25, 1.5, 2, 3]) assert.ok(pr * outlineScale(pr) >= 2 - 1e-9);
});

test('creases on the land surface get no ink (grid steps), elsewhere they do', () => {
  assert.equal(edgeStrength({ cosAngle: 0, onTerrain: true }), 0);
  assert.equal(edgeStrength({ cosAngle: 0, onTerrain: false }), EDGE.creaseStrength);
  assert.equal(edgeStrength({ idChange: true, onTerrain: true }), 1);
  assert.equal(edgeStrength({ depth2: 1, onTerrain: true }), 1);
});
