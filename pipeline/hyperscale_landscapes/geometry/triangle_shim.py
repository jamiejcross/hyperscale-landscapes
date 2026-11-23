"""Drop-in shim for the `triangle` package using mapbox_earcut + scipy.

Replaces tr.triangulate(pslg, "p") used by build_terrain.py.

Strategy
--------
The real `triangle` library does constrained Delaunay triangulation (CDT).
scipy.spatial.Delaunay is *unconstrained* and produces triangles outside the
polygon, which makes road-slab meshes non-manifold (manifold3d rejects them).

This shim uses:
1. mapbox_earcut for polygon triangulation — guarantees all triangles are
   inside the boundary and all boundary edges appear in the output.
2. If there are interior Steiner points (for terrain draping on wide polygons),
   we rebuild the triangulation using scipy Delaunay on ALL points, then keep
   only triangles whose edges are all contained within the polygon.

Rings are tracked as INDEX lists into the PSLG vertex array throughout, so
triangle indices always refer to the caller's vertex order (the side-wall
builder in build_terrain.py indexes the same array via `segments`).
"""
from __future__ import annotations

import numpy as np
import mapbox_earcut as earcut
from scipy.spatial import Delaunay
from shapely.geometry import Polygon
from shapely.validation import make_valid


def triangulate(pslg: dict, opts: str = "p") -> dict:
    verts = np.asarray(pslg["vertices"], dtype=np.float64)
    segments = pslg.get("segments")

    if len(verts) < 3:
        return {"vertices": verts, "triangles": np.empty((0, 3), dtype=np.int64)}

    if segments is None or len(segments) == 0:
        # No boundary info — fall back to plain Delaunay
        dt = Delaunay(verts)
        return {"vertices": verts, "triangles": dt.simplices}

    segments = np.asarray(segments, dtype=np.int64)

    # --- Reconstruct polygon rings (as vertex-index lists) from segments ---
    rings_idx = _segments_to_rings(segments, verts)
    if not rings_idx:
        dt = Delaunay(verts)
        return {"vertices": verts, "triangles": dt.simplices}

    # Count how many vertices belong to boundary rings
    n_boundary = sum(len(r) for r in rings_idx)
    n_interior = len(verts) - n_boundary

    if n_interior == 0:
        # ---- EARCUT PATH: boundary-only vertices (most roads) ----
        return _earcut_triangulate(verts, rings_idx)
    else:
        # ---- HYBRID PATH: boundary + interior Steiner points ----
        # Use Delaunay on all points, then filter strictly using the polygon
        return _delaunay_constrained(verts, segments, rings_idx)


def _earcut_triangulate(verts, rings_idx):
    """Triangulate with mapbox_earcut, returning GLOBAL vertex indices.

    Two historical bugs fixed here:
    - mapbox_earcut takes cumulative ring END indices (exclusive), not ring
      lengths.  Passing lengths raised ValueError for any polygon with holes,
      so holed road networks silently lost their mesh.
    - earcut's output indices refer to the concatenated ring coordinate
      array; they must be mapped back to the caller's vertex order, which
      the side-wall builder also uses.
    """
    concat = np.concatenate([np.asarray(r, dtype=np.int64) for r in rings_idx])
    coords = np.ascontiguousarray(verts[concat], dtype=np.float64)
    ring_ends = np.cumsum([len(r) for r in rings_idx]).astype(np.uint32)

    tri_local = earcut.triangulate_float64(coords, ring_ends)
    tris = concat[tri_local.reshape(-1, 3).astype(np.int64)]

    return {"vertices": verts, "triangles": tris}


def _rings_to_polygon(verts, rings_idx):
    """Build a shapely Polygon (largest ring exterior, rest holes)."""
    exterior = verts[np.asarray(rings_idx[0], dtype=np.int64)]
    holes = [verts[np.asarray(r, dtype=np.int64)] for r in rings_idx[1:]]
    poly = Polygon(exterior, holes)
    if not poly.is_valid:
        poly = make_valid(poly)
        if poly.geom_type == "MultiPolygon":
            poly = max(poly.geoms, key=lambda g: g.area)
    return poly


def _delaunay_constrained(verts, segments, rings_idx):
    """Delaunay on all points, then keep only triangles inside the polygon.

    Checks both triangle centroids and non-boundary edge midpoints (the
    latter catches slivers that cross the boundary), fully vectorised.
    """
    dt = Delaunay(verts)
    tris = dt.simplices.astype(np.int64)

    poly = _rings_to_polygon(verts, rings_idx)
    if poly.is_empty or poly.geom_type != "Polygon":
        return {"vertices": verts, "triangles": tris}

    # Collect all boundary edges from the segments
    boundary_edges = set()
    for seg in segments:
        a, b = int(seg[0]), int(seg[1])
        boundary_edges.add((min(a, b), max(a, b)))

    # Vectorised filtering (shapely 2.x contains_xy):
    # 1. Triangle centroid must be inside the polygon.
    # 2. Each non-boundary edge midpoint must be inside the (slightly
    #    shrunk) polygon — catches triangles that cross the boundary.
    from shapely import contains_xy

    bx0, by0, bx1, by1 = poly.bounds
    tol = max(bx1 - bx0, by1 - by0) * 5e-4
    poly_shrunk = poly.buffer(-tol) if tol > 0 else poly
    if poly_shrunk.is_empty:
        poly_shrunk = poly

    centroids = verts[tris].mean(axis=1)
    keep = contains_xy(poly, centroids[:, 0], centroids[:, 1])

    # Edge midpoints for all three edges of every triangle
    e_a = np.stack([tris[:, 0], tris[:, 1], tris[:, 2]], axis=1)  # (n, 3)
    e_b = np.stack([tris[:, 1], tris[:, 2], tris[:, 0]], axis=1)
    mids = (verts[e_a] + verts[e_b]) / 2.0                        # (n, 3, 2)
    mids_inside = contains_xy(
        poly_shrunk, mids[..., 0].ravel(), mids[..., 1].ravel()
    ).reshape(len(tris), 3)

    # Boundary edges are exempt from the midpoint test
    lo = np.minimum(e_a, e_b)
    hi = np.maximum(e_a, e_b)
    if boundary_edges:
        b_arr = np.array(sorted(boundary_edges), dtype=np.int64)
        max_idx = int(max(hi.max(), b_arr.max())) + 1
        edge_keys = lo * max_idx + hi
        boundary_keys = b_arr[:, 0] * max_idx + b_arr[:, 1]
        is_boundary = np.isin(edge_keys, boundary_keys)
    else:
        is_boundary = np.zeros(e_a.shape, dtype=bool)

    edges_ok = (mids_inside | is_boundary).all(axis=1)
    keep &= edges_ok
    tris = tris[keep]

    # Safety: ensure all boundary segments appear as edges in the output.
    # If any are missing, the mesh side-walls won't match and we get
    # non-manifold geometry. Fall back to earcut if coverage is incomplete.
    if len(tris) and boundary_edges:
        t_a = np.concatenate([tris[:, 0], tris[:, 1], tris[:, 2]])
        t_b = np.concatenate([tris[:, 1], tris[:, 2], tris[:, 0]])
        t_lo = np.minimum(t_a, t_b)
        t_hi = np.maximum(t_a, t_b)
        b_arr = np.array(sorted(boundary_edges), dtype=np.int64)
        max_idx = int(max(t_hi.max(), b_arr.max())) + 1
        tri_keys = np.unique(t_lo * max_idx + t_hi)
        boundary_keys = b_arr[:, 0] * max_idx + b_arr[:, 1]
        missing = int((~np.isin(boundary_keys, tri_keys)).sum())
    else:
        missing = len(boundary_edges)
    if missing > 0:
        # Delaunay couldn't preserve all boundary edges — fall back to earcut
        # (loses interior points but at least produces a valid mesh)
        return _earcut_triangulate(verts, rings_idx)

    return {"vertices": verts, "triangles": tris}


def _segments_to_rings(segments, verts):
    """Reconstruct closed rings from segments as vertex-INDEX lists.

    Returns rings sorted largest-area first (exterior, then holes).
    """
    from collections import defaultdict

    adj = defaultdict(list)
    for s in segments:
        adj[int(s[0])].append(int(s[1]))
        adj[int(s[1])].append(int(s[0]))

    visited_edges = set()
    rings = []

    for start_seg in segments:
        edge = (int(start_seg[0]), int(start_seg[1]))
        if edge in visited_edges:
            continue

        ring_indices = [edge[0]]
        prev = edge[0]
        curr = edge[1]
        visited_edges.add((prev, curr))
        visited_edges.add((curr, prev))

        while curr != ring_indices[0]:
            ring_indices.append(curr)
            neighbors = adj[curr]
            next_node = None
            for n in neighbors:
                if (curr, n) not in visited_edges and n != prev:
                    next_node = n
                    break
            if next_node is None:
                for n in neighbors:
                    if (curr, n) not in visited_edges:
                        next_node = n
                        break
            if next_node is None:
                break
            visited_edges.add((curr, next_node))
            visited_edges.add((next_node, curr))
            prev = curr
            curr = next_node

        if curr == ring_indices[0] and len(ring_indices) >= 3:
            rings.append(ring_indices)

    # Largest-area ring first (exterior), rest are holes
    if len(rings) > 1:
        rings.sort(
            key=lambda r: Polygon(verts[np.asarray(r)]).area if len(r) >= 3 else 0,
            reverse=True,
        )

    return rings
