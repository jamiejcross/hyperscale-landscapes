// Node tests for the bundle @3 decoders (run: node --test tests/web).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeTrees, bundleProps, bundleSubsurface } from '../../web/js/data/props.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/trees_encoded.json', import.meta.url)));

test('decodes trees packed by the Python encoder', () => {
  const t = decodeTrees(fx);
  assert.equal(t.count, 4);
  const rows = [...t.x].map((x, i) => [x, t.y[i], t.h[i], t.archetype[i], t.source[i], t.crownR[i]])
    .sort((a, b) => a[0] - b[0]);
  const want = [[0, 0, 4, 0, 3, 1.2], [12.3, 7.8, 12.3, 1, 2, 4.8], [1500, 800, 20, 4, 0, 2], [3199.9, 1599.9, 43.9, 2, 1, 25.5]];
  rows.forEach((r, i) => r.forEach((v, k) => assert.ok(Math.abs(v - want[i][k]) < 0.06, `${i},${k}: ${v} vs ${want[i][k]}`)));
});

test('@2 bundles have no props or subsurface', () => {
  const v2 = { schema: 'hyperscale-landscapes/site-bundle@2', osm: {}, elevation: {} };
  assert.equal(bundleProps(v2), null);
  assert.equal(bundleSubsurface(v2), null);
  assert.equal(decodeTrees(bundleProps(v2)), null);
});
