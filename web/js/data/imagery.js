// Optional satellite drape: EOxCloudless (Sentinel-2 cloudless mosaics by
// EOX IT Services GmbH). Licences checked 24 Nov 2026; see DATA_LICENCES.md.
//
//   2016: CC BY 4.0. Anything made with it can be shared freely.
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
  'eox-2016': {
    label: 'Satellite, 2016 (free to share)', layer: 's2cloudless_3857', licence: 'CC BY 4.0',
    attribution: 'Satellite: EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016 & 2017), CC BY 4.0',
    note: 'Imagery from 2016–17, at 10 m: recent buildings and sites may not show.',
  },
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
  return out;
}
