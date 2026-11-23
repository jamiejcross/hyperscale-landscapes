"""Inland water provider: OSM Overpass.

Returns dict {"waterways": [...], "water_polys": [...]}
Sea/ocean handled by coastline provider, NOT here.
"""

import json
import logging
from pathlib import Path

from . import BBox, ProviderResult, DEFAULT_CACHE, overpass_query

log = logging.getLogger(__name__)

DEFAULT_WATERWAY_WIDTHS = {"river": 30, "canal": 15, "stream": 4}


def _coords_close(a, b, tol=1e-6):
    return abs(a[0] - b[0]) < tol and abs(a[1] - b[1]) < tol


def _merge_way_segments(segments):
    """Merge way segments that share endpoints into closed rings."""
    if not segments:
        return []
    chains = [list(s) for s in segments]
    merged = True
    while merged:
        merged = False
        i = 0
        while i < len(chains):
            j = i + 1
            while j < len(chains):
                ci, cj = chains[i], chains[j]
                connected = None
                if _coords_close(ci[-1], cj[0]):
                    connected = ci + cj[1:]
                elif _coords_close(ci[-1], cj[-1]):
                    connected = ci + list(reversed(cj))[1:]
                elif _coords_close(ci[0], cj[-1]):
                    connected = cj + ci[1:]
                elif _coords_close(ci[0], cj[0]):
                    connected = list(reversed(cj)) + ci[1:]
                if connected:
                    chains[i] = connected
                    chains.pop(j)
                    merged = True
                else:
                    j += 1
            i += 1
    result = []
    for c in chains:
        if len(c) >= 4 and _coords_close(c[0], c[-1]):
            result.append(c)
    return result


def _fetch_osm_water(bbox: BBox, cache_dir: Path) -> dict:
    """Fetch waterways and water polygons from OSM Overpass."""
    cache_file = cache_dir / (
        f"osm_water_{bbox.min_lat:.4f}_{bbox.max_lat:.4f}"
        f"_{bbox.min_lon:.4f}_{bbox.max_lon:.4f}.json"
    )

    if cache_file.exists():
        log.info("Using cached OSM water")
        with open(cache_file) as f:
            return json.load(f)

    bbox_str = f"{bbox.min_lat},{bbox.min_lon},{bbox.max_lat},{bbox.max_lon}"
    query = f"""
    [out:json][timeout:120];
    (
      way["waterway"~"^(river|canal|stream)$"]({bbox_str});
      way["natural"="water"]({bbox_str});
      way["water"]({bbox_str});
      way["waterway"="riverbank"]({bbox_str});
      way["natural"="wetland"]["tidal"="yes"]({bbox_str});
      way["natural"="mud"]({bbox_str});
      relation["natural"="water"]({bbox_str});
      relation["water"]({bbox_str});
      relation["waterway"="riverbank"]({bbox_str});
    );
    (._;>;);
    out body;
    """

    raw_result = overpass_query(query)

    # Build node lookup
    nodes = {}
    for el in raw_result.get("elements", []):
        if el["type"] == "node":
            nodes[el["id"]] = (el["lon"], el["lat"])

    # Track way coords for relation assembly
    way_coords = {}

    waterways = []
    water_polys = []
    tidal_polys = []

    for el in raw_result.get("elements", []):
        if el["type"] != "way":
            continue
        tags = el.get("tags", {})
        coords = [nodes[nid] for nid in el.get("nodes", []) if nid in nodes]
        if len(coords) < 2:
            continue

        way_coords[el["id"]] = coords

        # Waterway linestrings (rivers, canals, streams)
        wt = tags.get("waterway")
        if wt in ("river", "canal", "stream"):
            w_m = DEFAULT_WATERWAY_WIDTHS[wt]
            if "width" in tags:
                try:
                    w_m = float(tags["width"].replace("m", "").strip())
                except (ValueError, AttributeError):
                    pass
            waterways.append({"coords": coords, "width": w_m, "type": wt})

        # Tidal areas (wetland+tidal, mud flats) — treated as sea
        is_tidal = (tags.get("tidal") == "yes" or
                    tags.get("natural") == "mud")
        if is_tidal and len(coords) >= 4:
            tc = list(coords)
            if tc[0] != tc[-1]:
                tc.append(tc[0])
            tidal_polys.append({"coords": tc})

        # Water area polygons
        is_area = (tags.get("natural") == "water" or
                   tags.get("waterway") == "riverbank" or
                   "water" in tags)
        if is_area and len(coords) >= 4:
            c = list(coords)
            if c[0] != c[-1]:
                c.append(c[0])
            water_polys.append({"coords": c})

    # Assemble relation water polygons
    for el in raw_result.get("elements", []):
        if el["type"] != "relation":
            continue
        tags = el.get("tags", {})
        is_water = (tags.get("natural") == "water" or
                    tags.get("water") is not None or
                    tags.get("waterway") == "riverbank")
        if not is_water:
            continue

        outers = []
        for m in el.get("members", []):
            if m.get("type") == "way" and m.get("role", "outer") in ("outer", ""):
                wc = way_coords.get(m["ref"])
                if wc and len(wc) >= 2:
                    outers.append(wc)

        merged = _merge_way_segments(outers)
        for ring_coords in merged:
            if len(ring_coords) >= 4:
                c = list(ring_coords)
                if c[0] != c[-1]:
                    c.append(c[0])
                water_polys.append({"coords": c})

    log.info("OSM water: %d waterways, %d water polygons, %d tidal polygons",
             len(waterways), len(water_polys), len(tidal_polys))

    result = {"waterways": waterways, "water_polys": water_polys, "tidal_polys": tidal_polys}
    with open(cache_file, "w") as f:
        json.dump(result, f)

    return result


# ---------------------------------------------------------------------------
# Public interface
# ---------------------------------------------------------------------------

def fetch(bbox: BBox, cache_dir: Path = DEFAULT_CACHE, **kwargs) -> ProviderResult:
    """Fetch inland waterways and water polygons for bbox from OSM.

    Returns ProviderResult where:
      .data = {"waterways": [...], "water_polys": [...]}
      .source = "osm-overpass"
    """
    cache = Path(cache_dir) / "water"
    cache.mkdir(parents=True, exist_ok=True)

    water = _fetch_osm_water(bbox, cache)

    return ProviderResult(
        data=water,
        source="osm-overpass",
        cached=False,
        metadata={
            "waterway_count": len(water["waterways"]),
            "water_poly_count": len(water["water_polys"]),
            "tidal_poly_count": len(water.get("tidal_polys", [])),
        },
    )
