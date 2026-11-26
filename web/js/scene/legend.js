// The map legend: symbols and colours for what is shown in the current look,
// and the subsurface geology where the site has it (the same rows as the
// studio's geology panel, from export/walls.js legendItems). Used three ways:
//   - a band drawn into saved images and animation frames (caption.js), when
//     "Add a legend" is ticked;
//   - a standalone legend sheet, PNG (legendCanvas) or SVG (legendSVG).
// Screen artefacts only: nothing here touches the print files.
//
// Items: { head, big? } | { swatch: canvas | CSS colour, text } | { mark, text } | { note }.

const INK = '#221d18', COAL = '#15110e', RED = '#8b0d06', LINE = '#ff4d1f', PAPER = '#fffaec';

// Small symbols in a 26 x 16 box, as primitives both canvas and SVG can draw.
export const MARKS = {
  coal: [{ rect: [5, 0, 16, 16], fill: COAL, stroke: PAPER, w: 1.5 }],
  unknown: [{ rect: [5, 0, 16, 16], fill: PAPER, stroke: COAL, w: 1.5, dash: [3, 2] }],
  quarry: [{ rect: [5, 0, 16, 16], fill: PAPER, stroke: COAL, w: 1.5 }],
  borehole: [{ path: 'M13 -2 L13 13', stroke: RED, w: 3 }, { circle: [13, 14, 3.5], fill: RED }],
  panel: [{ rect: [0, 0, 26, 16], fill: COAL }, { rect: [4, 4, 12, 2], fill: '#fff7e3' }, { rect: [4, 9, 15, 2], fill: '#fff7e3' }],
  redLine: [{ rect: [2, 3, 22, 10], stroke: LINE, w: 2.5 }],
  pylon: [{ path: 'M9 16 L13 0 L17 16 Z', fill: 'rgba(255,250,236,0.85)', stroke: INK, w: 1.3 },
    { path: 'M7 3 L19 3 M8.5 6 L17.5 6 M10.5 10 L15.5 13 M15.5 10 L10.5 13', stroke: INK, w: 1.1 }],
  wire: [{ path: 'M0 4 Q13 11 26 4', stroke: INK, w: 1.2 }],
  turbine: [{ path: 'M13 16 L13 6', stroke: INK, w: 1.6 },
    { path: 'M13 6 L13 -1 M13 6 L7 10 M13 6 L19 10', stroke: INK, w: 1.4 }, { circle: [13, 6, 1.6], fill: INK }],
  tree: [{ circle: [9, 9, 5.5], fill: '#5f6141', stroke: INK, w: 0.8 }, { circle: [17, 8, 5], fill: '#666842', stroke: INK, w: 0.8 }],
};

// Draw a mark with its box's top-left at (x, y), `k` px per box unit.
export function drawMark(g, kind, x, y, k = 1) {
  for (const p of MARKS[kind] || []) {
    g.save(); g.translate(x, y); g.scale(k, k);
    g.beginPath();
    if (p.rect) g.rect(...p.rect);
    else if (p.circle) g.arc(p.circle[0], p.circle[1], p.circle[2], 0, Math.PI * 2);
    const path = p.path ? new Path2D(p.path) : null;
    if (p.fill) { g.fillStyle = p.fill; path ? g.fill(path) : g.fill(); }
    if (p.stroke) {
      g.strokeStyle = p.stroke; g.lineWidth = p.w || 1; g.lineCap = 'round'; g.lineJoin = 'round';
      if (p.dash) g.setLineDash(p.dash);
      path ? g.stroke(path) : g.stroke();
    }
    g.restore();
  }
}
export function markSVGOf(kind, x, y) {
  return (MARKS[kind] || []).map(p => {
    const st = `${p.fill ? ` fill="${p.fill}"` : ' fill="none"'}${p.stroke ? ` stroke="${p.stroke}" stroke-width="${p.w || 1}" stroke-linecap="round" stroke-linejoin="round"` : ''}${p.dash ? ` stroke-dasharray="${p.dash.join(' ')}"` : ''}`;
    const t = `transform="translate(${x} ${y})"`;
    if (p.rect) return `<rect ${t} x="${p.rect[0]}" y="${p.rect[1]}" width="${p.rect[2]}" height="${p.rect[3]}"${st}/>`;
    if (p.circle) return `<circle ${t} cx="${p.circle[0]}" cy="${p.circle[1]}" r="${p.circle[2]}"${st}/>`;
    return `<path ${t} d="${p.path}"${st}/>`;
  }).join('');
}

// The map part of the legend, read from the layer list on screen (the same
// rows, names and swatch colours, so the two always agree). Only ticked rows.
// elec: { pylons, turbines } counts; redLine: the caption's red-line text or null;
// geology: true when the geology part follows (it lists the pits itself).
export function mapKeyItems(list, { elec = {}, redLine = null, geology = false } = {}) {
  const items = [{ head: 'On the map' }];
  if (redLine) items.push({ mark: 'redLine', text: redLine.replace(/^Red line:\s*/, 'Red line: ').replace(/\.$/, '') });
  for (const li of list?.querySelectorAll(':scope > li') || []) {
    const input = li.querySelector('label.check input[type=checkbox]');
    if (!input?.checked) continue;
    const label = li.querySelector('label.check').textContent.trim().replace(/\s+/g, ' ');
    if (input.dataset.layer) {
      const sw = li.querySelector('.swatch');
      items.push({ swatch: sw ? getComputedStyle(sw).backgroundColor : INK, text: label });
      if (input.dataset.layer === 'power') {
        if (elec.pylons) items.push({ mark: 'pylon', text: 'Pylon or pole (at recorded height where known)' });
        if (elec.wires) items.push({ mark: 'wire', text: 'Overhead line between supports (sag drawn, not measured)' });
        if (elec.turbines) items.push({ mark: 'turbine', text: 'Wind turbine' });
      }
    } else if (input.dataset.pits && !geology) items.push({ mark: input.dataset.pits, text: label });
    else if (input.dataset.prop === 'trees') items.push({ mark: 'tree', text: label });
    else if ('context' in input.dataset) items.push({ swatch: '#d9d4c8', text: 'CONTEXT (not printed): the land, routes, water and place names round the model, faded with distance' });
    else if ('energy' in input.dataset) items.push({ mark: 'pylon', text: 'CONTEXT (not printed): pylons, poles and overhead lines round the model' });
  }
  return items.length > 1 ? items : [];
}

// ---- layout (shared by the image band, the PNG sheet and the SVG) ----
// Greedy word wrap with a measuring function.
export function wrapText(text, maxW, measure) {
  const out = []; let line = '';
  for (const w of String(text).split(' ')) {
    const t = line ? `${line} ${w}` : w;
    if (measure(t) > maxW && line) { out.push(line); line = w; } else line = t;
  }
  if (line) out.push(line);
  return out;
}
// Items into `cols` columns of about equal height, a heading kept with its
// first row. Returns [{ item, lines, col, y, h }] and the total height.
export function layoutKey(items, { cols, colW, fs, measure, measureBold = measure }) {
  const lh = Math.round(fs * 1.3), iw = Math.round(fs * 2.2), ih = Math.round(iw * 16 / 26), gap = Math.round(fs * 0.6);
  const sized = items.map(it => {
    if (it.head) { const lines = wrapText(it.head, colW, measureBold); return { item: it, lines, h: lines.length * lh + Math.round(fs * (it.big ? 0.8 : 0.5)) }; }
    if (it.note) { const lines = wrapText(it.note, colW, measure); return { item: it, lines, h: lines.length * lh + Math.round(fs * 0.3) }; }
    const lines = wrapText(it.text, colW - iw - gap, measure);
    return { item: it, lines, h: Math.max(ih, lines.length * lh) + Math.round(fs * 0.35) };
  });
  const total = sized.reduce((s, r) => s + r.h, 0), target = total / cols;
  let col = 0, y = 0, maxY = 0;
  sized.forEach((r, i) => {
    const keep = r.item.head && sized[i + 1] ? sized[i + 1].h : 0;
    if (col < cols - 1 && y > 0 && y + r.h + keep > target + lh) { maxY = Math.max(maxY, y); col++; y = 0; }
    r.col = col; r.y = y; y += r.h;
  });
  return { rows: sized, height: Math.max(maxY, y), lh, iw, ih, gap };
}

const font = (px, weight = 400) => `${weight} ${px}px Inter, "Helvetica Neue", Helvetica, Arial, sans-serif`;

// The legend band for an image W px wide: { height, draw(g, x, y, { fg, muted }) }.
export function keyBand(items, W, { fs = Math.max(11, Math.round(W / 130)) } = {}) {
  const m = document.createElement('canvas').getContext('2d');
  const pad = Math.round(fs * 0.8), cols = W >= 1500 ? 3 : W >= 700 ? 2 : 1, colGap = Math.round(fs * 2);
  const colW = (W - 2 * pad - (cols - 1) * colGap) / cols;
  const measure = t => { m.font = font(fs); return m.measureText(t).width; };
  const measureBold = t => { m.font = font(fs, 700); return m.measureText(t).width; };
  const L = layoutKey(items, { cols, colW, fs, measure, measureBold });
  const titleH = Math.round(fs * 1.9);
  return {
    height: pad * 2 + titleH + L.height,
    draw(g, x0, y0, { fg = '#000', muted = '#5c5c5c' } = {}) {
      g.save();
      g.fillStyle = fg; g.font = font(Math.round(fs * 1.1), 700); g.textBaseline = 'alphabetic';
      g.fillText('Legend', x0 + pad, y0 + pad + Math.round(fs * 1.1));
      const top = y0 + pad + titleH;
      for (const r of L.rows) {
        const x = x0 + pad + r.col * (colW + colGap), y = top + r.y, it = r.item;
        if (it.head) {
          g.fillStyle = fg; g.font = font(fs, 700);
          r.lines.forEach((l, i) => g.fillText(l, x, y + fs + i * L.lh));
          continue;
        }
        if (it.note) {
          g.fillStyle = muted; g.font = font(Math.round(fs * 0.92));
          r.lines.forEach((l, i) => g.fillText(l, x, y + fs + i * L.lh));
          continue;
        }
        const iy = y + Math.max(0, Math.round((L.lh - L.ih) / 2) - 1);
        if (it.mark) drawMark(g, it.mark, x, iy, L.iw / 26);
        else if (typeof it.swatch === 'string') {
          g.fillStyle = it.swatch; g.fillRect(x, iy, L.iw, L.ih);
          g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 1; g.strokeRect(x + 0.5, iy + 0.5, L.iw - 1, L.ih - 1);
        } else if (it.swatch) g.drawImage(it.swatch, x, iy, L.iw, L.ih);
        g.fillStyle = fg; g.font = font(fs);
        r.lines.forEach((l, i) => g.fillText(l, x + L.iw + L.gap, y + fs + i * L.lh));
      }
      g.restore();
    },
  };
}

// A standalone legend sheet (the PNG export): the band on white, W px wide.
export function legendCanvas(items, W = 1600) {
  const band = keyBand(items, W, { fs: Math.round(W / 85) });
  const c = document.createElement('canvas'); c.width = W; c.height = band.height;
  const g = c.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, c.height);
  band.draw(g, 0, 0, {});
  return c;
}

// The same sheet as SVG, with its caption lines (title, notices, sources, footer).
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export function legendSVG(items, { title, lines = [], fontCSS = '', width = 1200 }) {
  const fs = 13, pad = 40, cols = 2, colGap = 30, colW = (width - 2 * pad - colGap) / cols;
  const measure = t => String(t).length * 6.6, measureBold = t => String(t).length * 6.9;
  const L = layoutKey(items, { cols, colW, fs, measure, measureBold });
  const out = [], text = (x, y, s, a = '') => out.push(`<text x="${x.toFixed(1)}" y="${y.toFixed(1)}"${a}>${esc(s)}</text>`);
  text(pad, 34, title, ' font-size="20" font-weight="700"');
  const top = 60;
  for (const r of L.rows) {
    const x = pad + r.col * (colW + colGap), y = top + r.y, it = r.item;
    if (it.head) { r.lines.forEach((l, i) => text(x, y + fs + i * L.lh, l, ' font-weight="700"')); continue; }
    if (it.note) { r.lines.forEach((l, i) => text(x, y + fs + i * L.lh, l, ' fill="#5c5c5c" font-size="12"')); continue; }
    const iy = y + Math.max(0, Math.round((L.lh - L.ih) / 2) - 1), k = L.iw / 26;
    if (it.mark) out.push(`<g transform="translate(${x} ${iy}) scale(${k})">${markSVGOf(it.mark, 0, 0)}</g>`);
    else if (typeof it.swatch === 'string') out.push(`<rect x="${x}" y="${iy}" width="${L.iw}" height="${L.ih}" fill="${it.swatch}" stroke="rgba(0,0,0,0.35)"/>`);
    else if (it.swatch) out.push(`<image href="${it.swatch.toDataURL('image/png')}" x="${x}" y="${iy}" width="${L.iw}" height="${L.ih}"/>`);
    r.lines.forEach((l, i) => text(x + L.iw + L.gap, y + fs + i * L.lh, l));
  }
  let y = top + L.height + 24;
  out.push(`<rect x="0" y="${y}" width="${width}" height="4" fill="#000"/>`);
  y += 24;
  for (const [l, bold] of lines) for (const w of wrapText(l, width - 2 * pad, measure)) { text(pad, y, w, bold ? ' font-weight="700"' : ' fill="#5c5c5c"'); y += 18; }
  const H = Math.ceil(y + 10);
  return [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}" font-family="Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif" font-size="${fs}" fill="#000">`,
    `<title>${esc(title)}</title>`, fontCSS ? `<style>${fontCSS}</style>` : '', '<rect width="100%" height="100%" fill="#ffffff"/>', ...out, '</svg>'].join('\n');
}
