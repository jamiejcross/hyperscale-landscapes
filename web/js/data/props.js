// Decoders for the optional sections of a site bundle (schema @3):
// props (trees, turbines, supports, lines) and subsurface. @2 bundles have
// neither, and every reader here returns null for them.
// Pure functions with no imports, so Node can test this file directly.

// Trees: base64 little-endian records "<HHHBBB" (x, y, h_dm, archetype, source,
// crown_r_dm), x and y in xy_unit_m from the bbox SW corner (app frame).
export function decodeTrees(props) {
  const t = props?.trees;
  if (!t || !t.count) return null;
  if (t.record !== '<HHHBBB') throw new Error(`unknown tree record ${t.record}`);
  const bin = typeof atob === 'function'
    ? Uint8Array.from(atob(t.data), c => c.charCodeAt(0))
    : new Uint8Array(Buffer.from(t.data, 'base64'));
  const n = t.count, size = 9;
  if (bin.length !== n * size) throw new Error(`tree data is ${bin.length} bytes, expected ${n * size}`);
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const out = {
    count: n, x: new Float32Array(n), y: new Float32Array(n), h: new Float32Array(n), crownR: new Float32Array(n),
    archetype: new Uint8Array(n), source: new Uint8Array(n), archetypes: t.archetypes, sources: t.sources,
  };
  for (let i = 0, o = 0; i < n; i++, o += size) {
    out.x[i] = dv.getUint16(o, true) * t.xy_unit_m;
    out.y[i] = dv.getUint16(o + 2, true) * t.xy_unit_m;
    out.h[i] = dv.getUint16(o + 4, true) * t.h_unit_m;
    out.archetype[i] = dv.getUint8(o + 6);
    out.source[i] = dv.getUint8(o + 7);
    out.crownR[i] = dv.getUint8(o + 8) * t.crown_r_unit_m;
  }
  return out;
}

export const bundleProps = bundle => bundle?.props || null;
export const bundleSubsurface = bundle => bundle?.subsurface || null;
