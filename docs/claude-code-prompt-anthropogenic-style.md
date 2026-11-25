# Task: add a fourth named style, "Anthropogenic"

## Context
The web app has two looks, `guthrie` (the default) and `field`. Mossmorran has been
retired: `?style=mossmorran` now maps to `guthrie` via `RETIRED` in urlstate.js. Add a
third look, **Anthropogenic**. It uses the Guthrie palette but swaps the comic-book ink
treatment for a cartographic one. The style's point is visual hierarchy: the land is soft,
painterly and lineless, while everything people have built (buildings, roads, rail,
pylons, turbines, residues, mine sites, the geological cutaway) is drawn crisply, with
thin outlines.

References (in docs/reference/):
- `auchtertool-guthrie-cartographic-smooth.png`: the target look (overview, mid view,
  cutaway, a before/after of the terrain smoothing).
- `mock_anthropogenic_carto.js`: throwaway mock-up of the drape painting, glyphs, haze
  and slab border.
- `mock_anthropogenic_smooth_terrain.js`: throwaway mock-up of the screen-terrain rebuild.
- `auchtertool-guthrie-palette.png` and `Sir James Guthrie.jpg`: the palette source.

The mock-up scripts were injected into a running page, so they're full of hacks: write
the real thing properly, in the project's own modules. Don't copy them. They show what
to draw and the numbers that worked.

It's presentation only. Print geometry, 3MF/STL, cross-sections, manifests and data are
unchanged.

## Constraints (non-negotiable)
- Read PLAN.md (§5, §10), scene.js (LOOKS, MAKE, setLook, setDrape, setBackground,
  setScreenColours, setShadow, the INKLESS list), ink.js, studio.js, urlstate.js,
  caption.js, contours.js, turntable.js, export/viewer.js, and the subsurface and props
  modules if they exist, before changing anything.
- The Guthrie task has landed: reuse `palettes.js` and its land-cover recolouring.
  Anthropogenic is a palette *plus* a different treatment.
- The props and subsurface tasks have landed (props.js, geology.js, pits.js,
  subsurface-info.js, export/walls.js, scene/extras.js). Read them too.
- Field and Guthrie must render pixel-identically to now. Compare screenshots before
  and after.
- Guthrie stays the default look on every model build; land cover stays the default
  surface.
- 3MF/STL byte-identical. Check by hash (baselines: auchtertool-cato b194caff4b9e,
  larbert 7c734cebc1ae).
- Nothing painted may suggest a feature that isn't in the data. The woodland crowns
  and brushwork are textures and patterns, and the caption must say the crowns are
  symbols, not individual trees.
- Work in stages. Show me screenshots (tools/shoot) after each.

## Stage 1: smoothed screen terrain (web/js/scene/screenterrain.js, new)
The print terrain mesh has channels cut along watercourses, with holes that the print
files fill using the water and base meshes. On screen these read as fins, teeth and
holes. Smoothing the existing vertex heights does NOT fix it (tested): the artefacts
come from the holes and from internal walls, not from bumpy heights.

Build a separate screen-only terrain mesh instead:
1. Find the grid step: the median gap between distinct vertex x values in the terrain
   mesh. It was 0.3 mm on auchtertool-cato. Don't estimate it from vertex count: the
   mesh has duplicated vertices, and that estimate came out wrong (0.21 mm).
2. Height grid: for each cell, take the MAXIMUM z of the print-terrain vertices that
   round into it. Channel cuts only ever go down, so max ignores them.
3. Fill empty cells (the channel holes) from their 8 neighbours, iterating up to 12
   times (a cell needs at least 2 filled neighbours).
4. A 3×3 morphological closing (max filter, then min filter) to shut narrow notches.
5. A 3×3 mean (radius 1). Make the radius a setting; 1 is the default.
6. Build a regular indexed BufferGeometry over the grid: positions, UVs from plan
   position (u = x/Wmm, v = y/Hmm), and computed normals. Sample heights bilinearly
   between grid nodes (node i at xmin + i·cell, no half-cell offset).
7. Walls: keep only the OUTER perimeter wall triangles (centroid within 0.4 mm of the
   bbox edge). The print mesh also has internal walls along cut channels, which must
   not show. Move each wall's top vertices to the smoothed height at that point (bottom
   edge fixed, at least 0.2 mm above the base), so the slab stays sealed. The geology
   walls (geology.js) must follow the same smoothed outer-wall tops in this style, so
   the cutaway meets the land without a gap or a step.
8. Hide the stepped print base (terrain-base) on screen in this style. The outer walls
   and the screen terrain close the slab as seen.
9. Rebuild when the model, height exaggeration or height slider changes, and dispose
   the old geometry.

Use the screen terrain for Anthropogenic only at first, but write it so other looks
can opt in. Add `screenTerrain: true` to the look definition.

Report: grid size, how many cells were filled, the max and mean |Δz| against the print
surface (excluding channel cells), and a before/after crop of a burn. Tests: a synthetic
mesh with a cut channel and a hole comes back flat; the grid-step detector handles
duplicated vertices; bilinear sampling hits grid nodes exactly.

## Stage 2: the drape (web/js/scene/carto.js, new)
For this style, the terrain material is **unlit**
(`MeshBasicMaterial({ map })`): all shading is baked into the drape, like a printed
relief map. Draw the drape at 6144 px on the long side, capped by
renderer.capabilities.maxTextureSize, with mipmaps and maximum anisotropy. Layers,
in order:

1. **Land cover** in the Guthrie palette. Recolour from the base land-cover canvas by
   nearest palette colour. Any pixel with distance² > 900 from every palette colour
   becomes base land, otherwise stray anti-aliased edges pick up random classes.
   Scale nearest-neighbour (no smoothing) when enlarging the 2048 px source.
2. **Relief**: the contour helper's canvas (`contourCanvas(...).canvas`: note it returns
   `{canvas, interval, indexInterval}`), at 3072 px wide, drawn over the whole drape
   with `multiply` at alpha 0.62. This gives baked hillshade plus faint contours.
3. **Brushwork**: ~16,000 strokes per 4096×2000 px, scaled by area. Strokes are 6–27 px
   long, 2–7 px wide, near-horizontal (±0.45 rad), with round caps and a slight curve.
   Tones are picked at random: rgba(255,246,222,0.07), rgba(52,40,22,0.06),
   rgba(120,128,80,0.06), rgba(150,95,60,0.05). Use a seeded PRNG from the site id.
4. **Woodland** (OSM natural=wood / landuse=forest), all lineless:
   - Contact shadow first: each wood polygon filled rgba(38,30,16,0.42), offset
     7 m to the north-east (away from a south-west sun), and blurred by 5 m.
   - Base tint #6a6845 inside the polygon.
   - Stippled crowns on a hexagonal grid about 8.5 m apart, jittered ±25%, with holes
     respected. Conifer share by leaf_type: needleleaved 85%, broadleaved 8%, else 40%.
     Draw north to south, so southern crowns overlap northern ones (a 2.5D read).
     - Broadleaf: a disc 3.6–5.2 m in radius, colour picked from #5f6141 / #666842 /
       #57593b, plus a soft shadow ellipse to the lower right, plus a highlight disc
       rgba(196,190,140,0.35) offset up-left at about half the radius.
     - Conifer: a spire 6–8.5 m tall (width 0.42× height), #33362a, with a lit left
       flank #4f5338 and a small shadow ellipse.
   - Tree rows and hedges (OSM landcover LineStrings): small crowns of 2.6 m radius,
     every 6 m along the line, with shadows.
   - The props task has landed: where the bundle's `props.trees` covers a wood, place
     crowns at the real tree tops with their real crown radii instead of the grid, and
     keep the same symbols. Use the hex grid only where there are no props trees.
5. **Water**, lineless: lakes filled #8a98a0; waterways stroked in the same colour,
   6 m wide for rivers and canals, 3.2 m otherwise. Hide the water mesh.
6. **Routes**, crisp and cased, in canvas px at 6144:
   - roads: casing ink 9 px (major) / 6 px (minor), fill #e4dbc6 at 6.5 / 3.8 px;
   - rail: ink, dashed 12/9, 2.6 px;
   - power lines: ink at 0.8 alpha, 2.2 px (minor lines 1.4 px).
7. **Residues**: fill rgba(166,90,68,0.25), a 45° hatch of #a65a44 at 2 px every 10 px,
   and a 2.5 px edge.
8. **Buildings and receptors in plan view**: a contact shadow (the footprint offset
   1.8 m to the north-east, rgba(30,22,12,0.45)), then the footprint fill (#ddd5c2;
   receptors #8ea0ae) with a 1.6 px ink edge.

Hide the extruded print meshes for roads, power, rail, railDisused, residues, buildings,
receptors and water in this style; their information is now painted. Also hide the 3D
props (trees, turbines, pylons, poles and sagging lines from props.js): the crowns and
glyphs replace them. The other looks keep the 3D props. Pits (pits.js) are painted
after all of this, on top, and keep their three separate toggles (coal, unknown,
quarry; quarries off by default). The site red line, if present, also goes on top.

## Stage 3: outlines (selective)
- Turn the screen-space ink pass OFF for this style. Excluding just the land from it
  doesn't work: it then outlines the hidden base and internal walls (tested).
- The only 3D outlines are explicit line geometry:
  - **Slab border:** from the outer-wall triangles, collect edges that are boundary
    edges (used once) or creases (the two face normals' dot product < 0.5), and draw
    them as LineSegments in ink #2b2115. Rebuild with the walls.
- Every other "outline" is drawn into the drape (routes, footprints, residues) or into
  the glyph textures (stage 4). Natural features (terrain, woods, hedges, water) get no
  outline anywhere.

## Stage 4: 2.5D glyphs (web/js/scene/glyphs.js, new)
Draw glyphs as upright Sprites (center 0.5, 0: they stand on their point), with
CanvasTexture artwork, alphaTest 0.05, and fog enabled. Each glyph gets a small
contact-shadow disc on the ground: CircleGeometry radius 0.18 × glyph height,
#1e160c at 0.28 opacity, offset north-east, depthWrite off.
- **Pylon** (OSM power=tower): a 128×256 texture of a tapered lattice. Cream fill
  rgba(255,250,236,0.85), ink outline 5 px, 5 bays of cross-bracing at 3 px, and two
  cross-arms with insulator stubs. Height = 42 m × 1.3 (glyph legibility), so the
  caption must say "pylon symbols ×1.3 height". Use each tower's `height` from the
  bundle's `props.supports` × 1.3 where it exists, and 42 m × 1.3 otherwise.
- **Turbine** (OSM power=generator, wind): a 256×384 texture. Tapered tower, three
  curved blades and a hub, in fill #efe9da with a 5 px ink outline. Height = hub +
  rotor radius from the bundle's `props.turbines` (`hub_height`, `rotor_diameter`), or
  125 m by default where those are missing, flagged as assumed in the caption.
- **Wood poles / minor lines:** a simple pole glyph. The data distinguishes them:
  `props.supports` entries with `kind: 'pole'`, each with its own `height`.
- Glyphs stay out of every other pass. Sprites face the camera, so they read the same
  from any angle. Check them in turntable GIF frames for flicker.

## Stage 5: atmosphere
- `scene.fog = new THREE.Fog('#d3cdbf', near, far)`, with near = 0.55 × and
  far = 1.75 × the camera–target distance. Update it on every camera change and before
  each grab or turntable frame.
- Labels, threads, pit-label sprites and the slab border have fog off: they must
  stay crisp.
- Background: the Guthrie sky gradient (#a8a596 → #cdc8b9 at 45% → #e7e1d3).
- No toon ramp, no VSM ground shadow (the shadow catcher is off by default in this
  style): depth comes from the baked relief, contact shadows and haze.

## Stage 6: wiring
- LOOKS: `anthropogenic: 'Anthropogenic'`. setLook applies stages 1–5 and fully restores
  on leaving: the original terrain geometry and material, the visible print meshes,
  the ink setting, fog = null, the shadow, the background.
- Studio: Style select entry; checkboxes "Brushwork" and "Relief shading" (both on),
  and "Crown symbols" (on). In the layer key (scene/extras.js), the props rows (trees,
  turbines, pylons) toggle the crowns and glyphs in this style, not the 3D props; the
  tree-height slider does nothing here and should be hidden. The geology walls, the
  three pit toggles and the "Geology legend (BGS)" fieldset work as in the other looks.
- urlstate.js: add `anthropogenic` to `STYLES`, so `?style=anthropogenic` round-trips.
- Caption small print, generated:
  - "Colours after Sir James Guthrie";
  - "woodland drawn as crown symbols, not individual trees";
  - "pylon symbols ×1.3 height";
  - any assumed turbine dimensions;
  - "terrain smoothed for display (~20 m); printed model unchanged";
  - the BGS geology note (`captionNote`) where the site has subsurface data, as now.
- Offline viewer (export/viewer.js, viewer.html, js/viewer/main.js): carries the style
  and renders identically. Build the drape at viewer load from the bundled data, not
  as an embedded 6144 px PNG. The viewer already packs heights, props and subsurface,
  but has no elevation sampler (`contourCanvas` needs `elev.sample` and
  `grid.proj.toLonLat`) and no woods, hedge, water or footprint vectors: add an
  elevation adapter over the packed height grid and pack those vectors. New modules
  must be added to `MODULES` (the packing test fails otherwise). Viewers are already
  6.9–9.9 MB; report the size added per site.
- Screengrabs, turntable GIF/MP4 and the unfolded-walls export (PNG/SVG and the
  sources JSON) all work in this style. Glyph sprites and fog must behave in turntable frames.

## Performance
- The drape build (6144 px, ~6,500 crowns on auchtertool) must finish in under 1.5 s on a
  2020 MacBook Air. Claude Code can only time it on the development machine: report
  those timings, and JC checks on the Air. If it doesn't, build it in an OffscreenCanvas in a worker, or tile it.
  Cache the drape per site and look; rebuild only when the layers, surface or
  brushwork toggle change.
- The screen-terrain rebuild must finish in under 300 ms.

## Done when
- tools/shoot for auchtertool-cato, south-gyle and ravenscraig in Anthropogenic: SW
  overview, NE overview, a mid view and a coal-corner close-up where relevant.
  auchtertool-cato should match docs/reference/auchtertool-guthrie-cartographic-smooth.png
  in kind.
- No fins, teeth, holes or internal walls visible anywhere on the land, in any of those
  views.
- Field and Guthrie are pixel-identical to before. The 3MF hashes match the baselines.
- Toggling all three looks 10× shows no growth in renderer.info.memory.
- The colour-blind check (tests/web/palettes.test.mjs, "evidence colours pass the
  colour-blind check") is extended to this style's evidence colours, including against
  the baked relief at its darkest, and passes.
- Tests: screen terrain (stage 1); a drape-recolour fallback to base for off-palette
  pixels; seeded determinism of brushwork and crowns (same seed → identical pixels);
  slab-border edge extraction on a box (12 edges); fog distances; the URL round-trip;
  the viewer packing test still passes. Run `node --test tests/web/*.test.mjs`.
