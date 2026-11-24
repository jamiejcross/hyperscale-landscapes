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
