"""The build pipeline: providers -> terrain, buildings, roads, water ->
multi-object 3MF (+ optional single-colour STL) + manifest.

``_build_core`` is ported from ElchoMaps' ``build()`` (PLAN.md D1) with
only mechanical changes: ``args`` became ``opts``, the cache moved out of
the output folder (D8), and the elevation and buildings providers take a
source preference.  Do not restructure the geometry stages without the
parity test (``tests/test_parity.py``) and the geometry tests passing.
"""
from __future__ import annotations

import json
import logging
import math
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np
import trimesh
from scipy.ndimage import distance_transform_edt, gaussian_filter, zoom
from shapely import contains_xy as shapely_contains_xy
from shapely.geometry import LineString, Polygon
from shapely.ops import unary_union
from shapely.prepared import prep
from shapely.validation import make_valid

from . import __version__
from . import provenance
from .export.threemf import Part, export_3mf
from .geometry import checks
from .geometry.mesh import (clean_mesh, make_bilinear_sampler,
                            nudge_duplicate_vertices, safe_decimate,
                            separated_parts, slab_from_poly)
from .geometry.mesh import _rasterise_fast
from .providers import BBox, default_cache_dir
from .providers import buildings as bldg_provider
from .providers import coastline as coast_provider
from .providers import elevation as elev_provider
from .providers import roads as road_provider
from .providers import water as water_provider

log = logging.getLogger("hyperscale.build")

M_PER_DEG_LAT = 111_320.0

# Buildings whose footprint is >50 % inside the river shape grown by this
# buffer are dropped.  Keep it conservative: OSM river polygons are narrower
# than the real river, and a wide filter wipes out riverside buildings.
# Never above ~80 m (../CLAUDE.md); narrower suits canals.
RIVER_FILTER_BUFFER_M = 20.0
RIVER_FILTER_BUFFER_MAX_M = 80.0

DEFAULT_COLOURS = {
    "land":      "#8B7355",
    "buildings": "#C8C8C8",
    "roads":     "#3A3A3A",
    "water":     "#4488CC",
}

_TOTAL_STAGES = 21


def _progress(stage: int, label: str):
    log.info("[%3d%%] %s", int(stage / _TOTAL_STAGES * 100), label)


def _tick(msg: str):
    if sys.stderr.isatty():
        print("\r" + msg, end="", file=sys.stderr, flush=True)


@dataclass
class BuildOptions:
    min_lat: float
    max_lat: float
    min_lon: float
    max_lon: float
    name: str = ""
    print_size: float = 150.0
    z_exag: float = 2.0
    river_exag: float = 0.6
    building_exag: float = 1.0      # PLAN.md D2: true height by default
    roads: str = "major-residential"
    base: float = 5.0
    road_raise: float = 0.5
    river_width: float = 45.0
    sea_level: float = 3.0
    no_buildings: bool = False
    max_buildings: int | None = None
    elevation: str = "auto"         # auto | srtm | copernicus
    buildings_source: str = "osm"   # osm | overture
    stl: bool = False               # also write the single-colour union STL
    bambu_metadata: bool = True
    force: bool = False
    out_dir: str = "output"
    cache_dir: str | None = None
    colours: dict = field(default_factory=lambda: dict(DEFAULT_COLOURS))

    @property
    def bbox_id(self) -> str:
        return (f"{self.min_lat:.5f}_{self.max_lat:.5f}_"
                f"{self.min_lon:.5f}_{self.max_lon:.5f}")


def exaggeration_note(opts: BuildOptions) -> str:
    """The disclosure that must accompany every export (models are evidence)."""
    t = f"Height exaggerated ×{opts.z_exag:g}"
    if opts.building_exag == 1:
        return t + "; buildings at true height"
    return t + f"; buildings ×{opts.building_exag:g}"


def _build_core(opts, out_dir: Path, cache_dir: Path):

    bbox = BBox(opts.min_lat, opts.max_lat, opts.min_lon, opts.max_lon)

    sources = {}  # track provenance for manifest

    # ---- 1. Fetch elevation via provider ----
    _progress(1, "Fetching elevation")
    elev_result = elev_provider.fetch(bbox, cache_dir, force=opts.force,
                                      prefer=opts.elevation)
    elev_raw = elev_result.data["elev"]
    extent = elev_result.data["extent"]
    sources["elevation"] = elev_result.source
    log.info("Elevation source: %s, shape: %s", elev_result.source, elev_raw.shape)

    north, south = extent["north"], extent["south"]
    west, east = extent["west"], extent["east"]

    # ---- 1a. Regrid elevation to EXACTLY the requested bbox ----
    # Elevation sources may return a slightly larger extent (Copernicus
    # window padding, SRTM tile-crop margins).  Every other provider
    # fetches on the requested bbox, and the terrain footprint defines the
    # print outline — any mismatch leaves sea/roads stopping short of the
    # print edge.  Resample onto the requested bbox so all layers agree.
    if (abs(north - opts.max_lat) > 1e-9 or abs(south - opts.min_lat) > 1e-9 or
            abs(west - opts.min_lon) > 1e-9 or abs(east - opts.max_lon) > 1e-9):
        from scipy.ndimage import map_coordinates
        n_r, n_c = elev_raw.shape
        out_r = max(2, int(round((opts.max_lat - opts.min_lat) /
                                 max(north - south, 1e-12) * (n_r - 1))) + 1)
        out_c = max(2, int(round((opts.max_lon - opts.min_lon) /
                                 max(east - west, 1e-12) * (n_c - 1))) + 1)
        lats = np.linspace(opts.max_lat, opts.min_lat, out_r)
        lons = np.linspace(opts.min_lon, opts.max_lon, out_c)
        rr = (north - lats) / max(north - south, 1e-12) * (n_r - 1)
        cc = (lons - west) / max(east - west, 1e-12) * (n_c - 1)
        RR, CC = np.meshgrid(rr, cc, indexing="ij")
        elev_raw = map_coordinates(elev_raw.astype(np.float64), [RR, CC],
                                   order=1, mode="nearest").astype(np.float32)
        log.info("Regridded elevation from extent %.5f..%.5fN %.5f..%.5fE "
                 "to exact bbox: %s", south, north, west, east, elev_raw.shape)
        north, south = opts.max_lat, opts.min_lat
        west, east = opts.min_lon, opts.max_lon

    # ---- 1b. Downsample high-res elevation to print resolution ----
    # A 3D print can resolve ~0.2 mm; finer grids only add processing time
    # and file size.  Convert that to world metres for this bbox and never
    # build a grid finer than the print can show (floor of 2 m).
    mid_lat_approx = (north + south) / 2
    width_m_approx = (east - west) * M_PER_DEG_LAT * math.cos(math.radians(mid_lat_approx))
    height_m_approx = (north - south) * M_PER_DEG_LAT
    PRINT_RES_MM = 0.2
    TARGET_CELL_M = max(
        2.0, max(width_m_approx, height_m_approx) * PRINT_RES_MM / opts.print_size)
    log.info("Print-resolution cell target: %.2f m", TARGET_CELL_M)
    raw_cell_approx = width_m_approx / max(elev_raw.shape[1] - 1, 1)
    if raw_cell_approx < TARGET_CELL_M * 0.9:
        downsample = TARGET_CELL_M / raw_cell_approx
        new_shape = (int(elev_raw.shape[0] / downsample),
                     int(elev_raw.shape[1] / downsample))
        log.info("Downsampling LIDAR from %.2f m (shape %s) → ~%.1f m (shape %s)",
                 raw_cell_approx, elev_raw.shape, TARGET_CELL_M, new_shape)
        elev_raw = zoom(elev_raw.astype(float), 1.0 / downsample, order=3)
        log.info("Downsampled grid: %s", elev_raw.shape)

    # ---- 2. Fetch coastline via provider ----
    _progress(2, "Fetching coastline")
    coast_result = coast_provider.fetch(bbox, cache_dir, force=opts.force)
    sea_polys_ll = coast_result.data  # shapely Polygons in lat/lon
    sources["coastline"] = coast_result.source
    log.info("Coastline source: %s, %d sea polygons",
             coast_result.source, len(sea_polys_ll))

    # ---- 3. Fetch buildings via provider ----
    _progress(3, "Fetching buildings")
    if opts.no_buildings:
        buildings_in = []
        sources["buildings"] = "disabled"
    else:
        bldg_result = bldg_provider.fetch(bbox, cache_dir, prefer=opts.buildings_source)
        buildings_in = bldg_result.data
        sources["buildings"] = bldg_result.source
        if opts.max_buildings and len(buildings_in) > opts.max_buildings:
            log.info("Capping buildings at %d (fetched %d)", opts.max_buildings, len(buildings_in))
            buildings_in = buildings_in[:opts.max_buildings]
        log.info("Buildings source: %s, count: %d",
                 bldg_result.source, len(buildings_in))

    # ---- 4. Fetch roads via provider ----
    _progress(4, "Fetching roads")
    road_result = road_provider.fetch(bbox, cache_dir, roads_profile=opts.roads)
    roads_in = road_result.data
    sources["roads"] = road_result.source
    log.info("Roads source: %s, count: %d", road_result.source, len(roads_in))

    # ---- 5. Fetch inland water via provider ----
    _progress(5, "Fetching water")
    water_result = water_provider.fetch(bbox, cache_dir)
    waterways = water_result.data["waterways"]
    water_polys_in = water_result.data["water_polys"]
    tidal_polys_in = water_result.data.get("tidal_polys", [])
    sources["water"] = water_result.source
    log.info("Water source: %s, %d waterways, %d water polys, %d tidal polys",
             water_result.source, len(waterways), len(water_polys_in),
             len(tidal_polys_in))

    # ---- 6. Set up coordinate system ----
    _progress(6, "Setting up coordinates")
    mid_lat = (north + south) / 2
    M_PER_DEG_LON = M_PER_DEG_LAT * math.cos(math.radians(mid_lat))
    WIDTH_M = (east - west) * M_PER_DEG_LON
    HEIGHT_M = (north - south) * M_PER_DEG_LAT

    def project(lon, lat):
        return ((lon - west) * M_PER_DEG_LON,
                (lat - south) * M_PER_DEG_LAT)

    def project_arr(coords):
        """Vectorised projection of an iterable of (lon, lat) pairs."""
        c = np.asarray(coords, dtype=np.float64).reshape(-1, 2)
        out = np.empty_like(c)
        out[:, 0] = (c[:, 0] - west) * M_PER_DEG_LON
        out[:, 1] = (c[:, 1] - south) * M_PER_DEG_LAT
        return out

    log.info("Bbox in metres: %.0f x %.0f", WIDTH_M, HEIGHT_M)

    # ---- 7. Upsample elevation grid (adaptive, print-resolution capped) ----
    _progress(7, "Processing elevation grid")
    # Upsample coarse sources (SRTM/Copernicus) for smooth meshes, but never
    # beyond what the print can resolve — finer grids just cost time/memory.
    raw_cell_m = WIDTH_M / max(elev_raw.shape[1] - 1, 1)
    upsample_factor = int(np.clip(round(raw_cell_m / TARGET_CELL_M), 1, 3))
    sigma = {1: 0.3, 2: 0.4, 3: 0.6}[upsample_factor]
    log.info("Raw cell %.2f m, target %.2f m → upsample %d×, sigma %.1f",
             raw_cell_m, TARGET_CELL_M, upsample_factor, sigma)
    if upsample_factor > 1:
        elev_grid = zoom(gaussian_filter(elev_raw, sigma=sigma), upsample_factor, order=3)
    else:
        elev_grid = gaussian_filter(elev_raw.astype(float), sigma=sigma)
    n_rows, n_cols = elev_grid.shape
    xs_grid = np.linspace(0, WIDTH_M, n_cols)
    ys_grid = np.linspace(HEIGHT_M, 0, n_rows)
    cell_m = (WIDTH_M / (n_cols - 1) + HEIGHT_M / (n_rows - 1)) / 2
    log.info("Upsampled grid: %s, cell %.2f m", elev_grid.shape, cell_m)

    TERRAIN_BBOX = Polygon([(0, 0), (WIDTH_M, 0), (WIDTH_M, HEIGHT_M), (0, HEIGHT_M)])

    # ---- 7b. Sea mask from coastline provider polygons ----
    _progress(8, "Building sea mask")
    # The coastline provider delivers clean sea polygons in lat/lon.
    # Project them to local coords and rasterise.
    sea_polys = []
    for sp_ll in sea_polys_ll:
        # Project polygon coords
        try:
            ext_xy = project_arr(list(sp_ll.exterior.coords))
            holes_xy = [project_arr(list(hole.coords))
                        for hole in sp_ll.interiors]
            projected = Polygon(ext_xy, holes_xy)
            if not projected.is_valid:
                projected = make_valid(projected)
            clipped = projected.intersection(TERRAIN_BBOX)
            if not clipped.is_empty:
                if clipped.geom_type == "Polygon":
                    sea_polys.append(clipped)
                elif clipped.geom_type == "MultiPolygon":
                    sea_polys.extend(clipped.geoms)
        except Exception as e:
            log.warning("Skipping sea polygon projection: %s", e)

    sea_mask = np.zeros(elev_grid.shape, dtype=bool)
    if sea_polys:
        sea_shape = unary_union(sea_polys)
        sea_mask = _rasterise_fast(sea_shape, elev_grid.shape, xs_grid, ys_grid)
        log.info("Sea mask: %d/%d cells (%.1f%%)",
                 sea_mask.sum(), sea_mask.size, 100 * sea_mask.mean())

    # Add tidal polygons (wetland+tidal, mud flats) to sea_polys
    for tp in tidal_polys_in:
        xy = project_arr(tp["coords"])
        if len(xy) < 4:
            continue
        poly = Polygon(xy)
        if not poly.is_valid:
            poly = make_valid(poly)
        if poly.is_empty:
            continue
        clipped = poly.intersection(TERRAIN_BBOX)
        if clipped.is_empty:
            continue
        if clipped.geom_type == "MultiPolygon":
            sea_polys.extend(p for p in clipped.geoms if p.area > 10)
        elif clipped.geom_type == "Polygon" and clipped.area > 10:
            sea_polys.append(clipped)
    if tidal_polys_in:
        log.info("Added tidal polygons: %d ways -> %d total sea polygons",
                 len(tidal_polys_in), len(sea_polys))
        # Re-rasterise sea mask if tidal polys added new geometry
        if sea_polys:
            sea_shape = unary_union(sea_polys)
            sea_mask = _rasterise_fast(sea_shape, elev_grid.shape, xs_grid, ys_grid)

    if sea_mask.sum() == 0 and opts.sea_level > 0:
        sea_mask = elev_grid <= opts.sea_level
        if sea_mask.sum() > 0:
            log.info("SRTM sea-level fallback: %d/%d cells", sea_mask.sum(), sea_mask.size)

    n_sea = sea_mask.sum()
    elev_pre_sea = elev_grid.copy()
    if n_sea > 0:
        elev_grid[sea_mask] = 0.0
        coast_band = distance_transform_edt(~sea_mask) * cell_m
        blend_width_m = 30.0
        blend = np.clip(coast_band / blend_width_m, 0, 1)
        elev_blended = gaussian_filter(elev_grid, sigma=2.0)
        elev_grid = np.where(blend < 1.0,
                             blend * elev_grid + (1 - blend) * elev_blended,
                             elev_grid)
        log.info("Sea flattening applied: %d cells -> 0 m", n_sea)

    # ---- 8. Build river shape ----
    _progress(9, "Building river shape")
    river_centerlines = []
    for wl in waterways:
        if wl["type"] in ("river", "canal"):
            xy = project_arr(wl["coords"])
            if len(xy) >= 2:
                river_centerlines.append(LineString(xy))
    river_buffer = (unary_union([line.buffer(opts.river_width, cap_style=1, join_style=1)
                                 for line in river_centerlines])
                    if river_centerlines else None)

    osm_water = []
    for wp in water_polys_in:
        coords = wp["coords"]
        # Strip closing coordinate if present
        if len(coords) >= 4 and coords[0] == coords[-1]:
            coords = coords[:-1]
        if len(coords) < 3:
            continue
        xy = project_arr(coords)
        p = Polygon(xy)
        if not p.is_valid:
            p = make_valid(p)
        if p.is_empty:
            continue
        if p.geom_type == "Polygon":
            osm_water.append(p)
        elif p.geom_type == "MultiPolygon":
            osm_water.extend(p.geoms)

    river_parts = []
    if river_buffer is not None and not river_buffer.is_empty:
        river_parts.append(river_buffer)
    river_parts.extend(osm_water)
    river_shape = (unary_union(river_parts).intersection(TERRAIN_BBOX)
                   if river_parts else None)
    river_polys = ([river_shape] if river_shape and river_shape.geom_type == "Polygon"
                   else list(river_shape.geoms) if river_shape else [])
    log.info("River: %d polygon(s), %.0f m²",
             len(river_polys), sum(p.area for p in river_polys if p))

    river_filter = (river_shape.buffer(RIVER_FILTER_BUFFER_M, cap_style=2, join_style=2)
                    if river_shape else None)

    # ---- 8b. Rasterise river mask ----
    _progress(10, "Rasterising river mask")
    log.info("Rasterising river mask...")
    river_union = unary_union(river_polys) if river_polys else None
    river_mask = (_rasterise_fast(river_union, elev_grid.shape, xs_grid, ys_grid)
                  if river_union and not river_union.is_empty
                  else np.zeros(elev_grid.shape, dtype=bool))
    log.info("River cells: %d/%d (%.1f%%)",
             river_mask.sum(), river_mask.size, 100 * river_mask.mean())

    # ---- 8c. Valley + river carve ----
    _progress(11, "Carving valley")
    dist_in = distance_transform_edt(river_mask) * cell_m
    dist_out = distance_transform_edt(~river_mask) * cell_m

    VALLEY_RADIUS_M = 100.0
    VALLEY_DEPTH_M = 3.0
    valley_ramp = 1.0 - np.clip(dist_out / VALLEY_RADIUS_M, 0, 1)
    valley = 0.5 * (1 - np.cos(np.pi * valley_ramp)) * VALLEY_DEPTH_M

    RIVER_TAPER_M = 30.0
    RIVER_DEPTH_M = 7.0
    river_ramp = np.clip(dist_in / RIVER_TAPER_M, 0, 1)
    river_extra = 0.5 * (1 - np.cos(np.pi * river_ramp)) * RIVER_DEPTH_M
    river_extra[~river_mask] = 0.0
    elev_carved = elev_grid - valley - river_extra

    elev_smooth = gaussian_filter(elev_carved, sigma=1.0)
    elev_natural = gaussian_filter(elev_grid, sigma=1.0)
    depth_below = np.maximum(0, elev_natural - elev_smooth)

    elev_base = (elev_natural - elev_natural.min()) * opts.z_exag
    elev_carved_raw = elev_base - depth_below * opts.z_exag * opts.river_exag
    z_offset = elev_carved_raw.min()
    elev_z = elev_carved_raw - z_offset

    elev_natural_presea = gaussian_filter(elev_pre_sea, sigma=1.0)
    elev_water_base = (elev_natural_presea - elev_natural.min()) * opts.z_exag
    elev_water_z = elev_water_base - z_offset

    log.info("Elevation z range (units): %.2f–%.2f", elev_z.min(), elev_z.max())
    max_carve_depth = (elev_water_z - elev_z).max()
    log.info("Max water carving depth: %.2f units", max_carve_depth)

    # ---- 9. Sample elevation functions (vectorised) ----
    _progress(12, "Setting up elevation samplers")
    sample_elev = make_bilinear_sampler(elev_z, WIDTH_M, HEIGHT_M)
    sample_water_elev = make_bilinear_sampler(elev_water_z, WIDTH_M, HEIGHT_M)


    # ---- 10. Terrain solid with thick base ----
    _progress(13, "Building terrain mesh")
    WORLD_TO_MM = opts.print_size / max(WIDTH_M, HEIGHT_M)
    BASE_BOTTOM = -(opts.base / WORLD_TO_MM)
    log.info("Base thickness %.1f mm -> BASE_BOTTOM = %.2f units", opts.base, BASE_BOTTOM)

    xs = np.linspace(0, WIDTH_M, n_cols)
    ys = np.linspace(HEIGHT_M, 0, n_rows)
    xx, yy = np.meshgrid(xs, ys)
    top_v = np.stack([xx.ravel(), yy.ravel(), elev_z.ravel()], axis=1)
    bot_v = np.stack([xx.ravel(), yy.ravel(),
                      np.full(xx.size, BASE_BOTTOM)], axis=1)
    all_v = np.vstack([top_v, bot_v])
    NTOP = top_v.shape[0]

    # Vectorised face generation — no per-cell Python loops.
    rr, cc = np.meshgrid(np.arange(n_rows - 1), np.arange(n_cols - 1),
                         indexing="ij")
    rr = rr.ravel(); cc = cc.ravel()
    a = rr * n_cols + cc            # ti(r, c)
    b = (rr + 1) * n_cols + cc      # ti(r+1, c)
    d = rr * n_cols + cc + 1        # ti(r, c+1)
    e = (rr + 1) * n_cols + cc + 1  # ti(r+1, c+1)
    top_f = np.concatenate([np.column_stack([a, e, b]),
                            np.column_stack([a, d, e])])
    bot_f = np.concatenate([np.column_stack([a, b, e]),
                            np.column_stack([a, e, d])]) + NTOP

    def _wall(idx_t, idx_b, flip):
        tL, tR = idx_t[:-1], idx_t[1:]
        bL, bR = idx_b[:-1], idx_b[1:]
        if flip:
            return np.concatenate([np.column_stack([tR, tL, bL]),
                                   np.column_stack([tR, bL, bR])])
        return np.concatenate([np.column_stack([tL, tR, bR]),
                               np.column_stack([tL, bR, bL])])

    cols_idx = np.arange(n_cols)
    rows_idx = np.arange(n_rows)
    south_t = (n_rows - 1) * n_cols + cols_idx
    north_t = cols_idx
    west_t = rows_idx * n_cols
    east_t = rows_idx * n_cols + (n_cols - 1)
    walls = [
        _wall(south_t, south_t + NTOP, flip=True),    # r = n_rows-1
        _wall(north_t, north_t + NTOP, flip=False),   # r = 0
        _wall(west_t, west_t + NTOP, flip=False),     # c = 0 (tN,tS,bS / tN,bS,bN)
        _wall(east_t, east_t + NTOP, flip=True),      # c = n_cols-1
    ]
    faces = np.vstack([top_f, bot_f] + walls)
    terrain = trimesh.Trimesh(vertices=all_v, faces=faces, process=False)
    # Faces are constructed with consistent outward winding; a volume-sign
    # check replaces the expensive fix_winding graph traversal.
    if terrain.volume < 0:
        terrain.invert()
    log.info("Terrain (pre-decimate): watertight=%s, faces=%d",
             terrain.is_watertight, len(terrain.faces))

    # Decimate terrain — halve face count; flat areas collapse, detail preserved.
    # safe_decimate reverts automatically if decimation breaks watertightness.
    terrain = safe_decimate(terrain, max(len(terrain.faces) // 2, 1000), "Terrain")

    # ---- 11. Buildings ----
    _progress(14, "Extruding buildings")
    log.info("Extruding %d buildings...", len(buildings_in))
    bld_meshes = []
    filtered_river = 0
    filtered_outside = 0
    skipped = 0
    BUILDING_BURY = 8.0
    BUILDING_SAFETY = 2.0
    WORLD_TO_MM_B = opts.print_size / max(WIDTH_M, HEIGHT_M)
    BLDG_SEP_M = 0.05 / WORLD_TO_MM_B  # ~0.05 mm at print scale

    river_filter_prep = (prep(river_filter)
                         if river_filter and not river_filter.is_empty else None)
    n_bld_total = len(buildings_in)
    for bi_idx, b in enumerate(buildings_in):
        if bi_idx % 200 == 0:
            _tick(f"  Buildings: {bi_idx}/{n_bld_total}")
        coords = b["coords"]
        # Strip closing coord if present
        if len(coords) >= 4 and coords[0] == coords[-1]:
            coords = coords[:-1]
        coords_xy = project_arr(coords)
        poly = Polygon(coords_xy)
        if not poly.is_valid:
            poly = make_valid(poly)
            if poly.geom_type == "MultiPolygon":
                poly = max(poly.geoms, key=lambda g: g.area)
            elif poly.geom_type != "Polygon":
                skipped += 1; continue
        if poly.area < 4.0:
            skipped += 1; continue
        # Drop collinear/near-duplicate vertices (5 cm tolerance) — these
        # produce zero-area triangles in the extruded mesh, which slicers
        # flag as errors.
        simplified = poly.simplify(0.05, preserve_topology=True)
        if simplified.geom_type == "Polygon" and not simplified.is_empty:
            poly = simplified
        # Shrink by ~half print resolution: terraced buildings share
        # party-wall vertices exactly, which collapse to identical
        # coordinates at the .3MF's export precision and weld into
        # non-manifold edges in the slicer.
        shrunk = poly.buffer(-BLDG_SEP_M)
        if shrunk.geom_type == "MultiPolygon" and not shrunk.is_empty:
            shrunk = max(shrunk.geoms, key=lambda g: g.area)
        if shrunk.geom_type == "Polygon" and not shrunk.is_empty:
            poly = shrunk
        poly = poly.intersection(TERRAIN_BBOX)
        if poly.is_empty:
            filtered_outside += 1; continue
        if poly.geom_type == "MultiPolygon":
            poly = max(poly.geoms, key=lambda g: g.area)
        if poly.geom_type != "Polygon" or poly.area < 4.0:
            filtered_outside += 1; continue
        if river_filter_prep is not None and river_filter_prep.intersects(poly):
            try:
                inter = poly.intersection(river_filter)
                if not inter.is_empty and inter.area / poly.area > 0.5:
                    filtered_river += 1; continue
            except Exception:
                pass
        minx, miny, maxx, maxy = poly.bounds
        gx = minx + np.array([0.0, 0.5, 1.0]) * (maxx - minx)
        gy = miny + np.array([0.0, 0.5, 1.0]) * (maxy - miny)
        gxx, gyy = np.meshgrid(gx, gy)
        gmask = shapely_contains_xy(poly, gxx.ravel(), gyy.ravel())
        sample_pts = np.vstack([
            [[poly.centroid.x, poly.centroid.y]],
            np.column_stack([gxx.ravel()[gmask], gyy.ravel()[gmask]]),
        ])
        es = sample_elev(sample_pts)
        base_z = float(es.min()); top_terr = float(es.max())
        # Building heights use their own exaggeration (default 1 = true
        # scale).  Multiplying by z_exag made buildings look twice as tall
        # as their footprints suggest on a 2x-exaggerated terrain.
        height = b["height"] * opts.building_exag
        extrude_h = (top_terr - base_z) + height + BUILDING_BURY + BUILDING_SAFETY
        try:
            bm = trimesh.creation.extrude_polygon(poly, extrude_h)
        except Exception:
            skipped += 1; continue
        # Sink the safety margin below ground: roof sits at exactly
        # top_terr + height instead of poking SAFETY units higher.
        bm.apply_translation([0, 0, base_z - BUILDING_BURY - BUILDING_SAFETY])
        if bm.volume < 0:
            bm.invert()
        # Per-building hygiene: drop zero-area faces, and reject any shell
        # that is not watertight — one leaky building would otherwise mark
        # the whole Buildings object as broken in the slicer.
        bm.update_faces(bm.nondegenerate_faces())
        if not bm.is_watertight:
            skipped += 1; continue
        bld_meshes.append(bm)

    _tick(f"  Buildings: {n_bld_total}/{n_bld_total}")
    log.info("Buildings: %d kept; %d in river; %d outside; %d invalid",
             len(bld_meshes), filtered_river, filtered_outside, skipped)

    # ---- 12. Roads ----
    _progress(15, "Building roads")
    ROAD_VISIBLE = opts.road_raise / WORLD_TO_MM
    ROAD_BURY = 3.0 / WORLD_TO_MM
    # Interior Steiner-point spacing and boundary simplification, both in
    # world metres but pinned to print resolution: points denser than
    # ~0.3 mm on the print add faces without adding visible detail, and
    # vertices closer than ~0.05 mm collapse to identical coordinates in
    # the exported file.
    INTERIOR_SPACING = max(2.0, cell_m * 0.6, 0.3 / WORLD_TO_MM)
    SIMPLIFY_TOL_M = 0.05 / WORLD_TO_MM
    log.info("Building %d roads (top +%.1f u = %.1f mm above, buried %.1f u below)",
             len(roads_in), ROAD_VISIBLE, opts.road_raise, ROAD_BURY)

    # Union all road strips into ONE clean network first, then build slabs
    # from the non-overlapping parts.  This eliminates the hundreds of
    # mutually intersecting shells that triggered slicer warnings, and
    # cuts the face count substantially (shared junctions meshed once).
    road_meshes = []
    road_skipped = 0
    strips = []
    for rd in roads_in:
        if len(rd["coords"]) < 2:
            road_skipped += 1; continue
        coords_xy = project_arr(rd["coords"])
        strips.append(LineString(coords_xy).buffer(rd["width"] / 2.0,
                                                   cap_style=2, join_style=2))
    if strips:
        log.info("  Unioning %d road strips...", len(strips))
        road_network = unary_union(strips).intersection(TERRAIN_BBOX)
        if river_shape and not river_shape.is_empty:
            road_network = road_network.difference(river_shape)
        road_network = make_valid(road_network)
        road_parts = separated_parts(road_network, simplify_tol=SIMPLIFY_TOL_M)
        log.info("  Road network: %d non-overlapping part(s)", len(road_parts))
        for pi, part in enumerate(road_parts):
            if pi % 20 == 0:
                _tick(f"  Road parts: {pi}/{len(road_parts)}")
            sl = slab_from_poly(part, sample_elev,
                                ROAD_VISIBLE, ROAD_BURY, INTERIOR_SPACING,
                                max_seg=max(4.0, INTERIOR_SPACING))
            if sl is not None:
                road_meshes.append(sl)
            else:
                road_skipped += 1
        _tick(f"  Road parts: {len(road_parts)}/{len(road_parts)}")
    log.info("Built %d road slab(s) (%d skipped)", len(road_meshes), road_skipped)

    # ---- 13. Water bodies ----
    _progress(16, "Building water bodies")
    log.info("Building water bodies...")
    water_meshes = []
    water_skipped = 0

    # 13a. River polygons — terrain-relative water in carved valley
    # Erode inward so water doesn't reach the bank edge (where carved
    # terrain equals bank height).  Then use carved terrain as reference
    # so water always sits inside the channel.
    RIVER_INSET_M = 10.0  # pull water edge 10 m back from the BANKS only
    RIVER_WATER_TOP = 0.3 / WORLD_TO_MM   # 0.3 mm above water surface
    RIVER_WATER_DEPTH = 2.0 / WORLD_TO_MM  # 2.0 mm below water surface

    # River/lake water SURFACE: the lowest carved level within roughly a
    # channel radius (minimum filter), lightly smoothed.  Draping water
    # directly on carved terrain let it climb the banks and hillsides
    # wherever the fixed-width river buffer or a tributary overlapped
    # rising ground — visible as water stripes up the hillside in
    # mountainous areas.  With the min-filtered surface, water sits at
    # channel-bottom level and is naturally buried (deeply, on steep
    # ground) wherever its polygon overlaps a slope.
    from scipy.ndimage import minimum_filter
    WATER_LEVEL_RADIUS_M = opts.river_width + 30.0
    mf_size = max(3, int(round(2 * WATER_LEVEL_RADIUS_M / cell_m)) | 1)
    elev_river_surface = gaussian_filter(
        minimum_filter(elev_z, size=mf_size), sigma=1.0)
    sample_river_surface = make_bilinear_sampler(
        elev_river_surface, WIDTH_M, HEIGHT_M)
    # Inset must apply only along the banks — eroding with buffer(-d) also
    # pulled the water back from the bbox edge, leaving a dry strip at the
    # edge of the print.  Subtract a buffered copy of the NON-river area
    # instead, so edges that coincide with the print boundary stay put.
    river_bank_buf = None
    if river_shape and not river_shape.is_empty:
        river_bank_buf = (TERRAIN_BBOX.difference(river_shape)
                          .buffer(RIVER_INSET_M))
    for wp in river_polys:
        if wp is None or wp.is_empty:
            water_skipped += 1; continue
        wp_clipped = wp.intersection(TERRAIN_BBOX)
        if wp_clipped.is_empty:
            water_skipped += 1; continue
        wp_eroded = (wp_clipped.difference(river_bank_buf)
                     if river_bank_buf is not None
                     else wp_clipped.buffer(-RIVER_INSET_M))
        if wp_eroded.is_empty:
            water_skipped += 1; continue
        for part in separated_parts(wp_eroded, simplify_tol=SIMPLIFY_TOL_M):
            if part.geom_type != "Polygon" or part.area < 4.0:
                continue
            # Top AND bottom follow the min-filtered water surface, not the
            # carved terrain — keeps water level in the channel.
            sl = slab_from_poly(part, sample_river_surface,
                                RIVER_WATER_TOP, RIVER_WATER_DEPTH,
                                INTERIOR_SPACING,
                                max_seg=max(4.0, INTERIOR_SPACING))
            if sl is not None:
                water_meshes.append(sl)
            else:
                water_skipped += 1

    log.info("River water: %d slab(s)", len(water_meshes))

    # 13b. Sea polygons — void-fill in carved sea shelf
    SEA_INSET_M = 8.0
    sea_mesh_count = 0
    if sea_polys:
        # Erode only along the COASTLINE: subtract buffered land instead of
        # shrinking the whole polygon, so the sea still reaches the print
        # edge where the bbox boundary is open water.
        land_buf = (TERRAIN_BBOX.difference(unary_union(sea_polys))
                    .buffer(SEA_INSET_M))
        for wp in sea_polys:
            if wp is None or wp.is_empty:
                water_skipped += 1; continue
            wp_clipped = wp.intersection(TERRAIN_BBOX)
            if wp_clipped.is_empty:
                water_skipped += 1; continue
            wp_eroded = wp_clipped.difference(land_buf)
            if wp_eroded.is_empty:
                water_skipped += 1; continue
            for part in separated_parts(wp_eroded, simplify_tol=SIMPLIFY_TOL_M):
                if part.geom_type != "Polygon" or part.area < 4.0:
                    continue
                sl = slab_from_poly(part, sample_water_elev,
                                    0, 0, INTERIOR_SPACING,
                                    bottom_elev_fn=sample_elev,
                                    bottom_offset=0,
                                    min_thickness=0.2 / WORLD_TO_MM,
                                    max_seg=max(4.0, INTERIOR_SPACING))
                if sl is not None:
                    water_meshes.append(sl)
                    sea_mesh_count += 1
                else:
                    water_skipped += 1

    log.info("Sea water: %d slab(s)", sea_mesh_count)
    log.info("Total water: %d slab(s) (%d skipped)", len(water_meshes), water_skipped)

    # ---- 14. Concatenate per-type meshes ----
    _progress(17, "Assembling final mesh")
    buildings_mesh = (trimesh.util.concatenate(bld_meshes)
                      if bld_meshes else trimesh.Trimesh())
    # Buildings are already clean per-shell (validated at creation).
    # No global vertex-merge or decimation: both can open closed bodies,
    # and the face count is small relative to the terrain.
    roads_mesh = (trimesh.util.concatenate(road_meshes)
                  if road_meshes else trimesh.Trimesh())
    water_mesh = (trimesh.util.concatenate(water_meshes)
                  if water_meshes else trimesh.Trimesh())
    roads_mesh = clean_mesh(roads_mesh, "Roads", merge=False)
    water_mesh = clean_mesh(water_mesh, "Water", merge=False)

    # ---- 15. Scale to print size ----
    _progress(18, "Scaling to print size")
    all_pieces = [m for m in [terrain, buildings_mesh, roads_mesh, water_mesh]
                  if len(m.vertices) > 0]
    all_verts = np.vstack([m.vertices for m in all_pieces])
    global_min = all_verts.min(axis=0)
    global_max = all_verts.max(axis=0)
    global_ext = global_max - global_min
    scale = opts.print_size / max(global_ext[0], global_ext[1])

    for m in [terrain, buildings_mesh, roads_mesh, water_mesh]:
        if len(m.vertices) == 0:
            continue
        m.apply_scale(scale)

    scaled_pieces = [m for m in [terrain, buildings_mesh, roads_mesh, water_mesh]
                     if len(m.vertices) > 0]
    all_scaled_verts = np.vstack([m.vertices for m in scaled_pieces])
    origin = all_scaled_verts.min(axis=0)

    for m in [terrain, buildings_mesh, roads_mesh, water_mesh]:
        if len(m.vertices) == 0:
            continue
        m.apply_translation(-origin)

    for m in [terrain, buildings_mesh, roads_mesh, water_mesh]:
        if len(m.vertices) > 0:
            trimesh.repair.fix_normals(m)

    # Final dedupe in print-mm space: no two shells may share a vertex
    # position at export precision, or position-welding importers create
    # non-manifold edges.
    buildings_mesh = nudge_duplicate_vertices(buildings_mesh, "Buildings")
    roads_mesh = nudge_duplicate_vertices(roads_mesh, "Roads")
    water_mesh = nudge_duplicate_vertices(water_mesh, "Water")

    log.info("Scaled to print size: scale=%.6f", scale)
    for name, m in [("Land", terrain), ("Buildings", buildings_mesh),
                    ("Roads", roads_mesh), ("Water", water_mesh)]:
        if len(m.vertices) > 0:
            log.info("  %s: %d verts, %d faces, extents %s",
                     name, len(m.vertices), len(m.faces), m.extents)

    return {
        "sources": sources, "bbox": bbox,
        "terrain": terrain, "buildings": buildings_mesh,
        "roads": roads_mesh, "water": water_mesh,
        "counts": {"buildings": len(bld_meshes), "roads": len(road_meshes),
                   "water": len(water_meshes)},
        "filtered": {"buildings_in_river": filtered_river,
                     "buildings_outside": filtered_outside,
                     "buildings_invalid": skipped},
        "scale_mm_per_m": float(scale),
        "width_m": float(WIDTH_M), "height_m": float(HEIGHT_M),
        "elevation_range_m": [float(elev_grid.min()), float(elev_grid.max())],
        "cell_m": float(cell_m),
    }


def build(opts: BuildOptions) -> dict:
    """Run the full build and return the manifest (also written to disk)."""
    t_start = time.time()
    out_dir = Path(opts.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    cache_dir = Path(opts.cache_dir) if opts.cache_dir else default_cache_dir()
    cache_dir.mkdir(parents=True, exist_ok=True)

    r = _build_core(opts, out_dir, cache_dir)
    terrain, buildings_mesh = r["terrain"], r["buildings"]
    roads_mesh, water_mesh = r["roads"], r["water"]
    sources = r["sources"]

    # ---- Export as multi-object 3MF ----
    _progress(19, "Exporting 3MF")
    c = {**DEFAULT_COLOURS, **(opts.colours or {})}
    parts = [Part("Land", terrain, c["land"], 1),
             Part("Water", water_mesh, c["water"], 2),
             Part("Roads", roads_mesh, c["roads"], 3),
             Part("Buildings", buildings_mesh, c["buildings"], 4)]
    attribution = provenance.attribution_line(sources)
    title = opts.name or f"Terrain {opts.bbox_id}"
    out_3mf = out_dir / f"terrain_{opts.bbox_id}.3mf"
    export_3mf(out_3mf, parts, title=title, bambu=opts.bambu_metadata,
               metadata={
                   "Designer": "Hyperscale Landscapes " + __version__,
                   "Description": exaggeration_note(opts),
                   "Copyright": attribution,
                   "LicenseTerms": "Map data ODbL 1.0; see manifest for all sources",
                   "CreationDate": time.strftime("%Y-%m-%d"),
               })

    # ---- Optional single-colour union STL ----
    union_stats = None
    out_stl = None
    if opts.stl:
        from .geometry.union import union_solids
        _progress(19, "Boolean union for single-colour STL")
        merged, union_stats = union_solids(terrain, [buildings_mesh, roads_mesh])
        out_stl = out_dir / f"terrain_{opts.bbox_id}.stl"
        merged.export(str(out_stl))

    # ---- Printability check (land is the structural body) ----
    _progress(20, "Checking printability")
    n_oh, a_oh = checks.overhangs(terrain)
    log.info("Overhang faces: %d, area: %.2f mm² -> %s", n_oh, a_oh,
             "OK, print without supports" if checks.support_free(n_oh, a_oh)
             else "inspect in slicer")

    # ---- Manifest ----
    _progress(21, "Writing manifest")
    meshes = {"land": terrain, "buildings": buildings_mesh,
              "roads": roads_mesh, "water": water_mesh}
    objects = {}
    for k, m in meshes.items():
        objects[k] = {"faces": int(len(m.faces)), "vertices": int(len(m.vertices)),
                      "watertight": bool(m.is_watertight) if len(m.faces) else None}
        if k in r["counts"]:
            objects[k]["count"] = r["counts"][k]
    manifest = {
        "schema": "hyperscale-landscapes/manifest@2",
        "generator": f"hyperscale-landscapes {__version__}",
        "name": opts.name or None,
        "outputs": {"3mf": str(out_3mf), "stl": str(out_stl) if out_stl else None},
        "bbox": {"min_lat": opts.min_lat, "max_lat": opts.max_lat,
                 "min_lon": opts.min_lon, "max_lon": opts.max_lon},
        "options": {k: v for k, v in asdict(opts).items()
                    if k not in ("min_lat", "max_lat", "min_lon", "max_lon",
                                 "out_dir", "cache_dir", "force")},
        "disclosure": exaggeration_note(opts),
        "attribution": attribution,
        "provenance": {layer: provenance.lookup(src) for layer, src in sources.items()},
        "world": {"width_m": r["width_m"], "height_m": r["height_m"],
                  "cell_m": r["cell_m"], "scale_mm_per_m": r["scale_mm_per_m"],
                  "elevation_range_m": r["elevation_range_m"]},
        "objects": objects,
        "filtered": r["filtered"],
        "union": union_stats,
        "stats": {
            "total_vertices": sum(o["vertices"] for o in objects.values()),
            "total_faces": sum(o["faces"] for o in objects.values()),
            "terrain_watertight": bool(terrain.is_watertight),
            "overhang_faces": n_oh,
            "overhang_area_mm2": round(a_oh, 4),
            "support_free": checks.support_free(n_oh, a_oh),
            "build_seconds": round(time.time() - t_start, 1),
        },
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    manifest_path = out_dir / f"manifest_{opts.bbox_id}.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
    log.info("Manifest -> %s", manifest_path)
    return manifest
