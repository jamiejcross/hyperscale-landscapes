// The studio panel (after JC's Mossmorran viewer): look, camera, lens,
// sun, height, background, screengrab), shared by the app's preview and the
// downloadable offline viewer.  Saved images always carry the caption strip.
import { withCaption } from './caption.js';
import { LOOKS } from './scene.js';
import { PALETTES } from './palettes.js';
import { SIZES, makeGIF, makeVideo, videoType } from './turntable.js';
import { captionNote, subsurfaceManifest } from './subsurface-info.js';
import { wallsSVG, wallsPNG, legendItems, markSVG, diagramVex } from '../export/walls.js';

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'N'];

// Caption note for the geology walls and pits when they are on screen: the
// BGS attribution, the non-commercial notice and the sources, from the data.
export function geologyNote(scene) {
  const g = scene.geology;
  if (!g?.shown) return '';
  return g.sub ? captionNote(g.sub) : `${g.attribution}${g.nonCommercial ? ' (non-commercial use only)' : ''}`;
}
const escHTML = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function mountStudio(el, scene, host) {
  // host: { caption(): {title, disclosure, sources, footer, top}, filename(): string,
  //         printColours(): {layerId: hex}, onChange?(view), alt?(): string }
  el.classList.add('studio');
  el.innerHTML = `
    <fieldset><legend>Style</legend>
      <select name="look" aria-label="Style">
        ${Object.entries(LOOKS).map(([k, label]) => `<option value="${k}"${k === scene.view.look ? ' selected' : ''}>${label}</option>`).join('')}
      </select>
      <label class="range" name="inkRow">Outline <input type="range" name="ink" min="1" max="3" step="0.1" value="1.8"><output name="inkV"></output></label>
      <label class="check" name="brushRow"${PALETTES[scene.view.look]?.brushwork ? '' : ' hidden'}><input type="checkbox" name="brush"${scene.view.brushwork ? ' checked' : ''}> Brushwork (a texture, not data)</label>
      <p class="hint">Changes how the model is drawn on screen and in saved images. Print files are not affected.</p>
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
    <fieldset><legend>Model</legend>
      <label class="range">Extra height <input type="range" name="zex" min="50" max="300" step="25" value="100"><output name="zexV"></output></label>
      <label class="check"><input type="checkbox" name="sides" checked> Soil sides</label>
      <label class="check" name="geoRow" hidden><input type="checkbox" name="geology" checked> Geology walls (BGS; screen only)</label>
      <label class="check"><input type="checkbox" name="shadow"> Ground shadow</label>
      <label class="check"><input type="checkbox" name="print"> Print colours</label>
    </fieldset>
    <fieldset name="geoPanel" hidden><legend>Geology legend (BGS)</legend>
      <div name="geoLegend" class="geo-legend"></div>
      <div class="inline">
        <button type="button" name="wallsPng">Unfolded walls (PNG)</button>
        <button type="button" name="wallsSvg">SVG</button>
        <button type="button" name="geoManifest">Sources (JSON)</button>
      </div>
      <p class="hint">The four walls laid out flat at true horizontal scale, with this legend and the BGS notice. Non-commercial use only.</p>
      <p class="hint" name="geoInfo" aria-live="polite"></p>
    </fieldset>
    <fieldset><legend>Background</legend>
      <select name="bg" aria-label="Background">
        <option value="sky">Sky</option><option value="studio">Studio grey</option>
        <option value="white">White</option><option value="guthrie">Guthrie sky</option><option value="dark">Charcoal</option>
        <option value="clear">Transparent</option>
      </select>
    </fieldset>
    <fieldset><legend>Animation</legend>
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
    <fieldset><legend>Save an image</legend>
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
  const q = n => el.querySelector(`[name="${n}"]`);

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
  q('look').addEventListener('change', e => {
    const to = e.target.value;
    scene.setLook(to);
    renderLegend();
    q('brushRow').hidden = !PALETTES[to]?.brushwork;    // Guthrie only
    q('bg').value = scene.view.background;     // each look brings its own background
    update();
  });
  el.addEventListener('click', e => { const b = e.target.closest('[data-view]'); if (b) scene.setView(b.dataset.view); });

  // The caption for saved images and animations, with the look's note (Guthrie) in the small print.
  function caption() {
    const c = host.caption(), notes = [PALETTES[scene.view.look]?.captionNote, geologyNote(scene)].filter(Boolean);
    return notes.length ? { ...c, footer: [c.footer, ...notes].join(' · ') } : c;
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
  function refreshGeology() { q('geoRow').hidden = q('geoPanel').hidden = !scene.geology?.walls; renderLegend(); update(); }

  // ---- geology legend and the unfolded-walls export ----
  function renderLegend() {
    const G = scene.geology?.instance, box = q('geoLegend');
    if (!G) { box.innerHTML = ''; return; }
    box.innerHTML = legendItems({ geology: G, look: scene.view.look, pitsShown: scene.pits?.shown }).map(it => {
      if (it.head) return `<h3>${escHTML(it.head)}</h3>`;
      if (it.note) return `<p class="hint">${escHTML(it.note)}</p>`;
      const icon = it.swatch ? `<img alt="" src="${it.swatch.toDataURL('image/png')}" width="26" height="16">`
        : `<svg width="26" height="18" viewBox="0 -2 26 20" aria-hidden="true">${markSVG(it.mark, 0, 0)}</svg>`;
      return `<div class="geo-row">${icon}<span>${escHTML(it.text)}</span></div>`;
    }).join('');
  }
  function wallsCaption() { const c = host.caption(), note = PALETTES[scene.view.look]?.captionNote; return note ? { ...c, footer: `${c.footer} · ${note}` } : c; }
  // (the BGS sources go in the export's own caption, so the plain caption is used)
  async function walls(kind) {
    const G = scene.geology?.instance; if (!G) return null;
    const info = q('geoInfo'); info.textContent = 'Drawing the walls…';
    try {
      const svg = wallsSVG({ geology: G, look: scene.view.look, caption: wallsCaption(), pitsShown: scene.pits?.shown, fontCSS: (await host.fontCSS?.()) || '' });
      const blob = kind === 'svg' ? new Blob([svg], { type: 'image/svg+xml' }) : await wallsPNG(svg, 2);
      download(blob, `${host.filename()}-walls.${kind}`);
      info.textContent = `Unfolded walls (${kind.toUpperCase()}): ${(blob.size / 1e6).toFixed(1)} MB.`;
      return { svg, blob };
    } catch (e) { info.textContent = `Could not draw the walls: ${e.message}`; throw e; }
  }
  function manifest() {
    const G = scene.geology?.instance, sub = scene.geology?.sub; if (!sub) return null;
    const c = host.caption();
    const m = subsurfaceManifest(sub, { name: c.title, Wm: G?.Wm, Hm: G?.Hm, zExag: G?.zExag,
      vex: G ? diagramVex({ dzTrueM: (G.zmax - G.zmin) / (G.mmPerM * G.zExag), kx: 1720 / (G.Wm + G.Hm), zExag: G.zExag }) : null });
    download(new Blob([JSON.stringify(m, null, 2)], { type: 'application/json' }), `${host.filename()}-subsurface.json`);
    return m;
  }
  q('wallsPng').addEventListener('click', () => walls('png'));
  q('wallsSvg').addEventListener('click', () => walls('svg'));
  q('geoManifest').addEventListener('click', manifest);
  return { refreshGeology, renderLegend, walls, wallsCaption, manifest, update, grab, compose, caption, runAnim, animOpts, setLook, setBrushwork, reset: update };
}
