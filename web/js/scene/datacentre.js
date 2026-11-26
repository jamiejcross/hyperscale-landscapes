// Proposed data centres from the planning record (brief v2, "calm"): the screen
// part, shared by the web app and the offline viewer. Buildings are flat-filled
// in the look's building colour, on level platforms, outlined in ink: solid for
// documented features, dashed for indicative ones. Parameter zones are a pale
// tint on the drape with a solid edge (height labels off for now). Nothing animates and
// nothing is symbolic. The plan comes from datacentre-math.js; the terrain cut
// for the platforms is done by the scene (reversible), never on the print.
import * as THREE from 'three';
import { ringSegments } from './datacentre-math.js';

// A footprint extruded from z0 to z1 (print mm, z up): caps from three's
// triangulator, walls per ring edge. Outer anticlockwise, holes clockwise.
function solid(rings, z0, z1) {
  const area = r => r.reduce((a, p, i) => { const q = r[(i + 1) % r.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
  const rs = rings.map((r, k) => { const rr = r.slice(); if ((k === 0) !== (area(rr) > 0)) rr.reverse(); return rr; }).filter(r => r.length >= 3);
  if (!rs.length) return null;
  const v2 = rr => rr.map(([x, y]) => new THREE.Vector2(x, y));
  const tris = THREE.ShapeUtils.triangulateShape(v2(rs[0]), rs.slice(1).map(v2));
  const flat = rs.flat(), n = flat.length, pos = new Float32Array(n * 6), idx = [];
  flat.forEach(([x, y], k) => { pos.set([x, y, z0], 3 * k); pos.set([x, y, z1], 3 * (n + k)); });
  for (const [a, b, c] of tris) {
    const cr = (flat[b][0] - flat[a][0]) * (flat[c][1] - flat[a][1]) - (flat[b][1] - flat[a][1]) * (flat[c][0] - flat[a][0]);
    const [q, r] = cr < 0 ? [c, b] : [b, c];
    idx.push(n + a, n + q, n + r, a, r, q);
  }
  let start = 0;
  for (const r of rs) {
    for (let k = 0; k < r.length; k++) { const P = start + k, Q = start + (k + 1) % r.length; idx.push(n + Q, P, Q, n + Q, n + P, P); }
    start += r.length;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(idx);
  return g;
}

function mergeGeoms(gs) {
  const pos = [], idx = []; let off = 0;
  for (const g of gs) { const P = g.attributes.position.array; pos.push(...P); for (const i of g.index.array) idx.push(i + off); off += P.length / 3; g.dispose(); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); return g;
}

const FONT = 'DejaVu Sans, Helvetica, Arial, sans-serif';
const LABEL_PX = 17;
// Zone height labels ("up to 40 m"): off and hidden for now (JC, 26 Nov 2026; may return).
const HEIGHT_LABELS = false;

export function createDatacentre(plan, { look }) {
  const group = new THREE.Group(); group.name = 'datacentre';
  const mats = {
    body: new THREE.MeshLambertMaterial({ color: 0xd9d1bd, flatShading: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),   // both sides: solid from every angle, whatever the winding
    solid: new THREE.LineBasicMaterial({ color: 0x2b2115, fog: false }),
    dashed: new THREE.LineDashedMaterial({ color: 0x2b2115, dashSize: plan.dashMm, gapSize: plan.gapMm, fog: false }),
    thread: new THREE.LineBasicMaterial({ color: 0x2b2115, transparent: true, opacity: 0.8, fog: false }),
  };
  const lines = [];
  for (const it of plan.items) {
    // from the lowest ground (a plinth where the ground falls away) to the roof
    const parts = it.polys.map(rings => solid(rings, it.low - 0.05, it.top)).filter(Boolean);
    if (!parts.length) continue;
    const g = parts.length === 1 ? parts[0] : mergeGeoms(parts);
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, mats.body);
    mesh.castShadow = mesh.receiveShadow = true; mesh.name = `dc:${it.name}`;
    // Ink: the building's edges (about 20°), plus the platform line where it
    // meets the ground. The plinth's bottom edge is under the ground and is left out.
    const e = new THREE.EdgesGeometry(g, 20), P = e.attributes.position.array, keep = [];
    for (let k = 0; k < P.length; k += 6) if (P[k + 2] > it.low + 0.01 || P[k + 5] > it.low + 0.01) for (let j = 0; j < 6; j++) keep.push(P[k + j]);
    for (const rings of it.polys) for (const r of rings) keep.push(...ringSegments(r, it.level + 0.02));
    e.dispose();
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(keep, 3));
    const ls = new THREE.LineSegments(lg, mats[it.style]);
    if (it.style === 'dashed') ls.computeLineDistances();
    ls.renderOrder = 2;
    group.add(mesh, ls); lines.push(ls);
  }
  // Zone height labels ("up to 40 m"), on a short thread above the zone.
  const labels = [];
  for (const z of HEIGHT_LABELS ? plan.zones : []) {
    if (!Number.isFinite(z.heightM)) continue;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(`up to ${z.heightM} m`), depthTest: false, depthWrite: false, sizeAttenuation: false, fog: false }));
    sp.center.set(0.5, 0); sp.renderOrder = 10; sp.userData.aspect = sp.material.map.image.width / sp.material.map.image.height;
    labels.push({ sp, z });
    group.add(sp);
  }
  function placeLabels(zAt) {
    for (const L of labels) {
      const [x, y] = L.z.centre, g = zAt(x, y), lift = 30 * plan.mmPerM;
      L.sp.position.set(x, y, g + lift);
      const tg = new THREE.BufferGeometry(); tg.setAttribute('position', new THREE.Float32BufferAttribute([x, y, g, x, y, g + lift], 3));
      L.thread?.geometry.dispose(); group.remove(L.thread);
      L.thread = new THREE.LineSegments(tg, mats.thread); group.add(L.thread);
    }
  }
  function labelTexture(text) {
    const c0 = document.createElement('canvas').getContext('2d');
    c0.font = `bold 40px ${FONT}`;
    const cv = document.createElement('canvas'); cv.width = Math.ceil(c0.measureText(text).width) + 36; cv.height = 64;
    const c = cv.getContext('2d');
    c.fillStyle = 'rgba(255,250,236,0.95)'; c.fillRect(0, 0, cv.width, cv.height);
    c.strokeStyle = '#2b2115'; c.lineWidth = 4; c.strokeRect(2, 2, cv.width - 4, cv.height - 4);
    c.fillStyle = '#2b2115'; c.font = `bold 40px ${FONT}`; c.textBaseline = 'middle'; c.fillText(text, 18, cv.height / 2 + 2);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  function setLook(P) {
    mats.body.color.set(P.roof || P.layers?.buildings || '#d9d1bd');
    for (const k of ['solid', 'dashed', 'thread']) mats[k].color.set(P.ink || '#2b2115');
  }
  // Zones: a pale tint with a thin solid edge, painted into the drape (W x H mm plate).
  function paint(g, { Wmm, Hmm }, P) {
    if (!plan.zones.length) return;
    const W = g.canvas.width, H = g.canvas.height, X = x => x / Wmm * W, Y = y => (1 - y / Hmm) * H;
    g.save();
    for (const z of plan.zones) {
      g.beginPath();
      for (const rings of z.polys) for (const r of rings) { r.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y)))); g.closePath(); }
      g.globalAlpha = 0.32; g.fillStyle = '#fffaec'; g.fill('evenodd');
      g.globalAlpha = 0.9; g.strokeStyle = P?.ink || '#2b2115'; g.lineWidth = Math.max(1.2, W / 2400); g.setLineDash(z.style === 'dashed' ? [W / 500, W / 700] : []); g.stroke();
    }
    g.restore();
  }
  // Labels keep a fixed pixel height (sprites without size attenuation).
  function layout(camera, size) {
    if (!labels.length) return;
    const sy = LABEL_PX * 2 / (camera.projectionMatrix.elements[5] * size.y);
    for (const L of labels) L.sp.scale.set(sy * L.sp.userData.aspect, sy, 1);
  }
  function dispose() {
    group.traverse(o => { o.geometry?.dispose(); if (o.isSprite) { o.material.map.dispose(); o.material.dispose(); } });
    for (const m of Object.values(mats)) m.dispose();
  }
  setLook(look);
  return { group, plan, setLook, paint, layout, placeLabels, dispose, hasZones: plan.zones.length > 0,
    counts: { buildings: plan.items.filter(i => i.kind === 'building').length, extents: plan.items.filter(i => i.kind === 'extent').length, zones: plan.zones.length } };
}
