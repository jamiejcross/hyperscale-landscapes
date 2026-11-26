import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readWithProgress, progressOf } from '../../web/js/data/overpass.js';

const body = JSON.stringify({ elements: Array.from({ length: 2000 }, (_, i) => ({ id: i, type: 'node' })) });
const chunked = (headers) => {
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 4096) c.enqueue(bytes.slice(i, i + 4096)); c.close(); } });
  return new Response(stream, { headers });
};

test('readWithProgress reports a fraction when the length is known', async () => {
  const seen = [];
  const text = await readWithProgress(chunked({ 'Content-Length': String(new TextEncoder().encode(body).length) }), p => seen.push(p));
  assert.equal(text, body);
  assert.equal(seen.at(-1).fraction, 1);
});

test('readWithProgress reports bytes only when there is no length (or it is compressed)', async () => {
  for (const h of [{}, { 'Content-Length': '10', 'Content-Encoding': 'gzip' }]) {
    const seen = [];
    await readWithProgress(chunked(h), p => seen.push(p));
    assert.equal(seen.at(-1).fraction, null);
    assert.equal(seen.at(-1).received, new TextEncoder().encode(body).length);
  }
  assert.deepEqual(progressOf(50, 200), { received: 50, total: 200, fraction: 0.25 });
});
