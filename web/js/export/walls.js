// "Unfolded walls" export (subsurface brief, Stage 4): the four geology
// walls laid out flat, seen from outside, at true horizontal scale in two
// rows (south | east, north | west), with corner letters, scale bars, the
// diagram's vertical exaggeration stated, the legend and the BGS notice.
// Modelled on export/section.js: an SVG (the wall paintings are embedded
// PNGs), and a PNG made from it. Screen artefact only.
import { legendModel, captionNote, nominalTable } from '../scene/subsurface-info.js';
import { profileAt } from '../scene/geology-math.js';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const INK = '#000000', GREY = '#5c5c5c', LIGHT = '#d9d9d9';
const FONT = "Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif";
const NAMES = ['SOUTH WALL', 'EAST WALL', 'NORTH WALL', 'WEST WALL'];
const CORNERS = [['SW', 'SE'], ['SE', 'NE'], ['NE', 'NW'], ['NW', 'SW']];   // left, right as seen from outside

function niceStep(x) { const p = 10 ** Math.floor(Math.log10(x)); return [1, 2, 5, 10].map(k => k * p).find(v => v >= x) || 10 * p; }
// Wrap at roughly `px` pixels of 13 px Inter (about 6.6 px a character).
function wrap(t, px, cw = 6.6) {
  const n = Math.max(10, Math.floor(px / cw)), out = []; let line = '';
  for (const w of String(t).split(' ')) { if ((line + ' ' + w).length > n && line) { out.push(line); line = w; } else line = line ? `${line} ${w}` : w; }
  if (line) out.push(line); return out;
}

// The diagram's vertical exaggeration: at least the model's own, raised so
// each wall strip is tall enough to read (stated on the diagram).
export function diagramVex({ dzTrueM, kx, zExag, minPx = 170, max = 12 }) {
  const need = minPx / Math.max(1e-9, dzTrueM * kx);
  return Math.min(max, Math.max(zExag, Math.ceil(need * 10) / 10));
}

// geology: the scene's geology instance; look: the current look;
// caption: captionLines(...) for the site; pitsShown: { coal, unknown, quarry }.
export function wallsSVG({ geology, look, caption, name, pitsShown = { coal: true, unknown: true, quarry: false }, fontCSS = '', width = 1800 }) {
  const G = geology, sub = G.sub;
  const m = { l: 40, r: 40 }, pw = width - m.l - m.r;
  const kx = pw / (G.Wm + G.Hm);                                 // px per metre along the walls
  const dzTrueM = (G.zmax - G.zmin) / (G.mmPerM * G.zExag);      // metres from the slab base to its highest point
  const vex = diagramVex({ dzTrueM, kx, zExag: G.zExag });
  const h = dzTrueM * vex * kx;                                  // strip height, px
  const atlas = G.atlas(look, vex);
  const depthAt = (k, t) => (profileAt(G.surf[k], t) - G.zmin) / (G.mmPerM * G.zExag);
  let dMin = Infinity, dMax = 0;
  for (let k = 0; k < 4; k++) for (let t = 0; t <= 1; t += 0.01) { const d = depthAt(k, t); dMin = Math.min(dMin, d); dMax = Math.max(dMax, d); }

  const out = [];
  let y = 30;
  const text = (x, yy, s, a = '') => out.push(`<text x="${x}" y="${yy}"${a}>${esc(s)}</text>`);
  text(m.l, y, `${caption.title}: the four walls unfolded`, ' font-size="22" font-weight="700" letter-spacing="-0.3"');
  y += 22;
  text(m.l, y, `Seen from outside · true horizontal scale · vertical ×${vex} on this diagram (the model: ×${G.zExag}) · base of the model ≈ ${Math.round(dMin)}–${Math.round(dMax)} m below ground`, ` fill="${GREY}"`);
  y += 12;

  // ---- the walls: two rows of two
  const rows = [[0, 1], [2, 3]];
  for (const row of rows) {
    y += 34;
    let x = m.l;
    const top = y;
    for (const k of row) {
      const L = k % 2 === 0 ? G.Wm : G.Hm, w = L * kx;
      text(x + w / 2, top - 10, NAMES[k], ' font-weight="700" text-anchor="middle" letter-spacing="0.06em"');
      // the strip, resampled to 2x its drawn size
      const c = document.createElement('canvas'); c.width = Math.round(w * 2); c.height = Math.round(h * 2);
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
      g.drawImage(atlas, 0, k * G.SH, G.CW, G.SH, 0, 0, c.width, c.height);
      const id = `wall${k}`, N = 240, pts = [];
      for (let i = 0; i <= N; i++) { const t = i / N; pts.push([x + t * w, top + (G.zmax - profileAt(G.surf[k], t)) / (G.zmax - G.zmin) * h]); }
      const P = pts.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
      out.push(`<clipPath id="${id}"><polygon points="${P} ${(x + w).toFixed(1)},${(top + h).toFixed(1)} ${x.toFixed(1)},${(top + h).toFixed(1)}"/></clipPath>`);
      out.push(`<image href="${c.toDataURL('image/png')}" x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" preserveAspectRatio="none" clip-path="url(#${id})"/>`);
      out.push(`<polyline points="${P}" fill="none" stroke="${INK}" stroke-width="1.5"/>`);
      out.push(`<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="none" stroke="${INK}" stroke-width="1.5"/>`);
      text(x + 3, top + h + 16, CORNERS[k][0], ` fill="${GREY}"`);
      text(x + w - 3, top + h + 16, CORNERS[k][1], ` fill="${GREY}" text-anchor="end"`);
      x += w;
    }
    y = top + h + 16;
  }

  // ---- scale bars: one horizontal (metres along the walls), one vertical (depth at diagram scale)
  const hm = niceStep((G.Wm + G.Hm) / 10), vm = niceStep(dzTrueM / 3);
  y += 30 + vm * vex * kx;
  out.push(`<rect x="${m.l}" y="${y}" width="${(hm * kx).toFixed(1)}" height="3" fill="${INK}"/>`);
  text(m.l, y + 18, `${hm >= 1000 ? `${hm / 1000} km` : `${hm} m`} along the walls`, '');
  const vx = m.l + hm * kx + 60;
  out.push(`<rect x="${vx}" y="${(y + 3 - vm * vex * kx).toFixed(1)}" width="3" height="${(vm * vex * kx).toFixed(1)}" fill="${INK}"/>`);
  text(vx + 10, y + 3, `${vm} m depth (diagram scale, ×${vex})`, '');
  y += 40;

  // ---- legend (generated from the bundle)
  const colW = (pw - 30) / 2, lineH = 17;
  const items = [{ head: 'Legend', big: true }, ...legendItems({ geology: G, look, pitsShown })]
    .map(it => (it.swatch ? { ...it, swatch: { href: it.swatch.toDataURL('image/png'), w: 26, h: 16 } } : it));
  // lay items out in two columns, filling the left first
  const heightOf = it => it.head ? (it.big ? 28 : 8 + wrap(it.head, colW, 6.9).length * lineH) : 4 + wrap(it.text ?? it.note, colW - (it.note ? 0 : 36)).length * lineH;
  const total = items.reduce((s, it) => s + heightOf(it), 0);
  let col = 0, cy = y, colTop = y, colBottom = y;
  items.forEach((it, n) => {
    const hh = heightOf(it), keep = it.head && items[n + 1] ? heightOf(items[n + 1]) : 0;   // a heading stays with its first row
    if (col === 0 && cy - colTop + hh + keep > total / 2 + 40 && !it.big) { col = 1; colBottom = cy; cy = colTop; }
    const x0 = m.l + col * (colW + 30);
    if (it.head) {
      if (it.big) text(x0, cy + 18, it.head, ' font-size="17" font-weight="700"');
      else wrap(it.head, colW, 6.9).forEach((l, i) => text(x0, cy + 8 + 12 + i * lineH, l, ` font-weight="700" fill="${GREY}"`));
    } else if (it.note) {
      wrap(it.note, colW).forEach((l, i) => text(x0, cy + 4 + 12 + i * lineH, l, ` fill="${GREY}" font-size="12"`));
    } else {
      const sy = cy + 4;
      if (it.swatch) out.push(`<image href="${it.swatch.href}" x="${x0}" y="${sy}" width="${it.swatch.w}" height="${it.swatch.h}"/>`);
      else out.push(markSVG(it.mark, x0, sy));
      wrap(it.text, colW - 36).forEach((l, i) => text(x0 + 36, sy + 12 + i * lineH, l, ''));
    }
    cy += hh;
  });
  y = Math.max(cy, colBottom) + 20;

  // ---- caption band, with the BGS notice
  const notice = `${sub.attribution}.${sub.nonCommercial ? ' BGS 1:50 000 geology is licensed for non-commercial use only; commercial reuse needs a BGS licence.' : ''}`;
  const capLines = [[`${caption.title}  ·  ${caption.disclosure}`, true], [notice, true],
    ...wrap(`Sources: ${captionNote(sub)}. ${caption.sources}.`, pw).map(l => [l, false]), ...wrap(caption.footer, pw).map(l => [l, false])];
  out.push(`<rect x="0" y="${y}" width="${width}" height="4" fill="${INK}"/>`);
  capLines.forEach(([l, bold], i) => text(m.l, y + 24 + i * 18, l, `${i ? ` fill="${i === 1 ? INK : GREY}"` : ''}${bold ? ' font-weight="700"' : ''}`));
  const H = y + 24 + capLines.length * 18 + 10;

  return [`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${Math.ceil(H)}" viewBox="0 0 ${width} ${Math.ceil(H)}" font-family="${FONT}" font-size="13" fill="${INK}">`,
    `<title>${esc(caption.title)}: the four walls unfolded</title>`,
    fontCSS ? `<style>${fontCSS}</style>` : '',
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    ...out, '</svg>'].join('\n');
  // (vex is returned through the title line; callers that need it use diagramVex)
}


// Interface wording for the legend's closing note (keys geology.note.* in
// data/i18n), set by the app and the offline viewer from their strings.
let TX = {};
export const GEOLOGY_TEXT_KEYS = ['geology.note.head', 'geology.note.data', 'geology.note.assumed', 'geology.note.schematic', 'geology.note.site',
  'geology.note.plan', 'geology.note.plan.mine', 'geology.note.boreholes', 'geology.note.boreholes.deepest', 'geology.note.coal', 'geology.note.quarry',
  'geology.note.unknown', 'geology.note.hidden', 'geology.note.pits'];
export function setGeologyText(strings) { TX = strings || {}; }
const tx = (k, vars = {}) => Object.entries(vars).reduce((s, [a, v]) => s.replaceAll(`{${a}}`, v), TX[k] ?? k);

// The legend rows, generated from the bundle: { head } | { swatch: canvas,
// text } | { mark: 'coal'|'unknown'|'quarry'|'borehole'|'panel', text } |
// { note }. Shared by the export and the studio's legend panel.
// The note on what is data and what is drawn (wording: geology.note.* in
// data/i18n), filled in for this site: { title, data, assumed, schematic, on_this_site }.
export function dataNote(opts) { return legendItems(opts, true); }

export function legendItems({ geology, look, pitsShown = { coal: true, unknown: true, quarry: false } }, wantNote = false) {
  let note = null;
  const G = geology, sub = G.sub, LG = legendModel(sub, { Wm: G.Wm, Hm: G.Hm });
  const items = [];   // rows are short (two lines at most); the detail goes to the note at the end
  const sw = cv => cv;
  // BGS labels are "Formation — lithology"; a row shows the formation alone
  // unless two rows share it.
  const short = list => list.map(e => {
    const name = e.label.split(' — ')[0];
    return list.filter(o => o.label.split(' — ')[0] === name).length > 1 ? e.label : name;
  });
  if (LG.bedrock.length) {
    items.push({ head: 'Bedrock' });
    const rows = short(LG.bedrock);
    LG.bedrock.forEach((e, i) => items.push({ swatch: sw(G.swatch(e.unit, look)), text: rows[i] }));
  }
  if (LG.sheets.length) {
    items.push({ head: 'Sheets' });
    const rows = short(LG.sheets);
    LG.sheets.forEach((e, i) => items.push({ swatch: sw(G.swatch(e.unit, look)), text: rows[i] }));
  }
  if (LG.cover.length) {
    items.push({ head: 'Superficial and artificial deposits' });
    for (const e of LG.cover) items.push({ swatch: sw(G.swatch(e.unit, look, { cover: true })), text: e.label });
  }
  items.push({ head: 'Coal and records' });
  if (LG.coal) {
    items.push({ swatch: sw(G.coalSwatch(look)), text: 'Coal-bearing ground' });
  }
  const pan = G.panel;
  if (pan) items.push({ mark: 'panel', text: `Mine plan ${pan.plan}` });
  // the site's own records, for the note at the end
  const site = [];
  if (pan) {
    const pl = LG.plans.find(p => p.catalogue === String(pan.plan));
    site.push(pl ? tx('geology.note.plan.mine', { plan: pan.plan, mine: `${pl.mine}${pl.year ? `, abandoned ${pl.year}` : ''}` }) : tx('geology.note.plan', { plan: pan.plan }));
  }
  if (LG.boreholes.length) {
    const deepest = [...LG.boreholes].sort((a, b) => b.depth - a.depth)[0];
    items.push({ mark: 'borehole', text: `BGS boreholes (${LG.boreholes.length})` });
    site.push(deepest.depth >= 10 ? tx('geology.note.boreholes.deepest', { n: LG.boreholes.length, ref: deepest.ref, depth: +deepest.depth.toFixed(1) })
      : tx('geology.note.boreholes', { n: LG.boreholes.length }));
  }
  // historic coal mines, historic quarries, then type unknown (the layer list's order)
  const PIT = { coal: 'Historic coal mine (BritPits)', quarry: 'Historic quarry (BritPits)', unknown: 'Mine or quarry, type unknown (BritPits)' };
  for (const [cls, label] of Object.entries(PIT)) {
    const names = LG.pits[cls]; if (!names.length) continue;
    items.push({ mark: cls, text: label });
    const list = names.join(', ');
    site.push(tx(`geology.note.${cls}`, { names: pitsShown[cls] ? list : tx('geology.note.hidden', { list }) }));
  }
  const anyPits = LG.pits.coal.length + LG.pits.unknown.length + LG.pits.quarry.length;

  // What is data and what is drawn: one synthesised note (wording in data/i18n),
  // with this site's thicknesses and records.
  const nominal = Object.fromEntries(nominalTable(sub));
  const coverT = Object.keys(sub?.nominal_thickness_m?.superficial || {})
    .filter(k => LG.cover.some(e => e.label.toLowerCase().includes(k.replace(/_/g, ' '))))
    .map(k => `${k.replace(/_/g, ' ')} ${nominal[k]} m`);
  const thicknesses = [...(LG.sheets.length ? LG.sheetRanges : []), ...coverT];
  // Not shown in the legend (JC, 25 Nov 2026): kept for the Sources (JSON) download.
  note = {
    title: tx('geology.note.head'),
    data: tx('geology.note.data'),
    assumed: thicknesses.length ? tx('geology.note.assumed', { thicknesses: thicknesses.join(', ') }) : null,
    schematic: LG.coal || pan ? tx('geology.note.schematic') : null,
    on_this_site: site.length ? `${tx('geology.note.site', { items: site.join('; ') })}${anyPits ? ` ${tx('geology.note.pits')}` : ''}` : null,
  };

  return wantNote ? note : items;
}

// Small symbols for legend rows without a unit swatch.
export function markSVG(kind, x, y) {
  const C = '#15110e', RED = '#8b0d06';
  switch (kind) {
    case 'coal': return `<rect x="${x + 5}" y="${y}" width="16" height="16" fill="${C}" stroke="#fffaec" stroke-width="1.5"/>`;
    case 'unknown': return `<rect x="${x + 5}" y="${y}" width="16" height="16" fill="#fffaec" stroke="${C}" stroke-width="1.5" stroke-dasharray="3 2"/>`;
    case 'quarry': return `<rect x="${x + 5}" y="${y}" width="16" height="16" fill="#fffaec" stroke="${C}" stroke-width="1.5"/>`;
    case 'borehole': return `<line x1="${x + 13}" y1="${y - 2}" x2="${x + 13}" y2="${y + 13}" stroke="${RED}" stroke-width="3" stroke-linecap="round"/><circle cx="${x + 13}" cy="${y + 14}" r="3.5" fill="${RED}"/>`;
    case 'panel': return `<rect x="${x}" y="${y}" width="26" height="16" fill="${C}"/><rect x="${x + 4}" y="${y + 4}" width="12" height="2" fill="#fff7e3"/><rect x="${x + 4}" y="${y + 9}" width="15" height="2" fill="#fff7e3"/>`;
    default: return '';
  }
}

export async function wallsPNG(svg, scale = 2) {
  const img = new Image();
  img.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth * scale; c.height = img.naturalHeight * scale;
  const g = c.getContext('2d'); g.scale(scale, scale); g.drawImage(img, 0, 0);
  URL.revokeObjectURL(img.src);
  return new Promise(r => c.toBlob(r, 'image/png'));
}
