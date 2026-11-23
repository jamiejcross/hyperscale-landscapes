"""Coastline provider: GSHHG → OSM fallback.

Downloads GSHHG h-resolution shapefiles on first use, parses land polygons,
clips to bbox, and returns sea = bbox.difference(land).

OS Open Data MHW/MLW for UK is deferred to Session 5.
"""

import io
import json
import logging
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

import shapefile  # pyshp
from shapely.geometry import box, Polygon, MultiPolygon, shape
from shapely.ops import unary_union
from shapely.validation import make_valid

from . import BBox, ProviderResult, DEFAULT_CACHE, USER_AGENT, require_online

log = logging.getLogger(__name__)

GSHHG_URL = (
    "https://www.soest.hawaii.edu/pwessel/gshhg/"
    "gshhg-shp-2.3.7.zip"
)
# L1 = land boundaries (continents + islands)
GSHHG_L1_SUBPATH = "GSHHS_shp/h/GSHHS_h_L1.shp"
# L2 = lakes (holes in land) — useful for accurate coastlines near lochs
GSHHG_L2_SUBPATH = "GSHHS_shp/h/GSHHS_h_L2.shp"


# ---------------------------------------------------------------------------
# GSHHG download + cache
# ---------------------------------------------------------------------------

def _ensure_gshhg(cache_dir: Path) -> Path:
    """Download and extract GSHHG shapefiles if not already cached.
    Returns the directory containing the extracted shapefiles.
    """
    gshhg_dir = cache_dir / "gshhg"
    marker = gshhg_dir / "GSHHS_shp" / "h" / "GSHHS_h_L1.shp"
    if marker.exists():
        log.info("GSHHG shapefiles already cached")
        return gshhg_dir

    require_online("the GSHHG coastline dataset")
    gshhg_dir.mkdir(parents=True, exist_ok=True)
    log.info("Downloading GSHHG shapefiles (~150 MB)...")

    req = urllib.request.Request(GSHHG_URL, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=300) as resp:
        zip_bytes = resp.read()

    log.info("Extracting GSHHG shapefiles...")
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        # Only extract the h-resolution files we need
        for member in zf.namelist():
            if member.startswith("GSHHS_shp/h/"):
                zf.extract(member, gshhg_dir)

    if not marker.exists():
        raise RuntimeError("GSHHG extraction failed — L1 shapefile not found")

    log.info("GSHHG cached at %s", gshhg_dir)
    return gshhg_dir


# ---------------------------------------------------------------------------
# GSHHG coastline fetcher
# ---------------------------------------------------------------------------

def _read_land_polygons(gshhg_dir: Path, bbox: BBox) -> list:
    """Read GSHHG L1 (land) polygons that intersect bbox. Returns list of shapely Polygons."""
    shp_path = gshhg_dir / GSHHG_L1_SUBPATH
    bbox_poly = box(bbox.min_lon, bbox.min_lat, bbox.max_lon, bbox.max_lat)

    land_polys = []
    sf = shapefile.Reader(str(shp_path))
    for sr in sf.iterShapeRecords(bbox=[bbox.min_lon, bbox.min_lat,
                                        bbox.max_lon, bbox.max_lat]):
        # Numeric bounding-box pre-filter (no shapely object creation)
        sb = sr.shape.bbox  # [min_lon, min_lat, max_lon, max_lat]
        if (sb[2] < bbox.min_lon or sb[0] > bbox.max_lon or
                sb[3] < bbox.min_lat or sb[1] > bbox.max_lat):
            continue

        # Convert to shapely and clip
        try:
            geom = shape(sr.shape.__geo_interface__)
            geom = make_valid(geom)
            clipped = geom.intersection(bbox_poly)
            if not clipped.is_empty:
                land_polys.append(clipped)
        except Exception as e:
            log.warning("Skipping invalid GSHHG polygon: %s", e)
            continue

    log.info("GSHHG L1: %d land polygons intersect bbox", len(land_polys))
    return land_polys


def _read_lake_polygons(gshhg_dir: Path, bbox: BBox) -> list:
    """Read GSHHG L2 (lake) polygons that intersect bbox."""
    shp_path = gshhg_dir / GSHHG_L2_SUBPATH
    if not shp_path.exists():
        return []

    bbox_poly = box(bbox.min_lon, bbox.min_lat, bbox.max_lon, bbox.max_lat)
    lake_polys = []
    sf = shapefile.Reader(str(shp_path))
    for sr in sf.iterShapeRecords(bbox=[bbox.min_lon, bbox.min_lat,
                                        bbox.max_lon, bbox.max_lat]):
        sb = sr.shape.bbox
        if (sb[2] < bbox.min_lon or sb[0] > bbox.max_lon or
                sb[3] < bbox.min_lat or sb[1] > bbox.max_lat):
            continue
        try:
            geom = shape(sr.shape.__geo_interface__)
            geom = make_valid(geom)
            clipped = geom.intersection(bbox_poly)
            if not clipped.is_empty:
                lake_polys.append(clipped)
        except Exception:
            continue

    log.info("GSHHG L2: %d lake polygons intersect bbox", len(lake_polys))
    return lake_polys


def _compute_sea_polygons(bbox: BBox, land_polys: list, lake_polys: list) -> list:
    """Sea = bbox - land + lakes (lakes are holes in land, not sea, so ignore them for sea calc).

    Returns list of shapely Polygons representing sea areas.
    """
    bbox_poly = box(bbox.min_lon, bbox.min_lat, bbox.max_lon, bbox.max_lat)

    if not land_polys:
        # No land in bbox → entire bbox is sea (or no coastline data)
        return [bbox_poly]

    land_union = unary_union(land_polys)
    land_union = make_valid(land_union)
    sea = bbox_poly.difference(land_union)
    sea = make_valid(sea)

    if sea.is_empty:
        return []

    # Normalise to list of Polygons
    if isinstance(sea, Polygon):
        return [sea]
    elif isinstance(sea, MultiPolygon):
        return list(sea.geoms)
    else:
        # GeometryCollection — extract only polygons
        return [g for g in sea.geoms if isinstance(g, Polygon)]


def _fetch_gshhg(bbox: BBox, cache_dir: Path) -> list:
    """Fetch sea polygons via GSHHG. Returns list of shapely Polygons."""
    gshhg_dir = _ensure_gshhg(cache_dir)
    land_polys = _read_land_polygons(gshhg_dir, bbox)
    lake_polys = _read_lake_polygons(gshhg_dir, bbox)
    sea_polys = _compute_sea_polygons(bbox, land_polys, lake_polys)
    return sea_polys


# ---------------------------------------------------------------------------
# OSM Overpass fallback
# ---------------------------------------------------------------------------

def _fetch_osm_coastline(bbox: BBox) -> list:
    """Fetch coastline from OSM Overpass as a last-resort fallback.

    Queries natural=coastline ways, assembles into polygons.
    This is the same flawed approach as multi-extruder — kept only as fallback.
    """
    log.info("Falling back to OSM Overpass for coastline...")
    query = f"""
    [out:json][timeout:60];
    (
      way["natural"="coastline"]({bbox.min_lat},{bbox.min_lon},{bbox.max_lat},{bbox.max_lon});
    );
    out body;
    >;
    out skel qt;
    """
    from . import overpass_query
    result = overpass_query(query)

    # Build node lookup
    nodes = {}
    for el in result.get("elements", []):
        if el["type"] == "node":
            nodes[el["id"]] = (el["lon"], el["lat"])

    # Build linestrings from ways
    lines = []
    for el in result.get("elements", []):
        if el["type"] == "way":
            coords = [nodes[nid] for nid in el.get("nodes", []) if nid in nodes]
            if len(coords) >= 2:
                lines.append(coords)

    if not lines:
        log.warning("OSM returned no coastline ways for bbox")
        return []

    # Simple approach: try to form a polygon from coastline + bbox edges
    # Coastline in OSM has water on the right side (by convention)
    bbox_poly = box(bbox.min_lon, bbox.min_lat, bbox.max_lon, bbox.max_lat)

    from shapely.geometry import LineString
    from shapely.ops import linemerge, polygonize

    merged = linemerge(
        [LineString(c) for c in lines]
    )

    # Add bbox edges to help close polygons
    bbox_ring = bbox_poly.exterior
    all_lines = [merged] if merged.geom_type == "LineString" else list(merged.geoms)
    all_lines.append(bbox_ring)

    polys = list(polygonize(all_lines))

    # Filter: keep polygons that are likely sea (heuristic: not mostly land)
    # This is imperfect — hence why GSHHG is preferred
    sea_polys = []
    for p in polys:
        p = make_valid(p)
        clipped = p.intersection(bbox_poly)
        if not clipped.is_empty and isinstance(clipped, (Polygon, MultiPolygon)):
            if isinstance(clipped, Polygon):
                sea_polys.append(clipped)
            else:
                sea_polys.extend(clipped.geoms)

    log.info("OSM coastline: assembled %d candidate sea polygons", len(sea_polys))
    return sea_polys


# ---------------------------------------------------------------------------
# Public interface
# ---------------------------------------------------------------------------

def fetch(bbox: BBox, cache_dir: Path = DEFAULT_CACHE, **kwargs) -> ProviderResult:
    """Fetch sea polygons for bbox. Tries GSHHG first, then OSM.

    Returns ProviderResult where:
      .data = list of shapely.Polygon (sea areas within bbox)
      .source = "gshhg-h" or "osm-coastline"
    """
    cache = Path(cache_dir) / "coastline"
    cache.mkdir(parents=True, exist_ok=True)

    # Bbox-keyed result cache (WKT) — skips the shapefile scan entirely
    from shapely import wkt as _wkt
    result_cache = cache / (
        f"sea_{bbox.min_lat:.5f}_{bbox.max_lat:.5f}"
        f"_{bbox.min_lon:.5f}_{bbox.max_lon:.5f}.json"
    )
    if result_cache.exists() and not kwargs.get("force"):
        try:
            with open(result_cache) as f:
                cached = json.load(f)
            sea_polys = [_wkt.loads(w) for w in cached["wkt"]]
            log.info("Using cached sea polygons (%d)", len(sea_polys))
            return ProviderResult(
                data=sea_polys, source=cached["source"], cached=True,
                metadata={"num_sea_polygons": len(sea_polys)})
        except Exception as e:
            log.warning("Sea polygon cache unreadable (%s) — recomputing", e)

    # Try GSHHG first
    try:
        sea_polys = _fetch_gshhg(bbox, cache)
        source = "gshhg-h"
        log.info("GSHHG: %d sea polygons for bbox", len(sea_polys))
    except Exception as e:
        log.warning("GSHHG failed (%s), falling back to OSM", e)
        try:
            sea_polys = _fetch_osm_coastline(bbox)
            source = "osm-coastline"
        except Exception as e2:
            raise RuntimeError(
                f"All coastline sources failed. GSHHG: {e}; OSM: {e2}"
            ) from e2

    try:
        with open(result_cache, "w") as f:
            json.dump({"source": source,
                       "wkt": [p.wkt for p in sea_polys]}, f)
    except Exception as e:
        log.warning("Could not write sea polygon cache: %s", e)

    total_area = sum(p.area for p in sea_polys)
    bbox_area = (bbox.max_lon - bbox.min_lon) * (bbox.max_lat - bbox.min_lat)

    return ProviderResult(
        data=sea_polys,
        source=source,
        cached=False,
        metadata={
            "num_sea_polygons": len(sea_polys),
            "sea_fraction": total_area / bbox_area if bbox_area > 0 else 0,
        },
    )
