// The shared Three.js scene. This is the one place the model's look is
// defined: the app preview, the standalone viewer and (Phase 4) every
// rendered artefact use it, so styling is identical everywhere.
//
// Lighting and materials follow JC's Mossmorran viewer: room environment,
// hemisphere fill, a warm soft-shadow sun from the south-west, soil strata
// on the sides, clearcoat water, and a shadow-catcher ground.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/RoomEnvironment.js';

export const LANDCOVER_COLOURS = {
  'landuse:farmland': '#C9C08A', 'landuse:meadow': '#B5C98A', 'landuse:grass': '#B5C98A',
  'landuse:forest': '#6E8B5A', 'natural:wood': '#6E8B5A', 'natural:scrub': '#8FA06A',
  'natural:heath': '#A8937A', 'natural:moor': '#A8937A', 'natural:grassland': '#B5C98A',
  'natural:wetland': '#94A9A0', 'landuse:residential': '#CFC6B8', 'landuse:farmyard': '#C2B49A',
  'landuse:cemetery': '#A9B898', 'landuse:allotments': '#B9C08A', 'landuse:recreation_ground': '#B5C98A',
  'landuse:commercial': '#C8BFC0', 'landuse:retail': '#C8BFC0', 'landuse:railway': '#BDB5AA',
  'natural:bare_rock': '#B3ADA4', 'natural:scree': '#B3ADA4',
};
const LAND_BASE = '#BDB08E';

export function createScene(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);
  renderer.domElement.setAttribute('role', 'img');

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.35;
  scene.background = gradient([[0, '#7fa6c9'], [0.55, '#c9d9e4'], [1, '#e9e4da']]);

  const camera = new THREE.PerspectiveCamera(28, 1, 0.5, 5000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.autoRotateSpeed = 0.8;

  const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x5a4a35, 1.0);
  const sun = new THREE.DirectionalLight(0xfff1dc, 3.0);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.04;
  scene.add(hemi, sun, sun.target);

  const model = new THREE.Group();
  model.rotation.x = -Math.PI / 2;            // model z-up (mm) -> three y-up
  const inner = new THREE.Group();
  model.add(inner);
  scene.add(model);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.28 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
  scene.add(ground);

  const meshes = {};
  let span = 150, H = 20;

  function resize() {
    const w = container.clientWidth || 600, h = container.clientHeight || 400;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);
  resize();

  function setSun(azDeg = 225, elDeg = 32) {
    const az = THREE.MathUtils.degToRad(azDeg), el = THREE.MathUtils.degToRad(elDeg), r = span * 2.5;
    sun.position.set(Math.sin(az) * Math.cos(el) * r, Math.sin(el) * r, -Math.cos(az) * Math.cos(el) * r);
    const sc = sun.shadow.camera;
    sc.left = sc.bottom = -span * 0.75; sc.right = sc.top = span * 0.75; sc.near = 1; sc.far = span * 6;
    sc.updateProjectionMatrix();
  }

  function geometry(m) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    g.setIndex(new THREE.BufferAttribute(m.indices, 1));
    g.computeVertexNormals();
    return g;
  }

  // layers: {id: mesh}; colours: {id: '#rrggbb'}; landcover: canvas or null
  function setModel({ layers, insert, colours, landcover, grid }) {
    for (const k of Object.keys(meshes)) { inner.remove(meshes[k]); meshes[k].geometry.dispose(); delete meshes[k]; }
    span = Math.max(grid.Wmm, grid.Hmm);
    let zmax = 0;
    for (const [id, m] of Object.entries({ ...layers, ...(insert ? { site: insert } : {}) })) {
      if (!m || !m.indices.length) continue;
      const g = geometry(m);
      let mat;
      if (id === 'terrain') {
        // Top and bottom take the land-cover drape; the sides are split off
        // into their own geometry with soil strata, as in the Mossmorran viewer.
        const { capsIdx, walls } = splitWalls(m);
        g.setIndex(new THREE.BufferAttribute(capsIdx, 1));
        g.setAttribute('uv', planarUV(m.positions, grid));
        mat = new THREE.MeshStandardMaterial({ map: landcover ? canvasTexture(landcover, renderer) : null,
          color: landcover ? 0xffffff : LAND_BASE, roughness: 0.92 });
        const side = new THREE.Mesh(walls, new THREE.MeshStandardMaterial({ map: strataTexture(renderer), roughness: 0.96 }));
        side.castShadow = side.receiveShadow = true; side.name = 'terrain-sides';
        inner.add(side); meshes['terrain-sides'] = side;
      } else if (id === 'water') {
        mat = new THREE.MeshPhysicalMaterial({ color: 0x24506a, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1.6 });
      } else if (id === 'site') {
        mat = new THREE.MeshStandardMaterial({ color: colours.site || '#D55E00', roughness: 0.5, transparent: true, opacity: 0.88 });
      } else {
        mat = new THREE.MeshStandardMaterial({ color: colours[id] || colours[id.replace('Disused', '')] || '#cccccc', roughness: 0.8 });
      }
      const mesh = new THREE.Mesh(g, mat);
      mesh.castShadow = id !== 'water'; mesh.receiveShadow = true;
      mesh.name = id;
      inner.add(mesh); meshes[id] = mesh;
      for (let k = 2; k < m.positions.length; k += 3) zmax = Math.max(zmax, m.positions[k]);
    }
    H = zmax;
    inner.position.set(-grid.Wmm / 2, -grid.Hmm / 2, 0);
    ground.scale.set(span * 8, span * 8, 1);
    setSun();
    setView('oblique', false);
  }

  function setVisible(id, on) {
    for (const k of [id, `${id}Disused`, `${id}-sides`]) if (meshes[k]) meshes[k].visible = on;
  }

  function setView(name, animate = true) {
    const d = span * 1.95;
    const views = { oblique: [0.55, 0.62, 0.85], reverse: [-0.55, 0.62, -0.85], low: [0.25, 0.18, 1.0], top: [0, 1, 0.0001] };
    const v = new THREE.Vector3(...(views[name] || views.oblique)).normalize().multiplyScalar(d);
    const target = new THREE.Vector3(0, H * 0.3, 0);
    if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      camera.position.copy(v); controls.target.copy(target); controls.update(); return;
    }
    const p0 = camera.position.clone(), t0 = controls.target.clone(), s = performance.now();
    (function step() {
      const k = Math.min((performance.now() - s) / 700, 1), e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      camera.position.lerpVectors(p0, v, e); controls.target.lerpVectors(t0, target, e); controls.update();
      if (k < 1) requestAnimationFrame(step);
    })();
  }

  function setSpin(on) { controls.autoRotate = on; }

  renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
  return { renderer, scene, camera, controls, setModel, setVisible, setView, setSpin, setSun, meshes };
}

// Separate wall triangles (|normal z| small) from the top/bottom caps.
function splitWalls({ positions: P, indices: I }) {
  const caps = [], wallPos = [], wallUV = [];
  let zmax = 0;
  for (let k = 2; k < P.length; k += 3) zmax = Math.max(zmax, P[k]);
  for (let t = 0; t < I.length; t += 3) {
    const a = 3 * I[t], b = 3 * I[t + 1], c = 3 * I[t + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1];
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nz, (P[b + 1] - P[a + 1]) * (P[c + 2] - P[a + 2]) - (P[b + 2] - P[a + 2]) * (P[c + 1] - P[a + 1]),
      (P[b + 2] - P[a + 2]) * (P[c] - P[a]) - (P[b] - P[a]) * (P[c + 2] - P[a + 2])) || 1;
    if (Math.abs(nz / len) > 0.2) { caps.push(I[t], I[t + 1], I[t + 2]); continue; }
    for (const v of [a, b, c]) {
      wallPos.push(P[v], P[v + 1], P[v + 2]);
      // u runs along the edge of the model; v is height
      wallUV.push((P[v] + P[v + 1]) / 60, Math.min(P[v + 2] / zmax, 1));
    }
  }
  const walls = new THREE.BufferGeometry();
  walls.setAttribute('position', new THREE.Float32BufferAttribute(wallPos, 3));
  walls.setAttribute('uv', new THREE.Float32BufferAttribute(wallUV, 2));
  walls.computeVertexNormals();
  return { capsIdx: new Uint32Array(caps), walls };
}

// Soil strata for the sides (from the Mossmorran viewer): irregular bands
// by height, a little grain, and a dark turf line at the surface.
function strataTexture(renderer) {
  const W = 1024, Hh = 512, c = document.createElement('canvas'); c.width = W; c.height = Hh;
  const g = c.getContext('2d');
  const layers = [[0.00, '#3b2f26'], [0.10, '#5a4a3a'], [0.24, '#8a7356'], [0.33, '#6f5a43'],
    [0.45, '#a58a63'], [0.55, '#7d6449'], [0.68, '#5d4a37'], [0.82, '#4a3b2b'], [0.93, '#3a2e1f']];
  for (let x = 0; x < W; x += 2) for (let i = 0; i < layers.length; i++) {
    const wob = k => Math.sin(x * 0.013 + k * 3.1) * 0.012 + Math.sin(x * 0.051 + k * 1.7) * 0.006;
    const y0 = layers[i][0] + (i ? wob(i) : 0), y1 = i + 1 < layers.length ? layers[i + 1][0] + wob(i + 1) : 1;
    g.fillStyle = layers[i][1]; g.fillRect(x, Hh - y1 * Hh, 2, (y1 - y0) * Hh + 1);
  }
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let k = 0; k < 9000; k++) {
    const s = rnd() * 2.2 + 0.4; g.fillStyle = rnd() < 0.5 ? 'rgba(255,240,215,0.10)' : 'rgba(0,0,0,0.14)';
    g.fillRect(rnd() * W, rnd() * Hh, s, s * 0.7);
  }
  const tg = g.createLinearGradient(0, 0, 0, Hh * 0.06); tg.addColorStop(0, '#2f3a1c'); tg.addColorStop(1, 'rgba(47,42,28,0)');
  g.fillStyle = tg; g.fillRect(0, 0, W, Hh * 0.06);
  const t = canvasTexture(c, renderer); t.wrapS = THREE.RepeatWrapping; return t;
}

function planarUV(P, grid) {
  const uv = new Float32Array(P.length / 3 * 2);
  for (let i = 0, j = 0; i < P.length; i += 3, j += 2) { uv[j] = P[i] / grid.Wmm; uv[j + 1] = P[i + 1] / grid.Hmm; }
  return new THREE.BufferAttribute(uv, 2);
}

function canvasTexture(c, renderer) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}

function gradient(stops) {
  const c = document.createElement('canvas'); c.width = 4; c.height = 512;
  const g = c.getContext('2d'), lg = g.createLinearGradient(0, 0, 0, 512);
  stops.forEach(([o, col]) => lg.addColorStop(o, col)); g.fillStyle = lg; g.fillRect(0, 0, 4, 512);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// Land-cover colours drawn to a canvas the shape of the model (north up).
export function landcoverCanvas(grid, features, widthPx = 2048) {
  const c = document.createElement('canvas');
  c.width = widthPx; c.height = Math.round(widthPx * grid.Hmm / grid.Wmm);
  const g = c.getContext('2d');
  g.fillStyle = LAND_BASE; g.fillRect(0, 0, c.width, c.height);
  const k = c.width / grid.Wmm;
  g.setTransform(k, 0, 0, -k, 0, c.height);
  const order = ['landuse:residential', 'landuse:farmland', 'landuse:meadow', 'landuse:grass'];
  const fs = features.filter(f => f.layer === 'landcover' && LANDCOVER_COLOURS[f.kind])
    .sort((a, b) => order.indexOf(b.kind) - order.indexOf(a.kind));
  for (const f of fs) {
    g.fillStyle = LANDCOVER_COLOURS[f.kind];
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [];
    for (const rings of polys) {
      g.beginPath();
      for (const r of rings) r.forEach(([lon, lat], i) => { const [x, y] = grid.mm(lon, lat); i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.fill('evenodd');
    }
  }
  return c;
}
