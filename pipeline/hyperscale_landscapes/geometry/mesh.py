"""Mesh and slab helpers, ported verbatim from ElchoMaps
(``elcho-maps/scripts/build_terrain.py``), which in turn ported them from
the multi-extruder pipeline.

Lessons preserved here (see PLAN.md §5):
- ``slab_from_poly`` forces CCW exteriors and CW holes with
  ``shapely.geometry.polygon.orient``; manifold3d rejects inverted slabs.
- Slabs are built with ``process=False`` so ring pinch points are never
  welded into non-manifold edges.
- ``separated_parts`` and ``nudge_duplicate_vertices`` keep shells apart at
  the 3MF's 4-decimal export precision.
"""
from __future__ import annotations

import logging
import math

import numpy as np
import trimesh
from shapely.geometry import Polygon
from shapely.geometry.polygon import orient

try:  # the real constrained-Delaunay library, if it builds on this Python
    import triangle as tr
except ImportError:  # pragma: no cover - depends on platform
    # The shim can leave a few boundary edges uncovered on large holed
    # polygons (seen on the Mossmorran road network: 12 open edges), so
    # warn loudly.  Install `triangle` for watertight road slabs.
    from . import triangle_shim as tr
    logging.getLogger(__name__).warning(
        "`triangle` is not installed; using the earcut fallback shim. "
        "Road slabs may not be watertight. pip install triangle")

log = logging.getLogger(__name__)


def densify_ring(pts, max_seg=4.0):
    out = []
    n = len(pts)
    for i in range(n):
        a, b = pts[i], pts[(i + 1) % n]
        out.append(a)
        d = math.hypot(b[0] - a[0], b[1] - a[1])
        if d > max_seg:
            steps = int(math.ceil(d / max_seg))
            for k in range(1, steps):
                t = k / steps
                out.append((a[0] + t * (b[0] - a[0]),
                            a[1] + t * (b[1] - a[1])))
    return out


def interior_grid_points(poly, spacing_m, edge_buf=0.5):
    """Vectorised interior grid-point generation (shapely 2.x contains_xy)."""
    from shapely import contains_xy
    minx, miny, maxx, maxy = poly.bounds
    inset = poly.buffer(-edge_buf)
    if inset.is_empty:
        return []
    sx = math.floor(minx / spacing_m) * spacing_m
    sy = math.floor(miny / spacing_m) * spacing_m
    gx = np.arange(sx, maxx + spacing_m * 0.5, spacing_m)
    gy = np.arange(sy, maxy + spacing_m * 0.5, spacing_m)
    if len(gx) == 0 or len(gy) == 0:
        return []
    xx, yy = np.meshgrid(gx, gy)
    xs, ys = xx.ravel(), yy.ravel()
    mask = contains_xy(inset, xs, ys)
    return list(zip(xs[mask], ys[mask]))


def slab_from_poly(sp, sample_elev_fn, above_units, below_units, interior_spacing,
                   bottom_elev_fn=None, bottom_offset=0.0, min_thickness=0.0,
                   max_seg=4.0):
    """Build a watertight terrain-draped slab from a polygon.

    If bottom_elev_fn is provided, the slab bottom follows that surface
    (plus bottom_offset) instead of sample_elev_fn - below_units.
    min_thickness keeps the slab from collapsing to zero height where the
    two surfaces meet — coincident top/bottom vertices get welded during
    processing and break watertightness.
    """
    if sp is None or sp.is_empty:
        return None
    if sp.geom_type == "MultiPolygon":
        sp = max(sp.geoms, key=lambda g: g.area)
    if sp.geom_type != "Polygon" or sp.area < 2.0:
        return None
    sp = orient(sp, sign=1.0)
    rings = [list(sp.exterior.coords)]
    for hole in sp.interiors:
        rings.append(list(hole.coords))
    rings = [r[:-1] if r and r[0] == r[-1] else r for r in rings]
    rings_d = [densify_ring(r, max_seg=max_seg) for r in rings]
    vertices = []
    segments = []
    for ring in rings_d:
        offset = len(vertices)
        if len(ring) < 3:
            continue
        for p in ring:
            vertices.append(p)
        for i in range(len(ring)):
            segments.append([offset + i, offset + (i + 1) % len(ring)])
    # De-duplicate coincident boundary vertices (ring pinch points, where a
    # hole touches the exterior).  A ~5 mm world offset (<1 µm at print
    # scale) keeps the shells separate even if a slicer or importer welds
    # vertices by position, which would otherwise create non-manifold edges.
    if len(vertices) > 1:
        vb = np.asarray(vertices, dtype=np.float64)
        _, inv, counts = np.unique(np.round(vb, 6), axis=0,
                                   return_inverse=True, return_counts=True)
        if (counts > 1).any():
            seen = {}
            for i, key in enumerate(inv.ravel()):
                k = int(key)
                n = seen.get(k, 0)
                if n > 0:
                    vertices[i] = (vertices[i][0] + 0.005 * n,
                                   vertices[i][1] + 0.005 * n)
                seen[k] = n + 1
    holes = []
    for hole in sp.interiors:
        try:
            hp = Polygon(hole.coords)
            if hp.is_valid and hp.area > 0:
                rp = hp.representative_point()
                holes.append((rp.x, rp.y))
        except Exception:
            pass
    for p in interior_grid_points(sp, interior_spacing, edge_buf=0.3):
        vertices.append(p)
    if len(vertices) < 3 or len(segments) < 3:
        return None
    pslg = {"vertices": np.array(vertices, dtype=np.float64),
            "segments": np.array(segments, dtype=np.int32)}
    if holes:
        pslg["holes"] = np.array(holes, dtype=np.float64)
    try:
        result = tr.triangulate(pslg, "p")
    except Exception:
        return None
    if "triangles" not in result or len(result["triangles"]) == 0:
        return None
    out_pts = np.asarray(result["vertices"], dtype=np.float64)
    out_tris = np.asarray(result["triangles"], dtype=np.int64)
    n_pts = len(out_pts)
    zs_terrain = np.asarray(sample_elev_fn(out_pts), dtype=np.float64)
    zs_top = zs_terrain + above_units
    if bottom_elev_fn is not None:
        zs_bot = np.asarray(bottom_elev_fn(out_pts), dtype=np.float64) + bottom_offset
    else:
        zs_bot = zs_terrain - below_units
    zs_bot = np.minimum(zs_bot, zs_top - min_thickness)
    verts = np.zeros((2 * n_pts, 3))
    verts[:n_pts, :2] = out_pts; verts[:n_pts, 2] = zs_bot
    verts[n_pts:, :2] = out_pts; verts[n_pts:, 2] = zs_top
    # Vectorised face assembly: top, bottom (flipped), then side walls
    top_faces = out_tris + n_pts
    bot_faces = out_tris[:, [0, 2, 1]]
    seg_arr = np.asarray(segments, dtype=np.int64)
    a, b = seg_arr[:, 0], seg_arr[:, 1]
    wall1 = np.column_stack([a + n_pts, a, b])
    wall2 = np.column_stack([a + n_pts, b, b + n_pts])
    faces = np.vstack([top_faces, bot_faces, wall1, wall2])
    # process=False: caps and walls index the same vertex array, so the
    # shell is closed by construction.  process=True would weld coincident
    # vertices at ring pinch points (where a hole touches the exterior),
    # creating non-manifold edges and breaking watertightness.
    rm = trimesh.Trimesh(vertices=verts, faces=faces, process=False)
    if len(rm.faces) == 0:
        return None
    return rm


def _rasterise_fast(geom, shape, xs, ys):
    """Vectorised point-in-polygon rasterisation using shapely 2.x."""
    from shapely import contains_xy
    xx, yy = np.meshgrid(xs, ys)
    coords = np.column_stack([xx.ravel(), yy.ravel()])
    mask = contains_xy(geom, coords[:, 0], coords[:, 1])
    return mask.reshape(shape)


# ============================================================================
# MESH HYGIENE — validation and safe decimation (3MF error reduction)
# ============================================================================

def clean_mesh(mesh, name="mesh", merge=True):
    """Drop degenerate/duplicate faces, fix normals, optionally merge verts.

    Run on every object before export so the .3MF contains only clean shells.
    Use merge=False for concatenations of separate closed bodies (e.g.
    buildings) — welding coincident vertices of *adjacent* bodies creates
    non-manifold edges and breaks watertightness.
    """
    if mesh is None or len(mesh.faces) == 0:
        return mesh
    pre_f = len(mesh.faces)
    if merge:
        mesh.merge_vertices()
        # Degenerate-face removal is only safe on single-shell meshes —
        # on multi-body concatenations it opens otherwise-closed shells.
        mesh.update_faces(mesh.nondegenerate_faces())
    mesh.update_faces(mesh.unique_faces())
    mesh.remove_unreferenced_vertices()
    trimesh.repair.fix_normals(mesh)
    removed = pre_f - len(mesh.faces)
    if removed > 0:
        log.info("  %s: removed %d degenerate/duplicate faces", name, removed)
    return mesh


def safe_decimate(mesh, target_faces, name="mesh", merge=True):
    """Quadric decimation that never trades watertightness for face count.

    If the input is watertight and the decimated result is not, the
    original mesh is kept (slicers reject leaky shells; big meshes are
    merely slow).
    """
    if mesh is None or len(mesh.faces) <= target_faces:
        return mesh
    was_watertight = mesh.is_watertight
    try:
        try:
            dec = mesh.simplify_quadric_decimation(face_count=target_faces)
        except TypeError:  # older trimesh: positional arg
            dec = mesh.simplify_quadric_decimation(target_faces)
    except Exception as e:
        log.warning("  %s: decimation failed (keeping original): %s", name, e)
        return mesh
    dec = clean_mesh(dec, name, merge=merge)
    if was_watertight and not dec.is_watertight:
        log.warning("  %s: decimation broke watertightness — keeping original "
                    "(%d faces)", name, len(mesh.faces))
        return mesh
    log.info("  %s: decimated %d -> %d faces (watertight=%s)",
             name, len(mesh.faces), len(dec.faces), dec.is_watertight)
    return dec


def separated_parts(geom, eps=0.005, simplify_tol=0.0):
    """Split a (Multi)Polygon into clean, well-separated Polygon parts.

    - shrink by ~eps metres: union parts can touch each other (or
      themselves, at ring pinch points) at single vertices; coincident
      vertices across shells become non-manifold edges if a slicer welds
      by position.  A 5 mm world shrink (<1 µm at print scale) separates
      them while looking identical.
    - simplify by simplify_tol metres: vertices closer together than the
      .3MF's 4-decimal coordinate precision collapse to identical points
      on export, which also welds into non-manifold edges.  Pass a
      tolerance of ~0.05 mm at print scale to drop them.
    """
    polys = (list(geom.geoms) if hasattr(geom, "geoms") else [geom])
    out = []
    for g in polys:
        if g.geom_type != "Polygon" or g.is_empty:
            continue
        gb = g.buffer(-eps)
        if gb.is_empty:
            gb = g  # too small to shrink — keep as-is
        if simplify_tol > 0:
            gs = gb.simplify(simplify_tol, preserve_topology=True)
            if not gs.is_empty:
                gb = gs
        if gb.geom_type == "Polygon":
            out.append(gb)
        elif hasattr(gb, "geoms"):
            out.extend(p for p in gb.geoms if p.geom_type == "Polygon")
    return out


def nudge_duplicate_vertices(mesh, name="mesh", eps=0.0005):
    """Separate vertices that would collide at .3MF export precision.

    Runs in PRINT-mm space after scaling: vertices are grouped at the
    export quantum (4 decimals), so near-coincident vertices that would
    round to identical coordinates — and weld into non-manifold edges in
    a position-welding importer — get pushed ~0.5 µm apart, which is
    invisible but survives the rounding.
    """
    if mesh is None or len(mesh.vertices) == 0:
        return mesh
    v = mesh.vertices.view(np.ndarray)
    _, inv, counts = np.unique(np.round(v, 4), axis=0,
                               return_inverse=True, return_counts=True)
    if not (counts > 1).any():
        return mesh
    n_moved = 0
    seen = {}
    for i, key in enumerate(inv.ravel()):
        k = int(key)
        n = seen.get(k, 0)
        if n > 0 and counts[k] > 1:
            v[i, 0] += eps * n
            v[i, 1] += eps * n
            n_moved += 1
        seen[k] = n + 1
    if n_moved:
        mesh.vertices = v
        log.info("  %s: nudged %d coincident vertices apart", name, n_moved)
    return mesh


def make_bilinear_sampler(grid, width_m, height_m):
    """Return a vectorised bilinear sampler over a regular elevation grid.

    The returned function accepts an (N, 2) array of x/y coords (or a list
    of tuples) and returns an (N,) array of interpolated values.
    """
    n_rows, n_cols = grid.shape

    def sampler(pts):
        pts = np.asarray(pts, dtype=np.float64).reshape(-1, 2)
        fc = np.clip(pts[:, 0] / width_m * (n_cols - 1), 0.0, n_cols - 1.0001)
        fr = np.clip((height_m - pts[:, 1]) / height_m * (n_rows - 1),
                     0.0, n_rows - 1.0001)
        c0 = fc.astype(np.int64); r0 = fr.astype(np.int64)
        dc = fc - c0; dr = fr - r0
        return ((1 - dc) * (1 - dr) * grid[r0, c0] +
                dc * (1 - dr) * grid[r0, c0 + 1] +
                (1 - dc) * dr * grid[r0 + 1, c0] +
                dc * dr * grid[r0 + 1, c0 + 1])

    return sampler

rasterise = _rasterise_fast
