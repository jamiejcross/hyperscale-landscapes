# Task: industrial pollutant releases (SPRI pins) and gridded emissions (NAEI drapes)

## Context
The models show the shape of each site but not what is released into the land, air
and water around it. Add two layers for all curated sites in `data/sites/`:
1. **SPRI pins**: one pin for each SEPA-regulated industrial site that reports to
   the Scottish Pollutant Release Inventory, within the site bbox plus a buffer.
2. **NAEI drapes**: 1 km gridded emissions from the UK National Atmospheric
   Emissions Inventory, painted onto the terrain surface as a choropleth drape.
These are screen and artefact layers only. Print files (3MF/STL) don't change.

These two sources measure different things. Keep them separate in the code, the
legend and the caption, and never merge them into one "pollution" score:
- SPRI = REPORTED. Annual totals that operators report to SEPA, only above
  pollutant-specific thresholds. A missing site is not a zero.
- NAEI = MODELLED. National totals spread onto a 1 km grid using proxy data.
  These are estimates, not measurements, and not concentrations or exposures.

## Constraints (non-negotiable)
- Read PLAN.md, DATA_LICENCES.md, data/layers.json, the pipeline providers
  (follow providers/subsurface.py as the most recent pattern), bake.py,
  provenance.py, web/js/data/imagery.js (the `nonCommercial` pattern),
  web/js/scene/scene.js, caption.js and ink.js first. Follow the existing
  provider, cache, provenance, layer-registry and bundle patterns.
- 3MF/STL output is byte-identical before and after. Diff an export.
- Every element is labelled REPORTED, MODELLED, ASSUMED or SCHEMATIC on the
  model, in the legend and in the manifest:
  - REPORTED: SPRI site position, operator, sector, pollutant, medium
    (air / water / waste water / waste transfer), year, quantity (kg).
  - MODELLED: NAEI cell values (t/km²/yr), pollutant, year, sector if used.
  - ASSUMED: pin-height scaling, the buffer distance, colour class breaks.
  - SCHEMATIC: pin shape and stem.
- Licences: put each source in DATA_LICENCES.md as **to verify** until it has
  been checked at the source. Don't ship a layer whose licence is unresolved
  without a visible "licence to verify" note in the caption.
- Add both layers to data/layers.json with neutral, descriptive `why` text, marked
  `why_status: "draft, for JC review"`. Use colours that pass tests/test_palette.py.
- Work in stages. Show me screenshots and numbers after each.

## Data sources (find and confirm the current endpoints; report back before building)
1. **SPRI data (SEPA)**: https://www.sepa.org.uk/environment/environmental-data/spri
   - Yearly "Scottish Pollutant Release Inventory <year> - Full data (Excel)"
     downloads. Use the latest year that has a full-data file (2024 was
     published 30 Sep 2025 as Official Statistics; the dashboard is
     https://shiny.data.gov.scot/sepa/spri/. If the 2024 full-data Excel isn't
     there, use 2023 and say so). Keep the previous 5 years so pins can show
     a trend.
   - There is also a SPRI MapService (via spatialdata.gov.scot / data.gov.uk:
     "Scottish_Pollutant_Release_Inventory (MapService)") with layers Air
     Releases, Water Releases, Waste Water Releases and Waste Transfers, and
     ATOM feeds such as `http://map.sepa.org.uk/atom/SEPA_SPRI_Waste_Water_releases.atom`.
     Check whether these carry coordinates and quantities, or only locations.
   - Gotcha: the Excel may hold site name / address / grid ref instead of clean
     coordinates. Geocode from the grid reference (BNG) when present. Otherwise
     join on the SEPA authorisation number to source 2. Report the match rate.
     Never place a pin by address geocoding without flagging it ASSUMED.
2. **SEPA Authorised Sites** (OGL), ArcGIS REST:
   `https://map.sepa.org.uk/server/rest/services/Open/Utility_and_Governmental_Services/MapServer`
   - The layers seen in Nov 2026 include "Authorised Sites (current)" (113)
     and a PPC Part B layer (120), in EPSG:27700. Check the layer IDs with
     `/layers?f=json` before you use them; don't hard-code them unchecked.
   - Use them for authoritative positions, the regime (PPC A/B, WML, CAR) and
     the authorisation number for the SPRI join.
   - Also list PPC sites in the bbox that have no SPRI record, as a separate
     pale "regulated, no SPRI return above threshold" pin class. Report whether
     any data-centre generator or combustion plant permits appear. Don't
     assume they do.
3. **NAEI gridded emissions** (UK-wide):
   https://naei.energysecurity.gov.uk/data/maps/download-gridded-emissions
   - Choose pollutant and year. Each zip holds ASCII grid and GeoTIFF files at
     1×1 km, BNG, from 2005 to the latest inventory year (reported two years
     behind).
   - Default pollutants: NOx, PM2.5, PM10, SO2, NH3, NMVOC, plus CO2 as the one
     greenhouse gas (configurable list). Take the total. If sector rasters are
     offered, keep them in the cache for a later sector toggle, but don't build
     the UI for them yet.
   - Gotcha: the download is a form (select, then click). Find the direct file
     URLs behind it and record them in the provider. If there are none, ask me
     to download the zips into `data/cache/naei/` and read them from there
     (config: `NAEI_GRID_PATH`).
   - Clip to each site bbox plus one cell. Don't bundle national rasters.

## Stage 1: pipeline providers and bundle
- `providers/spri.py`: load SPRI (all media), geolocate, and keep sites within
  the bbox plus a buffer (default 2 km, configurable; the buffer is ASSUMED).
  Output per site: id, name, operator, sector/activity code, regime,
  authorisation no., BNG + lat/lon, location method (grid ref / authorised-site
  join / assumed), and a releases table {year, medium, pollutant, kg}.
- `providers/naei.py`: clip each pollutant grid to the bbox, and store a compact
  integer-quantised array with scale/offset, nodata, the cell origin (BNG), year
  and units.
- Throttle (≤ 8 in flight) and cache like the other providers. Record the source
  URLs, retrieval date and file hashes in provenance.
- Bundle: add `pollution.spri` and `pollution.naei` sections (bump the schema to
  the next version and keep older bundles readable). Watch the size-guard budget.
- Report a table for all sites: SPRI sites within the bbox and within the buffer,
  location method counts, top three pollutants by mass to air and to water,
  PPC sites without SPRI returns, the NAEI pollutants/year loaded, the cell count,
  and the min/median/max per pollutant.

## Stage 2: SPRI pins (web/js/scene/pollution-pins.js, new)
- One pin per site: a thin stem plus a head. Height ∝ log10(kg of the selected
  pollutant + 1), clamped to a min and max. Show the scaling in the legend
  ("height: log scale, ASSUMED").
- The head colour is the medium: air, water, waste water, waste transfer.
  Use Okabe–Ito colours.
- Pin classes: REPORTED (solid), "regulated, no SPRI return above threshold"
  (pale hollow head), location ASSUMED (dashed stem).
- Pins outside the bbox but within the buffer sit on the slab edge on the
  bearing to the site, with a small distance label ("1.4 km →").
- Studio controls: a pollutant picker (only the pollutants present at that
  site), a medium filter, a year picker (latest by default), and a toggle for
  "all pollutants" mode (height = number of pollutants reported).
- Hover/click card: operator, sector, regime, auth no., and a release table for
  the selected year with a 5-year sparkline. Footer: "Reported by the operator
  to SEPA. Only releases above SPRI thresholds are reported."
- Labels: reuse the subsurface pit-label layout (screen-space silhouette,
  no overlaps, threads), and keep sprites and threads out of the ink pass.

## Stage 3: NAEI drape (web/js/scene/emissions-drape.js, new)
- Paint the clipped grid into the drape canvas as 1 km squares, aligned to BNG.
  Don't smooth or interpolate: the cell is the unit of the data, so show it.
- Colour with a sequential colour-blind-safe ramp. Classes are quantiles across
  all curated sites for that pollutant/year (so sites can be compared), with
  a "this site only" toggle. Class breaks are ASSUMED, and the legend says so.
- Opacity slider. The drape sits under OSM linework and over the imagery and
  land cover. It's mutually exclusive with other choropleth drapes, if any.
- Show the cell grid lines faintly, and label the units: "t/km²/yr, MODELLED
  (NAEI <year>)".
- Caption line: "Modelled emissions estimates, not measured concentrations or
  exposure."

## Stage 4: artefacts, caption, viewer
- Legend groups REPORTED / MODELLED / ASSUMED / SCHEMATIC.
- Caption and manifest, generated from the data and never hard-coded: SPRI year
  and file, the counts by location method, the NAEI pollutant/year/version, the
  buffer, the scaling, class breaks, attributions and licence status.
- A CSV export per site: SPRI sites with releases, and NAEI cell values, with
  provenance columns.
- The offline viewer carries the pollution data and renders identically.

## Done when
- Screenshots for larbert (nearest to Grangemouth), hunterston, ravenscraig
  and cockenzie, plus one site with no SPRI pins (likely killean-cowal), from the SW and NE, with pins
  on and the NOx drape on.
- The Stage 1 table for all curated sites.
- Tests: SPRI join and geolocation on a fixture (grid ref, auth-no. join, and
  a failure case); BNG cell alignment of the drape (a known cell lands on the
  right terrain texels); quantisation round-trip; log-height clamping; class
  breaks; bundle encode/decode; layer registry and palette tests pass.
- A byte-identical 3MF, bundle sizes within budget, and DATA_LICENCES.md rows
  for SPRI, SEPA Authorised Sites and NAEI with their status.
