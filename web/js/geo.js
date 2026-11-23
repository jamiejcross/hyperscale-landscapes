// Local equirectangular projection, identical to the Python pipeline's.
export const M_PER_DEG_LAT = 111320;

export function makeProjection(bbox) {
  const mid = (bbox.minLat + bbox.maxLat) / 2;
  const mPerDegLon = M_PER_DEG_LAT * Math.cos(mid * Math.PI / 180);
  const widthM = (bbox.maxLon - bbox.minLon) * mPerDegLon;
  const heightM = (bbox.maxLat - bbox.minLat) * M_PER_DEG_LAT;
  return {
    widthM, heightM, mPerDegLon,
    toXY: (lon, lat) => [(lon - bbox.minLon) * mPerDegLon, (lat - bbox.minLat) * M_PER_DEG_LAT],
    toLonLat: (x, y) => [bbox.minLon + x / mPerDegLon, bbox.minLat + y / M_PER_DEG_LAT],
  };
}

export function bboxSizeKm(b) {
  const p = makeProjection(b);
  return { w: p.widthM / 1000, h: p.heightM / 1000 };
}

export function bboxOfCoords(coords, padM = 0) {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const [lon, lat] of coords) {
    minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
  }
  const mid = (minLat + maxLat) / 2;
  const dLat = padM / M_PER_DEG_LAT;
  const dLon = padM / (M_PER_DEG_LAT * Math.cos(mid * Math.PI / 180));
  return { minLat: minLat - dLat, maxLat: maxLat + dLat, minLon: minLon - dLon, maxLon: maxLon + dLon };
}

// Every [lon, lat] pair in a GeoJSON geometry, feature or collection.
export function allCoords(gj, out = []) {
  if (!gj) return out;
  if (gj.type === 'FeatureCollection') gj.features.forEach(f => allCoords(f, out));
  else if (gj.type === 'Feature') allCoords(gj.geometry, out);
  else if (gj.type === 'GeometryCollection') gj.geometries.forEach(g => allCoords(g, out));
  else if (gj.coordinates) (function walk(c) {
    if (typeof c[0] === 'number') out.push(c); else c.forEach(walk);
  })(gj.coordinates);
  return out;
}

// Outer rings + holes of every polygon in a GeoJSON object.
export function polygonsOf(gj) {
  const out = [];
  (function walk(g) {
    if (!g) return;
    if (g.type === 'FeatureCollection') g.features.forEach(walk);
    else if (g.type === 'Feature') walk(g.geometry);
    else if (g.type === 'GeometryCollection') g.geometries.forEach(walk);
    else if (g.type === 'Polygon') out.push(g.coordinates);
    else if (g.type === 'MultiPolygon') g.coordinates.forEach(p => out.push(p));
  })(gj);
  return out;
}

export function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(x, y, rings) {
  if (!pointInRing(x, y, rings[0])) return false;
  for (let k = 1; k < rings.length; k++) if (pointInRing(x, y, rings[k])) return false;
  return true;
}

export function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return a / 2;   // positive = clockwise in y-up coordinates
}
