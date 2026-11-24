// Optional satellite drape: EOxCloudless (Sentinel-2 cloudless mosaics by
// EOX IT Services GmbH). Licences checked 24 Nov 2026; see DATA_LICENCES.md.
//
//   2025: CC BY-NC-SA 4.0. Exports must carry the licence notice, and the
//         people who receive them may not use them commercially (EOX counts
//         councils and government agencies as commercial users).
//
// Native resolution is 10 m, so the drape shows fields, woods and large
// sites, not individual buildings. It is never part of a print file.
import { cacheGet, cacheSet } from './cache.js';

const URL_PATTERN = 'https://tiles.maps.eox.at/wmts/1.0.0/{layer}/default/g/{z}/{y}/{x}.jpg';
const ZOOM = 14;   // ~5 m per pixel at Scottish latitudes; the data are 10 m

export const SURFACES = {
  landcover: { label: 'Land cover (OpenStreetMap)', attribution: null },
  contours: { label: 'Contours (from elevation data)', attribution: null },
  'eox-2025': {
    label: 'Satellite, 2025 (non-commercial)', layer: 's2cloudless-2025_3857', licence: 'CC BY-NC-SA 4.0',
    attribution: 'Satellite: EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2025), CC BY-NC-SA 4.0',
    note: 'Images made with this layer may only be shared for non-commercial use, under the same licence. Councils and government bodies may not be able to reuse them.',
    nonCommercial: true,
  },
};

const lon2x = (lon, z) => (lon + 180) / 360 * 2 ** z;
const lat2y = (lat, z) => {
  const r = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z;
};

async function tile(layer, z, x, y) {
  const key = `eox:${layer}:${z}/${x}/${y}`;
  const hit = await cacheGet(key);
  if (hit) return hit;
  const url = URL_PATTERN.replace('{layer}', layer).replace('{z}', z).replace('{x}', x).replace('{y}', y);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Satellite tile ${z}/${x}/${y}: ${r.status}`);
  const b = await r.blob();
  await cacheSet(key, b);
  return b;
}

// Returns a canvas covering the model area exactly, north up, `widthPx` wide.
export async function imageryCanvas(surfaceId, bbox, grid, widthPx = 2048) {
  const s = SURFACES[surfaceId];
  if (!s?.layer) throw new Error(`Unknown imagery layer ${surfaceId}`);
  const z = ZOOM;
  const x0 = Math.floor(lon2x(bbox.minLon, z)), x1 = Math.floor(lon2x(bbox.maxLon, z));
  const y0 = Math.floor(lat2y(bbox.maxLat, z)), y1 = Math.floor(lat2y(bbox.minLat, z));
  const src = new OffscreenCanvas((x1 - x0 + 1) * 256, (y1 - y0 + 1) * 256);
  const sg = src.getContext('2d');
  const jobs = [];
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
    jobs.push(tile(s.layer, z, tx, ty).then(createImageBitmap).then(bmp => sg.drawImage(bmp, (tx - x0) * 256, (ty - y0) * 256)));
  }
  await Promise.all(jobs);

  // Reproject: longitude is linear in both projections; latitude is not, so
  // copy one output row at a time from the matching Mercator row.
  const out = document.createElement('canvas');
  out.width = widthPx; out.height = Math.round(widthPx * grid.Hmm / grid.Wmm);
  const og = out.getContext('2d');
  og.imageSmoothingQuality = 'high';
  const sx = (lon2x(bbox.minLon, z) - x0) * 256, sw = (lon2x(bbox.maxLon, z) - lon2x(bbox.minLon, z)) * 256;
  for (let row = 0; row < out.height; row++) {
    const lat = bbox.maxLat - (row + 0.5) / out.height * (bbox.maxLat - bbox.minLat);
    const sy = (lat2y(lat, z) - y0) * 256;
    og.drawImage(src, sx, Math.max(0, sy - 0.5), sw, 1, 0, row, out.width, 1);
  }
  grade(out, out.width / sw);
  return out;
}

// Sentinel-2 mosaics come out dark, flat and very green on a lit 3D surface.
// A light, global grade (the same for every pixel, so nothing is invented):
// stretch luminance between its 0.5th and 99.5th percentiles, lift the
// midtones, pull saturation back a little, then a mild unsharp mask at the
// scale of the source pixels to undo the softness of upsampling.
export function grade(c, upscale = 1) {
  const g = c.getContext('2d', { willReadFrequently: true });
  const { width: w, height: h } = c;
  // unsharp mask first, on the reprojected image
  const blur = document.createElement('canvas'); blur.width = w; blur.height = h;
  const bg = blur.getContext('2d', { willReadFrequently: true });
  bg.filter = `blur(${Math.max(1, upscale * 0.9).toFixed(1)}px)`; bg.drawImage(c, 0, 0);
  const img = g.getImageData(0, 0, w, h), d = img.data, b = bg.getImageData(0, 0, w, h).data;
  const AMOUNT = 0.55, SAT = 0.72, GAMMA = 0.9;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    for (let k = 0; k < 3; k++) d[i + k] = Math.max(0, Math.min(255, d[i + k] + AMOUNT * (d[i + k] - b[i + k])));
    hist[(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) | 0]++;
  }
  const n = w * h, pct = q => { let acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= q * n) return v; } return 255; };
  const lo = pct(0.005), hi = Math.max(lo + 1, pct(0.995));
  const lut = new Float32Array(256);
  for (let v = 0; v < 256; v++) lut[v] = 255 * Math.pow(Math.min(1, Math.max(0, (v - lo) / (hi - lo))), GAMMA);
  for (let i = 0; i < d.length; i += 4) {
    const L = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    const k = L > 0.5 ? lut[L | 0] / L : 1;
    for (let j = 0; j < 3; j++) {
      const v = d[i + j] * k, Lk = L * k;
      d[i + j] = Math.max(0, Math.min(255, Lk + SAT * (v - Lk)));
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}
