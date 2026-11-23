"""Insert and recess on a synthetic sloping terrain (no real site data)."""
import numpy as np
import trimesh
from shapely.geometry import box

from hyperscale_landscapes.geometry.insert import CLEARANCE_MM, build_insert, cut_all
from hyperscale_landscapes.geometry.union import subtract
from hyperscale_landscapes.pipeline import BuildOptions


def ctx():
    # 1000 m square world, 0.1 mm per m (100 mm print), gentle slope in x
    w2mm = 0.1
    def sample(pts):
        pts = np.asarray(pts).reshape(-1, 2)
        return 10 + 0.02 * pts[:, 0]
    terrain = trimesh.creation.box(extents=(1000, 1000, 80))
    terrain.apply_translation((500, 500, -10))      # top at z=30, bottom at -50
    return dict(world_to_mm=w2mm, sample_elev=sample, terrain_bbox=box(0, 0, 1000, 1000),
                base_bottom=-50.0, elev_z=np.array([[0.0, 30.0]]),
                opts=BuildOptions(0, 1, 0, 1)), terrain


def test_insert_fits_recess_with_clearance():
    c, terrain = ctx()
    fp = box(400, 400, 600, 500)                     # 200 x 100 m = 20 x 10 mm
    insert, recess, magnets, info = build_insert(c, fp, height_m=20.0)
    assert insert.is_watertight and recess.is_watertight
    # 10 mm wide cannot take two 6 mm magnets with walls: one, centred
    assert info["magnet_holes"] == 1
    _, _, _, big = build_insert(c, box(300, 300, 700, 500), height_m=20.0)
    assert big["magnet_holes"] == 2
    # clearance: recess is wider than the insert by 2 x 0.2 mm (in world metres)
    gap = (recess.bounds[1][0] - recess.bounds[0][0]) - (insert.bounds[1][0] - insert.bounds[0][0])
    assert abs(gap - 2 * CLEARANCE_MM / 0.1) < 0.5
    # floor is flat and below the lowest terrain under the footprint
    assert abs(recess.bounds[0][2] - insert.bounds[0][2]) < 1e-4   # float32 via manifold3d
    assert insert.bounds[0][2] < 10 + 0.02 * 400
    cut = subtract(terrain, recess)
    for m in magnets:
        cut = subtract(cut, m)
    assert cut.is_watertight
    assert cut.volume < terrain.volume
    cut.apply_translation((0, 0, 50))        # base bottom onto the bed (world = mm here x10)
    tri, n = cut.triangles, cut.face_normals
    floating = (n[:, 2] < -0.707) & (tri[:, :, 2].mean(1) > 1.0)
    assert not floating.any(), "recess or magnet holes created overhangs"


def test_cut_all_drops_buildings_inside_footprint():
    c, _ = ctx()
    _, recess, _, _ = build_insert(c, box(400, 400, 600, 500), height_m=20.0)
    inside = trimesh.creation.box(extents=(10, 10, 10)); inside.apply_translation((500, 450, 15))
    outside = trimesh.creation.box(extents=(10, 10, 10)); outside.apply_translation((100, 100, 15))
    out = cut_all([inside, outside], recess)
    assert len(out) == 1 and np.allclose(out[0].bounds, outside.bounds)
