"""Woodland type data for tree symbols, clipped to a site and cached.

  * National Forest Inventory Scotland 2025 (Forestry Commission, OGL): the
    interpreted forest type of each woodland polygon (IFT_IOA).
  * Native Woodland Survey of Scotland (Scottish Forestry, OGL v3): native,
    nearly-native and PAWS woods, with each wood's species proportions from
    the Species Structures table (SP_STR_PCT, per species and structure).
  * OpenStreetMap individual trees (natural=tree) with genus, species or
    leaf_type (ODbL), taken from the site's own OSM data (the shared feature
    query baked into each bundle), not fetched here.

All three are read through public services: ArcGIS FeatureServers (paged
REST queries, output on the National Grid) and Overpass.
"""
from __future__ import annotations

import json
import logging
import time
import urllib.parse
import urllib.request
from pathlib import Path

from . import BBox, DEFAULT_CACHE, USER_AGENT, require_online

log = logging.getLogger(__name__)

NFI_URL = ("https://services2.arcgis.com/mHXjwgl3OARRqqD4/arcgis/rest/services/"
           "National_Forest_Inventory_Scotland_2025/FeatureServer/0")
NWSS_URL = ("https://services9.arcgis.com/RCPJF8Z8BrfjscvL/arcgis/rest/services/"
            "Native_Woodland_Survey_of_Scotland/FeatureServer/0")
NWSS_SPECIES_URL = ("https://services9.arcgis.com/RCPJF8Z8BrfjscvL/arcgis/rest/services/"
                    "NWSS_Species_Structures/FeatureServer/0")
CACHE_VERSION = "v1"
MAX_AGE_S = 90 * 24 * 3600


def _get(url: str, params: dict) -> dict:
    require_online(f"woodland data ({url.split('/services/')[1].split('/')[0]})")
    q = url + "/query?" + urllib.parse.urlencode(params)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(q, headers={"User-Agent": USER_AGENT}), timeout=120) as r:
                d = json.loads(r.read())
            if "error" in d:
                raise RuntimeError(d["error"])
            return d
        except Exception as e:
            if attempt == 3:
                raise
            log.warning("woodland query failed (%s); retrying", e)
            time.sleep(3 * (attempt + 1))


def _features_in_bbox(url: str, bb: BBox, fields: str) -> list[dict]:
    """Every polygon intersecting the bbox, as GeoJSON features on EPSG:27700."""
    out, offset = [], 0
    while True:
        d = _get(url, {"where": "1=1", "geometry": f"{bb.min_lon},{bb.min_lat},{bb.max_lon},{bb.max_lat}",
                       "geometryType": "esriGeometryEnvelope", "inSR": 4326, "spatialRel": "esriSpatialRelIntersects",
                       "outFields": fields, "outSR": 27700, "f": "geojson", "resultOffset": offset,
                       "resultRecordCount": 1000})
        feats = d.get("features", [])
        out += feats
        if len(feats) < 1000 and not d.get("properties", {}).get("exceededTransferLimit") and not d.get("exceededTransferLimit"):
            return out
        offset += len(feats)


def _nwss_species(ids: list[int]) -> list[dict]:
    rows = []
    for i in range(0, len(ids), 150):
        chunk = ids[i:i + 150]
        d = _get(NWSS_SPECIES_URL, {"where": f"SCPTDATA_I IN ({','.join(map(str, chunk))})",
                                    "outFields": "SCPTDATA_I,SPECIES,STRUCTURE,SP_STR_PCT,STOCKING",
                                    "returnGeometry": "false", "f": "json", "resultRecordCount": 4000})
        rows += [f["attributes"] for f in d.get("features", [])]
    return rows


def osm_trees(elements: list) -> list[dict]:
    """Individual OSM trees with a usable type tag, from Overpass elements."""
    els = [e for e in elements if e.get("type") == "node" and e.get("tags", {}).get("natural") == "tree"]
    keep = ("genus", "species", "species:en", "leaf_type", "leaf_cycle", "taxon")
    return [{"lon": e["lon"], "lat": e["lat"], "tags": {k: v for k, v in e.get("tags", {}).items() if k in keep}}
            for e in els if any(k in e.get("tags", {}) for k in keep)]


def fetch(bb: dict, cache_dir: Path = DEFAULT_CACHE, force: bool = False, osm_elements: list | None = None) -> dict:
    """{"nfi": [features], "nwss": [features], "nwss_species": [rows], "osm_trees": [...], "fetched": date}.
    OSM trees come from `osm_elements` (the site's own OSM data)."""
    box = BBox(bb["min_lat"], bb["max_lat"], bb["min_lon"], bb["max_lon"])
    path = Path(cache_dir) / "woodland" / (f"woodland_{CACHE_VERSION}_{box.min_lat:.5f}_{box.max_lat:.5f}_"
                                           f"{box.min_lon:.5f}_{box.max_lon:.5f}.json")
    if path.exists() and not force and time.time() - path.stat().st_mtime < MAX_AGE_S:
        out = json.loads(path.read_text())
        out["osm_trees"] = osm_trees(osm_elements or [])
        return out
    nfi = _features_in_bbox(NFI_URL, box, "CATEGORY,IFT_IOA")
    nwss = _features_in_bbox(NWSS_URL, box, "SCPTDATA_I,TYPE,PAWS_SURVY,DOM_HABITA,NATIVE_PCT")
    ids = sorted({f["properties"]["SCPTDATA_I"] for f in nwss if f["properties"].get("SCPTDATA_I")})
    species = _nwss_species(ids) if ids else []
    out = {"nfi": nfi, "nwss": nwss, "nwss_species": species,
           "fetched": time.strftime("%Y-%m-%d"),
           "sources": {"nfi": "National Forest Inventory Scotland 2025", "nwss": "Native Woodland Survey of Scotland",
                       "osm": "OpenStreetMap natural=tree"}}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out))
    out["osm_trees"] = osm_trees(osm_elements or [])
    return out
