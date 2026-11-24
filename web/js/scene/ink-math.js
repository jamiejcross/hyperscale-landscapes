// The edge rules behind the field style's ink (shared by ink.js's shader and
// the tests; no imports, so Node can load it).
//
// An edge is the strongest of:
//   a. an object change (silhouette against the background, shoreline,
//      building footprint, slab top/wall corner): full strength;
//   b. a depth discontinuity (a skyline over land further away), found from
//      the second difference of 1/z, which is zero across any flat plane:
//      full strength;
//   c. a crease, where the surface turns by more than about 50 degrees:
//      0.8 strength. Gentler folds in the terrain get no ink.

export const EDGE = {
  depthLow: 0.015, depthHigh: 0.04,      // relative second difference of 1/z
  creaseLow: 0.30, creaseHigh: 0.40,     // 1 - cos(angle) between normals
  creaseStrength: 0.8,
};

export function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// idChange: true when a neighbour belongs to another object (or the
// background); depth2: relative second difference of 1/z; cosAngle: dot of
// the two unit normals. Returns 0..1 before the overall strength.
// onTerrain: the pixel is on the land surface, where creases are not inked
// (its sharp folds are grid steps such as stream channels; real skylines
// come from the depth rule).
export function edgeStrength({ idChange = false, depth2 = 0, cosAngle = 1, onTerrain = false }) {
  const a = idChange ? 1 : 0;
  const b = smoothstep(EDGE.depthLow, EDGE.depthHigh, depth2);
  const c = onTerrain ? 0 : smoothstep(EDGE.creaseLow, EDGE.creaseHigh, 1 - cosAngle) * EDGE.creaseStrength;
  return Math.max(a, b, c);
}
export const TERRAIN_ID = 1;

// Width handling: the ring of samples sits at half the line width (in CSS
// px) times the render's pixel ratio; the outline target is drawn at a scale
// that gives at least 2 samples per CSS pixel.
export function ringRadius(lineWidthCss, pixelRatio) { return (lineWidthCss / 2) * pixelRatio; }
export function outlineScale(pixelRatio) { return pixelRatio < 2 ? 2 / pixelRatio : 1; }
