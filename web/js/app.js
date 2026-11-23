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
import { write3MF } from './export/threemf.js';
import { writeSTL } from './export/stl.js';

const $ = id => document.getElementById(id);
const OSM_ATTR = '© OpenStreetMap contributors';
const state = { bbox: null, name: '', site: null, bundle: null, footprint: null, model: null, layers: {}, presets: {} };
let scene = null;

await loadStrings();
state.layers = Object.fromEntries((await (await fetch('data/layers.json')).json()).layers.map(l => [l.id, l]));
for (const id of ['power-and-place', 'residues', 'full', 'classic']) {
  state.presets[id] = await (await fetch(`data/presets/${id}.json`)).json();
  $('preset').append(new Option(state.presets[id].name, id, id === 'power-and-place', id === 'power-and-place'));
}

// ---------------- Step 1: choose an area ----------------
const picker = createPicker($('map'), {
  onBBox: b => setBBox(b),
  onFootprint: gj => setFootprint(gj),
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
}

function setFootprint(gj) {
  state.footprint = gj;
  $('clear-footprint').hidden = !gj;
  picker.showFootprint(gj);
}

for (const s of await listSites()) {
  const li = document.createElement('li');
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = s.name;
  b.onclick = async () => {
    const { site, bundle } = await loadSite(s);
    const bb = site.properties.model_bbox;
    picker.showBBox({ minLat: bb.min_lat, maxLat: bb.max_lat, minLon: bb.min_lon, maxLon: bb.max_lon });
    setBBox(state.bbox, { name: site.properties.name, site, bundle });
    if (site.geometry) {
      setFootprint({ type: 'Feature', properties: {}, geometry: site.geometry });
      const o = $('options').elements, p = site.properties;
      if (p.stated_height_m) o.insertHeight.value = p.stated_height_m;
      if (p.massing_source) o.insertSource.value = p.massing_source;
      if (p.footprint_precision) o.precision.value = p.footprint_precision;
      if (p.planning_refs?.[0]) o.planningRef.value = p.planning_refs[0].ref || p.planning_refs[0];
    } else setFootprint(null);
  };
  li.append(b); $('sites').append(li);
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
$('draw-footprint').onclick = () => { picker.setMode('footprint'); $('draw-finish').hidden = false; $('map').scrollIntoView({ behavior: 'smooth' }); };
$('draw-finish').onclick = () => { if (picker.finishPolygon()) $('draw-finish').hidden = true; };
$('clear-footprint').onclick = () => setFootprint(null);

$('upload').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const gj = await readBoundary(f);
    picker.showBBox(bboxOfCoords(allCoords(gj), 300));
    state.name = f.name.replace(/\.(geo)?json|\.kmz?$/i, '');
  } catch (err) { $('area').textContent = err.message; }
};
$('footprint-file').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try { setFootprint(await readBoundary(f)); } catch (err) { $('build-status').textContent = err.message; }
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
      footprint: state.footprint, insertHeight: +o.insertHeight.value || null,
    };
    if (opts.footprint && !opts.insertHeight) throw new Error('Please give the height of the proposed building.');
    status.textContent = t('build.loading.elevation');
    const elev = await loadElevation(state.bbox, state.bundle?.elevation?.tiles);
    status.textContent = t('build.loading.features');
    const raw = state.bundle?.osm || await fetchOSM(state.bbox, host => { status.textContent = `${t('build.loading.features')} (${host})`; });
    const osm = parseOSM(raw);
    status.textContent = t('build.loading.geometry');
    await new Promise(r => setTimeout(r, 30));
    const sources = sourcesFor();
    opts.labels = [
      [state.name || 'Terrain model', 6.0],
      [t('caption.exag', { x: opts.zExag }), 3.6],
      [`${ELEV_SHORT}; ${OSM_ATTR}`, 3.6],
      ...(opts.footprint ? [[t('caption.footprint', { precision: o.precision.value, ref: o.planningRef.value || 'not given' }), 3.6]] : []),
      [`Made ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} with Hyperscale Landscapes`, 3.6],
    ];
    const model = buildModel({ bbox: state.bbox, elev, osm, opts });
    state.model = { model, osm, opts, sources, form: Object.fromEntries(new FormData(e.target)) };
    showPreview();
    const objs = printObjects(model, state.presets[o.preset.value]).filter(x => x.mesh.indices.length);
    status.textContent = t('build.done', { objects: objs.length, buildings: model.report.counts.buildings + model.report.counts.receptors });
  } catch (err) {
    console.error(err);
    status.classList.add('error');
    status.textContent = t('build.error', { message: err.message });
  } finally { $('build').disabled = false; }
};

const ELEV_SHORT = 'Elevation: Mapzen Terrain Tiles (USGS, NOAA, EA)';
function sourcesFor() {
  return { elevation: ELEV_ATTRIBUTION, features: OSM_ATTR };
}

// ---------------- Step 3: preview ----------------
function showPreview() {
  const { model, osm, opts, form } = state.model;
  $('preview').hidden = false; $('export').hidden = false;
  scene ||= createScene($('view'));
  const colours = Object.fromEntries(Object.values(state.layers).map(l => [l.id, l.colour_screen]));
  colours.railDisused = state.layers.rail.colour_screen_disused;
  scene.setModel({ layers: model.layers, insert: model.insert, colours, grid: model.grid,
    landcover: landcoverCanvas(model.grid, osm.features) });
  const ul = $('layer-list'); ul.textContent = '';
  const shown = ['terrain', 'water', 'buildings', 'roads', 'rail', 'power', 'residues', 'receptors', ...(model.insert ? ['site'] : [])];
  for (const id of shown) {
    const L = state.layers[id];
    const li = document.createElement('li');
    li.innerHTML = `<label class="check"><input type="checkbox" checked data-layer="${id}"><span class="swatch" style="background:${L.colour_screen}"></span>${L.name}</label>
      <details><summary>${t('preview.why')}</summary><p>${L.why}</p></details>`;
    ul.append(li);
  }
  ul.querySelectorAll('input').forEach(i => { i.onchange = () => scene.setVisible(i.dataset.layer, i.checked); });
  const counts = model.report.counts;
  scene.renderer.domElement.setAttribute('aria-label', altText(model, osm));
  $('caption').textContent = captionText(opts, form) + ` Counts: ${counts.buildings} buildings, ${counts.receptors} schools, care or community buildings, ${counts.roads} roads.`;
  $('dl-insert').hidden = !model.insert;
  $('pauses').textContent = 'Single-colour printers: pause to change filament at ' +
    pauseHeights(model, opts.base).map(p => `${p.zMm} mm (${p.changeTo})`).join(', ') + '.';
  $('preview').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

function captionText(opts, form) {
  let s = `${state.name || 'Terrain model'}. ${t('caption.exag', { x: opts.zExag })}. ${ELEV_ATTRIBUTION}. Map data ${OSM_ATTR}. Generated ${new Date().toISOString().slice(0, 10)}.`;
  if (opts.footprint) s += ` ${t('caption.footprint', { precision: form.precision, ref: form.planningRef || 'not given' })}. Height ${opts.insertHeight} m (${form.insertSource || 'source not given'}).`;
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

$('preview').addEventListener('click', e => { const v = e.target.closest('[data-view]'); if (v) scene.setView(v.dataset.view); });
$('spin').onchange = e => scene.setSpin(e.target.checked);

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
    const separate = model.insert ? [{ name: 'Proposed data centre', slot: preset.insert.slot, colour: '#FFFFFF', mesh: model.insert }] : [];
    const blob = await write3MF({
      title: state.name || 'Terrain model', parts, separate,
      metadata: {
        Designer: 'Hyperscale Landscapes (browser)',
        Description: captionText(opts, form),
        Copyright: `${ELEV_ATTRIBUTION}; Map data ${OSM_ATTR}`,
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
$('dl-insert').onclick = () => save(writeSTL([state.model.model.insert]), `${slug()}-data-centre-block.stl`);

window.__app = state;   // for debugging and automated checks
