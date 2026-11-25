// Node tests for pits on the surface (run: node --test tests/web/*.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abandonedYear, collieryByName, displayClass, pitNote, groupPits, layoutLabels, silhouette } from '../../web/js/scene/pits-math.js';

const plan = (year, seams) => ({ year_abandoned: year, seams });
const PITS = [
  { name: 'Little Raith', class: 'coal', x: 100, y: 200, plans: [plan('1939', ['A']), plan('1932', ['A', 'B', 'C'])] },
  { name: 'Little Raith', class: 'coal', x: 300, y: 400, plans: [plan('1932', ['A', 'B', 'C'])] },
  { name: 'Little Raith Quarries', class: 'coal', coal_by_stripped_name: true, x: 0, y: 0, plans: [plan('1932', ['A'])] },
  { name: 'Camilla', class: 'unknown', x: 10, y: 10, plans: [] },
  { name: 'Cults Quarry', class: 'quarry', x: 50, y: 50, plans: [] },
];

test('classes, years and notes', () => {
  assert.equal(abandonedYear(PITS[0]), '1932');                 // the plan with the most seams
  assert.equal(displayClass(PITS[2]), 'quarry');                // matched coal only by a stripped name
  assert.equal(pitNote('coal', '1932'), 'coal mine · abandoned 1932');
  assert.equal(pitNote('coal', null), 'coal mine');
  assert.equal(pitNote('unknown'), 'mine or quarry · type unknown');
  assert.equal(pitNote('quarry', null, true), 'quarry · name also on a coal mine plan');
});

test('collieries by name count as coal, labelled as such', () => {
  const c = { name: 'Dalzell Colliery', class: 'unknown', x: 0, y: 0, plans: [] };
  assert.equal(collieryByName(c), true);
  assert.equal(displayClass(c), 'coal');
  assert.equal(displayClass({ name: 'Wellington Pit', class: 'unknown' }), 'unknown');
  assert.equal(displayClass({ name: 'Colliery Quarry', class: 'quarry' }), 'quarry');   // only unknowns are promoted
  assert.equal(groupPits([c])[0].note, 'colliery · no mine plan matched');
});

test('one group per name; quarries only when asked for', () => {
  const g = groupPits(PITS);
  assert.deepEqual(g.map(x => x.name), ['Little Raith', 'Camilla']);
  assert.equal(g[0].cls, 'coal'); assert.equal(g[0].pits.length, 2);
  assert.equal(g[0].cx, 200); assert.equal(g[0].cy, 300);
  assert.equal(g[0].note, 'coal mine · abandoned 1932');
  const q = groupPits(PITS, { showQuarries: true });
  assert.equal(q.length, 4);
  assert.equal(q.find(x => x.name === 'Little Raith Quarries').note, 'quarry · name also on a coal mine plan');
});

test('label layout: above the silhouette, no overlaps, inside the frame', () => {
  // a synthetic model: a ridge whose top is at y = 300 - 0.2 * |x - 400| (px)
  const pts = []; for (let x = 0; x <= 800; x += 2) pts.push([x, 300 - 0.2 * Math.abs(x - 400)]);
  const W = 800, H = 600, silTop = silhouette(pts, W, H);
  const items = [380, 400, 410, 420, 30, 790, 600].map(ax => ({ ax, wpx: 120, hpx: 28 }));
  const boxes = layoutLabels(items, silTop, { width: W });
  boxes.forEach((b, i) => {
    assert.ok(b.bottom <= silTop(b.x0, b.x1) - 28 + 1e-9, `label ${i} clear of the land`);
    assert.ok(b.x0 >= 0 && b.x1 <= W, `label ${i} in frame`);
    assert.ok(Math.abs(b.top - (b.bottom - 28)) < 1e-9);
    for (let j = 0; j < i; j++) {
      const a = boxes[j], overlap = b.x0 < a.x1 && a.x0 < b.x1 && b.top < a.bottom && a.top < b.bottom;
      assert.ok(!overlap, `labels ${j} and ${i} overlap`);
    }
  });
  assert.equal(boxes[4].shift, 34);          // slid right to 4 px margin + half of 120
  assert.equal(boxes[5].shift, -54);
});

test('silhouette: highest point per column, empty columns at the bottom', () => {
  const s = silhouette([[10, 50], [12, 40], [500, 90]], 800, 600, 80);
  assert.equal(s(0, 20), 40);
  assert.equal(s(700, 790), 600);
});
