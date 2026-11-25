// Field style: routes and residue areas painted into the land surface (the
// drape), instead of the raised print strips the Mossmorran look shows.
// Presentation only: the vectors are the same features model.js rasterises
// for the print layers, in print millimetres, and nothing here changes them.
//
// Widths are in canvas pixels for a drape 2048 px across, scaled to the
// drape's real width, so lines keep the same weight relative to the model.

export const OVERLAY = {
  baseWidth: 2048,
  // Site red line: three stacked strokes (dark casing, white halo, red core)
  // in the proportions 7/6/4, given in canvas px at 4096 across and scaled by
  // `emphasis` so the core reads at about 3 CSS px in a default view (at 1x
  // it was a hairline once the drape is fitted to the screen).
  boundary: { baseWidth: 4096, emphasis: 5, casing: 7, casingColour: '#16120e', casingAlpha: 0.6, halo: 6, haloColour: '#ffffff', core: 4, coreColour: '#ff4d1f' },
  road: { major: 3, minor: 2, casing: 0.75, fill: '#f3eee4', casingColour: '#6b6256' },
  rail: { width: 1.5, colour: '#3a332b', tickEvery: 10, tickLength: 4, dash: [5, 3] },
  powerLine: { width: 1.25, colour: '#3a332b' },
  residues: { hatchEvery: 5, hatchWidth: 1, fillAlpha: 0.28, outline: 0.75 },
};

// Roads drawn at the "major" width; everything else included is minor.
export const MAJOR_ROADS = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link']);

// Line width in canvas pixels for one overlay kind on a drape `drapeWidth`
// pixels across. kind: a road kind ('primary', 'service', …), 'rail',
// 'railDisused' or 'powerLine'. Roads include their casing.
export function overlayWidth(kind, drapeWidth = OVERLAY.baseWidth) {
  const s = drapeWidth / OVERLAY.baseWidth;
  if (kind === 'rail' || kind === 'railDisused') return OVERLAY.rail.width * s;
  if (kind === 'powerLine') return OVERLAY.powerLine.width * s;
  const core = MAJOR_ROADS.has(kind) ? OVERLAY.road.major : OVERLAY.road.minor;
  return (core + 2 * OVERLAY.road.casing) * s;
}

// Paint the overlays onto a 2D context covering the model area (north up).
// vectors: { roads: [{k, p}], rail: [{p}], railDisused: [{p}], powerLines: [{p}],
//            residues: [{rings: [p, …]} | {disc: [x, y, d]}] }, where p is a
//            flat [x0, y0, x1, y1, …] array in print mm.
// show: { roads, rail, power, residues } booleans (the layer checkboxes).
// residueColour: the residues layer colour.
// colours: { roadFill, roadCasing, rail, power } for the current look (defaults: field).
export function paintOverlays(g, vectors, { Wmm, Hmm, show = {}, residueColour = '#c98a93', colours = {} }) {
  const C = { roadFill: OVERLAY.road.fill, roadCasing: OVERLAY.road.casingColour, rail: OVERLAY.rail.colour,
              power: OVERLAY.powerLine.colour, ...colours };
  const W = g.canvas.width, H = g.canvas.height, s = W / OVERLAY.baseWidth;
  const X = x => x / Wmm * W, Y = y => (1 - y / Hmm) * H;
  const trace = p => { g.moveTo(X(p[0]), Y(p[1])); for (let i = 2; i < p.length; i += 2) g.lineTo(X(p[i]), Y(p[i + 1])); };
  g.save();
  g.lineCap = 'round'; g.lineJoin = 'round';

  if (show.residues !== false && vectors.residues?.length) {
    const pat = hatch(g, residueColour, s);
    for (const f of vectors.residues) {
      g.beginPath();
      if (f.disc) { const [x, y, dm] = f.disc; g.arc(X(x), Y(y), dm / Wmm * W / 2, 0, 2 * Math.PI); }
      else for (const r of f.rings) { trace(r); g.closePath(); }
      g.globalAlpha = OVERLAY.residues.fillAlpha; g.fillStyle = residueColour; g.fill('evenodd');
      g.globalAlpha = 1; g.fillStyle = pat; g.fill('evenodd');
      g.lineWidth = OVERLAY.residues.outline * s; g.strokeStyle = residueColour; g.stroke();
    }
  }

  if (show.roads !== false && vectors.roads?.length) {
    // All casings first, then all fills, so junctions join cleanly.
    for (const pass of ['casing', 'fill']) {
      g.strokeStyle = pass === 'casing' ? C.roadCasing : C.roadFill;
      for (const r of vectors.roads) {
        const w = overlayWidth(r.k, W);
        g.lineWidth = pass === 'casing' ? w : w - 2 * OVERLAY.road.casing * s;
        g.beginPath(); trace(r.p); g.stroke();
      }
    }
  }

  if (show.rail !== false) {
    for (const [key, dashed] of [['rail', false], ['railDisused', true]]) {
      const ls = vectors[key] || [];
      g.strokeStyle = C.rail; g.lineWidth = overlayWidth(key, W); g.lineCap = 'butt';
      for (const r of ls) {
        g.setLineDash(dashed ? OVERLAY.rail.dash.map(v => v * s) : []);
        g.beginPath(); trace(r.p); g.stroke();
        g.setLineDash([]);
        ticks(g, r.p.map((v, i) => (i % 2 ? Y(v) : X(v))), OVERLAY.rail.tickEvery * s, OVERLAY.rail.tickLength * s);
      }
      g.lineCap = 'round';
    }
  }

  if (show.power !== false && vectors.powerLines?.length) {
    g.strokeStyle = C.power; g.lineWidth = overlayWidth('powerLine', W);
    for (const r of vectors.powerLines) { g.beginPath(); trace(r.p); g.stroke(); }
  }
  g.restore();
}

// Short cross-ticks every `every` pixels along a polyline already in pixels.
function ticks(g, p, every, len) {
  g.lineWidth = Math.max(1, g.lineWidth * 0.8);
  let next = every / 2;
  g.beginPath();
  for (let i = 2, run = 0; i < p.length; i += 2) {
    const x0 = p[i - 2], y0 = p[i - 1], dx = p[i] - x0, dy = p[i + 1] - y0, d = Math.hypot(dx, dy);
    if (!d) continue;
    while (next <= run + d) {
      const t = (next - run) / d, x = x0 + dx * t, y = y0 + dy * t, nx = -dy / d * len / 2, ny = dx / d * len / 2;
      g.moveTo(x - nx, y - ny); g.lineTo(x + nx, y + ny);
      next += every;
    }
    run += d;
  }
  g.stroke();
}

// Diagonal hatch pattern in pixel space.
function hatch(g, colour, s) {
  const n = Math.max(3, Math.round(OVERLAY.residues.hatchEvery * s));
  const c = document.createElement('canvas'); c.width = c.height = n;
  const h = c.getContext('2d');
  h.strokeStyle = colour; h.lineWidth = OVERLAY.residues.hatchWidth * s; h.lineCap = 'square';
  h.beginPath(); h.moveTo(0, n); h.lineTo(n, 0); h.moveTo(-n / 2, n / 2); h.lineTo(n / 2, -n / 2); h.moveTo(n / 2, n * 1.5); h.lineTo(n * 1.5, n / 2); h.stroke();
  return g.createPattern(c, 'repeat');
}

// Paint a site boundary (rings: flat [x0, y0, …] arrays in print mm) as a
// route-style red line. Drawn last, so it sits on top of every overlay.
export function paintBoundary(g, rings, { Wmm, Hmm }) {
  if (!rings?.length) return;
  const B = OVERLAY.boundary, W = g.canvas.width, H = g.canvas.height, s = W / B.baseWidth * B.emphasis;
  const X = x => x / Wmm * W, Y = y => (1 - y / Hmm) * H;
  g.save();
  g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath();
  for (const p of rings) { g.moveTo(X(p[0]), Y(p[1])); for (let i = 2; i < p.length; i += 2) g.lineTo(X(p[i]), Y(p[i + 1])); g.closePath(); }
  for (const [w, c, a] of [[B.casing, B.casingColour, B.casingAlpha], [B.halo, B.haloColour, 1], [B.core, B.coreColour, 1]]) {
    g.globalAlpha = a; g.lineWidth = w * s; g.strokeStyle = c; g.stroke();
  }
  g.restore();
}
