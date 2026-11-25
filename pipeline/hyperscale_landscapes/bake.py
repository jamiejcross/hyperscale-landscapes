"""Bake a curated site's browser bundle (PLAN.md §11).

The bundle holds the raw Overpass response for the shared web query
(data/overpass/web.ql) and the site's elevation, so the web app can build
the site without contacting any third-party service. Elevation is the
Scottish LiDAR terrain model at 4 m (gaps filled from Copernicus 30 m and
recorded); if LiDAR is unavailable, the Terrarium tiles are bundled instead.

Schema @3 (25 Nov 2026) adds two optional sections; @2 bundles stay readable
because the app reads only ``osm`` and ``elevation`` and treats the rest as
optional:

  * ``props``: trees (packed binary records, see TREE_RECORD), wind turbines,
    power-line supports and lines, all in the app's local frame (metres east
    and north of the bbox SW corner, equirectangular at the bbox mid-latitude,
    as web/js/geo.js makeProjection), with bearings computed in that frame.
  * ``subsurface``: BGS geology along the walls, boreholes, pits and mine plans
    (providers/subsurface.py), marked ``nonCommercial``.

    python -m hyperscale_landscapes.bake auchtertool-cato
    python -m hyperscale_landscapes.bake --reuse auchtertool-cato   # keep the bundle's OSM and elevation
"""
from __future__ import annotations

import base64
import gzip
import json
import math
import struct
import sys
import time
import urllib.request

import numpy as np

from .paths import data_dir
from .providers import USER_AGENT, BBox, DEFAULT_CACHE, overpass_query
from .providers import elevation as elev_provider
from .provenance import lookup as lookup_source

TERRARIUM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
ZOOM = 14
MAX_BUNDLE_BYTES = 5_000_000
LIDAR_RES_M = 4.0
SCHEMA = "hyperscale-landscapes/site-bundle@3"
M_PER_DEG_LAT = 111_320.0          # as web/js/geo.js
# One tree: x, y (uint16, from the bbox SW corner, in TREE_XY_UNIT), h (uint16 dm),
# archetype (uint8), source (uint8), crown radius (uint8 dm, capped at 25.5 m).
TREE_RECORD = "<HHHBBB"
TREE_FIELDS = ["x", "y", "h_dm", "archetype", "source", "crown_r_dm"]


def tiles_for(bb, z=ZOOM):
    def x(lon): return (lon + 180) / 360 * 2 ** z
    def y(lat):
        r = math.radians(lat)
        return (1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * 2 ** z
    for ty in range(int(y(bb["max_lat"])), int(y(bb["min_lat"])) + 1):
        for tx in range(int(x(bb["min_lon"])), int(x(bb["max_lon"])) + 1):
            yield z, tx, ty


def _write(out, bundle) -> bytes:
    data = gzip.compress(json.dumps(bundle, separators=(",", ":")).encode(), 9)
    if len(data) > MAX_BUNDLE_BYTES:
        raise SystemExit(f"Bundle is {len(data)/1e6:.1f} MB, over the 5 MB repository limit")
    out.write_bytes(data)
    return data


def bake(site_id: str, reuse: bool = False) -> dict:
    """Bake a site's bundle. With reuse=True the existing bundle's OSM data and
    elevation are kept (so the print model is unchanged) and only the @3
    sections are added or refreshed."""
    sites = data_dir() / "sites"
    site = json.loads((sites / f"{site_id}.geojson").read_text())
    bb = site["properties"]["model_bbox"]
    out = sites / f"{site_id}.bundle.json.gz"
    if reuse and out.exists():
        bundle = json.loads(gzip.decompress(out.read_bytes()))
        if bundle.get("bbox") != bb:
            raise SystemExit(f"{site_id}: the bundle's area differs from the site's; rebake without --reuse")
        bundle["schema"] = SCHEMA
        for k in ("props", "subsurface"):
            bundle.pop(k, None)
        lidar = bundle["elevation"].get("lidar")
    else:
        q = (data_dir() / "overpass" / "web.ql").read_text().replace(
            "{{bbox}}", f"{bb['min_lat']},{bb['min_lon']},{bb['max_lat']},{bb['max_lon']}")
        osm = overpass_query(q, timeout=240)
        lidar = lidar_grid(bb)
        elevation, elev_attr = {}, "elevation: Mapzen Terrain Tiles"
        if lidar:
            elevation["lidar"] = lidar
            elev_attr = lidar["attribution"]
        else:
            tiles = {}
            for z, x, y in tiles_for(bb):
                req = urllib.request.Request(TERRARIUM.format(z=z, x=x, y=y), headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=60) as r:
                    tiles[f"{z}/{x}/{y}"] = base64.b64encode(r.read()).decode()
            elevation.update({"zoom": ZOOM, "tiles": tiles})
        bundle = {"schema": SCHEMA, "site": site_id,
                  "query": "web-v2", "fetched": time.strftime("%Y-%m-%d"),
                  "bbox": bb,   # the app ignores a bundle whose area differs from the site's
                  "attribution": f"© OpenStreetMap contributors; {elev_attr}",
                  "osm": osm, "elevation": elevation}
        _write(out, bundle)     # trees and structures read the site's OSM from the bundle on disk
    base_bytes = len(gzip.compress(json.dumps(bundle, separators=(",", ":")).encode(), 9))
    bundle["props"] = props_section(site_id, site, bb, bundle["osm"]["elements"])
    bundle["subsurface"] = subsurface_section(site, bb)
    data = _write(out, bundle)
    idx_path = sites / "index.json"
    idx = json.loads(idx_path.read_text())
    for s in idx["sites"]:
        if s["id"] == site_id:
            s["bundle"] = out.name
            s["bundle_fetched"] = bundle["fetched"]
    idx_path.write_text(json.dumps(idx, indent=2, ensure_ascii=False) + "\n")
    return {"file": str(out), "bytes": len(data), "added_bytes": len(data) - base_bytes,
            "trees": bundle["props"]["trees"]["count"], "turbines": len(bundle["props"]["turbines"]),
            "supports": len(bundle["props"]["supports"]), "elevation": lidar["source"] if lidar else "terrarium",
            "elements": len(bundle["osm"].get("elements", []))}


# ---------------------------------------------------------------- @3 sections

def app_projection(bb: dict):
    """The web app's local frame (web/js/geo.js makeProjection)."""
    mlon = M_PER_DEG_LAT * math.cos(math.radians((bb["min_lat"] + bb["max_lat"]) / 2))
    to_xy = lambda lon, lat: ((lon - bb["min_lon"]) * mlon, (lat - bb["min_lat"]) * M_PER_DEG_LAT)
    return to_xy, (bb["max_lon"] - bb["min_lon"]) * mlon, (bb["max_lat"] - bb["min_lat"]) * M_PER_DEG_LAT


def encode_trees(x, y, h, crown_r, archetype, source, width_m: float, height_m: float) -> dict:
    """Pack trees (app-frame metres) into TREE_RECORD structs, base64. Decimetres
    when the site fits in a uint16 (6.55 km), else a 0.5 m grid."""
    unit = 0.1 if max(width_m, height_m) <= 65535 * 0.1 else 0.5
    if max(width_m, height_m) > 65535 * unit:
        raise ValueError("site too large for uint16 tree positions")
    order = sorted(range(len(x)), key=lambda i: (round(y[i] / unit), round(x[i] / unit)))
    buf = bytearray()
    for i in order:
        buf += struct.pack(TREE_RECORD, min(65535, max(0, round(x[i] / unit))), min(65535, max(0, round(y[i] / unit))),
                           min(65535, max(0, round(h[i] * 10))), int(archetype[i]), int(source[i]),
                           min(255, max(0, round(crown_r[i] * 10))))
    return {"record": TREE_RECORD, "fields": TREE_FIELDS, "xy_unit_m": unit, "h_unit_m": 0.1,
            "crown_r_unit_m": 0.1, "count": len(x), "data": base64.b64encode(bytes(buf)).decode()}


def decode_trees(t: dict) -> dict:
    raw = base64.b64decode(t["data"])
    rec = list(struct.iter_unpack(t["record"], raw))
    u = t["xy_unit_m"]
    return {"x": [r[0] * u for r in rec], "y": [r[1] * u for r in rec], "h": [r[2] * t["h_unit_m"] for r in rec],
            "archetype": [r[3] for r in rec], "source": [r[4] for r in rec],
            "crown_r": [r[5] * t["crown_r_unit_m"] for r in rec]}


def props_section(site_id: str, site: dict, bb: dict, elements: list) -> dict:
    from pyproj import Transformer
    from . import structures, trees

    to_xy, W, H = app_projection(bb)
    r1 = lambda v: round(v, 1)
    t = trees.typed_for_site(site_id)
    lon, lat = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True).transform(t["x"], t["y"])
    xs, ys, keep = [], [], []
    for i, (a, b) in enumerate(zip(lon, lat)):
        px, py = to_xy(a, b)
        if 0 <= px <= W and 0 <= py <= H:
            xs.append(px); ys.append(py); keep.append(i)
    tr = encode_trees(xs, ys, [float(t["h"][i]) for i in keep], [float(t["crown_r"][i]) for i in keep],
                      [int(t["archetype"][i]) for i in keep], [int(t["source"][i]) for i in keep], W, H)
    chm = {k: t["chm"].get(k) for k in ("dtm_programmes", "dsm_programmes", "dsm_years", "pct_lidar",
                                         "pct_fallback", "pct_no_data", "fallback_dates", "canopy_over_5m_ha")}
    tr.update({"origin": {"lon": bb["min_lon"], "lat": bb["min_lat"], "frame": "web/js/geo.js makeProjection"},
               "archetypes": trees.ARCHETYPES, "sources": trees.SOURCES,
               "thin_cell_m": t["summary"]["thin_cell_m"], "detected": t["summary"]["detected"],
               "capped": t["summary"]["capped"], "chm": chm, "height_m": t["height_m"],
               "typing": {k: t["typing"][k] for k in ("by_archetype", "by_source", "woodland_fetched", "sources",
                                                      "dropped_felled")}})
    s = structures.extract(elements, to_xy, site["properties"].get("turbines"))
    turbines = [{"x": r1(to_xy(o["lon"], o["lat"])[0]), "y": r1(to_xy(o["lon"], o["lat"])[1]),
                 "hub_height": o["hub_height"], "rotor_diameter": o["rotor_diameter"], "source": o["source"],
                 "facing": o["facing"], "facing_source": o["facing_source"], "osm": o["osm"]} for o in s["turbines"]]
    supports = [{"x": r1(to_xy(o["lon"], o["lat"])[0]), "y": r1(to_xy(o["lon"], o["lat"])[1]),
                 "kind": o["kind"], "voltage_kv": o["voltage_kv"], "height": o["height"],
                 "height_source": o["height_source"], "bearing": o["bearing"], "osm": o["osm"]} for o in s["supports"]]
    lines = [{"kind": o["kind"], "voltage_kv": o["voltage_kv"], "osm": o["osm"],
              "xy": [[r1(v) for v in to_xy(*c)] for c in o["coords"]]} for o in s["lines"]]
    return {"frame": "metres east and north of the bbox SW corner (web/js/geo.js makeProjection)",
            "trees": tr, "turbines": turbines, "supports": supports, "lines": lines,
            "structures_summary": s["summary"], "structures_rules": s["rules"],
        }


def subsurface_section(site: dict, bb: dict) -> dict:
    """The subsurface provider's output, made compact for the browser: no
    per-point lon/lat (recomputable from the bbox and step), boreholes and
    pits in the app frame."""
    from .providers import subsurface
    sub = subsurface.fetch(site)
    to_xy, _, _ = app_projection(bb)
    r1 = lambda v: round(v, 1)
    sides = {s: {k: v for k, v in d.items() if k != "lonlat"} for s, d in sub["walls"]["sides"].items()}
    scan_base = "https://api.bgs.ac.uk/sobi-scans/v1/borehole/scans/items/"
    bores = []
    for b in sub["boreholes"]:
        if b["lon"] is None:
            continue
        x, y = to_xy(b["lon"], b["lat"])
        scan = b.get("scan_url") or ""
        bores.append({"ref": b["ref"], "name": b["name"], "length_m": b["length_m"], "year": b["year"],
                      "x": r1(x), "y": r1(y), "inside": b["inside"],
                      "scan": scan.removeprefix(scan_base) if scan.startswith(scan_base) else (scan or None),
                      "ags": b.get("ags_url")})
    pits = []
    for p in sub["pits"]:
        x, y = to_xy(p["lon"], p["lat"])
        pits.append({**{k: p[k] for k in ("ref", "name", "status", "class", "plans", "coal_by_stripped_name")},
                     "x": r1(x), "y": r1(y)})
    return {"fetched": sub["fetched"], "walls": {"step_m": sub["walls"]["step_m"], "units": sub["walls"]["units"],
                                                 "sides": sides},
            "boreholes": bores, "borehole_scan_base": scan_base, "pits": pits,
            "nominal_thickness_m": sub["nominal_thickness_m"], "sources": sub["sources"],
            "nonCommercial": True, "attribution": sub["attribution"], "labels": sub["labels"]}


def lidar_grid(bb: dict) -> dict | None:
    """The site's LiDAR terrain as a compact grid for the browser: decimetres
    as int16, delta-coded along each row (it gzips to a fraction of raw).
    Row 0 is the north edge; the grid spans the bbox exactly. None if LiDAR
    is unavailable for this area."""
    box = BBox(bb["min_lat"], bb["max_lat"], bb["min_lon"], bb["max_lon"])
    try:
        r = elev_provider.fetch(box, DEFAULT_CACHE, prefer="lidar")
    except Exception as e:     # noqa: BLE001 - any failure means "use Terrarium"
        print(f"  LiDAR unavailable ({e}); bundling Terrarium tiles", file=sys.stderr)
        return None
    z = r.data["elev"].astype(np.float64)
    k = max(1, round(LIDAR_RES_M / r.metadata.get("resolution_m", 2.0)))
    h, w = (z.shape[0] // k) * k, (z.shape[1] // k) * k
    z = z[:h, :w].reshape(h // k, k, w // k, k).mean(axis=(1, 3))
    dm = np.round(z * 10).astype(np.int32)
    delta = np.diff(dm, axis=1, prepend=0).astype(np.int16)
    attribution = lookup_source(r.source)["attribution"]
    gap, gap_src = r.metadata.get("gap_fraction") or 0, r.metadata.get("gap_fill_source")
    if gap and gap_src:     # name the fill source too, with its share of the area
        attribution += f"; {100 * gap:.1f}% of the area, with no LiDAR survey, from " + lookup_source(gap_src)["attribution"].removeprefix("Elevation: ")
    return {"format": "int16-dm-rowdelta", "w": int(dm.shape[1]), "h": int(dm.shape[0]),
            "res_m": LIDAR_RES_M, "data": base64.b64encode(delta.tobytes()).decode(),
            "source": r.source, "programmes": r.metadata.get("programmes"),
            "gap_fraction": gap, "gap_fill_source": gap_src, "attribution": attribution}


if __name__ == "__main__":
    args = sys.argv[1:]
    reuse = "--reuse" in args
    for sid in [a for a in args if not a.startswith("--")] or ["auchtertool-cato"]:
        print(bake(sid, reuse=reuse), flush=True)
