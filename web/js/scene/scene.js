// The shared Three.js scene. This is the one place the model's look is
// defined: the app preview, the standalone viewer and (Phase 4) every
// rendered artefact use it, so styling is identical everywhere.
//
// Two looks share the same geometry, switched by setLook() without a rebuild:
//   mossmorran (default) follows JC's Mossmorran viewer: room environment,
//     hemisphere fill, a warm soft-shadow sun from the south-west, soil strata
//     on the sides, clearcoat water, and a shadow-catcher ground.
//   field: a flat-shaded diorama on white (presentation only: print files,
//     sections and every factual layer are unchanged).
// Each mesh keeps one material per look, made the first time that look is
// shown and disposed with the model.
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
export const LOOKS = { mossmorran: 'Mossmorran', field: 'Field' };

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
  const roomEnv = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = roomEnv;
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

  const view = { az: 225, el: 32, strength: 3.0, fill: 1.0, heightScale: 1, fov: 28, background: 'sky', print: false, look: 'mossmorran' };

  // Sun: azimuth clockwise from north, height above the horizon; it warms
  // towards orange as it drops (as in the Mossmorran viewer).
  function setSun(azDeg = view.az, elDeg = view.el, strength = view.strength, fill = view.fill) {
    Object.assign(view, { az: azDeg, el: elDeg, strength, fill });
    const az = THREE.MathUtils.degToRad(azDeg), el = THREE.MathUtils.degToRad(elDeg), r = span * 2.5;
    sun.position.set(Math.sin(az) * Math.cos(el) * r, Math.sin(el) * r, -Math.cos(az) * Math.cos(el) * r);
    sun.intensity = strength; hemi.intensity = fill;
    const warm = THREE.MathUtils.clamp((elDeg - 3) / 30, 0, 1);
    if (view.look === 'field') sun.color.set(0xffffff);      // field: neutral light, the colours are in the materials
    else sun.color.setRGB(1, 0.78 + 0.18 * warm, 0.58 + 0.33 * warm);
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

  // ---- Materials, one set per look ----
  let drapeTex = null;           // the land-cover or satellite drape, shared by both looks
  const MAKE = {
    mossmorran(mesh) {
      const { kind, colour } = mesh.userData;
      if (kind === 'terrain') return new THREE.MeshStandardMaterial({ map: drapeTex, color: drapeTex ? 0xffffff : LAND_BASE, roughness: 0.92 });
      if (kind === 'terrain-sides') return new THREE.MeshStandardMaterial({ map: strataTexture(renderer), roughness: 0.96 });
      if (kind === 'water') return new THREE.MeshPhysicalMaterial({ color: 0x24506a, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1.6 });
      return new THREE.MeshStandardMaterial({ color: colour, roughness: 0.8 });
    },
    // Field, first pass (step 1): flat Lambert stand-ins; toon shading,
    // shaded slab walls and the ink pass replace these in the next steps.
    field(mesh) {
      const { kind, colour } = mesh.userData;
      if (kind === 'terrain') return new THREE.MeshLambertMaterial({ map: drapeTex, color: drapeTex ? 0xffffff : LAND_BASE });
      if (kind === 'terrain-sides') return new THREE.MeshLambertMaterial({ color: 0xf4f2ee });
      if (kind === 'water') return new THREE.MeshLambertMaterial({ color: 0x7fbcc4, transparent: true, opacity: 0.5 });
      return new THREE.MeshLambertMaterial({ color: colour });
    },
  };
  function lookMaterial(mesh, look = view.look) {
    const L = mesh.userData.looks;
    if (!L[look]) {
      L[look] = MAKE[look](mesh);
      if (mesh.userData.override.color) L[look].color.set(mesh.userData.override.color);   // screen recolouring
    }
    return L[look];
  }
  // What a mesh shows: its print colour when print colours are on, else its look.
  function applyMaterial(mesh) {
    mesh.material = view.print && mesh.userData.printMaterial ? mesh.userData.printMaterial : lookMaterial(mesh);
  }
  function disposeMesh(mesh) {
    mesh.geometry.dispose();
    const mats = [...Object.values(mesh.userData.looks), mesh.userData.printMaterial].filter(Boolean);
    for (const m of mats) {
      for (const t of [m.map, m.gradientMap]) if (t && t !== drapeTex) t.dispose();
      m.dispose();
    }
  }

  // layers: {id: mesh}; colours: {id: '#rrggbb'}; landcover: canvas or null
  function setModel({ layers, colours, landcover, grid }) {
    for (const k of Object.keys(meshes)) { inner.remove(meshes[k]); disposeMesh(meshes[k]); delete meshes[k]; }
    drapeTex?.dispose();
    drapeTex = landcover ? canvasTexture(landcover, renderer) : null;
    span = Math.max(grid.Wmm, grid.Hmm);
    let zmax = 0;
    const add = (id, g, kind, colour) => {
      const mesh = new THREE.Mesh(g);
      mesh.userData = { kind, colour, looks: {}, override: {} };
      mesh.castShadow = kind !== 'water'; mesh.receiveShadow = true;
      mesh.name = id;
      applyMaterial(mesh);
      inner.add(mesh); meshes[id] = mesh;
      return mesh;
    };
    for (const [id, m] of Object.entries(layers)) {
      if (!m || !m.indices.length) continue;
      const g = geometry(m);
      if (id === 'terrain') {
        // Top and bottom take the drape; the sides are split off into their
        // own geometry (soil strata in the Mossmorran look).
        const { capsIdx, walls } = splitWalls(m);
        g.setIndex(new THREE.BufferAttribute(capsIdx, 1));
        g.setAttribute('uv', planarUV(m.positions, grid));
        add('terrain-sides', walls, 'terrain-sides');
      }
      const kind = id === 'terrain' || id === 'water' ? id : 'layer';
      add(id, g, kind, colours[id] || colours[id.replace('Disused', '')] || '#cccccc');
      for (let k = 2; k < m.positions.length; k += 3) zmax = Math.max(zmax, m.positions[k]);
    }
    H = zmax;
    inner.position.set(-grid.Wmm / 2, -grid.Hmm / 2, 0);
    ground.scale.set(span * 8, span * 8, 1);
    setSun();
    setHeightScale(view.heightScale);
    setView('oblique', false);
  }

  // Swap the drape on the land top (land cover or satellite) without rebuilding.
  function setDrape(canvas) {
    const m = meshes.terrain; if (!m) return;
    drapeTex?.dispose();
    drapeTex = canvas ? canvasTexture(canvas, renderer) : null;
    for (const mat of Object.values(m.userData.looks)) {
      mat.map = drapeTex;
      mat.color.set(canvas ? 0xffffff : LAND_BASE);
      mat.needsUpdate = true;
    }
  }

  // ---- Looks ----
  // Switch the whole look (materials, lights, environment, tone mapping,
  // shadow type, background) without rebuilding any geometry.
  let mossBackground = view.background;
  function setLook(look) {
    if (!LOOKS[look] || look === view.look) return;
    const field = look === 'field';
    if (field) mossBackground = view.background;
    view.look = look;
    for (const m of Object.values(meshes)) applyMaterial(m);
    scene.environment = field ? null : roomEnv;
    renderer.toneMapping = field ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
    if (field) { hemi.color.set(0xffffff); hemi.groundColor.set(0xc9c5bd); }
    else { hemi.color.set(0xcfe3ff); hemi.groundColor.set(0x5a4a35); }
    // A new shadow type needs a fresh shadow map and recompiled shaders.
    renderer.shadowMap.type = field ? THREE.VSMShadowMap : THREE.PCFSoftShadowMap;
    sun.shadow.radius = field ? 6 : 1; sun.shadow.blurSamples = field ? 12 : 8;
    sun.shadow.bias = field ? -0.0002 : -0.0004;
    sun.shadow.map?.dispose(); sun.shadow.map = null;
    scene.traverse(o => { if (o.material) o.material.needsUpdate = true; });
    setBackground(field ? 'white' : mossBackground);
    setSun();
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

  // Lens: keep the framing while changing focal length (dolly to compensate).
  function setFov(f) {
    const dir = camera.position.clone().sub(controls.target);
    dir.multiplyScalar(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / Math.tan(THREE.MathUtils.degToRad(f / 2)));
    camera.position.copy(controls.target).add(dir);
    camera.fov = f; camera.updateProjectionMatrix(); view.fov = f;
  }
  // 35 mm-equivalent focal length for the label
  const focalMm = f => Math.round(18 / Math.tan(THREE.MathUtils.degToRad(f / 2)));

  // View-only height scale on top of the model's exaggeration. Captions
  // report the product, so the disclosed figure is always what is shown.
  function setHeightScale(k) { model.scale.set(1, 1, k); view.heightScale = k; }

  const BACKGROUNDS = {
    sky: () => gradient([[0, '#7fa6c9'], [0.55, '#c9d9e4'], [1, '#e9e4da']]),
    studio: () => gradient([[0, '#d9d6cf'], [1, '#a9a59c']]),
    white: () => new THREE.Color(0xffffff),
    dark: () => gradient([[0, '#2b2e33'], [1, '#141518']]),
    clear: () => null,
  };
  function setBackground(name) {
    view.background = name;
    if (scene.background?.isTexture) scene.background.dispose();
    scene.background = (BACKGROUNDS[name] || BACKGROUNDS.sky)();
    ground.material.opacity = name === 'dark' ? 0.45 : 0.28;
  }

  // Print colours: show each layer in the filament colour of its print object.
  // Recolour layers on screen (not in print files), e.g. neutral roads and
  // buildings over a satellite drape so they don't fight the photograph.
  function setScreenColours(colours = {}) {
    for (const [id, c] of Object.entries(colours)) {
      const m = meshes[id]; if (!m) continue;
      m.userData.override.color = c;                  // also applies to looks made later
      for (const mat of Object.values(m.userData.looks)) mat.color.set(c);
    }
  }
  function setPrintColours(on, colours = {}) {
    view.print = on;
    for (const [id, m] of Object.entries(meshes)) {
      const c = colours[id] || colours[id.replace('Disused', '')];
      if (on && c) {
        m.userData.printMaterial ||= new THREE.MeshStandardMaterial({ roughness: 0.6 });
        m.userData.printMaterial.color.set(c);
      }
      if (!c && m.userData.printMaterial) { m.userData.printMaterial.dispose(); m.userData.printMaterial = null; }
      applyMaterial(m);
    }
  }
  function setShadow(on) { ground.visible = on; }

  // Render at `mult` x the on-screen size and return the pixels on a canvas.
  // Captures ignore any on-screen view offset (the offline viewer shifts the
  // view beside its panel), so saved images are always centred.
  function withoutOffset(fn) {
    const v = camera.view?.enabled ? { ...camera.view } : null;
    if (v) { camera.clearViewOffset(); camera.updateProjectionMatrix(); }
    try { return fn(); } finally {
      if (v) { camera.setViewOffset(v.fullWidth, v.fullHeight, v.offsetX, v.offsetY, v.width, v.height); camera.updateProjectionMatrix(); }
    }
  }

  function grab(mult = 2) { return withoutOffset(() => grabInner(mult)); }
  function grabInner(mult) {
    const w = container.clientWidth, h = container.clientHeight, pr = renderer.getPixelRatio();
    renderer.setPixelRatio(mult); renderer.setSize(w, h, false);
    renderer.render(scene, camera);
    const c = document.createElement('canvas');
    c.width = renderer.domElement.width; c.height = renderer.domElement.height;
    c.getContext('2d').drawImage(renderer.domElement, 0, 0);
    renderer.setPixelRatio(pr); renderer.setSize(w, h, false);
    return c;
  }

  const loop = () => { controls.update(); renderer.render(scene, camera); };
  renderer.setAnimationLoop(loop);

  // ---- Capture helpers for animations (turntable GIF / video) ----
  // Pause the live loop so nothing moves the camera between frames.
  function pause() { renderer.setAnimationLoop(null); }
  function resume() { renderer.setAnimationLoop(loop); }
  // Render the current camera at exactly w x h pixels, onto a new canvas.
  function renderAt(w, h) { return withoutOffset(() => renderAtInner(w, h)); }
  function renderAtInner(w, h) {
    const pr = renderer.getPixelRatio(), cw = container.clientWidth, ch = container.clientHeight;
    renderer.setPixelRatio(1); renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.render(scene, camera);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').drawImage(renderer.domElement, 0, 0);
    renderer.setPixelRatio(pr); renderer.setSize(cw, ch, false);
    camera.aspect = cw / ch; camera.updateProjectionMatrix();
    return c;
  }
  // Orbit: remember the current view, then place the camera at an angle
  // (radians, about the vertical axis through the target) from it.
  let orbitBase = null;
  // `aspect` is the frame's width/height: when it is narrower than the screen,
  // the camera moves back so the model's full width stays in frame.
  function orbitStart(aspect = camera.aspect) {
    const k = Math.max(1, camera.aspect / aspect);
    orbitBase = { offset: camera.position.clone().sub(controls.target).multiplyScalar(k), pos: camera.position.clone() };
  }
  function orbitTo(angle) {
    const v = orbitBase.offset.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), angle);
    camera.position.copy(controls.target).add(v); camera.lookAt(controls.target);
  }
  function orbitEnd() { if (orbitBase) camera.position.copy(orbitBase.pos); camera.lookAt(controls.target); orbitBase = null; }

  return { renderer, scene, camera, controls, view, meshes, focalMm, setModel, setDrape, setLook, setVisible, setView, setSpin,
    setSun, setFov, setHeightScale, setBackground, setPrintColours, setScreenColours, setShadow, grab,
    pause, resume, renderAt, orbitStart, orbitTo, orbitEnd };
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
