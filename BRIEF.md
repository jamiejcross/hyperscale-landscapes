# Brief: Hyperscale Landscapes — an open-source terrain toolkit for data centre organising

*Working title. Brief for Claude Code. Author: Jamie Cross (University of Glasgow). November 2026.*

## 0. How to use this brief

You are starting a new open-source project in this folder (`glasgow-3d-terrain/hyperscale-landscapes/`). It is a public, rebuilt version of my private multi-extruder terrain pipeline, which lives next door:

- `../multi-extruder/scripts/build_terrain_multi.py`: the multi-object 3MF builder (Land, Buildings, Roads, Water). **This is the main source to port.**
- `../multi-extruder/scripts/add_gpx_route.py`: adds a route layer
- `../multi-extruder/frontend/index.html`: the bbox picker
- `../multi-extruder/output/mossmorran-terrain-viewer.html` and `mossmorran-terrain-*-sample.png`: my hand-made digital artefacts (a self-contained 3D viewer and landscape-segment renders of Mossmorran/Auchtertool, Fife). **These are the reference for the "digital artefact" features.**
- `../multi-extruder/Terrain Detail 0.16mm @BBL A1.json`: my Bambu A1 slicer profile
- `../elcho-maps/scripts/providers/`: a cleaner provider architecture (elevation, buildings, roads, water, coastline). **Use it as the structural model for the new package.**
- `../CLAUDE.md` and `../docs/README.md`: hard-won lessons (winding order, river buffers, sliver filtering, Overpass mirrors). **Read them before touching geometry code.**

Before you write any code, read all of the above. Then produce a plan (`PLAN.md`) that maps the phases below onto concrete files, and stop for my review. Use British English everywhere: in the code comments, the UI and the docs.

## 1. Purpose

Between 2024 and 2026, land speculators identified at least twenty-four sites for possible hyperscale data centres in Scotland's central belt. Communities near these sites (Auchtertool, Fife; Hurlford, East Ayrshire; Newarthill, North Lanarkshire; Ravenscraig; Cockenzie, and others) are organising, mostly through Facebook groups, WhatsApp, email and public meetings. Developers present these sites as empty or "employable" land. Planning documents reduce them to polygons, red lines and grid references.

This tool lets people **see, hold and share the wider landscape that a proposed data centre would be fused to**: the terrain and the watercourses, the pylons, substations and battery storage that make a site attractive, the residues of coal, oil, gas, steel and farming, and the homes, schools and other institutions nearby. The tool produces two kinds of output:

1. **Physical models**: 3D-printable, multi-material terrain models, plus a removable "ghost" block showing the proposed data centre, for use at community meetings, workshops, exhibitions and planning hearings.
2. **Digital artefacts**: rotating GIFs and short videos, landscape-segment images, and self-contained interactive 3D viewers. These are sized for the media that organisers actually use: Facebook posts, WhatsApp, slides and printed leaflets.

### Intellectual framing (for the UI copy, docs and design choices)

The tool comes out of research by Jamie Cross and Alex Nading on "hyperscale landscapes" (paper under review; **do not quote the manuscript in the repo**, only paraphrase the ideas below). Design decisions should express these ideas:

- **Landscape structures.** Data centres are not dropped into blank space. They fuse to earlier infrastructures: coal fields, refineries, railways, transmission lines, wind farms. Their modular form follows these older arrangements. The tool should make it easy to see that layering.
- **Residues.** Every era leaves material and chemical residues: bings, flooded mines, contaminated ground, decommissioned plant, field boundaries, ruins. Make residues a first-class layer, not decoration.
- **Proximity to power.** Sites are often chosen for grid proximity (substations, high-voltage lines, battery storage, renewables), not because the land is "empty". Power infrastructure must be prominent.
- **Water is an assumption.** Show rivers, reservoirs and flood risk so that water use and drainage become visible questions.
- **Scale.** Translate footprints into comparisons people already understand: football pitches, the nearest village, the home range of a roe deer or badger group.
- **Post-pastoral landscapes.** Both developers and opponents invoke the pastoral countryside. The tool should help people describe the landscape as it actually is (worked, layered, industrial and agricultural at once), not as an idyll or a wasteland.
- **Information circulation.** Organisers share evidence through social media and messaging apps. Exports must be lightweight, correctly sized, captioned and attributed so they survive being forwarded.

The tone should be evidentiary and careful, not propagandistic. This is a tool for understanding and deliberation that organisers can trust and that planners cannot dismiss as inaccurate.

## 2. Users

- **Primary:** community organisers and residents near proposed sites. Assume no coding experience, no 3D printing experience, and possibly no printer. They may be on a phone.
- **Secondary:** makerspaces, libraries and schools that run printing sessions; journalists; researchers and students; local councillors and community councils.
- **Tertiary:** developers who want to extend the tool to other countries or other kinds of contested infrastructure (gigafactories, hydrogen plants, mines).

## 3. Architecture: two tiers, one repository

The user chose both tiers. They share a site-data format and a layer/colour vocabulary.

### Tier 1: browser app (`web/`)

A static site hosted on GitHub Pages. No install, no account, no server. It runs entirely client-side, so it stays free to host and nobody's searches are logged.

- **Stack:** plain HTML/CSS/ES modules with no build step if feasible (I prefer simple, semantic, maintainable front-ends: `<main>`, CSS custom properties, `ch`-based measure, responsive layout). Three.js for rendering. Use small vendored libraries (for example `fflate` for 3MF zipping, `gifenc` or similar for GIFs). If a bundler becomes unavoidable, justify it in `PLAN.md`.
- **Flow:**
  1. Pick a curated site, search a place, draw a box, or upload a polygon (GeoJSON/KML/KMZ).
  2. Choose a size and a style preset.
  3. Preview the model in 3D and toggle the layers.
  4. Export a print file and/or a digital artefact.
- **Data:** elevation from a CORS-friendly open terrain-tile source (for example AWS Terrain Tiles / Terrarium; verify the licence and attribution). Features come from Overpass with mirror fallback and polite rate-limiting. Cache in IndexedDB.
- **Print exports:** multi-object 3MF (one object per layer group, with colours) and STL (merged, for single-colour printing). Browser exports may be lower resolution than the Python tier. Say so plainly in the UI.
- **Limits:** cap the bbox area in the browser (around 3 km × 3 km), and suggest the Python tier for larger or high-detail builds.

### Tier 2: Python pipeline (`pipeline/`)

An installable package (`pip install hyperscale-landscapes`, or `pipx`), ported from `build_terrain_multi.py` and restructured on the `elcho-maps/providers` pattern.

- **CLI:** `hyperscale build --site auchtertool-cato`, `--bbox file.json`, `--polygon site.geojson`, or `--min_lat …`. Plus `hyperscale render` for artefacts and `hyperscale sites list`.
- **Providers:** one module per layer (see §4), each with a global fallback and an optional Scotland/UK-specific source.
- **Output:** a high-quality multi-object 3MF, an optional merged watertight STL (keep the manifold3d union and sliver filtering from `../scripts/build_terrain.py`), a manifest JSON with stats **and full data provenance**, and the artefacts in §6.
- **Preserve these lessons** (from `../CLAUDE.md`): force CCW exteriors and CW holes with `shapely.geometry.polygon.orient`; keep the river-filter buffer conservative (never past ~80 m, and narrower for canals); bury buildings so they sit on slopes; discard sub-mm³ slivers; designed support-free; Overpass mirror fallback; aggressive caching.
- **Tests:** pytest with small fixture bboxes and cached fixture data, so CI runs offline. Add geometry checks for watertightness, overhang counts and object counts.

### Repository layout (proposed; refine in PLAN.md)

```
hyperscale-landscapes/
├── README.md               ← plain-language front door
├── LICENSE                 ← code licence (see §9)
├── DATA_LICENCES.md        ← per-source data licences + attribution text
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
├── CITATION.cff
├── web/                    ← Tier 1 static app (GitHub Pages)
├── pipeline/               ← Tier 2 Python package
│   └── hyperscale_landscapes/providers/…
├── data/
│   ├── sites/              ← curated site GeoJSON + schema
│   └── presets/            ← layer → colour → extruder presets
├── slicer/                 ← Bambu/Prusa/Orca profiles
├── docs/                   ← guides (also published on Pages)
├── examples/               ← sample outputs (small!)
└── .github/workflows/      ← tests, Pages deploy, data validation
```

Never commit large outputs, `.venv`, caches or STL/3MF builds over about 5 MB. Keep example outputs small, and publish big files as release assets.

## 4. Layers

Each layer has an ID, a display name, a default colour, a short plain-language explanation shown in the UI ("Why this matters"), and provenance metadata. Layers group into **print objects** (see §5).

| Layer | What it shows | Global source | Scotland/UK source (verify licence and API before use) |
|---|---|---|---|
| Terrain | Elevation, exaggerated | Copernicus GLO-30 / SRTM | OS Terrain 50 (OGL); Scottish LiDAR (Remote Sensing Portal) |
| Water | Rivers, lochs, reservoirs, coast | OSM | SEPA flood extents (check licence) |
| Buildings | Footprints extruded on terrain | OSM | — |
| Roads & rail | Roads; **disused railways highlighted** | OSM (`railway=abandoned/disused`) | — |
| Power | Substations, HV lines/pylons, generators, battery storage, wind/solar | OSM `power=*` | DESNZ Renewable Energy Planning Database (REPD), including *proposed* and *consented* projects |
| Industrial residues | Mines, bings/spoil heaps, quarries, refineries, works, landfill, brownfield | OSM (`historic=mine`, `landuse=industrial/quarry/landfill`, `man_made=*`, `disused:*`) | Scottish Vacant and Derelict Land Survey; Coal Authority (Mining Remediation Authority) mining data; Canmore/HES where licensable |
| Receptors | Homes, schools, care homes, hospitals, prisons, community buildings | OSM | — |
| Planning | Zoning/allocations where open (e.g. "employment land") | — | Local development plan data via the Spatial Hub *only if* licence permits; otherwise user upload |
| Proposed data centre | Footprint polygon + estimated massing | Curated dataset / user upload | Curated dataset |

Requirements:

- **Proposed and existing must be visually distinct.** For example, proposed renewables or battery storage get a hatched or outlined treatment in digital views.
- **Optional eras view** in the digital artefacts: tag features by era where the data allows (agrarian, coal and steel, petrochemical, renewable, hyperscale), and let users fade the eras in and out. This is the "landscape structures" argument made visible. Start crude and honest; make it data-driven, never invented.
- Each layer's "Why this matters" text should be one or two sentences, factual and non-polemical. Draft them, then flag them for my review.

## 5. Physical model

- **Default sizes:** 150 mm (~1.5 km bbox) and 200 mm (~2 km). Warn above ~3 km, where buildings stop being legible.
- **Print objects and colour presets.** Most hobby multi-material systems have 4 slots (Bambu AMS / AMS lite), so ship presets that map layers into ≤4 objects:
  - *"Power and place"*: Land / Water / Power + roads + rail / Buildings
  - *"Residues"*: Land / Water / Industrial residues / Buildings + roads
  - *"Full"*: up to 8 objects, for people with more slots, or for painting
  - *"Single colour"*: one merged watertight STL (the manifold3d path)
- **Data centre insert.** Print the proposed facility as a **separate, removable block**: its footprint extruded to the height stated in the planning documents, or to a user-entered estimate (store the source). Cut a matching shallow recess into the base or terrain with ~0.2 mm clearance, so the block can be lifted in and out at meetings. Provide optional magnet holes (e.g. 6×2 mm).
- **Base and labelling.** A 5 mm base by default. Optionally emboss on the base edge or underside: site name, north arrow, a scale bar, the vertical exaggeration factor ("Height exaggerated ×2"), "© OpenStreetMap contributors" and data sources, and the build date. Exaggeration must always be disclosed, because models are evidence.
- **Single-extruder colour.** Support filament changes at layer heights (land, then water level, etc.) by outputting the suggested pause heights, and document the steps in each slicer.
- **No-printer alternative (stretch goal, valuable for workshops):** export SVG contour layers for laser-cut or hand-cut card/plywood stacks, with registration holes and layer numbers.

## 6. Digital artefacts

These are a core feature, not an afterthought. They should match or exceed what I made by hand for Mossmorran (see the files referenced in §0).

1. **Rotating GIF / video:** a turntable orbit around the model with an adjustable camera elevation, duration and speed, and an option to pause on the data centre insert. Output GIF (with size targets: under 8 MB for WhatsApp/Facebook), MP4/WebM, and presets for square 1080×1080, portrait 1080×1350 and 16:9.
2. **Landscape segment:** a cropped oblique render of a strip or section of the landscape, like my `mossmorran-terrain-wide-sample.png`. It can also be a true **cross-section profile** along a user-drawn line (e.g. village → site → substation), showing elevation, the facility's massing at true height, and labelled features. Output PNG/SVG at print resolution.
3. **Self-contained viewer:** a single HTML file with the mesh embedded (as in `mossmorran-terrain-viewer.html`), with layer toggles, labels and captions, that works offline. People can email it or host it anywhere.
4. **Before/after:** the same view with and without the proposed facility, either as a side-by-side image or a crossfade GIF.
5. **Scale comparison card:** an image stating the footprint area and comparisons (football pitches, the nearest village's built-up area, roe deer home range), plus the distances to the nearest home and school, the nearest substation and the nearest watercourse.
6. **Info pack (stretch):** a one-page PDF combining the segment image, scale card, sources and print instructions, for leaflets and planning objections.

Every artefact must carry a **caption strip**: site name, data sources and licences, vertical exaggeration, date generated, and "Proposed footprint approximate; source: [planning ref]". The caption must survive cropping, so place it inside the image.

Rendering: use the same Three.js scene in both tiers. The Python tier can drive a headless browser (Playwright) to render artefacts, or use pyrender/trimesh. Choose whichever gives identical styling to the web app.

## 7. Curated site dataset (`data/sites/`)

- **Format:** one GeoJSON per site plus `index.json`. Define a JSON Schema with these fields:
  - `id`, `name`, `developer` (company name), `local_authority`
  - `status` (rumoured / pre-application / application lodged / consented / refused / withdrawn / operational)
  - `planning_refs` (with URLs)
  - `stated_capacity_mw`, `stated_height_m`, `stated_floor_area_m2`
  - `footprint_precision` (exact from plans / digitised from images / approximate)
  - `sources` (URLs + access dates), `last_verified`, `notes`
- **Seed:** start with Auchtertool (Cato) as the worked example, then the other central-belt sites I will supply. **Do not invent site data.** Where you lack verified information, leave placeholders and list them in `data/sites/TODO.md` for me.
- **User upload:** users can upload a GeoJSON/KML/KMZ, or draw a polygon in the web app and export it in the same schema. Add a "Suggest a site" GitHub issue form that collects sources.
- **CI:** validate all site files against the schema on every PR.
- **Data ethics:** record only corporate and planning information. Do not add personal data about objectors, residents or officials. Receptor layers show building *types* from OSM, never names or addresses of private homes.

## 8. Instructions for people new to 3D printing

Write these as guides in `docs/`, published on GitHub Pages and linked contextually from the app ("New to 3D printing? Start here"). Keep them plain-language and illustrated, using screenshots and diagrams generated from the tool itself.

1. **What you will make, and what it's for.** Show photos and GIFs of finished models in use at a meeting.
2. **Don't have a printer?** Cover makerspaces, library and university maker facilities, community print services and online print bureaus, and how to ask them for help. Include an email template. Also mention the card/laser-cut alternative.
3. **Choosing a size and area.** Explain the trade-offs, print times, rough filament quantity and cost (show the app's estimate), and vertical exaggeration, including why you must disclose it.
4. **Step-by-step slicing:** separate guides for Bambu Studio (A1/A1 mini, P1S, X1 with AMS), OrcaSlicer and PrusaSlicer. Cover:
   - opening the 3MF and assigning colours to objects
   - single-colour printing with pauses for filament swaps
   - my tested settings, as defaults (quoted below)
5. **Printing the removable data centre insert,** and gluing in magnets.
6. **Troubleshooting:** bed adhesion, stringing, colour bleed, warped base, the slicer reporting "non-manifold", and models that are too big for the plate.
7. **Making digital artefacts** without printing anything.
8. **Using models and images responsibly:** cite the sources, disclose the exaggeration, mark the approximate footprints, and don't overclaim.

Tested Bambu A1 defaults (from `../CLAUDE.md`; also ship `slicer/` profiles):

- PLA Basic, not matte (matte hides road detail)
- 0.16 mm layers, with variable layer height 0.08–0.20 biased toward detail
- 3 walls, top shell 5, bottom shell 4; 10% gyroid infill
- Outer wall at 80 mm/s; first layer 30 mm/s
- Smooth PEI at 55 °C; supports OFF; 5 mm outer brim
- Run flow dynamics and flow rate calibration once per spool

## 9. Open-source hygiene

- **Code licence:** GPL-3.0 by default, to keep derivatives open. Flag this in PLAN.md so I can confirm, or switch to MIT.
- **Data:** curated site data under CC BY 4.0. OSM-derived outputs carry ODbL attribution. Every export embeds attribution automatically, and `DATA_LICENCES.md` lists every source with its licence and required attribution text. Check each UK source's licence before integrating it; if it is unclear, leave it out and list it.
- **Repo files:** README (plain language first, technical second), CONTRIBUTING, CODE_OF_CONDUCT, CITATION.cff (credit: Jamie Cross and Alex Nading, University of Glasgow / Cornell), issue templates ("Suggest a site", "Bug", "Printing help") and a privacy statement for the web app (no tracking, no analytics, everything client-side).
- **Accessibility:** keyboard navigation, alt text on generated images (auto-drafted from layer stats), colour-blind-safe default palettes (check the presets for deuteranopia), and readable contrast.
- **Translations:** structure the UI strings for i18n. Gaelic or Scots translations are a possible later addition.

## 10. Phases

0. **Read & plan:** read the existing code and docs, write `PLAN.md`, and stop for review.
1. **Pipeline port:** package `build_terrain_multi.py` into providers. Get parity with the current multi-object 3MF output for a known bbox (use the Mossmorran/Auchtertool bbox in `../multi-extruder/output/` filenames). Set up tests and CI.
2. **New layers:** power, industrial residues, receptors, proposed site + insert, presets, base labelling and the manifest provenance.
3. **Web app MVP:** site picker, draw/upload, 3D preview with layer toggles, STL + 3MF export, and Pages deploy.
4. **Digital artefacts:** turntable GIF/video, landscape segment and cross-section, self-contained viewer, before/after, scale card. All captioned.
5. **Docs:** the beginner printing guides, slicer guides, "no printer" route and responsible-use guide.
6. **Curated dataset:** schema, validation, the Auchtertool example and the site TODO list.
7. **Stretch goals:** laser-cut contour export, info-pack PDF, eras view, i18n.

## 11. Acceptance criteria for v1

- A first-time user can go from opening the site to downloading an Auchtertool GIF in under 3 minutes on a laptop, and under 5 on a phone, without reading any docs.
- The same user can export a 3MF that opens in Bambu Studio with ≤4 coloured objects, prints support-free on an A1 at 150 mm, and includes a removable data centre insert that fits.
- Every export carries correct attribution, the exaggeration factor and the footprint precision.
- The Python CLI reproduces my current multi-extruder output quality for the reference bbox.
- CI passes offline; site data validates; no file in the repo exceeds 5 MB.
- No invented data anywhere. Every unverified item is listed for me.

## 12. Working conventions

- Make iterative, scoped changes, and commit per logical step with clear messages.
- Validate Python and JS before declaring anything done: run the tests, open the web app in a headless browser, render one artefact, and look at it.
- Do not create the GitHub repo or push until I approve `PLAN.md`. Then create it under my account (`gh repo create`), public, with Pages enabled from `web/` or a `docs` build.
- Ask before adding any data source whose licence is unclear, any dependency over ~1 MB, or any server-side component.
