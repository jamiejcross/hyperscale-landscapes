// Elevation, sampled bilinearly. Two sources:
//  - Curated sites in Scotland ship a Scottish Government LiDAR terrain grid
//    (4 m, bare earth, OGL v3) in their bundle; see pipeline/bake.py.
//  - Anywhere else: AWS Terrain Tiles (Terrarium PNGs), where height in
//    metres is (R × 256 + G + B / 256) − 32768, fetched once and stitched.
import { TERRARIUM, TERRARIUM_ZOOM } from '../config.js';
import { cacheGet, cacheSet } from './cache.js';

export const ATTRIBUTION = 'Elevation: Mapzen Terrain Tiles (SRTM and GMTED2010 courtesy of the U.S. Geological Survey; ETOPO1, NOAA; UK: © Environment Agency 2015)';

const lon2x = (lon, z) => (lon + 180) / 360 * 2 ** z;
const lat2y = (lat, z) => {
  const r = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z;
};

export function tilesFor(bbox, z = TERRARIUM_ZOOM) {
  const x0 = Math.floor(lon2x(bbox.minLon, z)), x1 = Math.floor(lon2x(bbox.maxLon, z));
  const y0 = Math.floor(lat2y(bbox.maxLat, z)), y1 = Math.floor(lat2y(bbox.minLat, z));
  const tiles = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) tiles.push({ z, x, y });
  return { z, x0, y0, x1, y1, tiles };
}

async function tileBlob({ z, x, y }, bundled) {
  const key = `${z}/${x}/${y}`;
  if (bundled?.[key]) return await (await fetch(`data:image/png;base64,${bundled[key]}`)).blob();
  const hit = await cacheGet(`terrarium:${key}`);
  if (hit) return hit;
  const r = await fetch(TERRARIUM.replace('{z}', z).replace('{x}', x).replace('{y}', y));
  if (!r.ok) throw new Error(`Elevation tile ${key}: ${r.status}`);
  const blob = await r.blob();
  await cacheSet(`terrarium:${key}`, blob);
  return blob;
}

export const SHORT = 'Elevation: Mapzen Terrain Tiles (USGS, NOAA, EA)';
const LIDAR_SHORT = 'Elevation: Scottish Government LiDAR (OGL v3)';

// Decode a bundled LiDAR grid: int16 decimetres, delta-coded along each row,
// row 0 at the north edge, spanning the bundle's bbox exactly.
function lidarSampler(L, bb) {
  const bin = Uint8Array.from(atob(L.data), c => c.charCodeAt(0));
  const d = new Int16Array(bin.buffer, bin.byteOffset, L.w * L.h);
  const z = new Float32Array(L.w * L.h);
  for (let r = 0; r < L.h; r++) {
    let acc = 0;
    for (let c = 0; c < L.w; c++) { acc += d[r * L.w + c]; z[r * L.w + c] = acc / 10; }
  }
  const at = (c, r) => z[Math.min(L.h - 1, Math.max(0, r)) * L.w + Math.min(L.w - 1, Math.max(0, c))];
  return (lon, lat) => {
    const fx = (lon - bb.min_lon) / (bb.max_lon - bb.min_lon) * L.w - 0.5;
    const fy = (bb.max_lat - lat) / (bb.max_lat - bb.min_lat) * L.h - 0.5;
    const c = Math.floor(fx), r = Math.floor(fy), dx = fx - c, dy = fy - r;
    return (1 - dx) * (1 - dy) * at(c, r) + dx * (1 - dy) * at(c + 1, r)
         + (1 - dx) * dy * at(c, r + 1) + dx * dy * at(c + 1, r + 1);
  };
}

// `bundle`: a site bundle (with .elevation and .bbox) or null.
// Returns { sample(lon, lat) -> metres, attribution, short, source, metresPerPixel }.
export async function loadElevation(bbox, bundle = null) {
  const L = bundle?.elevation?.lidar;
  if (L) {
    return { sample: lidarSampler(L, bundle.bbox), attribution: L.attribution, short: LIDAR_SHORT,
      source: L.source, gapFraction: L.gap_fraction || 0, metresPerPixel: L.res_m };
  }
  const bundled = bundle?.elevation?.tiles || null;
  const T = tilesFor(bbox);
  const nx = T.x1 - T.x0 + 1, ny = T.y1 - T.y0 + 1;
  const canvas = new OffscreenCanvas(nx * 256, ny * 256);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  await Promise.all(T.tiles.map(async t => {
    const bmp = await createImageBitmap(await tileBlob(t, bundled), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    ctx.drawImage(bmp, (t.x - T.x0) * 256, (t.y - T.y0) * 256);
  }));
  const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const W = canvas.width, H = canvas.height;
  const h = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) h[i] = px[4 * i] * 256 + px[4 * i + 1] + px[4 * i + 2] / 256 - 32768;
  const at = (c, r) => h[Math.min(H - 1, Math.max(0, r)) * W + Math.min(W - 1, Math.max(0, c))];
  const sample = (lon, lat) => {
    const fx = (lon2x(lon, T.z) - T.x0) * 256 - 0.5, fy = (lat2y(lat, T.z) - T.y0) * 256 - 0.5;
    const c = Math.floor(fx), r = Math.floor(fy), dx = fx - c, dy = fy - r;
    return (1 - dx) * (1 - dy) * at(c, r) + dx * (1 - dy) * at(c + 1, r)
         + (1 - dx) * dy * at(c, r + 1) + dx * dy * at(c + 1, r + 1);
  };
  return { sample, attribution: ATTRIBUTION, short: SHORT, source: 'terrarium', tiles: T.tiles.length, metresPerPixel: 40075016 * Math.cos((bbox.minLat + bbox.maxLat) / 2 * Math.PI / 180) / 2 ** T.z / 256 };
}
