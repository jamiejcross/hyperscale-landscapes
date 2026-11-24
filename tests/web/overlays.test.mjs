// Node tests for the field style's painted-overlay widths (run: node --test tests/web).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overlayWidth, OVERLAY, MAJOR_ROADS } from '../../web/js/scene/overlays.js';

test('road widths at 2048 px: 3 px major, 2 px minor, plus a 0.75 px casing each side', () => {
  assert.equal(overlayWidth('primary'), 3 + 1.5);
  assert.equal(overlayWidth('tertiary_link'), 3 + 1.5);
  assert.equal(overlayWidth('residential'), 2 + 1.5);
  assert.equal(overlayWidth('service'), 2 + 1.5);
});

test('rail, disused rail and power lines', () => {
  assert.equal(overlayWidth('rail'), 1.5);
  assert.equal(overlayWidth('railDisused'), 1.5);
  assert.equal(overlayWidth('powerLine'), 1.25);
});

test('widths scale with the drape width', () => {
  assert.equal(overlayWidth('primary', 4096), 2 * overlayWidth('primary'));
  assert.equal(overlayWidth('powerLine', 1024), OVERLAY.powerLine.width / 2);
});

test('every major road kind has a _link partner where OSM has one', () => {
  for (const k of ['motorway', 'trunk', 'primary', 'secondary', 'tertiary']) {
    assert.ok(MAJOR_ROADS.has(k) && MAJOR_ROADS.has(`${k}_link`), k);
  }
});
