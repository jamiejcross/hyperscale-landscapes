import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapText, layoutKey, markSVGOf, MARKS } from '../../web/js/scene/legend.js';

const measure = t => t.length * 6;

test('wrapText breaks at the width', () => {
  assert.deepEqual(wrapText('aaa bbb ccc', 45, measure), ['aaa bbb', 'ccc']);
  assert.deepEqual(wrapText('one', 5, measure), ['one']);
});

test('layoutKey keeps a heading with its first row and balances columns', () => {
  const items = [{ head: 'A' }, ...Array.from({ length: 6 }, (_, i) => ({ swatch: '#000', text: `row ${i}` })), { head: 'B' }, { mark: 'coal', text: 'coal' }];
  const L = layoutKey(items, { cols: 2, colW: 300, fs: 12, measure });
  const b = L.rows.findIndex(r => r.item.head === 'B');
  assert.equal(L.rows[b].col, L.rows[b + 1].col);
  assert.ok(L.rows.some(r => r.col === 1));
  assert.ok(L.height > 0 && L.height < L.rows.reduce((s, r) => s + r.h, 0));
});

test('every mark draws as SVG', () => {
  for (const k of Object.keys(MARKS)) assert.ok(markSVGOf(k, 0, 0).startsWith('<'), k);
});
