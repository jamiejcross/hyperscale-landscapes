"""Canopy height model rules (no network)."""
from hyperscale_landscapes.providers import canopy, lidar


def test_structure_buffers():
    sb = canopy._structure_buffer
    assert sb({"power": "line", "voltage": "132000"}) == 10.0
    assert sb({"power": "minor_line"}) == 4.0
    assert sb({"power": "tower"}) == canopy.SUPPORT_BUFFER_M
    assert sb({"power": "generator", "generator:source": "wind", "rotor:diameter": "92 m"}) == 46.0
    assert sb({"power": "generator", "generator:source": "wind"}) == canopy.TURBINE_RADIUS_ASSUMED_M
    assert sb({"power": "generator", "generator:source": "solar"}) is False
    assert sb({"building": "yes"}) is False


def test_programme_capture_table_covers_every_ranked_phase():
    for p in [f"phase-{i}" for i in range(1, 7)] + ["national-lidar-programme"]:
        assert p in lidar.PROGRAMME_CAPTURE and lidar.PROGRAMME_CAPTURE[p]["years"]


def test_rings_skip_points_outside_the_query_box():
    way = {"type": "way", "geometry": [{"lat": 1, "lon": 2}, None, {"lat": 3, "lon": 4}]}
    assert canopy._rings(way) == [[(2, 1), (4, 3)]]


def test_smooth_surfaces_are_not_trees_but_rough_canopy_is():
    import numpy as np
    rng = np.random.default_rng(0)
    chm = np.zeros((120, 120), np.float32)
    yy, xx = np.mgrid[0:60, 0:60]
    chm[30:90, 0:60] = 8 + 0.1 * xx            # a sloping roof, 3600 m2, perfectly smooth
    wood = rng.uniform(6, 18, (60, 60)).astype(np.float32)
    from scipy import ndimage as ndi
    chm[30:90, 60:120] = ndi.gaussian_filter(wood, 1.0)   # bumpy canopy
    smooth = canopy._smooth_surfaces(chm)
    assert smooth[40:80, 5:50].mean() > 0.95       # roof interior removed
    assert smooth[40:80, 70:115].mean() < 0.05     # canopy kept
