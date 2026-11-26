// Build the downloadable offline viewer: one HTML file with Three.js, the
// viewer code and the model inlined. Modules are mapped to data: URLs via an
// import map, so the file runs from disk with no server and no internet.
import { gzipSync } from '../../vendor/fflate.js';
import { fontFaceCSS } from '../fonts.js';

export const MODULES = {
  three: 'vendor/three/three.module.min.js',
  'three/addons/OrbitControls.js': 'vendor/three/addons/OrbitControls.js',
  'hl/scene': 'js/scene/scene.js',
  'hl/palettes': 'js/scene/palettes.js',
  'hl/ink': 'js/scene/ink.js',
  'hl/ink-math': 'js/scene/ink-math.js',
  'hl/overlays': 'js/scene/overlays.js',
  'hl/urlstate': 'js/urlstate.js',
  'hl/studio': 'js/scene/studio.js',
  'hl/caption': 'js/scene/caption.js',
  'hl/turntable': 'js/scene/turntable.js',
  'hl/props': 'js/scene/props.js',
  'hl/props-math': 'js/scene/props-math.js',
  'hl/geology': 'js/scene/geology.js',
  'hl/geology-math': 'js/scene/geology-math.js',
  'hl/pits': 'js/scene/pits.js',
  'hl/pits-math': 'js/scene/pits-math.js',
  'hl/subsurface-info': 'js/scene/subsurface-info.js',
  'hl/extras': 'js/scene/extras.js',
  'hl/export/walls': 'js/export/walls.js',
  'hl/data/props': 'js/data/props.js',
  'hl/screenterrain': 'js/scene/screenterrain.js',
  'hl/carto': 'js/scene/carto.js',
  'hl/contours': 'js/scene/contours.js',
  'hl/glyphs': 'js/scene/glyphs.js',
  'hl/scalebar': 'js/scene/scalebar.js',
  'hl/legend': 'js/scene/legend.js',
  'hl/apron': 'js/scene/apron.js',
  'hl/apron-math': 'js/scene/apron-math.js',
  gifenc: 'vendor/gifenc.js',
};
const KEY_OF = Object.fromEntries(Object.entries(MODULES).map(([k, p]) => [p, k]));

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const dataURL = text => `data:text/javascript;base64,${b64(new TextEncoder().encode(text))}`;

// Relative imports cannot resolve from a data: URL, so point each at its
// name in the import map (resolved from the importing module's folder).
// A relative import of a file not in MODULES is an error, not a silent gap.
export function rewrite(text, from) {
  const dir = from.split('/').slice(0, -1);
  return text.replace(/(\bfrom\s*|\bimport\s*)(['"])(\.{1,2}\/[^'"]+)\2/g, (all, kw, q, spec) => {
    const parts = [...dir];
    for (const seg of spec.split('/')) { if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg); }
    const key = KEY_OF[parts.join('/')];
    if (!key) throw new Error(`offline viewer: ${from} imports ${spec}, which is not packed`);
    return `${kw}${q}${key}${q}`;
  });
}

export async function buildViewer({ model, legend, colours, printColours, caption, sub, drape, drapeKind = null, zExag, slug, alt, seed = null, view = null,
  props = null, subsurface = null, context = null, text = {}, relief = null }) {
  // Pack every non-empty layer into one gzipped buffer.
  const parts = [], layout = {}, ids = [];
  let offset = 0;
  const add = (key, arr, type) => {
    // typed arrays must start on a multiple of their element size: pad to 4 bytes
    if (offset % 4) { const pad = 4 - (offset % 4); parts.push(new Uint8Array(pad)); offset += pad; }
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
  // Field style: screen-only meshes and the painted-route vectors.
  const screenIds = [];
  for (const [id, m] of Object.entries(model.screen || {})) {
    if (!m || !m.indices.length) continue;
    screenIds.push(id);
    add(`screen:${id}_p`, m.positions, 'float32');
    add(`screen:${id}_i`, m.indices, 'uint32');
  }
  if (model.vectors) add('vectors', new TextEncoder().encode(JSON.stringify(model.vectors)), 'json');
  // Site extras (screen only): the height grid for placing props and pits,
  // and the bundle's props and subsurface sections as they are.
  // (always packed: the Anthropogenic look's relief, sea and screen terrain need it too)
  if (model.heights) add('heights', model.heights, 'float32');
  if (model.waterFill) add('waterFill', model.waterFill, 'float32');   // painted water's level channels
  if (props) add('props', new TextEncoder().encode(JSON.stringify(props)), 'json');
  if (subsurface) add('subsurface', new TextEncoder().encode(JSON.stringify(subsurface)), 'json');
  // the context apron (screen only): the bundle's context section, with the model bbox it is framed on
  if (context) add('context', new TextEncoder().encode(JSON.stringify(context)), 'json');
  const raw = new Uint8Array(offset);
  let o = 0; for (const p of parts) { raw.set(p, o); o += p.byteLength; }
  const geom = b64(gzipSync(raw, { level: 9 }));

  const D = {
    schema: 'hyperscale-landscapes/viewer@1',
    layers: ids, screen: screenIds, layout, geom,
    grid: Object.fromEntries(['Wmm', 'Hmm', 'mmPerM', 'nx', 'ny', 'dx', 'dy'].map(k => [k, model.grid[k]])), text,
    colours, printColours, legend, caption, sub, zExag, slug, alt, seed, view, relief,
    drape: drape ? drape.toDataURL('image/jpeg', 0.85) : null, drapeKind,
  };

  const [template, ...sources] = await Promise.all([
    fetch('viewer.html').then(r => r.text()),
    ...Object.values(MODULES).map(p => fetch(p).then(r => r.text())),
    fetch('js/viewer/main.js').then(r => r.text()),
  ]);
  const main = sources.pop();
  const fontCSS = await fontFaceCSS();
  const imports = Object.fromEntries(Object.entries(MODULES).map(([k, p], i) => [k, dataURL(rewrite(sources[i], p))]));
  const html = template
    .replace('<!--FONTS-->', () => `<style>${fontCSS}</style>`)
    .replace('<!--IMPORTMAP-->', () => `<script type="importmap">${JSON.stringify({ imports })}</script>`)
    .replace('<!--DATA-->', () => `<script id="terrain-data" type="application/json">${JSON.stringify(D).replace(/</g, '\\u003c')}</script>`)
    .replace('<!--MAIN-->', () => `<script type="module">\n${main}\n</script>`);
  return new Blob([html], { type: 'text/html' });
}
