// Runtime of the downloadable offline viewer (one self-contained HTML file,
// in the form of JC's Mossmorran viewer). It reads the model from the
// #terrain-data script tag, decodes the gzipped geometry, and uses the same
// scene, studio and caption code as the web app.
import { createScene } from 'hl/scene';
import { mountStudio } from 'hl/studio';

const D = JSON.parse(document.getElementById('terrain-data').textContent);
const $ = id => document.getElementById(id);

// ---- geometry: base64 -> gzip -> typed arrays (layout: name -> [offset, bytes, type])
const bin = Uint8Array.from(atob(D.geom), c => c.charCodeAt(0));
const buf = await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
const T = { float32: Float32Array, uint32: Uint32Array };
const arr = k => { const [o, n, t] = D.layout[k]; const C = T[t]; return new C(buf, o, n / C.BYTES_PER_ELEMENT); };
const layers = {};
for (const id of D.layers) layers[id] = { positions: arr(`${id}_p`), indices: arr(`${id}_i`) };
const insert = D.layout.site_p ? { positions: arr('site_p'), indices: arr('site_i') } : null;

// ---- scene
const scene = createScene($('view'));
const drape = D.drape ? await new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = D.drape; }) : null;
scene.setModel({ layers, insert, colours: D.colours, grid: D.grid, landcover: drape && toCanvas(drape) });
function toCanvas(img) { const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d').drawImage(img, 0, 0); return c; }

// ---- panel: title, layers, studio, caption
document.title = D.caption.title;
$('title').textContent = D.caption.title;
$('sub').textContent = D.sub;
const ul = $('layers');
for (const L of D.legend) {
  const li = document.createElement('li');
  li.innerHTML = `<label class="check"><input type="checkbox" checked data-layer="${L.id}"><span class="swatch" style="background:${L.colour}"></span>${L.name}</label>
    <details><summary>Why this matters</summary><p>${L.why}</p></details>`;
  ul.append(li);
}
ul.querySelectorAll('input').forEach(i => { i.onchange = () => scene.setVisible(i.dataset.layer, i.checked); });

const exag = () => {
  const k = scene.view.heightScale, z = D.zExag, r = v => +v.toFixed(2);
  return k === 1 ? D.caption.disclosure : `Height exaggerated ×${r(z * k)}; buildings ×${r(k)}`;
};
const caption = () => ({ ...D.caption, disclosure: exag(), top: D.caption.top.replace(D.caption.disclosure, exag()) });
const studio = mountStudio($('studio'), scene, {
  caption, filename: () => `${D.slug}-${new Date().toISOString().slice(0, 10)}`,
  printColours: () => D.printColours, alt: () => D.alt,
  onChange: () => { $('caption').textContent = `${exag()}. ${D.caption.sources}. ${D.caption.footer}.`; },
});
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
$('loading').remove();
window.__ready = true;
