// Binary STL. In the browser the parts are combined but not boolean-unioned
// (slicers merge overlapping shells); the Python tool makes a true single
// watertight body.
export function writeSTL(meshes, header = 'Hyperscale Landscapes') {
  meshes = meshes.filter(m => m && m.indices.length);
  const nTri = meshes.reduce((s, m) => s + m.indices.length / 3, 0);
  const buf = new ArrayBuffer(84 + 50 * nTri), dv = new DataView(buf);
  const h = new TextEncoder().encode(header.slice(0, 79));
  new Uint8Array(buf, 0, 80).set(h);
  dv.setUint32(80, nTri, true);
  let o = 84;
  for (const { positions: P, indices: I } of meshes) {
    for (let t = 0; t < I.length; t += 3) {
      const a = 3 * I[t], b = 3 * I[t + 1], c = 3 * I[t + 2];
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true); o += 12;
      for (const v of [a, b, c]) { dv.setFloat32(o, P[v], true); dv.setFloat32(o + 4, P[v + 1], true); dv.setFloat32(o + 8, P[v + 2], true); o += 12; }
      o += 2;
    }
  }
  return new Blob([buf], { type: 'model/stl' });
}
