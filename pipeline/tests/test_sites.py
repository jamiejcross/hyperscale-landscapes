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
        assert b["schema"] == "hyperscale-landscapes/site-bundle@1"
        assert b["osm"]["elements"] and b["elevation"]["tiles"]
