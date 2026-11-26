# Task: add a third named style, "Guthrie"

## Context
The web app has two looks, switched by `setLook()` in web/js/scene/scene.js:
`mossmorran` and `field`. A colour study (docs/reference/auchtertool-guthrie-palette.png)
re-coloured the field look with a palette taken from a pastoral by Sir James Guthrie
(1859–1930, Glasgow Boys; public domain), in docs/reference/Sir James Guthrie.jpg.
Make it a third named style, **Guthrie**.

It's the field look (toon shading, ink outlines, VSM shadows, 20° FOV, the same camera
limits) with a different palette, a sky-gradient background and an optional brushwork
texture on the land. It's presentation only: geometry, data, labels and print files are
unchanged.

## Constraints (non-negotiable)
- Read scene.js (LOOKS, FIELD, FIELD_LANDCOVER_COLOURS, MAKE, paletteMap/recolour, setLook,
  setBackground, setScreenColours), ink.js, studio.js, urlstate.js, caption.js and
  export/viewer.js first. Reuse the field code paths. Don't fork them.
- Mossmorran and Field must render pixel-identically to now. Compare screenshots
  before and after.
- 3MF/STL are byte-identical. Diff an export.
- Evidence colours stay distinguishable from each other and from the land: residues,
  schools/care/community, coal, the red line, pit squares and labels, and borehole
  markers. See the colour-blind check under "Done when".

## 1. Palettes in one place
Move the per-look colours into a new web/js/scene/palettes.js:
`PALETTES = { field: {...}, guthrie: {...} }`. Field's values are copied unchanged
from scene.js, and scene.js reads from here. Guthrie's values:

**Land cover** (same OSM classes as FIELD_LANDCOVER_COLOURS):

| class | hex |
|---|---|
| landuse:farmland | #c2b088 |
| landuse:meadow, landuse:grass, natural:grassland, landuse:recreation_ground | #9c9e6c |
| landuse:forest, natural:wood | #5d5e3f |
| natural:scrub | #7f7a55 |
| natural:heath, natural:moor | #8e6a50 |
| natural:wetland | #879082 |
| landuse:residential | #d9d0bc |
| landuse:farmyard | #b39b78 |
| landuse:cemetery | #8e8f68 |
| landuse:allotments | #a3a06a |
| landuse:commercial, landuse:retail | #aca594 |
| landuse:railway | #a0977f |
| natural:bare_rock, natural:scree | #9a9282 |
| base land (no class) | #bba886 |

**Model and scene:**
- water #8a98a0 (opaque, as in field)
- buildings #d9d1bd
- industrial residues #a65a44
- schools/care/community #7f93a3
- ink #2b2115
- slab walls (when the geology walls are off): light #e3dccb, dark #b5aa92, base #6e5f47
- background: a vertical gradient #a8a596 (top) → #cdc8b9 (45%) → #e7e1d3 (bottom),
  registered as a background option "Guthrie sky", which is the default when entering
  this style
- ground shadow: as field

**Painted overlays** (roads etc. drawn into the drape):
- road fill #ddd3bd, casing #5d4c38
- rail and power lines #3a2e22

**Props** (if the trees/turbines/pylons work has landed; otherwise add these keys for
it to use):
- Scots pine: trunk #7a4b33, crown #3d3f2a / #4a4b31
- spruce #34372a
- broadleaf #5f6141
- birch: trunk #d8d0bd, crown #7c7a52
- turbine #e6e0d0
- pylon #4a3f30

**Geology walls** (if the subsurface work has landed): a per-unit override map keyed by
LEX_D, with a fallback that softens BGS RGB 55% towards rgb(184,170,138):
- Pathhead Formation #c4b083
- Lower Limestone Formation #9ea3a0
- Limestone Coal Formation #8a7655
- Kinghorn Volcanic Formation #9a6e57
- sills (Midland Valley Sill-Complex; Dinantian to Westphalian Sills of Lothians and
  Fife) #6e6c4c
- named limestone beds (St Monans White, Blackhall, Hurlet) #b9b6a8
- superficial: till #9c7f61, glaciofluvial #b5996f, alluvium #c8bda0
- turf line #5a5034
- coal seams #1d1610, coal-ground tint rgba(60,40,22,0.25)

Other BGS units fall back to the softened BGS colour. Log any fallback units
per site, so we can add tones for them.

## 2. The look itself
- Add `guthrie: 'Guthrie'` to LOOKS. In MAKE, `guthrie(mesh)` = `field(mesh)` using the
  guthrie palette. setLook applies everything field does (lights, tone mapping, VSM, FOV
  and camera limits, ink on), plus the guthrie background, ink colour and screen colours.
  Switching back restores the previous look's values exactly.
- Generalise the land-cover recolouring: `paletteMap(fromPalette, toPalette)`, so the
  drape is remapped from the base land-cover canvas to field or guthrie by
  nearest-colour, as now. Cache one recoloured drape texture per look. Satellite and
  contour surfaces are not recoloured.
- Ink colour per look: make INK a function of the current look (or have setLook set
  INK.colour) rather than a module constant.

## 3. Brushwork texture (optional; on by default in Guthrie, off elsewhere)
- Drawn into the recoloured land-cover drape only, after recolouring: ~16,000 short
  curved strokes per 4096 px drape (scale the count by drape area).
  - length 4–18 px, width 1.5–5 px, round caps, near-horizontal (±0.45 rad);
  - four tones picked at random: rgba(255,246,222,0.07), rgba(52,40,22,0.06),
    rgba(120,128,80,0.06), rgba(150,95,60,0.05).
- Deterministic: a seeded PRNG from the site id, so the same site always gets the same
  strokes and GIF frames don't shimmer.
- Studio checkbox "Brushwork", shown only in Guthrie. The caption says nothing about
  brushwork: it adds no information. But PLAN.md should note it's a texture, not data.

## 4. Wiring
- Studio: add Guthrie to the Style select.
- urlstate.js: add `'guthrie'` to STYLES (`?style=guthrie`). Update the parse/serialise tests.
- Layer panel swatches show the active look's colours.
- Caption: in Guthrie, add "Colours after Sir James Guthrie" to the small print
  (one line, generated). Sources and exaggeration lines are unchanged.
- Offline viewer (export/viewer.js, viewer.html, js/viewer/main.js): carries the style,
  the palette and the brushwork setting, and renders identically.
- Screengrabs, turntable GIF/MP4 and the unfolded-walls export (if present) all use the
  active look.

## Done when
- tools/shoot (the screenshot harness), for auchtertool-cato, south-gyle and ravenscraig
  in all three looks, from the SW and NE. Guthrie on auchtertool-cato should match
  docs/reference/auchtertool-guthrie-palette.png in kind.
- Mossmorran and Field shots are pixel-identical to before. The 3MF is byte-identical.
- Colour-blind check (add tools/palette_check.mjs, a pure function plus a test):
  - simulate deuteranopia, protanopia and tritanopia (Machado 2009 matrices);
  - require CIEDE2000 ΔE ≥ 15 between every pair of evidence colours (residues,
    schools, coal, red line, pit labels, borehole red);
  - require ΔE ≥ 10 between each evidence colour and the three most common land
    colours.
  Report the table. If a pair fails, propose an adjusted hex and show it, but don't
  change the palette without asking me.
- Tests pass, including new ones for the palette mapping (every field class has a
  guthrie entry), brushwork determinism (same seed → identical pixels), and the URL
  style round-trip.
- Toggling between the three looks 10× shows no growth in renderer.info.memory.
