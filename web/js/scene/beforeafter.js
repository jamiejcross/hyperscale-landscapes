// Before / after (brief §6.4): the same view with and without the proposed
// facility, as a side-by-side image or a crossfade GIF. Both carry the full
// caption, including the footprint's precision and source.
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { captionHeight, withCaption } from 'hl/caption';

const FONT = (px, w = 700) => `${w} ${px}px Inter, "Helvetica Neue", Helvetica, Arial, sans-serif`;
const SPOT = '#d55e00';
export const LABELS = { before: 'Today', after: 'With the proposed data centre' };

// Render the current view twice: today (land as it is, no recess, any
// buildings the site would clear still standing), then with the facility.
function pair(scene, w, h) {
  scene.pause();
  try {
    scene.setBefore(true); const before = scene.renderAt(w, h);
    scene.setBefore(false); const after = scene.renderAt(w, h);
    return { before, after };
  } finally { scene.setBefore(false); scene.resume(); }
}

// A label tab in the top-left corner: black for "today", spot for "after".
function label(g, text, x, y, fs, spot) {
  g.font = FONT(fs);
  const pad = Math.round(fs * 0.5), w = g.measureText(text).width + 2 * pad, h = Math.round(fs * 1.7);
  g.fillStyle = spot ? SPOT : '#000'; g.fillRect(x, y, w, h);
  g.fillStyle = '#fff'; g.fillText(text, x + pad, y + Math.round(h * 0.7));
}

export function sideBySide(scene, caption, { w = 1920, h = 1080, dark = false } = {}) {
  const gap = Math.round(w / 160);
  const pw = Math.floor((w - gap) / 2), ph = h - captionHeight(w, caption);
  const { before, after } = pair(scene, pw, ph);
  const c = document.createElement('canvas'); c.width = w; c.height = ph;
  const g = c.getContext('2d');
  g.fillStyle = dark ? '#000' : '#fff'; g.fillRect(0, 0, w, ph);
  g.drawImage(before, 0, 0); g.drawImage(after, pw + gap, 0);
  const fs = Math.max(14, Math.round(w / 70));
  label(g, LABELS.before, Math.round(fs * 0.8), Math.round(fs * 0.8), fs, false);
  label(g, LABELS.after, pw + gap + Math.round(fs * 0.8), Math.round(fs * 0.8), fs, true);
  return withCaption(c, caption, { dark });
}

export async function crossfadeGIF(scene, caption, { w = 720, h = 720, dark = false, onProgress = () => {} } = {}) {
  const rh = h - captionHeight(w, caption);
  const { before, after } = pair(scene, w, rh);
  const fs = Math.max(14, Math.round(w / 40));
  const frame = (t) => {                       // t = 0 (before) .. 1 (after)
    const c = document.createElement('canvas'); c.width = w; c.height = rh;
    const g = c.getContext('2d');
    g.drawImage(before, 0, 0);
    g.globalAlpha = t; g.drawImage(after, 0, 0); g.globalAlpha = 1;
    label(g, t < 0.5 ? LABELS.before : LABELS.after, Math.round(fs * 0.8), Math.round(fs * 0.8), fs, t >= 0.5);
    return withCaption(c, caption, { dark });
  };
  // hold before 1.2 s, fade 0.8 s, hold after 1.6 s, fade back 0.8 s (loops)
  const fps = 10, seq = [];
  const hold = (t, s) => { for (let i = 0; i < s * fps; i++) seq.push(t); };
  const fade = (a, b, s) => { const n = s * fps; for (let i = 1; i <= n; i++) seq.push(a + (b - a) * (0.5 - 0.5 * Math.cos(Math.PI * i / n))); };
  hold(0, 1.2); fade(0, 1, 0.8); hold(1, 1.6); fade(1, 0, 0.8);
  const gif = GIFEncoder();
  // One palette from both end states, so neither drifts in colour.
  const f0 = frame(0), f1 = frame(1);
  const both = document.createElement('canvas'); both.width = w; both.height = f0.height * 2;
  both.getContext('2d').drawImage(f0, 0, 0); both.getContext('2d').drawImage(f1, 0, f0.height);
  const palette = quantize(both.getContext('2d').getImageData(0, 0, w, both.height).data, 256);
  for (let i = 0; i < seq.length; i++) {
    const f = frame(seq[i]);
    gif.writeFrame(applyPalette(f.getContext('2d').getImageData(0, 0, f.width, f.height).data, palette),
      f.width, f.height, { palette: i === 0 ? palette : undefined, delay: 1000 / fps });
    onProgress(`Encoding frame ${i + 1} of ${seq.length}…`);
    await new Promise(r => setTimeout(r));
  }
  gif.finish();
  return new Blob([gif.bytes()], { type: 'image/gif' });
}
