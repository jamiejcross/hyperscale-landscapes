# Claude Code prompt: a proposed data centre that can be toggled on and off at each site

> Paste this into a Claude Code session opened at the root of `hyperscale-landscapes`.
> The mock-up is in `docs/reference/`: `datacentre-mockup.png` and `.gif`, plus `mock_datacentre_shell.js` and `mock_datacentre_extras.js`. Those files are injected Playwright code written for a mock-up, so treat them as a picture of the intended result, not as code to paste in.

## What this adds

This adds a **screen-only "Data centre (proposed)" option** to each site. When it is on, the model shows:

1. **The building.** One continuous translucent warm-orange volume covering the proposed building extent, at the height in the planning documents. It has **no internal divisions**: only its outer walls, a single roof, and an outline around the foot, the roof edge and the four corners.
2. **Server racks inside it.** Instanced rack bays in a crisp line-art style, pulsing blue, standing on **level pads** that are sited on the flattest ground inside the footprint.
3. **Radiating heat.** Thin wavefronts travel outward across the land and up a soft column above the roof, with a warm ground glow and a warm point light.

There are three controls, all in the studio's **Model** fieldset next to the tree-height slider:

- a **"Data centre (proposed)"** checkbox;
- a **"Server racks"** slider;
- a **"Rack density"** select.

Under them sits a one-line readout. It is off by default.

**Print stays untouched.** STL, 3MF, the slicer and the export walls do not change. PLAN.md's decision to drop the physical insert still stands ("No data-centre block": a block risks being inaccurate and leaves a hole when lifted out). This feature is a screen layer. It never changes the printable Land object and it never cuts the print geometry.

## Ground rules (from BRIEF/PLAN; do not relax these)

- **Nothing invented.** Every number the layer draws comes from a recorded source in the site file, or is an explicit, labelled assumption with a constant name in code. If a site has no sourced building area or height, the checkbox is **disabled**, and its tooltip and hint say why (see Tiers).
- **Label honestly, in four tiers.** Every caption, legend and hint separates what is **published** (a planning document or official briefing), **indicative** (placed by us), **assumed** (a stated engineering assumption) and **symbolic** (the glow, heat waves and blue pulse are visual metaphors, not physical models).
- **True height.** The building is drawn at true height on terrain exaggerated ×2, following D2 (buildings at true scale, terrain ×2, both disclosed).
- **Licensing.** Do not trace footprints from OS-based planning drawings without the check in `data/sites/TODO.md` item 3. Keep APRS credited.
- **Write all code from scratch** in the repo's style: ES modules with no build step, pure maths split into a `*-math.js` file with Node tests, as `pits-math.js` and `props-math.js` already are.

## Part 1: data (do this first and show me before writing any rendering)

### 1a. Schema

Extend each `data/sites/<id>.geojson` with an optional `properties.massing` object. Keep the existing top-level fields (`stated_height_m`, `stated_floor_area_m2`, `stated_building_area_ha`, `footprint_precision`, `massing_source`). `massing` holds the detail and its provenance:

```jsonc
"massing": {
  "tier": "plans" | "red_line" | "indicative" | null,      // see 1c
  "buildings": null,            // GeoJSON MultiPolygon of building footprints, from a planning drawing only
  "red_line": null,             // GeoJSON Polygon of the application boundary, from a planning drawing only
  "indicative_extent": null,    // GeoJSON Polygon placed by us when there is no drawing (tier "indicative")
  "indicative_extent_method": null,  // one sentence on how it was placed
  "building_area_m2": null,  "building_area_source": null,   // source = {title, publisher, url, accessed, quote}
  "height_m": null,          "height_source": null,
  "capacity_mw": null,       "capacity_source": null,        // usually = stated_capacity_mw
  "pue": null,               "pue_source": null,             // null → app uses the assumed default
  "notes": null
}
```

- Add the schema to `data/sites/` with validation, in the same style as `bundle.schema.json`.
- Extend `tools/import_aprs_map.py`, or add `tools/massing.py`, so that it never overwrites hand-entered massing.
- Add pytest coverage for: rejecting a geometry that has no source; an area that disagrees with its polygon by more than 10% raising a warning; and `tier` being consistent with which geometries are present.

### 1b. Research each site's planning documents (27 sites)

For each site, look for:

- the council planning reference and portal URL;
- the DPEA case (EIA screening and scoping decisions);
- the Design and Access Statement, Planning Statement, EIA screening request, parameter plans and site location plan;
- SPICe or Scottish Government briefings;
- council committee reports.

Record each figure with a short quote and its URL. Fill `planning_refs`, `status` and `last_verified` while you are there.

If you cannot reach a portal (many Idox portals block automated access), do not guess. Write `data/sites/MASSING_TODO.md` listing, per site, the documents to fetch and the exact fields still missing, so that I can download the documents and drop them in `data/sites/docs/<id>/` (git-ignored). Then read the documents I supply.

### 1c. Tiers: what to draw from what we know

| Tier | What the site file holds | What gets drawn |
|---|---|---|
| `plans` | building footprints from a planning drawing, plus height | those footprints, each at its stated height |
| `red_line` | an application boundary, plus building area and height | one extent of the stated area, placed inside the red line on its flattest ground. Caption: "building extent indicative within the application boundary" |
| `indicative` | only a pin or location, plus building area and height from a published source | a rectangle of the stated area, placed by a documented method. Caption: "building extent indicative; no published plan" |
| `null` | no sourced area or no sourced height | nothing. The checkbox is disabled with the tooltip "No published building area or height for this site yet" |

### 1d. Auchtertool (Cato), the worked example

**Checked against the application documents on 25 Nov 2026.** The documents are in `data/sites/docs/auchtertool-cato/` (git-ignored); they were downloaded from the planning.org.uk mirror of Fife's register.

| Figure | Value | Source |
|---|---|---|
| Application site (red line) | **68.90 ha** | Application form, "Site Area" |
| Application site, as divided up in the D&A | 68.7 ha: 24.8 ha Development Area, 40.9 ha landscaping and water storage, 3 ha access and margins | Design & Access Statement, Iteration Stage 8 |
| Development Area | **~25 ha** ("25 ha approx") | Supporting Document §2.4 |
| Sub-areas | Main Building Area 16.1 ha (buildings ≤35 m); Substation Area 3.1 ha (≤15 m); Ancillary Area 2.9 ha (≤12 m); Construction / Auxiliary Building Area 1.9 ha (≤12 m); Entrance Area 0.8 ha (≤12 m) | D&A, Iteration Stage 7 |
| Buildings | **6 main data hall buildings of identical footprint**, side by side in a row, stepping up in height towards the west. Plus 1 auxiliary building south of the Dronachy Burn (labs/offices, ≤12 m). Substation at the west end. | Supporting Document §2.4; D&A |
| Heights | maximum **35 m** above proposed ground for assessment; main body of each hall **~24.5 m**; "stoa" frontage 12 m; substation and switchgear ~15 m | Supporting Document §2.4 |
| Floorspace | **160,000 m² gross** (estimate); target of **10,000 m² data hall floor space per building** | Application form; D&A |
| Flood storage | 4.7 ha; minimum finished floor level 117.15 m AOD | Supporting Document; D&A |
| Hallyards | the remains are isolated to a single building plot; the Heritage Impact Assessment discusses loss preceded by "preservation by record" | D&A; HIA |
| OS grid reference on the block plan | 321000 691000 | Block plan (LoganPM) |

- **Not in any application document:** SPICe's "280,000 m²" (repeated by CMS as land area). Treat it as secondary and unexplained. Use 160,000 m² GFA and the 25 ha Development Area.
- **Press figures:** 60 ha (BBC/Yahoo) and 62 acres (Bisnow, ≈ 25 ha) are approximations of the 68.9 ha and 25 ha figures. "Up to seven buildings" is the six halls plus the auxiliary building.
- **Footprint geometry:** the illustrative layout is drawn on an OS base (Crown copyright). Digitise the six hall footprints, the Development Area and the red line **only after the licensing check** in TODO item 3. Until then, set `tier: "indicative"` and use the stated sub-area extents and hall count, laid out by the method below.
- **Layout to emulate:** a single row of six identical halls, each about 100 × 230 m including plant compounds, with roughly 75 × 170 m data-hall cores. These sizes were measured from the 1:15,000 location plan, which is marked "do not scale", so allow ±10%. The row's long axis runs WSW–ENE, with the halls' long axes roughly N–S. The substation sits at the WSW end and the Camilla battery storage just beyond the ENE end.

The rest of this subsection (below) comes from earlier research and has been superseded where it conflicts with the table above:

- **Application:** Fife Council 26/01243/PPP, Planning Permission in Principle for a data centre campus, land north of Camilla Road, Gleniston, Auchtertool. The applicant is ILI Group. The site is at <https://planning.org.uk/app/194/TE9GGMHFFWY00>; get the Fife Idox URL for the record.
- **EIA:** DPEA case EIA-250-002, decision 17 Aug 2026 ("EIA Required"): <https://www.dpea.scotland.gov.uk/CaseDetails.aspx?id=128778>.
- **Building area:** 280,000 m² of buildings. SPICe Spotlight, "Data centres", 26 Jun 2026: <https://spice-spotlight.scot/2026/06/26/data-centres/>. Check whether this is footprint or floor area against the Planning Statement, and record which.
- **Height:** data hall buildings up to 35 m. Same SPICe piece, and STV/LDRS: <https://news.stv.tv/north/fife-community-taken-aback-at-scale-of-plans-for-data-centre>.
- **Capacity:** 600 MW. Already in the file from APRS; also stated in ILI's submission as reported by the trade press.
- **Site area:** about 25 ha. Construction Review Online cites the planning documents; confirm against the Planning Statement.
- **Indicative extent:** use it until a drawing is supplied. The mock-up used a rectangle at lon −3.2770 to −3.2672 and lat 56.1056 to 56.1097, about 608 × 456 m, or 27.7 ha. It lies due west of the APRS pin (the Camilla battery storage) and takes in Hallyards Castle, because APRS reports that the submitted plans build over it. Record that method sentence as it stands.
- **Flag the conflict:** 280,000 m² of buildings exceeds the ~25 ha site, which suggests the figure is floor area across storeys. Mark the conflict and do not resolve it by fiat.

### 1e. The other 26 sites: pre-filled from council records (25 Nov 2026)

These figures were read directly from documents downloaded from each council's Idox register. The PDFs are in `data/sites/docs/<id>/` (git-ignored, about 330 MB); `data/sites/docs/_portal_index_2026-11-25.json` lists every application and document found. Re-read each figure from the PDF and quote it in `*_source` before entering it.

**How to read the "Stage" column:**
- **PAN:** pre-application notice.
- **SCR / EIASCR:** EIA screening.
- **SCO / EIA:** EIA scoping.
- **PPP / PIP:** planning permission in principle.
- **FUL:** full permission.
- **MSC:** matters specified by conditions.

Screening and scoping figures are the developer's *proposed* parameters. They are weaker than figures from an application, and the caption must say "proposed at screening/scoping stage".

**How to read the "Tier" column:** it gives the proposed tier and assumes footprints are not yet digitised (licensing check pending). Following 1c, a site is drawn only when it has a sourced area **and** a sourced height.

| Site (`id`) | Main reference(s) and stage | Site area | Building area / floorspace | Height | Buildings | Tier | Source documents |
|---|---|---|---|---|---|---|---|
| `chapelcross` | Dumfries & Galloway 26/1649/PIP (PPiP with EIA, validated Sept 2026); 26/0464/SCO; 26/0855/PAN | **55 ha** (application form; ~57 ha at scoping) | **≤162,000 m² GFA** data centre, plus ≤1,100 m² training centre and ≤6,500 m² industrial units | **≤40 m** to top of plant (data centres); training centre ≤18 m; industrial ≤16.5 m; substation ≤9 m | D&A illustrative layout: **eight** data centre buildings | indicative | Application form; Cover Letter; Planning Statement; D&A; Scoping Report; Building Height and Land Use Parameter Plans |
| `larbert` | Falkirk P/26/0237/FUL (full application with EIA, awaiting decision) | **18.92 ha** (application form) | **128,863 m² GIA** (form; Planning Statement). East DC 85,500 m² and West DC 44,000 m², each 2 floors (Site Waste Management Plan) | **28 m** above FFL for DC1 and DC2 (EIAR App. 9-2, cited in AECOM review); substation ≤15 m | **2** data centre buildings | indicative (full application: drawings may give exact footprints) | Non-householder application form; Planning Statement; D&A; LEMP; AECOM technical review |
| `greenock` | Inverclyde 26/0136/IC (PPP, pending; EIA not required) | **28.21 ha** (application form) | **c. 80,000 m²** floorspace (form; Planning Statement 4.16) | **18 m** maximum (Planning Statement, citing the EIA Screening Request) | not fixed | indicative | Application form; Planning Statement (copy via APRS) |
| `south-gyle` | Edinburgh 25/04239/PPP, **refused** Feb 2026; appeal DPEA PPA-230-2794 (appellant to submit EIA Report) | **5.74 ha** (form; 5.86 ha at screening) | **65,000 m²** (form) | parameter range **18–32 m** | **2** data centre buildings | indicative (status "refused, at appeal" must show) | Application form; screening form |
| `hunterston` | North Ayrshire 26/00138/EIA (scoping opinion agreed); ECU00003319 | 88.16 ha (APRS; **not found in the scoping report**, so verify) | **≤300,000 m² total footprint**; indicative 6 × 50,000 m² | **≤35 m** | indicative **6** | indicative (scoping-stage parameters) | EIA Scoping Report §3.5 |
| `ravenscraig` | North Lanarkshire 25/00744/EIASCR (no EIA required); 25/00838/PAN (550 MW) | **41.6 ha** development area | **c. 65,000 m² GEA footprint**, 1–2 storeys | **c. 15 m** (excluding chiller plant and flues) | "one or more" | indicative (screening) | EIA Screening Request §2.2, §3.4. **Conflict:** APRS quotes a 158,119 m² GEA footprint, probably from a later document. Find it before choosing. |
| `coldstream` | Scottish Borders 25/00556/SCR (no EIA required) | **68.9 ha** (screening); APRS gives a PAN boundary of 252 ha | **c. 75,000 m² GEA footprint**, 1–2 storeys | **c. 15 m** (excluding chiller plant and flues) | "one or more" | indicative (screening) | Screening Request; SBC screening opinion |
| `westerhill` | East Dunbartonshire TP/ED/25/0245 (EIA required); TP/ED/25/0428 PAN; TP/ED/26/0627 (awaiting decision) | **52.1 ha** | **c. 85,000 m² footprint**, 1–2 storeys | **c. 15 m** | not fixed | indicative (screening) | EIA screening decision and checklist. Check TP/ED/26/0627 for application figures. |
| `duns` | Scottish Borders 25/01835/SCR (EIA required); 26/01660/PAN | **151 ha** in total, including access options; development site **c. 88 ha** | **3 × 54,000 m²** internal floor space over 2 floors (27,000 m² ground footprint each); total footprint c. 8 ha | **≤24 m** (excluding plant and flues) | **3** two-storey buildings | indicative (screening) | EIA Screening Report (Ironside Farrar) §2.3.4, §5.1.4; SBC screening opinion |
| `dunbar` | East Lothian 25/00008/SCR (EIA required); scoping opinion | **60.2 ha** | not stated | **c. 12 m** (2 storeys, excluding roof plant) at scoping | "building(s)" | `null` until a floor area appears | Screening opinion; Scoping Report §2.8 |
| `data-vita-fortis` | North Lanarkshire 25/01159/PPP (**permitted**); 25/00150/FUL extension (permitted); 26/00350/MSC | **1.8 ha** (PPP); existing site 1.76 ha (FUL) | existing building about 8,000 m² (APRS); new building's area not stated | "likely … a **3 storey** building" (PPP statement); no metre figure | 1 new building plus existing | `null` (no metre height; check MSC drawings) | Planning statement and EIA screening report; site plans; decision notices |
| `wester-hermiston` | Edinburgh 25/02924/SCR (no EIA required); 25/03978/PAN (200 MW) | **30.5 ha** (screening form) | not stated | not stated | not stated | `null` | Screening application form and decision; PAN form |
| `newhouse` | North Lanarkshire 25/00989/PAN; 26/00595/EIASCR (**withdrawn**) | **c. 46 ha** (screening request) | not stated | not stated | indicative site layout drawing only | `null` | EIA screening request; indicative site layout |
| `drumshangie` | North Lanarkshire 24/01025/PAN, 26/00069/PAN: "digital and manufacturing campus" (data centres, gigafactory, …) | PAN boundary **252.53 ha** (237.50 ha in the earlier PAN); "area under consideration" **c. 150 ha** | not stated | not stated | not stated | `null` (mixed campus; data centre share unknown) | PAN cover letter; location plans |
| `blackdog` | Aberdeenshire APP/2016/0766, a 2016 **mixed-use town-centre** PPP (38.2 ha); APP/2019/2161 conditions | the 2016 consent is not a data centre application | — | — | — | `null` (APRS: "around 200 acres", developer statements only) | 2016 application form and masterplan, kept for context only |
| `data-vita-lancaster-road` | North Lanarkshire 25/01322/PAN (Lancaster Avenue) | not stated in the PAN | — | — | — | `null` | PAN decision letter |
| `data-vita-south-lanridge` | North Lanarkshire 25/01328/PAN (South Lanridge Farm) | not stated in the PAN | — | — | — | `null` | PAN decision letter |
| `killean-cowal` | Argyll & Bute 20/00229/PP (a single data-storage building, 2020); 25/00445/CLAWU | APRS: an AI Growth Zone bid covering 186 acres (not a planning document) | — | — | — | `null` | — |
| `hurlford` | East Ayrshire 25/0008/PREAPP (pre-application; ILI "Rufus", 540 MW) | press: about 100 ha earmarked | — | — | — | `null`, **fetch by hand** | East Ayrshire portal not reachable from the research machine |
| `ochiltree` | East Ayrshire (EIA required; APRS) | APRS: **24.5 ha**, **45,000 m²** building, so verify | APRS figure only | — | — | `null` until verified, **fetch by hand** | as above |
| `haspielaw` | South Lanarkshire (PAN; EIA required; APRS) | — | — | — | — | `null`, **fetch by hand** | South Lanarkshire portal not reachable |
| `freeport-west-calder` | West Lothian (PAN; APRS) | — | — | — | — | `null`, **fetch by hand** | West Lothian portal not reachable |
| `clydebridge` | not in planning (NESO register "Clydebridge DC", 360 MW) | — | — | — | — | `null` | — |
| `cockenzie` | not in planning; East Lothian Council and SDCL joint-venture feasibility | APRS: "around 70 acres" | — | — | — | `null` | — |
| `irvine-i3` | not in planning; location approximate | — | — | — | — | `null` | — |
| `plean` | related infrastructure (BESS and grid connection for Larbert); earlier PAN site of about 43.1 ha | — | — | — | — | `null` (not a data centre; never drawn) | — |

**Tally:**
- 10 sites can be drawn now: Auchtertool plus `chapelcross`, `larbert`, `greenock`, `south-gyle`, `hunterston`, `ravenscraig`, `coldstream`, `westerhill` and `duns`.
- 16 stay greyed out: `dunbar`, `data-vita-fortis` and `wester-hermiston` are close, needing one more figure each.

**Notes for building the layer:**
- **Floorspace vs footprint.** Area figures mix GFA, GIA, GEA footprint and "total footprint". For the drawn building extent, use a **footprint** figure where one exists. Where only GFA/GIA is given, divide by storeys if a document states them (Larbert: 2 floors; Duns: 2 floors). Otherwise draw GFA as single-storey extent, labelled "upper bound on footprint; floorspace may be spread over several storeys".
- **Rack slider capacity.** Where a document gives data-hall floor area (Auchtertool: 10,000 m² per building; Larbert: MW per data hall in the SWMP), use it to set the slider's capacity instead of the pad-fitting maximum, and say so in the hint.
- **Manual fetching.** Add the four sites marked "fetch by hand" to `MASSING_TODO.md` with their portal links from `_portal_index`. The East Ayrshire, South Lanarkshire and West Lothian portals refused automated connections.

## Part 2: geometry and maths (`web/js/scene/datacentre-math.js`, pure functions plus Node tests)

1. **`roofSurface(groundGrid, heightM, {smoothCells, minFrac = 0.8})`.** The ground under the footprint is sampled on a grid and box-smoothed. Roof = min(ground + H, max(smoothed + H, ground + 0.8·H)), so the roof is never above the stated height and never below 80% of it. Return the worst-case wall height for the caption. **Test:** the maximum wall height is ≤ H everywhere.
2. **`sitePads(heightGrid, footprint, {padW, padH, gap, inset, step})`.** Slide a pad-sized window over the footprint in steps of 10 m. Score each position by relief (max − min of a 7×5 sample) and greedily keep the flattest positions that don't overlap, in flatness order. Each pad gets `z = median` ground level. Make it deterministic, with a tie-break by x then y. **Test:** no overlaps, every pad inside the footprint, flatter pads first, and the same result on every run.
3. **Pad size.** A pad holds one hall of 6 × 6 bays plus an 8 m margin, about 103 × 72 m. A bay is 12 × 6 × 6 m (L × W × H) with 3 m and 4 m aisles. All of these are named constants carrying an `// assumed` comment.
4. **Racks and power.**
   - `racksForBays(n) = n × RACKS_PER_BAY` (40, assumed).
   - `kwPerRack(racks, mw, pue) = mw / pue × 1000 / racks`, with `PUE_DEFAULT = 1.3` (assumed) when the site has none.
   - `densityPresets(mw, pue, capBays)` returns:
     - "AI, ~120 kW per rack": bays = ceil(IT kW / 120 / 40) rounded up to a whole hall;
     - "~40 kW per rack";
     - "fill level ground" (= capacity).
   
   **Test:** with 600 MW at PUE 1.3, "AI" gives 96 bays and 3,840 racks.
5. **Capacity.** Capacity = the number of pads that fit × the bays per pad, and the slider max is set to it. The hint says so in words, e.g. "15 level pads fit; the slider stops at 21,600 racks". Do not stack storeys (one storey is assumed, and stated).

## Part 3: rendering (`web/js/scene/datacentre.js`, used by both the web app and the offline viewer, like `extras.js`)

All of this is screen-only and must be fully reversible: turning the option off must leave the scene exactly as before.

### Shell
- A single mesh: a roof grid with perimeter walls running from the ground (buried 0.3 m) to the roof. Use `transparent`, `depthWrite: false`, `DoubleSide`.
- **Wall shader:** gets hotter towards the roof; heat shimmer from `uTime`; a bright roof line and foot; alpha about 0.08–0.75.
- **Roof shader:** no grid and no internal lines.
- **Outline:** foot line plus roof perimeter plus four corner verticals, in `#7a1f0c`. Nothing else.
- **Colours:** per look, from `palettes.js`. Defaults are deep `#b8260f` and pale `#ffb36b`. Add a `datacentre` entry to each palette, keeping the Guthrie and Anthropogenic looks harmonious, and check contrast against the red line.

### Pads
- Each pad is a box from (lowest ground − 1.5 m) to (pad z + 0.4 m).
- **Top colour:** the drape's average colour under the pad, mixed 18% towards paper `#efe6d4`. **Sides:** the same colour ×0.72. **Edges:** the same colour ×0.45.
- **Ground cut:** where the terrain is above pad z, lower the **screen** terrain vertices to pad z. Keep a copy of the original heights so it can be undone. Never touch the print path. Only the pads in use are cut and shown.

### Racks
- One `InstancedMesh` holding all capacity bays, with the count set by the slider (`im.count = n`, plus `setDrawRange` on the ink edges).
- **Texture:** line-art canvas textures (front: 20 rack fronts with vent lines; top: two rows of rack tops).
- **Shader:** blue pulse, `0.5 + 0.5·sin(2·τ/LOOP·t − |xz|·0.9)`, colours `#0a3d8f` → `#3aa4ff`. Draw after the shell (`renderOrder` 30) so the blue reads through it.
- **Halos:** one additive halo sprite per pad in use, pulsing in phase.

### Heat
- **Rings across the land:** a second mesh sharing the terrain geometry, with polygon offset. Its shader takes the signed distance to the footprint in metres. The front is `pow(0.5 + 0.5·cos(2π(d/140 − t/LOOP)), 9)` with a fall-off of `exp(−d/420)`, discarded beyond 1,400 m. It adds a soft glow of `exp(−d/70)·0.2` at the wall foot. No particles.
- **Rising column:** an open, widening tube above the roof (spread ×2.1, about 200 mm of model height). Wavefronts travel up it at `cos(2π((y + wobble)·5 − t/LOOP))`; it fades with height and is shaded by facing.
- **Light:** a warm `PointLight` at the roof centre, with a gentle pulse.
- **Ground spill:** draw it as part of the ring shader (the `exp(−d/70)` term), **not** painted into the drape canvas. Painting into the drape could not be undone and would leak into PNG drape exports.

### Time
- Register a single `update(t)` with the scene's existing animation hook, so that turntable and animation exports include the pulse and the waves.
- `LOOP` divides the animation length, so exported loops are seamless.
- Under `prefers-reduced-motion`, render one still frame (`t` fixed) and do not animate.

## Part 4: interface

- **Model fieldset** (`studio.js`, through a slot like `treeSlot`):
  - `Data centre (proposed)`: a checkbox, off by default, disabled with a tooltip when the tier is `null`.
  - `Server racks`: a `label.range` with a slider (step = one hall) and `<output>` showing the rack count with thousands separators.
  - `Rack density`: a `<select>` offering the three presets plus "custom". Moving the slider sets it to custom.
  - A `p.hint`, e.g. "96 bays on 3 of 15 level pads · ~120 kW per rack at 600 MW (PUE 1.3)".
  - Hide the slider, select and hint while the checkbox is off.
- **i18n:** add every string to `data/i18n/en-GB.json` (`dc.toggle`, `dc.racks`, `dc.density`, `dc.preset.ai`, `dc.preset.40`, `dc.preset.fill`, `dc.hint`, `dc.disabled`, `dc.why`, the tier captions). Nothing hard-coded.
- **URL state** (`urlstate.js`): `dc=1` and `racks=<bays>`, validated and clamped, with tests in `urlstate.test.mjs`.
- **Caption** (drawn into the canvas, per PLAN.md), e.g. "Proposed data centre: building area 280,000 m² and height ≤35 m (SPICe, 2026); extent indicative; 3,840 racks assumed at 40 per bay, ~120 kW per rack; heat and pulse are symbolic."
- **Legend** (`legend.js`): items for the shell, a rack bay, a pad and the heat rings. Each is marked by its tier.
- **"Why this matters"** note on the checkbox: one paragraph covering scale, power and heat, and that the arrangement is illustrative.
- **Looks:** the layer is available in all three looks. In **Print colours** mode, hide the glow, rings, column and halos, and keep the shell outline and pads in ink.

## Part 5: tests and checks

- **Node** (`tests/web/datacentre.test.mjs`): roof cap, pad siting, presets, kW per rack, capacity, URL round trip.
- **pytest:** the massing schema and the tier logic.
- **Manual check:** Auchtertool in all three looks with the toggle on and off; take screenshots at 96, 288 and the maximum number of bays. After toggling off, terrain vertices, drape pixels and `scene.children` match a fresh load.
- **Exports:** PNG and animation exports show the caption and legend. The 3MF and STL output is **byte-identical** to `main` with the toggle on or off.
- **Performance:** about 600 instances plus 2 shader meshes. Pad siting reads heights from the terrain vertices (bin them to 5 m cells). It does **not** raycast per sample; the mock-up's first version took minutes doing that.

## Deliver

1. A short plan.
2. Part 1, with `MASSING_TODO.md` and a diff of the Auchtertool massing for my review.
3. Then Parts 2–5 as separate commits.
4. Update `PLAN.md` with a short entry recording this screen-only layer and why it does not reverse the "No data-centre block" decision for print.
5. Update `DATA_LICENCES.md` for any new sources.
