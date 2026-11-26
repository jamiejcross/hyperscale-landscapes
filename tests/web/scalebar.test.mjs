import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metresPerPx, niceBar } from '../../web/js/scene/scalebar.js';

test('metresPerPx: visible height over pixels, in ground metres', () => {
  // fov 90: visible height = 2d; d = 100 mm, 200 px tall, 0.1 mm per m -> 10 m/px
  assert.ok(Math.abs(metresPerPx(100, 90, 200, 0.1) - 10) < 1e-9);
  assert.equal(metresPerPx(0, 20, 200, 0.1), null);
});

test('niceBar picks 1, 2 or 5 x 10^n within the width', () => {
  assert.deepEqual(niceBar(10, 120).metres, 1000);   // 1200 m fits -> 1 km
  assert.equal(niceBar(10, 120).label, '1 km');
  assert.equal(niceBar(10, 120).px, 100);
  assert.equal(niceBar(3, 120).metres, 200);         // 360 m
  assert.equal(niceBar(5, 120).metres, 500);         // 600 m
  assert.equal(niceBar(5, 120).label, '500 m');
  assert.equal(niceBar(30, 120).label, '2 km');
  assert.equal(niceBar(0.1, 120).label, '10 m');
  assert.equal(niceBar(NaN), null);
});
