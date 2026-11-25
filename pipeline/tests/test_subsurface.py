"""Offline tests for the subsurface provider's pure parts."""
from hyperscale_landscapes.providers.subsurface import (
    classify_pit, council_tokens, name_variants, parse_fields, pit_base_name, wall_points)

FIXTURE = """<?xml version="1.0" encoding="UTF-8"?>
<FeatureInfoResponse xmlns="http://www.esri.com/wms">
<FIELDS OBJECTID="1" LEX="PDB" LEX_D="Pathhead Formation" RCS_X="MDST + SDST > 50% &amp; SLST" BGSRED="224"></FIELDS>
<FIELDS OBJECTID="2" LEX="TILLD" LEX_D="Till, Devensian" RCS_X="DMTN"/>
</FeatureInfoResponse>"""


def test_parse_fields_handles_gt_in_values():
    recs = parse_fields(FIXTURE)
    assert len(recs) == 2
    assert recs[0]["LEX_D"] == "Pathhead Formation"
    assert recs[0]["RCS_X"] == "MDST + SDST > 50% & SLST"
    assert recs[0]["BGSRED"] == "224"
    assert recs[1]["LEX"] == "TILLD"


def test_parse_fields_empty_response():
    assert parse_fields('<FeatureInfoResponse xmlns="http://www.esri.com/wms"></FeatureInfoResponse>') == []


def test_pit_names_and_variants():
    assert pit_base_name("Little Raith Quarries") == "LITTLE RAITH"
    assert pit_base_name("Dundonald Colliery") == "DUNDONALD"
    assert pit_base_name("Camilla") == "CAMILLA"
    assert name_variants("Walton") == ["WALTON", "WALTON COLLIERY", "WALTON PIT"]
    assert name_variants("Little Raith Quarries")[:2] == ["LITTLE RAITH QUARRIES", "LITTLE RAITH"]


def test_council_tokens():
    assert council_tokens("City of Edinburgh") == ["CITY OF EDINBURGH", "EDINBURGH"]
    assert council_tokens("Fife") == ["FIFE"]


def test_classify_pit():
    coal = [{"minerals": "Coal and associated minerals"}]
    iron = [{"minerals": "Ironstone"}]
    assert classify_pit({"name": "Little Raith"}, coal) == "coal"
    assert classify_pit({"name": "Little Raith Quarries"}, coal) == "coal"      # coal plan wins (flagged elsewhere)
    assert classify_pit({"name": "Cults Quarry"}, []) == "quarry"
    assert classify_pit({"name": "Camilla"}, iron) == "unknown"
    assert classify_pit({"name": "Camilla"}, []) == "unknown"
    assert classify_pit({"name": "Camilla"}, [], commodity="Sandstone") == "quarry"
    assert classify_pit({"name": "X"}, [], commodity="Coal, deep") == "coal"
    assert classify_pit({"name": "Dalzell Colliery"}, []) == "coal"           # coal by name (flagged)
    assert classify_pit({"name": "Parkneuk Colliery Pits Nos 1 & 2"}, []) == "coal"
    assert classify_pit({"name": "Wellington Pit"}, []) == "unknown"
    assert classify_pit({"name": "Colliery Quarry"}, []) == "quarry"         # a quarry name wins


def test_wall_points_order_and_spacing():
    bb = {"min_lat": 56.0, "max_lat": 56.01, "min_lon": -3.02, "max_lon": -3.0}
    s = wall_points(bb, 40)
    # S runs west->east, E south->north, N east->west, W north->south
    assert s["south"][0][:2] == (-3.02, 56.0) and s["south"][-1][:2] == (-3.0, 56.0)
    assert s["east"][0][:2] == (-3.0, 56.0) and s["east"][-1][:2] == (-3.0, 56.01)
    assert s["north"][0][:2] == (-3.0, 56.01) and s["north"][-1][:2] == (-3.02, 56.01)
    assert s["west"][0][:2] == (-3.02, 56.01) and s["west"][-1][:2] == (-3.02, 56.0)
    steps = [b[2] - a[2] for a, b in zip(s["south"], s["south"][1:])]
    assert all(35 <= d <= 45 for d in steps)
