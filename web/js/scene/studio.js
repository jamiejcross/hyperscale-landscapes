// The studio panel: the controls of JC's Mossmorran viewer (camera, lens,
// sun, height, background, screengrab), shared by the app's preview and the
// downloadable offline viewer.  Saved images always carry the caption strip.
import { withCaption } from './caption.js';
import { LOOKS } from './scene.js';
import { SIZES, makeGIF, makeVideo, videoType } from './turntable.js';

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'N'];

export function mountStudio(el, scene, host) {
  // host: { caption(): {title, disclosure, sources, footer, top}, filename(): string,
  //         printColours(): {layerId: hex}, onChange?(view), alt?(): string }
  el.classList.add('studio');
  el.innerHTML = `
    <fieldset><legend>Style</legend>
      <select name="look" aria-label="Style">
        ${Object.entries(LOOKS).map(([k, label]) => `<option value="${k}"${k === scene.view.look ? ' selected' : ''}>${label}</option>`).join('')}
      </select>
      <p class="hint">Changes how the model is drawn on screen and in saved images. Print files are not affected.</p>
    </fieldset>
    <fieldset><legend>Camera</legend>
      <div class="inline">
        <button type="button" data-view="oblique">Oblique</button>
        <button type="button" data-view="reverse">Reverse</button>
        <button type="button" data-view="low">Low angle</button>
        <button type="button" data-view="top">From above</button>
      </div>
      <label class="range">Lens <input type="range" name="fov" min="10" max="60" value="28"><output name="fovV"></output></label>
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
      <label class="check"><input type="checkbox" name="shadow" checked> Ground shadow</label>
      <label class="check"><input type="checkbox" name="print"> Print colours</label>
    </fieldset>
    <fieldset><legend>Background</legend>
      <select name="bg" aria-label="Background">
        <option value="sky">Sky</option><option value="studio">Studio grey</option>
        <option value="white">White</option><option value="dark">Charcoal</option>
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
    scene.setShadow(q('shadow').checked);
    scene.setPrintColours(q('print').checked, host.printColours());
    host.onChange?.(scene.view);
  }
  ['az', 'el', 'sun', 'fill', 'zex'].forEach(n => q(n).addEventListener('input', update));
  ['sides', 'shadow', 'print'].forEach(n => q(n).addEventListener('change', update));
  q('fov').addEventListener('input', () => { scene.setFov(+q('fov').value); q('fovV').value = `${scene.focalMm(+q('fov').value)} mm`; });
  q('fovV').value = `${scene.focalMm(28)} mm`;
  q('spin').addEventListener('change', e => scene.setSpin(e.target.checked));
  q('bg').addEventListener('change', e => scene.setBackground(e.target.value));
  q('look').addEventListener('change', e => {
    scene.setLook(e.target.value);
    q('bg').value = scene.view.background;     // each look brings its own background and lens
    q('fov').value = Math.round(scene.view.fov); q('fovV').value = `${scene.focalMm(scene.view.fov)} mm`;
    update();
  });
  el.addEventListener('click', e => { const b = e.target.closest('[data-view]'); if (b) scene.setView(b.dataset.view); });

  // The captioned image, without downloading it (also used by artefact exports).
  function compose(mult = +q('res').value) {
    return withCaption(scene.grab(mult), host.caption(), { dark: scene.view.background === 'dark' });
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
        const r = await makeGIF(scene, host.caption(), animOpts(12), m => { info.textContent = m; });
        download(r.blob, `${host.filename()}.gif`);
        info.textContent = `GIF: ${r.w} × ${r.h} px, ${(r.blob.size / 1e6).toFixed(1)} MB.`;
        return r;
      }
      const r = await makeVideo(scene, host.caption(), animOpts(30), m => { info.textContent = m; });
      download(r.blob, `${host.filename()}.${r.ext}`);
      info.textContent = `Video (${r.ext.toUpperCase()}): ${(r.blob.size / 1e6).toFixed(1)} MB.`;
      return r;
    } catch (e) { info.textContent = `Could not make the ${kind}: ${e.message}`; throw e; }
    finally { btns.forEach(b => { b.disabled = false; }); }
  }
  q('gif').addEventListener('click', () => runAnim('gif'));

  q('video').addEventListener('click', () => runAnim('video'));
  update();
  return { update, grab, compose, runAnim, animOpts, reset: update };
}
