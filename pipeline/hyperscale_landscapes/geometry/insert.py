"""The removable data-centre insert and its recess (PLAN.md §6).

- The insert is the proposed footprint extruded to the stated height (or a
  user estimate, whose source is recorded), at ``building_exag``.
- The recess is the footprint grown by ``CLEARANCE_MM`` and cut into the
  model, with a flat floor ``RECESS_DEPTH_MM`` below the lowest terrain
  under the footprint, so the block always sits level.
- Optional magnet holes (default 6 × 2 mm magnets, +0.2 mm) are cut in the
  recess floor and the insert's underside at matching positions.
- Every printed part that falls inside the recess (buildings, roads, pads)
  is cut away with it.

Nothing here invents a footprint: the polygon always comes from a curated
site file with a source, or from the user.
"""
from __future__ import annotations

import logging

import numpy as np
import trimesh
from shapely.geometry import MultiPolygon, Point, Polygon
from shapely.geometry.polygon import orient

from .union import subtract

log = logging.getLogger(__name__)

CLEARANCE_MM = 0.2
RECESS_DEPTH_MM = 2.0
MIN_FLOOR_ABOVE_BED_MM = 0.8
MAGNET_DIAMETER_MM = 6.0
MAGNET_DEPTH_MM = 2.0
MAGNET_SLACK_MM = 0.2


def _prism(poly, z0, z1):
    poly = orient(poly, sign=1.0)
    m = trimesh.creation.extrude_polygon(poly, z1 - z0)
    m.apply_translation((0, 0, z0))
    if m.volume < 0:
        m.invert()
    return m


def _cylinder(xy, r, z0, z1, sections=48):
    m = trimesh.creation.cylinder(radius=r, height=z1 - z0, sections=sections)
    m.apply_translation((xy[0], xy[1], (z0 + z1) / 2))
    return m


def magnet_positions(poly: Polygon, inset: float) -> list[tuple[float, float]]:
    """Two positions along the footprint's long axis, or one at its centre."""
    inner = poly.buffer(-inset)
    if inner.is_empty:
        c = poly.representative_point()
        return [(c.x, c.y)]
    mrr = poly.minimum_rotated_rectangle
    xs, ys = mrr.exterior.coords.xy
    edges = [(xs[i + 1] - xs[i], ys[i + 1] - ys[i]) for i in range(4)]
    long = max(edges, key=lambda e: np.hypot(*e))
    ang = np.arctan2(long[1], long[0])
    c = poly.centroid
    # Start at ±30 % of the long side and walk inwards until both holes sit
    # inside the inset outline, while staying at least ``inset`` apart
    # (hole radius plus a wall), so each magnet keeps its own pocket.
    half = 0.3 * np.hypot(*long)
    while half >= inset:
        pts = [(c.x + s * half * np.cos(ang), c.y + s * half * np.sin(ang))
               for s in (-1, 1)]
        if all(inner.contains(Point(p)) for p in pts):
            return pts
        half *= 0.85
    rp = inner.representative_point()
    return [(rp.x, rp.y)]


def build_insert(ctx, footprint: Polygon | MultiPolygon, height_m: float, *,
                 magnets: bool = True):
    """Return (insert mesh, recess cutter, magnet cutters, info) in world units."""
    w2mm = ctx["world_to_mm"]
    opts = ctx["opts"]
    sample = ctx["sample_elev"]
    fp = footprint.intersection(ctx["terrain_bbox"])
    if fp.is_empty:
        raise ValueError("The site footprint lies outside the model area")
    if fp.geom_type == "MultiPolygon":
        fp = max(fp.geoms, key=lambda g: g.area)
    clear = CLEARANCE_MM / w2mm
    recess_poly = fp.buffer(clear, join_style=2)

    # Terrain under the grown footprint: boundary plus an interior grid.
    pts = [np.array(recess_poly.exterior.coords)]
    minx, miny, maxx, maxy = recess_poly.bounds
    gx, gy = np.meshgrid(np.linspace(minx, maxx, 25), np.linspace(miny, maxy, 25))
    from shapely import contains_xy
    inside = contains_xy(recess_poly, gx.ravel(), gy.ravel())
    pts.append(np.column_stack([gx.ravel()[inside], gy.ravel()[inside]]))
    z = np.asarray(sample(np.vstack(pts)))
    z_low, z_high = float(z.min()), float(z.max())

    floor = z_low - RECESS_DEPTH_MM / w2mm
    lowest_floor = (ctx["base_bottom"] + (MIN_FLOOR_ABOVE_BED_MM
                    + (MAGNET_DEPTH_MM + MAGNET_SLACK_MM if magnets else 0)) / w2mm)
    if floor < lowest_floor:
        log.warning("Recess floor raised to keep %.1f mm of base under it; "
                    "consider a thicker --base", MIN_FLOOR_ABOVE_BED_MM)
        floor = lowest_floor
    top = z_high + height_m * opts.building_exag
    sky = max(top, float(ctx["elev_z"].max())) + 100.0 / w2mm

    recess = _prism(recess_poly, floor, sky)
    insert = _prism(fp, floor, top)

    magnet_cutters = []
    holes = []
    if magnets:
        r = (MAGNET_DIAMETER_MM + MAGNET_SLACK_MM) / 2 / w2mm
        depth = (MAGNET_DEPTH_MM + MAGNET_SLACK_MM) / w2mm
        for xy in magnet_positions(fp, inset=r + 2.0 / w2mm):
            magnet_cutters.append(_cylinder(xy, r, floor - depth, floor + 1e-3))
            holes.append(_cylinder(xy, r, floor - 1e-3, floor + depth))
        if fp.buffer(-(r + 1.0 / w2mm)).is_empty:
            log.warning("Footprint too small for magnet holes; leaving them out")
            magnet_cutters, holes = [], []
        for h in holes:
            insert = subtract(insert, h)

    info = {
        "footprint_area_m2": round(float(fp.area), 1),
        "height_m": height_m,
        "building_exag": opts.building_exag,
        "clearance_mm": CLEARANCE_MM,
        "recess_depth_mm": round((z_low - floor) * w2mm, 2),
        "insert_height_mm": round((top - floor) * w2mm, 2),
        "magnet_holes": len(magnet_cutters),
        "magnet_size_mm": f"{MAGNET_DIAMETER_MM:g} × {MAGNET_DEPTH_MM:g}" if magnets else None,
    }
    return insert, recess, magnet_cutters, info


def cut_all(meshes, cutter):
    """Subtract ``cutter`` from each mesh that overlaps it; drop empties."""
    out = []
    cb = cutter.bounds
    for m in meshes:
        if m is None or len(m.faces) == 0:
            continue
        b = m.bounds
        overlaps = not (b[1][0] < cb[0][0] or b[0][0] > cb[1][0] or
                        b[1][1] < cb[0][1] or b[0][1] > cb[1][1])
        if not overlaps:
            out.append(m)
            continue
        r = subtract(m, cutter)
        if len(r.faces):
            out.append(r)
    return out
