"""Pylons, lines and turbines: heights, bearings, precedence."""
import math

import pytest

from hyperscale_landscapes import structures as st


def test_bearing_and_bisector():
    assert st.bearing((0, 0), (0, 1)) == pytest.approx(0)
    assert st.bearing((0, 0), (1, 0)) == pytest.approx(90)
    assert st.bearing((0, 0), (-1, 0)) == pytest.approx(270)
    assert st.bisector(80, 100) == pytest.approx(90)
    assert st.bisector(350, 10) == pytest.approx(0, abs=1e-9) or st.bisector(350, 10) == pytest.approx(360)
    assert st.bisector(90, 270) == pytest.approx(90)          # doubles back: keep incoming


def _line(coords, tags):
    return {"type": "way", "id": 1, "tags": {"power": "line", **tags},
            "geometry": [{"lon": x, "lat": y} for x, y in coords]}


def _node(i, x, y, tags):
    return {"type": "node", "id": i, "lon": x, "lat": y, "tags": tags}


def test_support_bearing_is_the_bisector_of_the_line_through_it():
    # an L-shaped line: east, then north. The corner tower faces north-east (45 degrees).
    els = [_line([(0, 0), (1, 0), (1, 1)], {"voltage": "132000"}),
           _node(10, 0, 0, {"power": "tower"}), _node(11, 1, 0, {"power": "tower"}), _node(12, 1, 1, {"power": "tower"})]
    r = st.extract(els, lambda lon, lat: (lon, lat))
    b = {s["osm"]: s["bearing"] for s in r["supports"]}
    assert b["n10"] == pytest.approx(90) and b["n12"] == pytest.approx(0) and b["n11"] == pytest.approx(45)


def test_support_heights_osm_first_then_voltage_defaults_marked_assumed():
    els = [_line([(0, 0), (1, 0), (2, 0)], {"voltage": "400000;275000"}),
           _node(1, 0, 0, {"power": "tower", "height": "52 m"}), _node(2, 1, 0, {"power": "tower"}),
           _line([(5, 5), (6, 5)], {"voltage": "33000"}) | {"id": 2, "tags": {"power": "minor_line", "voltage": "33000"}},
           _node(3, 5, 5, {"power": "pole"})]
    r = st.extract(els, lambda lon, lat: (lon, lat))
    s = {x["osm"]: x for x in r["supports"]}
    assert (s["n1"]["height"], s["n1"]["height_source"]) == (52.0, "osm")
    assert (s["n2"]["height"], s["n2"]["height_source"]) == (46.5, "assumed") and "L12" in s["n2"]["height_rule"]
    assert (s["n3"]["height"], s["n3"]["height_source"]) == (9.2, "assumed") and "ES400W2" in s["n3"]["height_rule"]
    assert r["summary"]["support_height_sources"] == {"osm": 1, "assumed": 2}


def test_turbine_precedence_osm_then_site_override_then_default():
    osm = st.turbine_dims({"height:hub": "78", "rotor:diameter": "82"}, None)
    assert (osm["hub_height"], osm["rotor_diameter"], osm["source"]) == (78, 82, {"hub_height": "osm", "rotor_diameter": "osm"})
    tip = st.turbine_dims({"height": "119.3", "rotor:diameter": "82"}, None)        # total height -> hub
    assert tip["hub_height"] == pytest.approx(78.3) and tip["source"]["hub_height"] == "osm-derived"
    cur = st.turbine_dims({}, {"hub_height": 59, "rotor_diameter": 82, "source": "planning ref X"})
    assert cur["source"] == {"hub_height": "curated", "rotor_diameter": "curated"} and cur["curated_source"] == "planning ref X"
    dflt = st.turbine_dims({"height": "120"}, None)                                  # tip without rotor: not used
    assert (dflt["hub_height"], dflt["rotor_diameter"]) == (80.0, 90.0)
    assert dflt["source"] == {"hub_height": "assumed", "rotor_diameter": "assumed"}


def test_turbine_facing_defaults_to_prevailing_wind():
    r = st.extract([_node(1, 0, 0, {"power": "generator", "generator:source": "wind"}),
                    _node(2, 1, 0, {"power": "generator", "generator:source": "wind", "direction": "270"})],
                   lambda lon, lat: (lon, lat))
    f = {t["osm"]: (t["facing"], t["facing_source"]) for t in r["turbines"]}
    assert f["n1"][0] == 225 and f["n1"][1].startswith("assumed") and f["n2"] == (270.0, "osm")
    assert r["summary"]["turbines_with_assumed_size"] == 2


def test_metres_parsing():
    assert st.metres("52 m") == 52 and st.metres("52") == 52 and st.metres("100 ft") == 30.48
    assert st.metres("tall") is None and st.metres(None) is None
