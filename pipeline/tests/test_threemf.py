import zipfile
import xml.etree.ElementTree as ET

import trimesh

from hyperscale_landscapes.export.threemf import Part, export_3mf

NS = {"m": "http://schemas.microsoft.com/3dmanufacturing/core/2015/02"}


def test_3mf_round_trip(tmp_path):
    a = trimesh.creation.box(extents=(10, 10, 2)); a.apply_translation((5, 5, 1))
    b = trimesh.creation.box(extents=(2, 2, 4)); b.apply_translation((5, 5, 4))
    insert = trimesh.creation.box(extents=(3, 3, 3))
    path = tmp_path / "t.3mf"
    export_3mf(path, [Part("Land", a, "#8B7355", 1), Part("Buildings", b, "#C8C8C8", 4)],
               title="Test", metadata={"Copyright": "© OpenStreetMap contributors"},
               separate=[Part("Insert", insert, "#FFFFFF", 4)])
    with zipfile.ZipFile(path) as z:
        model = ET.fromstring(z.read("3D/3dmodel.model"))
        cfg = ET.fromstring(z.read("Metadata/model_settings.config"))
    objs = model.findall(".//m:object", NS)
    names = [o.get("name") for o in objs]
    assert names == ["Land", "Buildings", "Insert", "Test"]
    # two base materials (slots 1 and 4), parts point at the right one
    bases = model.findall(".//m:base", NS)
    assert [b.get("displaycolor") for b in bases] == ["#8B7355", "#C8C8C8"]
    assert objs[1].get("pindex") == "1"
    # build: the parent plus the separate insert
    assert len(model.findall(".//m:build/m:item", NS)) == 2
    meta = {m.get("name"): m.text for m in model.findall("m:metadata", NS)}
    assert "OpenStreetMap" in meta["Copyright"]
    # Bambu slot assignment
    ext = {p.find("metadata[@key='name']").get("value"):
           p.find("metadata[@key='extruder']").get("value")
           for p in cfg.iter("part")}
    assert ext == {"Land": "1", "Buildings": "4"}
    # and trimesh can read it back
    scene = trimesh.load(path)
    assert len(scene.geometry) >= 2
