"""Pylons, poles, overhead lines and wind turbines for the 3D view.

Positions, voltages and any stated dimensions come from OpenStreetMap. Where
a dimension is missing it is filled from the defaults below and labelled
"assumed", with the rule and its source, so the caption and manifest can say
how many sizes were assumed. Nothing here touches the print files: on the
printed model, supports and turbines stay as pegs.
"""
from __future__ import annotations

import math
import re

# ---------------------------------------------------------------------------
# Support heights when OSM has no height tag. Values are typical heights of
# the common British designs, taken from Telcontar's table of British
# pylon series (telcontar.net/Power/pylons/series, read 25 Nov 2026), which
# gives line-tower heights per design and voltage; checked against National
# Grid ("A 400,000 volt lattice pylon is typically up to 50-metres high").
# ---------------------------------------------------------------------------
SUPPORT_DEFAULTS = [
    # (structure, from kV, height m, source note)
    ("tower", 275.1, 46.5, "400 kV lattice tower: L12 standard height 46.5 m (400 kV designs 41.6-50.5 m; "
                           "Telcontar series table)"),
    ("tower", 200, 36.9, "275 kV lattice tower: L3 (Blaw Knox D) 36.9 m (275 kV designs 25.2-41.6 m; Telcontar)"),
    ("tower", 100, 24.2, "132 kV lattice tower: Scottish double-circuit 24.2 m (Rannoch-Abernethy, SS-PL1; "
                         "132 kV designs 20.2-26.9 m; Telcontar)"),
    ("tower", 0, 20.3, "66 kV and lower lattice tower: Milliken L134 20.3 m (Telcontar)"),
    ("pole", 100, 15.0, "132 kV wood pole (trident): no published typical height found; 15 m assumed, to verify"),
    ("pole", 0, 10.0, "11-33 kV wood pole: no published typical height found; 10 m assumed, to verify"),
]
UNKNOWN_VOLTAGE_TOWER_M = (24.2, "voltage not tagged: 132 kV tower height assumed (24.2 m)")

# Wind turbines: OSM tags, then a per-site curated override (planning
# documents), then these defaults, marked assumed.
TURBINE_DEFAULTS = {"hub_height": 80.0, "rotor_diameter": 90.0}
PREVAILING_WIND_DEG = 225.0         # rotor faces south-west unless OSM gives a direction


def metres(v) -> float | None:
    """'52 m', '52', '170 ft' -> metres; None if unparsable."""
    if v is None:
        return None
    m = re.match(r"\s*([0-9]+(?:\.[0-9]+)?)\s*(m|ft|')?\s*$", str(v))
    if not m:
        return None
    x = float(m.group(1))
    return round(x * 0.3048, 2) if m.group(2) in ("ft", "'") else x


def kilovolts(v) -> float | None:
    try:
        return max(float(x) for x in str(v).split(";") if x.strip()) / 1000
    except (ValueError, TypeError):
        return None


def bearing(p, q) -> float:
    """Compass bearing (degrees clockwise from north) from p to q, (x east, y north)."""
    return (math.degrees(math.atan2(q[0] - p[0], q[1] - p[1])) + 360) % 360


def bisector(b_in: float, b_out: float) -> float:
    """Mean direction of two bearings (the line's direction through a support)."""
    x = math.sin(math.radians(b_in)) + math.sin(math.radians(b_out))
    y = math.cos(math.radians(b_in)) + math.cos(math.radians(b_out))
    if abs(x) < 1e-9 and abs(y) < 1e-9:       # the line doubles back: keep the incoming direction
        return b_in
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def support_height(kind: str, tags: dict, kv: float | None):
    """(height m, source, rule) for a tower/pole/portal."""
    h = metres(tags.get("height"))
    if h:
        return h, "osm", "OSM height tag"
    structure = "pole" if kind == "pole" else "tower"
    if kv is None and structure == "tower":
        return UNKNOWN_VOLTAGE_TOWER_M[0], "assumed", UNKNOWN_VOLTAGE_TOWER_M[1]
    for s, lo, hm, note in SUPPORT_DEFAULTS:
        if s == structure and (kv or 0) >= lo:
            return hm, "assumed", note
    return SUPPORT_DEFAULTS[-1][2], "assumed", SUPPORT_DEFAULTS[-1][3]


def turbine_dims(tags: dict, override: dict | None):
    """{hub_height, rotor_diameter, source per dimension}.

    OSM: height:hub is the hub height; plain height is the TOTAL height to
    the blade tip (OSM wiki, Key:generator), so with rotor:diameter it gives
    hub = height - diameter/2 ("osm-derived")."""
    out, src = {}, {}
    rotor = metres(tags.get("rotor:diameter"))
    hub = metres(tags.get("height:hub")) or metres(tags.get("hub_height"))
    hub_src = "osm" if hub else None
    tip = metres(tags.get("height"))
    if not hub and tip and rotor and tip > rotor / 2:
        hub, hub_src = round(tip - rotor / 2, 1), "osm-derived"
    osm = {"hub_height": (hub, hub_src), "rotor_diameter": (rotor, "osm" if rotor else None)}
    for k in ("hub_height", "rotor_diameter"):
        if osm[k][0]:
            out[k], src[k] = osm[k][0], osm[k][1]
        elif override and override.get(k):
            out[k], src[k] = float(override[k]), "curated"
        else:
            out[k], src[k] = TURBINE_DEFAULTS[k], "assumed"
    out["source"] = src
    if override and any(v == "curated" for v in src.values()):
        out["curated_source"] = override.get("source")
    return out


def extract(elements: list, to_xy, site_turbines: dict | None = None) -> dict:
    """Supports, lines and turbines from Overpass elements (`out tags geom`).

    to_xy(lon, lat) -> (x, y) in metres on a local grid (used for bearings).
    """
    # Lines, with their vertices; supports are matched to line vertices by position.
    lines = []
    vertex_lines: dict = {}
    for e in elements:
        t = e.get("tags", {})
        if e.get("type") != "way" or t.get("power") not in ("line", "minor_line") or not e.get("geometry"):
            continue
        pts = [(p["lon"], p["lat"]) for p in e["geometry"] if p]
        if len(pts) < 2:
            continue
        li = len(lines)
        lines.append({"kind": t["power"], "voltage_kv": kilovolts(t.get("voltage")), "name": t.get("name"),
                      "coords": pts, "osm": f"w{e['id']}"})
        for i, p in enumerate(pts):
            vertex_lines.setdefault((round(p[0], 7), round(p[1], 7)), []).append((li, i))

    supports = []
    for e in elements:
        t = e.get("tags", {})
        if e.get("type") != "node" or t.get("power") not in ("tower", "pole", "portal"):
            continue
        key = (round(e["lon"], 7), round(e["lat"], 7))
        on = vertex_lines.get(key, [])
        kv = max((lines[li]["voltage_kv"] or 0 for li, _ in on), default=None) or kilovolts(t.get("voltage"))
        h, hsrc, rule = support_height(t["power"], t, kv)
        brg = None
        if on:
            li, i = max(on, key=lambda o: lines[o[0]]["voltage_kv"] or 0)
            c = lines[li]["coords"]
            xy = lambda k: to_xy(*c[k])
            if 0 < i < len(c) - 1:
                brg = bisector(bearing(xy(i - 1), xy(i)), bearing(xy(i), xy(i + 1)))
            elif len(c) > 1:
                brg = bearing(xy(0), xy(1)) if i == 0 else bearing(xy(i - 1), xy(i))
        supports.append({"lon": e["lon"], "lat": e["lat"], "kind": t["power"],
                         "structure": t.get("structure"), "design": t.get("design"),
                         "voltage_kv": kv, "height": h, "height_source": hsrc, "height_rule": rule,
                         "bearing": None if brg is None else round(brg, 1), "osm": f"n{e['id']}"})

    turbines = []
    for e in elements:
        t = e.get("tags", {})
        if e.get("type") != "node":
            continue
        is_wind = (t.get("power") == "generator" and (t.get("generator:source") == "wind"
                                                       or t.get("generator:method") == "wind_turbine"))
        if not is_wind:
            continue
        d = turbine_dims(t, site_turbines)
        facing = None
        try:
            facing = float(t["direction"]) % 360
        except (KeyError, ValueError):
            pass
        turbines.append({"lon": e["lon"], "lat": e["lat"], **d,
                         "facing": facing if facing is not None else PREVAILING_WIND_DEG,
                         "facing_source": "osm" if facing is not None else "assumed (prevailing wind, south-west)",
                         "output": t.get("generator:output:electricity"), "model": t.get("model"),
                         "manufacturer": t.get("manufacturer"), "osm": f"n{e['id']}"})

    # Summary for the caption and manifest.
    hs = {}
    for s in supports:
        hs[s["height_source"]] = hs.get(s["height_source"], 0) + 1
    ts = {"hub_height": {}, "rotor_diameter": {}}
    for tb in turbines:
        for k in ts:
            v = tb["source"][k]; ts[k][v] = ts[k].get(v, 0) + 1
    assumed_turbines = sum(1 for tb in turbines if "assumed" in tb["source"].values())
    return {"supports": supports, "lines": lines, "turbines": turbines,
            "summary": {"supports": len(supports), "support_height_sources": hs,
                        "towers": sum(s["kind"] in ("tower", "portal") for s in supports),
                        "poles": sum(s["kind"] == "pole" for s in supports),
                        "supports_without_bearing": sum(s["bearing"] is None for s in supports),
                        "lines": len(lines), "turbines": len(turbines), "turbine_dimension_sources": ts,
                        "turbines_with_assumed_size": assumed_turbines},
            "rules": {"support_defaults": [{"structure": s, "from_kv": lo, "height_m": h, "source": n}
                                           for s, lo, h, n in SUPPORT_DEFAULTS],
                      "unknown_voltage_tower": UNKNOWN_VOLTAGE_TOWER_M[1],
                      "turbine_defaults": TURBINE_DEFAULTS,
                      "turbine_precedence": "OSM height:hub (or tip height - rotor radius) and rotor:diameter > site override > default",
                      "bearing": "bisector of the line's incoming and outgoing segments at each support",
                      "facing": f"OSM direction, else {PREVAILING_WIND_DEG:g} degrees (prevailing wind)"}}


def for_site(site_id: str) -> dict:
    import gzip
    import json
    from pyproj import Transformer
    from .paths import data_dir

    site = json.loads((data_dir() / "sites" / f"{site_id}.geojson").read_text())
    bundle = json.loads(gzip.decompress((data_dir() / "sites" / f"{site_id}.bundle.json.gz").read_bytes()))
    tr = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)
    return extract(bundle["osm"]["elements"], tr.transform, site["properties"].get("turbines"))
