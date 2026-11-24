"""Import the sites on APRS's map of proposed data centres in Scotland.

Source: "APRS's map of proposed Data Centres in Scotland" (Google My Maps,
mid=1iGmWc4tSHrLNwDRCFz86dLgBFWWw-Kg), exported as KML on 24 Nov 2026.

What is taken from the map:
  - the point location of each site (APRS's own pin; precision as stated);
  - facts stated in APRS's description, transcribed by hand into FACTS
    below: developer, stated capacity, planning stage where stated outright,
    stated site area, and short neutral notes.  APRS's own wording is not
    copied; figures are recorded as "reported by APRS" and are not yet
    checked against planning documents.
Local authority comes from OpenStreetMap boundaries (Nominatim reverse
lookup of the public site point).  The model_bbox is centred on
the point (3.2 km east–west by 1.2 km north–south): a modelling extent, not
a site boundary.  No footprint is
recorded for any site, so none has an insert.

    python tools/import_aprs_map.py map.kml local_authorities.json
"""
from __future__ import annotations

import json
import math
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITES = ROOT / "data" / "sites"
MAP_URL = "https://www.google.com/maps/d/viewer?mid=1iGmWc4tSHrLNwDRCFz86dLgBFWWw-Kg"
ACCESSED = "2026-11-24"
WIDTH_KM, HEIGHT_KM = 3.2, 1.2   # default model area: wide landscape strip (JC, 24 Nov 2026)

# KML placemark name -> facts transcribed from APRS's description.
# None = not stated on the map.  status uses the schema's vocabulary and is
# set only where APRS states the stage outright.
FACTS = {
    "Ravenscraig": dict(id="ravenscraig", name="Ravenscraig, Motherwell", developer="Apatura",
        capacity=550, status=None, notes="Former Ravenscraig steelworks site. APRS reports that no Environmental Impact Assessment (EIA) is required."),
    "Coldstream": dict(id="coldstream", name="Laundryfield, Coldstream", developer="Apatura",
        capacity=300, status=None, notes="Farmland near Coldstream. APRS reports that no EIA is required."),
    "Drumshangie": dict(id="drumshangie", name="Drumshangie, Airdrie", developer="Apatura",
        capacity=500, status="pre-application", notes="Drumshangie Moss and the former Drumshangie coal mine; APRS notes the area includes the memorial to the Stanrigg pit disaster."),
    "Killean": dict(id="killean-cowal", name="Killean, Cowal (Argyll)", developer=None,
        capacity=1000, status=None, notes="APRS reports a proposal of 1,000 MW scaling to 2,000 MW, an AI Growth Zone application covering 186 acres, and a 2020 consent for a single smaller data-storage building nearby."),
    "Auchtertool": dict(id="auchtertool-cato", name="Auchtertool (Cato), Fife", developer="ILI",
        capacity=600, status=None, notes="Farmland by Auchtertool. APRS reports a newly built battery energy storage system next to the site, that the council is screening for EIA, and that the submitted plans show buildings over Hallyards Castle."),
    "Hurlford": dict(id="hurlford", name="Hurlford, East Ayrshire", developer="ILI",
        capacity=540, status="pre-application", notes="Farmland on the edge of Hurlford, near Kilmarnock."),
    "Newhouse": dict(id="newhouse", name="Newhouse, North Lanarkshire", developer="ILI",
        capacity=400, status="pre-application", notes="Green Belt farmland between Chapelhall and Holytown."),
    "South Gyle": dict(id="south-gyle", name="South Gyle, Edinburgh", developer=None,
        capacity=213, status="refused", notes="APRS reports that the City of Edinburgh Council planning sub-committee refused planning permission in principle in February 2026. The site had permission for offices."),
    "Wester Hermiston": dict(id="wester-hermiston", name="Wester Hermiston, Edinburgh", developer="Apatura",
        capacity=200, status=None, notes="Green Belt farmland. APRS reports that no EIA is required."),
    "Freeport": dict(id="freeport-west-calder", name="Freeport, West Calder", developer="Apatura",
        capacity=250, status=None, notes="Former Freeport shopping centre site and Green Belt land next to the Five Sisters bing (spoil heap)."),
    "Westerhill": dict(id="westerhill", name="Westerhill, Bishopbriggs", developer="Apatura",
        capacity=200, status=None, notes="Green Belt farmland between Bishopbriggs and Lenzie. APRS reports that an EIA is required."),
    "Haspielaw": dict(id="haspielaw", name="Haspielaw, Hamilton", developer="Apatura",
        capacity=None, status=None, notes="Green Belt farmland south-west of Hamilton. APRS reports that the capacity is not given in the planning documents and that an EIA is required."),
    "Ochiltree": dict(id="ochiltree", name="Ochiltree (Killoch), East Ayrshire", developer="Apatura",
        capacity=200, status=None, notes="Farmland next to the former Killoch Colliery, near Cumnock. APRS reports that an EIA is required."),
    "Duns": dict(id="duns", name="Duns, Scottish Borders", developer=None,
        capacity=220, status=None, notes="Farmland and moorland near Duns."),
    "Dunbar": dict(id="dunbar", name="Dunbar, East Lothian", developer="Thistle Sands Data Ltd",
        capacity=None, status=None, area_ha=60.2, notes="Grade 2 agricultural land along the southern edge of Dunbar. APRS reports that the capacity is not stated."),
    "Data vita, Fortis": dict(id="data-vita-fortis", name="Data Vita (Fortis), Chapelhall", developer="Data Vita",
        capacity=40, status=None, notes="Extension of an existing data centre; APRS reports an existing connection of about 24 MW rising to 40 MW, within the proposed North Lanarkshire AI Growth Zone."),
    "Data Vita, South Lanridge": dict(id="data-vita-south-lanridge", name="Data Vita, South Lanridge", developer="Data Vita",
        capacity=None, status="pre-application", notes="Green Belt land across the M8 from Chapelhall; APRS describes it as the main site of the proposed AI Growth Zone (about 500 MW across the zone)."),
    "Irvine": dict(id="irvine-i3", name="Irvine (i3 Business Park)", developer="AI Pathfinder",
        capacity=1000, status=None, location_precision="approximate", notes="APRS reports the site is not yet in planning and the pin is an approximate location within the i3 Business Park."),
    "Cockenzie": dict(id="cockenzie", name="Cockenzie, East Lothian", developer=None,
        capacity=None, status=None, notes="Former coal stores of the dismantled Cockenzie power station. APRS reports it is not yet in planning; East Lothian Council has chosen a preferred supplier."),
    "Chapelcross": dict(id="chapelcross", name="Chapelcross, Annan", developer="CX Power",
        capacity=1000, status="application lodged", area_ha=57, notes="Land north of the former Chapelcross nuclear site. APRS reports the planning application was validated on 28 September 2026, with an EIA."),
    "Greenock": dict(id="greenock", name="Greenock, Inverclyde", developer=None,
        capacity=None, status=None, notes="APRS's map gives a location and a link only."),
    "Larbert": dict(id="larbert", name="Glenbervie, Larbert", developer="Apatura",
        capacity=300, status="application lodged", notes="Glenbervie industrial estate; previously proposed at Plean. APRS reports a full planning application has been submitted."),
    "Blackdog Aberdeen": dict(id="blackdog", name="Blackdog, Aberdeenshire", developer=None,
        capacity=600, status=None, notes="Edge of the dune system on a former MOD firing range. APRS reports 600 MW initially, scaling to multiple gigawatts, and an existing planning permission in principle for mixed 'town centre' use."),
    "Apatura Plean": dict(id="plean", name="Plean (grid connection for Larbert)", developer="Apatura",
        capacity=None, status=None, role="related infrastructure", grid_mw=400,
        notes="Earlier proposed data-centre site. APRS reports a 400 MW grid connection to a battery storage scheme here, from which the Larbert data centre would draw power."),
    "Data Vita Lancaster Road AI Growth zone site": dict(id="data-vita-lancaster-road", name="Data Vita, Lancaster Road, Chapelhall", developer="Data Vita",
        capacity=None, status="pre-application", notes="Green Belt land about 500 m from the existing Data Vita site; part of the proposed AI Growth Zone."),
    "Hunterston Data Centre": dict(id="hunterston", name="Hunterston, North Ayrshire", developer="Eneus Energy Limited",
        capacity=None, status="pre-application", buildings_ha=30, notes="Grade 3 agricultural land north of West Kilbride, next to Hunterston power station. APRS reports an EIA scoping report was submitted in February 2026; capacity is not stated."),
    "Clydebridge Data Centre": dict(id="clydebridge", name="Clydebridge, Cambuslang", developer=None,
        capacity=None, status=None, grid_mw=360, notes="Former steelworks site, not yet in planning. APRS reports a 360 MW connection listed on the NESO register as 'Clydebridge DC'."),
}


def bbox_around(lon, lat, width_km=WIDTH_KM, height_km=HEIGHT_KM):
    d_lat = height_km / 2 / 111.32
    d_lon = width_km / 2 / 111.32 / math.cos(math.radians(lat))
    r = lambda v: round(v, 5)  # noqa: E731
    return {"min_lat": r(lat - d_lat), "max_lat": r(lat + d_lat),
            "min_lon": r(lon - d_lon), "max_lon": r(lon + d_lon)}


def main(kml_path, la_path):
    ns = {"k": "http://www.opengis.net/kml/2.2"}
    root = ET.parse(kml_path).getroot()
    las = json.loads(Path(la_path).read_text())
    index = []
    seen = set()
    for pm in root.findall(".//k:Placemark", ns):
        kname = pm.find("k:name", ns).text.strip()
        f = FACTS[kname]                      # KeyError = a new pin: add it to FACTS by hand
        lon, lat = (float(v) for v in pm.find(".//k:coordinates", ns).text.strip().split(",")[:2])
        link = next((d.find("k:value", ns).text for d in pm.findall(".//k:Data", ns)
                     if d.get("name") == "Link" and d.find("k:value", ns) is not None), None)
        if link and not re.match(r"https?://", link):
            link = None if "no link" in link.lower() else "https://" + link
        la = las.get(kname) or las.get(kname + " ") or {}
        authority = la.get("county") or la.get("city")
        sources = [{"title": "APRS map of proposed data centres in Scotland", "publisher": "APRS",
                    "url": MAP_URL, "accessed": ACCESSED}]
        if link:
            sources.append({"title": f"APRS page: {f['name']}", "publisher": "APRS", "url": link,
                            "accessed": None})
        props = {
            "id": f["id"], "name": f["name"],
            "site_role": f.get("role", "data centre"),
            "developer": f["developer"],
            "local_authority": authority,
            "local_authority_source": "OpenStreetMap boundaries (Nominatim reverse lookup)",
            "status": f["status"],
            "planning_refs": [],
            "stated_capacity_mw": f["capacity"],
            "grid_connection_mw": f.get("grid_mw"),
            "stated_height_m": None,
            "stated_floor_area_m2": None,
            "stated_site_area_ha": f.get("area_ha"),
            "stated_building_area_ha": f.get("buildings_ha"),
            "footprint_precision": None,
            "massing_source": None,
            "location": [round(lon, 6), round(lat, 6)],
            "location_precision": f.get("location_precision", "pin on APRS map"),
            "reported_by": "APRS",
            "verification": "Figures as reported by APRS; not yet checked against planning documents.",
            "sources": sources,
            "last_verified": None,
            "licence": "CC-BY-4.0",
            "notes": f["notes"],
            "model_bbox": bbox_around(lon, lat),
            "model_bbox_note": (f"{WIDTH_KM:g} × {HEIGHT_KM:g} km (east–west × north–south) centred on the APRS pin; "
                                "a modelling extent, not a site boundary."),
        }
        path = SITES / f"{f['id']}.geojson"
        if f["id"] == "auchtertool-cato":
            # JC's Mossmorran/Auchtertool study area is kept as a wider
            # alternative.  It does not contain APRS's pin (which lies ~300 m
            # north of it), so the default extent is centred on the pin.
            props["model_bbox_wide"] = {"min_lat": 56.09158, "max_lat": 56.10642,
                                        "min_lon": -3.30543, "max_lon": -3.24569}
            props["model_bbox_wide_note"] = ("Study area of JC's Mossmorran/Auchtertool terrain build "
                                             "(Nov 2026), taking in the Mossmorran plant.")
        feat = {"type": "Feature", "geometry": None, "properties": props}
        path.write_text(json.dumps(feat, indent=2, ensure_ascii=False) + "\n")
        assert f["id"] not in seen; seen.add(f["id"])
        index.append({"id": f["id"], "name": f["name"], "local_authority": authority,
                      "status": f["status"], "site_role": props["site_role"],
                      "file": path.name})
    old_idx = json.loads((SITES / "index.json").read_text())
    bundles = {s["id"]: s for s in old_idx["sites"]}
    for s in index:
        b = bundles.get(s["id"], {})
        for k in ("bundle", "bundle_fetched"):
            if k in b:
                s[k] = b[k]
    index.sort(key=lambda s: (s["local_authority"] or "", s["name"]))
    (SITES / "index.json").write_text(json.dumps(
        {"schema": "hyperscale-landscapes/sites-index@1", "sites": index},
        indent=2, ensure_ascii=False) + "\n")
    print(f"Wrote {len(index)} sites")


if __name__ == "__main__":
    main(*sys.argv[1:3])
