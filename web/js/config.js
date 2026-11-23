// Limits and endpoints for the browser tier. See PLAN.md §8 and PRIVACY.md.
export const LIMITS = {
  maxAreaKm2: 9.0,          // about 3 km × 3 km
  maxSideKm: 4.0,
  warnSideKm: 3.0,
};

// Target print-space cell size for the browser grid (mm). Coarser on phones.
export const CELL_MM = globalThis.matchMedia?.('(max-width: 700px)').matches ? 0.45 : 0.3;
export const MAX_COLS = 720;

export const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// AWS Terrain Tiles (Terrarium encoding), CORS-enabled, no key.
export const TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const TERRARIUM_ZOOM = 14;

export const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
export const BASEMAP = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
