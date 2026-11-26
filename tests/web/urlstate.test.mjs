// Node tests for the shareable view URL (run: node --test tests/web).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseView, viewSearch, EL_MIN, EL_MAX } from '../../web/js/urlstate.js';

test('parseView reads valid parameters', () => {
  assert.deepEqual(parseView('?site=south-gyle&style=field&az=135&el=30'),
    { site: 'south-gyle', style: 'field', az: 135, el: 30 });
});

test('parseView clamps elevation to 0–90 and wraps azimuth', () => {
  assert.equal(parseView('?el=5').el, 5);
  assert.equal(parseView('?el=95').el, EL_MAX);
  assert.equal(parseView('?el=-40').el, EL_MIN);
  assert.equal(parseView('?az=370').az, 10);
  assert.equal(parseView('?az=-90').az, 270);
  assert.equal(parseView('?az=12.34').az, 12.3);
});

test('parseView drops anything invalid', () => {
  assert.deepEqual(parseView('?site=../etc&style=fancy&az=north&el='), {});
  assert.deepEqual(parseView('?site=Upper&az=&el=abc'), {});
  assert.deepEqual(parseView(''), {});
  assert.equal(parseView('?site=a'.padEnd(80, 'b')).site, undefined);   // too long
});

test('viewSearch writes, rounds, clamps and keeps other parameters', () => {
  assert.equal(viewSearch('?lang=en', { site: 'plean', style: 'field', az: 134.6, el: 95 }),
    '?lang=en&site=plean&style=field&az=135&el=90');
  assert.equal(parseView('?style=mossmorran').style, 'guthrie');   // retired look
  assert.equal(viewSearch('?site=plean&az=10', { site: null }), '?az=10');
  assert.equal(viewSearch('', {}), '');
});

test('a written view reads back the same', () => {
  const v = { site: 'cockenzie', style: 'field', az: 225, el: 32 };
  assert.deepEqual(parseView(viewSearch('', v)), v);
});

test('guthrie style round-trips through the URL', () => {
  const s = viewSearch('', { site: 'auchtertool-cato', style: 'guthrie', az: 225, el: 30 });
  assert.equal(s, '?site=auchtertool-cato&style=guthrie&az=225&el=30');
  assert.deepEqual(parseView(s), { site: 'auchtertool-cato', style: 'guthrie', az: 225, el: 30 });
});


test('context view and labels round-trip; defaults stay out of the URL', () => {
  assert.deepEqual(parseView('?ctx=energy&labels=1'), { ctx: 'energy', labels: true });
  assert.deepEqual(parseView('?ctx=off&labels=2'), {});
  assert.equal(viewSearch('', { ctx: 'geology', labels: true }), '?ctx=geology&labels=1');
  assert.equal(viewSearch('?ctx=energy&labels=1', { ctx: null, labels: false }), '');
  // Terrain and Electricity Grid together, in either order
  assert.deepEqual(parseView('?ctx=landscape,energy'), { ctx: 'landscape,energy' });
  assert.deepEqual(parseView('?ctx=energy,landscape'), { ctx: 'landscape,energy' });
  assert.deepEqual(parseView('?ctx=geology,energy'), {});
});

test('dc=1 (the proposed data centre shown) round-trips; anything else is left out', () => {
  assert.equal(parseView('?site=larbert&dc=1').dc, true);
  assert.equal('dc' in parseView('?dc=yes'), false);
  assert.equal(viewSearch('', { dc: true }), '?dc=1');
  assert.equal(viewSearch('?dc=1', { dc: false }), '');
});
