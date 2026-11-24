"""Bake a curated site's browser bundle (PLAN.md §11).

The bundle holds the raw Overpass response for the shared web query
(data/overpass/web.ql) and the site's elevation, so the web app can build
the site without contacting any third-party service. Elevation is the
Scottish LiDAR terrain model at 4 m (gaps filled from Copernicus 30 m and
recorded); if LiDAR is unavailable, the Terrarium tiles are bundled instead.

    python -m hyperscale_landscapes.bake auchtertool-cato
"""
from __future__ import annotations

import base64
import gzip
import json
import math
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


def tiles_for(bb, z=ZOOM):
    def x(lon): return (lon + 180) / 360 * 2 ** z
    def y(lat):
        r = math.radians(lat)
        return (1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * 2 ** z
    for ty in range(int(y(bb["max_lat"])), int(y(bb["min_lat"])) + 1):
        for tx in range(int(x(bb["min_lon"])), int(x(bb["max_lon"])) + 1):
            yield z, tx, ty


def bake(site_id: str) -> dict:
    sites = data_dir() / "sites"
    site = json.loads((sites / f"{site_id}.geojson").read_text())
    bb = site["properties"]["model_bbox"]
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
    bundle = {"schema": "hyperscale-landscapes/site-bundle@2", "site": site_id,
              "query": "web-v2", "fetched": time.strftime("%Y-%m-%d"),
              "bbox": bb,   # the app ignores a bundle whose area differs from the site's
              "attribution": f"© OpenStreetMap contributors; {elev_attr}",
              "osm": osm, "elevation": elevation}
    out = sites / f"{site_id}.bundle.json.gz"
    data = gzip.compress(json.dumps(bundle, separators=(",", ":")).encode(), 9)
    if len(data) > MAX_BUNDLE_BYTES:
        raise SystemExit(f"Bundle is {len(data)/1e6:.1f} MB, over the 5 MB repository limit")
    out.write_bytes(data)
    idx_path = sites / "index.json"
    idx = json.loads(idx_path.read_text())
    for s in idx["sites"]:
        if s["id"] == site_id:
            s["bundle"] = out.name
            s["bundle_fetched"] = bundle["fetched"]
    idx_path.write_text(json.dumps(idx, indent=2, ensure_ascii=False) + "\n")
    return {"file": str(out), "bytes": len(data), "elevation": lidar["source"] if lidar else "terrarium",
            "gap": lidar["gap_fraction"] if lidar else None, "elements": len(osm.get("elements", []))}


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
    for sid in sys.argv[1:] or ["auchtertool-cato"]:
        print(bake(sid))
