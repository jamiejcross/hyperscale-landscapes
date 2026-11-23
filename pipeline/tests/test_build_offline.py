"""End-to-end build on cached fixture data, with the network forbidden."""
import json
import zipfile

from conftest import FIXTURE_BBOX
from hyperscale_landscapes.pipeline import BuildOptions, build


def test_fixture_build(offline_cache, tmp_path):
    m = build(BuildOptions(**FIXTURE_BBOX, elevation="srtm", stl=True,
                           cache_dir=str(offline_cache), out_dir=str(tmp_path)))
    o = m["objects"]
    assert o["land"]["watertight"] is True
    assert o["buildings"]["count"] >= 10
    assert o["water"]["count"] >= 1
    assert o["roads"]["count"] >= 1
    for k in ("buildings", "roads", "water"):
        assert o[k]["watertight"] in (True, None), k
    assert m["stats"]["support_free"]
    assert m["stats"]["overhang_faces"] < 50
    assert m["union"]["watertight"] is True
    assert "OpenStreetMap" in m["attribution"]
    assert m["disclosure"].startswith("Height exaggerated ×2")
    assert m["provenance"]["elevation"]["id"] == "srtm-30m"
    with zipfile.ZipFile(m["outputs"]["3mf"]) as z:
        assert "Metadata/model_settings.config" in z.namelist()
    # print footprint: longest edge is the requested print size
    assert json.loads((tmp_path / f"manifest_{BuildOptions(**FIXTURE_BBOX).bbox_id}.json")
                      .read_text())["options"]["print_size"] == 150.0
