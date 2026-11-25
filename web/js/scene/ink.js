// Ink outlines for the field style (written for this project on plain
// three.js; no third-party post-processing code).
//
// After the colour render, the scene is drawn again into an outline target:
// RGB holds the view-space normal and A an object ID (set per mesh as
// userData.inkId), with the depth buffer kept as a texture. A full-screen
// quad then looks at a ring of 8 neighbours around each pixel and inks the
// pixel if any of them is across an edge (see ink-math.js for the rules).
//
// Line width is in CSS pixels at any pixel ratio: the ring radius is half
// the width times the render's pixel ratio. Below a ratio of 2 the outline
// target is drawn at 2 samples per CSS pixel and read bilinearly, which
// smooths the steps along long diagonal slab edges.
import * as THREE from 'three';
import { EDGE, TERRAIN_ID, ringRadius, outlineScale } from './ink-math.js';

export const INK = { colour: '#221d18', strength: 1.0, lineWidth: 1.8 };

const f = v => v.toFixed(4);

const OUTLINE_VERT = /* glsl */`
#include <common>
#include <skinning_pars_vertex>
varying vec3 vN;
void main() {
  vec3 nrm = normal; vec4 pos = vec4(position, 1.0);
#ifdef USE_INSTANCING
  nrm = mat3(instanceMatrix) * nrm; pos = instanceMatrix * pos;
#endif
  vN = normalize(normalMatrix * nrm);
  gl_Position = projectionMatrix * modelViewMatrix * pos;
}`;
const OUTLINE_FRAG = /* glsl */`
uniform float inkId;
varying vec3 vN;
void main() {
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  gl_FragColor = vec4(n * 0.5 + 0.5, inkId * 16.0 / 255.0);   // IDs 16 levels apart, robust to dithering
}`;

const QUAD_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const QUAD_FRAG = /* glsl */`
uniform sampler2D tOutline;
uniform sampler2D tDepth;
uniform vec2 texel;          // 1 / outline target size
uniform float radius;        // ring radius, outline-target texels
uniform float soft;          // anti-aliasing band, outline-target texels
uniform float near, far;
uniform vec3 ink;
uniform float strength;
varying vec2 vUv;

float invZ(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  if (d >= 1.0) return 0.0;                          // background
  return (far - d * (far - near)) / (near * far);    // 1 / view z
}
vec4 S(vec2 uv) { return texture2D(tOutline, uv); }

// Edge strength seen from the centre with the ring at radius r.
float edgeAt(float r) {
  vec4 c = S(vUv);
  vec3 nc = c.xyz * 2.0 - 1.0;
  float wc = invZ(vUv);
  bool onTerrain = abs(c.a * 255.0 / 16.0 - ${TERRAIN_ID}.0) < 0.5;
  float e = 0.0;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.7853982;
    vec2 o = vec2(cos(a), sin(a)) * r * texel;
    vec4 s = S(vUv + o);
    // a. object change (IDs, incl. background = 0)
    if (abs(s.a - c.a) > 8.0 / 255.0) e = 1.0;
    // c. crease
    vec3 ns = s.xyz * 2.0 - 1.0;
    float crease = smoothstep(${f(EDGE.creaseLow)}, ${f(EDGE.creaseHigh)}, 1.0 - dot(nc, ns)) * ${f(EDGE.creaseStrength)};
    if (!onTerrain) e = max(e, crease);
    // b. depth discontinuity, from the opposite pair (4 pairs in all)
    if (i < 4) {
      float wa = invZ(vUv + o), wb = invZ(vUv - o);
      float m = max(max(wa, wb), wc);
      if (m > 0.0) e = max(e, smoothstep(${f(EDGE.depthLow)}, ${f(EDGE.depthHigh)}, abs(wa + wb - 2.0 * wc) / m));
    }
  }
  return e;
}

void main() {
  // Full strength within the inner ring; a soft rim out to the outer ring.
  float inner = edgeAt(max(radius - soft, 0.5));
  float outer = edgeAt(radius);
  float a = max(inner, outer * 0.5) * strength;
  if (a < 0.003) discard;
  gl_FragColor = vec4(ink, a);
}`;

export function createInk(renderer) {
  const size = new THREE.Vector2();
  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.UnsignedByteType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  target.depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType);
  const outlineMat = new THREE.ShaderMaterial({
    vertexShader: OUTLINE_VERT, fragmentShader: OUTLINE_FRAG,
    uniforms: { inkId: { value: 0 } }, blending: THREE.NoBlending, side: THREE.DoubleSide,
  });
  // Each mesh writes its own ID: set just before it is drawn.
  const setId = function (r, s, c, g, material) {
    if (material !== outlineMat) return;
    outlineMat.uniforms.inkId.value = this.userData.inkId ?? 15;
    outlineMat.uniformsNeedUpdate = true;
  };
  const quadMat = new THREE.ShaderMaterial({
    vertexShader: QUAD_VERT, fragmentShader: QUAD_FRAG, transparent: true, depthTest: false, depthWrite: false,
    uniforms: {
      tOutline: { value: target.texture }, tDepth: { value: target.depthTexture },
      texel: { value: new THREE.Vector2() }, radius: { value: 1 }, soft: { value: 1 }, near: { value: 1 }, far: { value: 1000 },
      ink: { value: new THREE.Vector3() },   // sRGB, written straight to the output
      strength: { value: 1 },
    },
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), quadMat);
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene(); quadScene.add(quad);
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // Draw ink over whatever was just rendered to the current target.
  // `hide`: objects left out of the outline pass (the shadow-catcher ground).
  function render(scene, camera, { hide = [] } = {}) {
    const out = renderer.getRenderTarget();
    const pr = out ? 1 : renderer.getPixelRatio();
    if (out) size.set(out.width, out.height); else renderer.getDrawingBufferSize(size);
    const k = outlineScale(pr);
    const tw = Math.round(size.x * k), th = Math.round(size.y * k);
    if (target.width !== tw || target.height !== th) target.setSize(tw, th);

    // Outline pass: normals + IDs + depth, no background, no shadow-map update.
    const bg = scene.background, override = scene.overrideMaterial, autoClear = renderer.autoClear;
    const shadowAuto = renderer.shadowMap.autoUpdate, vis = hide.map(o => o.visible);
    const clearColour = renderer.getClearColor(new THREE.Color()), clearAlpha = renderer.getClearAlpha();
    scene.traverse(o => { if (o.isMesh && o.onBeforeRender !== setId) o.onBeforeRender = setId; });
    scene.background = null; scene.overrideMaterial = outlineMat; renderer.shadowMap.autoUpdate = false;
    hide.forEach(o => { o.visible = false; });
    renderer.setRenderTarget(target); renderer.setClearColor(0x8080ff, 0); renderer.clear();
    renderer.render(scene, camera);
    hide.forEach((o, i) => { o.visible = vis[i]; });
    scene.background = bg; scene.overrideMaterial = override; renderer.shadowMap.autoUpdate = shadowAuto;
    renderer.setClearColor(clearColour, clearAlpha);

    // Composite the ink over the colour render.
    const U = quadMat.uniforms;
    U.texel.value.set(1 / tw, 1 / th);
    U.radius.value = Math.max(0.75, ringRadius(INK.lineWidth, pr) * k);
    U.soft.value = 0.75 * k;      // anti-aliasing band: 0.75 device px at any ratio
    U.near.value = camera.near; U.far.value = camera.far;
    U.ink.value.set(...[1, 3, 5].map(i => parseInt(INK.colour.slice(i, i + 2), 16) / 255));
    U.strength.value = INK.strength;
    renderer.setRenderTarget(out);
    renderer.autoClear = false;
    renderer.render(quadScene, quadCam);
    renderer.autoClear = autoClear;
  }

  function dispose() { target.depthTexture.dispose(); target.dispose(); outlineMat.dispose(); quadMat.dispose(); quad.geometry.dispose(); }
  return { render, dispose };
}
