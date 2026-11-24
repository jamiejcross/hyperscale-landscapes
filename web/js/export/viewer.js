// Build the downloadable offline viewer: one HTML file with Three.js, the
// viewer code and the model inlined. Modules are mapped to data: URLs via an
// import map, so the file runs from disk with no server and no internet.
import { gzipSync } from '../../vendor/fflate.js';
import { fontFaceCSS } from '../fonts.js';

const MODULES = {
  three: 'vendor/three/three.module.min.js',
  'three/addons/OrbitControls.js': 'vendor/three/addons/OrbitControls.js',
  'three/addons/RoomEnvironment.js': 'vendor/three/addons/RoomEnvironment.js',
  'hl/scene': 'js/scene/scene.js',
  'hl/studio': 'js/scene/studio.js',
  'hl/caption': 'js/scene/caption.js',
  'hl/turntable': 'js/scene/turntable.js',
  'hl/beforeafter': 'js/scene/beforeafter.js',
  gifenc: 'vendor/gifenc.js',
};

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const dataURL = text => `data:text/javascript;base64,${b64(new TextEncoder().encode(text))}`;

// Relative imports cannot resolve from a data: URL, so point them at the map.
const rewrite = text => text.replaceAll("from './caption.js'", "from 'hl/caption'")
  .replaceAll("from './turntable.js'", "from 'hl/turntable'")
  .replaceAll("from './beforeafter.js'", "from 'hl/beforeafter'");

export async function buildViewer({ model, legend, colours, printColours, caption, sub, drape, zExag, slug, alt }) {
  // Pack every non-empty layer (and the insert) into one gzipped buffer.
  const parts = [], layout = {}, ids = [];
  let offset = 0;
  const add = (key, arr, type) => {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    layout[key] = [offset, bytes.byteLength, type];
    parts.push(bytes); offset += bytes.byteLength;
  };
  for (const [id, m] of Object.entries(model.layers)) {
    if (!m || !m.indices.length) continue;
    ids.push(id);
    add(`${id}_p`, m.positions, 'float32');
    add(`${id}_i`, m.indices, 'uint32');
  }
  if (model.insert) { add('site_p', model.insert.positions, 'float32'); add('site_i', model.insert.indices, 'uint32'); }
  for (const [k, m] of Object.entries(model.before || {}))   // 'today' land for before/after
    if (m?.indices.length) { add(`before_${k}_p`, m.positions, 'float32'); add(`before_${k}_i`, m.indices, 'uint32'); }
  const raw = new Uint8Array(offset);
  let o = 0; for (const p of parts) { raw.set(p, o); o += p.byteLength; }
  const geom = b64(gzipSync(raw, { level: 9 }));

  const D = {
    schema: 'hyperscale-landscapes/viewer@1',
    layers: ids, layout, geom,
    grid: { Wmm: model.grid.Wmm, Hmm: model.grid.Hmm },
    colours, printColours, legend, caption, sub, zExag, slug, alt,
    drape: drape ? drape.toDataURL('image/jpeg', 0.85) : null,
  };

  const [template, ...sources] = await Promise.all([
    fetch('viewer.html').then(r => r.text()),
    ...Object.values(MODULES).map(p => fetch(p).then(r => r.text())),
    fetch('js/viewer/main.js').then(r => r.text()),
  ]);
  const main = sources.pop();
  const fontCSS = await fontFaceCSS();
  const imports = Object.fromEntries(Object.keys(MODULES).map((k, i) => [k, dataURL(rewrite(sources[i]))]));
  const html = template
    .replace('<!--FONTS-->', () => `<style>${fontCSS}</style>`)
    .replace('<!--IMPORTMAP-->', () => `<script type="importmap">${JSON.stringify({ imports })}</script>`)
    .replace('<!--DATA-->', () => `<script id="terrain-data" type="application/json">${JSON.stringify(D).replace(/</g, '\\u003c')}</script>`)
    .replace('<!--MAIN-->', () => `<script type="module">\n${main}\n</script>`);
  return new Blob([html], { type: 'text/html' });
}
