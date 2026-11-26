// Scale bar for the preview (screen only; not in saved images). Pure helpers,
// so Node can test them; scene.js owns the element.
//
// A perspective view has no single scale, so the bar is measured at the point
// the camera looks at, across the screen (horizontal ground distance there).
// Heights are exaggerated, so it says nothing about vertical distances.

// Ground metres per CSS pixel at distance `d` (mm) from a camera with vertical
// field of view `fovDeg`, in a view `heightPx` CSS pixels tall.
export function metresPerPx(d, fovDeg, heightPx, mmPerM) {
  if (!(d > 0 && heightPx > 0 && mmPerM > 0)) return null;
  return 2 * d * Math.tan(fovDeg * Math.PI / 360) / heightPx / mmPerM;
}

// The longest 1, 2 or 5 x 10^n metres that fits in `maxPx` pixels.
export function niceBar(mPerPx, maxPx = 120) {
  if (!(mPerPx > 0)) return null;
  const max = mPerPx * maxPx, p = 10 ** Math.floor(Math.log10(max));
  const m = [5, 2, 1].map(k => k * p).find(v => v <= max);
  return { metres: m, px: m / mPerPx, label: m >= 1000 ? `${+(m / 1000).toFixed(3)} km` : `${+m.toFixed(3)} m` };
}
