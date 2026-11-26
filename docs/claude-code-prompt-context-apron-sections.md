# Task: context apron, infrastructure past the edge, and N/S/E/W section toggles

## Context
At the moment the model sits on the page as a block with four straight cut walls.
It reads as a decontextualised object, not as part of a landscape. Mock-ups made on
25 Nov 2026 (docs/reference/section-toggles/, code in mock_apron_sections.py) tried
several edge treatments on auchtertool-cato. JC's decisions:

- **Default view: a context apron.** About 1.6 km of coarser terrain round the
  model area. It is desaturated and fades into the background with distance,
  and an ink border marks the model area. See
  `auchtertool-apron-infrastructure.png`.
- **Infrastructure past the edge.** Power lines and pylons, roads, rail,
  rivers, water, pipelines and industrial land run continuously out of the model
  area across the apron. Grid connections, Mossmorran, the battery-storage sites
  and the quarries are part of the argument; the block's edge used to cut them off.
- **Section toggles N S E W** replace the cut walls as the way to see the
  geology. Turning a face on slices the apron back to the plane of that face,
  across the whole width of the context, so the slice runs through the
  landscape. That reveals the model's full BGS cross-section on that face, and
  the apron's own cut face continuing the slice as a plain, fading context band
  with **no label on it**. See `auchtertool-section-toggles-sheet.png`: S; W;
  S+W; N+E seen from the NE.
- **Rejected:** a trench dug in front of the faces, and a lifted-out block.
  Neither is true to the language of the site. Don't build them.

The mock-up is a 2D painter's-algorithm render. Treat it as the target look and
behaviour, not as code to port.

## Constraints (non-negotiable)
- Read PLAN.md, DATA_LICENCES.md, bake.py, providers/, data/overpass/web.ql,
  web/js/scene/scene.js, screenterrain.js, geology.js, geology-math.js,
  web/js/urlstate.js, web/js/app.js and the reference folder first. Follow the
  existing provider, cache, provenance, bundle and test patterns.
- **Print is unchanged.** 3MF/STL output is byte-identical before and after. Diff
  an export. The apron, the extra infrastructure and the section toggles are screen
  and artefact only.
- The page stays strictly black and white (PLAN, 24 Nov). The toggle chips are
  black/white. The model palettes (field, Guthrie, anthropogenic) apply to the
  apron as they do to the land.
- Every element is DATA, CONTEXT, ASSUMED or SCHEMATIC, labelled on the model,
  in the legend and in the manifest. The apron and its cut faces are CONTEXT.
  Say so in the legend and manifest only, never as a label on the model.
  Geology on the model faces keeps its existing labels (unit extents DATA;
  superficial and sheet thickness and vertical contacts ASSUMED; seams
  SCHEMATIC).
- Work in stages. After each stage, show me screenshots from the default camera
  (az 225, el 32) and from az 45 in all three looks, plus the numbers asked for.

## Stage 1: pipeline, the context section of the bundle
1. Bump the bundle schema to `hyperscale-landscapes/site-bundle@4` and update
   bundle.schema.json. Add a `context` section:
   - `pad_m` (default 1600, one constant, configurable per site).
   - `elevation`: same `int16-dm-rowdelta` encoding as `elevation.lidar`, about
     20 m cells. **The grid is snapped to the model edges**: cell size `W/round(W/20)`
     by `H/round(H/20)`, and the model's corners fall exactly on grid vertices.
     Cut faces line up with the walls only if this holds.
     Source: the existing coarse elevation path (Terrarium z13 as in the web tier,
     or Copernicus GLO-30 if the provider already supports it; say which). Record
     `source`, `res_m` and `offset_m`: the median of (LiDAR − context) along the
     model boundary, added to the context so the two surfaces meet. It was
     −0.1 m at Auchtertool in the mock-up. Report it for every site; flag any
     site where |offset| > 3 m.
   - `osm`: a second Overpass query over the padded bbox. Put it in
     data/overpass/context.ql. Include: power line/minor_line, tower/pole;
     highway motorway…unclassified (+ _link); railway rail/disused;
     waterway river/stream/canal; natural=water; landuse
     industrial/quarry/landfill; man_made=pipeline; building; place
     village/hamlet/town nodes. Strip it to what the web app uses (geometry +
     needed tags).
2. Cache and provenance as for the other providers. Rebake all curated
   sites with `--reuse` where possible.
3. Tests: snapping (corners on vertices), offset sign, decode round-trip,
   context.ql parity with any JS query helper (follow test_query_parity.py).
4. Report: gzipped bundle size before/after for every site. Target: under
   +1.5 MB per site; if over, propose thinning (e.g. drop buildings under 50 m²
   in the context).

## Stage 2: web, the apron and infrastructure past the edge
1. Build the apron as a screen-only mesh beside the model terrain (see
   screenterrain.js). Leave out cells inside the model area. Share the edge
   vertices so there's no seam or step at the ink border.
2. Shading: same lighting as the land. Colour: the look's land colour, partly
   desaturated (about 35% toward grey), then blended toward the look's background
   by `0.22 + 0.66 * smoothstep(0, pad, distance outside the model)`. No
   contours, trees, props or glyphs in the apron. Keep the existing fog/haze
   behaviour per look; the fade must work with fog off too.
3. Infrastructure: drape the context OSM over model + apron with the existing
   line/overlay code where possible. Fade lines more weakly than land (to at most
   ~40–50%), so they stay legible to the edge. Pylons/poles as in the model
   area. Landuse names (Mossmorran, the quarries, battery storage) and place
   names as labels in the existing label style. Inside the model area keep
   today's layers as they are; don't draw duplicates.
4. Ink border round the model area (it may already exist as borderEdges) stays
   on in every look.
5. Numbers: apron triangle count, frame time on the default view vs before,
   bundle decode time.

## Stage 3: section toggles N S E W
1. UI: a "Sections" control with four chips, N S E W, off by default, in the
   viewer controls and the offline viewer. Keyboard accessible, with i18n strings.
   URL state: `?cut=` with letters in canonical order NSEW (e.g. `cut=SW`);
   parse and write it in urlstate.js beside site/style/az/el, with tests.
2. Behaviour when a face is on:
   - Leave out apron cells beyond that face's plane across the whole context:
     S removes y < 0, N removes y > H, W removes x < 0, E removes x > W.
     Corner regions go if either adjacent face is on.
   - Show the model's geology wall for that face (the existing geology.js wall
     for that side, with boreholes, contacts and seams as now).
   - Draw the apron's cut face along the same plane, from the model corner to the
     apron's limit (or to the adjacent cut, if that face is on too): context
     colour with a thin cover band, faded with distance like the apron. **No
     label on the context faces.** The legend entry for CONTEXT explains them
     (terrain only; geology not sampled beyond the model).
   - Hide infrastructure, labels and pylons in removed regions. Don't connect
     lines across the cut.
   - Faces turned away from the camera can be on; they show when the camera
     turns. Don't rotate the camera automatically.
   - All four on gives back the plain block with geology on every face. That
     is expected; note it in the help text.
3. Off state: with no faces on, no walls are visible (the apron covers them). The
   surface geology layer (pits, coal extents) works as now and doesn't depend on
   the toggles.
4. Turntable GIFs, still grabs, the caption and the legend follow the toggles.
   The caption names the faces that are open, e.g. "Sections open: S, W".
   export/section.js and export/walls.js are unchanged.
5. Tests (tests/web): removal rules for each toggle combination, corner
   handling, URL round-trip, chips' state ↔ scene state, and that geometry
   for the print is untouched.

## Stage 4 (optional, behind a flag): geology on the context faces
Extend subsurface sampling along each slice line to the apron's limit (the same
40 m step; about 40 extra points per face end, so ~160 per face at the default
pad). With the flag on, context faces show real BGS units, faded like the apron,
recorded as DATA in the legend and manifest (still no labels on the faces). Report the extra WMS calls and the
bake time per site before turning it on by default.

## Stage 5: documentation and licences
- PLAN.md: add a dated decision record (25 Nov 2026): apron + infrastructure as
  the default, section toggles replace cut walls on screen, trench and lift
  rejected, and why.
- DATA_LICENCES.md: add the context elevation source with its attribution
  (Terrarium has no entry yet; add one if it's used), and the
  OSM context query under the existing ODbL entry.
- README / user docs: one short paragraph and a screenshot of the toggles.

## Done when
- [ ] 3MF/STL byte-identical (diff shown).
- [ ] All curated sites rebaked at schema @4; offsets and size increases reported.
- [ ] Default view: apron + infrastructure in all three looks, no seam at the
      border, frame time within 10% of before (or explained).
- [ ] N/S/E/W toggles work in all 16 combinations, from both az 225 and az 45;
      URL `?cut=` round-trips; GIFs and grabs follow.
- [ ] Legend, caption and manifest carry the CONTEXT / DATA / ASSUMED / SCHEMATIC labels.
- [ ] Tests pass (pytest + node tests); new tests added for each stage.
- [ ] PLAN.md and DATA_LICENCES.md updated.
