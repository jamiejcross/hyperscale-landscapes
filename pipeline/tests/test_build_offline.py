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


def test_presets_and_insert(offline_cache, tmp_path):
    """Every preset fits its slot budget; a synthetic footprint (test only,
    not site data) produces a removable insert and a recessed, watertight land."""
    fp = tmp_path / "synthetic_footprint.geojson"
    fp.write_text(json.dumps({"type": "Feature", "properties": {"note": "synthetic test polygon"},
                              "geometry": {"type": "Polygon", "coordinates": [[
                                  [-3.2620, 56.0985], [-3.2590, 56.0985],
                                  [-3.2590, 56.0997], [-3.2620, 56.0997],
                                  [-3.2620, 56.0985]]]}}))
    m = build(BuildOptions(**FIXTURE_BBOX, elevation="srtm", preset="power-and-place",
                           footprint=str(fp), insert_height_m=25.0,
                           insert_height_source="test value", footprint_precision="approximate",
                           cache_dir=str(offline_cache), out_dir=str(tmp_path / "a")))
    assert len(m["print_objects"]) <= 4
    assert all(o["watertight"] in (True, None) for o in m["print_objects"].values())
    assert m["layers"]["terrain"]["watertight"] is True
    assert m["stats"]["support_free"]
    ins = m["insert"]
    assert ins["magnet_holes"] == 2 and ins["clearance_mm"] == 0.2
    assert ins["height_source"] == "test value"
    assert m["base_label"]["lines"][0].startswith("Terrain") or m["base_label"]["lines"]
    assert any("footprint approximate" in l for l in m["base_label"]["lines"])
    with zipfile.ZipFile(m["outputs"]["3mf"]) as z:
        model = z.read("3D/3dmodel.model").decode()
    assert 'name="Proposed data centre"' in model
    assert m["outputs"]["features_geojson"]

    for preset, limit in (("residues", 4), ("classic", 4), ("full", 8)):
        mm = build(BuildOptions(**FIXTURE_BBOX, elevation="srtm", preset=preset, labels=False,
                                cache_dir=str(offline_cache), out_dir=str(tmp_path / preset)))
        assert len(mm["print_objects"]) <= limit, preset

    single = build(BuildOptions(**FIXTURE_BBOX, elevation="srtm", preset="single-colour",
                                labels=False, cache_dir=str(offline_cache),
                                out_dir=str(tmp_path / "single")))
    assert single["outputs"]["3mf"] is None and single["union"]["watertight"] is True
