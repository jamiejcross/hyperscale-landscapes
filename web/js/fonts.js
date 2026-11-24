// Inter (SIL OFL 1.1, vendored) as embeddable @font-face CSS, for artefacts
// that must carry their own type: saved SVGs and the offline viewer.
let cached = null;

async function b64(url) {
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function fontFaceCSS() {
  if (cached) return cached;
  const faces = await Promise.all([400, 700].map(async w =>
    `@font-face{font-family:"Inter";font-weight:${w};src:url(data:font/woff2;base64,${await b64(`vendor/fonts/inter-latin-${w}.woff2`)}) format("woff2")}`));
  cached = faces.join('');
  return cached;
}
