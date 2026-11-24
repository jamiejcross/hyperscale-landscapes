# Site data to verify (for Jamie)

Nothing in `data/sites/` is invented. All 27 sites were imported on 24 Nov 2026
from **APRS's map of proposed data centres in Scotland**
(<https://www.google.com/maps/d/viewer?mid=1iGmWc4tSHrLNwDRCFz86dLgBFWWw-Kg>) by
`tools/import_aprs_map.py`. Every figure is recorded as *reported by APRS*, and
none has yet been checked against planning documents (`last_verified` is empty
everywhere).

## Before public release

1. **APRS's permission and credit.** The site list and its facts come from
   APRS's map. Facts aren't copyright, but the compilation may carry database
   right, and our site data is licensed CC BY 4.0. Ask APRS whether they're
   happy for it to be reused under CC BY 4.0, and how they'd like to be
   credited. Until then, the source is cited on every site.
2. **Planning references.** No site has a planning reference yet. For each,
   add the council's reference and portal URL (`planning_refs`). That is what
   lets `status` move from "as reported" to verified.
3. **Footprints.** No site has a footprint, so none gets a data-centre block.
   Add a polygon only from a planning drawing or a digitised published plan,
   with `footprint_precision` and the stated height (`stated_height_m`,
   `massing_source`).
4. **Pin precision.** Pins are APRS's markers. Irvine is explicitly
   approximate. Check each against the red-line boundary once a footprint is
   added.
5. **Site roles.** `plean` is recorded as *related infrastructure* (the grid
   connection for Larbert), not as a data-centre site. `data-vita-fortis` is an
   extension of an existing data centre. Please confirm these readings.
6. **Status left empty where APRS doesn't state a stage outright**, e.g.
   Ochiltree ("this application"), Cockenzie ("preferred supplier chosen"),
   Auchtertool ("EIA screening"). Please set these from the planning portals.
7. **Auchtertool extent.** APRS's pin lies about 300 m north of the Mossmorran
   study area used so far. The default model is now a 2 km square on the pin;
   your wider Mossmorran extent is kept as `model_bbox_wide`.

## Fields still empty, by site

| id | name | council | not stated |
|---|---|---|---|
| `auchtertool-cato` | Auchtertool (Cato), Fife | Fife | status, stated_height_m, stated_floor_area_m2 |
| `blackdog` | Blackdog, Aberdeenshire | Aberdeenshire | developer, status, stated_height_m, stated_floor_area_m2 |
| `chapelcross` | Chapelcross, Annan | Dumfries and Galloway | stated_height_m, stated_floor_area_m2 |
| `clydebridge` | Clydebridge, Cambuslang | South Lanarkshire | developer, status, stated_capacity_mw, stated_height_m, stated_floor_area_m2 |
| `cockenzie` | Cockenzie, East Lothian | East Lothian | developer, status, stated_capacity_mw, stated_height_m, stated_floor_area_m2 |
| `coldstream` | Laundryfield, Coldstream | Scottish Borders | status, stated_height_m, stated_floor_area_m2 |
| `data-vita-fortis` | Data Vita (Fortis), Chapelhall | North Lanarkshire | status, stated_height_m, stated_floor_area_m2 |
| `data-vita-lancaster-road` | Data Vita, Lancaster Road, Chapelhall | North Lanarkshire | stated_capacity_mw, stated_height_m, stated_floor_area_m2 |
| `data-vita-south-lanridge` | Data Vita, South Lanridge | North Lanarkshire | stated_capacity_mw, stated_height_m, stated_floor_area_m2 |
| `drumshangie` | Drumshangie, Airdrie | North Lanarkshire | stated_height_m, stated_floor_area_m2 |
| `dunbar` | Dunbar, East Lothian | East Lothian | status, stated_capacity_mw, stated_height_m, stated_floor_area_m2 |
| `duns` | Duns, Scottish Borders | Scottish Borders | developer, status, stated_height_m, stated_floor_area_m2 |
| `freeport-west-calder` | Freeport, West Calder | West Lothian | status, stated_height_m, stated_floor_area_m2 |
| `greenock` | Greenock, Inverclyde | Inverclyde | developer, status, stated_capacity_mw, stated_height_m, stated_floor_area_m2 |
| `haspielaw` | Haspielaw, Hamilton | South Lanarkshire | status, stated_capacity_mw, stated_height_m, stated_floor_area_m2 |
| `hunterston` | Hunterston, North Ayrshire | North Ayrshire | stated_capacity_mw, stated_height_m, stated_floor_area_m2 |
| `hurlford` | Hurlford, East Ayrshire | East Ayrshire | stated_height_m, stated_floor_area_m2 |
| `irvine-i3` | Irvine (i3 Business Park) | North Ayrshire | status, stated_height_m, stated_floor_area_m2 |
| `killean-cowal` | Killean, Cowal (Argyll) | Argyll and Bute | developer, status, stated_height_m, stated_floor_area_m2 |
| `larbert` | Glenbervie, Larbert | Falkirk | stated_height_m, stated_floor_area_m2 |
| `newhouse` | Newhouse, North Lanarkshire | North Lanarkshire | stated_height_m, stated_floor_area_m2 |
| `ochiltree` | Ochiltree (Killoch), East Ayrshire | East Ayrshire | status, stated_height_m, stated_floor_area_m2 |
| `plean` | Plean (grid connection for Larbert) | Stirling | status, stated_capacity_mw, stated_height_m, stated_floor_area_m2 |
| `ravenscraig` | Ravenscraig, Motherwell | North Lanarkshire | status, stated_height_m, stated_floor_area_m2 |
| `south-gyle` | South Gyle, Edinburgh | City of Edinburgh | developer, stated_height_m, stated_floor_area_m2 |
| `wester-hermiston` | Wester Hermiston, Edinburgh | City of Edinburgh | status, stated_height_m, stated_floor_area_m2 |
| `westerhill` | Westerhill, Bishopbriggs | East Dunbartonshire | status, stated_height_m, stated_floor_area_m2 |
