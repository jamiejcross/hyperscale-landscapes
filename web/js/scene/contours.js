// Contour surface: a drape drawn straight from the elevation data.
//
// Heights are sampled once per pixel (not per model grid cell) and lightly
// smoothed, so the lines run as smooth curves rather than following the grid.
// Each line is anti-aliased by its distance to the contour level, worked out
// from the local slope. Black and white: an off-white ground with soft
// hillshading, thin grey contours and a heavier line every fifth interval.

const INDEX_EVERY = 5;

// 5 m on low-relief sites, 10 m where the ground rises more than 150 m.
export function contourInterval(relief) {
  return relief > 150 ? 10 : 5;
}

export function contourCanvas(grid, elev, widthPx = 2048) {
  const W = widthPx, Hc = Math.round(widthPx * grid.Hmm / grid.Wmm);
  const wM = grid.Wmm / grid.mmPerM, hM = grid.Hmm / grid.mmPerM, px = wM / W;   // metres per pixel

  // Sample heights at pixel centres, row 0 at the north edge.
  let e = new Float32Array(W * Hc);
  let lo = Infinity, hi = -Infinity;
  for (let j = 0; j < Hc; j++) {
    const y = (Hc - j - 0.5) / Hc * hM;
    for (let i = 0; i < W; i++) {
      const [lon, lat] = grid.proj.toLonLat((i + 0.5) / W * wM, y);
      let v = elev.sample(lon, lat);
      if (!(v > 0)) v = 0;                                   // sea and no-data at sea level
      e[j * W + i] = v;
      if (v > 0) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    }
  }
  e = blur(e, W, Hc, 2);
  const interval = contourInterval(hi > lo ? hi - lo : 0);

  const img = new ImageData(W, Hc), d = img.data;
  // Light from the north-west, 45° up; slopes exaggerated ×2 for the shading only.
  const L = norm([-1, 1, Math.SQRT2]), ex = 2;
  for (let j = 0; j < Hc; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i, v = e[k];
    const gx = (e[j * W + Math.min(i + 1, W - 1)] - e[j * W + Math.max(i - 1, 0)]) / 2;           // m per pixel, east
    const gy = (e[Math.max(j - 1, 0) * W + i] - e[Math.min(j + 1, Hc - 1) * W + i]) / 2;          // m per pixel, north
    // Hillshade: surface normal from the slope (pixel size in metres).
    const n = norm([-gx * ex / px, -gy * ex / px, 1]);
    const lambert = Math.max(0, n[0] * L[0] + n[1] * L[1] + n[2] * L[2]);
    let g = 236 + 22 * (lambert - L[2]) / (1 - L[2] + 1e-6);   // flat ground stays at 236
    g = Math.min(250, Math.max(200, g));
    // Contour line: distance (in pixels) from this pixel to the nearest level.
    const slope = Math.hypot(gx, gy);
    if (v > 0 && slope > 1e-4) {
      const t = v / interval, level = Math.round(t);
      if (level > 0) {
        const dist = Math.abs(t - level) * interval / slope;
        const index = level % INDEX_EVERY === 0;
        const half = index ? 1.7 : 0.9, ink = index ? 30 : 95;    // half-widths in pixels (of 2048)
        const a = Math.min(1, Math.max(0, half + 0.5 - dist));
        g = g * (1 - a) + ink * a;
      }
    }
    d[4 * k] = d[4 * k + 1] = d[4 * k + 2] = g; d[4 * k + 3] = 255;
  }
  const c = document.createElement('canvas');
  c.width = W; c.height = Hc;
  c.getContext('2d').putImageData(img, 0, 0);
  return { canvas: c, interval, indexInterval: interval * INDEX_EVERY };
}

function norm(v) { const l = Math.hypot(...v) || 1; return v.map(x => x / l); }

// Separable box blur, applied twice (close to a Gaussian), radius r pixels.
function blur(a, W, H, r) {
  let src = a, tmp = new Float32Array(a.length), out = new Float32Array(a.length);
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < H; j++) {
      let s = 0; const row = j * W;
      for (let i = -r; i <= r; i++) s += src[row + Math.min(Math.max(i, 0), W - 1)];
      for (let i = 0; i < W; i++) {
        tmp[row + i] = s / (2 * r + 1);
        s += src[row + Math.min(i + r + 1, W - 1)] - src[row + Math.max(i - r, 0)];
      }
    }
    for (let i = 0; i < W; i++) {
      let s = 0;
      for (let j = -r; j <= r; j++) s += tmp[Math.min(Math.max(j, 0), H - 1) * W + i];
      for (let j = 0; j < H; j++) {
        out[j * W + i] = s / (2 * r + 1);
        s += tmp[Math.min(j + r + 1, H - 1) * W + i] - tmp[Math.max(j - r, 0) * W + i];
      }
    }
    src = out; out = pass === 0 ? new Float32Array(a.length) : out;
  }
  return src;
}
