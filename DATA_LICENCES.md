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
| Scottish Public Sector LiDAR (DTM), via the public `srsp-open-data` bucket (Scottish Government / JNCC) | elevation in Scotland: Python tier, and curated-site bundles in the browser | OGL v3.0 (the Remote Sensing Portal states OGL v3 unless a dataset says otherwise; the one stated exception is the Phase 2 LAZ point clouds, which we do not use) | Elevation: Scottish Government LiDAR. Contains public sector information licensed under the Open Government Licence v3.0 | licence checked 24 Nov 2026; **to verify:** per-programme copyright lines (e.g. Phase 1 names Scottish Government, SEPA and Scottish Water) |
| GSHHG (Wessel & Smith) | coastline | LGPL 3.0 | Coastline: GSHHG (Wessel & Smith) | to verify |
| AWS Terrain Tiles (Mapzen / tilezen) | elevation (browser tier) | composite: SRTM and GMTED2010 (public domain, USGS), ETOPO1 (public domain, NOAA), UK Environment Agency LiDAR (OGL v3) | Elevation: Mapzen Terrain Tiles (SRTM and GMTED2010 courtesy of the U.S. Geological Survey; ETOPO1, NOAA; UK: © Environment Agency 2015) | to verify: which source covers Scotland (the joerd attribution page does not say) |
| Overture Maps (opt-in only) | buildings / roads fallback | mixed by theme | © Overture Maps Foundation; © OpenStreetMap contributors | to verify |
| Curated sites (`data/sites/`) | site metadata | CC BY 4.0 | Hyperscale Landscapes contributors | — |

## Imagery (checked 24 Nov 2026; EOX 2025 is the default drape, EOX 2016 and OSM land cover are options)

The tool's exports (PNG, GIF, offline HTML) are forwarded freely, so imagery
must allow embedding in exported files and redistribution by end users.

| Source | Licence | Browser use | In redistributed exports | Resolution | Verdict |
|---|---|---|---|---|---|
| EOxCloudless **2016** (tiles.maps.eox.at, layer `s2cloudless_3857`) | CC BY 4.0 | yes; no key; CORS ok; fair use | yes, attribution visibly embedded | 10 m (imagery from 2016–17) | **fully open option** |
| EOxCloudless **2018–2025** (`s2cloudless-2025_3857` etc.) | CC BY-NC-SA 4.0 | yes; no key; CORS ok; non-commercial apps only | yes, with attribution + CC BY-NC-SA notice; recipients bound by NC and ShareAlike; EOX counts government/agency use as commercial | 10 m | **current imagery, with conditions** |
| Copernicus Sentinel-2 (raw scenes) | EU Copernicus legal notice: free, full and open, incl. distribution | via AWS COGs (CORS ok) but single, often cloudy scenes | yes; "Contains modified Copernicus Sentinel data [year]" | 10 m | possible later; more engineering |
| Esri World Imagery | proprietary (Esri Master Agreement E204) | works without a key, but keyless use not expressly permitted | static images arguably for account holders; embedding tiles in forwarded HTML doubtful; open licensing of exports conflicts with B.1(k) | ~0.3 m | **not for exports** |
| APGB / Getmapping / Digimap | public-sector / educational licences | — | no redistribution | 12.5–25 cm | not usable |
| Mapbox, Google, Bing/Azure | proprietary | key required | storage and redistribution prohibited | sub-metre | not usable |
| OpenAerialMap (CC BY 4.0) | CC BY 4.0 | yes | yes | 2–5 cm, tiny patches only (8 in the central belt, none at the sites) | not useful here |
| Landsat (USGS / NASA GIBS) | public domain | yes | yes | 30 m | too coarse |

Attribution wording (EOX): "EOxCloudless https://cloudless.eox.at by EOX IT
Services GmbH (Contains modified Copernicus Sentinel data [year])"; links
required in online publications and social media.

No openly licensed sub-metre aerial imagery of the central belt was found.

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
| Inter 4 (400, 700), `web/vendor/fonts/` | web app, captions, cross-sections, offline viewer | SIL Open Font Licence 1.1 | verified (licence text in `web/vendor/licences/inter.LICENSE`) |

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
