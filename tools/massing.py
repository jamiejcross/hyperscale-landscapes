#!/usr/bin/env python3
"""Fold the planning geometry into each site file's properties.massing.

Reads
  data/sites/datacentre-red-lines.geojson  (tools/fetch_council_boundaries.py)
  data/sites/datacentre-sites.geojson      (red lines + buildings and zones from drawings;
                                            tools/georef_drawing.py, and the hand-traced Auchtertool layout)
and writes, per site, into data/sites/<id>.geojson -> properties.massing:

  tier        "plans"      documented building outlines or documented parameter zones
              "indicative" otherwise, where any red line or drawn building exists
  red_line    the council-mapped application boundary (first application listed for the
              site in tools/datacentre_sources.json), with its source and areas
  other_red_lines  any further council boundaries for the same site
  buildings   building outlines and building-sized areas, each with its own evidence
  zones       parameter zones (drawn as a tint, not a volume)

Only those keys are written. Every other key in massing (hand-entered heights, areas,
sources, notes) is kept as it is. The site's top-level geometry is never touched.

    python tools/massing.py            # write
    python tools/massing.py --check    # report what would change; exit 1 if anything would
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITES = ROOT / "data" / "sites"
SOURCES = ROOT / "tools" / "datacentre_sources.json"

OWNED = ("tier", "red_line", "other_red_lines", "buildings", "zones")
ZONE_KINDS = {"height parameter zone"}
FEATURE_KEYS = ("name", "kind", "evidence", "height_m", "height_min_m", "height_basis",
                "source", "area_m2", "georeference")


def tier_for(buildings: list, zones: list, red_line) -> str | None:
    documented = any(b["evidence"] == "documented" for b in buildings) or \
        any(z["evidence"] == "documented" for z in zones)
    if documented:
        return "plans"
    if buildings or zones or red_line:
        return "indicative"
    return None


def red_line_entry(f: dict, form_area: dict) -> dict:
    p = f["properties"]
    return {
        "ref": p["ref"], "keyVal": p["keyVal"], "evidence": "documented",
        "source": p["source"], "retrieved": p["retrieved"],
        "area_ha": p["area_ha"], "form_area_ha": form_area.get((p["site"], p["ref"])),
        "geometry": f["geometry"],
    }


def drawn_entry(f: dict) -> dict:
    p = f["properties"]
    e = {k: p[k] for k in FEATURE_KEYS if k in p}
    e["geometry"] = f["geometry"]
    return e


def build(red_lines: dict, drawn: dict, sources: dict) -> dict[str, dict]:
    """{site: owned massing keys} for every site that has planning geometry."""
    form_area = {(a["site"], a["ref"]): a.get("form_area_ha") for a in sources["applications"]}
    order = [(a["site"], a["ref"]) for a in sources["applications"]]
    rl_by_site: dict[str, list] = {}
    for f in sorted(red_lines["features"], key=lambda f: order.index((f["properties"]["site"], f["properties"]["ref"]))):
        rl_by_site.setdefault(f["properties"]["site"], []).append(red_line_entry(f, form_area))
    out: dict[str, dict] = {}
    sites = list(dict.fromkeys([s for s, _ in order] + [f["properties"]["site"] for f in drawn["features"]]))
    for site in sites:
        feats = [f for f in drawn["features"]
                 if f["properties"]["site"] == site and f["properties"]["kind"] != "application boundary"]
        for f in feats:
            p = f["properties"]
            if not p.get("evidence") or not p.get("source"):
                raise ValueError(f"{site}: {p.get('name')} has no evidence or source")
        zones = [drawn_entry(f) for f in feats if f["properties"]["kind"] in ZONE_KINDS]
        buildings = [drawn_entry(f) for f in feats if f["properties"]["kind"] not in ZONE_KINDS]
        rls = rl_by_site.get(site, [])
        red_line = rls[0] if rls else None
        out[site] = {"tier": tier_for(buildings, zones, red_line), "red_line": red_line,
                     "other_red_lines": rls[1:], "buildings": buildings, "zones": zones}
    return out


def merge(massing: dict | None, owned: dict) -> dict:
    m = dict(massing or {})
    m.update(owned)
    return m


# Site files are indented JSON; coordinate arrays are written on one line so the
# files stay readable.
_COORDS = re.compile(r'"coordinates": (\[[\s\S]*?\])(?=\n\s*\})')


def dumps_site(obj: dict) -> str:
    s = json.dumps(obj, indent=2, ensure_ascii=False)
    return _COORDS.sub(lambda m: '"coordinates": ' + json.dumps(json.loads(m.group(1)), separators=(",", ":")), s) + "\n"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--check", action="store_true", help="report changes without writing")
    a = ap.parse_args(argv)
    red_lines = json.loads((SITES / "datacentre-red-lines.geojson").read_text())
    drawn = json.loads((SITES / "datacentre-sites.geojson").read_text())
    sources = json.loads(SOURCES.read_text())
    changed = []
    for site, owned in build(red_lines, drawn, sources).items():
        path = SITES / f"{site}.geojson"
        doc = json.loads(path.read_text())
        before = doc["properties"].get("massing")
        doc["properties"]["massing"] = merge(before, owned)
        text = dumps_site(doc)
        if text != path.read_text():
            changed.append(site)
            if not a.check:
                path.write_text(text)
        m = doc["properties"]["massing"]
        print(f"{site:18} tier={m['tier']!s:10} red_line={'yes' if m['red_line'] else 'no ':3} "
              f"buildings={len(m['buildings']):2} zones={len(m['zones'])}")
    print(("would change: " if a.check else "changed: ") + (", ".join(changed) or "nothing"))
    return 1 if (a.check and changed) else 0


if __name__ == "__main__":
    sys.exit(main())
