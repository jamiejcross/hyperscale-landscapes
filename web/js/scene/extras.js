// The site extras in the layer key, shared by the web app and the offline
// viewer so both show and behave the same: 3D props (trees, turbines,
// pylons and lines), the geology walls and the pits on the surface, all
// from the site bundle and all screen only.
import { EVIDENCE } from './palettes.js';

// Strings the extras use (keys of data/i18n); the offline viewer carries them resolved.
export const EXTRAS_KEYS = ['preview.why', 'context.layer', 'context.layer.why', 'energy.layer', 'energy.layer.why', 'geology.view',
  'views.title', 'layer.labels', 'layer.labels.why', 'pits.quarries', 'pits.quarries.why', 'layer.scale', 'layer.scale.why', 'layer.generation', 'layer.generation.why', 'layer.transmission', 'layer.transmission.why', 'layer.power.print', 'props.trees', 'props.trees.why', 'props.trees.height', 'props.turbines', 'props.turbines.why',
  'props.pylons', 'props.pylons.why', 'pits.coal', 'pits.coal.why', 'pits.unknown', 'pits.unknown.why', 'pits.quarry', 'pits.quarry.why'];

// ul: the layer list; props / subsurface: the bundle's sections (or null);
// grid, heights, zExag: from the model; seed: the site's stable id;
// text(key, vars): the interface strings; onChange(): after a pit toggle.
// Each layer row's explanation: a small ▾ button after the name (inside the
// label, but with no text of its own, so the label's text stays the name)
// opens the note below. wireWhy(root) is safe to call more than once.
// Context views on at first: Terrain and Electricity Grid together (JC, 26 Nov 2026).
export const DEFAULT_CONTEXT = 'landscape,energy';
// The context views ticked, as 'landscape', 'energy', 'landscape,energy' or 'geology'; null if none.
export const contextViewValue = () => [...document.querySelectorAll('[data-context-view]:checked')].map(r => r.value).join(',') || null;
export const whyButton = label => `<button type="button" class="why-btn" aria-expanded="false" aria-label="${label}" title="${label}"></button>`;
export const whyBox = html => `<div class="why" hidden>${html}</div>`;
export function wireWhy(root) {
  for (const b of root.querySelectorAll('.why-btn')) {
    b.onclick = e => {
      e.preventDefault(); e.stopPropagation();          // do not toggle the row's checkbox
      const box = b.closest('li')?.querySelector('.why'); if (!box) return;
      box.hidden = !box.hidden; b.setAttribute('aria-expanded', String(!box.hidden));
    };
  }
}

// treeSlot: where the tree-height slider goes (the studio's Model fieldset), else the Trees row.
export function mountExtras(ul, scene, { props, subsurface, grid, heights, zExag, seed, text, onChange = () => {}, treeSlot = null, context = null, bbox = null, relief = null,
  contextSlot = null, contextView = null, onContextView = () => {}, labels = false, onLabels = () => {} }) {
  treeSlot?.querySelector('[data-tree-factor]')?.parentElement.remove();   // a rebuild: drop the last model's slider
  const pc = scene.setProps(props, { grid, heights, zExag, seed });
  // Turbines, pylons and lines have no rows of their own: the electricity
  // rows switch them (scene.setVisible: turbines with Generation; pylons,
  // poles and lines with Transmission), and their notes are added to that
  // row's explanation.
  const elec = [['turbines', 'generation', pc?.turbines], ['pylons', 'transmission', (pc?.towers || 0) + (pc?.poles || 0) + (pc?.lineSegments || 0)]].filter(([, , n]) => n);
  for (const [kind, group] of elec) {
    let row = ul.querySelector(`input[data-layer="${group}"]`)?.closest('li');
    if (!row) {          // a site with props but no such features in the model
      row = document.createElement('li');
      row.innerHTML = `<label class="check"><input type="checkbox" checked data-layer="${group}"><span class="swatch" data-swatch="power" data-screen="#E69F00" style="background:#E69F00"></span>${text(`layer.${group}`)}${whyButton(text('preview.why'))}</label>
        ${whyBox(`<p>${text(`layer.${group}.why`)} ${text('layer.power.print')}</p>`)}`;
      const after = group === 'generation' ? null : ul.querySelector('input[data-layer="storage"], input[data-layer="generation"]')?.closest('li');
      const before = ul.querySelector('input[data-layer="storage"], input[data-layer="transmission"], input[data-layer="residues"]')?.closest('li');
      if (after) after.after(row); else if (before) before.before(row); else ul.append(row);
      row.querySelector('input').onchange = e => scene.setVisible(group, e.target.checked);
    }
    const det = row.querySelector('.why');
    const p = document.createElement('p'); p.textContent = `${text(`props.${kind}`)}: ${text(`props.${kind}.why`)}`; det.append(p);
  }
  const propRows = [['trees', pc?.trees]];
  for (const [kind, n] of propRows) {
    if (!n) continue;
    const li = document.createElement('li');
    const input = `<input type="range" min="1" max="4" step="0.5" value="${zExag}" data-tree-factor>`;
    const slider = kind !== 'trees' ? ''
      : treeSlot   // the studio's rows: name, slider, value
        ? `<label class="range" data-hide-looks="anthropogenic">${text('props.trees.height', { x: '' }).replace(/[\s×]+$/, '')}${input}<output data-x="×">×${zExag}</output></label>`
        : `<label class="range" data-hide-looks="anthropogenic">${text('props.trees.height', { x: `<output>${zExag}</output>` })}${input}</label>`;
    li.innerHTML = `<label class="check"><input type="checkbox" checked data-prop="${kind}">${text(`props.${kind}`)}${whyButton(text('preview.why'))}</label>${treeSlot ? '' : slider}
      ${whyBox(`<p>${text(`props.${kind}.why`)}</p>`)}`;
    ul.append(li);
    if (treeSlot && slider) treeSlot.insertAdjacentHTML('beforeend', slider);
  }
  ul.querySelectorAll('input[data-prop]').forEach(i => { i.onchange = () => scene.setPropsVisible(i.dataset.prop, i.checked); });
  const tf = (treeSlot || ul).querySelector('[data-tree-factor]');
  if (tf) tf.oninput = () => { scene.setTreeFactor(+tf.value); const o = tf.parentElement.querySelector('output'); o.textContent = `${o.dataset.x || ''}${tf.value}`; };

  // Geology walls (on by default where there are samples), then the pits:
  // Coal mines, then Quarries (BritPits quarries and the records whose type is
  // not given, each still drawn with its own square), each row with its own toggle.
  scene.setGeology(subsurface, { grid, zExag, on: true });
  const pitCounts = scene.setPits(subsurface, { grid, heights, on: true });
  const PIT_ROWS = [['coal', ['coal'], `background:${EVIDENCE.coal}`],
    ['quarries', ['quarry', 'unknown'], `background:#fffaec;outline:1.5px solid ${EVIDENCE.coal};outline-offset:-1.5px`]];
  for (const [row, classes, swatch] of PIT_ROWS) {
    const n = classes.reduce((t, c) => t + (pitCounts?.[c] || 0), 0);
    if (!n) continue;
    const li = document.createElement('li');
    li.innerHTML = `<label class="check"><input type="checkbox" checked data-pits="${row}"><span class="swatch" style="${swatch}"></span>${text(`pits.${row}`)} (${n})${whyButton(text('preview.why'))}</label>
      ${whyBox(`<p>${text(`pits.${row}.why`)}</p>`)}`;
    ul.append(li);
    const set = on => { for (const c of classes) if (pitCounts[c]) scene.showPitClass(c, on); };
    set(true);
    li.querySelector('[data-pits]').onchange = e => { set(e.target.checked); onChange(); };
  }
  // Context views (never printed): one at a time, all three options visible.
  //   Terrain: the land, routes, water, buildings and names round the model;
  //   Electricity Grid: pylons, poles and lines only, the model's edge giving way to the background;
  //   both keep the camera above the terrain and switch Soil sides and Geology walls off.
  //   Geological: Soil sides and Geology walls on, nothing beyond the model.
  const ctx = scene.setContext(context, { bbox, grid, heights, relief, on: true });
  const VIEWS = [];
  if (ctx) VIEWS.push(['landscape', 'context.layer']);
  if (ctx?.supports) VIEWS.push(['energy', 'energy.layer']);
  if (ctx && scene.geology?.walls) VIEWS.push(['geology', 'geology.view']);
  let setView = () => {};
  if (VIEWS.length) {
    const soil = treeSlot?.querySelector('[name=sides]'), geo = treeSlot?.querySelector('[name=geology]');
    const host = contextSlot || ul.appendChild(document.createElement('li'));
    host.innerHTML = `<h3>${text('views.title')}</h3>
      <div class="context-views" role="group" aria-label="${text('views.title')}">${VIEWS.map(([v, k]) =>
        `<label class="check"><input type="checkbox" name="context-view" value="${v}" data-context-view>${text(k)}</label>`).join('')}</div>`;
    const boxes = [...host.querySelectorAll('[data-context-view]')];
    // Terrain and Electricity Grid can be on together (JC, 26 Nov 2026);
    // Geological stands alone. One view is always on.
    setView = (v, { notify = true } = {}) => {
      let on = String(v || '').split(',').filter(k => VIEWS.some(([x]) => x === k));
      if (on.includes('geology')) on = ['geology'];
      if (!on.length) on = DEFAULT_CONTEXT.split(',').filter(k => VIEWS.some(([x]) => x === k));
      if (!on.length) on = [VIEWS[0][0]];
      for (const r of boxes) r.checked = on.includes(r.value);
      scene.showContext(on.includes('landscape')); scene.showEnergy(on.includes('energy'));
      const geoOn = on.includes('geology');
      if (soil) soil.checked = geoOn; if (geo) geo.checked = geoOn;
      soil?.dispatchEvent(new Event('change'));                 // the studio applies both
      if (notify) { onContextView(on.join(',')); onChange(); }
    };
    for (const r of boxes) r.onchange = () => {
      let on = boxes.filter(b => b.checked).map(b => b.value);
      if (r.checked) on = r.value === 'geology' ? ['geology'] : on.filter(k => k !== 'geology');
      else if (!on.length) { r.checked = true; return; }      // keep one view on
      setView(on.join(','));
    };
    setView(contextView, { notify: false });
  } else {
    scene.showContext(false); scene.showEnergy(false);
    if (contextSlot) contextSlot.textContent = '';
  }
  // Labels: the pits' names and the context's place names.
  ul.querySelector('[data-labels]')?.closest('li').remove();
  if ((pitCounts?.labels || 0) + (ctx?.labels || 0) > 0) {
    const li = document.createElement('li');
    li.innerHTML = `<label class="check"><input type="checkbox"${labels ? ' checked' : ''} data-labels>${text('layer.labels')}${whyButton(text('preview.why'))}</label>
      ${whyBox(`<p>${text('layer.labels.why')}</p>`)}`;
    ul.append(li);
    scene.showLabels(labels);
    li.querySelector('[data-labels]').onchange = e => { scene.showLabels(e.target.checked); onLabels(e.target.checked); onChange(); };
  }
  wireWhy(ul);
  return { props: pc, pits: pitCounts, context: ctx, setContextView: v => setView(v) };
}

// The scale bar's row in the layer list (on by default; screen only, as the bar).
export function mountScaleRow(ul, scene, { text }) {
  ul.querySelector('[data-scalebar]')?.closest('li').remove();
  const li = document.createElement('li');
  li.innerHTML = `<label class="check"><input type="checkbox"${scene.scaleBarOn === false ? '' : ' checked'} data-scalebar>${text('layer.scale')}${whyButton(text('preview.why'))}</label>
    ${whyBox(`<p>${text('layer.scale.why')}</p>`)}`;
  ul.append(li);
  li.querySelector('[data-scalebar]').onchange = e => scene.showScaleBar(e.target.checked);
  wireWhy(li);
  return li;
}

