// Turntable animations (brief §6.1): one slow orbit of the model, with the
// caption burned into every frame.
//   GIF: gifenc, one shared palette, kept under 8 MB for WhatsApp and
//        Facebook by stepping the size down if needed.
//   Video: MediaRecorder; MP4 where the browser can write it (Safari, recent
//        Chrome), otherwise WebM.  WhatsApp needs MP4.
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { captionHeight, withCaption } from 'hl/caption';

export const SIZES = {
  square: { label: 'Square 1080 × 1080 (Facebook, Instagram)', w: 1080, h: 1080 },
  portrait: { label: 'Portrait 1080 × 1350 (phones)', w: 1080, h: 1350 },
  wide: { label: 'Wide 1920 × 1080 (slides, YouTube)', w: 1920, h: 1080 },
};
export const GIF_LIMIT = 8e6;

const ease = t => 0.5 - 0.5 * Math.cos(Math.PI * t);
const tick = () => new Promise(r => setTimeout(r));

// Camera angle for frame i of n: an optional hold on the starting view, then
// one turn (or part of one) with gentle acceleration at either end.
function angles(n, fps, { turn = 1, holdSeconds = 0 }) {
  const hold = Math.round(holdSeconds * fps), move = Math.max(1, n - hold);
  return Array.from({ length: n }, (_, i) => (i < hold ? 0 : ease((i - hold) / move) * turn * 2 * Math.PI));
}

function frames(scene, caption, { w, h, seconds, fps, turn, holdSeconds, dark }, each) {
  const capH = captionHeight(w, caption);
  const rh = Math.max(64, h - capH);
  const n = Math.round(seconds * fps);
  const a = angles(n, fps, { turn, holdSeconds });
  return (async () => {
    scene.pause(); scene.orbitStart(w / rh);
    try {
      for (let i = 0; i < n; i++) {
        scene.orbitTo(-a[i]);                       // clockwise seen from above
        const frame = withCaption(scene.renderAt(w, rh), caption, { dark });
        await each(frame, i, n);
      }
    } finally { scene.orbitEnd(); scene.resume(); }
  })();
}

export async function makeGIF(scene, caption, opts, onProgress = () => {}) {
  let scale = opts.scaleGif ?? 0.6667;            // 1080 -> 720 px: GIFs balloon at full HD
  for (let attempt = 0; attempt < 4; attempt++) {
    const w = Math.round(opts.w * scale / 2) * 2, h = Math.round(opts.h * scale / 2) * 2;
    const gif = GIFEncoder();
    let palette = null;
    await frames(scene, caption, { ...opts, w, h }, async (frame, i, n) => {
      const data = frame.getContext('2d').getImageData(0, 0, frame.width, frame.height).data;
      palette ||= quantize(data, 256);          // shared palette from the first frame
      gif.writeFrame(applyPalette(data, palette), frame.width, frame.height,
        { palette: i === 0 ? palette : undefined, delay: 1000 / opts.fps });
      onProgress(`Encoding frame ${i + 1} of ${n} (${w} × ${h})…`);
      await tick();
    });
    gif.finish();
    const blob = new Blob([gif.bytes()], { type: 'image/gif' });
    if (blob.size <= GIF_LIMIT || attempt === 3) return { blob, w, h, scale };
    scale *= 0.75;
    onProgress(`That came to ${(blob.size / 1e6).toFixed(1)} MB; trying smaller to stay under 8 MB…`);
  }
}

export function videoType() {
  for (const t of ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'])
    if (globalThis.MediaRecorder?.isTypeSupported?.(t)) return t;
  return null;
}

export async function makeVideo(scene, caption, opts, onProgress = () => {}) {
  const type = videoType();
  if (!type) throw new Error('This browser cannot record video. Try the GIF instead.');
  const canvas = document.createElement('canvas');
  canvas.width = opts.w; canvas.height = opts.h;
  const g = canvas.getContext('2d');
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0];
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8e6 });
  const chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  const done = new Promise(r => { rec.onstop = r; });
  rec.start();
  // Frames are drawn in real time so the recorder's clock matches the frame rate.
  let t0 = performance.now();
  await frames(scene, caption, opts, async (frame, i, n) => {
    g.drawImage(frame, 0, 0, canvas.width, canvas.height);
    track.requestFrame?.();
    onProgress(`Recording frame ${i + 1} of ${n}…`);
    const due = t0 + (i + 1) * 1000 / opts.fps;
    await new Promise(r => setTimeout(r, Math.max(0, due - performance.now())));
  });
  rec.stop(); await done;
  const blob = new Blob(chunks, { type: type.split(';')[0] });
  return { blob, ext: type.includes('mp4') ? 'mp4' : 'webm' };
}
