// Colours for the stylised looks, in one place. Presentation only: print
// colours, geometry and data are unchanged by any of these.
//
//   field   - the slabmaps-inspired diorama look (values as approved, 24 Nov 2026).
//   guthrie - the field look recoloured after a pastoral by Sir James Guthrie
//             (1859-1930, Glasgow Boys; the painting is public domain), from the
//             colour study in docs/reference/auchtertool-guthrie-palette.png.

const LANDCOVER_CLASSES = [
  'landuse:farmland', 'landuse:meadow', 'landuse:grass', 'landuse:forest', 'natural:wood', 'natural:scrub',
  'natural:heath', 'natural:moor', 'natural:grassland', 'natural:wetland', 'landuse:residential', 'landuse:farmyard',
  'landuse:cemetery', 'landuse:allotments', 'landuse:recreation_ground', 'landuse:commercial', 'landuse:retail',
  'landuse:railway', 'natural:bare_rock', 'natural:scree',
];
export { LANDCOVER_CLASSES };

// Evidence marks shared by every look (colour-blind checked with tools/palette_check.mjs;
// adjusted 25 Nov 2026 with JC's approval). Coal ground and pit squares/labels are one
// class ("coal") and share the near-black.
export const EVIDENCE = { redLine: '#ff4d1f', borehole: '#8b0d06', coal: '#15110e' };

export const PALETTES = {
  field: {
    name: 'Field',
    landcover: {
      'landuse:farmland': '#e2d9a8', 'landuse:meadow': '#cbcd82', 'landuse:grass': '#cbcd82',
      'landuse:forest': '#6f7d52', 'natural:wood': '#6f7d52', 'natural:scrub': '#aeb088',
      'natural:heath': '#b5a989', 'natural:moor': '#b5a989', 'natural:grassland': '#cbcd82',
      'natural:wetland': '#a9bfa9', 'landuse:residential': '#e8dfcf', 'landuse:farmyard': '#d9cba9',
      'landuse:cemetery': '#b9bf86', 'landuse:allotments': '#b9bf86', 'landuse:recreation_ground': '#cbcd82',
      'landuse:commercial': '#d8d1c7', 'landuse:retail': '#d8d1c7', 'landuse:railway': '#d8d1c7',
      'natural:bare_rock': '#a39c88', 'natural:scree': '#a39c88',
    },
    landBase: '#d6d09a',
    // evidence layers (screen and legend); power keeps its own colour
    layers: { water: '#83bec5', buildings: '#f1ece2', roads: '#f3eee4', rail: '#3a332b', residues: '#c98a93', receptors: '#6aa9c9' },
    roof: '#d6cdbd',
    water: '#83bec5',
    walls: { light: '#f4f2ee', dark: '#c9c5bd', base: '#9b968c' },
    channel: '#a9a27f',
    ink: '#221d18',
    background: 'white',
    overlays: { roadFill: '#f3eee4', roadCasing: '#6b6256', rail: '#3a332b', power: '#3a332b' },
    // for the tree/turbine/pylon symbols (trees brief, Stage 6)
    props: {
      scots_pine: { trunk: '#8a5236', crown: ['#3f5a36', '#4b6a3d'] }, spruce: { crown: '#34573a' },
      broadleaf: { crown: '#6b8a45' }, birch: { trunk: '#e8e4da', crown: '#8fae58' },
      turbine: '#f2f0ea', pylon: '#5a5a55',
    },
    brushwork: false,
  },

  guthrie: {
    name: 'Guthrie',
    landcover: {
      'landuse:farmland': '#c2b088', 'landuse:meadow': '#9c9e6c', 'landuse:grass': '#9c9e6c',
      'natural:grassland': '#9c9e6c', 'landuse:recreation_ground': '#9c9e6c',
      'landuse:forest': '#5d5e3f', 'natural:wood': '#5d5e3f', 'natural:scrub': '#7f7a55',
      'natural:heath': '#8e6a50', 'natural:moor': '#8e6a50', 'natural:wetland': '#879082',
      'landuse:residential': '#d9d0bc', 'landuse:farmyard': '#b39b78', 'landuse:cemetery': '#8e8f68',
      'landuse:allotments': '#a3a06a', 'landuse:commercial': '#aca594', 'landuse:retail': '#aca594',
      'landuse:railway': '#a0977f', 'natural:bare_rock': '#9a9282', 'natural:scree': '#9a9282',
    },
    landBase: '#bba886',
    layers: { water: '#8a98a0', buildings: '#d9d1bd', roads: '#ddd3bd', rail: '#3a2e22', residues: '#9a6050', receptors: '#7f93a3' },
    roof: '#d9d1bd',                // the brief gives one building colour
    water: '#8a98a0',
    walls: { light: '#e3dccb', dark: '#b5aa92', base: '#6e5f47' },
    channel: '#a9a27f',             // not in the brief: field's value kept
    ink: '#2b2115',
    background: 'guthrie',          // "Guthrie sky" gradient (see scene.js BACKGROUNDS)
    sky: [[0, '#a8a596'], [0.45, '#cdc8b9'], [1, '#e7e1d3']],
    overlays: { roadFill: '#ddd3bd', roadCasing: '#5d4c38', rail: '#3a2e22', power: '#3a2e22' },
    props: {
      scots_pine: { trunk: '#7a4b33', crown: ['#3d3f2a', '#4a4b31'] }, spruce: { crown: '#34372a' },
      broadleaf: { crown: '#5f6141' }, birch: { trunk: '#d8d0bd', crown: '#7c7a52' },
      turbine: '#e6e0d0', pylon: '#4a3f30',
    },
    // geology walls (subsurface brief): per-unit overrides keyed by BGS LEX_D, else
    // BGS RGB softened 55% towards rgb(184,170,138)
    geology: {
      units: {
        'Pathhead Formation': '#c4b083', 'Lower Limestone Formation': '#9ea3a0',
        'Limestone Coal Formation': '#8a7655', 'Kinghorn Volcanic Formation': '#9a6e57',
        'Midland Valley Sill-complex': '#6e6c4c', 'Dinantian To Westphalian Sills Of Lothians And Fife': '#6e6c4c',
        'St Monans White Limestone': '#b9b6a8', 'Blackhall Limestone': '#b9b6a8', 'Hurlet Limestone': '#b9b6a8',
        'Till': '#9c7f61', 'Glaciofluvial Deposits': '#b5996f', 'Alluvium': '#c8bda0',
      },
      softenTowards: [184, 170, 138], softenBy: 0.55,
      turf: '#5a5034', seams: '#1d1610', coalTint: 'rgba(60,40,22,0.25)',
    },
    brushwork: true,
    captionNote: 'Colours after Sir James Guthrie',
  },
};

// Brushwork for the Guthrie drape: deterministic short curved strokes, as data
// (so a seed always gives the same strokes and GIF frames do not shimmer).
export const BRUSHWORK = {
  perArea: 16000 / (4096 * 4096 * 0.5),     // strokes per px^2 (16,000 on a 4096 x 2048 drape)
  length: [4, 18], width: [1.5, 5], angle: 0.45,
  tones: ['rgba(255,246,222,0.07)', 'rgba(52,40,22,0.06)', 'rgba(120,128,80,0.06)', 'rgba(150,95,60,0.05)'],
};

// Small seeded PRNG (mulberry32) and a string hash for the seed.
export function seedFrom(text) {
  let h = 2166136261 >>> 0;
  for (const ch of String(text)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The stroke list for a W x H drape: [{x, y, len, width, angle, bend, tone}].
export function brushStrokes(W, H, seed) {
  const r = prng(seed), n = Math.round(BRUSHWORK.perArea * W * H), out = [];
  const B = BRUSHWORK;
  for (let i = 0; i < n; i++) {
    out.push({
      x: r() * W, y: r() * H,
      len: B.length[0] + r() * (B.length[1] - B.length[0]),
      width: B.width[0] + r() * (B.width[1] - B.width[0]),
      angle: (r() * 2 - 1) * B.angle,
      bend: (r() * 2 - 1) * 0.35,
      tone: B.tones[Math.floor(r() * B.tones.length)],
    });
  }
  return out;
}

// Paint strokes onto a 2D context (round caps, a slight curve each).
export function paintBrushwork(g, strokes) {
  g.save();
  g.lineCap = 'round';
  for (const s of strokes) {
    const dx = Math.cos(s.angle) * s.len / 2, dy = Math.sin(s.angle) * s.len / 2;
    g.strokeStyle = s.tone; g.lineWidth = s.width;
    g.beginPath();
    g.moveTo(s.x - dx, s.y - dy);
    g.quadraticCurveTo(s.x - dy * s.bend, s.y + dx * s.bend, s.x + dx, s.y + dy);
    g.stroke();
  }
  g.restore();
}

// Swatch colour for a layer in a look (falls back to its screen colour).
export function layerSwatch(id, look, screenColour) {
  const P = PALETTES[look];
  if (!P) return screenColour;
  if (id === 'terrain') return P.landBase;
  return P.layers[id] || screenColour;
}
