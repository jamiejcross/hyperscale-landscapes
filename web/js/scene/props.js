// 3D symbols on the model (trees brief, Stage 6): trees from the canopy
// height model, wind turbines, pylons and poles, and the power lines between
// them. Screen only: print files never include these.
//
// Trees are instanced archetypes (unit height, z up, 60–150 triangles each),
// drawn at measured height x the tree height factor (default: the model's
// terrain exaggeration), with crown width from the data. Turbines and pylons
// are drawn at true height, like buildings. Everything sits on the model's own
// height grid, so it lands exactly on the displayed terrain.
import * as THREE from 'three';
import { decodeTrees } from '../data/props.js';
import { PALETTES } from './palettes.js';
import { heightSampler, yawForBearing, spanPoints, clipSegment, rng, drawTrunk } from './props-math.js';

const TRUNK = '#5b4636';
export const PROP_INK_IDS = { trees: 13, turbines: 14, pylons: 14 };

// ---- unit geometries (base at z = 0, height 1) ----
const zUp = g => { g.rotateX(Math.PI / 2); return g; };
const cyl = (rt, rb, h, z, seg = 6) => zUp(new THREE.CylinderGeometry(rt, rb, h, seg)).translate(0, 0, z + h / 2);
const cone = (r, h, z, seg = 7) => zUp(new THREE.ConeGeometry(r, h, seg)).translate(0, 0, z + h / 2);
const blob = (r, sx, sy, sz, z, detail = 0) => new THREE.IcosahedronGeometry(r, detail).scale(sx, sy, sz).translate(0, 0, z);
const box = (w, d, h, z) => new THREE.BoxGeometry(w, d, h).translate(0, 0, z);
function merge(geoms) {
  const pos = [], nor = [];
  for (const g0 of geoms) {
    const g = g0.index ? g0.toNonIndexed() : g0;
    g.computeVertexNormals();
    pos.push(...g.attributes.position.array); nor.push(...g.attributes.normal.array);
    if (g !== g0) g.dispose();
    g0.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return out;
}

// Pylon and pole at unit height (base at z = 0), shared with the context apron.
export function supportGeometries() {
  return { tower: merge([cyl(0.03, 0.12, 1, 0, 4), box(0.5, 0.02, 0.02, 0.62), box(0.62, 0.02, 0.02, 0.78), box(0.42, 0.02, 0.02, 0.93)]),
           pole: merge([cyl(0.012, 0.016, 1, 0, 5), box(0.2, 0.015, 0.015, 0.93)]) };
}

// Archetypes: parts as [geometry, colour role]; unitR = crown radius at unit scale.
// Order matches trees.ARCHETYPES in the pipeline (bundle codes 0..4).
const ARCHETYPES = {
  broadleaf: { unitR: 0.40, parts: () => [[cyl(0.05, 0.07, 0.45, 0), 'trunk'], [blob(0.36, 1.12, 1.05, 0.8, 0.66, 1), 'crown']] },
  spruce: { unitR: 0.20, parts: () => [[cyl(0.03, 0.04, 0.2, 0), 'trunk'], [cone(0.2, 0.86, 0.14), 'crown']] },
  scots_pine: { unitR: 0.33, parts: () => [[cyl(0.03, 0.045, 0.72, 0), 'trunk'], [blob(0.3, 1.1, 0.9, 0.42, 0.82), 'crown'], [blob(0.18, 1, 1, 0.5, 0.72), 'crown2']] },
  birch: { unitR: 0.20, parts: () => [[cyl(0.022, 0.03, 0.6, 0), 'trunk'], [blob(0.2, 1, 1, 1.6, 0.66, 1), 'crown']] },
  young: { unitR: 0.30, parts: () => [[cyl(0.03, 0.04, 0.15, 0), 'trunk'], [cone(0.3, 0.85, 0.15), 'crown']] },
};
function partColour(P, arch, role) {
  const p = P.props[arch] || P.props.broadleaf;
  if (role === 'trunk') return p.trunk || TRUNK;
  const c = (arch === 'young' ? P.props.broadleaf.crown : p.crown);
  return Array.isArray(c) ? c[role === 'crown2' ? 1 : 0] : c;
}

// props: the bundle's props section; heights: buildModel's height grid (mm);
// grid: model grid; zExag: the model's terrain exaggeration.
export function createProps({ props, grid, heights, zExag = 2, seed = 1, ramp }) {
  const group = new THREE.Group(); group.name = 'props';
  const mmPerM = grid.mmPerM, zAt = heightSampler(grid, heights);
  const parts = { trees: [], turbines: [], pylons: [], lines: [] };
  const mats = {};                    // look -> { inst, turbine, pylon }
  let look = 'guthrie', treeFactor = zExag, rotorPhase = 0, treeMask = null;   // treeMask(x, y): hide a tree there
  const T = decodeTrees(props);

  // ---- trees ----
  const treeMeshes = [];             // { mesh, arch, role, idx: [tree indices] }
  if (T) {
    const names = T.archetypes;
    for (const [ai, arch] of names.entries()) {
      const A = ARCHETYPES[arch]; if (!A) continue;
      const all = []; for (let i = 0; i < T.count; i++) if (T.archetype[i] === ai) all.push(i);
      if (!all.length) continue;
      for (const [geom, role] of A.parts()) {
        const idx = role === 'trunk' ? all.filter(i => drawTrunk(T.count, T.h[i])) : all;
        if (!idx.length) { geom.dispose(); continue; }
        const g = role === 'trunk' ? geom : geom;
        const mesh = new THREE.InstancedMesh(g, null, idx.length);
        mesh.userData = { inkId: PROP_INK_IDS.trees, propKind: 'trees' };
        mesh.castShadow = mesh.receiveShadow = true; mesh.name = `tree-${arch}-${role}`;
        treeMeshes.push({ mesh, arch, role, idx, unitR: A.unitR });
        group.add(mesh); parts.trees.push(mesh);
      }
    }
  }
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), s = new THREE.Vector3(), Z = new THREE.Vector3(0, 0, 1);
  function placeTrees() {
    const r = rng(seed);
    const yaw = T ? Float32Array.from({ length: T.count }, () => r() * Math.PI * 2) : null;
    for (const t of treeMeshes) {
      t.idx.forEach((i, k) => {
        const x = T.x[i] * mmPerM, y = T.y[i] * mmPerM, hz = T.h[i] * mmPerM * treeFactor;
        const sxy = Math.max(1, T.crownR[i]) * mmPerM / t.unitR;
        q.setFromAxisAngle(Z, yaw[i]);
        const hide = treeMask?.(x, y);
        m4.compose(v.set(x, y, zAt(x, y) - 0.05), q, hide ? s.set(0, 0, 0) : s.set(sxy, sxy, hz));
        t.mesh.setMatrixAt(k, m4);
      });
      t.mesh.instanceMatrix.needsUpdate = true;
      t.mesh.computeBoundingSphere();
    }
  }
  function colourTrees() {
    const P = PALETTES[look] || PALETTES.field, col = new THREE.Color();
    for (const t of treeMeshes) {
      const r = rng(seed ^ (t.arch.length * 7919) ^ (t.role.length * 104729));
      const base = new THREE.Color(partColour(P, t.arch, t.role));
      t.idx.forEach((i, k) => { col.copy(base).offsetHSL(0, 0, (r() - 0.5) * 0.06); t.mesh.setColorAt(k, col); });
      t.mesh.instanceColor.needsUpdate = true;
    }
  }

  // ---- wind turbines (true height) ----
  const rotors = [];
  for (const [n, tb] of (props?.turbines || []).entries()) {
    const x = tb.x * mmPerM, y = tb.y * mmPerM, hub = tb.hub_height * mmPerM, R = tb.rotor_diameter / 2 * mmPerM;
    const T0 = new THREE.Group(); T0.position.set(x, y, zAt(x, y)); T0.name = 'turbine';
    const tower = new THREE.Mesh(cyl(hub * 0.012, hub * 0.026, hub, 0, 12));
    const nac = new THREE.Mesh(box(hub * 0.05, hub * 0.12, hub * 0.045, 0)); nac.position.set(0, -hub * 0.02, hub + hub * 0.01);
    const rotor = new THREE.Group(); rotor.position.set(0, hub * 0.045, hub + hub * 0.01);
    const blades = [new THREE.SphereGeometry(hub * 0.028, 10, 8)];
    for (let k = 0; k < 3; k++) {
      const sh = new THREE.Shape(), w = R * 0.07;
      sh.moveTo(0, 0); sh.lineTo(w, R * 0.15); sh.lineTo(w * 0.35, R); sh.lineTo(-w * 0.15, R); sh.lineTo(-w * 0.5, R * 0.12); sh.lineTo(0, 0);
      const bg = new THREE.ExtrudeGeometry(sh, { depth: R * 0.012, bevelEnabled: false });
      bg.rotateX(Math.PI / 2);                  // blade in the x-z plane: the rotor disc faces +y
      bg.rotateY(k * 2 * Math.PI / 3);
      blades.push(bg);
    }
    const rot = new THREE.Mesh(merge(blades)); rotor.add(rot);
    T0.add(tower, nac, rotor);
    // the hub faces the wind: the rotor's normal (+y) points to the bearing the wind comes from
    T0.rotation.z = yawForBearing(tb.facing ?? 225);
    for (const m of [tower, nac, rot]) { m.userData = { inkId: PROP_INK_IDS.turbines, propKind: 'turbines' }; m.castShadow = m.receiveShadow = true; parts.turbines.push(m); }
    rotors.push({ rotor, phase: n * 0.7 });
    group.add(T0);
  }
  function setRotor(phase) { rotorPhase = phase; for (const r of rotors) r.rotor.rotation.y = r.phase + phase; }

  // ---- pylons, poles (true height), and lines ----
  const sup = props?.supports || [];
  const { tower: towerGeo, pole: poleGeo } = supportGeometries();
  const onPlate = o => o.x >= 0 && o.y >= 0 && o.x * mmPerM <= grid.Wmm && o.y * mmPerM <= grid.Hmm;
  const towers = sup.filter(o => o.kind !== 'pole' && onPlate(o)), poles = sup.filter(o => o.kind === 'pole' && onPlate(o));
  const supportMesh = (geo, list, name) => {
    if (!list.length) { geo.dispose(); return null; }
    const mesh = new THREE.InstancedMesh(geo, null, list.length);
    list.forEach((o, i) => {
      const x = o.x * mmPerM, y = o.y * mmPerM, h = o.height * mmPerM;
      q.setFromAxisAngle(Z, yawForBearing(o.bearing ?? 0));
      mesh.setMatrixAt(i, m4.compose(v.set(x, y, zAt(x, y) - 0.05), q, s.set(h, h, h)));
    });
    mesh.computeBoundingSphere();
    mesh.userData = { inkId: PROP_INK_IDS.pylons, propKind: 'pylons' }; mesh.name = name;
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh); parts.pylons.push(mesh);
    return mesh;
  };
  supportMesh(towerGeo, towers, 'pylons'); supportMesh(poleGeo, poles, 'poles');
  // Lines: from support top to support top along each OSM line (2% sag); a
  // vertex with no support is held 10 m above the ground.
  const at = new Map(sup.map(o => [`${Math.round(o.x * 2)},${Math.round(o.y * 2)}`, o]));
  const linePos = [];
  for (const L of props?.lines || []) {
    const pts = L.xy.map(([xm, ym]) => {
      const o = at.get(`${Math.round(xm * 2)},${Math.round(ym * 2)}`), x = xm * mmPerM, y = ym * mmPerM;
      return [x, y, zAt(x, y) + (o ? o.height * 0.9 : 10) * mmPerM];
    });
    for (let k = 1; k < pts.length; k++) {
      const p = spanPoints(pts[k - 1], pts[k]);
      for (let j = 1; j < p.length; j++) { const c = clipSegment(p[j - 1], p[j], grid.Wmm, grid.Hmm); if (c) linePos.push(...c[0], ...c[1]); }
    }
  }
  let lines = null;
  if (linePos.length) {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(linePos, 3));
    lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: '#221d18', transparent: true, opacity: 0.85 }));
    lines.name = 'power-lines'; lines.userData = { propKind: 'pylons' };
    group.add(lines); parts.lines.push(lines);
  }

  // ---- looks ----
  function materialsFor(lk) {
    if (!mats[lk]) {
      const P = PALETTES[lk] || PALETTES.field;
      const make = c => new THREE.MeshToonMaterial({ color: c, gradientMap: ramp?.() });
      mats[lk] = { inst: make(0xffffff), turbine: make(P.props.turbine), pylon: make(P.props.pylon), ink: P.ink || '#221d18' };
    }
    return mats[lk];
  }
  function setLook(lk) {
    look = lk;
    const M = materialsFor(lk);
    for (const m of parts.trees) m.material = M.inst;
    for (const m of parts.turbines) m.material = M.turbine;
    for (const m of parts.pylons) m.material = M.pylon;
    if (lines) lines.material.color.set(M.ink);
    colourTrees();
  }
  function setTreeFactor(k) { treeFactor = k; placeTrees(); }
  // Hide the trees where fn(x, y) is true (print mm), e.g. inside proposed buildings; null shows all.
  function setTreeMask(fn) { treeMask = fn || null; placeTrees(); }
  function setVisible(kind, on) { for (const m of parts[kind] || []) m.visible = on; if (kind === 'turbines') for (const r of rotors) r.rotor.parent.visible = on; }
  function dispose() {
    group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    for (const M of Object.values(mats)) for (const m of [M.inst, M.turbine, M.pylon]) m.dispose();
    lines?.material.dispose();
    group.removeFromParent();
  }
  placeTrees(); setLook(look); setRotor(0);
  const counts = { trees: T?.count || 0, turbines: rotors.length, towers: towers.length, poles: poles.length, lineSegments: linePos.length / 6 };
  return { group, parts, lines, counts, setLook, setTreeFactor, setTreeMask, setRotor, setVisible, dispose,
    get rotorPhase() { return rotorPhase; }, get treeFactor() { return treeFactor; } };
}
