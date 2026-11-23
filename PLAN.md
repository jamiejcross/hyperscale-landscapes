# PLAN — Hyperscale Landscapes

*Phase 0 output. Written 23 November 2026, after reading `BRIEF.md` and every source it lists.*

> **Status (23 Nov 2026): approved by JC.** D1–D10 are accepted as recommended. Auchtertool ships with **no insert at all** until a sourced footprint exists. ORCIDs: Jamie Cross 0000-0002-0721-0786; Alex Nading 0000-0002-1731-321X. Phases 1–2 committed; Phase 3 (web MVP) committed. The GitHub repo will not be created or pushed until JC says so.

---

## 1. Decisions for you (please answer before Phase 1)

| # | Question | My recommendation | Why |
|---|---|---|---|
| D1 | **Which code to port.** The brief names `multi-extruder/scripts/build_terrain_multi.py` as the source. But `elcho-maps/scripts/build_terrain.py` is already a port of that file onto the providers, with fixes documented in `elcho-maps/docs/UPGRADE_NOTES.md`: watertight per-object meshes after 3MF round-trip, sea/road gaps at the print edge removed (exact regrid to the bbox), Scottish LiDAR reprojection (~1° OSGB skew), the road network unioned before meshing (247k → 7.5k faces), an earcut hole bug that silently dropped roads, vectorised sampling (36×) and face generation (128×), and water no longer climbing hillsides. | **Port from `elcho-maps/scripts/build_terrain.py` + its providers.** Use the multi-extruder Mossmorran 3MF only as the *visual and statistical* parity reference. | Porting the older file would bring back bugs that have already been fixed. |
| D2 | **Building height exaggeration.** Multi-extruder multiplies building heights by `z_exag` (×2). ElchoMaps added `--building_exag`, defaulting to 1.0 (true scale). | Keep `building_exag` as a separate setting. Default **1.0 for buildings** and **1.0 for the data-centre insert**, with terrain at ×2. Disclose both factors on every export ("Terrain height ×2; buildings at true height"). | Comparing the facility's massing with nearby homes is evidence, so both should be at true relative scale. Doubling the terrain alone is the standard, disclosed convention. This means the Mossmorran parity test compares *with* `building_exag=2`. |
| D3 | **Code licence.** | **GPL-3.0**, as the brief proposes. | It keeps derivatives (e.g. developer-commissioned forks) open. MIT would let a consultancy close a modified version. |
| D4 | **Satellite imagery.** The Mossmorran viewer drapes **Esri World Imagery**. Its terms do not allow it to be redistributed inside an open-source tool or embedded in forwarded HTML files. | **No aerial imagery in v1.** Colour the land from OSM `landuse`/`natural` (farmland, woodland, heath, quarry, industrial, residential), which also makes the *post-pastoral* landscape legible. List imagery as a later option, and add it only if you approve a source with a clear licence. | Every export has to be redistributable. OSM land cover is ODbL and data-driven, while imagery is neither of those. |
| D5 | **Privacy wording.** The web app runs client-side, but the *searches still reach* Nominatim (geocoding), Overpass (features) and the tile hosts (terrain and basemap). Those services see IP addresses and bounding boxes. | Say this plainly in the privacy statement: "We run no server and keep no logs. To fetch map data, your browser contacts these public services directly: …". Geocode only when the user submits a search (no search-as-you-type), and offer curated sites that load from bundled data with no third-party calls. | "Nobody's searches are logged" is not strictly true of the third parties, and organisers may be targets, so the statement has to be accurate. |
| D6 | **Dependencies over ~1 MB.** (a) **Three.js**: the vendored minified module is ~0.7–1.2 MB, depending on the release. (b) **Playwright + headless Chromium** (~150 MB, Python tier only, for rendering artefacts). (c) **GSHHG** coastline (~150 MB download on first use, cached, Python only; needed for Cockenzie). | Approve all three. Vendor Three.js into `web/vendor/`. Make Playwright an optional extra (`pip install hyperscale-landscapes[render]`). Download GSHHG lazily. | Three.js is the renderer for both tiers. Playwright is what gives the Python renders *identical* styling to the web app (brief §6). |
| D7 | **Basemap for the site picker.** It needs a slippy map. The options are OSM's own tiles (usage policy allows light use with attribution, but no heavy use) or **OpenFreeMap** (free, no key, OSM-based vector tiles, though it adds MapLibre at ~800 KB). | Leaflet (~150 KB) + OSM standard tiles, with attribution and a User-Agent-free referrer policy, and a config switch to move to another provider if traffic grows. | It is the lightest option and matches your existing picker. Our traffic will be modest. |
| D8 | **Cache location.** | `~/.cache/hyperscale-landscapes/` (via `platformdirs`), **not** inside the Dropbox repo folder. | The multi-extruder cache is 652 MB, and syncing it through Dropbox wastes space and causes conflicts. |
| D9 | **Slicer defaults conflict.** `../CLAUDE.md` says PLA Basic (not matte) with a 5 mm outer brim. `elcho-maps/slicer/README.md` says matte PLA, brim off, and a 0.08 mm Arachne preset for buildings. | Ship **your brief's A1 defaults** as the documented baseline (the `Terrain Detail 0.16mm @BBL A1.json` profile), and include the 0.08 mm Buildings preset as an "extra detail" option with its trade-offs explained. | The brief calls these your tested defaults, and the 0.08 mm preset is still useful for small, building-dense sites. |
| D10 | **Repo name and owner.** | `jamiejcross/hyperscale-landscapes`, public, with Pages built from a GitHub Actions workflow that publishes `web/` + the rendered `docs/`. | Publishing through Actions lets the docs and the app share one site. A plain `web/` folder source can't include `docs/`. |

---

## 2. What I read, and what carries over

| Source | What I take from it |
|---|---|
| `elcho-maps/scripts/providers/*` | `BBox`, `ProviderResult(data, source, cached, metadata)`, the shared `overpass_query()` (3 mirrors × 3 rounds, backoff), and per-layer `fetch(bbox, cache_dir)`. Elevation: Scottish LiDAR → Copernicus GLO-30 (windowed COG) → SRTM. Coastline: GSHHG → OSM. Buildings: Overture → OSM. Roads: OSM → Overture. Water: OSM. |
| `elcho-maps/scripts/build_terrain.py` | The pipeline core (see D1): regrid to the exact bbox, valley + channel carve, vectorised terrain grid with base, building extrusion with 49-point footprint sampling and bury, unioned road network, river/sea void-fill water, mesh hygiene, and the 3MF exporter with components. |
| `scripts/build_terrain.py` (single-colour) | The manifold3d `batch_boolean` union and sliver filter (keep the largest body plus any body ≥ 1 mm³). This becomes the "Single colour" STL path. |
| `multi-extruder/scripts/add_gpx_route.py` | A 3MF loader and a terrain-draped line slab. I'll reuse its approach for the **cross-section line** and for future route layers, not as a v1 feature in itself. |
| `multi-extruder/frontend/index.html` | The Leaflet draw flow, bbox JSON shape (`bbox`, `options`, `colours`), and the options UI. The web app takes over this JSON format so that both tiers read the same files. |
| `mossmorran-terrain-viewer.html` | The rendering recipe to reproduce in a shared module: a gzipped binary geometry blob embedded in JSON, RoomEnvironment + hemisphere + soft-shadow sun with azimuth/elevation, a procedural soil-strata texture on the skirt, clearcoat water, clipping planes for roads, a shadow catcher, sky/studio/white/charcoal/transparent backgrounds, camera presets, ×N screengrab, and a "print colours" toggle. **Changes:** vendor Three.js instead of using the unpkg CDN (so it works offline), drop the Esri drape (D4), and add a caption strip and layer toggles from the layer registry. |
| `mossmorran-terrain-*-sample.png` | The target look for the "landscape segment": an oblique view, 28° lens, sun from the SW at 32°, sky gradient, strata sides, soft ground shadow. |
| `Terrain Detail 0.16mm @BBL A1.json` | Copy it into `slicer/bambu/` unchanged. Note that it already enables a prime tower (`enable_prime_tower: 1`), which multi-colour printing needs. |
| `../CLAUDE.md`, `../docs/README.md` | The non-negotiables in §5 below. |

**Parity reference bbox (Phase 1):** `56.09158, 56.10642, -3.30543, -3.24569` (Mossmorran/Auchtertool, 150 mm). Reference stats from `manifest_56.09158_…json`: land 457,268 faces (watertight); 232 buildings; 110 road slabs; 5 water bodies; 0 overhang faces. The wider `56.08851 … -3.23332` build is the secondary check. Cached OSM + SRTM for both are in `multi-extruder/output/cache/`. **I will read from them but not move or modify them.**

---

## 3. Repository layout

```
hyperscale-landscapes/
├── README.md                    plain language first, technical second
├── LICENSE                      GPL-3.0 (D3)
├── DATA_LICENCES.md             every source, licence, attribution string
├── PRIVACY.md                   web app privacy statement (D5)
├── CONTRIBUTING.md  CODE_OF_CONDUCT.md (Contributor Covenant 2.1)  CITATION.cff
├── BRIEF.md  PLAN.md
│
├── data/                        ── shared by both tiers ──
│   ├── layers.json              layer registry: id, name, colours, "why this matters", provenance keys, era rules
│   ├── presets/                 power-and-place.json, residues.json, full.json, single-colour.json
│   ├── comparisons.json         scale-card reference figures, each with a citation (see §10)
│   ├── sites/
│   │   ├── schema.json          JSON Schema (draft 2020-12)
│   │   ├── index.json
│   │   ├── auchtertool-cato.geojson
│   │   └── TODO.md              every unverified field, for you
│   └── i18n/en-GB.json          all UI strings
│
├── pipeline/                    ── Tier 2: pip install hyperscale-landscapes ──
│   ├── pyproject.toml           extras: [render] (playwright), [uk] (rasterio), [dev]
│   ├── hyperscale_landscapes/
│   │   ├── cli.py               `hyperscale build | render | sites list | sites validate`
│   │   ├── config.py            BuildOptions dataclass ← CLI / bbox JSON / site file
│   │   ├── geo.py               BBox, projection, regrid-to-bbox, polygon → bbox
│   │   ├── cache.py             platformdirs cache (D8)
│   │   ├── providers/
│   │   │   ├── __init__.py      ProviderResult + Provenance + overpass_query
│   │   │   ├── elevation.py     Scottish LiDAR → Copernicus → SRTM
│   │   │   ├── coastline.py     GSHHG → OSM
│   │   │   ├── water.py         OSM waterways + polygons
│   │   │   ├── buildings.py     OSM (Overture optional, off by default)
│   │   │   ├── roads.py         OSM roads + rail (incl. disused/abandoned)
│   │   │   ├── power.py         OSM power=* ; REPD (Phase 2, if licence confirmed)
│   │   │   ├── residues.py      OSM mines/bings/quarries/landfill/works/disused:*
│   │   │   ├── receptors.py     OSM schools, care homes, hospitals, prisons, community
│   │   │   ├── landcover.py     OSM landuse/natural (for colouring, D4)
│   │   │   ├── planning.py      user-uploaded allocations only (v1)
│   │   │   └── site.py          curated site / uploaded polygon → footprint + massing
│   │   ├── geometry/
│   │   │   ├── terrain.py       grid, carve, base (ported)
│   │   │   ├── slabs.py         slab_from_poly, densify_ring, interior points (ported, orient kept)
│   │   │   ├── buildings.py     extrusion with footprint sampling + bury (ported)
│   │   │   ├── insert.py        data-centre block, recess, clearance, magnet holes
│   │   │   ├── labels.py        embossed text, north arrow, scale bar on the base
│   │   │   ├── union.py         manifold3d union + sliver filter (single-colour path)
│   │   │   └── checks.py        watertight, overhangs, object counts
│   │   ├── export/
│   │   │   ├── threemf.py       multi-object 3MF + Bambu project metadata
│   │   │   ├── stl.py
│   │   │   ├── contours.py      SVG laser-cut layers (stretch)
│   │   │   ├── viewer_bundle.py  mesh → gzipped binary blob for the web viewer
│   │   │   └── manifest.py      stats + full provenance
│   │   └── render/              drives web/ in headless Chromium (D6)
│   └── tests/
│       ├── fixtures/            tiny cached OSM/DEM (< 1 MB total)
│       └── test_*.py
│
├── web/                         ── Tier 1: static, no build step ──
│   ├── index.html               <main> app shell
│   ├── viewer.html              standalone viewer template (also used for artefacts)
│   ├── css/                     custom properties, ch-based measure, light/dark
│   ├── js/
│   │   ├── app.js               flow: pick → size/preset → preview → export
│   │   ├── picker.js            Leaflet map, draw box/polygon, search, upload
│   │   ├── data/                elevation.js (Terrarium tiles), overpass.js, cache.js (IndexedDB)
│   │   ├── geom/                terrain.js, slabs.js, buildings.js, insert.js (JS ports, lower-res)
│   │   ├── scene/               scene.js (shared renderer recipe), materials.js, caption.js
│   │   ├── export/              threemf.js, stl.js, gif.js, video.js, png.js, viewer-bundle.js
│   │   └── i18n.js
│   └── vendor/                  three (D6), leaflet, fflate, gifenc, togeojson, earcut — pinned, with licences
│
├── slicer/
│   ├── bambu/                   Terrain Detail 0.16mm @BBL A1.json (+ A1 mini, P1S/X1 variants), 0.08mm Buildings
│   ├── orca/  prusa/
│   └── README.md
├── docs/                        guides (Markdown → Pages via the Actions workflow)
├── examples/                    small outputs only (< 5 MB each)
└── .github/
    ├── workflows/               tests.yml (offline), validate-sites.yml, pages.yml, size-guard.yml
    └── ISSUE_TEMPLATE/          suggest-a-site.yml, bug.yml, printing-help.yml
```

**One rendering recipe, two tiers.** `web/js/scene/` is the only place that styles the model. The standalone viewer, the web app preview and every Python-tier artefact (rendered via Playwright loading `viewer.html` with a bundle) all use it. That is what makes the styling identical across tiers.

**One geometry implementation per tier.** Geometry exists twice, in Python (full quality) and JS (browser, lower resolution). I will keep the JS port deliberately simpler (no manifold union, coarser grid, no LiDAR) and say so in the UI. A WASM build of manifold3d exists (`manifold-3d` on npm, ~1 MB). I'll ask before adding it, which would only be needed if browser STL exports must be a single watertight body.

---

## 4. Layers and print objects

`data/layers.json` is the single registry. Each entry has `id`, `name`, `print_object`, `colour_print`, `colour_screen`, `proposed_style` (outline/hatch), `why` (draft text, flagged for you), `sources[]`, `era_rules[]`.

| Layer id | OSM selectors (initial; refine in Phase 2) | Print geometry |
|---|---|---|
| `terrain` | DEM | grid + base |
| `water` | `waterway=river/canal/stream`, `natural=water`, `water=*`, coastline/GSHHG | void-fill slabs (ported) |
| `buildings` | `building=*` (minus receptors and site) | extruded, buried |
| `roads` | `highway=*` per profile | draped slabs |
| `rail` | `railway=rail/light_rail`; **`railway=abandoned/disused/razed`** and `disused:railway=*` drawn distinct | draped slabs, distinct colour on screen; trackbed ridge in print |
| `power` | `power=substation/line/minor_line/tower/pole/plant/generator`; `generator:source=wind/solar/battery`, `plant:storage=*` | substations as raised pads; lines as thin draped strips with pylon pegs (pegs ≥ 1.2 mm, or they won't print); turbines as pegs |
| `residues` | `historic=mine/mine_shaft`, `man_made=spoil_heap/mineshaft/works/gasometer`, `landuse=quarry/landfill/brownfield/industrial`, `disused:*`, `abandoned:*`, `natural=bare_rock`+`spoil` | raised pads (bings already present as terrain relief) |
| `receptors` | `amenity=school/kindergarten/hospital/clinic/prison/community_centre/place_of_worship/library`, `social_facility=nursing_home`, `building=house/residential/apartments` (type only) | buildings recoloured, not new geometry |
| `landcover` | `landuse=farmland/meadow/forest/residential…`, `natural=wood/heath/scrub/wetland` | screen colour only (D4) |
| `planning` | user upload only in v1 | screen overlay; optional shallow emboss |
| `site` | curated GeoJSON / upload | **separate removable insert** + recess |

Print-object presets (≤ 4 slots unless "Full"):

| Preset | Obj 1 | Obj 2 | Obj 3 | Obj 4 | Insert |
|---|---|---|---|---|---|
| Power and place | Land | Water | Power + roads + rail | Buildings (incl. receptors) | separate plate |
| Residues | Land | Water | Residues | Buildings + roads + rail | separate plate |
| Full | Land, Water, Roads, Rail, Power, Residues, Buildings, Receptors | | | | separate plate |
| Single colour | one merged watertight STL (manifold3d) | | | | separate STL |

**Colour-blind check.** I will start the screen palettes from Okabe–Ito and Paul Tol's sets. A small script in CI simulates deuteranopia, protanopia and tritanopia (Machado 2009 matrices) and fails if any two layers within one preset fall below a ΔE2000 threshold. Print colours are chosen from Bambu PLA Basic's real colour list, so the palette matches filament people can buy.

**Proposed vs existing.** On screen, *proposed* features (from REPD status or the site file) get a dashed outline plus 45° hatching. In print, a proposed footprint can be embossed as a 0.4 mm outline ridge instead of a solid pad (optional), so a hand can feel the difference.

**Eras view (Phase 7).** Assign features to eras only from evidence in the data: `start_date`, `historic=*`, `disused:*`/`abandoned:*`, REPD dates and `landuse` class. Anything without evidence stays "unassigned" and is shown as such, never guessed.

---

## 5. Lessons that stay non-negotiable (from `../CLAUDE.md`, `../docs/README.md`, `UPGRADE_NOTES.md`)

- `orient(poly, sign=1.0)`: CCW exteriors, CW holes, in every slab builder. A unit test asserts the winding on a holed polygon.
- River-filter buffer stays at 20 m for rivers and narrower for canals; a test asserts it never exceeds 80 m.
- Buildings: 49-point footprint sampling, bury 8 units, safety margin sunk below ground.
- Roads: top +0.5 mm, buried 3 mm, unioned before meshing.
- Single-colour path: manifold3d union, keeping the largest body + bodies ≥ 1 mm³.
- Support-free: every build runs the overhang check (normal z < −0.707, z > 0.5 mm) and the manifest records it. CI fails above 50 faces / 1 mm² on fixtures.
- Overpass: 3 mirrors × 3 rounds with backoff, and a polite User-Agent naming the project (never the user).
- Regrid every elevation source onto **exactly** the requested bbox (the sea-gap fix).
- Footprints shrunk ~0.05 mm and vertices nudged so 3MF 4-decimal rounding never welds shells.

---

## 6. Physical model specifics

- **Sizes.** 150 mm ↔ ~1.5 km and 200 mm ↔ ~2 km by default. The web app warns above 3 km and blocks above ~3 × 3 km, pointing users to the Python tier.
- **Data-centre insert.** The footprint is extruded to `stated_height_m` (or a user estimate, with its source stored), at `building_exag` (D2). In the Land object, a recess is cut to the footprint offset by **+0.2 mm** clearance, with a flat floor 2 mm below the *lowest* terrain point under the footprint, so the block always sits level. The insert's height = recess depth + massing height. There are optional 6 × 2 mm magnet holes: one pair in the recess floor, one in the insert's underside, depth + 0.2 mm. The insert is a separate 3MF object on its own plate and a separate STL. This is built with manifold3d (a boolean difference on Land only), so the multi-object path gains one boolean step. I'll test that it still leaves Land watertight.
- **Base labelling.** Text is embossed 0.6 mm *into* the underside (no overhangs, nothing to snap off), or onto a 45° chamfered front edge, mirrored for the underside. It reads: site name, a north arrow, a scale bar (round number of 100 m), "Height exaggerated ×2", "© OpenStreetMap contributors; elevation: …", and the build date. Font: a vendored open single-stroke font (Hershey / Relief SingleLine, OFL) converted to outlines, with no system-font dependency.
- **Single-extruder colour.** The manifest and the web export list suggested pause heights: the top of the base, the median water-surface height, and the median road-top height. Docs show where to enter them in each slicer.
- **3MF colour assignment in Bambu Studio.** `basematerials displaycolor` alone often isn't mapped to AMS slots. I'll add Bambu's `Metadata/model_settings.config` (per-object `extruder` key) and test by opening it in Bambu Studio on your Mac during Phase 1. If that metadata route proves fragile, the fallback is clear docs on manual assignment.
- **Estimates.** Print time and filament are estimated from volume and surface area, with coefficients calibrated against your past A1 prints (the README quotes 5–7 h and 80–100 g for 150 mm Glasgow). They are labelled as rough.

---

## 7. Digital artefacts

Each one renders through the shared scene in `web/js/scene/`, either in the browser or in Playwright.

| Artefact | Browser tier | Python tier | Notes |
|---|---|---|---|
| Turntable GIF | gifenc in a Web Worker; adaptive palette; downscales or drops frames until **< 8 MB** | same page in Playwright | Presets: 1080², 1080 × 1350, 1920 × 1080. Adjustable elevation, duration and speed, with an optional dwell on the insert |
| Video | `MediaRecorder` → WebM (MP4 where the browser supports it) | Playwright frames → ffmpeg if installed | |
| Landscape segment | oblique crop, ×N screengrab (from the Mossmorran viewer) | same | PNG at print resolution (300 dpi at A4 width) |
| Cross-section | user draws a line → profile SVG/PNG: terrain, facility at true height, labelled features within a buffer | same | The profile is not exaggerated by default; if the user turns exaggeration on, it is stated |
| Standalone viewer | single HTML, Three.js inlined, geometry blob embedded | same | Layer toggles, captions, works offline. Size target < 8 MB for email |
| Before/after | two renders → side-by-side PNG or crossfade GIF | same | |
| Scale card | SVG → PNG | same | See §10 for the comparison figures |
| Info pack PDF | stretch: print-CSS page → `window.print()` | Playwright `page.pdf()` | |

**Caption strip** (`scene/caption.js`). It is drawn *into* the canvas, never as an HTML overlay, so it survives screenshots and cropping. It contains the site name · data sources and licences · "Height exaggerated ×2; buildings true height" · the date generated · "Proposed footprint {precision}; source: {planning_ref}". It repeats as a thin band along both the top and bottom edges of large images, so a single crop rarely removes both.

**Alt text.** It is drafted automatically from layer statistics ("Oblique 3D view of Auchtertool, Fife, showing 3 substations, 2 HV lines, 230 buildings…"). It is offered for copying when a file is exported, and embedded in PNG `tEXt` metadata.

---

## 8. Web app flow (Phase 3)

1. **Pick.** Curated sites list (loads offline from `data/sites/`), place search (Nominatim, submit-only), draw a box or polygon, or upload GeoJSON/KML/KMZ (fflate + togeojson).
2. **Size and style.** 150/200 mm, preset, exaggeration (always shown with disclosure text).
3. **Preview.** Three.js scene, layer toggles with "Why this matters" disclosures, and a stats panel.
4. **Export.** Print (3MF/STL/insert), images, GIF, video, viewer. Everything includes a "browser export is lower resolution than the Python tool" note where relevant.

**Data.** Elevation comes from AWS Terrain Tiles (Terrarium PNG, CORS-enabled) at z13–14. **Caveat to verify in Phase 3:** in Scotland these tiles are, as far as I know, SRTM/GMTED-derived (~30 m), not LiDAR, so the browser tier will be coarser than the Python tier with Scottish LiDAR. The attribution text must list the composite's sources, and I will confirm the current list from the registry page before writing it. Overpass with mirror fallback, a minimum of 1 s between requests, and IndexedDB caching keyed by bbox + query hash.

**Front-end conventions.** Semantic HTML (`<main>`, `<nav>`, `<fieldset>`), CSS custom properties, `max-inline-size: 65ch` for prose, responsive down to 360 px, keyboard-operable map controls (arrow-key nudging of the box, Enter to confirm), focus-visible styles, `prefers-reduced-motion` (turntable paused by default), and en-GB strings throughout.

**No build step.** ES modules + an import map pointing at `vendor/`. I don't expect to need a bundler. If the standalone viewer's Three.js inlining requires one, I'll use a tiny Python script (`pipeline/…/export/viewer_bundle.py`, also run in CI) rather than adding Node tooling.

---

## 9. Curated sites (Phase 6, but schema early)

- The schema has the fields listed in the brief, plus `geometry` (Polygon/MultiPolygon), `massing_source` and `licence: "CC-BY-4.0"`.
- **Auchtertool (Cato).** I have *no* verified planning data. The file will be created with every field `null` and listed in `data/sites/TODO.md`: developer, planning refs + URLs, capacity, height, floor area, footprint and precision, sources, last verified. **The footprint geometry will stay empty until you supply a source.** *Decided:* until then the worked example has **no insert at all**. It shows the landscape only.
- The other sites you named (Hurlford, Newarthill, Ravenscraig, Cockenzie, …) go into `TODO.md` as name-only stubs, with no geometry and no claims.
- CI validates every site file with `check-jsonschema`. There is a "Suggest a site" issue form with required source URLs.
- **Data ethics.** The schema has no person fields. A CI lint rejects `email`, `phone` and personal-name fields in site files, and receptor layers keep only `amenity`/`building` type.

---

## 10. Things I must not invent (listed for you)

1. All site data (see §9).
2. **Scale-card comparison figures.** Football pitch: I'll use the IFAB Laws of the Game recommended international size (105 × 68 m = 7,140 m²) and cite it. **Roe deer and badger home ranges** need ecological sources (they vary widely by habitat). I'll leave them `null` in `data/comparisons.json` until you or Alex give me a citation you trust. The "nearest village's built-up area" will be computed from OSM `place=*` + `landuse=residential` and labelled as such.
3. **UK data licences** need checking before integration: REPD (I believe OGL v3), Scottish Vacant and Derelict Land Survey (via the Spatial Hub; licence unclear), Coal Authority / Mining Remediation Authority layers (mixed OGL and restricted), SEPA flood maps (reuse likely restricted), HES/Canmore (designations OGL; Canmore records mixed), OS Terrain 50 (OGL), Scottish LiDAR from the Remote Sensing Portal (OGL, as the elcho provider already assumes). I'll verify each one from its licence page and record it in `DATA_LICENCES.md`. **Any source still unclear stays out of the code**, and is listed for you.
4. "Why this matters" texts: I will draft them in `layers.json` with `"status": "draft — needs JC review"`.
5. `CITATION.cff`: ~~ORCIDs~~ (supplied). Still needed: Alex's affiliation exactly as it should appear (I'll use "Cornell University" for now).

---

## 11. Phases → concrete work and checks

| Phase | Deliverables | Done when |
|---|---|---|
| **1 Pipeline port** | `pipeline/` package from elcho-maps (D1); CLI `build`; providers with `Provenance`; 3MF + Bambu metadata; STL union path; manifest v2; offline fixtures; `tests.yml`; repo hygiene files; `size-guard.yml` (fails on any file > 5 MB) | Mossmorran bbox builds with `--elevation srtm --building_exag 2`: object counts within ±5 % of the reference manifest (232 / 110 / 5), land watertight, 0 overhangs, and a side-by-side render shows no visible regression. CI passes offline. The 3MF opens in Bambu Studio with 4 objects coloured. |
| **2 New layers** | power, residues, receptors, landcover, site + insert + recess + magnets, presets, base labelling, provenance in the manifest, `layers.json` with draft "why" text | The Auchtertool build (illustrative or no polygon, per §9) shows power and residue objects. The insert fits a test recess (I'll ask you for one test print of a 30 mm crop). Each preset produces ≤ 4 objects. |
| **3 Web MVP** | picker, upload, Terrarium + Overpass + IndexedDB, JS geometry, preview, 3MF/STL export, privacy page, `pages.yml` | In headless Chromium, the Auchtertool flow works end to end, and the exported 3MF opens and validates (re-parsed in a Python test). Lighthouse a11y ≥ 95. |
| **4 Artefacts** | caption, GIF, video, segment, cross-section, standalone viewer, before/after, scale card; `hyperscale render` | I will render each one and look at it. The GIF is < 8 MB at 1080². The viewer works offline (file://, network disabled). |
| **5 Docs** | the eight guides from brief §8 with screenshots generated by the tool, an email template for makerspaces, slicer guides (Bambu, Orca, Prusa) | Every guide is linked from the app at the relevant step. |
| **6 Dataset** | schema, validation workflow, Auchtertool file, TODO.md, issue form | CI rejects an invalid fixture and a fixture with personal-data fields. |
| **7 Stretch** | SVG contour layers (registration holes, layer numbers), info-pack PDF, eras view, i18n scaffolding for gd/sco | — |

**Commits.** One logical step per commit, with British English messages. The GitHub repo is created and pushed **only after you approve this plan** (D10). Phase 1 work happens locally first. I'll ask before the first push.

**Acceptance (brief §11).** The "Auchtertool GIF in under 3 min" target depends on the curated site loading from bundled data, so the default path makes **no** Overpass call. That means the Auchtertool feature data (OSM-derived, ODbL, small) is pre-baked into `data/sites/auchtertool-cato.features.json.gz` by the Python tier and refreshed by a scheduled workflow. It also makes the phone target realistic.

---

## 12. Risks

- **Browser geometry performance on phones.** A 1.5 km grid at ~5 m cells is ~90k vertices, which is fine. Building extrusion is done in a Worker. If phones struggle, the curated sites ship pre-built `.glb`-style blobs (same viewer format) and only custom areas are computed live.
- **Overpass load and outages** during public meetings. Pre-baked curated sites (above) remove the dependency for the common path.
- **Bambu 3MF metadata** is undocumented and changes between Studio versions. I'll keep it minimal and test it in the current release.
- **Licence drift** in UK datasets. `DATA_LICENCES.md` records the date each licence was checked.
