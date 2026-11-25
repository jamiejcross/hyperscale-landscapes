// 2.5D glyphs for the Anthropogenic look (brief Stage 4): pylons, poles and
// wind turbines as upright sprites that stand on their point and face the
// camera, each with a small contact shadow on the ground. Screen only.
//
// Heights: pylons and poles at their recorded height (site bundle) or 42 m,
// times 1.3 for legibility (the caption says so); turbines at hub height plus
// rotor radius from the data, or 125 m, flagged as assumed.
import * as THREE from 'three';

const ART = {
  pylon: { w: 128, h: 256, draw(c, w, h, ink, C) {
    c.lineJoin = c.lineCap = 'round';
    const top = h * 0.06, base = h - 6, bw = w * 0.36, tw = w * 0.07, cx = w / 2;
    c.fillStyle = C.pylonFill; c.beginPath(); c.moveTo(cx - tw, top); c.lineTo(cx + tw, top); c.lineTo(cx + bw, base); c.lineTo(cx - bw, base); c.closePath(); c.fill();
    c.strokeStyle = ink; c.lineWidth = 5; c.stroke();
    c.lineWidth = 3;
    for (let i = 0; i < 5; i++) {                         // five bays of cross-bracing
      const y0 = top + (base - top) * i / 5, y1 = top + (base - top) * (i + 1) / 5, x0 = tw + (bw - tw) * i / 5, x1 = tw + (bw - tw) * (i + 1) / 5;
      c.beginPath(); c.moveTo(cx - x0, y0); c.lineTo(cx + x1, y1); c.moveTo(cx + x0, y0); c.lineTo(cx - x1, y1); c.stroke();
    }
    c.lineWidth = 5;
    for (const [yy, ww] of [[0.2, 0.42], [0.36, 0.34]]) {   // two cross-arms with insulator stubs
      c.beginPath(); c.moveTo(cx - w * ww, h * yy); c.lineTo(cx + w * ww, h * yy);
      c.moveTo(cx - w * ww, h * yy); c.lineTo(cx - w * ww, h * yy + 14); c.moveTo(cx + w * ww, h * yy); c.lineTo(cx + w * ww, h * yy + 14); c.stroke();
    }
  } },
  pole: { w: 64, h: 256, draw(c, w, h, ink, C) {
    c.lineJoin = c.lineCap = 'round'; const cx = w / 2;
    c.fillStyle = C.pylonFill; c.strokeStyle = ink; c.lineWidth = 5;
    c.beginPath(); c.moveTo(cx - 4, h * 0.08); c.lineTo(cx + 4, h * 0.08); c.lineTo(cx + 6, h - 6); c.lineTo(cx - 6, h - 6); c.closePath(); c.fill(); c.stroke();
    c.beginPath(); c.moveTo(cx - w * 0.4, h * 0.14); c.lineTo(cx + w * 0.4, h * 0.14); c.stroke();
  } },
  turbine: { w: 256, h: 384, draw(c, w, h, ink, C) {
    c.lineCap = c.lineJoin = 'round'; const cx = w / 2, hub = h * 0.33, R = w * 0.44;
    c.fillStyle = C.turbineFill; c.strokeStyle = ink; c.lineWidth = 5;
    c.beginPath(); c.moveTo(cx - 6, hub); c.lineTo(cx + 6, hub); c.lineTo(cx + 13, h - 6); c.lineTo(cx - 13, h - 6); c.closePath(); c.fill(); c.stroke();
    for (let i = 0; i < 3; i++) {
      const a = -Math.PI / 2 + 0.35 + i * 2 * Math.PI / 3, ex = cx + Math.cos(a) * R, ey = hub + Math.sin(a) * R, nx = -Math.sin(a) * 9, ny = Math.cos(a) * 9;
      c.beginPath(); c.moveTo(cx, hub);
      c.quadraticCurveTo(cx + Math.cos(a) * R * 0.3 + nx, hub + Math.sin(a) * R * 0.3 + ny, ex, ey);
      c.quadraticCurveTo(cx + Math.cos(a) * R * 0.5 - nx * 0.3, hub + Math.sin(a) * R * 0.5 - ny * 0.3, cx, hub);
      c.fill(); c.stroke();
    }
    c.beginPath(); c.arc(cx, hub, 9, 0, Math.PI * 2); c.fill(); c.stroke();
  } },
};
// Where the artwork's base sits in its texture (fraction of height from the bottom).
const FOOT = { pylon: 6 / 256, pole: 6 / 256, turbine: 6 / 384 };

// points: from glyphPoints(); zAt(x, y): the displayed ground height (mm).
export function createGlyphs({ points, zAt, ink, C, anisotropy = 8 }) {
  const group = new THREE.Group(); group.name = 'glyphs';
  const tex = {}, mats = {}, byKind = { pylon: [], pole: [], turbine: [] };
  for (const [kind, A] of Object.entries(ART)) {
    if (!points.some(p => p.kind === kind)) continue;
    const cv = document.createElement('canvas'); cv.width = A.w; cv.height = A.h;
    A.draw(cv.getContext('2d'), A.w, A.h, ink, C);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = anisotropy;
    tex[kind] = t;
    mats[kind] = new THREE.SpriteMaterial({ map: t, transparent: true, alphaTest: 0.05, fog: true });
  }
  const shadowMat = new THREE.MeshBasicMaterial({ color: C.glyphShadow, transparent: true, opacity: 0.28, depthWrite: false });
  const disc = new THREE.CircleGeometry(1, 16);
  for (const p of points) {
    const A = ART[p.kind], z = zAt(p.x, p.y);
    const sp = new THREE.Sprite(mats[p.kind]);
    sp.center.set(0.5, FOOT[p.kind]); sp.scale.set(p.hMm * A.w / A.h, p.hMm, 1);
    sp.position.set(p.x, p.y, z); sp.renderOrder = 2;
    const sh = new THREE.Mesh(disc, shadowMat);
    const r = p.hMm * 0.18; sh.scale.set(r, r, 1);
    sh.position.set(p.x + p.hMm * 0.08, p.y + p.hMm * 0.08, z + 0.03); sh.renderOrder = 1;
    group.add(sh, sp); byKind[p.kind].push(sp, sh);
  }
  // pylons and poles share the "pylons" toggle in the layer key
  function setVisible(kind, on) {
    for (const k of kind === 'pylons' ? ['pylon', 'pole'] : kind === 'turbines' ? ['turbine'] : []) for (const o of byKind[k]) o.visible = on;
  }
  function dispose() {
    for (const t of Object.values(tex)) t.dispose();
    for (const m of Object.values(mats)) m.dispose();
    shadowMat.dispose(); disc.dispose();
    group.clear();
  }
  return { group, setVisible, dispose };
}
