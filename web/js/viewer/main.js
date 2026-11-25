// Runtime of the downloadable offline viewer (one self-contained HTML file,
// in the form of JC's Mossmorran viewer). It reads the model from the
// #terrain-data script tag, decodes the gzipped geometry, and uses the same
// scene, studio and caption code as the web app.
import { createScene, layerSwatch } from 'hl/scene';
import { mountStudio } from 'hl/studio';
import { parseView, urlWriter } from 'hl/urlstate';
import { PALETTES } from 'hl/palettes';

const D = JSON.parse(document.getElementById('terrain-data').textContent);
const $ = id => document.getElementById(id);

// ---- geometry: base64 -> gzip -> typed arrays (layout: name -> [offset, bytes, type])
const bin = Uint8Array.from(atob(D.geom), c => c.charCodeAt(0));
const buf = await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
const T = { float32: Float32Array, uint32: Uint32Array };
const arr = k => { const [o, n, t] = D.layout[k]; const C = T[t]; return new C(buf, o, n / C.BYTES_PER_ELEMENT); };
const layers = {}, screen = {};
for (const id of D.layers) layers[id] = { positions: arr(`${id}_p`), indices: arr(`${id}_i`) };
for (const id of D.screen || []) screen[id] = { positions: arr(`screen:${id}_p`), indices: arr(`screen:${id}_i`) };
const vectors = D.layout.vectors
  ? JSON.parse(new TextDecoder().decode(new Uint8Array(buf, D.layout.vectors[0], D.layout.vectors[1]))) : null;

// ---- scene
const scene = createScene($('view'));
const drape = D.drape ? await new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = D.drape; }) : null;
scene.setModel({ layers, colours: D.colours, grid: D.grid, landcover: drape && toCanvas(drape), drapeKind: D.drapeKind, vectors, screen, seed: D.seed ?? D.slug });
function toCanvas(img) { const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d').drawImage(img, 0, 0); return c; }

// ---- panel: title, layers, studio, caption
document.title = D.caption.title;
$('title').textContent = D.caption.title;
$('sub').textContent = D.sub;
const ul = $('layers');
for (const L of D.legend) {
  const li = document.createElement('li');
  li.innerHTML = `<label class="check"><input type="checkbox" checked data-layer="${L.id}"><span class="swatch" data-swatch="${L.id}" data-screen="${L.colour}" style="background:${L.colour}"></span>${L.name}</label>
    <details><summary>Why this matters</summary><p>${L.why}</p></details>`;
  ul.append(li);
}
ul.querySelectorAll('input').forEach(i => { i.onchange = () => scene.setVisible(i.dataset.layer, i.checked); });

const exag = () => {
  const k = scene.view.heightScale, z = D.zExag, r = v => +v.toFixed(2);
  return k === 1 ? D.caption.disclosure : `Height exaggerated ×${r(z * k)}; buildings ×${r(k)}`;
};
const caption = () => ({ ...D.caption, disclosure: exag(), top: D.caption.top.replace(D.caption.disclosure, exag()) });
// Shareable view: ?style=&az=&el= (camera angles), read on load and kept up
// to date as the view changes.
const writeUrl = urlWriter(() => { const a = scene.cameraAngles(); return { style: scene.view.look, az: a.az, el: a.el }; });
const studio = mountStudio($('studio'), scene, {
  caption, filename: () => `${D.slug}-${new Date().toISOString().slice(0, 10)}`,
  printColours: () => D.printColours, alt: () => D.alt,
  onChange: () => {
    const note = PALETTES[scene.view.look]?.captionNote;
    $('caption').textContent = `${exag()}. ${D.caption.sources}. ${D.caption.footer}${note ? ` · ${note}` : ''}.`; writeUrl();
    document.querySelectorAll('.swatch[data-swatch]').forEach(s => { s.style.background = layerSwatch(s.dataset.swatch, scene.view.look, s.dataset.screen); });
  },
});
{
  const v = parseView(location.search);
  if (typeof D.view?.brushwork === 'boolean') studio.setBrushwork(D.view.brushwork);
  if (v.style || D.view?.look) studio.setLook(v.style || D.view.look);
  if (v.az != null || v.el != null) { const a = scene.cameraAngles(); scene.setCameraAngles(v.az ?? a.az, v.el ?? a.el); }
  scene.controls.addEventListener('change', writeUrl);
}
$('attr').textContent = D.caption.sources;

// ---- keys (as in the Mossmorran viewer): H hide panel, C clean view, P save PNG
addEventListener('keydown', e => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  const k = e.key.toLowerCase();
  if (k === 'h') document.body.classList.toggle('hidden');
  if (k === 'c') document.body.classList.toggle('clean');
  if (k === 'p') studio.grab();
});
$('showui').onclick = () => document.body.classList.remove('hidden');
// Keep the model centred in the space beside the panel (as in the Mossmorran viewer).
function offsetView() {
  const panel = document.body.classList.contains('hidden') || document.body.classList.contains('clean') ? 0 : $('panel').offsetWidth;
  const cam = scene.camera, w = innerWidth, h = innerHeight;
  if (panel && w > 700) cam.setViewOffset(w, h, -panel / 2, 0, w, h); else cam.clearViewOffset();
  cam.updateProjectionMatrix();
}
new MutationObserver(offsetView).observe(document.body, { attributes: true, attributeFilter: ['class'] });
addEventListener('resize', offsetView);
offsetView();
$('loading').remove();
window.__scene = scene;   // for automated checks
window.__ready = true;
