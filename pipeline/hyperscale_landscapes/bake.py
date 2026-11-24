"""Bake a curated site's browser bundle (PLAN.md §11).

The bundle holds the raw Overpass response for the shared web query
(data/overpass/web.ql) and the Terrarium elevation tiles covering the
site's model_bbox, so the web app can build the site without contacting
any third-party service.

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

from .paths import data_dir
from .providers import USER_AGENT, overpass_query

TERRARIUM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
ZOOM = 14
MAX_BUNDLE_BYTES = 5_000_000


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
    tiles = {}
    for z, x, y in tiles_for(bb):
        req = urllib.request.Request(TERRARIUM.format(z=z, x=x, y=y), headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=60) as r:
            tiles[f"{z}/{x}/{y}"] = base64.b64encode(r.read()).decode()
    bundle = {"schema": "hyperscale-landscapes/site-bundle@1", "site": site_id,
              "query": "web-v2", "fetched": time.strftime("%Y-%m-%d"),
              "attribution": "© OpenStreetMap contributors; elevation: Mapzen Terrain Tiles",
              "osm": osm, "elevation": {"zoom": ZOOM, "tiles": tiles}}
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
    return {"file": str(out), "bytes": len(data), "tiles": len(tiles),
            "elements": len(osm.get("elements", []))}


if __name__ == "__main__":
    for sid in sys.argv[1:] or ["auchtertool-cato"]:
        print(bake(sid))
