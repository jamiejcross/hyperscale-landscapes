"""Print geometry for the Phase 2 layers: power, rail, industrial residues
and receptors.

Everything is built in the pipeline's world units (x/y metres, z in
exaggerated "units") and sits *on* the terrain the same way roads do:
draped slabs with their tops a fraction of a millimetre above the ground
and their bottoms buried, so there are no exposed undersides and no
supports.  Pylons and turbines are vertical pegs, also buried.

Minimum printable widths are enforced in print millimetres, so features
stay legible at any print size (a 10 m substation would otherwise be a
0.4 mm speck).

2D overlap priority, highest first:
    water > roads > power > rail > residues
Lower-priority areas are cut back where a higher one already sits, and
every pad is cut around building footprints, so no two printed parts
occupy the same volume.
"""
from __future__ import annotations

import logging

import numpy as np
import trimesh
from shapely.geometry import Point, Polygon, box, shape
from shapely.ops import unary_union
from shapely.validation import make_valid

from .mesh import separated_parts, slab_from_poly

log = logging.getLogger(__name__)

# Print-millimetre dimensions (PLAN.md §4)
PAD_RAISE_MM = 0.4          # substations, plant, battery storage
RESIDUE_RAISE_MM = 0.3      # quarries, landfill, works, bings (relief is already terrain)
LINE_RAISE_MM = 0.35        # high-voltage line corridors
RAIL_RAISE_MM = 0.4
RAIL_DISUSED_RAISE_MM = 0.25
BURY_MM = 3.0
MIN_STRIP_MM = 0.8          # two 0.4 mm extrusion widths
PEG_MM = 1.2                # pylon peg side
TURBINE_PEG_MM = 1.4
OUTLINE_MM = 0.6            # ring width for proposed / under-construction areas
POINT_DISC_MM = 1.6         # mineshafts and other point residues

RECEPTOR_BUILDING_KINDS = {"school", "kindergarten", "college", "university",
                           "hospital", "clinic", "prison", "community_centre",
                           "church", "chapel", "mosque", "temple", "synagogue",
                           "civic", "public", "library", "care_home"}
RECEPTOR_AMENITIES = {"school", "kindergarten", "college", "university",
                      "hospital", "clinic", "doctors", "prison",
                      "community_centre", "place_of_worship", "library",
                      "social_facility", "nursing_home", "childcare"}
POWER_AREA_KINDS = {"substation", "plant", "generator", "battery", "switch",
                    "transformer", "converter", "compensator"}
POWER_LINE_KINDS = {"line", "minor_line"}


def _project_geom(geom, project_arr):
    """Project a lon/lat shapely geometry into world metres."""
    import shapely
    return shapely.transform(geom, lambda c: project_arr(c))


def _polys(g):
    if g is None or g.is_empty:
        return []
    if g.geom_type == "Polygon":
        return [g]
    if hasattr(g, "geoms"):
        out = []
        for x in g.geoms:
            out.extend(_polys(x))
        return out
    return []


def _peg(xy, side_m, height_units, sample_elev, bury_units):
    """A square vertical peg standing on the terrain at ``xy``."""
    half = side_m / 2
    corners = np.array([[xy[0] - half, xy[1] - half], [xy[0] + half, xy[1] - half],
                        [xy[0] + half, xy[1] + half], [xy[0] - half, xy[1] + half],
                        [xy[0], xy[1]]])
    z = np.asarray(sample_elev(corners))
    z0, z1 = float(z.min()) - bury_units, float(z.max()) + height_units
    m = trimesh.creation.box(extents=(side_m, side_m, z1 - z0))
    m.apply_translation((xy[0], xy[1], (z0 + z1) / 2))
    return m


def _slabs(geom, ctx, raise_mm, name):
    """Drape every separated part of ``geom`` as a slab; return meshes."""
    w2mm = ctx["world_to_mm"]
    out = []
    for part in separated_parts(make_valid(geom), simplify_tol=ctx["simplify_tol"]):
        if part.area < (MIN_STRIP_MM / w2mm) ** 2:
            continue
        sl = slab_from_poly(part, ctx["sample_elev"], raise_mm / w2mm,
                            BURY_MM / w2mm, ctx["interior_spacing"],
                            max_seg=max(4.0, ctx["interior_spacing"]))
        if sl is not None and sl.is_watertight:
            out.append(sl)
        elif sl is not None:
            log.warning("  %s: dropped a non-watertight slab", name)
    return out


def build_layers(ctx, features, bld_meshes, bld_info, *, pegs=True):
    """Return ({layer: [meshes]}, remaining building meshes, info dict)."""
    project_arr = ctx["project_arr"]
    sample_elev = ctx["sample_elev"]
    w2mm = ctx["world_to_mm"]
    opts = ctx["opts"]
    frame = ctx["terrain_bbox"]
    min_w = MIN_STRIP_MM / w2mm
    bury = BURY_MM / w2mm

    # Project and clip every feature once.
    proj = []
    for f in features:
        try:
            g = _project_geom(shape(f["geometry"]), project_arr)
            if not g.is_valid:
                g = make_valid(g)
            g = g.intersection(frame) if g.geom_type != "Point" else g
            if g.is_empty or (g.geom_type == "Point" and not frame.contains(g)):
                continue
            proj.append((f, g))
        except Exception as e:  # malformed OSM geometry: skip, but say so
            log.debug("feature %s skipped: %s", f.get("osm"), e)

    def of(layer, pred=lambda f, g: True):
        return [(f, g) for f, g in proj if f["layer"] == layer and pred(f, g)]

    building_union = unary_union([p for p, _ in bld_info]) if bld_info else Polygon()
    water = ctx["river_shape"] if ctx["river_shape"] is not None else Polygon()
    roads = ctx["road_network"] if ctx["road_network"] is not None else Polygon()
    occupied = unary_union([water, roads])

    layers: dict[str, list] = {"power": [], "rail": [], "residues": [], "receptors": []}
    info: dict = {"features": {}}

    # ---------------- Power ----------------
    proposed_like = ("proposed", "construction")
    areas, outlines, lines = [], [], []
    for f, g in of("power"):
        polys = _polys(g)
        if f["kind"] in POWER_LINE_KINDS and g.geom_type in ("LineString", "MultiLineString"):
            lines.append(g)
        elif polys:
            (outlines if f["status"] in proposed_like else areas).extend(polys)
        elif g.geom_type == "Point" and f["kind"] in ("substation", "battery", "plant"):
            # Mapped as a node only: draw a minimum-size square pad.
            side = max(25.0, 2.0 / w2mm)
            areas.append(box(g.x - side / 2, g.y - side / 2, g.x + side / 2, g.y + side / 2))
    power_pegs = []
    if pegs:
        for f, g in of("power", lambda f, g: g.geom_type == "Point"):
            kind = f["kind"]
            if kind == "tower":
                h_m = _num(f["tags"].get("height"), 30.0)
                h_mm = float(np.clip(h_m * opts.building_exag * w2mm, 1.5, 4.0))
                power_pegs.append((g, PEG_MM, h_mm))
            elif kind.startswith("generator:wind"):
                h_m = _num(f["tags"].get("height"), 80.0)
                h_mm = float(np.clip(h_m * opts.building_exag * w2mm, 2.0, 6.0))
                power_pegs.append((g, TURBINE_PEG_MM, h_mm))
    peg_cut = unary_union([Point(g.x, g.y).buffer(s / w2mm * 0.75, cap_style=3)
                           for g, s, _ in power_pegs]) if power_pegs else Polygon()

    line_width = {"line": max(10.0, min_w * 1.25), "minor_line": max(6.0, min_w)}
    line_geoms = []
    for (f, g) in of("power", lambda f, g: f["kind"] in POWER_LINE_KINDS):
        if g.geom_type in ("LineString", "MultiLineString"):
            line_geoms.append(g.buffer(line_width[f["kind"]] / 2, cap_style=2, join_style=2))
    power_lines = unary_union(line_geoms) if line_geoms else Polygon()
    power_areas = unary_union(areas) if areas else Polygon()
    ring_w = OUTLINE_MM / w2mm
    power_outlines = unary_union([p.buffer(0).boundary.buffer(ring_w / 2, cap_style=2)
                                  for p in outlines]) if outlines else Polygon()

    power_shape = unary_union([power_areas, power_outlines])
    power_shape = power_shape.difference(occupied).difference(building_union).difference(peg_cut)
    layers["power"] += _slabs(power_shape, ctx, PAD_RAISE_MM, "power")
    lines_shape = power_lines.difference(occupied).difference(power_shape).difference(peg_cut)
    layers["power"] += _slabs(lines_shape, ctx, LINE_RAISE_MM, "power lines")
    for g, side_mm, h_mm in power_pegs:
        if water.contains(g):
            continue
        layers["power"].append(_peg((g.x, g.y), side_mm / w2mm, h_mm / w2mm,
                                    sample_elev, bury))
    occupied = unary_union([occupied, power_shape, lines_shape, peg_cut])

    # ---------------- Rail ----------------
    live, dead = [], []
    for f, g in of("rail", lambda f, g: g.geom_type in ("LineString", "MultiLineString")):
        kind = f["kind"]
        if kind in ("tram", "subway") or f["status"] in ("proposed",):
            continue
        width = max(6.0 if kind in ("rail", "preserved") else 4.0, min_w)
        strip = g.buffer(width / 2, cap_style=2, join_style=2)
        (dead if f["status"] == "disused" else live).append(strip)
    rail_live = unary_union(live).difference(occupied) if live else Polygon()
    layers["rail"] += _slabs(rail_live.difference(building_union), ctx, RAIL_RAISE_MM, "rail")
    rail_dead = (unary_union(dead).difference(occupied).difference(rail_live)
                 if dead else Polygon())
    layers["rail"] += _slabs(rail_dead.difference(building_union), ctx,
                             RAIL_DISUSED_RAISE_MM, "disused rail")
    occupied = unary_union([occupied, rail_live, rail_dead])

    # ---------------- Residues ----------------
    res_polys, res_points = [], []
    for f, g in of("residues"):
        polys = _polys(g)
        if polys:
            res_polys.extend(polys)
        elif g.geom_type == "Point":
            res_points.append(g.buffer(POINT_DISC_MM / w2mm / 2, quad_segs=8))
    residues = unary_union(res_polys + res_points) if (res_polys or res_points) else Polygon()
    residues = residues.difference(occupied).difference(building_union)
    layers["residues"] += _slabs(residues, ctx, RESIDUE_RAISE_MM, "residues")

    # ---------------- Receptors (buildings re-assigned, never new geometry) ----
    receptor_areas = unary_union([p for f, g in of("receptors") for p in _polys(g)]) \
        if of("receptors") else Polygon()
    receptor_points = [g for f, g in of("receptors") if g.geom_type == "Point"]
    keep = []
    n_receptors = 0
    for mesh, (poly, rec) in zip(bld_meshes, bld_info):
        kind = (rec.get("kind") or "").lower()
        amen = (rec.get("amenity") or "").lower()
        is_rec = (kind in RECEPTOR_BUILDING_KINDS or amen in RECEPTOR_AMENITIES
                  or (not receptor_areas.is_empty
                      and poly.intersection(receptor_areas).area > 0.5 * poly.area)
                  or any(poly.contains(p) for p in receptor_points))
        if is_rec:
            layers["receptors"].append(mesh); n_receptors += 1
        else:
            keep.append(mesh)

    for layer in ("power", "rail", "residues", "receptors", "landcover"):
        kinds: dict[str, int] = {}
        for f, _ in of(layer):
            k = f"{f['kind']}" + ("" if f["status"] == "existing" else f" ({f['status']})")
            kinds[k] = kinds.get(k, 0) + 1
        if kinds:
            info["features"][layer] = dict(sorted(kinds.items(), key=lambda kv: -kv[1]))
    info["receptor_buildings"] = n_receptors
    return layers, keep, info


def _num(v, default):
    try:
        return float(str(v).replace("m", "").strip())
    except (TypeError, ValueError):
        return default


def project_lonlat(lon, lat, ctx):
    """World x/y for a single lon/lat, using the pipeline's projection."""
    xy = ctx["project_arr"](np.array([[lon, lat]]))
    return float(xy[0, 0]), float(xy[0, 1])

