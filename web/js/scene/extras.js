// The site extras in the layer key, shared by the web app and the offline
// viewer so both show and behave the same: 3D props (trees, turbines,
// pylons and lines), the geology walls and the pits on the surface, all
// from the site bundle and all screen only.
import { EVIDENCE } from './palettes.js';

// Strings the extras use (keys of data/i18n); the offline viewer carries them resolved.
export const EXTRAS_KEYS = ['preview.why', 'props.trees', 'props.trees.why', 'props.trees.height', 'props.turbines', 'props.turbines.why',
  'props.pylons', 'props.pylons.why', 'pits.coal', 'pits.coal.why', 'pits.unknown', 'pits.unknown.why', 'pits.quarry', 'pits.quarry.why'];

// ul: the layer list; props / subsurface: the bundle's sections (or null);
// grid, heights, zExag: from the model; seed: the site's stable id;
// text(key, vars): the interface strings; onChange(): after a pit toggle.
export function mountExtras(ul, scene, { props, subsurface, grid, heights, zExag, seed, text, onChange = () => {} }) {
  const pc = scene.setProps(props, { grid, heights, zExag, seed });
  const propRows = [['trees', pc?.trees], ['turbines', pc?.turbines], ['pylons', (pc?.towers || 0) + (pc?.poles || 0) + (pc?.lineSegments || 0)]];
  for (const [kind, n] of propRows) {
    if (!n) continue;
    const li = document.createElement('li');
    const slider = kind === 'trees'
      ? `<label class="range" data-hide-looks="anthropogenic">${text('props.trees.height', { x: `<output>${zExag}</output>` })}<input type="range" min="1" max="4" step="0.5" value="${zExag}" data-tree-factor></label>` : '';
    li.innerHTML = `<label class="check"><input type="checkbox" checked data-prop="${kind}">${text(`props.${kind}`)}</label>${slider}
      <details><summary>${text('preview.why')}</summary><p>${text(`props.${kind}.why`)}</p></details>`;
    ul.append(li);
  }
  ul.querySelectorAll('input[data-prop]').forEach(i => { i.onchange = () => { scene.setPropsVisible(i.dataset.prop, i.checked); if (i.dataset.prop === 'pylons') scene.setPropsVisible('lines', i.checked); }; });
  const tf = ul.querySelector('[data-tree-factor]');
  if (tf) tf.oninput = () => { scene.setTreeFactor(+tf.value); tf.parentElement.querySelector('output').textContent = tf.value; };

  // Geology walls (on by default where there are samples), then the pits:
  // one row per class (BGS BritPits), each with its own toggle; quarries start off.
  scene.setGeology(subsurface, { grid, zExag, on: true });
  const pitCounts = scene.setPits(subsurface, { grid, heights, on: true });
  const PIT_SWATCH = {
    coal: `background:${EVIDENCE.coal}`,
    unknown: `background:#fffaec;outline:1.5px dashed ${EVIDENCE.coal};outline-offset:-1.5px`,
    quarry: `background:#fffaec;outline:1.5px solid ${EVIDENCE.coal};outline-offset:-1.5px`,
  };
  for (const cls of ['coal', 'unknown', 'quarry']) {
    if (!pitCounts?.[cls]) continue;
    const on = scene.pits.shown[cls], li = document.createElement('li');
    li.innerHTML = `<label class="check"><input type="checkbox"${on ? ' checked' : ''} data-pits="${cls}"><span class="swatch" style="${PIT_SWATCH[cls]}"></span>${text(`pits.${cls}`)} (${pitCounts[cls]})</label>
      <details><summary>${text('preview.why')}</summary><p>${text(`pits.${cls}.why`)}</p></details>`;
    ul.append(li);
    li.querySelector('[data-pits]').onchange = e => { scene.showPitClass(cls, e.target.checked); onChange(); };
  }
  return { props: pc, pits: pitCounts };
}
