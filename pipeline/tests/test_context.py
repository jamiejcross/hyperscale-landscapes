"""The @4 context section (context.py): grid snapping, the offset, the
encoding, the stripping of the context OSM and the query's tags."""
import re
from pathlib import Path

import numpy as np
import pytest

from hyperscale_landscapes import context as C

ROOT = Path(__file__).resolve().parents[2]
BB = {"min_lat": 56.08, "max_lat": 56.095, "min_lon": -3.27, "max_lon": -3.24}


@pytest.mark.parametrize("W,H", [(1866.7, 1669.8), (3200.0, 1600.0), (1513.3, 2047.9), (55.0, 31.0)])
def test_model_corners_fall_on_grid_vertices(W, H):
    s = C.grid_spec(W, H)
    xs, ys = C.vertex_xy(s)
    k = C.model_corner_index(s)
    assert xs[k["sw"][0]] == pytest.approx(0, abs=1e-6) and ys[k["sw"][1]] == pytest.approx(0, abs=1e-6)
    assert xs[k["ne"][0]] == pytest.approx(W, abs=1e-6) and ys[k["ne"][1]] == pytest.approx(H, abs=1e-6)
    assert xs[k["se"][0]] == pytest.approx(W, abs=1e-6) and ys[k["nw"][1]] == pytest.approx(H, abs=1e-6)
    # cells near 20 m, pad at least the asked-for distance and a whole number of cells
    assert abs(s["dx"] - 20) <= 10 and abs(s["dy"] - 20) <= 10
    assert -xs[0] >= C.PAD_M - 1e-6 and ys[0] - H >= C.PAD_M - 1e-6
    assert xs[-1] - W == pytest.approx(-xs[0]) and -ys[-1] == pytest.approx(ys[0] - H)


def test_boundary_vertices_lie_on_the_model_edges():
    W, H = 1866.7, 1669.8
    s = C.grid_spec(W, H)
    xs, ys = C.vertex_xy(s)
    b = C.boundary_index(s)
    assert len(b) == len(set(b)) == 2 * (s["model_cells_x"] + s["model_cells_y"])
    for c, r in b:
        x, y = xs[c], ys[r]
        on = min(abs(x), abs(x - W), abs(y), abs(y - H))
        assert on < 1e-6 and -1e-6 <= x <= W + 1e-6 and -1e-6 <= y <= H + 1e-6


def test_grid_encoding_round_trips():
    rng = np.random.default_rng(1)
    z = np.cumsum(rng.normal(0, 3, (40, 57)), axis=1) + 120
    back = C.decode_grid(C.encode_grid(z), 57, 40)
    assert np.abs(back - z).max() <= 0.05 + 1e-9


def test_offset_sign_lifts_a_low_context_to_meet_the_model(monkeypatch):
    """A context surface 2 m below the model terrain gets offset +2 m."""
    to_ll, W, H = C.projection(BB)
    slope = lambda lon, lat: 100 + (np.asarray(lon) + 3.27) * 900 + (np.asarray(lat) - 56.08) * 1500
    monkeypatch.setattr(C, "model_sampler", lambda bundle: (slope, "test-lidar"))

    class R:      # the provider's Copernicus result: a raster 2 m below the model
        source = "copernicus-30m"
        def __init__(self, box):
            lon = np.linspace(box.min_lon, box.max_lon, 300); lat = np.linspace(box.max_lat, box.min_lat, 300)
            LON, LAT = np.meshgrid(lon, lat)
            d = (box.max_lon - box.min_lon) / 300 / 2, (box.max_lat - box.min_lat) / 300 / 2
            self.data = {"elev": slope(LON, LAT) - 2.0,
                         "extent": {"west": box.min_lon - d[0], "east": box.max_lon + d[0],
                                    "north": box.max_lat + d[1], "south": box.min_lat - d[1]}}
    monkeypatch.setattr(C.elev_provider, "fetch", lambda box, cache, prefer: R(box))
    e = C.context_elevation({"bbox": BB, "elevation": {}}, pad_m=400)
    assert e["offset_m"] == pytest.approx(2.0, abs=0.05)
    z = C.decode_grid(e["data"], e["w"], e["h"])
    k = C.model_corner_index(C.grid_spec(W, H, 400))
    c, r = k["sw"]
    lon, lat = to_ll(0.0, 0.0)
    assert z[r, c] == pytest.approx(float(slope(lon, lat)), abs=0.1)     # meets the model at the corner


def test_strip_drops_features_wholly_inside_and_unused_tags():
    inside = {"lat": 56.09, "lon": -3.25}
    outside = {"lat": 56.2, "lon": -3.25}
    osm = {"elements": [
        {"type": "way", "id": 1, "tags": {"building": "yes", "addr:street": "x"}, "geometry": [inside, inside]},
        {"type": "way", "id": 2, "tags": {"power": "line", "voltage": "275000", "operator": "SPEN"}, "geometry": [inside, outside]},
        {"type": "node", "id": 3, "lat": 56.123456789, "lon": -3.3, "tags": {"place": "village", "name": "Cardenden", "population": "1"}},
        {"type": "relation", "id": 4, "tags": {"landuse": "industrial", "name": "Mossmorran"},
         "members": [{"type": "way", "role": "outer", "geometry": [outside, outside]}]},
    ]}
    s = C.strip_osm(osm, BB)
    ids = [e["id"] for e in s["elements"]]
    assert ids == [2, 3, 4] and s["dropped_inside"] == 1
    assert s["elements"][0]["tags"] == {"power": "line", "voltage": "275000"}
    assert s["elements"][1]["lat"] == 56.12346 and s["elements"][1]["tags"] == {"place": "village", "name": "Cardenden"}
    assert s["elements"][2]["members"][0]["role"] == "outer"


def test_context_query_asks_only_for_kept_tags_and_the_listed_features():
    q = (ROOT / "data/overpass/context.ql").read_text()
    keys = set(re.findall(r'\["([a-z_:]+)"', q))
    assert keys == C.QUERY_KEYS and C.QUERY_KEYS <= C.KEEP_TAGS
    for want in ('"power"~"^(line|minor_line)$"', '"power"~"^(tower|pole)$"', '"railway"~"^(rail|disused)$"',
                 '"waterway"~"^(river|stream|canal)$"', '"natural"="water"', '"landuse"~"^(industrial|quarry|landfill)$"',
                 '"man_made"="pipeline"', '"place"~"^(village|hamlet|town)$"', '"highway"="unclassified"'):
        assert want in q
    assert re.search(r'"highway"~"\^\(motorway\|trunk\|primary\|secondary\|tertiary\)\(_link\)\?\$"', q)
    assert "{{bbox}}" in q and C.query(C.BBox(56.0, 56.1, -3.3, -3.2)).count("56.0,-3.3,56.1,-3.2") == q.count("{{bbox}}")


def test_context_power_keeps_supports_outside_by_the_props_rules():
    inside, out1, out2 = {"lat": 56.09, "lon": -3.25}, {"lat": 56.10, "lon": -3.25}, {"lat": 56.11, "lon": -3.25}
    osm = {"elements": [
        {"type": "way", "id": 1, "tags": {"power": "line", "voltage": "275000"}, "geometry": [inside, out1, out2]},
        {"type": "way", "id": 2, "tags": {"power": "minor_line"}, "geometry": [inside, inside]},
        {"type": "node", "id": 3, **inside, "tags": {"power": "tower"}},
        {"type": "node", "id": 4, **out1, "tags": {"power": "tower"}},
        {"type": "node", "id": 5, **out2, "tags": {"power": "tower", "height": "40"}},
    ]}
    p = C.context_power(osm, BB)
    assert [s["osm"] for s in p["supports"]] == ["n4", "n5"] and [l["osm"] for l in p["lines"]] == ["w1"]
    s4, s5 = p["supports"]
    assert s4["height"] == 36.9 and s4["height_source"] == "assumed"       # 275 kV tower default
    assert s5["height"] == 40 and s5["height_source"] == "osm"
    assert s4["bearing"] == pytest.approx(0, abs=0.5)                       # the line runs north
    assert s4["y"] > 0 and abs(s4["x"] - (s5["x"])) < 0.2 and len(p["lines"][0]["xy"]) == 3
