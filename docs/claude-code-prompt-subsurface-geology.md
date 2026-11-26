# Task: subsurface geology and coal on the slab walls and surface

## Context
A mock-up (docs/reference/auchtertool-coal-mockup.png, with the code in
docs/reference/mock_geology_walls.js and mock_sample_bgs_edges.py) painted
real BGS geology onto the slab walls of auchtertool-cato and emphasised coal:
- bedrock and superficial units along each wall;
- coal-bearing ground with heavy schematic seams;
- a BGS borehole projected onto the wall;
- historic pits as black squares draped on the land, with names floating
  above the model on threads;
- the seam names from a coal abandonment plan.
Build this properly into the project for all curated sites. It's screen and
artefact only; print files don't change.

Licensing: I hold a BGS licence for non-commercial use, which covers this
project. Treat BGS Geology 50k–derived outputs like the existing
non-commercial satellite layer (see `nonCommercial` in web/js/data/imagery.js):
the caption carries an NC notice, and DATA_LICENCES.md records the licence and
the attribution "Contains British Geological Survey materials © UKRI <year>".
Mining Remediation Authority plan metadata and scans have their own terms; link
them from DATA_LICENCES.md.

## Constraints (non-negotiable)
- Read PLAN.md (§5, §10), DATA_LICENCES.md, pipeline providers, bake.py,
  web/js/scene/scene.js, ink.js and the reference files first. Follow the existing
  provider, cache, provenance and bundle patterns.
- 3MF/STL output is byte-identical before and after. Diff an export.
- Every element is either DATA or labelled as ASSUMED/SCHEMATIC, on the model,
  in the legend and in the manifest. Specifically:
  - DATA: unit extents along walls, the opencast coal resource extent, borehole
    position and depth, pit positions and names, plan seam names.
  - ASSUMED: superficial thickness (till 6 m, glaciofluvial 5 m, alluvium 4 m,
    peat 2 m, made ground 3 m, configurable in one table), sheet thickness (sills
    20–30 m, named limestone beds 4–5 m), vertical projection of bedrock contacts.
  - SCHEMATIC: seam count, spacing and thickness; cyclothem patterns.
- Work in stages. Show me screenshots and numbers after each.

## Data sources (tested; these addresses work as of Nov 2026)
1. BGS Geology 50k, WMS GetFeatureInfo:
   `https://map.bgs.ac.uk/arcgis/services/BGS_Detailed_Geology/MapServer/WMSServer`
   - Layers: `BGS.50k.Bedrock`, `BGS.50k.Superficial.deposits`,
     `BGS.50k.Artificial.ground`, `BGS.50k.Mass.movement`, `BGS.50k.Linear.features`.
   - Gotcha: the layers are scale-limited. Query with a box of ±0.01° around the
     point, width=height=101, i=j=50, version 1.3.0, crs EPSG:4326 (lat,lon
     axis order), info_format=text/xml. Small boxes return nothing.
   - Gotcha: parse attributes with a regex over the text after `<FIELDS `.
     Matching the whole tag fails because some values contain `>`.
   - Useful fields: LEX, LEX_D, RCS, RCS_D, TYPE_D, MAX_PERIOD,
     BGSRED/BGSGREEN/BGSBLUE, MAP_SRC, VERSION.
   - If I later put the licensed 50k GeoPackage in a local folder
     (config: `BGS_GEOLOGY_50K_PATH`), read that instead of WMS. Same output schema.
2. BGS minerals, WMS:
   `https://map.bgs.ac.uk/arcgis/services/GeoIndex_Onshore/minerals_wms/MapServer/WMSServer`
   - `Shallow.Coal`: GetFeatureInfo at wall sample points. MIN_RES =
     "Primary opencast coal resource area".
   - `Mines.and.quarries` (BritPits): no query or identify support and no commodity
     field. Workflow: GetMap a transparent PNG over the bbox, label the connected
     symbol blobs, then GetFeatureInfo at each blob centre (feature_count=5).
     Fields: PIT_NAME, PIT_STATUS, EASTING, NORTHING, BGS_REFERENCE. Use the
     EASTING/NORTHING (BNG) for position, not the blob centre.
   - If a licensed BritPits extract with commodity is present (config:
     `BGS_BRITPITS_PATH`), use it and classify by commodity directly.
3. BGS boreholes, ArcGIS REST query (supports query):
   `https://map.bgs.ac.uk/arcgis/rest/services/GeoIndex_Onshore/boreholes/MapServer/0/query`
   (envelope, inSR=4326, outFields=*). Fields: REFERENCE, NAME, LENGTH,
   YEAR_KNOWN, SCAN_URL, AGS_LOG_URL. The OGC API collection `onshoreboreholeindex`
   is an alternative. Where AGS_LOG_URL exists, parse the AGS file and use the real
   strata (this replaces nominal superficial thickness where a borehole is within
   100 m of a wall). Scanned logs are linked only.
4. BGS Mine Plans, OGC API: `https://ogcapi.bgs.ac.uk/collections/mine_plans/items`
   - Gotchas: bbox queries return nothing (most geometries are empty), and `q=` is
     ignored (it returns everything). Query by exact `mine_name=` (upper case) for
     each BritPits PIT_NAME and simple variants ("X COLLIERY", "X PIT"). Keep only
     records whose gaz_feature_name_comma_list contains the site's council area
     (e.g. FIFE).
   - Fields: mineral_trans_comma_list, seam_name, year_abandoned,
     mra_catalogue_number, has_public_visible_scans_yn, scan_url_comma_list.
   - Example: LITTLE RAITH → MRA plan 10729, coal, abandoned 1932, seams Dunfermline
     Splint, Five Feet, Glassee, Little Splint, Lochgelly Splint & Parrot, Mynheer,
     Rough, Upper Five Feet.
5. Mining Remediation Authority mine entries and zones of influence: the old
   `map.bgs.ac.uk/arcgis/services/CoalAuthority/...` services now return 404.
   Find the current WMS/WFS (data.gov.uk, spatialdata.gov.scot) and report back
   before building on it. If found, add mine entries drawn with their own zone of
   influence (minimum 20 m radius) and use them for the Development High Risk Area
   context.

## Stage 1: pipeline provider (providers/subsurface.py) and bundle
- Sample each wall edge every 40 m (configurable) for bedrock, superficial,
  artificial, mass movement and Shallow.Coal. Collect boreholes in the bbox, plus
  those within 100 m outside it. Collect pits (BritPits) and classify each:
  - coal: Mine Plans record with a coal mineral in the same council area, or
    commodity = coal in a licensed extract;
  - quarry: name contains Quarry/Quarries, or a non-coal commodity;
  - unknown: otherwise.
  Attach plan metadata (catalogue number, year abandoned, seam names, scan
  availability).
- Throttle requests (≤ 8 in flight) and cache like the other providers.
- Bundle: add a "subsurface" section (bump the schema to the next version, keeping
  older bundles readable): per-side sample arrays (compact: a unit table plus
  index arrays), boreholes, pits and plans, the nominal-thickness table used,
  sources and versions, and the licence flag (nonCommercial: true).
- Report a table for all 27 sites: units per wall, % of wall in coal-bearing
  ground, Shallow.Coal hits, boreholes (with AGS logs or not), pits by class, plan
  matches. Flag sites in the coalfield with no plan matches.

## Stage 2: wall geometry and texture (web/js/scene/geology.js, new)
- The terrain-sides geometry is per-triangle. Assign UVs per triangle by its
  centroid's nearest edge (S, E, N, W). Each side runs left to right as seen from
  outside: S west→east, E south→north, N east→west, W north→south. Map into a
  4-strip atlas with v = (3 − k + zFrac)/4, because CanvasTexture flipY puts
  strip 0 at the top.
- Surface profile per side: the max z per bin from the wall's top vertices, with
  LINEAR interpolation across empty bins. Carry-forward causes saw-tooth gaps.
- Depth scale: metres below ground = Δz_mm / (mmPerM × zExag × heightScale).
  Re-render the atlas when the height slider changes.
- Draw order:
  1. bedrock fill, vertical projection, dashed contacts;
  2. sheets (any unit whose LEX_D is a sill, sill-complex or named limestone bed):
     a horizontal band of nominal thickness under the cover, tapered ends, host =
     nearest non-sheet neighbour;
  3. superficial cover from the surface down, nominal or AGS-derived;
  4. a thin turf line.
  Lithology patterns come from RCS_D: sandstone dots, mudstone dashes, limestone
  brick, (micro)gabbro crosses, tuff/lava v's, till pebbles, alluvium dashes.
  Colours are BGS RGB softened towards the field palette. Ink contacts are 2 px.
- Coal emphasis: wherever LEX_D contains "Coal" or Shallow.Coal is hit, darken
  the ground and draw HORIZONTAL seams. They must not follow the ground surface.
  Seams are 0.7–2 m thick and ~9–13 m apart, below the deepest cover base in that
  run, with a pale seat-earth line under each. Label each run "COAL: BGS opencast
  coal resource" or "COAL-BEARING STRATA", plus "seam positions schematic". Where
  a confirmed coal pit's plan has seam names and the pit is within 1 km of that
  wall run, add a dark panel listing them alphabetically, headed by the plan
  reference and year, with "order and depths not shown". If an AGS log gives real
  seam depths, draw those instead and label them DATA.
- Boreholes within 50 m of a wall: project onto it as a red line to the true
  depth, labelled with reference, name, year and depth, and "AGS log" or "scanned
  log, not read".
- Wall texels are not square. Draw all text in an aspect-corrected transform:
  x-scale = (wall height mm / SH px) / (side length mm / CW px). Without this, text
  stretches ~2× sideways.
- Material: field = MeshBasicMaterial({map, vertexColors}), with vertex shading
  light 1.0 / dark 0.86. Mossmorran = MeshStandardMaterial with the same map.
  Studio toggle "Geology walls"; when off, the walls revert to the current
  styles.

## Stage 3: pits on the surface
- Paint a 50 m square per pit into the drape canvas (both looks, every surface
  option; redraw when the drape changes):
  - coal = solid #15110e with a pale 2 px edge;
  - unknown = pale fill with a dashed dark outline;
  - quarry = hidden by default (toggle).
  Legend text: "50 m symbol, not a footprint or hazard zone".
- One floating label per pit name, as a sprite. Coal labels are inverted (dark,
  cream text, "coal mine · abandoned <year>"). Unknown labels are pale with a
  dashed border ("mine or quarry · type unknown"). Draw a thin dark line from the
  label to each of that name's squares.
- Label layout in screen space, re-run on every camera change (throttled to one
  per animation frame while orbiting) and before every grab or turntable frame:
  1. Project the terrain-top vertices (every ~7th) into a per-column screen
     silhouette.
  2. Place each label's bottom 28 px above the silhouette across its width.
  3. Sort by screen x and push up past any overlapping label (6–8 px gap).
  4. Binary-search the label's z so it projects exactly there.
  5. Update the thread end-points.
  Labels must never cover the land or each other.
- Keep sprites and threads out of the ink pass. Add them to ink.render's `hide`
  list rather than using a drawRange hack.

## Stage 4: artefacts, caption, viewer
- New export: "Unfolded walls" PNG/SVG, with the four walls at true horizontal
  scale in two rows (S|E, N|W), corner letters, scale bars, the vertical
  exaggeration stated and the legend. Model it on export/section.js.
- Legend panel in the studio, with DATA, ASSUMED and SCHEMATIC groups as in the
  mock-up.
- Caption and manifest: sources (BGS Geology 50k version, Shallow Coal, BritPits,
  Borehole Index, Mine Plans with catalogue numbers), the nominal-thickness table,
  counts, and the NC notice. Generate these from the data, never hard-code them.
- The offline viewer carries the subsurface data and renders identically.

## Done when
- auchtertool-cato, ravenscraig and cockenzie: screenshots (overview from the SW
  and NE, a close-up of the coal-bearing corner) and the unfolded-walls export,
  compared with docs/reference/auchtertool-coal-mockup.png.
- The Stage 1 table for all 27 sites.
- Tests:
  - side/UV mapping, including the flipY strip order;
  - surface-profile interpolation;
  - depth-scale maths;
  - FIELDS parsing on a fixture with `>` in a value;
  - pit classification;
  - label layout (no overlaps, labels above the silhouette, on a synthetic scene);
  - bundle encode/decode round-trip.
- A byte-identical 3MF, bundle sizes within the size-guard budget, and NC
  notices present on every output that uses 50k data.
