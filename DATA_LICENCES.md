# Data licences and attribution

Every export embeds the attribution for the sources it actually used (see
the `provenance` block of each manifest). The **Status** column records whether the
licence wording has been checked against the publisher's own licence page.
Sources marked *to verify* must be checked before the first public release.

| Source | Used for | Licence | Attribution text | Status |
|---|---|---|---|---|
| OpenStreetMap (Overpass API) | buildings, roads, rail, water, power, residues, receptors, land cover | ODbL 1.0 | © OpenStreetMap contributors | verified |
| SRTM 1″ via AWS Terrain Tiles | elevation (fallback) | Public domain (NASA/USGS) | Elevation: NASA/USGS SRTM | to verify |
| Copernicus DEM GLO-30 | elevation (global default) | Copernicus DEM licence | Copernicus DEM GLO-30 © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by the European Union and ESA | to verify |
| Scottish Public Sector LiDAR | elevation (Scotland) | OGL v3.0 | Contains public sector information licensed under the Open Government Licence v3.0 | to verify |
| GSHHG (Wessel & Smith) | coastline | LGPL 3.0 | Coastline: GSHHG (Wessel & Smith) | to verify |
| AWS Terrain Tiles (Mapzen / tilezen) | elevation (browser tier) | composite: SRTM and GMTED2010 (public domain, USGS), ETOPO1 (public domain, NOAA), UK Environment Agency LiDAR (OGL v3) | Elevation: Mapzen Terrain Tiles (SRTM and GMTED2010 courtesy of the U.S. Geological Survey; ETOPO1, NOAA; UK: © Environment Agency 2015) | to verify: which source covers Scotland (the joerd attribution page does not say) |
| Overture Maps (opt-in only) | buildings / roads fallback | mixed by theme | © Overture Maps Foundation; © OpenStreetMap contributors | to verify |
| Curated sites (`data/sites/`) | site metadata | CC BY 4.0 | Hyperscale Landscapes contributors | — |

## Services used by the browser app

| Service | Use | Terms |
|---|---|---|
| OpenStreetMap tiles | background map in the area picker | OSMF Tile Usage Policy (attribution shown; light use) |
| Nominatim | place search, on submit only | Nominatim Usage Policy (max 1 request/s, no autocomplete) |
| Overpass API | features for drawn areas | public instances; polite rate limit (1 request per 1.5 s) |

## Bundled software (web/vendor)

| Library | Version | Licence |
|---|---|---|
| three.js | 0.170.0 | MIT |
| Leaflet | 1.9.4 | BSD-2-Clause |
| fflate | 0.8.2 | MIT |
| earcut | 3.0.1 | ISC |
| @tmcw/togeojson | 5.8.1 | BSD-2-Clause |
| gifenc | 1.0.3 | MIT |

Licence texts are in `web/vendor/licences/`.

## Fonts

| Font | Used for | Licence | Status |
|---|---|---|---|
| Aileron Regular (dotcolon.net), embedded in Pillow | text engraved on the model base | CC0 1.0 (believed) | to verify |

## Not integrated: licence unclear (for review)

These sources are listed in the brief but are **not used**. They will stay out of the code
until each licence has been confirmed.

- DESNZ Renewable Energy Planning Database (REPD): believed OGL v3.0, to confirm
- Scottish Vacant and Derelict Land Survey (via the Spatial Hub)
- Coal Authority / Mining Remediation Authority mining data
- SEPA flood maps
- Historic Environment Scotland / Canmore records
- Local development plan allocations (Spatial Hub)
- OS Terrain 50 (OGL v3.0, believed; not yet needed)
