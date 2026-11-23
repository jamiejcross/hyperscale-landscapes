"""Buildings provider: OSM Overpass (default) or Overture Maps (opt-in).

OSM is the default so that every output carries a single, simple ODbL
attribution.  Overture can be requested with ``prefer="overture"``.

Returns list of dicts: {"coords": [(lon, lat), ...], "height": float}
"""

import json
import logging
from pathlib import Path

from . import BBox, ProviderResult, DEFAULT_CACHE, overpass_query, require_online

log = logging.getLogger(__name__)

# Latest Overture Maps release (update when new releases land)
OVERTURE_RELEASE = "2026-05-20.0"
OVERTURE_S3_PATH = (
    f"s3://overturemaps-us-west-2/release/{OVERTURE_RELEASE}"
    f"/theme=buildings/type=building/*"
)

DEFAULT_FLOOR_HEIGHT = 3.0  # metres per floor when height is null
DEFAULT_BUILDING_HEIGHT = 6.0  # fallback when both height and num_floors are null


# ---------------------------------------------------------------------------
# Overture Maps via DuckDB
# ---------------------------------------------------------------------------

def _fetch_overture(bbox: BBox, cache_dir: Path) -> list[dict]:
    """Query Overture Maps buildings via DuckDB from S3 Parquet."""
    import duckdb

    cache_file = cache_dir / (
        f"overture_buildings_{bbox.min_lat:.4f}_{bbox.max_lat:.4f}"
        f"_{bbox.min_lon:.4f}_{bbox.max_lon:.4f}.json"
    )

    if cache_file.exists():
        log.info("Using cached Overture buildings")
        with open(cache_file) as f:
            return json.load(f)

    require_online("Overture buildings")
    log.info("Querying Overture Maps buildings (release %s)...", OVERTURE_RELEASE)

    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute("INSTALL httpfs; LOAD httpfs;")
    con.execute("SET s3_region='us-west-2';")

    # Use bbox columns for efficient Parquet row-group pruning,
    # then extract coords from WKB geometry via spatial extension.
    query = f"""
        SELECT
            height,
            num_floors,
            ST_AsText(geometry) AS wkt
        FROM read_parquet('{OVERTURE_S3_PATH}', filename=true, hive_partitioning=1)
        WHERE bbox.xmin > {bbox.min_lon}
          AND bbox.xmax < {bbox.max_lon}
          AND bbox.ymin > {bbox.min_lat}
          AND bbox.ymax < {bbox.max_lat}
    """

    log.info("Running DuckDB query (this can take a few minutes on first run)...")
    result = con.execute(query).fetchall()
    con.close()
    log.info("Overture returned %d buildings", len(result))

    buildings = []
    for height, num_floors, wkt in result:
        coords = _parse_polygon_wkt(wkt)
        if not coords:
            continue

        if height is not None and height > 0:
            h = float(height)
        elif num_floors is not None and num_floors > 0:
            h = float(num_floors) * DEFAULT_FLOOR_HEIGHT
        else:
            h = DEFAULT_BUILDING_HEIGHT

        buildings.append({"coords": coords, "height": h})

    # Cache
    with open(cache_file, "w") as f:
        json.dump(buildings, f)

    return buildings


def _parse_polygon_wkt(wkt: str) -> list[tuple[float, float]] | None:
    """Extract exterior ring coords from a POLYGON WKT string.

    Returns list of (lon, lat) tuples, or None if not a polygon.
    """
    if not wkt or not wkt.startswith("POLYGON"):
        return None

    # Extract the first ring (exterior) from POLYGON((x y, x y, ...))
    try:
        # Strip "POLYGON ((" and find the first "))"
        inner = wkt.split("(", 2)[2]
        ring_str = inner.split(")")[0]
        coords = []
        for pair in ring_str.split(","):
            parts = pair.strip().split()
            coords.append((float(parts[0]), float(parts[1])))
        return coords
    except (IndexError, ValueError):
        return None


# ---------------------------------------------------------------------------
# OSM Overpass fallback
# ---------------------------------------------------------------------------



def _fetch_osm(bbox: BBox, cache_dir: Path) -> list[dict]:
    """Fetch building footprints from OSM Overpass API."""

    cache_file = cache_dir / (
        f"osm_buildings_v2_{bbox.min_lat:.4f}_{bbox.max_lat:.4f}"
        f"_{bbox.min_lon:.4f}_{bbox.max_lon:.4f}.json"
    )

    if cache_file.exists():
        log.info("Using cached OSM buildings")
        with open(cache_file) as f:
            return json.load(f)

    log.info("Fetching buildings from OSM Overpass...")
    bbox_str = f"{bbox.min_lat},{bbox.min_lon},{bbox.max_lat},{bbox.max_lon}"
    query = f"""
    [out:json][timeout:120];
    (
      way["building"]({bbox_str});
      relation["building"]({bbox_str});
    );
    out body;
    >;
    out skel qt;
    """

    osm_data = overpass_query(query, timeout=180)

    # Build node lookup
    nodes = {}
    for el in osm_data.get("elements", []):
        if el["type"] == "node":
            nodes[el["id"]] = (el["lon"], el["lat"])

    # Parse ways into building footprints
    buildings = []
    for el in osm_data.get("elements", []):
        if el["type"] != "way":
            continue
        tags = el.get("tags", {})
        if "building" not in tags:
            continue

        coords = []
        for nid in el.get("nodes", []):
            if nid in nodes:
                coords.append(nodes[nid])
        if len(coords) < 3:
            continue

        # Parse height
        h = DEFAULT_BUILDING_HEIGHT
        if "height" in tags:
            try:
                h = float(tags["height"].replace("m", "").strip())
            except ValueError:
                pass
        elif "building:levels" in tags:
            try:
                h = float(tags["building:levels"]) * DEFAULT_FLOOR_HEIGHT
            except ValueError:
                pass

        # Building *type* only (used for the receptors layer); never names.
        buildings.append({"coords": coords, "height": h,
                          "kind": tags.get("building", "yes"),
                          "amenity": tags.get("amenity")})

    log.info("OSM returned %d buildings", len(buildings))

    with open(cache_file, "w") as f:
        json.dump(buildings, f)

    return buildings


# ---------------------------------------------------------------------------
# Public interface
# ---------------------------------------------------------------------------

def fetch(bbox: BBox, cache_dir: Path = DEFAULT_CACHE, **kwargs) -> ProviderResult:
    """Fetch building footprints for bbox. Tries Overture Maps first, then OSM.

    Returns ProviderResult where:
      .data = list of {"coords": [(lon, lat), ...], "height": float}
      .source = "overture-maps" or "osm-overpass"
    """
    cache = Path(cache_dir) / "buildings"
    cache.mkdir(parents=True, exist_ok=True)

    prefer = kwargs.get("prefer", "osm")
    order = (["overture", "osm"] if prefer == "overture" else ["osm", "overture"])
    fetchers = {"osm": (_fetch_osm, "osm-overpass"),
                "overture": (_fetch_overture, "overture-maps")}
    errors = {}
    buildings = None
    for name in order:
        fn, source = fetchers[name]
        try:
            buildings = fn(bbox, cache)
            break
        except Exception as e:  # try the next source
            log.warning("%s buildings failed (%s)", name, e)
            errors[name] = e
    if buildings is None:
        raise RuntimeError(f"All building sources failed: {errors}")

    return ProviderResult(
        data=buildings,
        source=source,
        cached=False,
        metadata={
            "count": len(buildings),
            "heights": {
                "min": min((b["height"] for b in buildings), default=0),
                "max": max((b["height"] for b in buildings), default=0),
                "mean": (sum(b["height"] for b in buildings) / len(buildings))
                        if buildings else 0,
            },
        },
    )
