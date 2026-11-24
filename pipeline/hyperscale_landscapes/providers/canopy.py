"""Canopy height model (CHM): how tall the vegetation is, per square metre.

CHM = DSM - DTM from the Scottish Public Sector LiDAR (OGL v3), read through
``providers/lidar.py``: the surface model (first return: tree tops, roofs)
minus the bare-earth terrain. The DSM is taken from the SAME programme as the
DTM wherever that programme has data, so both describe one survey date;
pixels where it had to come from another programme are counted as a
mismatch and reported.

Both are read at 1 m by averaging the native 50 cm cells (Phase 1 is native
1 m). Averaging is linear, so this equals differencing at 50 cm and then
averaging.

Then:
  * buildings (OSM footprints, buffered 2 m), water and sea are masked out;
  * heights are clipped to 0-45 m, and anything under 2.5 m is "not tree";
  * where there is no LiDAR DSM/DTM, the gap is filled from the Meta/WRI
    1 m global canopy height map (CC BY 4.0), and the share is recorded.

Results are cached per bounding box in ``<cache>/canopy``.
"""
from __future__ import annotations

import gzip
import json
import logging
import math
import urllib.request
from pathlib import Path

import numpy as np

from . import BBox, DEFAULT_CACHE, USER_AGENT, require_online
from . import lidar

log = logging.getLogger(__name__)

RES_M = 1.0
NOT_TREE_M = 2.5
MAX_M = 45.0
BUILDING_BUFFER_M = 2.0
SEA_LEVEL_M = 0.3          # DTM at or below this is treated as sea/foreshore
CACHE_VERSION = "v3"

META_BASE = "https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float"
META_ZOOM = 9
META_CITATION = ("Meta and World Resources Institute (WRI) - 2024. High Resolution Canopy Height Maps (CHM). "
                 "Source imagery for CHM © 2016 Maxar. CC BY 4.0")

# Structures the DSM sees that are not trees, masked with these buffers (m).
# Lines: the conductors hang up to ~10 m either side of a transmission line's
# centre line; turbines: the rotor sweeps its radius (OSM rotor:diameter/2,
# else an assumed 60 m).
LINE_BUFFER_M = {"line": 10.0, "minor_line": 4.0}
SUPPORT_BUFFER_M = 8.0
TURBINE_RADIUS_ASSUMED_M = 60.0

# Smooth surfaces: canopy is rough at the metre scale; roofs, bridge decks
# and embankments the building mask missed (not in OSM) are planes. A pixel
# whose height departs from its local average by under SMOOTH_M (RMS over
# 5 m) is smooth; smooth regions of SMOOTH_MIN_M2 or more, grown by
# SMOOTH_GROW_M to take in their edges and ridges, are "not tree".
SMOOTH_M = 0.25
SMOOTH_MIN_M2 = 50
SMOOTH_GROW_M = 3            # applied to LiDAR pixels only

WATER_TAGS = {("natural", "water"), ("waterway", "riverbank"), ("landuse", "reservoir"), ("landuse", "basin")}


# ---------------------------------------------------------------------------
# Masks from the site's OSM data (the bundle's Overpass JSON, `out geom`)
# ---------------------------------------------------------------------------

def _rings(el) -> list[list[tuple[float, float]]]:
    # `out geom(bbox)` leaves null points for nodes outside the box: drop them.
    pts = lambda g: [(p["lon"], p["lat"]) for p in g if p]
    if el["type"] == "way" and el.get("geometry"):
        return [pts(el["geometry"])]
    if el["type"] == "relation":
        return [pts(m["geometry"]) for m in el.get("members", []) if m.get("role") == "outer" and m.get("geometry")]
    return []


def _mask(elements, pick, transform, shape, buffer_m=0.0):
    """Rasterise OSM features. pick(tags) -> False to skip, or a buffer in m
    (True means `buffer_m`). Areas are filled; lines and points are buffered."""
    from pyproj import Transformer
    from rasterio.features import rasterize
    from shapely.geometry import LineString, Point, Polygon

    tr = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)
    shapes = []
    for el in elements:
        b = pick(el.get("tags", {}))
        if b is False or b is None:
            continue
        buf = buffer_m if b is True else float(b)
        if el["type"] == "node":
            x, y = tr.transform(el["lon"], el["lat"])
            shapes.append(Point(x, y).buffer(max(buf, 0.5)))
            continue
        for ring in _rings(el):
            if len(ring) < 2:
                continue
            xs, ys = tr.transform(*zip(*ring))
            closed = len(ring) >= 4 and ring[0] == ring[-1]
            geom = Polygon(zip(xs, ys)) if closed else LineString(zip(xs, ys))
            if closed and not geom.is_valid:
                geom = geom.buffer(0)
            if buf or not closed:
                geom = geom.buffer(max(buf, 0.5))
            if not geom.is_empty:
                shapes.append(geom)
    if not shapes:
        return np.zeros(shape, dtype=bool)
    return rasterize(((s, 1) for s in shapes), out_shape=shape, transform=transform, dtype="uint8").astype(bool)


def _copernicus_sea(box: BBox, cache_dir, transform, shape) -> np.ndarray:
    """True where Copernicus GLO-30 is at or below sea level (it sets the sea to 0 m)."""
    from rasterio.transform import from_origin
    from rasterio.warp import Resampling, reproject
    from .elevation import _fetch_copernicus
    try:
        cop, ext = _fetch_copernicus(box, Path(cache_dir) / "elevation")
    except Exception as e:
        log.warning("Copernicus sea mask unavailable (%s)", e)
        return np.zeros(shape, bool)
    cop = np.asarray(cop, dtype=np.float32)
    h, w = cop.shape
    src_t = from_origin(ext["west"], ext["north"], (ext["east"] - ext["west"]) / w, (ext["north"] - ext["south"]) / h)
    out = np.full(shape, np.nan, dtype=np.float32)
    reproject(source=cop, destination=out, src_transform=src_t, src_crs="EPSG:4326", dst_transform=transform,
              dst_crs="EPSG:27700", resampling=Resampling.nearest, dst_nodata=np.nan)
    return np.isfinite(out) & (out <= 0.5)


def _smooth_surfaces(chm: np.ndarray) -> np.ndarray:
    """Planar raised surfaces (unmapped roofs, decks): see SMOOTH_M."""
    from scipy import ndimage as ndi
    tall = chm >= NOT_TREE_M
    if not tall.any():
        return np.zeros(chm.shape, bool)
    dev = chm - ndi.gaussian_filter(chm, 1.5 / RES_M)
    rough = np.sqrt(np.maximum(ndi.uniform_filter(dev * dev, int(5 / RES_M)), 0))
    smooth = tall & (rough < SMOOTH_M)
    lab, n = ndi.label(smooth)
    if n == 0:
        return smooth
    sizes = ndi.sum(smooth, lab, np.arange(1, n + 1)) * RES_M ** 2
    keep = np.zeros(n + 1, bool); keep[1:] = sizes >= SMOOTH_MIN_M2
    big = keep[lab]
    return ndi.binary_dilation(big, iterations=int(SMOOTH_GROW_M / RES_M)) & tall


def _structure_buffer(tags):
    """Mask buffer (m) for power lines, supports and wind turbines; False otherwise."""
    p = tags.get("power")
    if p in LINE_BUFFER_M:
        return LINE_BUFFER_M[p]
    if p in ("tower", "pole", "portal"):
        return SUPPORT_BUFFER_M
    if p == "generator" and (tags.get("generator:source") == "wind" or tags.get("generator:method") == "wind_turbine"):
        try:
            return float(str(tags.get("rotor:diameter", "")).split()[0]) / 2
        except (ValueError, IndexError):
            return TURBINE_RADIUS_ASSUMED_M
    return False


# ---------------------------------------------------------------------------
# Meta/WRI fallback
# ---------------------------------------------------------------------------

def _coords(c):
    """Every [x, y] in a nested GeoJSON coordinate array."""
    if c and isinstance(c[0], (int, float)):
        yield c
    else:
        for part in c:
            yield from _coords(part)


def _quadkey(x, y, z):
    return "".join(str((1 if x & (1 << (i - 1)) else 0) + (2 if y & (1 << (i - 1)) else 0)) for i in range(z, 0, -1))


def _meta_chm(bb: BBox, transform, shape):
    """Meta/WRI canopy height (m) on the National Grid output grid; NaN outside coverage."""
    import rasterio
    from rasterio.warp import Resampling, reproject, transform_bounds
    from rasterio.windows import from_bounds

    z = META_ZOOM
    tx = lambda lon: int((lon + 180) / 360 * 2 ** z)
    ty = lambda lat: int((1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * 2 ** z)
    keys = {_quadkey(x, y, z) for x in range(tx(bb.min_lon), tx(bb.max_lon) + 1)
            for y in range(ty(bb.max_lat), ty(bb.min_lat) + 1)}
    out = np.full(shape, np.nan, dtype=np.float32)
    dates = set()
    for qk in sorted(keys):
        require_online(f"Meta/WRI canopy tile {qk}")
        try:
            with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR"):
                with rasterio.open(f"/vsicurl/{META_BASE}/chm/{qk}.tif") as src:
                    b = transform_bounds("EPSG:4326", src.crs, bb.min_lon - 0.002, bb.min_lat - 0.002,
                                         bb.max_lon + 0.002, bb.max_lat + 0.002)
                    win = from_bounds(*b, src.transform).round_offsets().round_lengths()
                    data = src.read(1, window=win, boundless=True, fill_value=255).astype(np.float32)
                    data[data == 255] = np.nan
                    reproject(source=data, destination=out, src_transform=src.window_transform(win), src_crs=src.crs,
                              dst_transform=transform, dst_crs="EPSG:27700", src_nodata=np.nan, dst_nodata=np.nan,
                              init_dest_nodata=False, resampling=Resampling.bilinear)
        except Exception as e:
            log.warning("Meta/WRI canopy tile %s unreadable (%s)", qk, e)
            continue
        try:
            req = urllib.request.Request(f"{META_BASE}/metadata/{qk}.geojson", headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=60) as r:
                for f in json.loads(r.read()).get("features", []):
                    pts = list(_coords(f["geometry"]["coordinates"]))       # Polygon or MultiPolygon
                    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
                    if min(xs) < bb.max_lon and max(xs) > bb.min_lon and min(ys) < bb.max_lat and max(ys) > bb.min_lat:
                        dates.add(f["properties"].get("acq_date"))
        except Exception as e:
            log.warning("Meta/WRI metadata %s unreadable (%s)", qk, e)
    return out, sorted(d for d in dates if d)


# ---------------------------------------------------------------------------
# The canopy height model
# ---------------------------------------------------------------------------

def compute(bb: dict, osm_elements: list, cache_dir: Path = DEFAULT_CACHE, force: bool = False) -> dict:
    """CHM over a site bbox ({min_lat, max_lat, min_lon, max_lon}).

    Returns {"chm": float32 m (0 = not tree / masked), "transform", "crs",
    "valid": bool (land with a height from some source), "meta": {...}}.
    """
    from rasterio.transform import from_origin
    from .elevation import _bbox_osgb_bounds

    box = BBox(bb["min_lat"], bb["max_lat"], bb["min_lon"], bb["max_lon"])
    cache = Path(cache_dir) / "canopy"
    cache.mkdir(parents=True, exist_ok=True)
    key = f"chm_{CACHE_VERSION}_{box.min_lat:.5f}_{box.max_lat:.5f}_{box.min_lon:.5f}_{box.max_lon:.5f}.npz"
    if (cache / key).exists() and not force:
        z = np.load(cache / key, allow_pickle=False)
        meta = json.loads(str(z["meta"]))
        return {"chm": z["chm_dm"].astype(np.float32) / 10, "valid": z["valid"], "meta": meta,
                "transform": from_origin(*meta["origin"], RES_M, RES_M), "crs": "EPSG:27700"}

    e0, n0, e1, n1 = _bbox_osgb_bounds(box, pad_m=0.0)
    cols, rows = int(math.ceil((e1 - e0) / RES_M)), int(math.ceil((n1 - n0) / RES_M))
    transform = from_origin(e0, n1, RES_M, RES_M)
    shape = (rows, cols)

    dtm = dsm = None
    dtm_used = dsm_used = []
    try:
        dtm, _, dtm_used, dtm_src = lidar.read_surface((e0, n0, e1, n1), cache_dir, RES_M, kind="dtm", force=force)
        dsm, _, dsm_used, dsm_src = lidar.read_surface((e0, n0, e1, n1), cache_dir, RES_M, kind="dsm",
                                                      force=force, match=dtm_src)
    except RuntimeError as e:
        log.info("No LiDAR DTM/DSM here (%s); canopy from the fallback only", e)

    chm = np.full(shape, np.nan, dtype=np.float32)
    lidar_px = np.zeros(shape, bool)
    mismatch = np.zeros(shape, bool)
    if dtm is not None and dsm is not None:
        lidar_px = np.isfinite(dtm) & np.isfinite(dsm)
        chm[lidar_px] = dsm[lidar_px] - dtm[lidar_px]
        mismatch = lidar_px & (dsm_src != dtm_src)

    # Masks: buildings (buffered), water, sea.
    buildings = _mask(osm_elements, lambda t: "building" in t, transform, shape, BUILDING_BUFFER_M)
    water = _mask(osm_elements, lambda t: any((k, t.get(k)) in WATER_TAGS for k in t) or "water" in t,
                  transform, shape)
    sea = np.zeros(shape, bool) if dtm is None else (np.isfinite(dtm) & (dtm <= SEA_LEVEL_M))
    # Where the LiDAR has no terrain (often open sea), use Copernicus 30 m.
    no_dtm = np.ones(shape, bool) if dtm is None else ~np.isfinite(dtm)
    if no_dtm.any():
        sea |= no_dtm & _copernicus_sea(box, cache_dir, transform, shape)
    structures = _mask(osm_elements, _structure_buffer, transform, shape)
    masked = buildings | water | sea | structures

    fallback_px = np.zeros(shape, bool)
    meta_dates: list[str] = []
    need = ~lidar_px & ~masked
    if need.any():
        try:
            fb, meta_dates = _meta_chm(box, transform, shape)
            fallback_px = need & np.isfinite(fb)
            chm[fallback_px] = fb[fallback_px]
        except Exception as e:          # no fallback reachable: leave the gap, and say so
            log.warning("Meta/WRI canopy fallback failed (%s)", e)

    valid = (lidar_px | fallback_px) & ~masked
    chm = np.where(valid, np.clip(chm, 0, MAX_M), 0).astype(np.float32)
    chm[chm < NOT_TREE_M] = 0
    # LiDAR only: the Meta/WRI fallback is a smooth model output, so smoothness there means nothing.
    smooth = _smooth_surfaces(chm) & lidar_px
    smooth_ha = float((smooth & (chm > 0)).sum()) * RES_M ** 2 / 1e4
    chm[smooth] = 0

    land = int((~masked).sum()) or 1
    dsm_progs = [p for p in dsm_used]
    meta = {
        "origin": [e0, n1], "res_m": RES_M, "shape": list(shape),
        "dtm_programmes": dtm_used, "dsm_programmes": dsm_progs,
        "dsm_years": {p: lidar.PROGRAMME_CAPTURE.get(p, {}).get("years", "to verify") for p in dsm_progs},
        "pct_lidar": round(100 * float((lidar_px & ~masked).sum()) / land, 2),
        "pct_fallback": round(100 * float(fallback_px.sum()) / land, 2),
        "pct_no_data": round(100 * float((~valid & ~masked).sum()) / land, 2),
        "pct_programme_mismatch": round(100 * float((mismatch & ~masked).sum()) / max(1, int((lidar_px & ~masked).sum())), 2),
        "fallback_dates": meta_dates,
        "canopy_over_5m_ha": round(float((chm > 5).sum()) * RES_M ** 2 / 1e4, 2),
        "smooth_surfaces_removed_ha": round(smooth_ha, 2),
        "canopy_over_2_5m_ha": round(float((chm >= NOT_TREE_M).sum()) * RES_M ** 2 / 1e4, 2),
        "masked_pct": round(100 * float(masked.sum()) / masked.size, 2),
        "rules": {"not_tree_below_m": NOT_TREE_M, "clip_m": [0, MAX_M], "building_buffer_m": BUILDING_BUFFER_M,
                  "power_line_buffer_m": LINE_BUFFER_M, "support_buffer_m": SUPPORT_BUFFER_M,
                  "turbine_radius_assumed_m": TURBINE_RADIUS_ASSUMED_M,
                  "sea_dtm_at_or_below_m": SEA_LEVEL_M, "sea_where_no_lidar": "Copernicus GLO-30 at or below 0.5 m",
                  "resolution_m": RES_M,
                  "smooth_surface": f"RMS departure < {SMOOTH_M} m over 5 m, regions >= {SMOOTH_MIN_M2} m2, grown {SMOOTH_GROW_M} m"},
        "sources": {"lidar": "Scottish Public Sector LiDAR DSM and DTM (OGL v3)",
                    "fallback": META_CITATION if fallback_px.any() else None},
    }
    np.savez_compressed(cache / key, chm_dm=np.round(chm * 10).astype(np.uint16), valid=valid,
                        meta=np.array(json.dumps(meta)))
    return {"chm": chm, "valid": valid, "meta": meta, "transform": transform, "crs": "EPSG:27700"}


def site_report(site_id: str, cache_dir: Path = DEFAULT_CACHE, force: bool = False) -> dict:
    """Stage-1 numbers for one curated site, from its bundle's OSM data."""
    from ..paths import data_dir
    site = json.loads((data_dir() / "sites" / f"{site_id}.geojson").read_text())
    bundle = json.loads(gzip.decompress((data_dir() / "sites" / f"{site_id}.bundle.json.gz").read_bytes()))
    r = compute(site["properties"]["model_bbox"], bundle["osm"]["elements"], cache_dir, force)
    return {"site": site_id, **r["meta"]}


if __name__ == "__main__":       # python -m hyperscale_landscapes.providers.canopy [site ...]
    import sys
    logging.basicConfig(level=logging.WARNING)
    from ..paths import data_dir
    ids = sys.argv[1:] or [s["id"] for s in json.loads((data_dir() / "sites" / "index.json").read_text())["sites"]]
    for sid in ids:
        try:
            m = site_report(sid)
            print(json.dumps({k: m[k] for k in ("site", "dtm_programmes", "dsm_programmes", "dsm_years", "pct_lidar",
                                                 "pct_fallback", "pct_no_data", "pct_programme_mismatch",
                                                 "fallback_dates", "canopy_over_5m_ha", "masked_pct")}), flush=True)
        except Exception as e:
            print(json.dumps({"site": sid, "error": str(e)}), flush=True)
