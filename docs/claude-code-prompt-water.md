# Task: public water supply catchments and SEPA surface-water runoff

## Context
The water layer currently shows OSM rivers, burns, ponds and reservoirs. Add two
national layers for all curated sites in `data/sites/`:
1. **Water Supply Catchments** (Scottish Water): the land that drains to each
   water treatment works intake, i.e. where a place's drinking water comes from.
2. **SEPA surface-water runoff**: the Surface Water & Small Watercourses Flood
   Map v3.0 (extent, depth, velocity and velocity direction), clipped to each
   site through SEPA's REST service. Don't download the national geodatabases
   (the extent layer alone is ~2 GB).
These are screen and artefact layers only. Print files (3MF/STL) don't change.

## Constraints (non-negotiable)
- Read PLAN.md, DATA_LICENCES.md, data/layers.json, providers/water.py,
  providers/subsurface.py (the most recent provider pattern), bake.py,
  provenance.py, web/js/scene/scene.js, caption.js and ink.js first. Extend the
  existing `water` layer registry entry, or add sub-layers under it. Don't create
  a parallel water system.
- 3MF/STL output is byte-identical before and after. Diff an export.
- Every element is labelled DATA, MODELLED, ASSUMED or SCHEMATIC on the model, in
  the legend and in the manifest:
  - DATA: catchment boundaries and their treatment-works names/IDs.
  - MODELLED: all SEPA flood-map values (extent, depth, velocity, direction),
    with the probability band and the climate scenario named.
  - ASSUMED: any simplification tolerance, arrow density, colour breaks.
  - SCHEMATIC: arrow glyph shape and length.
- Licences: SEPA flood maps are OGL v3.0 and also OS terms. The attribution is
  "© SEPA <year>; this SEPA product is licensed under the Open Government Licence
  3.0", plus "Contains OS data © Crown copyright and database right <year>".
  Scottish Water layers: the data.gov.uk summary says "Licence: not set" but the
  ISO metadata says OGL. Record that as **to verify** in DATA_LICENCES.md.
- `why` text in data/layers.json should be neutral and descriptive, marked
  `why_status: "draft, for JC review"`. Colours must pass tests/test_palette.py.
- Work in stages. Show me screenshots and numbers after each.

## Data sources (confirm the current endpoints; report back before building)
1. **Scottish Water's Water Supply Catchments**, ArcGIS FeatureServer:
   `https://services3.arcgis.com/SClJFeTjrkPbtMzT/arcgis/rest/services/SW_Water_Supply_Catchments_Public_(view)/FeatureServer`
   (URL-encode the brackets). Publication date 2026-03-31. Inspect `/0?f=json`
   for fields (works name/ID, source type, area) and report them before choosing
   labels. Query with an envelope (bbox plus 1 km), `inSR=4326`, `outSR=27700`,
   `outFields=*`, and `returnGeometry=true`. Paginate on `exceededTransferLimit`.
   - Keep the full polygon of every catchment that intersects the bbox, so the
     model can say "this catchment extends 14 km to the NW". Clip only for
     drawing.
   - If a site lies in no supply catchment, record that explicitly. Don't treat
     an empty result as an error. (Most urban sites will sit downstream of their
     supply catchment, not inside it. Report this honestly.)
   - Same org, optional but cheap to add to the provider and not drawn yet:
     "Scottish Water's Sewer Catchments" (Drainage Operational Areas) and
     "Septic Tank STWs". Cache them for a later stage.
2. **SEPA Surface Water & Small Watercourses Flood Map v3.0**, ArcGIS REST:
   `https://map.sepa.org.uk/server/rest/services/Open/Flood_Maps/MapServer`
   - Layer 3 is `FRM_FH_SURFACE_WATER_EXTENT_H` (high-probability extent,
     published 2025-02-25), and other layers hold the medium/low extents, and
     depth, velocity and velocity-direction for high/medium/low and medium plus
     climate change (2070, 50th percentile, RCP8.5). List
     `/layers?f=json` and build a table of layer id → {quantity, probability,
     scenario, geometry type} before you write any code. Don't hard-code
     ids unchecked.
   - Vector layers: `/query` with an envelope geometry (BNG, bbox plus 200 m),
     `spatialRel=esriSpatialRelIntersects`, `outFields=*`, geometry
     in 27700, paginated. Clip to the bbox in the pipeline.
   - If depth/velocity/direction are raster-backed or class polygons too
     heavy to query: use `/export` (MapServer export) for that layer only,
     bbox in 27700, size matched to the drape resolution, `format=png32`,
     `transparent=true`, `layers=show:<id>`, and decode classes from the
     legend (`/legend?f=json`). Record which method each layer used.
   - Throttle requests to ≤ 4 in flight to SEPA, retry with backoff, and cache.
   - Gotcha to check: the SEPA services have `maxScale` 5000 / `minScale` 1.5e8.
     If an export at the site extent returns blank, tile the bbox.

## Stage 1: pipeline providers and bundle
- `providers/water_supply.py`: catchments intersecting the bbox, full and
  clipped geometry (simplified to the drape resolution, with the tolerance
  recorded), attributes, and the area of the bbox inside each catchment.
- `providers/surface_water.py`: for the high, medium and low probabilities and
  medium + climate change, fetch the extent polygons and, where available, depth
  classes, velocity classes and velocity direction. Store compact arrays: either
  polygons with a class index, or a class-index raster aligned to the drape
  grid with origin/cell size in BNG.
- Bundle: add `water.supply_catchments` and `water.surface_water` sections (bump
  the schema to the next version, keeping older bundles readable). Watch the
  size-guard budget. Quantise and simplify before raising the budget.
- Report a table for all sites: supply catchments intersecting (names), % of the
  bbox inside any supply catchment, and surface-water extent as a % of the bbox
  for each probability and for CC. Give the max depth class and max velocity
  class, the method used per layer (query/export), and the bytes added to the
  bundle.

## Stage 2: supply catchments on the model (web/js/scene/water-supply.js, new)
- Draw each catchment as a boundary line on the terrain (a 2 px ink-weight line,
  dashed where clipped by the slab edge), with a very light fill tint inside.
- Label each catchment with its treatment works name using the existing
  floating-label layout (no overlaps, threads, kept out of the ink pass). If the
  catchment extends beyond the slab, add a slab-edge arrow on the bearing to
  the catchment's centroid ("Catchment for <works> continues ~14 km →").
- Site with no catchment: one caption line, "Not within a Scottish Water public
  supply catchment," and nothing drawn.

## Stage 3: runoff drape and flow arrows (web/js/scene/surface-water.js, new)
- Extent: paint into the drape canvas as nested bands, low → medium → high
  probability (lightest to darkest blue), plus an outline-only CC band. This is
  MODELLED, and the legend gives the probability wording SEPA uses.
- Depth (toggle): a sequential ramp over the depth classes. Velocity (toggle):
  a separate ramp. Only one choropleth can be active at a time, and it's
  mutually exclusive with other choropleth drapes.
- Velocity direction (toggle): short arrows on a regular grid (spacing ASSUMED,
  default 25 m at model scale, configurable). Draw them as thin ink glyphs on
  the drape, not as 3D objects, and skip cells with no direction value. Legend:
  "direction of modelled surface-water flow, SEPA v3.0".
- Opacity slider. The drape sits over the terrain, imagery and land cover and
  under OSM water linework, so real burns stay legible.
- Caption line: "Modelled flood hazard from surface water and small watercourses
  (SEPA v3.0). Not a prediction for any individual property."

## Stage 4: artefacts, caption, viewer
- The legend groups DATA / MODELLED / ASSUMED / SCHEMATIC.
- Caption and manifest, generated from the data and never hard-coded: Scottish
  Water layer name and publication date, SEPA map version and layer ids used,
  probability bands, the CC scenario wording, methods (query/export),
  simplification tolerance, arrow spacing, attributions and licence status.
- A per-site export of a GeoJSON of the clipped catchments and surface-water
  extents, with provenance properties.
- The offline viewer carries the water data and renders identically.

## Later (don't build now; note in TODO.md)
- Sewer catchments (DOAs) and septic-tank works as a "where drainage goes" layer.
- Scottish Water stopcock density (connected properties) against DWQR Private
  Water Supply Sources (unconnected supplies) as a mains-access layer. Aggregate
  stopcocks to density. Don't draw household points.
- LiDAR DTM flow accumulation, to compare with the SEPA runoff and to catch
  channels below SEPA's 10 km² river-network threshold.
- SEPA baseline confluence inter-catchments
  (`.../Open/Hydrography/MapServer/10`) for watershed walls.

## Done when
- Screenshots for ravenscraig, cockenzie and killean-cowal (rural) and
  hunterston (coastal), from
  the SW and NE: catchments on; extent on; depth on; arrows on.
- The Stage 1 table for all curated sites, including those with no supply
  catchment and no surface-water extent.
- Tests: layer-table discovery (on a recorded `/layers` fixture); envelope query
  pagination; BNG alignment of the drape (a known polygon lands on the right
  terrain texels); export-legend class decoding; slab-edge arrow bearing;
  simplification and quantisation round-trip; bundle encode/decode; layer
  registry and palette tests pass.
- A byte-identical 3MF, bundle sizes within budget, and DATA_LICENCES.md rows for
  SEPA flood maps (OGL, with OS terms) and Scottish Water supply catchments
  (to verify).
