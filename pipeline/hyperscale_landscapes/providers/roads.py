"""Roads provider: OSM Overpass → Overture Maps transportation fallback.

Returns list of dicts {"coords": [(lon,lat),...], "width": float, "type": str}

Overpass is the primary source (best tagging), with retry rounds across
three mirrors.  If Overpass is down (regular 504s under load), Overture
Maps' transportation theme is queried via DuckDB instead — same S3 access
pattern as the buildings provider.  Overture `class` values match OSM
`highway` values closely enough to reuse the same profiles and widths.
"""

import json
import logging
from pathlib import Path

from . import BBox, ProviderResult, DEFAULT_CACHE, overpass_query

log = logging.getLogger(__name__)

ROAD_TYPES_BY_PROFILE = {
    "major-only":         {"motorway", "trunk", "primary", "secondary", "tertiary",
                           "motorway_link", "trunk_link", "primary_link",
                           "secondary_link", "tertiary_link"},
    "major-residential":  {"motorway", "trunk", "primary", "secondary", "tertiary",
                           "residential", "unclassified", "living_street", "service",
                           "motorway_link", "trunk_link", "primary_link",
                           "secondary_link", "tertiary_link"},
    "all":                {"motorway", "trunk", "primary", "secondary", "tertiary",
                           "residential", "unclassified", "living_street", "service",
                           "pedestrian", "footway", "cycleway", "path",
                           "motorway_link", "trunk_link", "primary_link",
                           "secondary_link", "tertiary_link", "track"},
}

ROAD_WIDTHS = {
    "motorway": 14, "motorway_link": 8, "trunk": 12, "trunk_link": 7,
    "primary": 10, "primary_link": 6, "secondary": 8, "secondary_link": 5,
    "tertiary": 7, "tertiary_link": 5, "residential": 6,
    "unclassified": 5, "living_street": 4, "service": 3.5,
    "pedestrian": 4, "footway": 1.5, "cycleway": 2, "path": 1.2, "track": 3,
}

# Overture release shared with the buildings provider
from .buildings import OVERTURE_RELEASE


# ---------------------------------------------------------------------------
# OSM Overpass (primary)
# ---------------------------------------------------------------------------

def _fetch_osm_roads(bbox: BBox, road_types: set, cache_dir: Path) -> list[dict]:
    """Fetch road geometries from OSM Overpass API."""
    cache_file = cache_dir / (
        f"osm_roads_{bbox.min_lat:.4f}_{bbox.max_lat:.4f}"
        f"_{bbox.min_lon:.4f}_{bbox.max_lon:.4f}.json"
    )

    if cache_file.exists():
        log.info("Using cached OSM roads")
        with open(cache_file) as f:
            return json.load(f)

    highway_filter = "|".join(road_types)
    bbox_str = f"{bbox.min_lat},{bbox.min_lon},{bbox.max_lat},{bbox.max_lon}"
    query = f"""
    [out:json][timeout:120];
    (
      way["highway"~"^({highway_filter})$"]({bbox_str});
    );
    out body;
    >;
    out skel qt;
    """

    raw_result = overpass_query(query)

    # Build node lookup
    nodes = {}
    for el in raw_result.get("elements", []):
        if el["type"] == "node":
            nodes[el["id"]] = (el["lon"], el["lat"])

    # Parse ways
    roads = []
    for el in raw_result.get("elements", []):
        if el["type"] != "way":
            continue
        tags = el.get("tags", {})
        rt = tags.get("highway")
        if not rt or rt not in road_types:
            continue

        coords = []
        for nid in el.get("nodes", []):
            if nid in nodes:
                coords.append(nodes[nid])
        if len(coords) < 2:
            continue

        w_m = ROAD_WIDTHS.get(rt, 5)
        if "width" in tags:
            try:
                w_m = float(tags["width"].replace("m", "").strip())
            except (ValueError, AttributeError):
                pass
        if "lanes" in tags:
            try:
                w_m = max(w_m, int(tags["lanes"]) * 3.5)
            except (ValueError, TypeError):
                pass

        roads.append({"coords": coords, "width": w_m, "type": rt})

    log.info("OSM returned %d roads", len(roads))

    with open(cache_file, "w") as f:
        json.dump(roads, f)

    return roads


# ---------------------------------------------------------------------------
# Overture Maps transportation (fallback)
# ---------------------------------------------------------------------------

def _parse_linestring_wkt(wkt: str):
    """Extract coords from a LINESTRING WKT string. Returns [(lon,lat),...]."""
    if not wkt or not wkt.startswith("LINESTRING"):
        return None
    try:
        inner = wkt.split("(", 1)[1].rsplit(")", 1)[0]
        coords = []
        for pair in inner.split(","):
            parts = pair.strip().split()
            coords.append((float(parts[0]), float(parts[1])))
        return coords if len(coords) >= 2 else None
    except (IndexError, ValueError):
        return None


def _fetch_overture_roads(bbox: BBox, road_types: set, cache_dir: Path) -> list[dict]:
    """Query Overture Maps road segments via DuckDB from S3 Parquet."""
    import duckdb

    cache_file = cache_dir / (
        f"overture_roads_{bbox.min_lat:.4f}_{bbox.max_lat:.4f}"
        f"_{bbox.min_lon:.4f}_{bbox.max_lon:.4f}.json"
    )
    if cache_file.exists():
        log.info("Using cached Overture roads")
        with open(cache_file) as f:
            return json.load(f)

    log.info("Querying Overture Maps roads (release %s)...", OVERTURE_RELEASE)
    s3_path = (f"s3://overturemaps-us-west-2/release/{OVERTURE_RELEASE}"
               f"/theme=transportation/type=segment/*")

    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute("INSTALL httpfs; LOAD httpfs;")
    con.execute("SET s3_region='us-west-2';")
    query = f"""
        SELECT class, ST_AsText(geometry) AS wkt
        FROM read_parquet('{s3_path}', filename=true, hive_partitioning=1)
        WHERE subtype = 'road'
          AND bbox.xmin > {bbox.min_lon} AND bbox.xmax < {bbox.max_lon}
          AND bbox.ymin > {bbox.min_lat} AND bbox.ymax < {bbox.max_lat}
    """
    result = con.execute(query).fetchall()
    con.close()
    log.info("Overture returned %d road segments", len(result))

    roads = []
    for cls, wkt in result:
        if cls not in road_types:
            continue
        coords = _parse_linestring_wkt(wkt)
        if coords is None:
            continue
        roads.append({"coords": coords,
                      "width": ROAD_WIDTHS.get(cls, 5),
                      "type": cls})

    log.info("Overture roads matching profile: %d", len(roads))
    with open(cache_file, "w") as f:
        json.dump(roads, f)
    return roads


# ---------------------------------------------------------------------------
# Public interface
# ---------------------------------------------------------------------------

def fetch(bbox: BBox, cache_dir: Path = DEFAULT_CACHE,
          road_types=None, roads_profile: str = "major-residential",
          **kwargs) -> ProviderResult:
    """Fetch road geometries for bbox: OSM Overpass, then Overture Maps.

    Returns ProviderResult where:
      .data = list of {"coords": [(lon, lat), ...], "width": float, "type": str}
      .source = "osm-overpass" or "overture-maps"
    """
    cache = Path(cache_dir) / "roads"
    cache.mkdir(parents=True, exist_ok=True)

    if road_types is None:
        road_types = ROAD_TYPES_BY_PROFILE.get(roads_profile,
                                                ROAD_TYPES_BY_PROFILE["major-residential"])

    try:
        roads = _fetch_osm_roads(bbox, road_types, cache)
        source = "osm-overpass"
    except Exception as e:
        log.warning("Overpass failed (%s) — falling back to Overture Maps "
                    "transportation", e)
        try:
            roads = _fetch_overture_roads(bbox, road_types, cache)
            source = "overture-maps"
        except Exception as e2:
            raise RuntimeError(
                f"All road sources failed. Overpass: {e}; Overture: {e2}"
            ) from e2

    return ProviderResult(
        data=roads,
        source=source,
        cached=False,
        metadata={
            "count": len(roads),
            "profile": roads_profile,
        },
    )
