// Pure helpers for the pits on the surface (subsurface brief, Stage 3).
// No imports, so Node can test this file directly.

export const PIT_SQUARE_M = 50;          // symbol size; not a footprint or hazard zone

// Year a coal pit was abandoned, from its matched mine plans (the plan with
// the most named seams first), or null.
export function abandonedYear(pit) {
  const plans = [...(pit.plans || [])].sort((a, b) => (b.seams?.length || 0) - (a.seams?.length || 0));
  return plans.find(p => p.year_abandoned)?.year_abandoned || null;
}

// Class as drawn:
//  - a quarry-named pit that only matched a coal plan once "Quarry/Quarries"
//    was stripped from its name is drawn as a quarry;
//  - a colliery-named pit is coal by its name alone: the pipeline flags it
//    (coal_by_name); bundles baked before that rule carry it as unknown, so
//    the same rule is applied here too. Labelled as known by name only.
export const collieryByName = p => p.class === 'unknown' && /\bcollier(y|ies)\b/i.test(p.name || '');
export const displayClass = p => (p.coal_by_stripped_name ? 'quarry' : collieryByName(p) ? 'coal' : p.class);

// The label's second line for a class.
export function pitNote(cls, year, sharedName = false, byName = false) {
  if (cls === 'coal' && !year && byName) return 'colliery · no mine plan matched';
  if (cls === 'coal') return year ? `coal mine · abandoned ${year}` : 'coal mine';
  if (cls === 'quarry') return sharedName ? 'quarry · name also on a coal mine plan' : 'quarry';
  return 'mine or quarry · type unknown';
}

// Which classes are drawn by default: coal mines and pits of unknown type on,
// quarries off. Each has its own toggle in the layer key.
export const PIT_CLASSES = ['coal', 'unknown', 'quarry'];
export const DEFAULT_PIT_SHOW = { coal: true, unknown: true, quarry: false };

// Pits grouped by name (one label per name), drawing only the classes in
// `show`. A group's class is coal if any of its drawn pits is coal, else
// unknown if any is unknown, else quarry.
export function groupPits(pits, { show = DEFAULT_PIT_SHOW } = {}) {
  const groups = new Map();
  for (const p of pits || []) {
    const cls = displayClass(p);
    if (!show[cls]) continue;
    const g = groups.get(p.name) || { name: p.name, pits: [], classes: new Set(), years: [], shared: false, byName: false };
    g.pits.push(p); g.classes.add(cls); g.shared ||= !!p.coal_by_stripped_name; g.byName ||= !!p.coal_by_name || collieryByName(p);
    const y = cls === 'coal' && abandonedYear(p); if (y) g.years.push(y);
    groups.set(p.name, g);
  }
  return [...groups.values()].map(g => {
    const cls = g.classes.has('coal') ? 'coal' : g.classes.has('unknown') ? 'unknown' : 'quarry';
    const year = g.years.sort()[0] || null;
    return { name: g.name, cls, pits: g.pits, note: pitNote(cls, year, g.shared, g.byName),
      cx: g.pits.reduce((s, p) => s + p.x, 0) / g.pits.length, cy: g.pits.reduce((s, p) => s + p.y, 0) / g.pits.length };
  });
}

// Screen-space label layout. items: [{ ax (label centre x, px), wpx, hpx }];
// silTop(x0, x1): the highest (smallest y) model pixel across that span.
// Each label's bottom goes `gap` px above the silhouette across its width,
// then (left to right) it is pushed up past any label it overlaps, with
// `pad` px clearance. With `width`, labels slide sideways to stay in frame
// (`shift`, px). Returns [{ bottom, top, x0, x1, shift }] in the items' order.
export function layoutLabels(items, silTop, { gap = 28, pad = 6, sep = 8, width = 0 } = {}) {
  const order = items.map((it, i) => i).sort((a, b) => items[a].ax - items[b].ax);
  const placed = [], out = new Array(items.length);
  for (const i of order) {
    // slide a label sideways to stay inside 0..width (its anchor stays put)
    const it = items[i], margin = 4;
    const cx = width ? Math.min(Math.max(it.ax, it.wpx / 2 + margin), width - it.wpx / 2 - margin) : it.ax;
    const x0 = cx - it.wpx / 2, x1 = cx + it.wpx / 2;
    let bottom = silTop(x0, x1) - gap, moved = true;
    while (moved) {
      moved = false;
      for (const r of placed) {
        if (x1 + pad > r.x0 && x0 - pad < r.x1 && bottom > r.top - pad && bottom - it.hpx < r.bottom + pad) { bottom = r.top - sep; moved = true; }
      }
    }
    const box = { x0, x1, bottom, top: bottom - it.hpx, shift: cx - it.ax };
    placed.push(box); out[i] = box;
  }
  return out;
}

// Per-column silhouette from projected points ([x, y] px): the smallest y in
// each of `cols` columns across width W. Returns silTop(x0, x1), with a small
// dilation (2 columns each side); empty columns count as the bottom (H).
export function silhouette(points, W, H, cols = 400) {
  const sil = new Float32Array(cols).fill(Infinity);
  for (const [x, y] of points) {
    const c = Math.floor(x / W * cols);
    if (c >= 0 && c < cols && y < sil[c]) sil[c] = y;
  }
  return (x0, x1) => {
    let m = Infinity;
    for (let c = Math.max(0, Math.floor(x0 / W * cols) - 2); c <= Math.min(cols - 1, Math.ceil(x1 / W * cols) + 2); c++) m = Math.min(m, sil[c]);
    return m === Infinity ? H : m;
  };
}
