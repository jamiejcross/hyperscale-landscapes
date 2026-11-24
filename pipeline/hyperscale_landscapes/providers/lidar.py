"""Scottish Public Sector LiDAR terrain (DTM), read straight from the public
``srsp-open-data`` bucket (Scottish Government / JNCC, Open Government
Licence v3.0; see DATA_LICENCES.md).

The bucket holds several survey programmes on the British National Grid
(EPSG:27700), in tiles of 1 km, 5 km or 10 km, at 25 cm to 1 m. This module

1. lists the bucket once (cached for 30 days) to build a tile index, with
   each tile's extent worked out from its OS grid-reference file name;
2. for a bounding box, picks every overlapping tile, newest programme
   first, and reads only the needed window, decimated to ``res_m``
   (cloud-optimised files serve this from their overviews);
3. mosaics them first-come-first-served per pixel, so newer surveys win and
   older ones only fill gaps.

It returns a grid on the National Grid with NaN where no survey has data;
the caller fills those gaps from a coarser source and records how much.
DTMs are bare earth: trees and buildings have been removed.
"""
from __future__ import annotations

import json
import logging
import math
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np

from . import USER_AGENT, require_online

log = logging.getLogger(__name__)

BUCKET = "https://srsp-open-data.s3.eu-west-2.amazonaws.com"
INDEX_MAX_AGE_S = 30 * 24 * 3600

# Newest and most complete first. Within a programme, finer tiles win.
PRIORITY = ["national-lidar-programme", "coastal", "phase-6", "phase-5", "phase-4",
            "phase-3", "hes", "phase-2", "phase-1", "outer-hebrides",
            "orkney-islands-council-23"]
PROGRAMME_NAMES = {
    "national-lidar-programme": "Scottish National LiDAR Programme",
    "coastal": "Scottish coastal LiDAR",
    "hes": "Historic Environment Scotland LiDAR",
    "outer-hebrides": "Outer Hebrides LiDAR",
    "orkney-islands-council-23": "Orkney Islands Council LiDAR 2023",
    **{f"phase-{i}": f"LiDAR for Scotland Phase {i}" for i in range(1, 7)},
}

_LETTERS = "ABCDEFGHJKLMNOPQRSTUVWXYZ"


def _grid_origin(g: str) -> tuple[int, int]:
    """OS 100 km square letters (e.g. 'NT') -> (easting, northing) of its SW corner."""
    a, b = _LETTERS.index(g[0]), _LETTERS.index(g[1])
    e = ((a - 2) % 5) * 5 + (b % 5)
    n = (19 - (a // 5) * 5) - (b // 5)
    return e * 100_000, n * 100_000


def tile_extent(fname: str):
    """(e0, n0, size_m) from a tile file name such as 'NT27SW_50CM_DTM_PHASE3.tif',
    'NG2004_50cm_DTM_...' (1 km) or 'HY20_1M_DTM_PHASE1.tif' (10 km). None if unparsable."""
    m = re.match(r"([A-Z]{2})(\d+)(NE|NW|SE|SW)?_", fname)
    if not m:
        return None
    g, digits, quad = m.groups()
    if len(digits) % 2:
        return None
    try:
        e0, n0 = _grid_origin(g)
    except ValueError:
        return None
    half = len(digits) // 2
    size = 10 ** (5 - half)
    e = e0 + int(digits[:half]) * size
    n = n0 + int(digits[half:]) * size
    if quad:
        size //= 2
        e += size if quad[1] == "E" else 0
        n += size if quad[0] == "N" else 0
    return e, n, size


def _list_bucket() -> list[tuple[str, int]]:
    require_online("the Scottish LiDAR tile index")
    keys, token = [], None
    while True:
        url = f"{BUCKET}/?list-type=2&prefix=lidar/&max-keys=1000"
        if token:
            url += "&continuation-token=" + urllib.parse.quote(token)
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=60) as r:
            x = r.read().decode()
        for k, s in re.findall(r"<Key>([^<]+)</Key>.*?<Size>(\d+)</Size>", x):
            if "/dtm/" in k and k.lower().endswith(".tif"):
                keys.append((k, int(s)))
        m = re.search(r"<NextContinuationToken>([^<]+)<", x)
        if not m:
            return keys
        token = m.group(1)


def tile_index(cache_dir: Path, force: bool = False) -> list[dict]:
    """Every DTM tile in the bucket with its National Grid extent."""
    path = Path(cache_dir) / "scottish_lidar_index_v1.json"
    if path.exists() and not force and time.time() - path.stat().st_mtime < INDEX_MAX_AGE_S:
        return json.loads(path.read_text())
    try:
        keys = _list_bucket()
    except Exception:
        if path.exists():          # stale is better than nothing
            log.warning("Could not refresh the LiDAR tile index; using the cached copy")
            return json.loads(path.read_text())
        raise
    out = []
    for k, size in keys:
        ext = tile_extent(k.rsplit("/", 1)[-1])
        if ext:
            out.append({"key": k, "programme": k.split("/")[1], "e": ext[0], "n": ext[1],
                        "size": ext[2], "bytes": size})
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out))
    log.info("Scottish LiDAR index: %d DTM tiles", len(out))
    return out


def _rank(t: dict) -> tuple:
    p = t["programme"]
    return (PRIORITY.index(p) if p in PRIORITY else len(PRIORITY), t["size"])


def read_dtm(bounds: tuple[float, float, float, float], cache_dir: Path,
             res_m: float = 2.0, force: bool = False):
    """Mosaic the DTM over National Grid ``bounds`` (e0, n0, e1, n1) at ``res_m``.

    Returns (grid float32 with NaN gaps, (e0, n1) top-left, programmes used).
    Raises RuntimeError if no tile overlaps.
    """
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.windows import from_bounds

    e0, n0, e1, n1 = bounds
    cols, rows = int(math.ceil((e1 - e0) / res_m)), int(math.ceil((n1 - n0) / res_m))
    e1, n0 = e0 + cols * res_m, n1 - rows * res_m
    tiles = [t for t in tile_index(cache_dir, force)
             if t["e"] < e1 and t["e"] + t["size"] > e0 and t["n"] < n1 and t["n"] + t["size"] > n0]
    if not tiles:
        raise RuntimeError("no Scottish LiDAR tiles overlap this area")
    tiles.sort(key=_rank)
    out = np.full((rows, cols), np.nan, dtype=np.float32)
    used: list[str] = []
    env = dict(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif",
               GDAL_HTTP_MULTIRANGE="YES", GDAL_HTTP_MERGE_CONSECUTIVE_RANGES="YES",
               VSI_CACHE="TRUE", GDAL_HTTP_MAX_RETRY="3", GDAL_HTTP_RETRY_DELAY="2")
    with rasterio.Env(**env):
        for t in tiles:
            if not np.isnan(out).any():
                break
            # This tile's overlap, snapped to the output grid.
            c0 = max(0, int((t["e"] - e0) // res_m)); c1 = min(cols, int(math.ceil((t["e"] + t["size"] - e0) / res_m)))
            r0 = max(0, int((n1 - (t["n"] + t["size"])) // res_m)); r1 = min(rows, int(math.ceil((n1 - t["n"]) / res_m)))
            if c1 <= c0 or r1 <= r0:
                continue
            hole = np.isnan(out[r0:r1, c0:c1])
            if not hole.any():
                continue
            require_online(f"LiDAR tile {t['key']}")
            try:
                with rasterio.open(f"/vsicurl/{BUCKET}/{t['key']}") as src:
                    win = from_bounds(e0 + c0 * res_m, n1 - r1 * res_m, e0 + c1 * res_m, n1 - r0 * res_m,
                                      src.transform)
                    data = src.read(1, window=win, out_shape=(r1 - r0, c1 - c0), boundless=True,
                                    fill_value=src.nodata if src.nodata is not None else -9999,
                                    resampling=Resampling.average).astype(np.float32)
                    nod = src.nodata
            except Exception as e:      # one bad tile should not sink the mosaic
                log.warning("LiDAR tile %s unreadable (%s); skipping", t["key"], e)
                continue
            if nod is not None:
                data[data == nod] = np.nan
            data[(data < -50) | (data > 1400)] = np.nan       # Scotland: below -50 m or above Ben Nevis
            take = hole & ~np.isnan(data)
            if take.any():
                block = out[r0:r1, c0:c1]
                block[take] = data[take]
                if t["programme"] not in used:
                    used.append(t["programme"])
    if not used:
        raise RuntimeError("Scottish LiDAR tiles overlap this area but hold no data")
    return out, (e0, n1), used
