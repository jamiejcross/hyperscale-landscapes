// Ink outlines for the field style (written for this project on plain
// three.js; no third-party post-processing code).
//
// After the colour render, the scene is drawn once more with every surface
// replaced by its view-space normal, into a render target that also keeps
// the depth buffer. A full-screen quad then finds edges in those two images
// and draws them in ink over the colour render:
//   depth:   creases and silhouettes, from the second difference of 1/z
//            (zero across any flat plane in perspective, so sloping ground
//            seen at a grazing angle does not fill with ink);
//   normals: folds where the surface turns sharply.
// Line width is in CSS pixels: the sampling offset scales with the render's
// pixel ratio, so lines look the same on a 2x display and in 2x-4x grabs.
import * as THREE from 'three';

export const INK = {
  colour: '#221d18', strength: 0.85, depthWeight: 1.0, normalWeight: 0.8, lineWidth: 1.2,
};

const VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const FRAG = /* glsl */`
uniform sampler2D tNormal;
uniform sampler2D tDepth;
uniform vec2 texel;          // 1 / render size
uniform float h;             // sampling offset, device pixels
uniform float near, far;
uniform vec3 ink;
uniform float strength, depthWeight, normalWeight;
varying vec2 vUv;

// 1/z in view space: linear across a plane in screen space.
float invZ(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  float z = near * far / (far - d * (far - near));
  return 1.0 / z;
}
vec3 nrm(vec2 uv) { return texture2D(tNormal, uv).xyz * 2.0 - 1.0; }

void main() {
  vec2 dx = vec2(texel.x * h, 0.0), dy = vec2(0.0, texel.y * h);
  float c = invZ(vUv);
  float l = invZ(vUv - dx), r = invZ(vUv + dx), d = invZ(vUv - dy), u = invZ(vUv + dy);
  float m = max(max(max(c, l), max(r, d)), u);
  // Second differences, relative to the nearest surface sampled.
  float de = max(abs(l + r - 2.0 * c), abs(d + u - 2.0 * c)) / m;
  float depthEdge = smoothstep(0.004, 0.02, de);

  vec3 n = nrm(vUv);
  float ne = 0.0;
  ne = max(ne, 1.0 - dot(n, nrm(vUv - dx)));
  ne = max(ne, 1.0 - dot(n, nrm(vUv + dx)));
  ne = max(ne, 1.0 - dot(n, nrm(vUv - dy)));
  ne = max(ne, 1.0 - dot(n, nrm(vUv + dy)));
  float normalEdge = smoothstep(0.18, 0.45, ne);

  float a = clamp(depthWeight * depthEdge + normalWeight * normalEdge, 0.0, 1.0) * strength;
  if (a < 0.003) discard;
  gl_FragColor = vec4(ink, a);
}`;

export function createInk(renderer) {
  const size = new THREE.Vector2();
  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.UnsignedByteType });
  target.depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType);
  const normalMat = new THREE.MeshNormalMaterial();
  const quadMat = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthTest: false, depthWrite: false,
    uniforms: {
      tNormal: { value: target.texture }, tDepth: { value: target.depthTexture },
      texel: { value: new THREE.Vector2() }, h: { value: 1 }, near: { value: 1 }, far: { value: 1000 },
      ink: { value: new THREE.Vector3() },   // sRGB, written straight to the output
      strength: { value: 0 }, depthWeight: { value: 0 }, normalWeight: { value: 0 },
    },
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), quadMat);
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene(); quadScene.add(quad);
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // Draw ink over whatever was just rendered to the current target.
  // `hide`: objects left out of the outline pass (the shadow-catcher ground).
  function render(scene, camera, { hide = [] } = {}) {
    renderer.getDrawingBufferSize(size);
    const out = renderer.getRenderTarget();
    if (out) size.set(out.width, out.height);
    if (target.width !== size.x || target.height !== size.y) target.setSize(size.x, size.y);

    // Outline pass: normals + depth, no background, no shadow-map update.
    const bg = scene.background, override = scene.overrideMaterial, autoClear = renderer.autoClear;
    const shadowAuto = renderer.shadowMap.autoUpdate, vis = hide.map(o => o.visible);
    const clearColour = renderer.getClearColor(new THREE.Color()), clearAlpha = renderer.getClearAlpha();
    scene.background = null; scene.overrideMaterial = normalMat; renderer.shadowMap.autoUpdate = false;
    hide.forEach(o => { o.visible = false; });
    renderer.setRenderTarget(target); renderer.setClearColor(0x8080ff, 1); renderer.clear();
    renderer.render(scene, camera);
    hide.forEach((o, i) => { o.visible = vis[i]; });
    scene.background = bg; scene.overrideMaterial = override; renderer.shadowMap.autoUpdate = shadowAuto;
    renderer.setClearColor(clearColour, clearAlpha);

    // Composite the ink over the colour render.
    const U = quadMat.uniforms, pr = out ? 1 : renderer.getPixelRatio();
    U.texel.value.set(1 / size.x, 1 / size.y);
    U.h.value = Math.max(0.5, INK.lineWidth * pr / 2);
    U.near.value = camera.near; U.far.value = camera.far;
    U.ink.value.set(...[1, 3, 5].map(i => parseInt(INK.colour.slice(i, i + 2), 16) / 255)); U.strength.value = INK.strength;
    U.depthWeight.value = INK.depthWeight; U.normalWeight.value = INK.normalWeight;
    renderer.setRenderTarget(out);
    renderer.autoClear = false;
    renderer.render(quadScene, quadCam);
    renderer.autoClear = autoClear;
  }

  function dispose() { target.depthTexture.dispose(); target.dispose(); normalMat.dispose(); quadMat.dispose(); quad.geometry.dispose(); }
  return { render, dispose };
}
