# Claude Code prompt: proposed data centres from planning records (v2, "calm")

> Paste this into a Claude Code session opened at the root of `hyperscale-landscapes`.
> It **supersedes the rendering parts** of `docs/claude-code-prompt-data-centre.md` (v1): the glowing translucent shell, the heat rings, the rising column, the pulsing racks and the halos are all dropped. v1 still applies for the schema, the research tables (§1d–1e), the controls in the Model fieldset, the URL state and the tests, except where this file says otherwise.

## What changed since v1, and why

A critique from critical data centre studies, the humanities and engineering found that the glow-and-pulse rendering reproduced the "digital sublime" it set out to question, and drew invented heat effects with the same authority as documented facts. v2 draws only what the planning record supports, in the model's own visual language. The line work itself tells the reader which kind of truth they are looking at:

- **Solid line = documented.** A council-mapped application boundary, a building outline from a full application or a siting plan, or a parameter zone.
- **Dashed line = indicative.** An illustrative layout, or an extent placed by us.

Nothing symbolic is drawn. The reference image is `docs/reference/auchtertool-datacentre-calm.png`, made with mock-up code `docs/reference/mock_datacentre_calm.js` (injected Playwright code: a picture of the intent, not code to paste in).

## Data already gathered (use it; don't refetch)

| File | What it is |
|---|---|
| `data/sites/datacentre-sites.geojson` | **36 features, WGS84.** Councils' application red lines for 9 sites, plus buildings and zones georeferenced from planning drawings for Larbert, South Gyle, Chapelcross and Greenock, plus the hand-traced Auchtertool layout. Every feature has `site`, `kind`, `evidence` (`documented`/`indicative`), `height_m` (where known), `height_basis`, `source`, `area_m2` and (for drawings) a `georeference` fit statement. |
| `data/sites/datacentre-red-lines.geojson` | Red lines only (a subset of the above), with ref, keyVal, area and retrieval date. |
| `data/sites/docs/_boundaries_27700_2026-11-26.json` | The same red lines in raw EPSG:27700, as returned by the councils' map services. |
| `data/sites/docs/_portal_index_2026-11-25.json` | Every application and document found per site (refs, status, document URLs). |
| `data/sites/docs/<id>/…` | The downloaded PDFs: forms, statements, screening and scoping reports, drawings (git-ignored). |
| `docs/reference/datacentre-footprints-check.png`, `check-larbert-overlay.png`, `check-chapelcross-overlay.png` | Visual checks of the georeferenced outlines against the source drawings. |

**Per-site status of geometry:**

| Site | Red line | Buildings / zones | Line style |
|---|---|---|---|
| `auchtertool-cato` | Fife Council map, 69.0 ha (form: 68.90) | 6 halls + 1 auxiliary building, hand-traced from a 1:15,000 raster plan, anchored on the battery storage; ±10% size, ~30 m position | halls dashed |
| `larbert` | Falkirk, 18.8 ha (form: 18.92) | 2 data-centre blocks from the full application's EIAR Fig. 3-1a (vector, fit 0.8 m RMS); office wing excluded; 28 m above FFL | **solid** |
| `south-gyle` | Edinburgh, 6.0 ha (form: 5.74) | "Siting of Data Centre" zone, 4.3 ha, from the PPP siting plan (fit 0.7 m); siting sought for full approval; 18–32 m; **refused, at appeal** | **solid** |
| `chapelcross` | Dumfries & Galloway, 56.6 ha (form: 55) | height-parameter zones (40/15/9 m; fit 2.8 m; read from rendered page because clipped) **solid**; 8 buildings, substation and industrial units from the indicative masterplan (fit 3.0 m) **dashed**, each at its zone's maximum height | mixed |
| `greenock` | Inverclyde, 32.4 ha (form: 28.21, discrepancy) | 2 "potential developable areas" from a preliminary drainage drawing (fit 4.1 m); 18 m max | dashed |
| `ravenscraig`, `coldstream`, `westerhill`, `duns` | red line only (Ravenscraig and Westerhill boundaries are from the pre-application notice, a different stage from the screening figures; flag it) | none yet: place a dashed extent of the stated footprint (§1e of v1) | dashed |
| `hunterston` | none (scoping only) | none | checkbox disabled |
| others | — | — | checkbox disabled (v1 §1e) |

**Licensing (blocking for public release, not for development).** The red lines are council-published, but they are drawn on Ordnance Survey data. The building outlines come from developers' drawings on OS bases. Do the check in `data/sites/TODO.md` item 3 before the public build. Until it is done, keep these layers behind a `DEV_ONLY_PLANNING_GEOMETRY` flag in the public deployment, and record the outcome in `DATA_LICENCES.md`.

## Part 1: make the data reproducible (tools, with tests)

1. **`tools/fetch_council_boundaries.py`.** Idox Public Access sites expose application boundaries through their map's WFS:
   - read `https://<host>/PAM/LIVE/pamap/config.json`;
   - resolve its `mapBaseUrl` (e.g. `../MapServer?map=pa`) against that URL;
   - POST a WFS 2.0 `GetFeature` for typeName `Planning_Application_Polygons` with an `ogc:PropertyIsEqualTo` filter on `KEYVAL`;
   - send a `Referer` of the pamap URL, or you will get a 403.
   
   Coordinates come back as EPSG:27700 `gml:posList`. Write to `data/sites/datacentre-red-lines.geojson`, with ref, keyVal, host, retrieval date and computed area. Compare each area against the application form's site area and warn above 5%. Re-running must reproduce the current file. Hosts and keyVals are in `_portal_index`.
2. **`tools/georef_drawing.py`** (pymupdf, numpy, scipy, shapely, opencv, pyproj). This reproduces how the drawn outlines were made.
   - **Apply the page rotation** (`page.rotation_matrix`); Larbert, Chapelcross and Greenock pages are rotated.
   - **Fitting:** take the red-line strokes of the drawing, convert points to metres at the stated scale (1 pt = 0.35278 mm × scale denominator), flip y, and fit to the council red line by translation-only ICP over a small grid of rotations (±4°) and scales (±2%), with trimmed matching. Accept only a trimmed RMS of 5 m or less, and record it on every feature.
   - **Shapes:** take them from vector fills when they are real polygons. When a drawing uses rectangles clipped by a mask (Chapelcross zones and buildings, Larbert's rotated block), classify the colour in a rendered page and vectorise the contours instead.
   - **Clean-up:** merge fragments per building and use the minimum rotated rectangle for rectilinear buildings. Write a check overlay PNG per drawing.
   - **Input:** a small YAML per drawing (file, scale, red-line colour and width, and the shape colours with kind, name and height rule).
3. **Fold into the site files.** Map these features into each site's `properties.massing` (v1 §1a), using `red_line`, `buildings` (with per-feature evidence) and a new `zones` list for parameter zones. Set `tier`:
   - `plans` where documented building outlines exist (Larbert, South Gyle);
   - `plans` with indicative buildings for Chapelcross (documented zones);
   - `indicative` otherwise.
4. **pytest:** a WFS response fixture parses to the right area; the georeferencing fit on a synthetic drawing recovers a known transform; every feature carries `evidence` and `source`.

## Part 2: rendering (`web/js/scene/datacentre.js`, screen only, shared with the offline viewer)

Print stays untouched: 3MF and STL output must be byte-identical with the option on or off (v1 rule).

- **Red line (documented):** paint it onto the drape as the app already paints the site boundary (`paintBoundary`: dark casing, white halo, red core, `EVIDENCE.redLine`), but solid. It is clipped to the model.
- **Buildings and zones:**
  - **Fill:** flat, low-saturation, using the look's `building` colour from `palettes.js` (Guthrie: walls about `#cdc4af`, roof about `#e2dac7`) with the scene's ordinary lighting. No emissive or animated materials and no transparency.
  - **Base:** each building stands on a **level platform** at the median ground height under it. The *screen* terrain is cut down to that level where it is higher, and a plinth wall fills down to the lowest ground where it is lower. Cuts must be reversible (keep the original heights).
  - **Height:** `height_m` × `mmPerM`, at true height on ×2 terrain (D2), disclosed in the caption.
  - **Outline:** an ink edge (`EdgesGeometry`, about 20° threshold) plus a foot line where the platform meets the ground. Use `LineBasicMaterial` for documented features and `LineDashedMaterial` (dash 7 m, gap 5 m, in world units; call `computeLineDistances()`) for indicative ones.
- **Parameter zones** (Chapelcross): draw them as a pale tint on the drape with a thin solid ink edge, not as volumes. Show the zone's height in a small label ("up to 40 m"). Buildings sitting in a zone take that height and stay dashed.
- **Extents without drawings** (Ravenscraig, Coldstream, Westerhill, Duns): one dashed box of the stated footprint area, at the stated height, placed on the flattest ground inside the red line (v1 pad-siting maths). The caption says "extent placed by us from the stated footprint; no layout published".
- **Heritage:** where the record names an affected asset, draw a small ink dot with a label on a thread. Auchtertool is the case so far: "Hallyards Castle (ruin) / application: record, then remove unless viable to keep" (D&A; Heritage Impact Assessment).
- **Removed from v1:** the warm shell shader, the ground spill, the heat rings, the rising column, the warm point light, the blue rack pulse and the halos. Keep **nothing** that animates.

## Part 3: controls (Model fieldset, beside Tree height)

- **"Data centre (proposed)"** checkbox: off by default. Disabled with its reason when the site has no sourced area and height (v1 §1c).
- **"Server racks"** (optional, secondary, off by default): static line-art rack bays drawn **inside** documented or indicative buildings only, never on open ground. Keep the v1 density presets and the kW-per-rack readout. Where a document gives data-hall floor area (Auchtertool: 10,000 m² per building), set slider capacity from it. No pulse.
- **Later (separate commit):** a **phase** select, where a phasing plan exists (Larbert construction phases 1–3, Chapelcross indicative phasing). Phase plans are in `data/sites/docs/<id>/`.

## Part 4: caption and legend

- **Caption line** for each site, built from the features, e.g. *"Proposed data centre (26/01243/PPP): application boundary from Fife Council's map (solid); building positions indicative, from the developer's illustrative layout (dashed); heights ~24.5 m (Supporting Document); terrain ×2, buildings true height."*
- **Legend:** two line samples, "documented" (solid) and "indicative" (dashed), plus the red line. No other data-centre legend items.
- **"Why" note** on the checkbox: one paragraph saying that what is drawn comes from the planning record and nothing is symbolic.

## Part 5: tests and checks

- **Node:** dash/solid chosen from `evidence`; platform cut reversible (terrain vertices and drape pixels identical after toggling off); heights from `height_m`; features outside the model extent clipped.
- **Manual:** screenshots at Auchtertool, Larbert, Chapelcross and South Gyle in all three looks, compared with `docs/reference/auchtertool-datacentre-calm.png` and `datacentre-footprints-check.png`.
- **Byte-identical print** with the toggle on and off.

## Deliver

1. A short plan.
2. Part 1, with the tools re-running cleanly and reproducing the current GeoJSON. Show me the diffs.
3. Parts 2–5 as separate commits.
4. Update `PLAN.md` (v2 replaces the v1 rendering; why) and `DATA_LICENCES.md` (council WFS boundaries; developers' drawings; the OS check status).
