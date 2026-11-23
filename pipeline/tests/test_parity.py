"""Parity with JC's multi-extruder Mossmorran build (PLAN.md §11, Phase 1).

Reference: multi-extruder manifest_56.09158_56.10642_-3.30543_-3.24569.json
(22 Nov 2026): 232 buildings, 110 road slabs, 5 water slabs, land
watertight, 0 overhang faces, SRTM elevation, buildings at ×2.

Road and water *counts* are not comparable one-to-one: ElchoMaps unions the
road network before meshing (one slab per connected part, not per OSM way)
and splits water differently.  So roads and water are checked for presence
and integrity; buildings are checked within ±5 %, since OSM may have changed
since the reference was built.
"""
import pytest

from hyperscale_landscapes.pipeline import BuildOptions, build

REF = dict(min_lat=56.09158, max_lat=56.10642, min_lon=-3.30543, max_lon=-3.24569)
REF_BUILDINGS = 232


@pytest.mark.network
@pytest.mark.slow
def test_mossmorran_parity(tmp_path):
    m = build(BuildOptions(**REF, elevation="srtm", building_exag=2.0,
                           out_dir=str(tmp_path)))
    o = m["objects"]
    assert abs(o["buildings"]["count"] - REF_BUILDINGS) <= 0.05 * REF_BUILDINGS
    assert o["roads"]["count"] > 0 and o["water"]["count"] > 0
    assert all(o[k]["watertight"] for k in ("land", "buildings", "roads", "water"))
    assert m["stats"]["overhang_faces"] == 0
    assert m["world"]["width_m"] == pytest.approx(3720, rel=0.02)
