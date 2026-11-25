"""Bundle @3 sections: tree packing round trip and the app frame."""
import json
import math
from pathlib import Path

from hyperscale_landscapes.bake import app_projection, decode_trees, encode_trees

FIXTURE = Path(__file__).resolve().parents[2] / "tests" / "web" / "fixtures" / "trees_encoded.json"


def sample():
    return dict(x=[0.0, 12.34, 3199.9, 1500.05], y=[0.0, 7.77, 1599.9, 800.0], h=[4.0, 12.3, 43.9, 20.05],
                crown_r=[1.2, 4.8, 30.0, 2.0], archetype=[0, 1, 2, 4], source=[3, 2, 1, 0])


def test_round_trip_decimetres():
    s = sample()
    enc = encode_trees(**s, width_m=3200, height_m=1600)
    assert enc["xy_unit_m"] == 0.1 and enc["count"] == 4
    dec = decode_trees(enc)
    got = sorted(zip(dec["x"], dec["y"], dec["h"], dec["archetype"], dec["source"], dec["crown_r"]))
    want = sorted(zip(s["x"], s["y"], s["h"], s["archetype"], s["source"], [min(c, 25.5) for c in s["crown_r"]]))
    for g, w in zip(got, want):
        assert all(abs(a - b) <= 0.051 for a, b in zip(g, w)), (g, w)


def test_half_metre_grid_for_large_sites():
    enc = encode_trees(x=[7000.0], y=[10.0], h=[5], crown_r=[1], archetype=[0], source=[0], width_m=8000, height_m=3000)
    assert enc["xy_unit_m"] == 0.5
    assert decode_trees(enc)["x"] == [7000.0]


def test_app_projection_matches_geo_js():
    bb = {"min_lat": 56.0, "max_lat": 56.02, "min_lon": -3.1, "max_lon": -3.05}
    to_xy, W, H = app_projection(bb)
    assert to_xy(-3.1, 56.0) == (0.0, 0.0)
    assert math.isclose(H, 0.02 * 111320, rel_tol=1e-9)
    assert math.isclose(W, 0.05 * 111320 * math.cos(math.radians(56.01)), rel_tol=1e-9)


def test_fixture_for_js_decoder_is_current():
    # The JS test decodes this file; regenerate it from the Python encoder if this fails.
    enc = encode_trees(**sample(), width_m=3200, height_m=1600)
    if not FIXTURE.exists() or json.loads(FIXTURE.read_text())["trees"]["data"] != enc["data"]:
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_text(json.dumps({"trees": {**enc, "archetypes": ["broadleaf", "spruce", "scots_pine", "birch", "young"],
                                                 "sources": ["default", "osm", "nwss", "nfi"]}}, indent=1))
    assert json.loads(FIXTURE.read_text())["trees"]["data"] == enc["data"]
