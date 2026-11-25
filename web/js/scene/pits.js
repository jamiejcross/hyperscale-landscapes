// Historic mines and quarries on the surface (subsurface brief, Stage 3):
// a 50 m square per BGS BritPits point painted into the land drape (a
// symbol, not a footprint or hazard zone), and one floating label per pit
// name with thin threads down to each of its squares. Labels are laid out in
// screen space so they never cover the land or each other. Screen only.
import * as THREE from 'three';
import { heightSampler } from './props-math.js';
import { PIT_SQUARE_M, DEFAULT_PIT_SHOW, displayClass, groupPits, layoutLabels, silhouette } from './pits-math.js';

const FONT = 'DejaVu Sans, Helvetica, Arial, sans-serif';
const LABEL_PX = 28, LABEL_PX_DENSE = 20;    // label height on screen, CSS px (smaller above 8 labels)
const PALE = 'rgba(255,250,236,0.97)', CREAM = '#fff7e3', CREAM2 = '#e9d8a8', EDGE = '#f3e6c4';

// sub: bundle subsurface section; grid, heights: from buildModel;
// terrain: the terrain mesh's position array (for the screen silhouette).
export function createPits({ sub, grid, heights, terrain, coal = '#15110e' }) {
  const all = sub?.pits || [];
  if (!all.length) return null;
  const mmPerM = grid.mmPerM, zAt = heightSampler(grid, heights);
  const group = new THREE.Group(); group.name = 'pits';
  const threadMat = new THREE.LineBasicMaterial({ color: coal, transparent: true, opacity: 0.85, depthTest: true });
  const show = { ...DEFAULT_PIT_SHOW }; let labels = [], lastKey = '';
  const topPts = [];
  for (let i = 0; i < terrain.length; i += 3 * 7) topPts.push(new THREE.Vector3(terrain[i], terrain[i + 1], terrain[i + 2]));

  function build() {
    for (const L of labels) { L.sp.material.map.dispose(); L.sp.material.dispose(); L.lines.geometry.dispose(); }
    group.clear(); labels = []; lastKey = '';
    for (const g of groupPits(all, { show })) {
      const pts = g.pits.map(p => { const x = p.x * mmPerM, y = p.y * mmPerM; return [x, y, zAt(x, y)]; });
      const cx = g.cx * mmPerM, cy = g.cy * mmPerM;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(g), depthTest: false, depthWrite: false, sizeAttenuation: false }));
      sp.center.set(0.5, 0); sp.renderOrder = 10; sp.userData.aspect = sp.material.map.image.width / sp.material.map.image.height;
      sp.position.set(cx, cy, Math.max(...pts.map(p => p[2])) + 10);
      const pos = new Float32Array(pts.length * 6);
      pts.forEach(([x, y, z], i) => pos.set([x, y, z + 0.05, cx, cy, sp.position.z], i * 6));
      const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const lines = new THREE.LineSegments(lg, threadMat); lines.renderOrder = 9;
      group.add(lines, sp);
      labels.push({ g, sp, lines, cx, cy });
    }
  }
  function labelTexture(g) {
    const coalLabel = g.cls === 'coal', c0 = document.createElement('canvas').getContext('2d');
    c0.font = `bold 44px ${FONT}`; const w1 = c0.measureText(g.name).width;
    c0.font = `30px ${FONT}`; const w2 = c0.measureText(g.note).width;
    const cv = document.createElement('canvas'); cv.width = Math.ceil(Math.max(w1, w2)) + 40; cv.height = 112;
    const c = cv.getContext('2d');
    c.fillStyle = coalLabel ? coal : PALE; c.fillRect(0, 0, cv.width, cv.height);
    c.strokeStyle = coalLabel ? EDGE : coal; c.lineWidth = 5; if (!coalLabel) c.setLineDash([14, 8]);
    c.strokeRect(2.5, 2.5, cv.width - 5, cv.height - 5); c.setLineDash([]);
    c.fillStyle = coalLabel ? CREAM : coal; c.font = `bold 44px ${FONT}`; c.fillText(g.name, 20, 50);
    c.fillStyle = coalLabel ? CREAM2 : '#5a5248'; c.font = `30px ${FONT}`; c.fillText(g.note, 20, 92);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = true;
    return t;
  }

  // The squares, painted into a drape canvas covering the W x H mm plate.
  function paint(g2, { Wmm, Hmm }) {
    const W = g2.canvas.width, H = g2.canvas.height, k = W / Wmm, half = PIT_SQUARE_M * mmPerM / 2 * k;
    const px = 1 / 1024 * W;                   // "2 px" on a 1024 px drape, scaled with the drape
    g2.save();
    for (const p of all) {
      const cls = displayClass(p);
      if (!show[cls]) continue;
      const x = p.x * mmPerM * k, y = (1 - p.y * mmPerM / Hmm) * H;
      if (cls === 'coal') {
        g2.fillStyle = 'rgba(255,250,236,0.95)'; g2.fillRect(x - half - 2 * px, y - half - 2 * px, 2 * half + 4 * px, 2 * half + 4 * px);
        g2.fillStyle = coal; g2.fillRect(x - half, y - half, 2 * half, 2 * half);
      } else {
        g2.fillStyle = 'rgba(255,250,236,0.8)'; g2.fillRect(x - half, y - half, 2 * half, 2 * half);
        g2.strokeStyle = coal; g2.lineWidth = 2 * px;
        if (cls !== 'quarry') g2.setLineDash([4 * px, 3 * px]);
        g2.strokeRect(x - half, y - half, 2 * half, 2 * half); g2.setLineDash([]);
      }
    }
    g2.restore();
  }

  // Screen layout for the current camera and canvas (CSS px). Cheap to call
  // every frame: it does nothing unless the camera, size or model moved.
  const v = new THREE.Vector4(), M = new THREE.Matrix4();
  function layout(camera, size, inner) {
    if (!group.visible || !labels.length) return;
    inner.updateMatrixWorld(true); camera.updateMatrixWorld();
    const key = [...camera.matrixWorld.elements, ...camera.projectionMatrix.elements, ...inner.matrixWorld.elements, size.x, size.y].map(n => n.toFixed(5)).join();
    if (key === lastKey) return;
    lastKey = key;
    const W = size.x, H = size.y;
    M.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(inner.matrixWorld);
    // [x px, y px, w]; w <= 0 means behind the camera
    const scr = (x, y, z) => { v.set(x, y, z, 1).applyMatrix4(M); return [(v.x / v.w + 1) / 2 * W, (1 - v.y / v.w) / 2 * H, v.w]; };
    const silTop = silhouette(topPts.map(p => scr(p.x, p.y, p.z)).filter(q => q[2] > 0), W, H);
    // sprites without size attenuation: scale.y = pixel height x 2 / (P11 x H)
    const px = labels.length > 8 ? LABEL_PX_DENSE : LABEL_PX;
    const P11 = camera.projectionMatrix.elements[5], sy = px * 2 / (P11 * H);
    const items = labels.map(L => ({ ax: scr(L.cx, L.cy, 0)[0], hpx: px, wpx: px * L.sp.userData.aspect }));
    const boxes = layoutLabels(items, silTop, { width: W, pad: px > 24 ? 6 : 4, sep: px > 24 ? 8 : 5 });
    labels.forEach((L, i) => {
      L.sp.scale.set(sy * L.sp.userData.aspect, sy, 1);
      L.sp.center.set(0.5 - boxes[i].shift / items[i].wpx, 0);     // slid to stay in frame
      // binary-search the z whose projection sits at the label's bottom
      let lo = -50, hi = 2000;
      for (let n = 0; n < 40; n++) { const mid = (lo + hi) / 2, q = scr(L.cx, L.cy, mid); if (q[2] > 0 && q[1] > boxes[i].bottom) lo = mid; else hi = mid; }
      const z = (lo + hi) / 2;
      L.sp.position.z = z;
      const pa = L.lines.geometry.attributes.position;
      for (let j = 1; j < pa.count; j += 2) pa.setZ(j, z);
      pa.needsUpdate = true; L.lines.geometry.computeBoundingSphere();
    });
  }

  // Draw one class (coal, unknown, quarry) or not.
  function setShown(cls, on) { if (cls in show && show[cls] !== !!on) { show[cls] = !!on; build(); } }
  function setVisible(on) { group.visible = !!on; lastKey = ''; }
  function dispose() {
    for (const L of labels) { L.sp.material.map.dispose(); L.sp.material.dispose(); L.lines.geometry.dispose(); }
    threadMat.dispose(); group.removeFromParent();
  }
  build();
  const counts = {
    coal: all.filter(p => displayClass(p) === 'coal').length, unknown: all.filter(p => displayClass(p) === 'unknown').length,
    quarry: all.filter(p => displayClass(p) === 'quarry').length,
  };
  return { group, paint, layout, setShown, setVisible, dispose, counts,
    get labels() { return labels.length; }, get shown() { return { ...show }; },
    get anyShown() { return Object.entries(show).some(([k, v]) => v && counts[k]); } };
}
