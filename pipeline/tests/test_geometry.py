"""Geometry lessons from ../CLAUDE.md, pinned as tests."""
import numpy as np
import trimesh
from shapely.geometry import Polygon, box
from shapely.geometry.polygon import orient

from hyperscale_landscapes import pipeline
from hyperscale_landscapes.geometry import checks
from hyperscale_landscapes.geometry.mesh import slab_from_poly, separated_parts
from hyperscale_landscapes.geometry.union import union_solids


def flat(_pts):
    return np.zeros(len(np.asarray(_pts).reshape(-1, 2)))


def holed():
    # Exterior given clockwise and hole anticlockwise: the wrong way round.
    ext = [(0, 0), (0, 40), (40, 40), (40, 0)]
    hole = [(15, 15), (25, 15), (25, 25), (15, 25)]
    return Polygon(ext, [hole])


def test_orient_gives_ccw_exterior_and_cw_holes():
    p = orient(holed(), sign=1.0)
    assert p.exterior.is_ccw
    assert all(not r.is_ccw for r in p.interiors)


def test_slab_from_wrongly_wound_polygon_is_watertight_and_positive():
    m = slab_from_poly(holed(), flat, 1.0, 3.0, interior_spacing=5.0)
    assert m is not None
    assert m.is_watertight
    assert m.volume > 0
    # 40x40 minus 10x10 hole, 4 units thick
    assert abs(m.volume - (1600 - 100) * 4.0) < 1.0


def test_slab_survives_manifold3d():
    import manifold3d as m3d
    m = slab_from_poly(holed(), flat, 1.0, 3.0, interior_spacing=5.0)
    mf = m3d.Manifold(m3d.Mesh(m.vertices.astype(np.float32),
                               m.faces.astype(np.uint32)))
    assert mf.num_tri() > 0  # zero triangles means inverted winding


def test_river_filter_buffer_is_conservative():
    assert pipeline.RIVER_FILTER_BUFFER_M <= pipeline.RIVER_FILTER_BUFFER_MAX_M <= 80.0


def test_separated_parts_split_touching_polygons():
    touching = box(0, 0, 10, 10).union(box(10, 10, 20, 20))
    parts = separated_parts(touching)
    assert len(parts) == 2
    assert parts[0].distance(parts[1]) > 0


def test_union_discards_slivers_and_stays_watertight():
    base = trimesh.creation.box(extents=(50, 50, 10))
    tower = trimesh.creation.box(extents=(5, 5, 20))
    sliver = trimesh.creation.box(extents=(0.5, 0.5, 0.5))   # 0.125 mm³, detached
    sliver.apply_translation((100, 100, 0))
    out, stats = union_solids(base, [tower, sliver])
    assert stats["slivers_discarded"] == 1
    assert out.is_watertight


def test_overhang_check():
    cube = trimesh.creation.box(extents=(10, 10, 10))
    cube.apply_translation((0, 0, 5))          # sits on the bed
    assert checks.overhangs(cube) == (0, 0.0)
    cube.apply_translation((0, 0, 5))          # floating: bottom is an overhang
    n, area = checks.overhangs(cube)
    assert n == 2 and abs(area - 100) < 1e-6


def test_real_triangle_library_is_used():
    # The earcut shim leaves open edges on big holed road networks.
    from hyperscale_landscapes.geometry import mesh
    assert mesh.tr.__name__ == "triangle"
