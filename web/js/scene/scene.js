// The shared Three.js scene. This is the one place the model's look is
// defined: the app preview, the standalone viewer and (Phase 4) every
// rendered artefact use it, so styling is identical everywhere.
//
// Two looks share the same geometry, switched by setLook() without a rebuild:
//   guthrie (default): a flat-shaded diorama with a palette after Sir James
//     Guthrie, a sky gradient and optional brushwork on the land.
//   field: the same on white, in its own palette (colours in palettes.js).
// Both are presentation only: print files, sections and every factual layer
// are unchanged. (The earlier Mossmorran look was retired in Nov 2026.)
// Each mesh keeps one material per look, made the first time that look is
// shown and disposed with the model.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { createInk, INK } from './ink.js';
import { paintOverlays, paintBoundary } from './overlays.js';
import { PALETTES, EVIDENCE, brushStrokes, paintBrushwork, seedFrom } from './palettes.js';
import { createProps } from './props.js';
import { createGeology } from './geology.js';
import { createPits } from './pits.js';
import { smoothTerrain, gridMesh, liftWalls, borderEdges } from './screenterrain.js';
import { paintCarto, paintWater, recolourData, heightMetres, seaCanvas, hazeRange, glyphPoints } from './carto.js';
import { reliefCanvas } from './contours.js';
import { createGlyphs } from './glyphs.js';
import { createApron } from './apron.js';
import { desaturate } from './apron-math.js';
import { metresPerPx, niceBar } from './scalebar.js';
import { heightSampler } from './props-math.js';
import { decodeTrees } from '../data/props.js';
import { createDatacentre } from './datacentre.js';
import { cutTerrain, restoreTerrain, insideItems } from './datacentre-math.js';
export { layerSwatch } from './palettes.js';

export const LANDCOVER_COLOURS = {
  'landuse:farmland': '#C9C08A', 'landuse:meadow': '#B5C98A', 'landuse:grass': '#B5C98A',
  'landuse:forest': '#6E8B5A', 'natural:wood': '#6E8B5A', 'natural:scrub': '#8FA06A',
  'natural:heath': '#A8937A', 'natural:moor': '#A8937A', 'natural:grassland': '#B5C98A',
  'natural:wetland': '#94A9A0', 'landuse:residential': '#CFC6B8', 'landuse:farmyard': '#C2B49A',
  'landuse:cemetery': '#A9B898', 'landuse:allotments': '#B9C08A', 'landuse:recreation_ground': '#B5C98A',
  'landuse:commercial': '#C8BFC0', 'landuse:retail': '#C8BFC0', 'landuse:railway': '#BDB5AA',
  'natural:bare_rock': '#B3ADA4', 'natural:scree': '#B3ADA4',
};
const LAND_BASE = '#BDB08E';                // land-cover canvas ground (redrawn in each look's palette)
export const LOOKS = { guthrie: 'Guthrie', field: 'Field', anthropogenic: 'Anthropogenic' };
export const DEFAULT_LOOK = 'guthrie';
// What each look does beyond its palette. Anthropogenic: a smoothed screen
// terrain, one painted cartographic drape on an unlit surface, no screen-space
// ink (only the slab border and what is drawn into the drape and glyphs),
// 2.5D glyphs for pylons and turbines, and haze. Any look can opt in.
export const LOOK_DEFS = {
  guthrie: {}, field: {},
  anthropogenic: { screenTerrain: true, carto: true, inkPass: false, glyphs: true, fog: true },
};
const lookDef = look => LOOK_DEFS[look] || {};
const stylisedLook = look => !!PALETTES[look];

// Kept for compatibility: the field palette now lives in palettes.js.
export const FIELD_LANDCOVER_COLOURS = PALETTES.field.landcover;
export const FIELD_LAYER_COLOURS = { terrain: PALETTES.field.landBase, ...PALETTES.field.layers };
// Screen-only meshes from buildModel, and the layer whose colour they take.
const SCREEN_OF = { powerGen: 'power', powerStore: 'power', powerGrid: 'power', powerLines: 'power', genPegs: 'power', gridPegs: 'power',
  waterAreas: 'water', waterLines: 'water' };
// The power meshes on screen, by electricity group (JC 26 Nov 2026): each
// group has its own layer row. They stand in for the print's single Power mesh.
const POWER_GROUP_OF = { powerGen: 'generation', powerStore: 'storage', powerGrid: 'transmission', powerLines: 'transmission', genPegs: 'generation', gridPegs: 'transmission' };
const POWER_AREA_MESHES = ['powerGen', 'powerStore', 'powerGrid', 'genPegs', 'gridPegs'];
// Object IDs for the ink pass (1-15): a change of ID between neighbouring pixels is an edge.
// Narrow waterways share the terrain's ID, so their stepped edges get no ink.
// three.js layer for the data centre's redraw over the ink (redrawDatacentre).
const DC_LAYER = 3;
const INK_IDS = { terrain: 1, 'terrain-steep': 1, 'terrain-sides': 2, 'terrain-base': 3, water: 4, waterAreas: 4, waterLines: 1, buildings: 5,
  receptors: 6, powerGen: 7, powerStore: 7, powerGrid: 7, genPegs: 7, gridPegs: 7, roads: 8, power: 9, powerLines: 9, rail: 10, railDisused: 11, residues: 12 };
// Shared by the stylised looks (colours are per palette).
const FIELD = {
  groundShadow: 0.08,
  tones: [0.70, 0.87, 1.0],      // three toon steps (shadow side, mid, lit)
  fov: 20, minEl: 0, maxEl: 90,   // camera: side-on to straight down
};

export function createScene(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;
  container.appendChild(renderer.domElement);
  renderer.domElement.setAttribute('role', 'img');

  const scene = new THREE.Scene();

  // Camera: a long lens, elevation anywhere from level with the base edge (0°)
  // to straight down (90°) (FIELD below). Right-drag or two-finger drag pans;
  // the point the camera looks at is kept over the model (clampTarget).
  const camera = new THREE.PerspectiveCamera(20, 1, 0.5, 5000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.minPolarAngle = THREE.MathUtils.degToRad(90 - FIELD.maxEl);
  controls.maxPolarAngle = THREE.MathUtils.degToRad(90 - FIELD.minEl);
  controls.enablePan = true; controls.screenSpacePanning = true;
  controls.autoRotateSpeed = 0.8;
  // Keep the look-at point within the model's footprint (and between the base
  // and twice the tallest point), moving the camera with it so the angle holds.
  // Then keep the camera above the ground wherever it is over the model, so a
  // close, low view never passes into the slab (clampCamera).
  const clampTmp = new THREE.Vector3();
  function clampTarget() {
    const t = controls.target, hx = (modelWmm || span) / 2, hz = (modelHmm || span) / 2;
    clampTmp.set(THREE.MathUtils.clamp(t.x, -hx, hx), THREE.MathUtils.clamp(t.y, 0, Math.max(H * 2, 1)), THREE.MathUtils.clamp(t.z, -hz, hz)).sub(t);
    if (clampTmp.lengthSq() > 1e-12) { t.add(clampTmp); camera.position.add(clampTmp); }
    clampCamera();
  }
  controls.addEventListener('change', clampTarget);
  // Lowest camera height (world y) at world (x, z): the displayed ground plus a
  // clearance well beyond the near plane, or -Infinity off the model.
  const CAMERA_CLEARANCE = 2;      // mm
  function minCameraY(x, z) {
    const hx = (modelWmm || span) / 2, hz = (modelHmm || span) / 2, edge = CAMERA_CLEARANCE;
    if (Math.abs(x) > hx + edge || Math.abs(z) > hz + edge) {
      if (!contextActive()) return -Infinity;
      return apron.zAt(x + hx, -z + hz) * model.scale.z + CAMERA_CLEARANCE;    // over the context: its own ground
    }
    const mx = THREE.MathUtils.clamp(x + hx, 0, 2 * hx), my = THREE.MathUtils.clamp(-z + hz, 0, 2 * hz);
    let g = groundAt ? groundAt(mx, my) : H;                       // the print terrain's surface (mm)
    if (screenT && screenT.mesh.visible) g = Math.max(g, screenT.T.sample(mx, my));   // Anthropogenic's smoothed land
    return g * model.scale.z + CAMERA_CLEARANCE;
  }
  function clampCamera() {
    const p = camera.position, lo = minCameraY(p.x, p.z);
    if (p.y < lo) p.y = lo;
  }

  // Neutral light: the colours are in the materials.
  const hemi = new THREE.HemisphereLight(0xffffff, 0xc9c5bd, 1.0);
  const sun = new THREE.DirectionalLight(0xffffff, 3.0);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0002; sun.shadow.normalBias = 0.04;
  sun.shadow.radius = 6; sun.shadow.blurSamples = 12;
  scene.add(hemi, sun, sun.target);
  hemi.layers.enable(DC_LAYER); sun.layers.enable(DC_LAYER);      // lights for the data centre's redraw (redrawDatacentre)

  const model = new THREE.Group();
  model.rotation.x = -Math.PI / 2;            // model z-up (mm) -> three y-up
  const inner = new THREE.Group();
  model.add(inner);
  scene.add(model);
  // The context apron (screen only, never printed): its own root with the
  // model's transform, so it is left out of the model's framing (fitPosition).
  const ctxModel = new THREE.Group(); ctxModel.rotation.x = -Math.PI / 2;
  const ctxInner = new THREE.Group(); ctxModel.add(ctxInner); scene.add(ctxModel);

  // Every render (live view, screengrabs, GIF and video frames) goes through
  // draw(), so the field style's ink outlines appear in all of them.
  const ink = createInk(renderer);
  // The raised route strips (shown in field only with print colours on) are
  // left out of the outline pass: at grid resolution their edges are
  // stepped, and ink would trace every step. Water stays in, so shorelines
  // are inked by the change of object.
  const INKLESS = ['roads', 'power', 'powerLines', 'rail', 'railDisused', 'residues'];
  const drawSize = new THREE.Vector2();
  // Scale bar (screen only: it is an element over the canvas, so grabs leave it out).
  const scaleEl = document.createElement('div');
  scaleEl.className = 'scalebar'; scaleEl.setAttribute('aria-hidden', 'true');
  scaleEl.style.cssText = 'position:absolute;right:12px;bottom:10px;pointer-events:none;font:11px/1.2 system-ui,sans-serif;color:#221d18;'
    + 'background:rgba(255,255,255,0.72);padding:4px 6px 3px;border-radius:2px;z-index:2;';
  scaleEl.innerHTML = '<div class="scalebar-bar" style="height:5px;border:1.5px solid currentColor;border-top:none;"></div>'
    + '<div><span class="scalebar-label"></span> <span style="opacity:0.7">(across the screen, at the centre of view)</span></div>';
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.appendChild(scaleEl);
  const scaleBarEl = scaleEl.firstChild, scaleLabelEl = scaleEl.querySelector('.scalebar-label');
  let scaleKey = '', scaleOn = true;
  // The scale bar's layer toggle (on by default).
  function showScaleBar(on) { scaleOn = !!on; scaleKey = ''; updateScaleBar(); }
  function updateScaleBar() {
    const mpp = modelSize && metresPerPx(camera.position.distanceTo(controls.target), camera.fov, container.clientHeight, modelSize.mmPerM);
    const b = mpp && niceBar(mpp, Math.min(140, container.clientWidth * 0.3));
    const key = b ? `${b.label}|${b.px.toFixed(1)}` : '';
    if (key === scaleKey) return;
    scaleKey = key; scaleEl.style.display = b && scaleOn ? '' : 'none';
    if (b) { scaleBarEl.style.width = `${b.px.toFixed(1)}px`; scaleLabelEl.textContent = b.label; }
  }
  // The proposed data centre is solid (JC, 26 Nov 2026): the ink pass works
  // from its own render and would draw the edges of what stands behind the
  // buildings (terrain, buildings, pylons) over their walls. So after the ink,
  // the buildings and their own lines are drawn again on DC_LAYER, depth-tested
  // against the colour render: where they are the nearest surface they cover
  // the ink; elsewhere nothing changes.
  function redrawDatacentre() {
    const bg = scene.background, mask = camera.layers.mask, autoClear = renderer.autoClear, shadowAuto = renderer.shadowMap.autoUpdate;
    scene.background = null; camera.layers.set(DC_LAYER); renderer.autoClear = false; renderer.shadowMap.autoUpdate = false;
    renderer.render(scene, camera);
    scene.background = bg; camera.layers.mask = mask; renderer.autoClear = autoClear; renderer.shadowMap.autoUpdate = shadowAuto;
  }
  function draw() {
    updateScaleBar();
    if (pits) pits.layout(camera, renderer.getSize(drawSize), inner);
    if (apron && apron.root.visible && apronOn) apron.layout(camera, renderer.getSize(drawSize), ctxInner, H);
    if (dc && dcOn) dc.layout(camera, renderer.getSize(drawSize));
    if (scene.fog) {               // haze follows the camera (live view, grabs and every turntable frame)
      [scene.fog.near, scene.fog.far] = hazeRange(camera.position.distanceTo(controls.target), PALETTES.anthropogenic.carto);
    }
    renderer.render(scene, camera);
    const inked = stylisedLook(view.look) && view.ink && lookDef(view.look).inkPass !== false;
    if (inked) ink.render(scene, camera, { hide: [ground, ...[...INKLESS, ...(painted() ? [] : POWER_AREA_MESHES)].map(id => meshes[id]).filter(Boolean), ...(props?.parts.lines || []), ...(props?.parts.trees || []), ...(pits ? [pits.group] : []), ...(dc ? [dc.group] : []), ...(apron ? apron.inkHide : [])], joinApron: !!apron && (apronOn || energyOn) && apron.root.visible });
    if (inked && dc && dcOn) redrawDatacentre();
  }

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.28 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
  scene.add(ground);

  const meshes = {};
  let props = null;            // 3D props (setProps)
  const propShown = { trees: true, turbines: true, pylons: true };
  let boundaryOn = true;            // the site red line (the "Data Centre Application Boundary" layer row)
  let geology = null, geologyOn = false, geologyLabels = { geology: false, bgs: false };   // geology walls (setGeology); legends and wall labels off by default (JC, 26 Nov 2026)
  let pits = null, pitsOn = true, pitsMeta = {};   // pits on the surface (setPits)
  let propsSection = null;     // the bundle's props, for crowns and glyphs
  // Carto looks (Anthropogenic): built on first use per model, then cached.
  let screenT = null;          // { T, mesh, border, wallOrig, wallLift, stats }
  let carto = null;            // { canvas, tex, stats }
  let cartoCache = {};         // base (recoloured), relief, sea, sampler
  let glyphs = null, glyphInfo = null;
  let heightsGrid = null, reliefMeta = null, layerColours = {};
  let groundAt = null;         // print terrain height (mm) at print x, y, for the camera floor
  let dc = null, dcOn = false, dcCut = null;     // proposed data centre (setDatacentre; screen only)
  let apron = null, apronOn = true, energyOn = true, apronEdge = null;   // the context apron (setContext): Landscape and Energy context
  // With either context shown, the camera may come down to the level of the terrain
  // (JC, 26 Nov 2026; was 15°): minCameraY keeps it just above the ground, the
  // context's own ground beyond the model.
  const CONTEXT_MIN_EL = FIELD.minEl;
  let minElNow = FIELD.minEl;
  let span = 150, H = 20, modelWmm = 0, modelHmm = 0;

  function resize() {
    const w = container.clientWidth || 600, h = container.clientHeight || 400;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);
  resize();

  // Measured with the [0.70, 0.87, 1.0] tones: at 0.79 a lit, level surface
  // renders at its own colour (within 2/255).
  const FIELD_SUN = 0.79, FIELD_FILL = 0.79;
  const view = { az: 225, el: 32, strength: 3.0, fill: 1.0, heightScale: 1, fov: 20, background: PALETTES[DEFAULT_LOOK].background, print: false, look: DEFAULT_LOOK, ink: true, inkWidth: 1.8, brushwork: true,
    relief: true, crowns: true, smoothRadius: 1,
    mist: Object.fromEntries(Object.keys(LOOKS).map(l => [l, !!lookDef(l).fog])),     // per look
    contours: false };                                                               // contour lines on land cover (Guthrie, Field)
  const stylised = () => stylisedLook(view.look);
  const pal = (look = view.look) => PALETTES[look] || PALETTES.field;

  // Sun: azimuth clockwise from north, height above the horizon.
  function setSun(azDeg = view.az, elDeg = view.el, strength = view.strength, fill = view.fill) {
    Object.assign(view, { az: azDeg, el: elDeg, strength, fill });
    const az = THREE.MathUtils.degToRad(azDeg), el = THREE.MathUtils.degToRad(elDeg), r = span * 2.5;
    sun.position.set(Math.sin(az) * Math.cos(el) * r, Math.sin(el) * r, -Math.cos(az) * Math.cos(el) * r);
    // Field lights are scaled so a lit, level surface shows its own colour.
    sun.intensity = strength * FIELD_SUN;
    hemi.intensity = fill * FIELD_FILL;
    const sc = sun.shadow.camera;
    sc.left = sc.bottom = -span * 0.75; sc.right = sc.top = span * 0.75; sc.near = 1; sc.far = span * 6;
    sc.updateProjectionMatrix();
    shadeWalls();
    geology?.shade(sun.position);
  }

  function geometry(m) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    g.setIndex(new THREE.BufferAttribute(m.indices, 1));
    g.computeVertexNormals();
    return g;
  }

  // ---- Materials, one set per look ----
  const MAKE = {
    // Field and Guthrie: three-step toon shading on everything lit; the slab
    // walls are flat colours, light or dark by which way they face the sun.
    field: mesh => stylisedMaterial(mesh, 'field'),
    guthrie: mesh => stylisedMaterial(mesh, 'guthrie'),
    anthropogenic: mesh => stylisedMaterial(mesh, 'anthropogenic'),
  };
  function stylisedMaterial(mesh, look) {
    const { kind, colour } = mesh.userData, P = PALETTES[look];
    const toon = o => new THREE.MeshToonMaterial({ gradientMap: toonRamp(), ...o });
    // (a carto look paints its own drape on the screen terrain, so the print terrain needs none)
    if (kind === 'terrain' && lookDef(look).carto && vectors) return toon({ color: P.landBase });
    if (kind === 'terrain') { const t = lookDrape(look); return toon({ map: t, color: t ? 0xffffff : P.landBase }); }
    if (kind === 'terrain-base') return new THREE.MeshBasicMaterial({ color: P.walls.base });
    if (kind === 'terrain-sides') return new THREE.MeshBasicMaterial({ vertexColors: true });
    if (kind === 'terrain-steep') return toon({ color: P.channel });     // channel banks inside the land
    if (kind === 'water') return new THREE.MeshBasicMaterial({ color: P.water });   // flat, opaque; ink gives the shoreline
    if (mesh.userData.id === 'buildings') return roofsAndWalls(toon({ flatShading: true }), P, look);
    const id = SCREEN_OF[mesh.userData.id] || mesh.userData.id;
    return toon({ color: P.layers[id] || colour, flatShading: mesh.userData.id === 'receptors' });
  }
  // Buildings in field: walls and flat roofs in two colours, chosen per face
  // from its direction (roofs face up), so no geometry changes.
  function roofsAndWalls(mat, P, look) {
    const wall = new THREE.Color(P.layers.buildings), roof = new THREE.Color(P.roof);
    mat.onBeforeCompile = sh => {
      sh.uniforms.wallColour = { value: wall }; sh.uniforms.roofColour = { value: roof };
      sh.fragmentShader = sh.fragmentShader
        .replace('void main() {', 'uniform vec3 wallColour;\nuniform vec3 roofColour;\nvoid main() {')
        .replace('#include <color_fragment>', `#include <color_fragment>
          vec3 faceN = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
          float upness = dot(faceN, normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz));
          diffuseColor.rgb = mix(wallColour, roofColour, step(0.7, abs(upness)));`);
    };
    mat.customProgramCacheKey = () => `roofs-walls-${look}`;
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
  // The stylised drapes (one per look), up to 4096 px across: the base drape
  // (land cover redrawn in the look's palette; satellite or contours as they
  // are), Guthrie's brushwork on land cover if switched on, then routes and
  // residue areas painted on top. Painting happens when the model came with
  // vectors (the web app and its offline viewer) and print colours are off;
  // then the raised route strips are hidden instead (see refreshVisibility).
  let drapeKind = null, drapeRaw = null, seed = 0;
  const drapes = {};                                 // look -> { base, canvas, tex }
  let vectors = null, modelSize = null;
  const shown = {};                                  // layer checkboxes: id -> on
  const painted = () => stylised() && !view.print && !!vectors;
  // Painted water (Guthrie and Field, as in Anthropogenic): lochs, waterways and
  // the sea drawn on the drape with smooth edges, over a screen-only copy of the
  // terrain whose water channels are filled level (waterFill from buildModel),
  // instead of the grid-stepped water slabs. Needs the height grid for the sea.
  let waterFill = null, waterGrid = null, waterOrig = null, waterFilled = false, waterCache = {};
  const waterPainted = () => painted() && !!waterFill && !!heightsGrid;
  function setWaterFilled(on) {
    on = !!on && !!waterFill;
    if (on === waterFilled) return;
    const recut = dcUncut();                        // fill from (and restore to) the uncut land
    const { nx, dx, dy, Hmm } = waterGrid;
    const targets = ['terrain', 'terrain-steep', 'terrain-sides'].map(id => meshes[id]).filter(Boolean);
    if (on && !waterOrig) waterOrig = new Map();
    // The terrain's position array is the print model's own (geometry() wraps it,
    // and the 3MF/STL are written from it): give the screen a copy before editing.
    const terr = meshes.terrain;
    if (on && terr && !terr.userData.ownPositions) {
      const copy = new THREE.BufferAttribute(Float32Array.from(terr.geometry.attributes.position.array), 3);
      terr.geometry.setAttribute('position', copy);
      meshes['terrain-base']?.geometry.setAttribute('position', copy);     // the underside shares it
      terr.userData.ownPositions = true;
    }
    for (const m of targets) {
      const a = m.geometry.attributes.position, P = a.array;
      if (on) {
        if (!waterOrig.has(m)) waterOrig.set(m, Float32Array.from(P));
        for (let k = 0; k < P.length; k += 3) {
          if (P[k + 2] < 0.7) continue;                       // the underside and wall bottoms (z <= the label engraving)
          const i = Math.round(P[k] / dx), j = Math.round((Hmm - P[k + 1]) / dy);
          if (Math.abs(P[k] - i * dx) > 1e-3 || Math.abs(Hmm - P[k + 1] - j * dy) > 1e-3) continue;
          const f = waterFill[j * nx + i];
          if (f > P[k + 2]) P[k + 2] = f;
        }
      } else if (waterOrig?.has(m)) P.set(waterOrig.get(m));
      a.needsUpdate = true;
      m.geometry.computeVertexNormals(); m.geometry.computeBoundingSphere();
    }
    if (geology) geology.mesh.geometry.computeBoundingSphere();
    waterFilled = on;
    if (recut) dcRecut();
  }
  // Contour lines (no hillshade) from the height grid, made once per model.
  function contourLines() {
    if (!heightsGrid) return null;
    if (!waterCache.contours) {
      const { Wmm, Hmm, mmPerM } = modelSize;
      const sampler = cartoCache.sampler ||= heightMetres(heightsGrid.grid, heightsGrid.heights, reliefMeta);
      waterCache.contours = reliefCanvas(sampler, Wmm / mmPerM, Hmm / mmPerM, 2048, Hmm / Wmm, { shade: false });
    }
    return waterCache.contours;
  }
  function setContours(on) { view.contours = !!on; for (const look of Object.keys(drapes)) paintDrape(look); }
  // The sea for painted water, in a look's water colour (from the height grid).
  function seaFor(colour) {
    if (!heightsGrid) return null;
    if (!(colour in waterCache)) {
      const { Wmm, Hmm, mmPerM } = modelSize;
      const sampler = cartoCache.sampler ||= heightMetres(heightsGrid.grid, heightsGrid.heights, reliefMeta);
      waterCache[colour] = seaCanvas(sampler, Wmm / mmPerM, Hmm / mmPerM, colour);
    }
    return waterCache[colour];
  }
  function lookDrape(look) {
    if (!drapeRaw) return null;
    if (!drapes[look]) {
      const img = drapeRaw, W = Math.min(4096, renderer.capabilities.maxTextureSize);
      const H = Math.round(W * img.height / img.width);
      const base = document.createElement('canvas'); base.width = W; base.height = H;
      const g = base.getContext('2d', { willReadFrequently: drapeKind === 'landcover' });
      g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, W, H);
      if (drapeKind === 'landcover') recolour(base, paletteMap(PALETTES[look]));
      const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
      drapes[look] = { base, canvas, tex: canvasTexture(canvas, renderer) };
      paintDrape(look);
    }
    return drapes[look].tex;
  }
  function paintDrape(look = view.look) {
    const d = drapes[look]; if (!d) return;
    const g = d.canvas.getContext('2d'), P = PALETTES[look];
    g.drawImage(d.base, 0, 0);
    // Brushwork: a texture, not data (Guthrie only; land cover only; seeded per site).
    if (P.brushwork && view.brushwork && drapeKind === 'landcover') {
      d.strokes ||= brushStrokes(d.canvas.width, d.canvas.height, seed);
      paintBrushwork(g, d.strokes);
    }
    // Contour lines from the model's heights, multiplied over the land cover or
    // satellite imagery (Guthrie, Field; not over the Contours surface itself).
    if (view.contours && drapeKind !== 'contours') {
      const cl = contourLines();
      if (cl) { g.save(); g.globalCompositeOperation = 'multiply'; g.globalAlpha = 0.55; g.imageSmoothingQuality = 'high'; g.drawImage(cl.canvas, 0, 0, d.canvas.width, d.canvas.height); g.restore(); }
    }
    if (painted() && look === view.look && waterPainted() && shown.water !== false) {
      const W0 = PALETTES.anthropogenic.carto;
      paintWater(g, { vectors, sea: seaFor(P.water), Wmm: modelSize.Wmm, mmPerM: modelSize.mmPerM, colour: P.water, riverM: W0.riverM, streamM: W0.streamM });
    }
    if (painted() && look === view.look) {
      paintOverlays(g, vectors, { Wmm: modelSize.Wmm, Hmm: modelSize.Hmm, residueColour: P.layers.residues, colours: P.overlays,
        show: { roads: shown.roads !== false, rail: shown.rail !== false, power: shown.transmission !== false, residues: shown.residues !== false } });
    }
    if (pits && pitsOn && !view.print) pits.paint(g, modelSize);   // pit symbols (BGS BritPits)
    if (dc && dcOn) dc.paint(g, modelSize, P);                // data-centre parameter zones
    if (boundaryOn) paintBoundary(g, vectors?.boundary, modelSize);   // the site red line, on top
    d.tex.needsUpdate = true;
  }
  const paintField = () => { if (cartoActive()) paintCartoDrape(); else if (stylised()) paintDrape(view.look); };
  // Route strips hidden while they are painted; power keeps its substations
  // and pegs as a screen-only mesh (powerPoints) so they still cast shadows.
  const PAINTED_MESHES = new Set(['roads', 'rail', 'railDisused', 'power', 'residues', 'water']);
  const splitPower = () => Object.keys(POWER_GROUP_OF).some(k => meshes[k]);
  // Mist: distance haze in the look's haze colour, on or off per look (on by
  // default where the look asks for it: Anthropogenic). Screen and saved images only.
  function applyMist() {
    const on = stylised() && view.mist[view.look] !== false && !!view.mist[view.look];
    if (!on) { scene.fog = null; return; }
    const P = PALETTES[view.look], colour = P.carto?.haze || P.haze || '#e6e3dc';
    if (!scene.fog) scene.fog = new THREE.Fog(colour, 1, 2); else scene.fog.color.set(colour);
  }
  function setMist(on) { view.mist[view.look] = !!on; applyMist(); }
  function refreshVisibility() {
    applyMist();
    if (refreshCarto()) { refreshApron(); return; }
    const p = painted(), wp = waterPainted();
    setWaterFilled(wp);
    for (const [k, m] of Object.entries(meshes)) {
      if (SCREEN_OF[k] === 'water' && wp) m.visible = false;              // painted on the drape instead
      else if (POWER_GROUP_OF[k]) m.visible = shown[POWER_GROUP_OF[k]] !== false   // power, by group, in every look
        && !(k === 'powerLines' && p)                                     // lines are painted (and strung between the 3D pylons)
        && !(k === 'gridPegs' && (props?.counts?.towers || props?.counts?.poles) && propShown.pylons !== false)     // the 3D props replace the pegs
        && !(k === 'genPegs' && props?.counts?.turbines && propShown.turbines !== false);
      else if (SCREEN_OF[k]) m.visible = p && shown[SCREEN_OF[k]] !== false;     // screen-only stand-ins
      else if (k === 'power' && splitPower()) m.visible = false;           // the print's Power mesh: the groups stand in on screen
      else if (LAND.has(k)) m.visible = true;                             // Terrain off: drawn as land cover (applyLand)
      else m.visible = shown[k] !== false && !(p && PAINTED_MESHES.has(k));
    }
    // Geology walls stand in for the plain slab walls (not with print colours).
    const geo = !!geology && geologyOn && !view.print;
    if (geology) geology.mesh.visible = geo && shown['terrain-sides'] !== false;
    if (geo && meshes['terrain-sides']) meshes['terrain-sides'].visible = false;
    refreshApron();
  }
  // ---- The context apron (bundle context section; screen only) ----
  // context: bundle.context; bbox: bundle.bbox; heights, relief: as setModel.
  function setContext(context, { bbox, grid, heights, relief, on = apronOn } = {}) {
    apron?.dispose(); apron = null; apronEdge = null;
    apronOn = !!on;
    if (!context?.elevation || !grid || !heights || !relief || !bbox) return null;
    const at = heightSampler(grid, heights);
    apron = createApron({ context, bbox, grid, relief, edgeZ: at, maxTexture: renderer.capabilities.maxTextureSize, ramp: toonRamp });
    ctxInner.add(apron.root);
    apron.setLabels(labelsOn);
    apronEdge = 'print';
    refreshApron();
    return apron.stats;
  }
  function showContext(on) { apronOn = !!on; refreshApron(); }          // Landscape Context
  function showEnergy(on) { energyOn = !!on; refreshApron(); }          // Energy Context: pylons, poles and lines only
  // The Labels layer: the pits' name labels and the context's place names (screen and saved images).
  let labelsOn = false;                     // off by default (JC, 26 Nov 2026)
  function showLabels(on) { labelsOn = !!on; pits?.setLabels(labelsOn); apron?.setLabels(labelsOn); }
  const contextActive = () => !!apron && (apronOn || energyOn) && stylised();
  // The camera's lowest elevation follows the context: above the terrain while it is shown.
  function applyCameraLimits() {
    const next = contextActive() ? CONTEXT_MIN_EL : FIELD.minEl;
    if (next === minElNow) return;
    minElNow = next;
    controls.maxPolarAngle = THREE.MathUtils.degToRad(90 - minElNow);
    const a = cameraAngles();
    if (a.el < minElNow) setCameraAngles(a.az, minElNow);
  }
  // The colour the apron fades toward: the background near the horizon.
  function horizonColour() {
    const b = view.background;
    if (b === 'guthrie') { const s = PALETTES.guthrie.sky; return s[s.length - 1][1]; }
    return { sky: '#e9e4da', studio: '#a9a59c', white: '#ffffff', dark: '#141518', clear: '#ffffff' }[b] || '#ffffff';
  }
  // The displayed height on the model's edge: Anthropogenic's smoothed land,
  // else the print terrain (with painted water's filled channels).
  function displayedEdge() {
    if (cartoActive() && screenT) return ['smooth', screenT.T.sample];
    if (waterFilled && waterFill) {
      const { nx, dx, dy, Hmm } = waterGrid;
      return ['filled', (x, y) => { const g = groundAt(x, y), f = waterFill[Math.round((Hmm - y) / dy) * nx + Math.round(x / dx)]; return f > g ? f : g; }];
    }
    return ['print', groundAt];
  }
  function refreshApron() {
    if (!apron) { applyLand(); return; }
    const on = contextActive();
    apron.setVisible(on);
    applyCameraLimits();
    if (!on) { applyLand(); return; }
    const [mode, fn] = displayedEdge();
    if (mode !== apronEdge && fn) { apron.setEdge(fn); apronEdge = mode; }
    const P = PALETTES[view.look], C = P.carto || null, carto = cartoActive();
    const long = Math.min(C?.drapePx || 4096, renderer.capabilities.maxTextureSize), { Wmm, Hmm } = modelSize;
    const drapeW = carto ? (Wmm >= Hmm ? long : Math.round(long * Wmm / Hmm)) : Math.min(4096, renderer.capabilities.maxTextureSize);
    const show = {};
    for (const k of ['water', 'roads', 'rail', 'power', 'buildings']) show[k] = shown[k] !== false;
    show.power = shown.transmission !== false && propShown.pylons !== false;     // the grid round the model is transmission
    const st = apron.setLook(view.look, { P, C, lit: !carto, useGlyphs: carto, bgHex: horizonColour(), drapeW,
      anisotropy: renderer.capabilities.getMaxAnisotropy(), show, parts: { land: apronOn, energy: energyOn }, edge: apronEdgeSource(carto) });
    if (st) apron.stats.paint = st;
    applyLand();
  }
  // The model's land colours for the apron to run on from: the look's drape
  // base (land cover or imagery, without routes), or Anthropogenic's painted land.
  function apronEdgeSource(cartoOn) {
    if (cartoOn) return carto?.canvas ? { canvas: carto.canvas, key: `carto|${view.look}|${drapeVersion}` } : null;
    if (!lookDrape(view.look)) return null;
    return { canvas: drapes[view.look].base, key: `${view.look}|${drapeVersion}` };
  }
  const contextInfo = () => apron ? { on: contextActive(), landscape: apronOn && stylised(), energy: energyOn && stylised(), minElevation: minElNow, ...apron.stats, pad_m: apron.pad_m, source: apron.source,
    attribution: apron.attribution, osmAttribution: apron.osmAttribution, offset_m: apron.offset_m, names: apron.names } : null;
  // ---- Carto looks (Anthropogenic) ----
  // Active only with the painted vectors (the web app and its offline viewer)
  // and with print colours off; otherwise the look falls back to its palette
  // on the ordinary meshes.
  const cartoActive = () => !!lookDef(view.look).carto && !view.print && !!vectors && !!meshes.terrain;
  const CARTO_HIDDEN = new Set(['terrain', 'terrain-steep', 'terrain-base', 'water', 'waterAreas', 'waterLines', 'roads', 'power',
    'rail', 'railDisused', 'residues', 'buildings', 'receptors', ...Object.keys(POWER_GROUP_OF)]);
  let drapeVersion = 0;
  // Visibility for a carto look; returns false (and undoes it) for any other.
  function refreshCarto() {
    if (!cartoActive()) {
      if (screenT) { screenT.mesh.visible = screenT.border.visible = false; setWallsLifted(false); }
      if (glyphs) glyphs.group.visible = false;
      if (props) props.group.visible = true;
      return false;
    }
    setWaterFilled(false);                          // the screen terrain and wall lift start from the print surface
    ensureScreenTerrain();
    for (const [k, m] of Object.entries(meshes)) m.visible = !CARTO_HIDDEN.has(k) && shown[k] !== false;
    const geo = !!geology && geologyOn, sides = shown['terrain-sides'] !== false;
    if (meshes['terrain-sides']) meshes['terrain-sides'].visible = sides && !geo;
    if (geology) geology.mesh.visible = geo && sides;
    setWallsLifted(true);                           // walls (and geology walls) meet the smoothed land
    screenT.mesh.visible = true;                  // Terrain off: the land in the apron's colours (applyLand)
    screenT.border.visible = sides;
    if (props) props.group.visible = false;         // glyphs and painted crowns replace the 3D props
    ensureGlyphs(); if (glyphs) glyphs.group.visible = true;
    paintCartoDrape();
    return true;
  }
  function setWallsLifted(on) {
    const m = meshes['terrain-sides'];
    if (!m || !screenT?.wallOrig || screenT.lifted === on) return;
    const a = m.geometry.attributes.position;
    a.array.set(on ? screenT.wallLift : screenT.wallOrig); a.needsUpdate = true;
    m.geometry.computeBoundingSphere();
    screenT.lifted = on;
  }
  // Stage 1: the smoothed screen terrain over the print terrain's top surface.
  function ensureScreenTerrain() {
    if (screenT) return screenT;
    const t0 = performance.now();
    const recut = dcUncut();                        // built from the uncut land
    const terr = meshes.terrain.geometry, src = terr.attributes.position.array, idx = terr.index.array;
    const used = new Uint8Array(src.length / 3); let n = 0;
    for (let i = 0; i < idx.length; i++) if (!used[idx[i]]) { used[idx[i]] = 1; n++; }
    const top = new Float32Array(n * 3);
    for (let v = 0, o = 0; v < used.length; v++) if (used[v]) { top[o++] = src[3 * v]; top[o++] = src[3 * v + 1]; top[o++] = src[3 * v + 2]; }
    const T = smoothTerrain(top, { radius: view.smoothRadius });
    const m = gridMesh(T, modelSize.Wmm, modelSize.Hmm);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(m.uvs, 2));
    g.setIndex(new THREE.BufferAttribute(m.indices, 1));
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffffff }));
    mesh.name = 'screen-terrain'; mesh.userData = { inkId: 1 }; mesh.visible = false;
    let wallOrig = null, wallLift = null, seg = new Float32Array(0), kept = null;
    const sides = meshes['terrain-sides'];
    if (sides) {
      wallOrig = Float32Array.from(sides.geometry.attributes.position.array);
      const L = liftWalls(wallOrig, T.sample, T);
      wallLift = L.positions; kept = [L.keep.reduce((a, b) => a + b, 0), L.keep.length];
      seg = borderEdges(wallLift, { keep: L.keep });           // Stage 3: the slab border
    }
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.BufferAttribute(seg, 3));
    const border = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: PALETTES[view.look].ink, fog: false }));
    border.name = 'slab-border'; border.visible = false;
    inner.add(mesh, border);
    screenT = { T, mesh, mat: mesh.material, border, wallOrig, wallLift, lifted: false,
      stats: { ...T.stats, wallTriangles: kept, borderSegments: seg.length / 6, ms: Math.round(performance.now() - t0) } };
    if (recut) dcRecut();
    if (dcCut) cutScreenTerrain();
    return screenT;
  }
  // Stage 4: glyphs on the smoothed ground.
  function ensureGlyphs() {
    if (glyphInfo || !lookDef(view.look).glyphs || !screenT) return;
    const C = PALETTES[view.look].carto;
    glyphInfo = glyphPoints({ props: propsSection, vectors, mmPerM: modelSize.mmPerM, Wmm: modelSize.Wmm, Hmm: modelSize.Hmm, C });
    if (!glyphInfo.points.length) return;
    glyphs = createGlyphs({ points: glyphInfo.points, wires: glyphInfo.wires, zAt: screenT.T.sample, ink: PALETTES[view.look].ink, C, anisotropy: renderer.capabilities.getMaxAnisotropy() });
    inner.add(glyphs.group);
    for (const k of ['pylons', 'turbines']) glyphs.setVisible(k, propShown[k] !== false);
  }
  function disposeGlyphs() { if (glyphs) { inner.remove(glyphs.group); glyphs.dispose(); } glyphs = null; glyphInfo = null; }
  // Stage 2: the painted drape, repainted only when what it shows changes.
  function paintCartoDrape() {
    if (!cartoActive() || !screenT) return null;
    const P = PALETTES[view.look], C = P.carto, t0 = performance.now();
    const { Wmm, Hmm, mmPerM } = modelSize;
    const long = Math.min(C.drapePx, renderer.capabilities.maxTextureSize);
    const W = Wmm >= Hmm ? long : Math.round(long * Wmm / Hmm), H = Wmm >= Hmm ? Math.round(long * Hmm / Wmm) : long;
    const show = { brushwork: view.brushwork, relief: view.relief, crowns: view.crowns && propShown.trees !== false };
    for (const k of ['water', 'roads', 'rail', 'residues', 'buildings', 'receptors', 'generation', 'storage', 'transmission']) show[k] = shown[k] !== false;
    const key = JSON.stringify([view.look, W, H, drapeVersion, show, pits && pitsOn ? pits.shown : null, !!(dc && dcOn), boundaryOn]);
    if (carto?.key === key) { if (!carto.tex) uploadCarto(); return carto.stats; }
    if (!carto || carto.canvas.width !== W || carto.canvas.height !== H) {
      carto?.tex?.dispose();
      const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
      carto = { canvas, tex: null };
    }
    let reliefMs = 0;
    if (drapeRaw && !cartoCache.base) cartoCache.base = drapeKind === 'landcover' ? recolourCopy(drapeRaw, paletteMap(P)) : drapeRaw;
    if (heightsGrid && !cartoCache.relief) {        // (the sampler may already exist: painted water and contours use it)
      const r0 = performance.now(), wM = Wmm / mmPerM, hM = Hmm / mmPerM;
      cartoCache.sampler ||= heightMetres(heightsGrid.grid, heightsGrid.heights, reliefMeta);
      cartoCache.relief = reliefCanvas(cartoCache.sampler, wM, hM, Math.round(C.reliefPx * W / C.drapePx), Hmm / Wmm).canvas;
      cartoCache.sea = seaCanvas(cartoCache.sampler, wM, hM, C.water);
      reliefMs = performance.now() - r0;
    }
    if (propsSection && cartoCache.trees === undefined) cartoCache.trees = decodeTrees(propsSection);
    const stats = paintCarto(carto.canvas, { base: cartoCache.base, baseKind: drapeKind, landBase: P.landBase, relief: cartoCache.relief, sea: cartoCache.sea,
      vectors, Wmm, Hmm, mmPerM, C, ink: P.ink, trees: cartoCache.trees || null, seed, show });
    const g = carto.canvas.getContext('2d');
    if (pits && pitsOn) pits.paint(g, modelSize);             // pit symbols (BGS BritPits), on top
    if (dc && dcOn) dc.paint(g, modelSize, P);                // data-centre parameter zones
    if (boundaryOn) paintBoundary(g, vectors?.boundary, modelSize);   // the site red line, on top
    carto.key = key;
    carto.stats = { ...stats, reliefMs: Math.round(reliefMs), ms: Math.round(stats.ms), totalMs: Math.round(performance.now() - t0) };
    uploadCarto();
    return carto.stats;
  }
  function uploadCarto() {
    if (!carto) return;
    if (carto.tex) carto.tex.needsUpdate = true; else carto.tex = canvasTexture(carto.canvas, renderer);
    if (screenT.mat.map !== carto.tex) { screenT.mat.map = carto.tex; screenT.mat.needsUpdate = true; }
  }
  function disposeCarto() {
    if (screenT) {
      setWallsLifted(false);
      inner.remove(screenT.mesh, screenT.border);
      screenT.mesh.geometry.dispose(); screenT.mat.dispose(); screenT.border.geometry.dispose(); screenT.border.material.dispose();
      screenT = null;
    }
    carto?.tex?.dispose(); carto = null; cartoCache = {};
    disposeGlyphs();
  }
  // Caption small print for the look, generated from what is drawn.
  function lookNotes() {
    const ctx = apron && apronOn && stylised() ? [`terrain round the model (context, not printed): ${apron.attribution.replace(/^Elevation: /, '')}; ${apron.osmAttribution}`]
      : apron && energyOn && stylised() && apron.stats.supports ? [`electricity grid round the model (context, not printed): pylons, poles and lines, ${apron.osmAttribution}`] : [];
    if (!cartoActive()) {
      const cl = view.contours && drapeKind !== 'contours' && stylised() && waterCache.contours;
      return [...(cl ? [`contours every ${cl.interval} m (heavier every ${cl.indexInterval} m) from the elevation data`] : []), ...ctx];
    }
    const out = [...ctx], c = carto?.stats?.crowns, gi = glyphInfo, T = screenT?.T;
    if (c && (c.canopy || c.grid || c.row)) {
      if (c.canopy) out.push('tree crowns drawn as symbols at canopy-model tree positions');
      if (c.grid || c.row) out.push('woodland drawn as crown symbols, not individual trees');
    }
    if (gi?.counts.pylon || gi?.counts.pole) {
      out.push(`${gi.counts.pole && gi.counts.pylon ? 'pylon and pole' : gi.counts.pylon ? 'pylon' : 'pole'} symbols ×${PALETTES[view.look].carto.glyphScale} height`);
      if (gi.assumed.pylonHeight) out.push(`${gi.assumed.pylonHeight} pylon height${gi.assumed.pylonHeight > 1 ? 's' : ''} assumed (${PALETTES[view.look].carto.pylonM} m)`);
    }
    if (gi?.assumed.turbineHeight) out.push(`turbine height assumed (${PALETTES[view.look].carto.turbineM} m) for ${gi.assumed.turbineHeight}`);
    if (T) {
      const m = (2 * T.stats.radius + 3) * T.cell / modelSize.mmPerM;     // closing (3 cells) widened by the mean
      out.push(`terrain smoothed for display (~${Math.max(5, Math.round(m / 5) * 5)} m); printed model unchanged`);
    }
    return out;
  }
  // Anthropogenic's own toggles (textures and symbols, not data).
  function setCarto({ relief, crowns } = {}) {
    if (relief != null) view.relief = !!relief;
    if (crowns != null) view.crowns = !!crowns;
    paintField();
  }
  // Pylons/poles, turbines and overhead lines drawn as symbols (for the legend):
  // the Anthropogenic glyphs, else the bundle's 3D props; none otherwise (the pegs are not symbols).
  function electricity() {
    if (cartoActive() && glyphInfo) return { pylons: glyphInfo.counts.pylon + glyphInfo.counts.pole, turbines: glyphInfo.counts.turbine, wires: glyphInfo.wires.length };
    if (props && !cartoActive()) return { pylons: props.counts.towers + props.counts.poles, turbines: props.counts.turbines, wires: props.counts.lineSegments };
    return {};
  }
  const cartoInfo = () => ({ screen: screenT?.stats || null, drape: carto?.stats || null, glyphs: glyphInfo ? { ...glyphInfo.counts, assumed: glyphInfo.assumed } : null, notes: lookNotes() });

  // Light or dark slab walls by facing direction relative to the sun.
  function shadeWalls() {
    const m = meshes['terrain-sides']; if (!m) return;
    const g = m.geometry, n = g.attributes.normal, N = n.count;
    const col = g.attributes.color || g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(N * 3), 3)).attributes.color;
    const W = pal(stylised() ? view.look : 'field').walls;
    const light = new THREE.Color(W.light), dark = new THREE.Color(W.dark), c = new THREE.Color();
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
    if (LAND.has(mesh.userData.id) && shown.terrain === false) { mesh.material = landAsApron(); return; }
    mesh.material = view.print && mesh.userData.printMaterial ? mesh.userData.printMaterial : lookMaterial(mesh);
  }
  // Terrain off: the model's land is not removed but drawn as land cover in the
  // apron's colours (the apron's own painting, mapped onto the model), so the
  // ground runs on with no hole; with no apron shown, the apron's land colour,
  // flat (JC 26 Nov 2026). Screen only.
  const LAND = new Set(['terrain', 'terrain-steep']);
  const flatLand = {};
  function landAsApron() {
    const m = apron && contextActive() ? apron.modelMaterial() : null;
    if (m) return m;
    const P = PALETTES[view.look], hex = P.carto?.landBase || P.landBase;
    if (!flatLand[hex]) {
      const [r, g, b] = desaturate(hex);
      flatLand[hex] = new THREE.MeshToonMaterial({ color: new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace), gradientMap: toonRamp() });
    }
    return flatLand[hex];
  }
  function applyLand() {
    for (const k of LAND) if (meshes[k]) applyMaterial(meshes[k]);
    if (screenT) screenT.mesh.material = shown.terrain === false ? landAsApron() : screenT.mat;
  }
  function disposeMesh(mesh) {
    mesh.geometry.dispose();
    const mats = [...Object.values(mesh.userData.looks), mesh.userData.printMaterial].filter(Boolean);
    for (const m of mats) {
      if (m.map && !Object.values(drapes).some(d => d.tex === m.map)) m.map.dispose();
      m.dispose();
    }
  }

  // layers: {id: mesh}; colours: {id: '#rrggbb'}; landcover: the drape canvas
  // or null; drapeKind: 'landcover' when it is the land-cover map (the field
  // style redraws that in its own palette), else anything.
  // vectors / screen: the field style's painted routes and screen-only meshes
  // (from buildModel); absent for models from the Python tool.
  // seed: a stable id for the site (Guthrie's brushwork is seeded from it).
  // heights / relief (optional): buildModel's height grid and { base, zExag,
  // minM }, for the Anthropogenic relief and sea; without them it has none.
  function setModel({ layers, colours, landcover, grid, drapeKind: kind = null, vectors: vec = null, screen = {}, seed: siteSeed = null, heights = null, relief = null, waterFill: fill = null }) {
    disposeCarto(true);
    waterFill = fill && heights ? fill : null; waterGrid = grid; waterOrig = null; waterFilled = false; waterCache = {};
    groundAt = heights ? heightSampler(grid, heights) : null;
    heightsGrid = heights && relief ? { grid, heights } : null; reliefMeta = relief; layerColours = colours || {};
    for (const k of Object.keys(meshes)) { inner.remove(meshes[k]); disposeMesh(meshes[k]); delete meshes[k]; }
    for (const k of Object.keys(shown)) delete shown[k];
    props?.dispose(); props = null;
    if (dc) { inner.remove(dc.group); dc.dispose(); } dc = null; dcCut = null;
    geology?.dispose(); geology = null;
    pits?.dispose(); pits = null;
    apron?.dispose(); apron = null; apronEdge = null;
    vectors = vec; modelSize = { Wmm: grid.Wmm, Hmm: grid.Hmm, mmPerM: grid.mmPerM };
    seed = seedFrom(siteSeed ?? `${grid.Wmm.toFixed(3)}x${grid.Hmm.toFixed(3)}`);
    setDrapeTextures(landcover, kind);
    span = Math.max(grid.Wmm, grid.Hmm); modelWmm = grid.Wmm; modelHmm = grid.Hmm;
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
        // own geometry (flat walls, or the geology walls).
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
    ctxInner.position.copy(inner.position);
    ground.scale.set(span * 8, span * 8, 1);
    setSun();
    setHeightScale(view.heightScale);
    setView('oblique', false);
  }

  // Swap the drape on the land top (land cover or satellite) without rebuilding.
  function setDrapeTextures(canvas, kind) {
    for (const k of Object.keys(drapes)) { drapes[k].tex.dispose(); delete drapes[k]; }
    drapeRaw = canvas; drapeKind = kind;
    delete cartoCache.base; drapeVersion++;
  }
  function repaintDrapes() { for (const look of Object.keys(drapes)) paintDrape(look); if (cartoActive()) paintCartoDrape(); }
  // kind: 'landcover' for the land-cover map, else anything (see setModel).
  function setDrape(canvas, kind = null) {
    setDrapeTextures(canvas, kind);
    for (const id of ['terrain', 'terrain-base']) {
      const m = meshes[id]; if (!m) continue;
      for (const [look, mat] of Object.entries(m.userData.looks)) {
        if (id === 'terrain-base') continue;      // flat colour
        if (lookDef(look).carto && vectors) continue;   // painted on the screen terrain instead
        const t = lookDrape(look);
        mat.map = t;
        mat.color.set(t ? 0xffffff : PALETTES[look].landBase);
        mat.needsUpdate = true;
      }
    }
    if (cartoActive()) paintCartoDrape();
  }

  // ---- Proposed data centre (brief v2; screen only) ----
  // plan: from datacentre-math.js planDatacentre, or null. Built off; showDatacentre turns it on.
  function setDatacentre(plan, { on = false } = {}) {
    showDatacentre(false);
    if (dc) { inner.remove(dc.group); dc.dispose(); dc = null; }
    if (!plan || (!plan.items.length && !plan.zones.length)) return null;
    dc = createDatacentre(plan, { look: PALETTES[view.look] });
    dc.group.traverse(o => { if (o.isMesh || o.isLineSegments) o.layers.enable(DC_LAYER); });   // drawn again over the ink
    dc.group.visible = false; inner.add(dc.group);
    if (groundAt) dc.placeLabels(groundAt);
    if (on) showDatacentre(true);
    return dc.counts;
  }
  // On: the buildings shown, and the screen terrain cut to each platform where
  // it is higher. The print arrays are never written: the land top gets its own
  // copy of the positions first (as painted water does), and every vertex the
  // cut lowers is recorded so turning it off puts it back exactly.
  // Trees inside a proposed building are hidden while it is shown (trees are
  // drawn taller than true height, so they would stand through its roof).
  function dcTreeMask() { props?.setTreeMask?.(dcOn && dc ? (x, y) => insideItems(dc.plan.items, x, y) : null); }
  function showDatacentre(on) {
    on = !!on && !!dc;
    if (on === dcOn) return;
    dcOn = on;
    if (dc) dc.group.visible = on;
    dcTreeMask();
    if (on) { dcCut = { changed: null, screen: null }; dcRecut(); if (screenT) cutScreenTerrain(); }
    else if (dcCut) {
      dcUncut();
      if (screenT && dcCut.screen) {
        const a = screenT.mesh.geometry.attributes.position;
        restoreTerrain(a.array, dcCut.screen); a.needsUpdate = true; screenT.mesh.geometry.computeVertexNormals();
      }
      dcCut = null;
    }
    paintField();
  }
  // The land top's cut, taken out (returns whether it was in) and put back,
  // so painted water's fill and the screen terrain always start from the uncut land.
  function dcUncut() {
    const terr = meshes.terrain;
    if (!dcCut?.changed || !terr) return false;
    const a = terr.geometry.attributes.position;
    restoreTerrain(a.array, dcCut.changed); dcCut.changed = null;
    a.needsUpdate = true; terr.geometry.computeVertexNormals();
    return true;
  }
  function dcRecut() {
    const terr = meshes.terrain;
    if (!dcCut || dcCut.changed || !terr || !dc.plan.items.length) return;
    if (!terr.userData.ownPositions) {
      const copy = new THREE.BufferAttribute(Float32Array.from(terr.geometry.attributes.position.array), 3);
      terr.geometry.setAttribute('position', copy);
      meshes['terrain-base']?.geometry.setAttribute('position', copy);     // the underside shares it
      terr.userData.ownPositions = true;
    }
    const a = terr.geometry.attributes.position;
    dcCut.changed = cutTerrain(a.array, dc.plan.items);
    a.needsUpdate = true; terr.geometry.computeVertexNormals();
  }
  // Anthropogenic's smoothed land: cut the same way (its own arrays).
  function cutScreenTerrain() {
    if (!dcCut || !screenT || dcCut.screen) return;
    const a = screenT.mesh.geometry.attributes.position;
    dcCut.screen = cutTerrain(a.array, dc.plan.items); a.needsUpdate = true; screenT.mesh.geometry.computeVertexNormals();
  }
  const datacentreInfo = () => (dc ? { on: dcOn, ...dc.counts, cutVertices: dcCut?.changed ? dcCut.changed.length / 2 : 0 } : null);

  // ---- Looks ----
  // Switch the look (materials, ink colour, background) without rebuilding any geometry.
  function setLook(look) {
    if (!LOOKS[look] || look === view.look) return;
    view.look = look;
    INK.colour = PALETTES[look].ink;
    if (carto && !lookDef(look).carto) { carto.tex?.dispose(); carto.tex = null; screenT && (screenT.mat.map = null); }   // free the GPU copy
    for (const m of Object.values(meshes)) applyMaterial(m);
    props?.setLook(look); geology?.setLook(look); dc?.setLook(PALETTES[look]);
    refreshVisibility();
    paintField();
    setBackground(PALETTES[look].background);
    setSun();
    controls.update();
  }
  // Guthrie's brushwork texture on or off (it adds no information).
  function setBrushwork(on) { view.brushwork = !!on; paintField(); }
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



  // ---- 3D props (trees, turbines, pylons and lines; screen only) ----
  // props: the bundle's props section; heights and grid from buildModel.
  function setProps(section, { grid, heights, zExag = 2, seed: s = null } = {}) {
    props?.dispose(); props = null;
    propsSection = section || null; disposeGlyphs(); delete cartoCache.trees; if (carto) carto.key = null;
    if (!section || !grid || !heights) { refreshVisibility(); return null; }
    props = createProps({ props: section, grid, heights, zExag, seed: seedFrom(s ?? 'props'), ramp: toonRamp });
    inner.add(props.group);
    props.setLook(view.look);
    dcTreeMask();
    for (const k of Object.keys(propShown)) propShown[k] = true;
    refreshVisibility();
    return props.counts;
  }
  // ---- geology walls (subsurface section; screen only) ----
  // Returns true when the bundle had wall samples. `on` sets the toggle.
  function setGeology(sub, { grid, zExag = 2, on = geologyOn } = {}) {
    geology?.dispose(); geology = null;
    const walls = meshes['terrain-sides'];
    if (sub && walls && grid) {
      geology = createGeology({ sub, walls: walls.geometry, grid, zExag, palettes: PALETTES, evidence: EVIDENCE, ink: PALETTES.field.ink, labels: geologyLabels });
      if (geology) { inner.add(geology.mesh); geology.setLook(view.look); geology.shade(sun.position); }
    }
    geologyOn = on;
    refreshVisibility();
    return !!geology;
  }
  // ---- pits on the surface (BGS BritPits; screen only) ----
  function setPits(sub, { grid, heights, on = pitsOn } = {}) {
    pits?.dispose(); pits = null;
    const terr = meshes.terrain;
    if (sub && grid && heights && terr) {
      pitsMeta = { attribution: sub.attribution, nonCommercial: !!sub.nonCommercial, sub };
      pits = createPits({ sub, grid, heights, terrain: terr.geometry.attributes.position.array, coal: EVIDENCE.coal });
      if (pits) inner.add(pits.group);
    }
    pitsOn = on; pits?.setVisible(on); pits?.setLabels(labelsOn);
    repaintDrapes();
    return pits ? { ...pits.counts, labels: pits.labels } : null;
  }
  function showPits(on) { pitsOn = !!on; pits?.setVisible(pitsOn); repaintDrapes(); }
  // One class of pit on or off: 'coal', 'unknown' or 'quarry'.
  function showPitClass(cls, on) { pits?.setShown(cls, on); pits?.setVisible(pitsOn); repaintDrapes(); }
  function showBoundary(on) { boundaryOn = !!on; if (painted() || cartoActive()) paintField(); }
  function showGeology(on) { geologyOn = !!on; refreshVisibility(); }
  function setGeologyLabels(on) { geologyLabels = on && typeof on === 'object' ? { geology: !!on.geology, bgs: !!on.bgs } : { geology: !!on, bgs: !!on }; geology?.setLabels(geologyLabels); }
  function setPropsVisible(kind, on) {
    propShown[kind] = on; props?.setVisible(kind, on); glyphs?.setVisible(kind, on); refreshVisibility();
    if (kind === 'trees' && cartoActive()) paintCartoDrape();      // crowns are painted
  }
  function setTreeFactor(k) { props?.setTreeFactor(k); }

  function setVisible(id, on) {
    for (const k of [id, `${id}Disused`, `${id}-sides`, `${id}-base`]) shown[k] = on;
    // Electricity, in three groups: Generation (with the wind turbines),
    // Storage, and Transmission (with the pylons, poles and overhead lines:
    // 3D props and the Anthropogenic glyphs). 'power' sets all three.
    if (id === 'power') for (const g of ['generation', 'storage', 'transmission']) shown[g] = on;
    const propsOf = { generation: ['turbines'], transmission: ['pylons', 'lines'], power: ['turbines', 'pylons', 'lines'] }[id] || [];
    for (const k of propsOf) { propShown[k] = on; props?.setVisible(k, on); glyphs?.setVisible(k, on); }
    // "Soil sides" hides the side walls and the flat base. The steep faces are
    // ground (hiding them left holes in the land), so they stay.
    if (id === 'terrain-sides') shown['terrain-base'] = on;
    refreshVisibility();
    if (['roads', 'rail', 'power', 'residues', 'generation', 'storage', 'transmission'].includes(id) && painted()) paintField();
    else if (id === 'water' && waterPainted()) paintField();
    else if (['water', 'buildings', 'receptors'].includes(id) && cartoActive()) paintField();
  }

  function setView(name, animate = true) {
    const d = span * 1.95;
    const views = { oblique: [0.55, 0.62, 0.85], reverse: [-0.55, 0.62, -0.85], low: [0.25, 0.18, 1.0], top: [0, 1, 0.0001] };
    let v = new THREE.Vector3(...(views[name] || views.oblique)).normalize().multiplyScalar(d);
    const target = new THREE.Vector3(0, H * 0.3, 0);
    if (stylised()) {
      // Hold the elevation within FIELD's range, then fit the model to the view.
      const sph = new THREE.Spherical().setFromVector3(v), deg = THREE.MathUtils.degToRad;
      sph.phi = THREE.MathUtils.clamp(sph.phi, deg(90 - FIELD.maxEl), deg(90 - minElNow));
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
  function setInkWidth(px) { INK.lineWidth = THREE.MathUtils.clamp(+px || 0.8, 0.5, 3); view.inkWidth = INK.lineWidth; }

  // Camera angles as seen from the model's centre, in degrees: az is the
  // compass bearing the camera stands at (clockwise from north), el its
  // height above the horizon. Used for shareable view URLs.
  function cameraAngles() {
    const v = camera.position.clone().sub(controls.target), r = v.length() || 1;
    const az = THREE.MathUtils.radToDeg(Math.atan2(v.x, -v.z));
    return { az: (az + 360) % 360, el: THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(v.y / r, -1, 1))) };
  }
  function setCameraAngles(azDeg, elDeg) {
    // (just short of 90°: straight down leaves the camera's up direction undefined)
    const az = THREE.MathUtils.degToRad(azDeg), el = THREE.MathUtils.degToRad(Math.min(89.9, elDeg));
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    camera.position.copy(fitPosition(dir, controls.target));
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
  function setHeightScale(k) { model.scale.set(1, 1, k); ctxModel.scale.set(1, 1, k); view.heightScale = k; }

  const BACKGROUNDS = {
    sky: () => gradient([[0, '#7fa6c9'], [0.55, '#c9d9e4'], [1, '#e9e4da']]),
    studio: () => gradient([[0, '#d9d6cf'], [1, '#a9a59c']]),
    white: () => new THREE.Color(0xffffff),
    guthrie: () => gradient(PALETTES.guthrie.sky),
    dark: () => gradient([[0, '#2b2e33'], [1, '#141518']]),
    clear: () => null,
  };
  function setBackground(name) {
    view.background = name;
    if (scene.background?.isTexture) scene.background.dispose();
    scene.background = (BACKGROUNDS[name] || BACKGROUNDS.sky)();
    ground.material.opacity = stylised() ? FIELD.groundShadow : name === 'dark' ? 0.45 : 0.28;
    refreshApron();
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
    if (changed) { refreshVisibility(); paintField(); }
  }
  function setShadow(on) { ground.visible = on; }
  INK.colour = PALETTES[view.look].ink; setBackground(view.background);   // the default look

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

  // Turbine rotors turn slowly in the live view and follow the orbit angle
  // in GIF/video frames (so loops are seamless); single grabs show them still.
  const clock = new THREE.Clock();
  const loop = () => { controls.update(); if (props?.counts.turbines) props.setRotor(props.rotorPhase + Math.min(clock.getDelta(), 0.1) * 0.6); draw(); };
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
  let orbitRotor = 0;
  function orbitStart(aspect = camera.aspect) {
    orbitRotor = props?.rotorPhase || 0;
    const k = Math.max(1, camera.aspect / aspect);
    orbitBase = { offset: camera.position.clone().sub(controls.target).multiplyScalar(k), pos: camera.position.clone() };
  }
  function orbitTo(angle) {
    const v = orbitBase.offset.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), angle);
    camera.position.copy(controls.target).add(v); camera.lookAt(controls.target);
    if (props) props.setRotor(orbitRotor + angle * 6);      // six whole rotor turns per lap: seamless loops
  }
  function orbitEnd() { if (orbitBase) camera.position.copy(orbitBase.pos); camera.lookAt(controls.target); orbitBase = null; }

  return { renderer, scene, camera, controls, view, meshes, focalMm, setContext, showContext, showEnergy, showLabels, get labelsOn() { return labelsOn; }, contextInfo, showScaleBar, get scaleBarOn() { return scaleOn; }, get apron() { return apron; }, setModel, setDrape, setLook, setVisible, setView, setSpin,
    cameraAngles, setCameraAngles, setInkWidth, setBrushwork,
    setSun, setFov, setHeightScale, setBackground, setPrintColours, setScreenColours, setShadow, grab,
    pause, resume, renderAt, orbitStart, orbitTo, orbitEnd, setCarto, setMist, setContours, lookNotes, cartoInfo, electricity, setGeology, showGeology, setGeologyLabels, setPits, showPits, showPitClass, get geology() { return (geology || pits) && { walls: !!geology, panel: geology?.panel, on: geologyOn, shown: !!geology?.mesh.visible || (!!pits && pitsOn && pits.anyShown), attribution: geology?.attribution ?? pitsMeta.attribution, sub: geology?.sub ?? pitsMeta.sub, instance: geology, nonCommercial: geology ? geology.nonCommercial : pitsMeta.nonCommercial }; }, setProps, setPropsVisible, setTreeFactor, get props() { return props; }, get pits() { return pits; }, setDatacentre, showDatacentre, datacentreInfo, showBoundary, get boundaryOn() { return boundaryOn; }, get datacentreOn() { return dcOn; } };
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

// Redraw a land-cover canvas (in place) in another palette: each pixel takes the target
// colour of the nearest source colour (so anti-aliased edges and JPEG noise
// in an offline viewer's drape map cleanly).
function paletteMap(to, from = { landBase: LAND_BASE, landcover: LANDCOVER_COLOURS }) {
  const pairs = [[from.landBase, to.landBase], ...Object.entries(from.landcover).map(([k, c]) => [c, to.landcover[k]])];
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

// A recoloured copy for the carto drape: nearest palette colour, and base
// land for anything further than 30 (RGB distance) from every colour.
function recolourCopy(src, map) {
  const c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(src, 0, 0);
  const id = g.getImageData(0, 0, c.width, c.height); recolourData(id.data, map, 900); g.putImageData(id, 0, 0);
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
