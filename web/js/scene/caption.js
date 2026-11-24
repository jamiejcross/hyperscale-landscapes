// Caption strips drawn INTO exported images (brief §6): site name, height
// exaggeration, data sources and licences, the date, and the footprint
// precision.  A full band runs along the bottom and a one-line band along
// the top, so a single crop rarely removes both.

export function captionLines({ name, exaggeration, sources, footprint, date = new Date() }) {
  const d = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  return {
    title: name || 'Terrain model',
    disclosure: exaggeration,
    sources,
    footer: [footprint, `Made ${d} with Hyperscale Landscapes`].filter(Boolean).join(' · '),
    top: `${name || 'Terrain model'} · ${exaggeration} · ${sources.split(';')[0]} and others · ${d}`,
  };
}

function wrap(g, text, maxW) {
  const words = text.split(' '), out = [];
  let line = '';
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (g.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t;
  }
  if (line) out.push(line);
  return out;
}

// Returns a new canvas: the render with caption bands attached above and
// below it (part of the same image, so they travel with it, without hiding
// any of the model).
const font = (px, weight = 400) => `${weight} ${px}px system-ui, -apple-system, "Segoe UI", Arial, sans-serif`;

// Layout of the caption bands for an image `W` pixels wide.
function layout(W, caption) {
  const fs = Math.max(12, Math.round(W / 120));          // body text size
  const pad = Math.round(fs * 0.8), lh = Math.round(fs * 1.3);
  const m = document.createElement('canvas').getContext('2d');
  const titleFs = Math.round(fs * 1.25);
  m.font = font(fs);
  const srcLines = wrap(m, caption.sources, W - 2 * pad);
  const footLines = wrap(m, caption.footer, W - 2 * pad);
  m.font = font(titleFs, 650); const tw = m.measureText(caption.title).width;
  m.font = font(fs, 600); const disc = `  ·  ${caption.disclosure}`;
  const discInline = pad + tw + m.measureText(disc).width < W - pad;
  const bandH = pad * 2 + Math.round(titleFs * 1.25) + lh * (srcLines.length + footLines.length + (discInline ? 0 : 1));
  const topH = Math.round(fs * 1.8);
  return { fs, pad, lh, titleFs, srcLines, footLines, tw, disc, discInline, bandH, topH };
}

// Total height the caption bands add to an image W pixels wide.
export function captionHeight(W, caption) { const L = layout(W, caption); return L.bandH + L.topH; }

export function withCaption(render, caption, { dark = false } = {}) {
  const W = render.width;
  const { fs, pad, lh, titleFs, srcLines, footLines, tw, disc, discInline, bandH, topH } = layout(W, caption);

  const out = document.createElement('canvas');
  out.width = W; out.height = topH + render.height + bandH;
  const g = out.getContext('2d');
  const bg = dark ? '#16181b' : '#f7f5f0', fg = dark ? '#ecebe8' : '#22201c', muted = dark ? '#b8b4ac' : '#55504a';
  g.fillStyle = bg; g.fillRect(0, 0, W, out.height);
  g.drawImage(render, 0, topH);

  // Bottom band: title and disclosure on one line, then sources, then footer.
  let y = topH + render.height + pad + titleFs;
  g.fillStyle = fg; g.font = font(titleFs, 650); g.fillText(caption.title, pad, y);
  g.font = font(fs, 600);
  if (discInline) g.fillText(disc, pad + tw, y);
  else { y += lh; g.fillText(caption.disclosure, pad, y); }
  y += Math.round(titleFs * 0.25);
  g.font = font(fs); g.fillStyle = muted;
  for (const l of srcLines) { y += lh; g.fillText(l, pad, y); }
  for (const l of footLines) { y += lh; g.fillText(l, pad, y); }

  // Top band, shortened to fit.
  g.fillStyle = fg; g.font = font(Math.round(fs * 0.9));
  let top = caption.top;
  while (g.measureText(top).width > W - 2 * pad && top.length > 20) top = top.slice(0, -4) + '…';
  g.fillText(top, pad, Math.round(topH * 0.66));
  return out;
}

// Alt text drafted from the model's statistics (brief §9, accessibility).
export function altText({ name, report, exaggeration, surface }) {
  const f = report.features || {};
  const n = (layer, pred = () => true) => Object.entries(f[layer] || {}).filter(([k]) => pred(k)).reduce((s, [, v]) => s + v, 0);
  const c = report.counts || {};
  const parts = [
    `${c.buildings + c.receptors} buildings`,
    n('power', k => k.startsWith('substation')) && `${n('power', k => k.startsWith('substation'))} substation(s)`,
    n('power', k => k.startsWith('line')) && `${n('power', k => k.startsWith('line'))} high-voltage line(s)`,
    n('residues') && `${n('residues')} industrial residue feature(s)`,
    n('rail', k => /disused/.test(k)) && `${n('rail', k => /disused/.test(k))} disused railway(s)`,
    c.receptors && `${c.receptors} school, care or community building(s)`,
  ].filter(Boolean);
  return `Oblique 3D view of a terrain model of ${name || 'the chosen area'}, ${surface}. ${exaggeration}. Shows ${parts.join(', ')}.`;
}
