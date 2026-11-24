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
import { createInk, INK } from './ink.js';
import { paintOverlays } from './overlays.js';

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

// Field style land-cover palette (same classes as above): saturated
// yellow-greens and olives with clear light/dark contrast, after slab's
// field look. Presentation only.
export const FIELD_LANDCOVER_COLOURS = {
  'landuse:farmland': '#e2d9a8', 'landuse:meadow': '#cbcd82', 'landuse:grass': '#cbcd82',
  'landuse:forest': '#6f7d52', 'natural:wood': '#6f7d52', 'natural:scrub': '#aeb088',
  'natural:heath': '#b5a989', 'natural:moor': '#b5a989', 'natural:grassland': '#cbcd82',
  'natural:wetland': '#a9bfa9', 'landuse:residential': '#e8dfcf', 'landuse:farmyard': '#d9cba9',
  'landuse:cemetery': '#b9bf86', 'landuse:allotments': '#b9bf86', 'landuse:recreation_ground': '#cbcd82',
  'landuse:commercial': '#d8d1c7', 'landuse:retail': '#d8d1c7', 'landuse:railway': '#d8d1c7',
  'natural:bare_rock': '#a39c88', 'natural:scree': '#a39c88',
};
const FIELD_LAND_BASE = '#d6d09a';
// The evidence layers in field (screen and legend only; print colours are
// unchanged). Power keeps its own colour.
export const FIELD_LAYER_COLOURS = {
  terrain: FIELD_LAND_BASE, water: '#83bec5', buildings: '#f1ece2', roads: '#f3eee4', rail: '#3a332b',
  residues: '#c98aa0', receptors: '#6aa9c9',
};
// The swatch colour for a layer in a look (falls back to its screen colour).
export function layerSwatch(id, look, screenColour) {
  return (look === 'field' && FIELD_LAYER_COLOURS[id]) || screenColour;
}
// Screen-only meshes from buildModel, and the layer whose colour they take.
const SCREEN_OF = { powerPoints: 'power', waterAreas: 'water', waterLines: 'water' };
// Object IDs for the ink pass (1-15): a change of ID between neighbouring pixels is an edge.
// Narrow waterways share the terrain's ID, so their stepped edges get no ink.
const INK_IDS = { terrain: 1, 'terrain-steep': 1, 'terrain-sides': 2, 'terrain-base': 3, water: 4, waterAreas: 4, waterLines: 1, buildings: 5,
  receptors: 6, powerPoints: 7, roads: 8, power: 9, rail: 10, railDisused: 11, residues: 12 };
const FIELD = {
  wallLight: '#f4f2ee', wallDark: '#c9c5bd', base: '#9b968c', channel: '#a9a27f', roof: '#d6cdbd',
  water: '#7fbcc4', waterOpacity: 0.5,
  tones: [0.62, 0.84, 1.0],      // three toon steps (shadow side, mid, lit)
  fov: 20, minEl: 12, maxEl: 70,  // camera
};

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

  // Every render (live view, screengrabs, GIF and video frames) goes through
  // draw(), so the field style's ink outlines appear in all of them.
  const ink = createInk(renderer);
  // The raised route strips (shown in field only with print colours on) are
  // left out of the outline pass: at grid resolution their edges are
  // stepped, and ink would trace every step. Water stays in, so shorelines
  // are inked by the change of object.
  const INKLESS = ['roads', 'power', 'rail', 'railDisused', 'residues'];
  function draw() {
    renderer.render(scene, camera);
    if (view.look === 'field' && view.ink) ink.render(scene, camera, { hide: [ground, ...INKLESS.map(id => meshes[id]).filter(Boolean)] });
  }

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

  // Measured: at 0.9 a lit, level surface renders at its own colour (±2/255).
  const FIELD_SUN = 0.9, FIELD_FILL = 0.9;
  const view = { az: 225, el: 32, strength: 3.0, fill: 1.0, heightScale: 1, fov: 28, background: 'sky', print: false, look: 'mossmorran', ink: true, inkWidth: 1.8 };

  // Sun: azimuth clockwise from north, height above the horizon; it warms
  // towards orange as it drops (as in the Mossmorran viewer).
  function setSun(azDeg = view.az, elDeg = view.el, strength = view.strength, fill = view.fill) {
    Object.assign(view, { az: azDeg, el: elDeg, strength, fill });
    const az = THREE.MathUtils.degToRad(azDeg), el = THREE.MathUtils.degToRad(elDeg), r = span * 2.5;
    sun.position.set(Math.sin(az) * Math.cos(el) * r, Math.sin(el) * r, -Math.cos(az) * Math.cos(el) * r);
    // Field lights are scaled so a lit, level surface shows its own colour.
    sun.intensity = strength * (view.look === 'field' ? FIELD_SUN : 1);
    hemi.intensity = fill * (view.look === 'field' ? FIELD_FILL : 1);
    const warm = THREE.MathUtils.clamp((elDeg - 3) / 30, 0, 1);
    if (view.look === 'field') sun.color.set(0xffffff);      // field: neutral light, the colours are in the materials
    else sun.color.setRGB(1, 0.78 + 0.18 * warm, 0.58 + 0.33 * warm);
    const sc = sun.shadow.camera;
    sc.left = sc.bottom = -span * 0.75; sc.right = sc.top = span * 0.75; sc.near = 1; sc.far = span * 6;
    sc.updateProjectionMatrix();
    shadeWalls();
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
      if (kind === 'terrain' || kind === 'terrain-base') return new THREE.MeshStandardMaterial({ map: drapeTex, color: drapeTex ? 0xffffff : LAND_BASE, roughness: 0.92 });
      if (kind === 'terrain-sides' || kind === 'terrain-steep') return new THREE.MeshStandardMaterial({ map: strataTexture(renderer), roughness: 0.96 });
      if (kind === 'water') return new THREE.MeshPhysicalMaterial({ color: 0x24506a, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1.6 });
      return new THREE.MeshStandardMaterial({ color: colour, roughness: 0.8 });
    },
    // Field: three-step toon shading on everything lit; the slab walls are
    // flat colours, light or dark by which way they face the sun.
    field(mesh) {
      const { kind, colour } = mesh.userData;
      const toon = o => new THREE.MeshToonMaterial({ gradientMap: toonRamp(), ...o });
      if (kind === 'terrain') { const t = fieldDrape(); return toon({ map: t, color: t ? 0xffffff : FIELD_LAND_BASE }); }
      if (kind === 'terrain-base') return new THREE.MeshBasicMaterial({ color: FIELD.base });
      if (kind === 'terrain-sides') return new THREE.MeshBasicMaterial({ vertexColors: true });
      if (kind === 'terrain-steep') return toon({ color: FIELD.channel });     // channel banks inside the land
      if (kind === 'water') return toon({ color: FIELD.water, transparent: true, opacity: FIELD.waterOpacity, depthWrite: false });
      if (mesh.userData.id === 'buildings') return roofsAndWalls(toon({ flatShading: true }));
      return toon({ color: FIELD_LAYER_COLOURS[SCREEN_OF[mesh.userData.id] || mesh.userData.id] || colour, flatShading: mesh.userData.id === 'receptors' });
    },
  };
  // Buildings in field: walls and flat roofs in two colours, chosen per face
  // from its direction (roofs face up), so no geometry changes.
  function roofsAndWalls(mat) {
    const wall = new THREE.Color(FIELD_LAYER_COLOURS.buildings), roof = new THREE.Color(FIELD.roof);
    mat.onBeforeCompile = sh => {
      sh.uniforms.wallColour = { value: wall }; sh.uniforms.roofColour = { value: roof };
      sh.fragmentShader = sh.fragmentShader
        .replace('void main() {', 'uniform vec3 wallColour;\nuniform vec3 roofColour;\nvoid main() {')
        .replace('#include <color_fragment>', `#include <color_fragment>
          vec3 faceN = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
          float upness = dot(faceN, normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz));
          diffuseColor.rgb = mix(wallColour, roofColour, step(0.7, abs(upness)));`);
    };
    mat.customProgramCacheKey = () => 'field-roofs-walls';
    return mat;
  }
  // One shared ramp texture for every toon material.
  let ramp = null;
  function toonRamp() {
    if (!ramp) {
      ramp = new THREE.DataTexture(new Uint8Array(FIELD.tones.map(v => Math.round(v * 255))), FIELD.tones.length, 1, THREE.RedFormat);
      ramp.minFilter = ramp.magFilter = THREE.NearestFilter; ramp.generateMipmaps = false; ramp.needsUpdate = true;
    }
    return ramp;
  }
  // The field drape, up to 4096 px across: the base drape (land cover redrawn
  // in the field palette; satellite or contours as they are) with routes and
  // residue areas painted on top. Painting happens when the model came with
  // vectors (the web app and its offline viewer) and print colours are off;
  // then the raised route strips are hidden instead (see refreshVisibility).
  let drapeKind = null, fieldDrapeTex = null, fieldBase = null, fieldCanvas = null;
  let vectors = null, modelSize = null, residueColour = '#c98aa0';
  const shown = {};                                  // layer checkboxes: id -> on
  const painted = () => view.look === 'field' && !view.print && !!vectors;
  function fieldDrape() {
    if (!drapeTex) return null;
    if (!fieldBase) {
      const img = drapeTex.image, W = Math.min(4096, renderer.capabilities.maxTextureSize);
      const H = Math.round(W * img.height / img.width);
      fieldBase = document.createElement('canvas'); fieldBase.width = W; fieldBase.height = H;
      const g = fieldBase.getContext('2d', { willReadFrequently: drapeKind === 'landcover' });
      g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, W, H);
      if (drapeKind === 'landcover') recolour(fieldBase, paletteMap());
      fieldCanvas = document.createElement('canvas'); fieldCanvas.width = W; fieldCanvas.height = H;
      fieldDrapeTex = canvasTexture(fieldCanvas, renderer);
      paintField();
    }
    return fieldDrapeTex;
  }
  function paintField() {
    if (!fieldCanvas) return;
    const g = fieldCanvas.getContext('2d');
    g.drawImage(fieldBase, 0, 0);
    if (painted()) {
      paintOverlays(g, vectors, { Wmm: modelSize.Wmm, Hmm: modelSize.Hmm, residueColour,
        show: { roads: shown.roads !== false, rail: shown.rail !== false, power: shown.power !== false, residues: shown.residues !== false } });
    }
    fieldDrapeTex.needsUpdate = true;
  }
  // Route strips hidden while they are painted; power keeps its substations
  // and pegs as a screen-only mesh (powerPoints) so they still cast shadows.
  const PAINTED_MESHES = new Set(['roads', 'rail', 'railDisused', 'power', 'residues', 'water']);
  function refreshVisibility() {
    const p = painted();
    for (const [k, m] of Object.entries(meshes)) {
      if (SCREEN_OF[k]) m.visible = p && shown[SCREEN_OF[k]] !== false;     // screen-only stand-ins
      else m.visible = shown[k] !== false && !(p && PAINTED_MESHES.has(k));
    }
  }
  // Light or dark slab walls by facing direction relative to the sun.
  function shadeWalls() {
    const m = meshes['terrain-sides']; if (!m) return;
    const g = m.geometry, n = g.attributes.normal, N = n.count;
    const col = g.attributes.color || g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(N * 3), 3)).attributes.color;
    const light = new THREE.Color(FIELD.wallLight), dark = new THREE.Color(FIELD.wallDark), c = new THREE.Color();
    const sx = sun.position.x, sz = sun.position.z, sl = Math.hypot(sx, sz) || 1;
    for (let i = 0; i < N; i++) {
      // model (x, y, z-up) -> world (x, z, -y)
      const d = (n.getX(i) * sx - n.getY(i) * sz) / sl;
      c.copy(dark).lerp(light, THREE.MathUtils.smoothstep(d, -0.15, 0.15));
      col.setXYZ(i, c.r, c.g, c.b);
    }
    col.needsUpdate = true;
  }
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
      if (m.map && m.map !== drapeTex && m.map !== fieldDrapeTex) m.map.dispose();
      m.dispose();
    }
  }

  // layers: {id: mesh}; colours: {id: '#rrggbb'}; landcover: the drape canvas
  // or null; drapeKind: 'landcover' when it is the land-cover map (the field
  // style redraws that in its own palette), else anything.
  // vectors / screen: the field style's painted routes and screen-only meshes
  // (from buildModel); absent for models from the Python tool.
  function setModel({ layers, colours, landcover, grid, drapeKind: kind = null, vectors: vec = null, screen = {} }) {
    for (const k of Object.keys(meshes)) { inner.remove(meshes[k]); disposeMesh(meshes[k]); delete meshes[k]; }
    for (const k of Object.keys(shown)) delete shown[k];
    vectors = vec; modelSize = { Wmm: grid.Wmm, Hmm: grid.Hmm };
    residueColour = FIELD_LAYER_COLOURS.residues;
    setDrapeTextures(landcover, kind);
    span = Math.max(grid.Wmm, grid.Hmm);
    let zmax = 0;
    const add = (id, g, kind, colour) => {
      const mesh = new THREE.Mesh(g);
      mesh.userData = { id, kind, colour, looks: {}, override: {}, inkId: INK_IDS[id] ?? 15 };
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
        const { capsIdx, baseIdx, walls, steep } = splitWalls(m, grid);
        g.setIndex(new THREE.BufferAttribute(capsIdx, 1));
        g.setAttribute('uv', planarUV(m.positions, grid));
        add('terrain-sides', walls, 'terrain-sides');
        if (steep) add('terrain-steep', steep, 'terrain-steep');
        // The underside: its own mesh so the field style can colour it.
        const base = new THREE.BufferGeometry();
        base.setAttribute('position', g.attributes.position); base.setAttribute('uv', g.attributes.uv);
        base.setIndex(new THREE.BufferAttribute(baseIdx, 1)); base.computeVertexNormals();
        add('terrain-base', base, 'terrain-base');
      }
      const kind = id === 'terrain' || id === 'water' ? id : 'layer';
      add(id, g, kind, colours[id] || colours[id.replace('Disused', '')] || '#cccccc');
      for (let k = 2; k < m.positions.length; k += 3) zmax = Math.max(zmax, m.positions[k]);
    }
    for (const [id, m] of Object.entries(screen || {})) {
      if (m?.indices.length) add(id, geometry(m), SCREEN_OF[id] === 'water' ? 'water' : 'layer', colours[SCREEN_OF[id]] || '#cccccc');
    }
    refreshVisibility();
    H = zmax;
    shadeWalls();
    inner.position.set(-grid.Wmm / 2, -grid.Hmm / 2, 0);
    ground.scale.set(span * 8, span * 8, 1);
    setSun();
    setHeightScale(view.heightScale);
    setView('oblique', false);
  }

  // Swap the drape on the land top (land cover or satellite) without rebuilding.
  function setDrapeTextures(canvas, kind) {
    drapeTex?.dispose(); fieldDrapeTex?.dispose(); fieldDrapeTex = null; fieldBase = fieldCanvas = null;
    drapeTex = canvas ? canvasTexture(canvas, renderer) : null;
    drapeKind = kind;
  }
  // kind: 'landcover' for the land-cover map, else anything (see setModel).
  function setDrape(canvas, kind = null) {
    setDrapeTextures(canvas, kind);
    for (const id of ['terrain', 'terrain-base']) {
      const m = meshes[id]; if (!m) continue;
      for (const [look, mat] of Object.entries(m.userData.looks)) {
        if (look === 'field' && id === 'terrain-base') continue;      // flat colour
        const t = look === 'field' ? fieldDrape() : drapeTex;
        mat.map = t;
        mat.color.set(t ? 0xffffff : look === 'field' ? FIELD_LAND_BASE : LAND_BASE);
        mat.needsUpdate = true;
      }
    }
  }

  // ---- Looks ----
  // Switch the whole look (materials, lights, environment, tone mapping,
  // shadow type, background) without rebuilding any geometry.
  let mossBackground = view.background, mossFov = view.fov;
  function setLook(look) {
    if (!LOOKS[look] || look === view.look) return;
    const field = look === 'field';
    if (field) { mossBackground = view.background; mossFov = camera.fov; }
    view.look = look;
    for (const m of Object.values(meshes)) applyMaterial(m);
    refreshVisibility();
    if (field) paintField();
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
    // Camera: a long lens, elevation held between 12° and 70°; back to the
    // previous lens and free elevation on the way out.
    const deg = THREE.MathUtils.degToRad;
    controls.minPolarAngle = field ? deg(90 - FIELD.maxEl) : 0;
    controls.maxPolarAngle = field ? deg(90 - FIELD.minEl) : Math.PI * 0.495;
    setFov(field ? FIELD.fov : mossFov);
    if (field) fit();
    controls.update();
  }
  // Move the camera along its line of sight until the model's bounding box
  // just fits the view (with a small margin).
  function fit(margin = 0.92) {
    camera.position.copy(fitPosition(camera.position.clone().sub(controls.target), controls.target, margin));
  }
  // Camera position looking along `offset` (camera minus target) at `target`
  // that just fits the model's bounding box.
  function fitPosition(offset, target, margin = 0.92) {
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model, true), pts = [];
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) pts.push(new THREE.Vector3(x, y, z));
    const dir = offset.clone().normalize(), cam = camera.clone();
    const fits = d => {
      cam.position.copy(target).addScaledVector(dir, d); cam.lookAt(target);
      cam.updateMatrixWorld(); cam.updateProjectionMatrix();
      return pts.every(p => { const q = p.clone().project(cam); return Math.abs(q.x) <= margin && Math.abs(q.y) <= margin && q.z < 1; });
    };
    let lo = span * 0.2, hi = span * 40;
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid; }
    return target.clone().addScaledVector(dir, hi);
  }



  function setVisible(id, on) {
    for (const k of [id, `${id}Disused`, `${id}-sides`, `${id}-base`]) shown[k] = on;
    if (id === 'terrain-sides') shown['terrain-steep'] = on;      // "Soil sides" hid these before too
    refreshVisibility();
    if (['roads', 'rail', 'power', 'residues'].includes(id) && painted()) paintField();
  }

  function setView(name, animate = true) {
    const d = span * 1.95;
    const views = { oblique: [0.55, 0.62, 0.85], reverse: [-0.55, 0.62, -0.85], low: [0.25, 0.18, 1.0], top: [0, 1, 0.0001] };
    let v = new THREE.Vector3(...(views[name] || views.oblique)).normalize().multiplyScalar(d);
    const target = new THREE.Vector3(0, H * 0.3, 0);
    if (view.look === 'field') {
      // Hold the elevation between 12° and 70°, then fit the model to the view.
      const sph = new THREE.Spherical().setFromVector3(v), deg = THREE.MathUtils.degToRad;
      sph.phi = THREE.MathUtils.clamp(sph.phi, deg(90 - FIELD.maxEl), deg(90 - FIELD.minEl));
      if (name === 'top') sph.theta = 0;
      v = fitPosition(new THREE.Vector3().setFromSpherical(sph), target);
    }
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
  // Field ink line width, CSS px (1–3).
  function setInkWidth(px) { INK.lineWidth = THREE.MathUtils.clamp(+px || 1.8, 1, 3); view.inkWidth = INK.lineWidth; }

  // Camera angles as seen from the model's centre, in degrees: az is the
  // compass bearing the camera stands at (clockwise from north), el its
  // height above the horizon. Used for shareable view URLs.
  function cameraAngles() {
    const v = camera.position.clone().sub(controls.target), r = v.length() || 1;
    const az = THREE.MathUtils.radToDeg(Math.atan2(v.x, -v.z));
    return { az: (az + 360) % 360, el: THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(v.y / r, -1, 1))) };
  }
  function setCameraAngles(azDeg, elDeg) {
    const az = THREE.MathUtils.degToRad(azDeg), el = THREE.MathUtils.degToRad(elDeg);
    const r = camera.position.distanceTo(controls.target);
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    camera.position.copy(view.look === 'field' ? fitPosition(dir, controls.target) : controls.target.clone().addScaledVector(dir, r));
    controls.update();
  }

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
    const changed = view.print !== on;
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
    // Print colours show the printed strips, so the painted routes step aside.
    if (changed) { refreshVisibility(); if (view.look === 'field') paintField(); }
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
    draw();
    const c = document.createElement('canvas');
    c.width = renderer.domElement.width; c.height = renderer.domElement.height;
    c.getContext('2d').drawImage(renderer.domElement, 0, 0);
    renderer.setPixelRatio(pr); renderer.setSize(w, h, false);
    return c;
  }

  const loop = () => { controls.update(); draw(); };
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
    draw();
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
    cameraAngles, setCameraAngles, setInkWidth,
    setSun, setFov, setHeightScale, setBackground, setPrintColours, setScreenColours, setShadow, grab,
    pause, resume, renderAt, orbitStart, orbitTo, orbitEnd };
}

// Separate wall triangles (|normal z| small) from the top cap and the
// underside (normal pointing down). Walls on the model's edge are the slab
// sides; steep faces inside (stream channels cut into the land) are kept
// apart as `steep`, so the field style can treat them as land.
function splitWalls({ positions: P, indices: I }, grid) {
  const caps = [], base = [], wallPos = [], wallUV = [], steepPos = [], steepUV = [];
  const onEdge = v => Math.min(Math.abs(P[v]), Math.abs(P[v] - grid.Wmm), Math.abs(P[v + 1]), Math.abs(P[v + 1] - grid.Hmm)) < 1e-3;
  let zmax = 0;
  for (let k = 2; k < P.length; k += 3) zmax = Math.max(zmax, P[k]);
  for (let t = 0; t < I.length; t += 3) {
    const a = 3 * I[t], b = 3 * I[t + 1], c = 3 * I[t + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1];
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nz, (P[b + 1] - P[a + 1]) * (P[c + 2] - P[a + 2]) - (P[b + 2] - P[a + 2]) * (P[c + 1] - P[a + 1]),
      (P[b + 2] - P[a + 2]) * (P[c] - P[a]) - (P[b] - P[a]) * (P[c + 2] - P[a + 2])) || 1;
    if (Math.abs(nz / len) > 0.2) { (nz > 0 ? caps : base).push(I[t], I[t + 1], I[t + 2]); continue; }
    const edge = onEdge(a) && onEdge(b) && onEdge(c);
    for (const v of [a, b, c]) {
      (edge ? wallPos : steepPos).push(P[v], P[v + 1], P[v + 2]);
      // u runs along the edge of the model; v is height
      (edge ? wallUV : steepUV).push((P[v] + P[v + 1]) / 60, Math.min(P[v + 2] / zmax, 1));
    }
  }
  const geo = (pos, uv) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.computeVertexNormals();
    return g;
  };
  return { capsIdx: new Uint32Array(caps), baseIdx: new Uint32Array(base), walls: geo(wallPos, wallUV), steep: steepPos.length ? geo(steepPos, steepUV) : null };
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

// Redraw a land-cover canvas (in place) in another palette: each pixel takes the target
// colour of the nearest source colour (so anti-aliased edges and JPEG noise
// in an offline viewer's drape map cleanly).
function paletteMap() {
  const pairs = [[LAND_BASE, FIELD_LAND_BASE], ...Object.entries(LANDCOVER_COLOURS).map(([k, c]) => [c, FIELD_LANDCOVER_COLOURS[k]])];
  const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  return pairs.map(([a, b]) => [rgb(a), rgb(b)]);
}
function recolour(c, map) {
  const g = c.getContext('2d');
  const id = g.getImageData(0, 0, c.width, c.height), d = id.data, memo = new Map();
  for (let i = 0; i < d.length; i += 4) {
    const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    let out = memo.get(key);
    if (!out) {
      let best = Infinity;
      for (const [s, t] of map) {
        const e = (d[i] - s[0]) ** 2 + (d[i + 1] - s[1]) ** 2 + (d[i + 2] - s[2]) ** 2;
        if (e < best) { best = e; out = t; }
      }
      memo.set(key, out);
    }
    d[i] = out[0]; d[i + 1] = out[1]; d[i + 2] = out[2];
  }
  g.putImageData(id, 0, 0);
  return c;
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
