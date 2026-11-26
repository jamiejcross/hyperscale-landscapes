// Shareable view state in the page URL:
//   ?site=<id>&style=guthrie|field|anthropogenic&az=<deg>&el=<deg>&ctx=landscape|energy|geology&labels=1&dc=1
// (ctx: the context view; labels=1: labels shown, off by default; dc=1: the proposed data centre shown, off by default)
// (style=mossmorran, from links made before that look was retired, opens as guthrie)
// az and el are the CAMERA's angles as seen from the model's centre: az is
// the compass bearing the camera stands at (clockwise from north, so 135 is
// looking from the south-east), el its height above the horizon, held to
// 0–90° (level with the base edge to straight down). (The sun's angles are not in the URL.)
// Pure functions, plus a throttled writer; no other imports, so Node can
// test this file directly.

export const STYLES = ['guthrie', 'field', 'anthropogenic'];
export const CONTEXT_VIEWS = ['landscape', 'energy', 'landscape,energy', 'geology'];
const RETIRED = { mossmorran: 'guthrie' };
export const EL_MIN = 0, EL_MAX = 90;
const SITE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

const num = v => (v === null || v.trim() === '' ? NaN : Number(v));
const round1 = v => Math.round(v * 10) / 10;

// Read the view from a query string. Anything missing or invalid is left out.
export function parseView(search) {
  const p = new URLSearchParams(search), out = {};
  const site = p.get('site');
  if (site && SITE_ID.test(site)) out.site = site;
  const style = RETIRED[p.get('style')] || p.get('style');
  if (STYLES.includes(style)) out.style = style;
  const az = num(p.get('az'));
  if (Number.isFinite(az)) out.az = round1(((az % 360) + 360) % 360);
  const el = num(p.get('el'));
  if (Number.isFinite(el)) out.el = round1(Math.min(EL_MAX, Math.max(EL_MIN, el)));
  // Terrain and Electricity Grid may be on together (written landscape,energy in either order)
  const ctx = (p.get('ctx') || '').split(',').sort((a, b) => CONTEXT_VIEWS.indexOf(a) - CONTEXT_VIEWS.indexOf(b)).join(',');
  if (CONTEXT_VIEWS.includes(ctx)) out.ctx = ctx;
  if (p.get('labels') === '1') out.labels = true;
  else if (p.get('labels') === '0') out.labels = false;
  if (p.get('dc') === '1') out.dc = true;
  return out;
}

// The query string for a view, keeping any other parameters already there.
// A key set to null or undefined is removed.
export function viewSearch(search, view) {
  const p = new URLSearchParams(search);
  for (const k of ['site', 'style', 'az', 'el', 'ctx', 'labels', 'dc']) {
    if (!(k in view)) continue;
    const v = view[k];
    if (k === 'labels' || k === 'dc') { if (v === true) p.set(k, '1'); else p.delete(k); continue; }
    if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) { p.delete(k); continue; }
    if (k === 'az') p.set(k, String(Math.round(((v % 360) + 360) % 360)));
    else if (k === 'el') p.set(k, String(Math.round(Math.min(EL_MAX, Math.max(EL_MIN, v)))));
    else p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

// Write the view to the address bar at most every `ms` milliseconds (the
// last call always lands). `get` returns the current view object.
export function urlWriter(get, ms = 300) {
  let timer = null, last = 0;
  const write = () => {
    timer = null; last = Date.now();
    try {
      const s = viewSearch(location.search, get());
      if (s !== location.search) history.replaceState(history.state, '', `${location.pathname}${s}${location.hash}`);
    } catch { /* some file:// pages refuse; the view still works */ }
  };
  return () => {
    if (timer) return;
    timer = setTimeout(write, Math.max(0, ms - (Date.now() - last)));
  };
}
