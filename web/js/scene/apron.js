// The context apron (screen only; docs/claude-code-prompt-context-apron-sections.md,
// stage 2): coarse terrain round the model from the bundle's context section,
// with the main infrastructure draped on it, pylons and poles, and place and
// landuse names, faded toward the background with distance from the model.
//
// CONTEXT, not the model: it is never printed, never in a print file, and is
// labelled only in the legend and the manifest. Nothing inside the model area
// is drawn (the model has its own data there); the apron meets the model's
// edge at the model's own edge vertices, and an ink line marks the border in
// every look.
import * as THREE from 'three';
import { decodeContextGrid, apronMesh, contextShade, contextFeatures, distOutside, landFade, lineFade, edgeBlend, EDGE_BLEND, desaturate, mixRGB, hexRGB,
  cullLabels, NAME_NOTES, NAME_RANK } from './apron-math.js';
import { paintOverlays } from './overlays.js';
import { paintWater, glyphWires } from './carto.js';
import { createGlyphs } from './glyphs.js';
import { supportGeometries, PROP_INK_IDS } from './props.js';
import { spanPoints, yawForBearing } from './props-math.js';

const FONT = 'DejaVu Sans, Helvetica, Arial, sans-serif';      // as the pit labels (pits.js)
const PALE = 'rgba(255,250,236,0.97)';
const LABEL_PX = 20;                                             // the pit labels' dense size, CSS px
export const APRON_INK_ID = 0;      // the background's ID: inked only where it meets the model (ink.js)
const M_PER_DEG_LAT = 111320;

// context: bundle.context; bbox: bundle.bbox; grid: the model grid (Wmm, Hmm,
// mmPerM, nx, ny, dx, dy); relief: { base, zExag, minM }; edgeZ(x, y): the
// displayed model height on its edge; maxTexture: the renderer's limit.
export function createApron({ context, bbox, grid, relief, edgeZ, maxTexture = 4096, ramp }) {
  const t0 = performance.now();
  const E = context.elevation, { Wmm, Hmm, mmPerM } = grid;
  const z = decodeContextGrid(E);
  const decodeMs = performance.now() - t0;
  const padMm = context.pad_m * mmPerM;
  const xs = Array.from({ length: grid.nx }, (_, i) => Math.min(Wmm, i * grid.dx));
  const ys = Array.from({ length: grid.ny }, (_, j) => Math.max(0, Hmm - (grid.ny - 1 - j) * grid.dy));
  xs[xs.length - 1] = Wmm; ys[0] = 0; ys[ys.length - 1] = Hmm;
  const m = apronMesh({ E, z, mm: { mmPerM, base: relief.base, zExag: relief.zExag, minM: relief.minM }, Wmm, Hmm, edge: { xs, ys }, edgeZ });
  const ext = m.extent;

  const root = new THREE.Group(); root.name = 'context-apron';
  const geo = new THREE.BufferGeometry();
  function setGeometry(g0) {
    geo.setAttribute('position', new THREE.BufferAttribute(g0.positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(g0.uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(g0.indices, 1));
    geo.computeVertexNormals(); geo.computeBoundingSphere();
  }
  setGeometry(m);
  const mesh = new THREE.Mesh(geo); mesh.name = 'context-apron-land';
  mesh.userData = { inkId: APRON_INK_ID, context: true }; mesh.receiveShadow = false;   // (the shadow map covers the model only) mesh.castShadow = false;
  root.add(mesh);
  // A floor across the model's footprint, in the apron's own colours (same
  // texture, same mapping): shown when the model's terrain is hidden, so the
  // ground does not open onto the sky through the model (JC 26 Nov 2026).
  const floorGeo = new THREE.BufferGeometry();
  let FZ = Infinity; for (const i of m.inner) FZ = Math.min(FZ, m.positions[3 * i + 2]);   // level with the lowest point of the apron's inner edge
  if (!Number.isFinite(FZ)) FZ = 0.3;
  const fuv = (x, y) => [(x - ext.x0) / (ext.x1 - ext.x0), (y - ext.y0) / (ext.y1 - ext.y0)];
  floorGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, FZ, Wmm, 0, FZ, Wmm, Hmm, FZ, 0, Hmm, FZ], 3));
  floorGeo.setAttribute('uv', new THREE.Float32BufferAttribute([...fuv(0, 0), ...fuv(Wmm, 0), ...fuv(Wmm, Hmm), ...fuv(0, Hmm)], 2));
  floorGeo.setIndex([0, 1, 2, 0, 2, 3]); floorGeo.computeVertexNormals();
  const floor = new THREE.Mesh(floorGeo); floor.name = 'context-apron-floor';
  floor.userData = { inkId: APRON_INK_ID, context: true }; floor.visible = false;
  root.add(floor);
  let floorOn = false;
  const showFloor = () => { floor.visible = floorOn && mesh.visible; };
  function setFloor(on) { floorOn = !!on; showFloor(); }

  // Ground height on the apron (mm): bilinear on the context grid, the model's mapping.
  const kz = relief.zExag * mmPerM;
  const zAt = (x, y) => {
    const fc = Math.min(E.w - 1.0001, Math.max(0, (x / mmPerM - E.x0_m) / E.dx_m)), fr = Math.min(E.h - 1.0001, Math.max(0, (E.y_top_m - y / mmPerM) / E.dy_m));
    const c = Math.floor(fc), r = Math.floor(fr), a = fc - c, b = fr - r, v = (cc, rr) => Math.max(0, z[rr * E.w + cc]);
    const e = (1 - a) * (1 - b) * v(c, r) + a * (1 - b) * v(c + 1, r) + (1 - a) * b * v(c, r + 1) + a * b * v(c + 1, r + 1);
    return Math.max(0.3, relief.base + (e - relief.minM) * kz);
  };

  // The ink border round the model, on the shared edge vertices.
  const loop = [];
  const inner = m.inner, P = m.positions;
  // order the edge vertices round the rectangle (south, east, north, west)
  const per = i => { const x = P[3 * i], y = P[3 * i + 1];
    if (y < 1e-4) return x; if (Math.abs(x - Wmm) < 1e-4) return Wmm + y; if (Math.abs(y - Hmm) < 1e-4) return Wmm + Hmm + (Wmm - x); return 2 * Wmm + Hmm + (Hmm - y); };
  const ring = [...inner].sort((a, b) => per(a) - per(b));
  for (const i of ring) loop.push(P[3 * i], P[3 * i + 1], P[3 * i + 2] + 0.04);
  const bg = new THREE.BufferGeometry(); bg.setAttribute('position', new THREE.Float32BufferAttribute(loop, 3));
  const border = new THREE.LineLoop(bg, new THREE.LineBasicMaterial({ color: '#221d18', fog: false }));
  border.name = 'context-border'; border.renderOrder = 3;
  border.visible = false;      // JC 26 Nov 2026: no line between the model and the context; the land runs on (kept for reference)
  root.add(border);
  function setEdge(fn) {          // the displayed edge changed (Anthropogenic's smoothed land)
    const la = bg.attributes.position;
    for (const i of inner) m.positions[3 * i + 2] = fn(m.positions[3 * i], m.positions[3 * i + 1]);
    ring.forEach((i, k) => la.setZ(k, m.positions[3 * i + 2] + 0.04));
    la.needsUpdate = true; bg.computeBoundingSphere();
    setGeometry(m);
  }

  // ---- context features ----
  const mid = (bbox.min_lat + bbox.max_lat) / 2, mlon = M_PER_DEG_LAT * Math.cos(mid * Math.PI / 180);
  const toMm = (lon, lat) => [(lon - bbox.min_lon) * mlon * mmPerM, (lat - bbox.min_lat) * M_PER_DEG_LAT * mmPerM];
  const { vectors: V, names } = contextFeatures(context.osm?.elements || [], toMm, Wmm, Hmm);

  // ---- the painted surface ----
  const long = Math.min(4096, maxTexture), spanX = ext.x1 - ext.x0, spanY = ext.y1 - ext.y0;
  const CW = spanX >= spanY ? long : Math.round(long * spanX / spanY), CH = spanX >= spanY ? Math.round(long * spanY / spanX) : long;
  const canvas = document.createElement('canvas'); canvas.width = CW; canvas.height = CH;
  const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  const ppm = CW / spanX;                                      // canvas px per model mm
  // the land at low resolution (smooth: colour and fade only), enlarged
  const LW = 768, LH = Math.max(8, Math.round(LW * CH / CW));
  const land = document.createElement('canvas'); land.width = LW; land.height = LH;
  const shade = contextShade(z, E);
  // lines and their fade mask (alpha = how much a line fades), at low resolution
  const fadeMask = document.createElement('canvas'); fadeMask.width = 512; fadeMask.height = Math.max(8, Math.round(512 * CH / CW));
  {
    const g = fadeMask.getContext('2d'), img = g.createImageData(fadeMask.width, fadeMask.height);
    for (let j = 0; j < fadeMask.height; j++) for (let i = 0; i < fadeMask.width; i++) {
      const x = ext.x0 + (i + 0.5) / fadeMask.width * spanX, y = ext.y1 - (j + 0.5) / fadeMask.height * spanY;
      img.data[4 * (j * fadeMask.width + i) + 3] = Math.round(255 * lineFade(distOutside(x, y, Wmm, Hmm), padMm));
    }
    g.putImageData(img, 0, 0);
  }
  const layer = document.createElement('canvas'); layer.width = CW; layer.height = CH;
  // A 2D context that draws in the model drape's own pixel frame (so painters
  // written for the model drape draw here at the same weight per mm).
  function drapeFrame(g, drapeW) {
    const drapeH = drapeW * Hmm / Wmm, k = ppm / (drapeW / Wmm);
    g.setTransform(k, 0, 0, k, -ext.x0 * ppm, (ext.y1 - Hmm) * ppm);
    const fake = { width: drapeW, height: drapeH };
    return new Proxy(g, { get: (t, p) => p === 'canvas' ? fake : (typeof t[p] === 'function' ? t[p].bind(t) : t[p]), set: (t, p, v) => { t[p] = v; return true; } });
  }

  // The model's own land colour along its edge (edge: { canvas, key }: the
  // model drape, north up, covering the model), sampled at the nearest edge point.
  let edgeCache = null;
  function edgeColour(edge) {
    if (!edge?.canvas) return null;
    if (edgeCache?.key === edge.key) return edgeCache.fn;
    const N = 96, Mh = Math.max(2, Math.round(N * Hmm / Wmm));
    const c = document.createElement('canvas'); c.width = N; c.height = Mh;
    const g = c.getContext('2d', { willReadFrequently: true }); g.imageSmoothingQuality = 'high'; g.drawImage(edge.canvas, 0, 0, N, Mh);
    const px = g.getImageData(0, 0, N, Mh).data;
    const fn = (x, y) => {
      const i = Math.min(N - 1, Math.max(0, Math.floor(x / Wmm * N))), j = Math.min(Mh - 1, Math.max(0, Math.floor((1 - y / Hmm) * Mh))), o = 4 * (j * N + i);
      return [px[o], px[o + 1], px[o + 2]];
    };
    edgeCache = { key: edge.key, fn };
    return fn;
  }
  let painted = null;
  // look: the palette (PALETTES[look]); carto: Anthropogenic's carto palette or
  // null; bgHex: the colour the land fades toward (the background's horizon).
  // bare: Energy Context on its own: no land, routes or water; the model's edge
  // colour gives way to the background over the same distance as the land does.
  function paint({ P, carto: C = null, bgHex, drapeW, show = {}, edge = null, bare = false }) {
    const key = JSON.stringify([P.landBase, bgHex, !!C, drapeW, show, edge?.key || null, bare]);
    const fromEdge = edgeColour(edge);
    if (painted === key) return null;
    const t1 = performance.now();
    // 1. land: the look's land colour, desaturated, blended toward the background
    const g0 = land.getContext('2d'), img = g0.createImageData(LW, LH), d = img.data;
    const base = desaturate(C ? (C.landBase || P.landBase) : P.landBase), sea = desaturate(C ? C.water : P.water), bgc = hexRGB(bgHex);
    const rAlpha = C ? (C.reliefAlpha ?? 0.6) : 0;
    for (let j = 0; j < LH; j++) for (let i = 0; i < LW; i++) {
      const x = ext.x0 + (i + 0.5) / LW * spanX, y = ext.y1 - (j + 0.5) / LH * spanY;
      const c = Math.round((x / mmPerM - E.x0_m) / E.dx_m), r = Math.round((E.y_top_m - y / mmPerM) / E.dy_m);
      const q = Math.min(E.h - 1, Math.max(0, r)) * E.w + Math.min(E.w - 1, Math.max(0, c));
      const dd = distOutside(x, y, Wmm, Hmm);
      let col = bare ? bgc : z[q] <= 0.05 ? sea : base;
      if (rAlpha && !bare) { const s = shade[q] / 255; col = col.map(v => v * (1 - rAlpha + rAlpha * s)); }   // the carto look's baked relief
      if (fromEdge && EDGE_BLEND > 0) col = mixRGB(fromEdge(x, y), col, edgeBlend(dd, padMm));      // the model's land runs on, then gives way (off: EDGE_BLEND 0)
      col = mixRGB(col, bgc, landFade(dd, padMm));
      const o = 4 * (j * LW + i); d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2]; d[o + 3] = 255;
    }
    g0.putImageData(img, 0, 0);
    const g = canvas.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0); g.imageSmoothingQuality = 'high'; g.drawImage(land, 0, 0, CW, CH);
    if (bare) { tex.needsUpdate = true; painted = key; return { ms: Math.round(performance.now() - t1), size: [CW, CH] }; }
    // 2. infrastructure on a layer: drawn as on the model, cut at the model edge, faded (weaker)
    const L = layer.getContext('2d');
    L.setTransform(1, 0, 0, 1, 0, 0); L.clearRect(0, 0, CW, CH);
    L.save();
    const f = drapeFrame(L, drapeW);
    const water = C ? C.water : P.water;
    if (show.water !== false) paintWater(f, { vectors: { lakes: V.lakes, waterways: V.waterways }, Wmm, mmPerM, colour: water, riverM: 6, streamM: 3.2 });
    if (show.buildings !== false && V.footprints.length) {
      f.fillStyle = C ? C.building : P.layers.buildings; f.strokeStyle = C ? P.ink : 'rgba(0,0,0,0)'; f.lineWidth = C ? C.footEdge * drapeW / C.drapePx : 0;
      const X = x => x / Wmm * drapeW, Y = y => (1 - y / Hmm) * drapeW * Hmm / Wmm;
      for (const b of V.footprints) {
        f.beginPath();
        for (const r of b.rings) { for (let i = 0; i < r.length; i += 2) (i ? f.lineTo : f.moveTo).call(f, X(r[i]), Y(r[i + 1])); f.closePath(); }
        f.fill('evenodd'); if (C) f.stroke();
      }
    }
    if (C) paintCartoRoutes(f, V, { Wmm, Hmm, drapeW, C, ink: P.ink, show });
    else paintOverlays(f, { roads: V.roads, rail: V.rail, railDisused: V.railDisused, powerLines: V.powerLines }, { Wmm, Hmm, colours: P.overlays,
      show: { roads: show.roads !== false, rail: show.rail !== false, power: show.power !== false, residues: false } });
    if (show.pipelines !== false && V.pipelines.length) {      // pipelines: a thin dashed ink line (not drawn on the model)
      const X = x => x / Wmm * drapeW, Y = y => (1 - y / Hmm) * drapeW * Hmm / Wmm, s = drapeW / 2048;
      f.save(); f.strokeStyle = P.ink; f.globalAlpha = 0.7; f.lineWidth = 1.1 * s; f.setLineDash([4 * s, 3 * s]);
      for (const p of V.pipelines) { f.beginPath(); for (let i = 0; i < p.p.length; i += 2) (i ? f.lineTo : f.moveTo).call(f, X(p.p[i]), Y(p.p[i + 1])); f.stroke(); }
      f.restore();
    }
    L.restore();
    L.setTransform(1, 0, 0, 1, 0, 0);
    L.clearRect((0 - ext.x0) * ppm, (ext.y1 - Hmm) * ppm, Wmm * ppm, Hmm * ppm);     // nothing inside the model
    L.globalCompositeOperation = 'destination-out'; L.imageSmoothingQuality = 'high'; L.drawImage(fadeMask, 0, 0, CW, CH);
    L.globalCompositeOperation = 'source-over';
    g.drawImage(layer, 0, 0);
    tex.needsUpdate = true;
    painted = key;
    return { ms: Math.round(performance.now() - t1), size: [CW, CH] };
  }

  // ---- materials, per look ----
  const mats = {};
  function material(look, lit) {
    look = `${look}|${lit ? 'lit' : 'flat'}`;
    if (!mats[look]) mats[look] = lit ? new THREE.MeshToonMaterial({ map: tex, gradientMap: ramp?.() }) : new THREE.MeshBasicMaterial({ map: tex });
    return mats[look];
  }

  // ---- pylons and poles (3D, Field and Guthrie) and their wires ----
  const sup = (context.power?.supports || []);
  const supXY = sup.map(o => ({ ...o, X: o.x * mmPerM, Y: o.y * mmPerM }));
  const { tower, pole } = supportGeometries();
  const props3d = new THREE.Group(); props3d.name = 'context-pylons'; root.add(props3d);
  const supMats = {};
  const q = new THREE.Quaternion(), m4 = new THREE.Matrix4(), v = new THREE.Vector3(), s = new THREE.Vector3(), Z = new THREE.Vector3(0, 0, 1);
  const placeAll = (im, list) => {
    list.forEach((o, i) => {
      const h = o.height * mmPerM;
      q.setFromAxisAngle(Z, yawForBearing(o.bearing ?? 0));
      im.setMatrixAt(i, m4.compose(v.set(o.X, o.Y, zAt(o.X, o.Y) - 0.05), q, s.set(h, h, h)));
    });
    im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere();
  };
  const instanced = (g0, list) => {
    if (!list.length) { g0.dispose(); return null; }
    const im = new THREE.InstancedMesh(g0, null, list.length);
    placeAll(im, list); im.userData = { inkId: PROP_INK_IDS.pylons, context: true, list };
    im.castShadow = false; im.receiveShadow = false;
    props3d.add(im); return im;
  };
  const towers = instanced(tower, supXY.filter(o => o.kind !== 'pole')), poles = instanced(pole, supXY.filter(o => o.kind === 'pole'));
  // wires: support top to support top along each line, outside the model only
  const at = new Map(sup.map(o => [`${Math.round(o.x * 2)},${Math.round(o.y * 2)}`, o]));
  const wireAll = [];
  const outside = (a, b) => distOutside((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Wmm, Hmm) > 0;
  for (const Ln of context.power?.lines || []) {
    const pts = Ln.xy.map(([xm, ym]) => { const o = at.get(`${Math.round(xm * 2)},${Math.round(ym * 2)}`), x = xm * mmPerM, y = ym * mmPerM;
      return [x, y, zAt(x, y) + (o ? o.height * 0.9 : 10) * mmPerM]; });
    for (let k = 1; k < pts.length; k++) {
      const p = spanPoints(pts[k - 1], pts[k]);
      const span = [];
      for (let j = 1; j < p.length; j++) if (outside(p[j - 1], p[j])) span.push(...p[j - 1], ...p[j]);
      if (span.length) wireAll.push({ a: pts[k - 1], b: pts[k], span });
    }
  }
  const wirePositions = () => wireAll.flatMap(w => w.span);
  const wirePos = wirePositions();
  let wires = null;
  if (wirePos.length) {
    const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.Float32BufferAttribute(wirePos, 3));
    wires = new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: '#221d18', transparent: true, opacity: 0.6 }));
    wires.name = 'context-wires'; props3d.add(wires);
  }
  // Anthropogenic: the same supports as glyphs (built on first use)
  let glyphs = null;
  function ensureGlyphs(P, C, anisotropy) {
    if (glyphs || !sup.length) return glyphs;
    const points = supXY.map(o => ({ kind: o.kind === 'pole' ? 'pole' : 'pylon', x: o.X, y: o.Y, hMm: o.height * C.glyphScale * mmPerM }));
    const lines = (context.power?.lines || []).map(Ln => Ln.xy.map(([x, y]) => [x * mmPerM, y * mmPerM]));
    const pa = i => [points[i].x, points[i].y];
    const w = glyphWires(points, lines, Math.max(0.05, 2 * mmPerM))
      .filter(([a, b]) => outside(pa(a), pa(b)));
    glyphs = createGlyphs({ points, wires: w, zAt, ink: P.ink, C, anisotropy });
    glyphs.group.name = 'context-glyphs';
    root.add(glyphs.group);
    return glyphs;
  }

  // ---- labels: place and landuse names, in the pit labels' style ----
  const labelGroup = new THREE.Group(); labelGroup.name = 'context-labels'; root.add(labelGroup);
  let labelsOn = false, landShown = true;     // the Labels layer; Landscape Context shown
  const threadMat = new THREE.LineBasicMaterial({ color: '#15110e', transparent: true, opacity: 0.6, fog: false });
  const labels = names.map(n => {
    const note = NAME_NOTES[n.kind] || n.kind;
    const c0 = document.createElement('canvas').getContext('2d');
    c0.font = `bold 44px ${FONT}`; const w1 = c0.measureText(n.name).width; c0.font = `30px ${FONT}`; const w2 = c0.measureText(note).width;
    const cv = document.createElement('canvas'); cv.width = Math.ceil(Math.max(w1, w2)) + 40; cv.height = 112;
    const c = cv.getContext('2d');
    c.fillStyle = PALE; c.fillRect(0, 0, cv.width, cv.height);
    c.strokeStyle = '#15110e'; c.lineWidth = 5; c.strokeRect(2.5, 2.5, cv.width - 5, cv.height - 5);
    c.fillStyle = '#15110e'; c.font = `bold 44px ${FONT}`; c.fillText(n.name, 20, 50);
    c.fillStyle = '#5a5248'; c.font = `30px ${FONT}`; c.fillText(note, 20, 92);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, depthWrite: false, sizeAttenuation: false, fog: false }));
    sp.center.set(0.5, 0); sp.renderOrder = 10;
    const z0 = zAt(n.x, n.y), lift = 6;
    sp.position.set(n.x, n.y, z0 + lift);
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute([n.x, n.y, z0, n.x, n.y, z0 + lift], 3));
    const thread = new THREE.LineSegments(lg, threadMat); thread.renderOrder = 9;
    labelGroup.add(thread, sp);
    return { n, sp, thread, aspect: cv.width / cv.height, rank: NAME_RANK[n.kind] ?? 5 };
  });
  // Screen layout: hide labels that would overlap one another or the model
  // (the model's eight box corners, projected), or fall off screen.
  const v4 = new THREE.Vector4(), M = new THREE.Matrix4();
  let lastKey = '', lastItems = null;
  function layout(camera, size, frame, H) {
    if (!labelGroup.visible || !labels.length) return;
    frame.updateMatrixWorld(true); camera.updateMatrixWorld();
    const key = [...camera.matrixWorld.elements, ...camera.projectionMatrix.elements, ...frame.matrixWorld.elements, size.x, size.y].map(n => n.toFixed(4)).join();
    if (key === lastKey) return; lastKey = key;
    const W = size.x, Hs = size.y;
    M.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(frame.matrixWorld);
    const scr = (x, y, zz) => { v4.set(x, y, zz, 1).applyMatrix4(M); return [(v4.x / v4.w + 1) / 2 * W, (1 - v4.y / v4.w) / 2 * Hs, v4.w]; };
    const hull = convexHull([0, Wmm].flatMap(x => [0, Hmm].flatMap(y => [0, H].map(zz => scr(x, y, zz)))).filter(p => p[2] > 0));
    const P11 = camera.projectionMatrix.elements[5], sy = LABEL_PX * 2 / (P11 * Hs);
    const items = labels.map(L => {
      const [x, y, w] = scr(L.sp.position.x, L.sp.position.y, L.sp.position.z), wpx = LABEL_PX * L.aspect;
      const box = [[x - wpx / 2, y - LABEL_PX], [x + wpx / 2, y - LABEL_PX], [x - wpx / 2, y], [x + wpx / 2, y]];
      const ok = w > 0 && x > wpx / 2 && x < W - wpx / 2 && y > LABEL_PX && y < Hs && !box.some(p => inHull(hull, p)) && !inHull(hull, [x, y + 0.01]);
      return { x, y, w: wpx, h: LABEL_PX, rank: L.rank, ok };
    });
    const keep = cullLabels(items); lastItems = items;
    labels.forEach((L, i) => { L.sp.visible = L.thread.visible = keep[i]; L.sp.scale.set(sy * L.aspect, sy, 1); });
  }

  // ---- looks ----
  // def: { lit, glyphs }; P: the palette; C: its carto palette (Anthropogenic) or null.
  // parts: { land, energy }: Landscape Context (the land, routes, water, buildings
  // and names) and Energy Context (pylons, poles and lines, 3D or glyphs).
  function setLook(look, { P, C = null, lit = true, useGlyphs = false, bgHex, drapeW, anisotropy = 8, show = {}, parts = { land: true, energy: true }, edge = null }) {
    const land = parts.land !== false, energy = parts.energy !== false, bare = !land && energy;
    // bare (Energy Context alone): a flat, unlit surface in the background colour,
    // so only the model's edge fade shows, not the shape of the land
    mesh.material = material(look, lit && !bare);
    mesh.visible = land || bare; labelGroup.visible = land && labelsOn; landShown = land;
    floor.material = mesh.material; showFloor();
    // power lines painted on the land belong to the Energy Context
    const stats = land || bare ? paint({ P, carto: useGlyphs ? C : null, bgHex, drapeW, show: { ...show, power: energy && show.power !== false }, edge, bare }) : null;
    border.material.color.set(P.ink);
    if (!supMats[look]) supMats[look] = new THREE.MeshToonMaterial({ color: P.props?.pylon || '#5a5a55', gradientMap: ramp?.() });
    for (const im of [towers, poles]) if (im) im.material = supMats[look];
    if (wires) wires.material.color.set(P.ink);
    props3d.visible = energy && !useGlyphs && show.power !== false;
    if (useGlyphs && energy) ensureGlyphs(P, C, anisotropy);
    if (glyphs) glyphs.group.visible = energy && useGlyphs && show.power !== false;
    lastKey = '';
    return stats;
  }
  function setVisible(on) { root.visible = !!on; lastKey = ''; }
  // The place and landuse name labels on or off (the Labels layer).
  function setLabels(on) { labelsOn = !!on; labelGroup.visible = landShown && labelsOn; lastKey = ''; }
  function dispose() {
    root.traverse(o => { o.geometry?.dispose(); if (o.material && o.isSprite) { o.material.map?.dispose(); o.material.dispose(); } });
    for (const mt of [...Object.values(mats), ...Object.values(supMats), border.material, threadMat, wires?.material]) mt?.dispose();
    tex.dispose(); glyphs?.dispose(); root.removeFromParent();
  }
  const stats = {
    triangles: m.stats.triangles, vertices: m.stats.vertices, clampedVertices: m.stats.clamped, edgeVertices: m.stats.edgeVertices,
    decodeMs: Math.round(decodeMs * 10) / 10, buildMs: Math.round(performance.now() - t0),
    supports: sup.length, wireSegments: wirePos.length / 6, labels: labels.length, features: Object.fromEntries(Object.entries(V).map(([k, a]) => [k, a.length])),
  };
  const inkHide = [labelGroup, ...(wires ? [wires] : [])];
  return { root, mesh, border, inkHide, setLook, setVisible, setFloor, setLabels, setEdge, layout, dispose, stats, zAt,
    get glyphs() { return glyphs; }, get layoutItems() { return lastItems; }, pad_m: context.pad_m, source: E.source, attribution: E.attribution, osmAttribution: context.osm?.attribution,
    offset_m: E.offset_m, names: labels.map(L => L.n.name) };
}

// Anthropogenic's routes (as paintCarto step 6), on the drape-framed context.
function paintCartoRoutes(g, V, { Wmm, Hmm, drapeW, C, ink, show }) {
  const k = drapeW / Wmm, Hd = drapeW * Hmm / Wmm, s = drapeW / C.drapePx;
  const X = x => x * k, Y = y => Hd - y * k;
  const linePath = p => { for (let i = 0; i < p.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, X(p[i]), Y(p[i + 1])); };
  g.lineCap = g.lineJoin = 'round';
  const major = /^(motorway|trunk|primary|secondary)/;
  if (show.roads !== false) for (const pass of [0, 1]) for (const r of V.roads) {
    const big = major.test(r.k || ''); g.beginPath(); linePath(r.p);
    g.strokeStyle = pass ? C.roadFill : ink; g.lineWidth = (pass ? C.roadWidth : C.roadCasing)[big ? 0 : 1] * s; g.stroke();
  }
  if (show.rail !== false) {
    g.save(); g.setLineDash(C.rail.map(v => v * s)); g.strokeStyle = ink; g.lineWidth = C.railWidth * s; g.lineCap = 'butt';
    for (const r of V.rail) { g.beginPath(); linePath(r.p); g.stroke(); }
    g.globalAlpha = 0.55; for (const r of V.railDisused) { g.beginPath(); linePath(r.p); g.stroke(); }
    g.restore();
  }
}

// Convex hull (monotone chain) of screen points; inHull: point in it.
function convexHull(pts) {
  const p = pts.map(q => [q[0], q[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}
function inHull(h, [x, y]) {
  if (h.length < 3) return false;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    if ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) < 0) return false;
  }
  return true;
}
