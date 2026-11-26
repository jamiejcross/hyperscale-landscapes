// The studio panel (after JC's Mossmorran viewer): look, camera, lens,
// sun, height, background, screengrab), shared by the app's preview and the
// downloadable offline viewer.  Saved images always carry the caption strip.
import { withCaption } from './caption.js';
import { LOOKS, LOOK_DEFS } from './scene.js';
import { PALETTES } from './palettes.js';
import { SIZES, makeGIF, makeVideo, videoType } from './turntable.js';
import { captionNote, subsurfaceManifest } from './subsurface-info.js';
import { wallsSVG, wallsPNG, legendItems, dataNote, markSVG, diagramVex } from '../export/walls.js';
import { mapKeyItems, legendCanvas, legendSVG } from './legend.js';

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'N'];

// Caption note for the geology walls and pits when they are on screen: the
// BGS attribution, the non-commercial notice and the sources, from the data.
export function geologyNote(scene) {
  const g = scene.geology;
  if (!g?.shown) return '';
  return g.sub ? captionNote(g.sub) : `${g.attribution}${g.nonCommercial ? ' (non-commercial use only)' : ''}`;
}
// The look's caption small print: the palette's note, then what the look
// itself drew (Anthropogenic: crowns, glyph heights, terrain smoothing).
export function lookNote(scene) {
  return [PALETTES[scene.view.look]?.captionNote, ...(scene.lookNotes?.() || [])].filter(Boolean).join('; ');
}
const escHTML = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function mountStudio(el, scene, host) {
  // host: { caption(): {title, disclosure, sources, footer, top}, filename(): string,
  //         printColours(): {layerId: hex}, onChange?(view), alt?(): string,
  //         layerList?(): the layer key <ul> (for the legend) }
  el.classList.add('studio');
  el.innerHTML = `
    <fieldset name="styleSet"><legend>Style</legend>
      <select name="look" aria-label="Style">
        ${Object.entries(LOOKS).map(([k, label]) => `<option value="${k}"${k === scene.view.look ? ' selected' : ''}>${label}</option>`).join('')}
      </select>
      <label class="range" name="inkRow"${LOOK_DEFS[scene.view.look]?.inkPass === false ? ' hidden' : ''}>Outline <input type="range" name="ink" min="0.5" max="3" step="0.1" value="1.8"><output name="inkV"></output></label>
      <label class="check" name="brushRow"${PALETTES[scene.view.look]?.brushwork ? '' : ' hidden'}><input type="checkbox" name="brush"${scene.view.brushwork ? ' checked' : ''}> Brushwork (a texture, not data)</label>
      <label class="check" name="reliefRow"${LOOK_DEFS[scene.view.look]?.carto ? '' : ' hidden'}><input type="checkbox" name="relief"${scene.view.relief !== false ? ' checked' : ''}> Relief shading (from the model's heights)</label>
      <label class="check" name="crownRow"${LOOK_DEFS[scene.view.look]?.carto ? '' : ' hidden'}><input type="checkbox" name="crowns"${scene.view.crowns !== false ? ' checked' : ''}> Crown symbols (woodland drawn as symbols)</label>
      <label class="check" name="contourRow"${LOOK_DEFS[scene.view.look]?.carto ? ' hidden' : ''}><input type="checkbox" name="contours"${scene.view.contours ? ' checked' : ''}> Contour lines</label>
      <label class="check"><input type="checkbox" name="mist"${scene.view.mist?.[scene.view.look] ? ' checked' : ''}> Mist (distance haze)</label>
    </fieldset>
    <fieldset><legend>Camera</legend>
      <div class="inline">
        <button type="button" data-view="oblique">Oblique</button>
        <button type="button" data-view="reverse">Reverse</button>
        <button type="button" data-view="low">Low angle</button>
        <button type="button" data-view="top">From above</button>
      </div>
      <label class="range">Lens <input type="range" name="fov" min="10" max="60" value="${Math.round(scene.view.fov)}"><output name="fovV"></output></label>
      <label class="check"><input type="checkbox" name="spin"> Turn slowly</label>
    </fieldset>
    <fieldset><legend>Sun</legend>
      <label class="range">Direction <input type="range" name="az" min="0" max="360" value="225"><output name="azV"></output></label>
      <label class="range">Height <input type="range" name="el" min="3" max="85" value="32"><output name="elV"></output></label>
      <label class="range">Strength <input type="range" name="sun" min="0" max="60" value="30"><output name="sunV"></output></label>
      <label class="range">Fill light <input type="range" name="fill" min="0" max="30" value="10"><output name="fillV"></output></label>
    </fieldset>
    <fieldset name="modelSet"><legend>Model</legend>
      <label class="range">Extra height <input type="range" name="zex" min="50" max="300" step="25" value="100"><output name="zexV"></output></label>
      <label class="check"><input type="checkbox" name="sides" checked> Soil sides</label>
      <label class="check" name="geoRow" hidden><input type="checkbox" name="geology" checked> Geology walls</label>
      <label class="check"><input type="checkbox" name="shadow"> Ground shadow</label>
      <label class="check"><input type="checkbox" name="print"> Print colours</label>
    </fieldset>
    <fieldset name="geoPanel" hidden><legend>Geology legends</legend>
      <label class="check"><input type="checkbox" name="legGeology" checked> Geology</label>
      <label class="check"><input type="checkbox" name="legBgs" checked> British Geological Survey</label>
      <label class="check"><input type="checkbox" name="geoLabels"> Labels on the walls (coal-bearing ground, deeper boreholes)</label>
      <div name="geoLegend" class="geo-legend"></div>
      <div name="geoExport">
        <div class="inline">
          <button type="button" name="wallsPng">Geology cross sections (PNG)</button>
          <button type="button" name="wallsSvg">SVG</button>
          <button type="button" name="geoManifest">Sources (JSON)</button>
        </div>
        <p class="hint">The four walls of the model laid out flat at true horizontal scale, with the geology legend and the BGS notice. Non-commercial use only. The JSON lists the sources and the data notes.</p>
        <p class="hint" name="geoInfo" aria-live="polite"></p>
      </div>
    </fieldset>
    <fieldset name="keySet"><legend>Legend</legend>
      <label class="check"><input type="checkbox" name="keyOn"> Add a legend to saved images and animations</label>
      <div name="keyExport">
        <div class="inline">
          <button type="button" name="keyPng">Export legend (PNG)</button>
          <button type="button" name="keySvg">SVG</button>
        </div>
        <p class="hint">Symbols and colours for the layers shown, in the current look, and the subsurface geology where the site has it.</p>
        <p class="hint" name="keyInfo" aria-live="polite"></p>
      </div>
    </fieldset>
    <fieldset name="bgSet"><legend>Background</legend>
      <select name="bg" aria-label="Background">
        <option value="sky">Sky</option><option value="studio">Studio grey</option>
        <option value="white">White</option><option value="guthrie">Guthrie sky</option><option value="dark">Charcoal</option>
        <option value="clear">Transparent</option>
      </select>
    </fieldset>
    <fieldset name="animSet"><legend>Animation</legend>
      <label>Size <select name="animSize">${Object.entries(SIZES).map(([k, s]) => `<option value="${k}">${s.label}</option>`).join('')}</select></label>
      <label class="range">Length <input type="range" name="secs" min="4" max="16" step="2" value="8"><output name="secsV"></output></label>
      <label class="check"><input type="checkbox" name="half"> Half a turn only</label>
      <label class="check"><input type="checkbox" name="hold" checked> Pause on the current view first</label>
      <div class="inline">
        <button type="button" name="gif">Make GIF</button>
        <button type="button" name="video">Make video</button>
      </div>
      <p class="hint">Starts from the view on screen: point the camera at the site first. GIFs are kept under 8 MB. ${videoType()?.includes('mp4') ? 'Videos are MP4.' : 'Videos are WebM; WhatsApp needs MP4 (use Safari or a recent Chrome).'}</p>
      <p class="hint" name="animInfo" aria-live="polite"></p>
    </fieldset>
    <fieldset name="grabSet"><legend>Save an image</legend>
      <div class="inline">
        <select name="res" aria-label="Image size">
          <option value="1">Screen size</option><option value="2" selected>2 × screen</option>
          <option value="3">3 × screen</option><option value="4">4 × screen (print)</option>
        </select>
        <button type="button" class="primary" name="grab">Save PNG</button>
      </div>
      <p class="hint">Every image carries a caption with the sources, the height exaggeration and the date, so it can be shared safely.</p>
      <p class="hint" name="grabInfo" aria-live="polite"></p>
    </fieldset>`;
  // Named controls, kept by reference: a host may move a fieldset elsewhere on
  // the page (the app puts the background beside Surface, and the image and
  // animation controls in its download section), and they keep working.
  const named = {};
  el.querySelectorAll('[name]').forEach(n => { named[n.getAttribute('name')] ||= n; });
  const q = n => named[n] || el.querySelector(`[name="${n}"]`);

  function update() {
    scene.setSun(+q('az').value, +q('el').value, +q('sun').value / 10, +q('fill').value / 10);
    q('azV').value = COMPASS[Math.round(+q('az').value / 45)];
    q('elV').value = `${q('el').value}°`;
    q('sunV').value = (+q('sun').value / 10).toFixed(1);
    q('fillV').value = (+q('fill').value / 10).toFixed(1);
    scene.setHeightScale(+q('zex').value / 100);
    q('zexV').value = `×${(+q('zex').value / 100).toFixed(2)}`;
    scene.setVisible('terrain-sides', q('sides').checked);
    scene.showGeology?.(q('geology').checked);
    scene.setShadow(q('shadow').checked);
    scene.setPrintColours(q('print').checked, host.printColours());
    host.onChange?.(scene.view);
  }
  ['az', 'el', 'sun', 'fill', 'zex'].forEach(n => q(n).addEventListener('input', update));
  ['sides', 'geology', 'shadow', 'print'].forEach(n => q(n).addEventListener('change', update));
  q('fov').addEventListener('input', () => { scene.setFov(+q('fov').value); q('fovV').value = `${scene.focalMm(+q('fov').value)} mm`; });
  q('fovV').value = `${scene.focalMm(scene.view.fov)} mm`;
  q('bg').value = scene.view.background;
  q('spin').addEventListener('change', e => scene.setSpin(e.target.checked));
  q('bg').addEventListener('change', e => scene.setBackground(e.target.value));
  const inkLabel = () => { q('inkV').value = `${(+q('ink').value).toFixed(1)} px`; };
  q('ink').addEventListener('input', () => { scene.setInkWidth(+q('ink').value); inkLabel(); });
  inkLabel();
  q('brush').addEventListener('change', e => scene.setBrushwork(e.target.checked));
  q('relief').addEventListener('change', e => { scene.setCarto?.({ relief: e.target.checked }); host.onChange?.(scene.view); });
  q('crowns').addEventListener('change', e => { scene.setCarto?.({ crowns: e.target.checked }); host.onChange?.(scene.view); });
  q('contours').addEventListener('change', e => { scene.setContours?.(e.target.checked); host.onChange?.(scene.view); });
  const legendShow = () => ({ geology: q('legGeology').checked, bgs: q('legBgs').checked });
  for (const n of ['legGeology', 'legBgs']) q(n).addEventListener('change', () => { renderLegend(); host.onChange?.(scene.view); });
  q('geoLabels').addEventListener('change', e => { scene.setGeologyLabels?.(e.target.checked); host.onChange?.(scene.view); });
  q('mist').addEventListener('change', e => { scene.setMist?.(e.target.checked); host.onChange?.(scene.view); });
  q('look').addEventListener('change', e => {
    const to = e.target.value;
    scene.setLook(to);
    renderLegend();
    q('brushRow').hidden = !PALETTES[to]?.brushwork;    // Guthrie and Anthropogenic
    q('reliefRow').hidden = q('crownRow').hidden = !LOOK_DEFS[to]?.carto;
    q('contourRow').hidden = !!LOOK_DEFS[to]?.carto;     // Anthropogenic has its contours in the relief
    q('mist').checked = !!scene.view.mist?.[to];          // mist is remembered per look
    q('inkRow').hidden = LOOK_DEFS[to]?.inkPass === false;
    // controls elsewhere that a look makes meaningless (e.g. the 3D tree height in Anthropogenic)
    document.querySelectorAll('[data-hide-looks]').forEach(n => { n.hidden = n.dataset.hideLooks.split(' ').includes(to); });
    q('bg').value = scene.view.background;     // each look brings its own background
    update();
  });
  el.addEventListener('click', e => { const b = e.target.closest('[data-view]'); if (b) scene.setView(b.dataset.view); });

  // The caption for saved images and animations, with the look's note (Guthrie) in the small print.
  function caption() {
    const c = host.caption(), notes = [lookNote(scene), geologyNote(scene)].filter(Boolean);
    const out = notes.length ? { ...c, footer: [c.footer, ...notes].join(' · ') } : { ...c };
    if (q('keyOn').checked) out.key = keyItems();
    return out;
  }
  // ---- the legend: the layers ticked in the layer key, then the geology ----
  function keyItems() {
    const G = scene.geology?.instance, c = host.caption();
    const show = legendShow();
    const items = mapKeyItems(host.layerList?.(), { elec: scene.electricity?.() || {}, redLine: c.legend || null, geology: !!G && show.bgs,
      context: document.querySelector('[data-context-view]:checked')?.value || null });
    if (G) items.push(...legendItems({ geology: G, look: scene.view.look, pitsShown: scene.pits?.shown, show }));
    return items;
  }
  function keyNotice() {
    const g = scene.geology;
    if (!g?.sub && !g?.attribution) return null;
    return `${g.sub?.attribution ?? g.attribution}.${g.nonCommercial ? ' BGS 1:50 000 geology is licensed for non-commercial use only; commercial reuse needs a BGS licence.' : ''}`;
  }
  async function exportKey(kind) {
    const info = q('keyInfo'), items = keyItems();
    if (!items.length) { info.textContent = 'Nothing is shown, so there is no legend to export.'; return null; }
    const c = caption(), look = PALETTES[scene.view.look]?.name || scene.view.look;
    const title = `${c.title}: legend (${look} look)`;
    let blob;
    if (kind === 'svg') {
      const lines = [[`${c.title}  ·  ${c.disclosure}`, true], ...(keyNotice() ? [[keyNotice(), true]] : []),
        [`Sources: ${[scene.geology?.sub ? captionNote(scene.geology.sub) : null, c.sources].filter(Boolean).join('. ')}.`, false], [c.footer, false]];
      blob = new Blob([legendSVG(items, { title, lines, fontCSS: (await host.fontCSS?.()) || '' })], { type: 'image/svg+xml' });
    } else {
      // the legend sheet with the ordinary caption bands (title, sources, date)
      const notice = keyNotice(), cap = { ...c, title, key: undefined, legend: [c.legend, notice].filter(Boolean).join(' ') || undefined };
      const out = withCaption(legendCanvas(items, 1600), cap, {});
      blob = await new Promise(r => out.toBlob(r, 'image/png'));
    }
    download(blob, `${host.filename()}-legend.${kind}`);
    info.textContent = `Legend (${kind.toUpperCase()}): ${(blob.size / 1e3).toFixed(0)} kB.`;
    return { blob, items };
  }
  // The captioned image, without downloading it (also used by artefact exports).
  function compose(mult = +q('res').value) {
    return withCaption(scene.grab(mult), caption(), { dark: scene.view.background === 'dark' });
  }

  async function grab() {
    const out = compose();
    const blob = await new Promise(r => out.toBlob(r, 'image/png'));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `${host.filename()}.png`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    q('grabInfo').textContent = `${out.width} × ${out.height} px · ${(blob.size / 1e6).toFixed(1)} MB.` +
      (host.alt ? ` Suggested alt text: ${host.alt()}` : '');
    return { canvas: out, blob };
  }
  q('grab').addEventListener('click', grab);

  // ---- animations ----
  const secsLabel = () => { q('secsV').value = `${q('secs').value} s`; };
  q('secs').addEventListener('input', secsLabel); secsLabel();
  function animOpts(fps) {
    const s = SIZES[q('animSize').value];
    return { w: s.w, h: s.h, seconds: +q('secs').value, fps, turn: q('half').checked ? 0.5 : 1,
      holdSeconds: q('hold').checked ? 1.5 : 0, dark: scene.view.background === 'dark' };
  }
  function download(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  async function runAnim(kind) {
    const info = q('animInfo'), btns = [q('gif'), q('video')];
    btns.forEach(b => { b.disabled = true; });
    try {
      if (kind === 'gif') {
        const r = await makeGIF(scene, caption(), animOpts(12), m => { info.textContent = m; });
        download(r.blob, `${host.filename()}.gif`);
        info.textContent = `GIF: ${r.w} × ${r.h} px, ${(r.blob.size / 1e6).toFixed(1)} MB.`;
        return r;
      }
      const r = await makeVideo(scene, caption(), animOpts(30), m => { info.textContent = m; });
      download(r.blob, `${host.filename()}.${r.ext}`);
      info.textContent = `Video (${r.ext.toUpperCase()}): ${(r.blob.size / 1e6).toFixed(1)} MB.`;
      return r;
    } catch (e) { info.textContent = `Could not make the ${kind}: ${e.message}`; throw e; }
    finally { btns.forEach(b => { b.disabled = false; }); }
  }
  q('gif').addEventListener('click', () => runAnim('gif'));

  q('video').addEventListener('click', () => runAnim('video'));
  update();
  // Switch style from outside (e.g. a shared URL), keeping the panel in step.
  function setLook(look) {
    if (look === scene.view.look || !q('look').querySelector(`option[value="${look}"]`)) return;
    q('look').value = look; q('look').dispatchEvent(new Event('change'));
  }
  function setBrushwork(on) { q('brush').checked = !!on; scene.setBrushwork(!!on); }
  // Geology walls: the toggle and the legend show only when the site has wall samples.
  // host.onGeology(shown) lets a host that has moved these parts show or hide them too.
  function refreshGeology() {
    const on = !!scene.geology?.walls;
    q('geoRow').hidden = q('geoPanel').hidden = q('geoExport').hidden = !on;
    host.onGeology?.(on); renderLegend(); update();
  }

  // ---- geology legend and the unfolded-walls export ----
  function renderLegend() {
    const G = scene.geology?.instance, box = q('geoLegend');
    if (!G) { box.innerHTML = ''; return; }
    const opts = { geology: G, look: scene.view.look, pitsShown: scene.pits?.shown, show: legendShow() };
    const items = legendItems(opts);
    // a name in bold and a grey second line, as the mine signposts on the model
    const html = it => {
      if (it.head) return it.big ? `<h3 class="geo-group">${escHTML(it.head)}</h3>` : `<h4>${escHTML(it.head)}</h4>`;
      if (it.note) return `<p class="hint">${escHTML(it.note)}</p>`;
      const icon = it.swatch ? `<img alt="" src="${it.swatch.toDataURL('image/png')}" width="26" height="16">`
        : `<svg width="26" height="18" viewBox="0 -2 26 20" aria-hidden="true">${markSVG(it.mark, 0, 0)}</svg>`;
      return `<div class="geo-row">${icon}<span><b>${escHTML(it.text)}</b>${it.sub ? `<small>${escHTML(it.sub)}</small>` : ''}</span></div>`;
    };
    // one column per legend: Geology, then British Geological Survey
    const cols = [];
    for (const it of items) { if (it.group || !cols.length) cols.push([]); cols[cols.length - 1].push(it); }
    box.innerHTML = cols.length ? `<div class="geo-cols">${cols.map(c => `<div>${c.map(html).join('')}</div>`).join('')}</div>` : '';
    // (the note on what is data and what is drawn goes only in the Sources JSON: manifest())
  }
  function wallsCaption() { const c = host.caption(), note = lookNote(scene); return note ? { ...c, footer: `${c.footer} · ${note}` } : c; }
  // (the BGS sources go in the export's own caption, so the plain caption is used)
  async function walls(kind) {
    const G = scene.geology?.instance; if (!G) return null;
    const info = q('geoInfo'); info.textContent = 'Drawing the walls…';
    try {
      const svg = wallsSVG({ geology: G, look: scene.view.look, caption: wallsCaption(), pitsShown: scene.pits?.shown, legendShow: legendShow(), fontCSS: (await host.fontCSS?.()) || '' });
      const blob = kind === 'svg' ? new Blob([svg], { type: 'image/svg+xml' }) : await wallsPNG(svg, 2);
      download(blob, `${host.filename()}-walls.${kind}`);
      info.textContent = `Geology cross sections (${kind.toUpperCase()}): ${(blob.size / 1e6).toFixed(1)} MB.`;
      return { svg, blob };
    } catch (e) { info.textContent = `Could not draw the walls: ${e.message}`; throw e; }
  }
  function manifest() {
    const G = scene.geology?.instance, sub = scene.geology?.sub; if (!sub) return null;
    const c = host.caption();
    const m = subsurfaceManifest(sub, { name: c.title, Wm: G?.Wm, Hm: G?.Hm, zExag: G?.zExag,
      vex: G ? diagramVex({ dzTrueM: (G.zmax - G.zmin) / (G.mmPerM * G.zExag), kx: 1720 / (G.Wm + G.Hm), zExag: G.zExag }) : null });
    if (G) m.what_is_data_and_what_is_drawn = dataNote({ geology: G, look: scene.view.look, pitsShown: scene.pits?.shown });
    const cx = scene.contextInfo?.();
    if (cx) m.context = { label: 'CONTEXT', printed: false, shown: cx.on, pad_m: cx.pad_m,
      terrain: { source: cx.source, attribution: cx.attribution, offset_m: cx.offset_m, triangles: cx.triangles,
        vertices_held_above_ground_plane: cx.clampedVertices },
      infrastructure: { attribution: cx.osmAttribution, features: cx.features, pylons_and_poles: cx.supports, labels: cx.names },
      drawn: 'land colour desaturated 35% and faded toward the background with distance (22% at the model edge to 88% at the pad); lines fade at most 45%; nothing drawn inside the model area' };
    download(new Blob([JSON.stringify(m, null, 2)], { type: 'application/json' }), `${host.filename()}-subsurface.json`);
    return m;
  }
  q('keyPng').addEventListener('click', () => exportKey('png'));
  q('keySvg').addEventListener('click', () => exportKey('svg'));
  q('wallsPng').addEventListener('click', () => walls('png'));
  q('wallsSvg').addEventListener('click', () => walls('svg'));
  q('geoManifest').addEventListener('click', manifest);
  return { part: q, refreshGeology, renderLegend, keyItems, exportKey, walls, wallsCaption, manifest, update, grab, compose, caption, runAnim, animOpts, setLook, setBrushwork, reset: update };
}
