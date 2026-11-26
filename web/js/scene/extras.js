// The site extras in the layer key, shared by the web app and the offline
// viewer so both show and behave the same: 3D props (trees, turbines,
// pylons and lines), the geology walls and the pits on the surface, all
// from the site bundle and all screen only.
import { EVIDENCE } from './palettes.js';

// Strings the extras use (keys of data/i18n); the offline viewer carries them resolved.
export const EXTRAS_KEYS = ['preview.why', 'context.layer', 'context.layer.why', 'energy.layer', 'energy.layer.why',  'layer.scale', 'layer.scale.why', 'layer.electricity', 'layer.electricity.why', 'props.trees', 'props.trees.why', 'props.trees.height', 'props.turbines', 'props.turbines.why',
  'props.pylons', 'props.pylons.why', 'pits.coal', 'pits.coal.why', 'pits.unknown', 'pits.unknown.why', 'pits.quarry', 'pits.quarry.why'];

// ul: the layer list; props / subsurface: the bundle's sections (or null);
// grid, heights, zExag: from the model; seed: the site's stable id;
// text(key, vars): the interface strings; onChange(): after a pit toggle.
// Each layer row's explanation: a small ▾ button after the name (inside the
// label, but with no text of its own, so the label's text stays the name)
// opens the note below. wireWhy(root) is safe to call more than once.
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

// Soil sides and Geology walls as they were before a context row switched them off (per layer list).
const SAVED = new WeakMap();
// treeSlot: where the tree-height slider goes (the studio's Model fieldset), else the Trees row.
export function mountExtras(ul, scene, { props, subsurface, grid, heights, zExag, seed, text, onChange = () => {}, treeSlot = null, context = null, bbox = null, relief = null }) {
  treeSlot?.querySelector('[data-tree-factor]')?.parentElement.remove();   // a rebuild: drop the last model's slider
  const pc = scene.setProps(props, { grid, heights, zExag, seed });
  // Turbines, pylons and lines have no rows of their own: the "Electricity
  // infrastructure" layer row switches them (scene.setVisible('power')), and
  // their notes are added to that row's explanation.
  const elec = [['turbines', pc?.turbines], ['pylons', (pc?.towers || 0) + (pc?.poles || 0) + (pc?.lineSegments || 0)]].filter(([, n]) => n);
  if (elec.length) {
    let row = ul.querySelector('input[data-layer="power"]')?.closest('li');
    if (!row) {          // a site with props but no power features in the model
      row = document.createElement('li');
      row.innerHTML = `<label class="check"><input type="checkbox" checked data-layer="power"><span class="swatch" data-swatch="power" data-screen="#E69F00" style="background:#E69F00"></span>${text('layer.electricity')}${whyButton(text('preview.why'))}</label>
        ${whyBox(`<p>${text('layer.electricity.why')}</p>`)}`;
      ul.append(row);
      row.querySelector('input').onchange = e => scene.setVisible('power', e.target.checked);
    }
    const det = row.querySelector('.why');
    for (const [kind] of elec) { const p = document.createElement('p'); p.textContent = `${text(`props.${kind}`)}: ${text(`props.${kind}.why`)}`; det.append(p); }
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
  // one row per class (BGS BritPits), each with its own toggle; quarries start off.
  scene.setGeology(subsurface, { grid, zExag, on: true });
  const pitCounts = scene.setPits(subsurface, { grid, heights, on: true });
  const PIT_SWATCH = {
    coal: `background:${EVIDENCE.coal}`,
    unknown: `background:#fffaec;outline:1.5px dashed ${EVIDENCE.coal};outline-offset:-1.5px`,
    quarry: `background:#fffaec;outline:1.5px solid ${EVIDENCE.coal};outline-offset:-1.5px`,
  };
  for (const cls of ['coal', 'quarry', 'unknown']) {     // historic coal mines, historic quarries, then type unknown
    if (!pitCounts?.[cls]) continue;
    const on = scene.pits.shown[cls], li = document.createElement('li');
    li.innerHTML = `<label class="check"><input type="checkbox"${on ? ' checked' : ''} data-pits="${cls}"><span class="swatch" style="${PIT_SWATCH[cls]}"></span>${text(`pits.${cls}`)} (${pitCounts[cls]})${whyButton(text('preview.why'))}</label>
      ${whyBox(`<p>${text(`pits.${cls}.why`)}</p>`)}`;
    ul.append(li);
    li.querySelector('[data-pits]').onchange = e => { scene.showPitClass(cls, e.target.checked); onChange(); };
  }
  // The context apron (CONTEXT, never printed): on by default where the bundle has it.
  // Two rows: Landscape Context (the land, routes, water, buildings and names)
  // and Energy Context (pylons, poles and lines only). With either on, the
  // camera stays above the terrain, and Soil sides and Geology walls are
  // switched off (their earlier state comes back when both are off).
  const ctx = scene.setContext(context, { bbox, grid, heights, relief, on: true });
  if (ctx) {
    const km = (context.pad_m / 1000).toFixed(1);
    const rows = [['context', 'background:linear-gradient(90deg,#bdb6a4,#ece8df)', 'context.layer', 'context.layer.why', on => scene.showContext(on)]];
    if (ctx.supports) rows.push(['energy', 'background:linear-gradient(90deg,#5a5a55,#d9d4c8)', 'energy.layer', 'energy.layer.why', on => scene.showEnergy(on)]);
    else scene.showEnergy(false);
    const soil = treeSlot?.querySelector('[name=sides]'), geo = treeSlot?.querySelector('[name=geology]');
    const sync = () => {
      const active = rows.some(([k]) => ul.querySelector(`[data-${k}]`)?.checked);
      const saved = SAVED.get(ul);
      if (active && !saved) {
        SAVED.set(ul, { soil: soil?.checked, geo: geo?.checked });
        if (soil) soil.checked = false; if (geo) geo.checked = false;
      } else if (!active && saved) {
        if (soil) soil.checked = saved.soil !== false; if (geo) geo.checked = saved.geo !== false;
        SAVED.delete(ul);
      } else return;
      soil?.dispatchEvent(new Event('change'));                 // the studio applies both
    };
    for (const [k, sw, label, why, show] of rows) {
      const li = document.createElement('li');
      li.innerHTML = `<label class="check"><input type="checkbox" checked data-${k}><span class="swatch" style="${sw}"></span>${text(label)}${whyButton(text('preview.why'))}</label>
        ${whyBox(`<p>${text(why, { km })}</p>`)}`;
      ul.append(li);
      li.querySelector(`[data-${k}]`).onchange = e => { show(e.target.checked); sync(); onChange(); };
    }
    sync();
  }
  wireWhy(ul);
  return { props: pc, pits: pitCounts, context: ctx };
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

