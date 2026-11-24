import json
import re
from pathlib import Path

DATA = Path(__file__).resolve().parents[2] / "data" / "sites"
PERSONAL = re.compile(r"(email|phone|telephone|mobile|address|objector|resident_name)", re.I)


def test_index_points_at_real_files():
    idx = json.loads((DATA / "index.json").read_text())
    for s in idx["sites"]:
        assert (DATA / s["file"]).exists(), s["id"]


def test_no_personal_data_fields():
    for f in DATA.glob("*.geojson"):
        keys = json.dumps(json.loads(f.read_text())).split('"')
        bad = [k for k in keys if PERSONAL.fullmatch(k)]
        assert not bad, f"{f.name}: personal-data fields {bad}"


def test_auchtertool_has_no_invented_footprint():
    f = json.loads((DATA / "auchtertool-cato.geojson").read_text())
    assert f["geometry"] is None        # no footprint until sourced (JC, 23 Nov 2026)


def test_curated_bundles_are_small_and_valid():
    import gzip
    idx = json.loads((DATA / "index.json").read_text())
    for s in idx["sites"]:
        if not s.get("bundle"):
            continue
        p = DATA / s["bundle"]
        assert p.stat().st_size < 5_000_000, s["id"]
        b = json.loads(gzip.decompress(p.read_bytes()))
        assert b["schema"] == "hyperscale-landscapes/site-bundle@2"
        assert b["osm"]["elements"]
        L = b["elevation"].get("lidar")
        assert L or b["elevation"].get("tiles"), s["id"]
        if L:   # LiDAR grid: complete, credited, and any gap fill recorded
            assert len(L["data"]) * 3 // 4 >= L["w"] * L["h"] * 2
            assert "Open Government Licence" in L["attribution"]
            assert not L["gap_fraction"] or "no LiDAR survey" in L["attribution"]
        # A bundle must cover exactly the site's model area (the app ignores
        # mismatched bundles and falls back to live requests).
        site = json.loads((DATA / s["file"]).read_text())["properties"]
        assert b.get("bbox") == site["model_bbox"], f"{s['id']}: bundle needs re-baking"


def test_every_site_validates_against_the_schema():
    import jsonschema
    schema = json.loads((DATA / "schema.json").read_text())
    for f in sorted(DATA.glob("*.geojson")):
        jsonschema.validate(json.loads(f.read_text()), schema)


def test_every_site_has_a_source_and_a_sane_extent():
    for f in sorted(DATA.glob("*.geojson")):
        p = json.loads(f.read_text())["properties"]
        assert p["sources"] and all(s["url"].startswith("http") for s in p["sources"]), f.name
        bb = p["model_bbox"]
        assert bb["min_lat"] < bb["max_lat"] and bb["min_lon"] < bb["max_lon"], f.name
        if "location" in p:
            lon, lat = p["location"]
            assert bb["min_lon"] < lon < bb["max_lon"] and bb["min_lat"] < lat < bb["max_lat"], f.name
