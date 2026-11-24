// The studio panel: the controls of JC's Mossmorran viewer (camera, lens,
// sun, height, background, screengrab), shared by the app's preview and the
// downloadable offline viewer.  Saved images always carry the caption strip.
import { withCaption } from './caption.js';

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'N'];

export function mountStudio(el, scene, host) {
  // host: { caption(): {title, disclosure, sources, footer, top}, filename(): string,
  //         printColours(): {layerId: hex}, onChange?(view), alt?(): string }
  el.classList.add('studio');
  el.innerHTML = `
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
  update();
  return { update, grab, compose, reset: update };
}
