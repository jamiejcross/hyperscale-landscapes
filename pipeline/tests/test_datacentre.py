"""Planning geometry for proposed data centres: council red lines, drawn buildings and zones,
and how they fold into each site's properties.massing (tools/fetch_council_boundaries.py,
tools/massing.py)."""
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "sites"
FIX = Path(__file__).parent / "fixtures"
sys.path.insert(0, str(ROOT / "tools"))

import fetch_council_boundaries as FCB  # noqa: E402
import massing as M  # noqa: E402


# ------------------------------------------------------------ council WFS

def test_wfs_response_parses_to_the_mapped_area():
    recs = FCB.parse_wfs((FIX / "wfs_falkirk_TFY4B9HC05J00.xml").read_bytes())
    assert len(recs) == 1
    r = recs[0]
    assert r["ref"] == "P/26/0237/FUL" and r["keyVal"] == "TFY4B9HC05J00"
    assert len(r["polygons"]) == 1 and len(r["polygons"][0][0]) == 36
    assert FCB.area_ha(r["polygons"]) == pytest.approx(18.78, abs=0.005)
    # first vertex, EPSG:27700 -> WGS84 at 7 dp, as in the published file
    assert FCB.to_wgs84(r["polygons"])[0][0][0] == [-3.8402605, 56.0346032]


def test_area_check_warns_only_above_five_percent():
    assert FCB.check_area(32.36, 28.21)            # Greenock: +15 %
    assert FCB.check_area(18.78, 18.92) is None    # Larbert: -0.7 %
    assert FCB.check_area(10.0, None) is None      # form area not read: no claim either way


def test_saved_dump_reproduces_the_red_lines_file(tmp_path):
    raw = DATA / "docs" / "_boundaries_27700_2026-11-26.json"
    if not raw.exists():
        pytest.skip("planning documents folder not present (git-ignored)")
    out = tmp_path / "rl.geojson"
    FCB.main(["--raw", str(raw), "--retrieved", "2026-11-26", "--out", str(out)])
    assert out.read_bytes() == (DATA / "datacentre-red-lines.geojson").read_bytes()


# ------------------------------------------------------------ features

def test_every_feature_carries_evidence_and_source():
    for name in ("datacentre-sites.geojson", "datacentre-red-lines.geojson"):
        for f in json.loads((DATA / name).read_text())["features"]:
            p = f["properties"]
            assert p.get("source"), (name, p)
            assert p.get("evidence", "documented") in ("documented", "indicative"), (name, p)
    for f in json.loads((DATA / "datacentre-sites.geojson").read_text())["features"]:
        assert f["properties"].get("evidence") in ("documented", "indicative"), f["properties"]


def test_drawn_features_from_drawings_record_an_acceptable_fit():
    for f in json.loads((DATA / "datacentre-sites.geojson").read_text())["features"]:
        g = f["properties"].get("georeference")
        if g:
            rms = float(g.split(":")[1].split("m RMS")[0])
            assert rms <= 5.0, f["properties"]["name"]


# ------------------------------------------------------------ massing

def test_tier_logic():
    doc = {"evidence": "documented"}
    ind = {"evidence": "indicative"}
    assert M.tier_for([doc], [], None) == "plans"           # Larbert, South Gyle
    assert M.tier_for([ind], [doc], {"x": 1}) == "plans"    # Chapelcross: documented zones
    assert M.tier_for([ind], [], {"x": 1}) == "indicative"  # Auchtertool, Greenock
    assert M.tier_for([], [], {"x": 1}) == "indicative"     # red line only
    assert M.tier_for([], [], None) is None


def test_merge_keeps_hand_entered_keys():
    hand = {"height_m": 24.5, "height_source": {"title": "Supporting Document"}, "tier": None, "buildings": []}
    m = M.merge(hand, {"tier": "plans", "buildings": [1], "zones": [], "red_line": None, "other_red_lines": []})
    assert m["height_source"] == {"title": "Supporting Document"} and m["height_m"] == 24.5
    assert m["tier"] == "plans" and m["buildings"] == [1]


def test_a_drawn_feature_without_a_source_is_rejected():
    drawn = {"features": [{"type": "Feature", "geometry": None,
                           "properties": {"site": "x", "name": "b", "kind": "building", "evidence": "indicative"}}]}
    with pytest.raises(ValueError):
        M.build({"features": []}, drawn, {"applications": []})


def test_site_files_are_up_to_date_and_validate():
    import jsonschema
    assert M.main(["--check"]) == 0, "run tools/massing.py"
    schema = json.loads((DATA / "schema.json").read_text())
    tiers = {}
    for s in json.loads((DATA / "index.json").read_text())["sites"]:
        doc = json.loads((DATA / s["file"]).read_text())
        jsonschema.validate(doc, schema)
        assert doc["geometry"] is None    # planning geometry lives in massing, screen only
        tiers[s["id"]] = (doc["properties"].get("massing") or {}).get("tier")
    assert tiers["larbert"] == tiers["south-gyle"] == tiers["chapelcross"] == "plans"
    assert tiers["auchtertool-cato"] == tiers["greenock"] == tiers["ravenscraig"] == "indicative"
    assert tiers["hunterston"] is None
