"""Elevation provider: Scottish LIDAR → EA WCS → Copernicus GLO-30 → SRTM fallback.

UK LIDAR sources provide 50cm–1m resolution for Scotland and England,
falling back to Copernicus 30m / SRTM 30m globally.
"""

import gzip
import logging
import math
import urllib.request
from pathlib import Path

import numpy as np

from . import BBox, ProviderResult, DEFAULT_CACHE, USER_AGENT, require_online

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# UK detection + OSGB grid helpers
# ---------------------------------------------------------------------------

def _is_uk_bbox(bbox: BBox) -> bool:
    """Check if bbox is within the UK (approximate)."""
    return (49.5 < bbox.min_lat < 61.0 and
            49.5 < bbox.max_lat < 61.0 and
            -8.5 < bbox.min_lon < 2.5 and
            -8.5 < bbox.max_lon < 2.5)


def _is_scotland_bbox(bbox: BBox) -> bool:
    """Check if bbox centre is in Scotland (north of ~55.3°N)."""
    centre_lat = (bbox.min_lat + bbox.max_lat) / 2
    return _is_uk_bbox(bbox) and centre_lat > 55.3


def _is_england_bbox(bbox: BBox) -> bool:
    """Check if bbox centre is in England (south of ~55.8°N, rough)."""
    centre_lat = (bbox.min_lat + bbox.max_lat) / 2
    return _is_uk_bbox(bbox) and centre_lat < 55.8


def _latlon_to_osgb(lon: float, lat: float) -> tuple:
    """Convert WGS84 lat/lon to OSGB36 easting/northing using pyproj."""
    from pyproj import Transformer
    t = Transformer.from_crs('EPSG:4326', 'EPSG:27700', always_xy=True)
    return t.transform(lon, lat)


# Primary 500km squares in the OS grid
_PRIMARY = {
    'S': (0, 0), 'T': (500000, 0),
    'N': (0, 500000), 'O': (500000, 500000),
    'H': (0, 1000000),
}
# Secondary 100km squares (A–Z omitting I)
_SECONDARY = 'ABCDEFGHJKLMNOPQRSTUVWXYZ'


def _osgb_to_gridref(easting: float, northing: float):
    """Convert OSGB easting/northing to 10km grid square + 5km quadrant.

    Returns (grid_10km, quadrant) e.g. ('NT37', 'SW').
    """
    for letter, (e0, n0) in _PRIMARY.items():
        if e0 <= easting < e0 + 500000 and n0 <= northing < n0 + 500000:
            pe, pn = easting - e0, northing - n0
            si = int(pe // 100000)
            sj = int(pn // 100000)
            idx = (4 - sj) * 5 + si
            sec = _SECONDARY[idx]
            re = pe % 100000
            rn = pn % 100000
            d1 = int(re // 10000)
            d2 = int(rn // 10000)
            qe = 1 if (re % 10000) >= 5000 else 0
            qn = 1 if (rn % 10000) >= 5000 else 0
            quads = {(0, 0): 'SW', (1, 0): 'SE', (0, 1): 'NW', (1, 1): 'NE'}
            return f'{letter}{sec}{d1}{d2}', quads[(qe, qn)]
    return None, None


def _bbox_osgb_bounds(bbox: BBox, pad_m: float = 0.0) -> tuple:
    """OSGB bounds covering the bbox, from all FOUR corners plus padding.

    The OSGB grid is rotated ~1° relative to the lat/lon graticule at
    Scottish longitudes; using only two corners under-covers the bbox.
    """
    corners = [(bbox.min_lon, bbox.min_lat), (bbox.min_lon, bbox.max_lat),
               (bbox.max_lon, bbox.min_lat), (bbox.max_lon, bbox.max_lat)]
    es, ns = zip(*[_latlon_to_osgb(lon, lat) for lon, lat in corners])
    return (min(es) - pad_m, min(ns) - pad_m,
            max(es) + pad_m, max(ns) + pad_m)


def _bbox_to_quadrant_tiles(bbox: BBox, pad_m: float = 0.0) -> list:
    """Find all 5km quadrant tile names that cover the bbox.

    Returns list of (grid_10km, quadrant) tuples e.g. [('NT37', 'SW')].
    """
    e1, n1, e2, n2 = _bbox_osgb_bounds(bbox, pad_m)

    # Expand to 5km grid boundaries
    e_min = int(e1 // 5000) * 5000
    n_min = int(n1 // 5000) * 5000
    e_max = int(e2 // 5000) * 5000
    n_max = int(n2 // 5000) * 5000

    tiles = set()
    for e in range(e_min, e_max + 5000, 5000):
        for n in range(n_min, n_max + 5000, 5000):
            ref, quad = _osgb_to_gridref(e + 2500, n + 2500)  # centre of 5km cell
            if ref is not None:
                tiles.add((ref, quad))
    return sorted(tiles)


# ---------------------------------------------------------------------------
# Scottish Government LIDAR via S3 (50cm DTM)
# ---------------------------------------------------------------------------

# Phases in preference order (newest first)
_SCOTTISH_PHASES = [
    'national-lidar-programme',
    'phase-6', 'phase-5', 'phase-4', 'phase-3', 'phase-2', 'phase-1',
]

_S3_BASE = 'https://srsp-open-data.s3.eu-west-2.amazonaws.com'


def _scottish_tile_url(phase: str, grid10: str, quad: str) -> str:
    """Build the S3 HTTPS URL for a Scottish LIDAR 5km quadrant tile."""
    # Phase 1 used 10km tiles with 1m resolution (different naming)
    if phase == 'phase-1':
        fname = f'{grid10}_1M_DTM_PHASE1.tif'
    elif phase == 'national-lidar-programme':
        # National programme uses 1km tiles — not 5km quadrants
        # We handle this differently; this function is for quadrant tiles only
        return None
    else:
        phase_label = phase.upper().replace('-', '')
        fname = f'{grid10}{quad}_50CM_DTM_{phase_label}.tif'
    return f'{_S3_BASE}/lidar/{phase}/dtm/27700/gridded/{fname}'


def _try_download(url: str, timeout: int = 120) -> bytes:
    """Try to download a URL, return bytes or raise."""
    require_online(url)
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _find_scottish_tile_url(grid10: str, quad: str) -> tuple:
    """Find the best available Scottish LIDAR tile URL, newest phase first.

    Returns (url, phase) or raises RuntimeError.
    Uses HEAD requests to check availability without downloading.
    """
    for phase in _SCOTTISH_PHASES:
        if phase in ('national-lidar-programme', 'phase-1'):
            continue  # different tile format, skip

        url = _scottish_tile_url(phase, grid10, quad)
        if url is None:
            continue

        try:
            req = urllib.request.Request(url, method='HEAD',
                                        headers={'User-Agent': USER_AGENT})
            with urllib.request.urlopen(req, timeout=10) as r:
                if r.status == 200:
                    log.info('  Found %s%s in %s', grid10, quad, phase)
                    return url, phase
        except Exception:
            continue

    raise RuntimeError(f'No Scottish LIDAR coverage for {grid10}{quad}')


def _fetch_scottish_lidar(bbox: BBox, cache_dir: Path):
    """Fetch Scottish LIDAR for bbox using windowed reads via /vsicurl/.

    Uses rasterio's virtual filesystem to read only the pixels we need
    from each S3-hosted GeoTIFF, avoiding multi-hundred-MB downloads.

    Returns (cropped_elev, extent_dict, phase_info).
    """
    import rasterio
    from rasterio.windows import from_bounds

    # Pad the source window 100 m so reprojection has full edge support
    PAD_M = 100.0
    tiles_needed = _bbox_to_quadrant_tiles(bbox, pad_m=PAD_M)
    log.info('Scottish LIDAR: %d quadrant tile(s) needed: %s',
             len(tiles_needed), tiles_needed)

    # OSGB bounds covering the bbox (all four corners + padding)
    e_min, n_min, e_max, n_max = _bbox_osgb_bounds(bbox, pad_m=PAD_M)

    # Check which tiles have data and find their URLs
    tile_urls = {}
    phases_used = set()
    for grid10, quad in tiles_needed:
        try:
            url, phase = _find_scottish_tile_url(grid10, quad)
            tile_urls[(grid10, quad)] = url
            phases_used.add(phase)
        except RuntimeError:
            log.warning('  No coverage for %s%s', grid10, quad)

    if not tile_urls:
        raise RuntimeError('No Scottish LIDAR tiles available for bbox')

    def _read_window(src, window):
        """Read a window and replace nodata with NaN."""
        data = src.read(1, window=window).astype(np.float32)
        if src.nodata is not None:
            data[data == src.nodata] = np.nan
        return data

    # For the common case of a single tile, do a simple windowed read
    if len(tile_urls) == 1:
        url = next(iter(tile_urls.values()))
        vsicurl = f'/vsicurl/{url}'
        with rasterio.open(vsicurl) as src:
            window = from_bounds(e_min, n_min, e_max, n_max, src.transform)
            elev = _read_window(src, window)
            # Compute the actual bounds of the window we read
            win_transform = src.window_transform(window)
            rows, cols = elev.shape
            crop_w = win_transform.c
            crop_n = win_transform.f
            crop_e = crop_w + cols * win_transform.a
            crop_s = crop_n + rows * win_transform.e
            res_x, res_y = abs(win_transform.a), abs(win_transform.e)
    else:
        # Multiple tiles: read each window and stitch
        tile_reads = []
        for (grid10, quad), url in tile_urls.items():
            vsicurl = f'/vsicurl/{url}'
            with rasterio.open(vsicurl) as src:
                # Clip the requested bbox to this tile's bounds
                tb = src.bounds
                clip_w = max(e_min, tb.left)
                clip_s = max(n_min, tb.bottom)
                clip_e = min(e_max, tb.right)
                clip_n = min(n_max, tb.top)
                if clip_w >= clip_e or clip_s >= clip_n:
                    continue
                window = from_bounds(clip_w, clip_s, clip_e, clip_n, src.transform)
                data = _read_window(src, window)
                wt = src.window_transform(window)
                tile_reads.append((data, wt, clip_w, clip_s, clip_e, clip_n))

        if not tile_reads:
            raise RuntimeError('No data read from Scottish LIDAR tiles')

        # Compute global bounds and stitch
        crop_w = min(t[2] for t in tile_reads)
        crop_s = min(t[3] for t in tile_reads)
        crop_e = max(t[4] for t in tile_reads)
        crop_n = max(t[5] for t in tile_reads)
        res = abs(tile_reads[0][1].a)
        res_x = res_y = res
        big_cols = int(round((crop_e - crop_w) / res))
        big_rows = int(round((crop_n - crop_s) / res))
        elev = np.full((big_rows, big_cols), np.nan, dtype=np.float32)

        for data, wt, cw, cs, ce, cn in tile_reads:
            c_off = max(0, int(round((cw - crop_w) / res)))
            r_off = max(0, int(round((crop_n - cn) / res)))
            h, w = data.shape
            # Windowed reads round bounds to whole pixels and can return
            # one more row/column than the mosaic allows — clip to fit,
            # otherwise the broadcast error silently dropped the whole
            # LIDAR source and the build fell back to 30 m Copernicus.
            r1 = min(r_off + h, big_rows)
            c1 = min(c_off + w, big_cols)
            if r1 <= r_off or c1 <= c_off:
                continue
            elev[r_off:r1, c_off:c1] = data[:r1 - r_off, :c1 - c_off]

    # --- Reproject OSGB-aligned grid to a lat/lon-aligned grid ---
    # OSGB north is rotated ~1° from true north at Scottish longitudes.
    # Treating the OSGB grid as lat/lon-aligned skewed the terrain by up
    # to ~10-20 m at bbox edges (misaligning roads/buildings with the
    # terrain) and made the model extent slightly mismatch the requested
    # bbox (leaving sea/road slivers at the print edge).  Resample onto a
    # geographic grid covering EXACTLY the requested bbox.
    from rasterio.transform import from_origin
    from rasterio.warp import reproject, Resampling

    src_transform = from_origin(crop_w, crop_n, res_x, res_y)
    mid_lat = (bbox.min_lat + bbox.max_lat) / 2
    res_lat = res_y / 111320.0
    res_lon = res_x / (111320.0 * math.cos(math.radians(mid_lat)))
    dst_h = max(2, int(math.ceil((bbox.max_lat - bbox.min_lat) / res_lat)))
    dst_w = max(2, int(math.ceil((bbox.max_lon - bbox.min_lon) / res_lon)))
    dst_transform = from_origin(
        bbox.min_lon, bbox.max_lat,
        (bbox.max_lon - bbox.min_lon) / dst_w,
        (bbox.max_lat - bbox.min_lat) / dst_h)
    dst = np.full((dst_h, dst_w), np.nan, dtype=np.float32)
    reproject(
        source=elev, destination=dst,
        src_transform=src_transform, src_crs='EPSG:27700',
        dst_transform=dst_transform, dst_crs='EPSG:4326',
        src_nodata=np.nan, dst_nodata=np.nan,
        resampling=Resampling.bilinear)
    elev = dst
    extent = {'north': bbox.max_lat, 'south': bbox.min_lat,
              'west': bbox.min_lon, 'east': bbox.max_lon}

    log.info('Scottish LIDAR: %s (reprojected to EPSG:4326), '
             'range %.1f-%.1f m, phases: %s',
             elev.shape, np.nanmin(elev), np.nanmax(elev),
             ', '.join(phases_used))

    return elev, extent, ', '.join(sorted(phases_used))


# ---------------------------------------------------------------------------
# Copernicus GLO-30 DEM (30 m, global)
# ---------------------------------------------------------------------------

def _copernicus_tile_url(lat: int, lon: int) -> str:
    """Build the S3 HTTPS URL for a Copernicus 1°×1° GeoTIFF tile."""
    ns = "N" if lat >= 0 else "S"
    ew = "E" if lon >= 0 else "W"
    tile = f"Copernicus_DSM_COG_10_{ns}{abs(lat):02d}_00_{ew}{abs(lon):03d}_00_DEM"
    return (
        f"https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com/"
        f"{tile}/{tile}.tif"
    )


def _fetch_copernicus_tile(lat: int, lon: int, cache_dir: Path):
    """Download one Copernicus 1°×1° tile. Returns (np.ndarray, affine-like metadata)."""
    import io
    import rasterio

    ns = "N" if lat >= 0 else "S"
    ew = "E" if lon >= 0 else "W"
    tile_name = f"Cop30_{ns}{abs(lat):02d}_{ew}{abs(lon):03d}"
    cached_npy = cache_dir / f"{tile_name}.npy"

    if cached_npy.exists():
        log.info("  Using cached Copernicus tile %s", tile_name)
        data = np.load(str(cached_npy), allow_pickle=True).item()
        return data["elev"], data["transform"]

    url = _copernicus_tile_url(lat, lon)
    log.info("  Fetching Copernicus tile %s", tile_name)

    try:
        with urllib.request.urlopen(url, timeout=120) as r:
            tif_bytes = r.read()
    except Exception as e:
        raise RuntimeError(f"Copernicus tile {tile_name} download failed: {e}") from e

    with rasterio.open(io.BytesIO(tif_bytes)) as src:
        elev = src.read(1).astype(np.float32)
        transform = src.transform

    # Cache as numpy for faster reload
    np.save(str(cached_npy), {"elev": elev, "transform": transform})

    return elev, transform


def _fetch_copernicus_windowed(bbox: BBox):
    """Read ONLY the bbox window from Copernicus COG tiles via /vsicurl/.

    Copernicus tiles are Cloud-Optimised GeoTIFFs, so rasterio can issue
    HTTP range requests for just the rows/columns we need instead of
    downloading whole ~50–100 MB tiles.  Returns (elev, extent_dict).
    """
    import rasterio
    from rasterio.windows import from_bounds as win_from_bounds

    lat_tiles = list(range(math.floor(bbox.min_lat), math.floor(bbox.max_lat) + 1))
    lon_tiles = list(range(math.floor(bbox.min_lon), math.floor(bbox.max_lon) + 1))

    # Pad bbox slightly so downstream interpolation has edge support
    pad = 0.001
    want_w, want_s = bbox.min_lon - pad, bbox.min_lat - pad
    want_e, want_n = bbox.max_lon + pad, bbox.max_lat + pad

    reads = []
    for tla in lat_tiles:
        for tlo in lon_tiles:
            url = _copernicus_tile_url(tla, tlo)
            with rasterio.open(f"/vsicurl/{url}") as src:
                tb = src.bounds
                cw, cs = max(want_w, tb.left), max(want_s, tb.bottom)
                ce, cn = min(want_e, tb.right), min(want_n, tb.top)
                if cw >= ce or cs >= cn:
                    continue
                window = win_from_bounds(cw, cs, ce, cn, src.transform)
                data = src.read(1, window=window).astype(np.float32)
                wt = src.window_transform(window)
                rows, cols = data.shape
                a_w = wt.c
                a_n = wt.f
                a_e = a_w + cols * wt.a
                a_s = a_n + rows * wt.e
                reads.append((data, a_w, a_s, a_e, a_n))

    if not reads:
        raise RuntimeError("Copernicus windowed read returned no data")

    if len(reads) == 1:
        elev = reads[0][0]
        _, a_w, a_s, a_e, a_n = reads[0]
        extent = {"north": a_n, "south": a_s, "west": a_w, "east": a_e}
    else:
        # Stitch multiple windows on a common grid
        res_x = (reads[0][3] - reads[0][1]) / reads[0][0].shape[1]
        res_y = (reads[0][4] - reads[0][2]) / reads[0][0].shape[0]
        g_w = min(r[1] for r in reads); g_s = min(r[2] for r in reads)
        g_e = max(r[3] for r in reads); g_n = max(r[4] for r in reads)
        big_cols = int(round((g_e - g_w) / res_x))
        big_rows = int(round((g_n - g_s) / res_y))
        elev = np.zeros((big_rows, big_cols), dtype=np.float32)
        for data, a_w, a_s, a_e, a_n in reads:
            c_off = int(round((a_w - g_w) / res_x))
            r_off = int(round((g_n - a_n) / res_y))
            h, w = data.shape
            r1 = min(r_off + h, big_rows); c1 = min(c_off + w, big_cols)
            elev[r_off:r1, c_off:c1] = data[:r1 - r_off, :c1 - c_off]
        extent = {"north": g_n, "south": g_s, "west": g_w, "east": g_e}

    log.info("Copernicus windowed read: %s, extent %.5f–%.5f N, %.5f–%.5f E",
             elev.shape, extent["south"], extent["north"],
             extent["west"], extent["east"])
    return elev, extent


def _fetch_copernicus(bbox: BBox, cache_dir: Path):
    """Fetch Copernicus elevation for bbox.

    Tries an efficient windowed COG read first (downloads only the pixels
    needed); falls back to whole-tile download + stitch + crop.
    Returns (cropped_elev, extent_dict).
    """
    require_online("Copernicus GLO-30 tiles")
    try:
        return _fetch_copernicus_windowed(bbox)
    except Exception as e:
        log.warning("Copernicus windowed read failed (%s) — "
                    "falling back to full-tile download", e)

    lat_tiles = list(range(math.floor(bbox.min_lat), math.floor(bbox.max_lat) + 1))
    lon_tiles = list(range(math.floor(bbox.min_lon), math.floor(bbox.max_lon) + 1))
    log.info("Copernicus tiles needed: %d lat x %d lon = %d",
             len(lat_tiles), len(lon_tiles), len(lat_tiles) * len(lon_tiles))

    tiles = {}
    for tla in lat_tiles:
        for tlo in lon_tiles:
            tiles[(tla, tlo)] = _fetch_copernicus_tile(tla, tlo, cache_dir)

    # All tiles should be the same resolution (3601×3601 for 1-arcsec)
    sample_elev = next(iter(tiles.values()))[0]
    tile_rows, tile_cols = sample_elev.shape

    n_lat = len(lat_tiles)
    n_lon = len(lon_tiles)
    big = np.zeros((n_lat * tile_rows, n_lon * tile_cols), dtype=np.float32)

    # Tiles are arranged: highest lat at top
    for i, tla in enumerate(reversed(sorted(lat_tiles))):
        for j, tlo in enumerate(sorted(lon_tiles)):
            elev_tile, _ = tiles[(tla, tlo)]
            r_off = i * tile_rows
            c_off = j * tile_cols
            big[r_off:r_off + tile_rows, c_off:c_off + tile_cols] = elev_tile

    # Grid extent
    grid_north = max(lat_tiles) + 1
    grid_south = min(lat_tiles)
    grid_west = min(lon_tiles)
    grid_east = max(lon_tiles) + 1
    total_rows, total_cols = big.shape

    # Crop to bbox
    def latlon_to_rc(lat, lon):
        r = (grid_north - lat) / (grid_north - grid_south) * (total_rows - 1)
        c = (lon - grid_west) / (grid_east - grid_west) * (total_cols - 1)
        return r, c

    r0, c0 = latlon_to_rc(bbox.max_lat, bbox.min_lon)
    r1, c1 = latlon_to_rc(bbox.min_lat, bbox.max_lon)
    r0 = max(0, int(math.floor(r0)) - 1)
    r1 = min(total_rows - 1, int(math.ceil(r1)) + 1)
    c0 = max(0, int(math.floor(c0)) - 1)
    c1 = min(total_cols - 1, int(math.ceil(c1)) + 1)
    cropped = big[r0:r1 + 1, c0:c1 + 1]

    extent = {
        "north": grid_north - r0 / (total_rows - 1) * (grid_north - grid_south),
        "south": grid_north - r1 / (total_rows - 1) * (grid_north - grid_south),
        "west":  grid_west + c0 / (total_cols - 1) * (grid_east - grid_west),
        "east":  grid_west + c1 / (total_cols - 1) * (grid_east - grid_west),
    }

    log.info("Copernicus: stitched %dx%d tiles -> %s, cropped to %s",
             n_lat, n_lon, big.shape, cropped.shape)
    log.info("Extent: %.5f–%.5f N, %.5f–%.5f E",
             extent["south"], extent["north"], extent["west"], extent["east"])
    log.info("Elev range: %.0f–%.0f m", cropped.min(), cropped.max())

    return cropped, extent


# ---------------------------------------------------------------------------
# SRTM v3 fallback (ported from multi-extruder)
# ---------------------------------------------------------------------------

def _fetch_srtm_tile(tile_lat: int, tile_lon: int, cache_dir: Path):
    """Download and decode a single SRTM .hgt tile (from Mapzen's S3 mirror)."""
    ns = "N" if tile_lat >= 0 else "S"
    ew = "E" if tile_lon >= 0 else "W"
    tile_name = f"{ns}{abs(tile_lat):02d}{ew}{abs(tile_lon):03d}"
    url = (f"https://s3.amazonaws.com/elevation-tiles-prod/skadi/"
           f"{ns}{abs(tile_lat):02d}/{tile_name}.hgt.gz")

    cached = cache_dir / f"{tile_name}.hgt.gz.npy"
    if cached.exists():
        log.info("  Using cached SRTM tile %s", tile_name)
        elev = np.load(str(cached))
        return elev, elev.shape[0]

    require_online(f"SRTM tile {tile_name}")
    log.info("  Fetching SRTM tile %s", tile_name)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=120) as r:
        raw = r.read()
    decompressed = gzip.decompress(raw)
    N = int(math.sqrt(len(decompressed) / 2))
    elev = np.frombuffer(decompressed, dtype=">i2").reshape(N, N).astype(np.float32)

    # Fill voids
    voids = elev <= -1000
    if voids.any():
        elev[voids] = float(np.median(elev[~voids]))

    np.save(str(cached), elev)
    return elev, N


def _fetch_srtm(bbox: BBox, cache_dir: Path):
    """Fetch SRTM tiles covering bbox, stitch and crop.

    Returns (cropped_elev, extent_dict).
    """
    lat_tiles = list(range(math.floor(bbox.min_lat), math.floor(bbox.max_lat) + 1))
    lon_tiles = list(range(math.floor(bbox.min_lon), math.floor(bbox.max_lon) + 1))
    log.info("SRTM tiles needed: %d lat x %d lon = %d",
             len(lat_tiles), len(lon_tiles), len(lat_tiles) * len(lon_tiles))

    tiles = {}
    for tla in lat_tiles:
        for tlo in lon_tiles:
            tiles[(tla, tlo)] = _fetch_srtm_tile(tla, tlo, cache_dir)

    N = next(iter(tiles.values()))[1]
    n_lat = len(lat_tiles)
    n_lon = len(lon_tiles)
    big_rows = n_lat * (N - 1) + 1
    big_cols = n_lon * (N - 1) + 1
    big = np.zeros((big_rows, big_cols), dtype=np.float32)

    for i, tla in enumerate(reversed(sorted(lat_tiles))):
        for j, tlo in enumerate(sorted(lon_tiles)):
            elev_tile, _ = tiles[(tla, tlo)]
            r_off = i * (N - 1)
            c_off = j * (N - 1)
            big[r_off:r_off + N, c_off:c_off + N] = elev_tile

    grid_north = max(lat_tiles) + 1
    grid_south = min(lat_tiles)
    grid_west = min(lon_tiles)
    grid_east = max(lon_tiles) + 1

    def latlon_to_rc(lat, lon):
        return ((grid_north - lat) / (grid_north - grid_south) * (big_rows - 1),
                (lon - grid_west) / (grid_east - grid_west) * (big_cols - 1))

    r0, c0 = latlon_to_rc(bbox.max_lat, bbox.min_lon)
    r1, c1 = latlon_to_rc(bbox.min_lat, bbox.max_lon)
    r0 = max(0, int(math.floor(r0)) - 1)
    r1 = min(big_rows - 1, int(math.ceil(r1)) + 1)
    c0 = max(0, int(math.floor(c0)) - 1)
    c1 = min(big_cols - 1, int(math.ceil(c1)) + 1)
    cropped = big[r0:r1 + 1, c0:c1 + 1]

    extent = {
        "north": grid_north - r0 / (big_rows - 1) * (grid_north - grid_south),
        "south": grid_north - r1 / (big_rows - 1) * (grid_north - grid_south),
        "west":  grid_west + c0 / (big_cols - 1) * (grid_east - grid_west),
        "east":  grid_west + c1 / (big_cols - 1) * (grid_east - grid_west),
    }

    log.info("SRTM: stitched %dx%d tiles -> %s, cropped to %s",
             n_lat, n_lon, big.shape, cropped.shape)
    log.info("Extent: %.5f–%.5f N, %.5f–%.5f E",
             extent["south"], extent["north"], extent["west"], extent["east"])
    log.info("Elev range: %.0f–%.0f m", cropped.min(), cropped.max())

    return cropped, extent


# ---------------------------------------------------------------------------
# Public interface
# ---------------------------------------------------------------------------

def fetch(bbox: BBox, cache_dir: Path = DEFAULT_CACHE, **kwargs) -> ProviderResult:
    """Fetch elevation grid for bbox.

    Priority:
      1. Scottish LIDAR (50cm, Scotland only)
      2. Copernicus GLO-30 (30m, global)
      3. SRTM v3 (30m, 60°N–56°S)

    Returns ProviderResult where:
      .data = {"elev": np.ndarray, "extent": dict}
      .source = "scottish-lidar-{phase}" or "copernicus-30m" or "srtm-30m"
      .metadata includes extent, shape, elev range
    """
    cache = Path(cache_dir) / "elevation"
    cache.mkdir(parents=True, exist_ok=True)

    # Bbox-keyed result cache — avoids re-fetching LIDAR/DEM windows on
    # every rebuild of the same area.  v2: LIDAR grids are now reprojected
    # to EPSG:4326; v1 caches held OSGB-skewed grids and must not be used.
    bbox_key = (f"{bbox.min_lat:.5f}_{bbox.max_lat:.5f}"
                f"_{bbox.min_lon:.5f}_{bbox.max_lon:.5f}")
    result_cache = cache / f"elev_v2_{kwargs.get('prefer', 'auto')}_{bbox_key}.npz"
    if result_cache.exists() and not kwargs.get("force"):
        try:
            cached = np.load(str(result_cache), allow_pickle=True)
            elev = cached["elev"]
            extent = cached["extent"].item()
            source = str(cached["source"])
            log.info("Using cached elevation (%s, %s)", source, elev.shape)
            return ProviderResult(
                data={"elev": elev, "extent": extent},
                source=source, cached=True,
                metadata={"shape": list(elev.shape),
                          "elev_min": float(elev.min()),
                          "elev_max": float(elev.max()),
                          "extent": extent})
        except Exception as e:
            log.warning("Elevation cache unreadable (%s) — refetching", e)

    def _save_result(elev, extent, source):
        try:
            np.savez_compressed(str(result_cache), elev=elev,
                                extent=np.array(extent, dtype=object),
                                source=source)
        except Exception as e:
            log.warning("Could not write elevation cache: %s", e)

    # ``prefer`` pins a single source (e.g. "srtm" for the parity build
    # against the multi-extruder reference); "auto" uses the priority order.
    prefer = kwargs.get("prefer", "auto")
    if prefer == "srtm":
        elev, extent = _fetch_srtm(bbox, cache)
        source = "srtm-30m"
        _save_result(elev, extent, source)
        return ProviderResult(
            data={"elev": elev, "extent": extent}, source=source, cached=False,
            metadata={"shape": list(elev.shape), "elev_min": float(elev.min()),
                      "elev_max": float(elev.max()), "extent": extent})
    if prefer == "copernicus":
        elev, extent = _fetch_copernicus(bbox, cache)
        source = "copernicus-30m"
        _save_result(elev, extent, source)
        return ProviderResult(
            data={"elev": elev, "extent": extent}, source=source, cached=False,
            metadata={"shape": list(elev.shape), "elev_min": float(elev.min()),
                      "elev_max": float(elev.max()), "extent": extent})

    # Try Scottish LIDAR first for Scotland bboxes
    if _is_scotland_bbox(bbox):
        try:
            elev, extent, phases = _fetch_scottish_lidar(bbox, cache)
            # Replace NaN gaps with 0 (sea level) if present
            nan_mask = np.isnan(elev)
            if nan_mask.any():
                log.warning('Scottish LIDAR: %d NaN pixels (%.1f%%), filling with 0',
                            nan_mask.sum(), 100 * nan_mask.mean())
                elev[nan_mask] = 0.0
            source = f"scottish-lidar-{phases}"
            _save_result(elev, extent, source)
            return ProviderResult(
                data={"elev": elev, "extent": extent},
                source=source,
                cached=False,
                metadata={
                    "shape": list(elev.shape),
                    "elev_min": float(elev.min()),
                    "elev_max": float(elev.max()),
                    "extent": extent,
                    "resolution_m": 0.5,
                },
            )
        except Exception as e:
            log.warning("Scottish LIDAR failed (%s), falling back to Copernicus", e)

    # Try Copernicus
    try:
        elev, extent = _fetch_copernicus(bbox, cache)
        source = "copernicus-30m"
    except Exception as e:
        log.warning("Copernicus failed (%s), falling back to SRTM", e)
        try:
            elev, extent = _fetch_srtm(bbox, cache)
            source = "srtm-30m"
        except Exception as e2:
            raise RuntimeError(
                f"All elevation sources failed. Copernicus: {e}; SRTM: {e2}"
            ) from e2

    _save_result(elev, extent, source)
    return ProviderResult(
        data={"elev": elev, "extent": extent},
        source=source,
        cached=False,
        metadata={
            "shape": list(elev.shape),
            "elev_min": float(elev.min()),
            "elev_max": float(elev.max()),
            "extent": extent,
        },
    )
