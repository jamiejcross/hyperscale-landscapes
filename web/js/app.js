// App controller: pick -> size and style -> preview -> download.
import { loadStrings, t } from './i18n.js';
import { CELL_MM, LIMITS, MAX_COLS } from './config.js';
import { allCoords, bboxOfCoords, bboxSizeKm } from './geo.js';
import { createPicker } from './picker.js';
import { listSites, loadSite } from './data/sites.js';
import { fetchOSM, parseOSM } from './data/overpass.js';
import { loadElevation, ATTRIBUTION as ELEV_ATTRIBUTION } from './data/elevation.js';
import { readBoundary } from './data/upload.js';
import { buildModel, printObjects, pauseHeights } from './geom/model.js';
import { createScene, landcoverCanvas } from './scene/scene.js';
import { contourCanvas } from './scene/contours.js';
import { SURFACES, imageryCanvas } from './data/imagery.js';
import { mountStudio } from './scene/studio.js';
import { buildViewer } from './export/viewer.js';
import { computeSection, sectionSVG, svgToPNG } from './export/section.js';
import { fontFaceCSS } from './fonts.js';
import { captionLines, altText as draftAlt } from './scene/caption.js';
import { write3MF } from './export/threemf.js';
import { writeSTL } from './export/stl.js';
import { parseView, urlWriter } from './urlstate.js';

const $ = id => document.getElementById(id);
const OSM_ATTR = '© OpenStreetMap contributors';
const state = { bbox: null, name: '', site: null, bundle: null, model: null, layers: {}, presets: {}, surface: 'eox-2025' };
let scene = null, studio = null;

// Shareable view URL (?site=&style=&az=&el=). A view in the address bar on
// load is applied once the first model is built.
let pendingView = parseView(location.search);
const writeUrl = urlWriter(() => {
  const v = { site: state.site ? $('site-select').value || null : null };
  if (scene) {
    const a = scene.cameraAngles();
    Object.assign(v, { style: scene.view.look, az: a.az, el: a.el });
  }
  return v;
});

await loadStrings();
state.layers = Object.fromEntries((await (await fetch('data/layers.json')).json()).layers.map(l => [l.id, l]));
for (const id of ['power-and-place', 'residues', 'full', 'classic']) {
  state.presets[id] = await (await fetch(`data/presets/${id}.json`)).json();
  $('preset').append(new Option(state.presets[id].name, id, id === 'power-and-place', id === 'power-and-place'));
}

// ---------------- Step 1: choose an area ----------------
const picker = createPicker($('map'), {
  onBBox: b => setBBox(b),
  onSection: line => drawSection(line),
});

function setBBox(b, { name = '', site = null, bundle = null } = {}) {
  state.bbox = b; state.name = name; state.site = site; state.bundle = bundle;
  const { w, h } = bboxSizeKm(b);
  const area = $('area');
  const tooLarge = w * h > LIMITS.maxAreaKm2 || Math.max(w, h) > LIMITS.maxSideKm;
  area.textContent = tooLarge ? t('pick.toolarge', { w: w.toFixed(1), h: h.toFixed(1) })
    : t('pick.area', { w: w.toFixed(2), h: h.toFixed(2) }) + (Math.max(w, h) > LIMITS.warnSideKm ? ` ${t('pick.large')}` : '');
  area.classList.toggle('error', tooLarge);
  $('build').disabled = tooLarge;
  const f = $('coords').elements;
  f.minLat.value = b.minLat.toFixed(5); f.maxLat.value = b.maxLat.toFixed(5);
  f.minLon.value = b.minLon.toFixed(5); f.maxLon.value = b.maxLon.toFixed(5);
  writeUrl();
}

// Curated sites: one dropdown, grouped by council, and a short fact panel.
const SITES = await listSites();
const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
{
  const sel = $('site-select'), groups = {};
  for (const s of SITES) (groups[s.local_authority || 'Other'] ||= []).push(s);
  for (const [la, list] of Object.entries(groups)) {
    const og = document.createElement('optgroup'); og.label = la;
    for (const s of list) og.append(new Option(s.status ? `${s.name} (${s.status})` : s.name, s.id));
    sel.append(og);
  }
  sel.onchange = () => { const s = SITES.find(x => x.id === sel.value); if (s) chooseSite(s); };
}

async function chooseSite(entry) {
  $('site-select').value = entry.id;
  const { site, bundle } = await loadSite(entry);
  const p = site.properties, bb = p.model_bbox;
  picker.showBBox({ minLat: bb.min_lat, maxLat: bb.max_lat, minLon: bb.min_lon, maxLon: bb.max_lon });
  setBBox(state.bbox, { name: p.name, site, bundle });
  if (p.location) picker.showPin(p.location, p.name);
  const row = (k, v) => v == null || v === '' ? '' : `<dt>${k}</dt><dd>${v}</dd>`;
  const by = p.reported_by ? ` (reported by ${esc(p.reported_by)})` : '';
  const links = (p.sources || []).map(x => `<a href="${esc(x.url)}" rel="noopener" target="_blank">${esc(x.title)}</a>`).join('<br>');
  $('site-facts').hidden = false;
  $('site-facts').innerHTML = `<strong>${esc(p.name)}</strong><dl>
    ${row('Developer', p.developer ? esc(p.developer) + by : null)}
    ${row('Capacity', p.stated_capacity_mw != null ? `${p.stated_capacity_mw} MW${by}` : null)}
    ${row('Grid connection', p.grid_connection_mw != null ? `${p.grid_connection_mw} MW${by}` : null)}
    ${row('Site area', p.stated_site_area_ha != null ? `${p.stated_site_area_ha} ha${by}` : null)}
    ${row('Planning stage', p.status ? esc(p.status) : 'not stated')}
    ${row('Council', esc(p.local_authority))}
  </dl><p>${esc(p.notes)}</p><p class="hint">${esc(p.verification || '')} The marker shows the reported location. Model area: ${esc(p.model_bbox_note || 'a box around the site')}</p><p>${links}</p>`;
}

$('search').onsubmit = async e => {
  e.preventDefault();
  const ul = $('results'); ul.textContent = '';
  try {
    for (const r of await picker.search($('q').value)) {
      const li = document.createElement('li'), b = document.createElement('button');
      b.type = 'button'; b.textContent = r.name;
      b.onclick = () => { picker.goTo(r.lat, r.lon); state.name = r.name.split(',')[0]; };
      li.append(b); ul.append(li);
    }
    if (!ul.children.length) ul.textContent = 'No places found.';
  } catch (err) { ul.textContent = err.message; }
};

$('draw-box').onclick = () => { picker.setMode('box'); $('draw-finish').hidden = true; };
$('draw-poly').onclick = () => { picker.setMode('polygon'); $('draw-finish').hidden = false; };
$('draw-finish').onclick = () => { if (picker.finishPolygon()) $('draw-finish').hidden = true; };

$('upload').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const gj = await readBoundary(f);
    picker.showBBox(bboxOfCoords(allCoords(gj), 300));
    state.name = f.name.replace(/\.(geo)?json|\.kmz?$/i, '');
  } catch (err) { $('area').textContent = err.message; }
};
$('coords').onsubmit = e => {
  e.preventDefault();
  const f = e.target.elements;
  picker.showBBox({ minLat: +f.minLat.value, maxLat: +f.maxLat.value, minLon: +f.minLon.value, maxLon: +f.maxLon.value });
};

// ---------------- Step 2: size and style ----------------
const exagNote = () => { $('exag-note').textContent = t('size.exag.note', { x: $('options').elements.zExag.value }); };
$('options').elements.zExag.onchange = exagNote; exagNote();

$('options').onsubmit = async e => {
  e.preventDefault();
  const o = e.target.elements, status = $('build-status');
  status.classList.remove('error');
  $('build').disabled = true;
  try {
    const opts = {
      printSize: +o.printSize.value, zExag: +o.zExag.value, buildingExag: 1, base: 5,
      roads: 'major-residential', pegs: true, cellMm: CELL_MM, maxCols: MAX_COLS,
    };
    status.textContent = t('build.loading.elevation');
    const elev = await loadElevation(state.bbox, state.bundle);
    status.textContent = t('build.loading.features');
    const raw = state.bundle?.osm || await fetchOSM(state.bbox, host => { status.textContent = `${t('build.loading.features')} (${host})`; });
    const osm = parseOSM(raw);
    status.textContent = t('build.loading.geometry');
    await new Promise(r => setTimeout(r, 30));
    const sources = { elevation: elev.attribution, features: OSM_ATTR };
    opts.labels = [
      [state.name || 'Terrain model', 6.0],
      [t('caption.exag', { x: opts.zExag }), 3.6],
      [`${elev.short}; ${OSM_ATTR}`, 3.6],
      [`Made ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} with Hyperscale Landscapes`, 3.6],
    ];
    const model = buildModel({ bbox: state.bbox, elev, osm, opts });
    state.model = { model, osm, opts, sources, elev, form: Object.fromEntries(new FormData(e.target)) };
    state.section = null; picker.showSection(null); $('section-figure').textContent = '';
    showPreview();
    const objs = printObjects(model, state.presets[o.preset.value]).filter(x => x.mesh.indices.length);
    status.textContent = t('build.done', { objects: objs.length, buildings: model.report.counts.buildings + model.report.counts.receptors });
  } catch (err) {
    console.error(err);
    status.classList.add('error');
    status.textContent = t('build.error', { message: err.message });
  } finally { $('build').disabled = false; }
};

// The elevation credit follows the source actually used (LiDAR or Terrarium).
const elevAttr = () => state.model?.elev?.attribution || ELEV_ATTRIBUTION;

// ---------------- Step 3: preview ----------------
function showPreview() {
  const { model, osm, opts, form } = state.model;
  $('preview').hidden = false; $('export').hidden = false;
  if (!scene) {
    scene = createScene($('view'));
    studio = mountStudio($('studio'), scene, {
      caption: () => captionLines({ name: state.name, exaggeration: exaggerationText(), sources: sourcesText() }),
      filename: () => `${slug()}-${new Date().toISOString().slice(0, 10)}`,
      printColours: printColourMap,
      alt: () => draftAlt({ name: state.name, report: state.model.model.report, exaggeration: exaggerationText(), surface: SURFACES[state.surface].label.toLowerCase() }),
      onChange: () => { refreshCaption(); writeUrl(); },
    });
    scene.controls.addEventListener('change', writeUrl);
  }
  const colours = Object.fromEntries(Object.values(state.layers).map(l => [l.id, l.colour_screen]));
  colours.railDisused = state.layers.rail.colour_screen_disused;
  state.drape = landcoverCanvas(model.grid, osm.features);
  scene.setModel({ layers: model.layers, colours, grid: model.grid, landcover: state.drape, drapeKind: 'landcover', vectors: model.vectors, screen: model.screen });
  const ul = $('layer-list'); ul.textContent = '';
  const shown = ['terrain', 'water', 'buildings', 'roads', 'rail', 'power', 'residues', 'receptors'];
  for (const id of shown) {
    const L = state.layers[id];
    const li = document.createElement('li');
    li.innerHTML = `<label class="check"><input type="checkbox" checked data-layer="${id}"><span class="swatch" style="background:${L.colour_screen}"></span>${L.name}</label>
      <details><summary>${t('preview.why')}</summary><p>${L.why}</p></details>`;
    ul.append(li);
  }
  ul.querySelectorAll('input').forEach(i => { i.onchange = () => scene.setVisible(i.dataset.layer, i.checked); });
  const counts = model.report.counts;
  studio.update();
  if (pendingView) {           // a view from a shared link, applied once
    const { style, az, el } = pendingView; pendingView = null;
    if (style) studio.setLook(style);
    if (az != null || el != null) { const a = scene.cameraAngles(); scene.setCameraAngles(az ?? a.az, el ?? a.el); }
  }
  writeUrl();
  scene.renderer.domElement.setAttribute('aria-label', altText(model, osm));
  $('caption').textContent = captionText(opts, form) + ` Counts: ${counts.buildings} buildings, ${counts.receptors} schools, care or community buildings, ${counts.roads} roads.`;
  $('pauses').textContent = 'Single-colour printers: pause to change filament at ' +
    pauseHeights(model, opts.base).map(p => `${p.zMm} mm (${p.changeTo})`).join(', ') + '.';
  if (state.surface !== 'landcover') applySurface(state.surface);
  $('preview').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

// The disclosed exaggeration is always what is on screen: the model's own
// factor times the studio's "extra height" (which also scales buildings).
function exaggerationText() {
  const k = scene?.view.heightScale ?? 1, z = state.model.opts.zExag;
  const r = v => +v.toFixed(2);
  return k === 1 ? t('caption.exag', { x: r(z) }) : `Height exaggerated ×${r(z * k)}; buildings ×${r(k)}`;
}
function sourcesText() {
  const sat = SURFACES[state.surface]?.attribution;
  return [elevAttr(), `Map data ${OSM_ATTR}`, sat].filter(Boolean).join('; ');
}
function printColourMap() {
  const preset = state.presets[$('options').elements.preset.value];
  const map = {};
  for (const o of preset.objects) for (const l of o.layers) map[l] = o.colour;
  return map;
}
function refreshCaption() {
  if (!state.model) return;
  const counts = state.model.model.report.counts;
  $('caption').textContent = captionText(state.model.opts, state.model.form) + ` Counts: ${counts.buildings} buildings, ${counts.receptors} schools, care or community buildings, ${counts.roads} roads.`;
}

function captionText(opts, form, { print = false } = {}) {
  // Print files state the model's own exaggeration; the studio's extra height is view-only.
  const exag = print ? t('caption.exag', { x: opts.zExag }) : exaggerationText();
  const src = print ? [elevAttr(), `Map data ${OSM_ATTR}`].join('; ') : sourcesText();
  let s = `${state.name || 'Terrain model'}. ${exag}. ${src}. Generated ${new Date().toISOString().slice(0, 10)}.`;
  return s;
}

function altText(model, osm) {
  const f = model.report.features;
  const n = (layer, pred = () => true) => Object.entries(f[layer] || {}).filter(([k]) => pred(k)).reduce((s, [, v]) => s + v, 0);
  return `3D model of ${state.name || 'the chosen area'}, height exaggerated. ` +
    `${model.report.counts.buildings + model.report.counts.receptors} buildings, ` +
    `${n('power', k => k.startsWith('substation'))} substations, ${n('power', k => k.startsWith('line'))} high-voltage lines, ` +
    `${n('residues')} industrial residue features, ${n('rail', k => /disused/.test(k))} disused railways.`;
}

// ---------------- Surface: land cover, contours or satellite ----------------
for (const [id, s] of Object.entries(SURFACES)) $('surface').append(new Option(s.label, id, id === state.surface, id === state.surface));
async function applySurface(id) {
  const { model, osm, opts, form } = state.model;
  const note = $('surface-note');
  state.surface = id;
  const roads = state.layers.roads.colour_screen;
  // Dark roads disappear into a photograph; draw them light over satellite.
  scene.setScreenColours({ roads: SURFACES[id]?.layer ? '#f2f2f2' : roads });
  try {
    if (id === 'landcover') {
      scene.setDrape(state.drape = landcoverCanvas(model.grid, osm.features), 'landcover');
      note.textContent = '';
    } else if (id === 'contours') {
      const c = contourCanvas(model.grid, state.model.elev);
      scene.setDrape(state.drape = c.canvas);
      note.textContent = `Contours every ${c.interval} m; heavier line every ${c.indexInterval} m. Drawn from the elevation data used for the model.`;
    } else {
      note.textContent = 'Loading satellite imagery from EOX…';
      const img = await imageryCanvas(id, state.bbox, model.grid);
      if (state.surface !== id || state.model?.model !== model) return;   // the choice changed while loading
      scene.setDrape(state.drape = img);
      note.textContent = SURFACES[id].note;
    }
  } catch (err) {
    note.textContent = `${id === 'contours' ? 'Contours' : 'Satellite imagery'} could not be ${id === 'contours' ? 'drawn' : 'loaded'} (${err.message}). Showing land cover instead.`;
    state.surface = 'landcover'; $('surface').value = 'landcover';
    scene.setScreenColours({ roads });
    scene.setDrape(state.drape = landcoverCanvas(model.grid, osm.features), 'landcover');
  }
  refreshCaption();
}
$('surface').onchange = e => applySurface(e.target.value);


// ---------------- Step 4: download ----------------
function slug() { return (state.name || 'terrain').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'terrain'; }
function save(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

$('dl-3mf').onclick = async () => {
  const { model, opts, form } = state.model;
  const btn = $('dl-3mf'); btn.disabled = true;
  try {
    const preset = state.presets[$('options').elements.preset.value];
    const parts = printObjects(model, preset).map(o => ({ ...o }));
    const blob = await write3MF({
      title: state.name || 'Terrain model', parts,
      metadata: {
        Designer: 'Hyperscale Landscapes (browser)',
        Description: captionText(opts, form, { print: true }),
        Copyright: `${elevAttr()}; Map data ${OSM_ATTR}`,
        LicenseTerms: 'Map data ODbL 1.0',
        CreationDate: new Date().toISOString().slice(0, 10),
      },
    });
    save(blob, `${slug()}-${preset.id}.3mf`);
  } finally { btn.disabled = false; }
};
$('dl-stl').onclick = () => {
  const { model } = state.model;
  const ids = ['terrain', 'water', 'buildings', 'receptors', 'roads', 'rail', 'railDisused', 'power', 'residues'];
  save(writeSTL(ids.map(i => model.layers[i]), `Hyperscale Landscapes: ${state.name}`.slice(0, 79)), `${slug()}.stl`);
};
$('dl-viewer').onclick = async () => {
  const { model, opts, form } = state.model;
  const btn = $('dl-viewer'), info = $('viewer-info');
  btn.disabled = true; info.textContent = 'Packing the viewer…';
  try {
    const colours = Object.fromEntries(Object.values(state.layers).map(l => [l.id, l.colour_screen]));
    colours.railDisused = state.layers.rail.colour_screen_disused;
    const shown = ['terrain', 'water', 'buildings', 'roads', 'rail', 'power', 'residues', 'receptors']
      .filter(id => model.layers[id]?.indices.length);
    const legend = shown.map(id => ({ id, name: state.layers[id].name, colour: state.layers[id].colour_screen, why: state.layers[id].why }));
    const { w, h } = bboxSizeKm(state.bbox);
    const caption = captionLines({ name: state.name, exaggeration: t('caption.exag', { x: opts.zExag }), sources: sourcesText() });
    const blob = await buildViewer({
      model, legend, colours, printColours: printColourMap(), caption, zExag: opts.zExag, slug: slug(),
      sub: `${state.bbox.minLat.toFixed(3)}–${state.bbox.maxLat.toFixed(3)}°N, ${Math.abs(state.bbox.maxLon).toFixed(3)}–${Math.abs(state.bbox.minLon).toFixed(3)}°W · ${w.toFixed(1)} × ${h.toFixed(1)} km · from the ${opts.printSize} mm print model`,
      drape: state.drape, drapeKind: state.surface === 'landcover' ? 'landcover' : state.surface,
      alt: draftAlt({ name: state.name, report: model.report, exaggeration: t('caption.exag', { x: opts.zExag }), surface: SURFACES[state.surface].label.toLowerCase() }),
    });
    save(blob, `${slug()}-viewer.html`);
    const mb = blob.size / 1e6;
    info.textContent = `${mb.toFixed(1)} MB${mb > 8 ? ' (large for email: choose a smaller area or a smaller print size)' : ' (fine to email)'}.`;
  } catch (err) { console.error(err); info.textContent = `Could not build the viewer: ${err.message}`; }
  finally { btn.disabled = false; }
};
// ---------------- Cross-section ----------------
$('section-draw').onclick = () => {
  if (!state.model) return;
  picker.setMode('section'); $('draw-finish').hidden = false;
  $('section-status').textContent = 'Click points along the line on the map, then press "Finish" under the drawing tools.';
  $('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
};
function sectionCaption(vex) {
  return captionLines({ name: state.name,
    exaggeration: vex === 1 ? 'Profile at true vertical scale (not exaggerated)' : `Profile height exaggerated ×${vex}`,
    sources: [elevAttr(), `Map data ${OSM_ATTR}`].join('; ') });
}
function drawSection(line) {
  $('draw-finish').hidden = true;
  const { model, osm, opts, elev } = state.model;
  const sec = computeSection({ line, bbox: state.bbox, elev, osm });
  state.section = sec;
  renderSection();
  $('section-panel').open = true;
  $('section-panel').scrollIntoView({ behavior: 'smooth' });
  const n = sec.items;
  $('section-status').textContent = `${(sec.length / 1000).toFixed(2)} km; crosses ${n.buildings.length} buildings, ${n.points.length} roads, railways, watercourses or power lines.`;
}
async function renderSection() {
  if (!state.section) return;
  const fontCSS = await fontFaceCSS();
  const vex = +$('section-vex').value;
  state.sectionSVG = sectionSVG(state.section, { vex, caption: sectionCaption(vex), fontCSS });
  $('section-figure').innerHTML = state.sectionSVG;
  $('section-svg').disabled = $('section-png').disabled = false;
}
$('section-vex').onchange = renderSection;
$('section-svg').onclick = () => save(new Blob([state.sectionSVG], { type: 'image/svg+xml' }), `${slug()}-section.svg`);
$('section-png').onclick = async () => save(await svgToPNG(state.sectionSVG, 2), `${slug()}-section.png`);

// A shared link naming a curated site opens it and builds the model.
if (pendingView.site) {
  const entry = SITES.find(s => s.id === pendingView.site);
  if (entry) { await chooseSite(entry); $('options').requestSubmit(); }
}

window.__app = state;   // for debugging and automated checks
Object.defineProperty(window, "__studio", { get: () => studio });
Object.defineProperty(window, "__scene", { get: () => scene });
window.__picker = picker;
