"""Tree-top detection on synthetic canopy height models (1 m pixels)."""
import numpy as np

from hyperscale_landscapes import trees


def cone(chm, r0, c0, h, radius):
    y, x = np.ogrid[:chm.shape[0], :chm.shape[1]]
    d = np.hypot(y - r0, x - c0)
    np.maximum(chm, np.clip(h * (1 - d / radius), 0, None), out=chm)


def test_isolated_cones_one_top_each_at_the_right_height():
    chm = np.zeros((80, 80), np.float32)
    spec = [(20, 20, 18, 4), (20, 60, 9, 3), (60, 40, 25, 5)]
    for r, c, h, rad in spec:
        cone(chm, r, c, h, rad)
    t = trees.detect_tops(chm)
    assert len(t["h"]) == 3
    for r, c, h, _ in spec:
        i = np.argmin(np.hypot(t["row"] - r, t["col"] - c))
        assert np.hypot(t["row"][i] - r, t["col"][i] - c) <= 1.0
        assert abs(t["h"][i] - h) < 1.0
    # crown radius follows the window rule
    i = np.argmax(t["h"])
    assert abs(t["crown_r"][i] - 0.6 * 2 * min(4.0, 1.5 + 0.08 * t["h"][i])) < 1e-6


def test_short_vegetation_is_not_a_tree():
    chm = np.zeros((40, 40), np.float32)
    cone(chm, 20, 20, 3.5, 3)          # under 4 m
    assert len(trees.detect_tops(chm)["h"]) == 0


def test_plantation_grid_counts_every_tree():
    chm = np.zeros((100, 100), np.float32)
    n = 0
    for r in range(10, 95, 8):          # 8 m spacing, 12 m trees (window r = 2.46 m)
        for c in range(10, 95, 8):
            cone(chm, r, c, 12, 4); n += 1
    t = trees.detect_tops(chm)
    assert abs(len(t["h"]) - n) <= n * 0.02


def test_hedgerow_line_of_crowns_not_one_blob():
    chm = np.zeros((40, 120), np.float32)
    cols = range(10, 111, 7)            # a hedgerow with trees every 7 m
    for c in cols:
        cone(chm, 20, c, 8, 4)
    t = trees.detect_tops(chm)
    assert len(t["h"]) == len(list(cols))
    assert np.all(np.abs(t["row"] - 20) <= 1)


def test_flat_topped_ridge_gives_few_tops_not_dozens():
    chm = np.zeros((30, 120), np.float32)
    chm[13:17, 10:110] = 6.0            # a clipped, uniform hedge 100 m long
    t = trees.detect_tops(chm)
    assert 1 <= len(t["h"]) <= 3


def test_thinning_keeps_tallest_per_cell_and_counts():
    tops = {"row": np.array([1.0, 2.0, 15.0]), "col": np.array([1.0, 3.0, 5.0]),
            "h": np.array([10.0, 14.0, 9.0]), "crown_r": np.array([2.0, 2.5, 2.0])}
    out = trees.thin(tops, cell_m=10)
    assert out["summary"] == {"detected": 3, "drawn": 2, "thin_cell_m": 10, "capped": False, "cap": trees.MAX_SYMBOLS}
    assert sorted(out["h"].tolist()) == [9.0, 14.0]
    assert sorted(out["count"].tolist()) == [1, 2]


def test_cap_enlarges_the_cell_and_says_so():
    rng = np.random.default_rng(1)
    tops = {"row": rng.uniform(0, 1000, 5000), "col": rng.uniform(0, 1000, 5000),
            "h": rng.uniform(4, 30, 5000), "crown_r": np.full(5000, 2.0)}
    out = trees.thin(tops, cell_m=10, cap=1000)
    assert out["summary"]["drawn"] <= 1000 and out["summary"]["capped"]
    assert out["summary"]["thin_cell_m"] > 10
    assert out["count"].sum() == 5000


# ---- Stage 3: tree type precedence ----

def _sq(x0, y0, s, props):
    return {"type": "Feature", "properties": props,
            "geometry": {"type": "Polygon", "coordinates": [[[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s], [x0, y0]]]}}


def _woodland():
    # NFI conifer square at 0-100 m; NWSS birch/pine wood overlapping its east half; NFI felled at 200-300 m.
    return {
        "nfi": [_sq(300000, 700000, 100, {"IFT_IOA": "Conifer"}), _sq(300200, 700000, 100, {"IFT_IOA": "Felled"}),
                _sq(300400, 700000, 100, {"IFT_IOA": "Mixed mainly conifer"})],
        "nwss": [_sq(300050, 700000, 50, {"SCPTDATA_I": 1, "TYPE": "Native woodland"}),
                 _sq(300600, 700000, 50, {"SCPTDATA_I": 2, "TYPE": "Open land habitat"})],
        "nwss_species": [
            {"SCPTDATA_I": 1, "SPECIES": "Silver birch *", "STRUCTURE": "Mature", "SP_STR_PCT": 60},
            {"SCPTDATA_I": 1, "SPECIES": "Scots pine *", "STRUCTURE": "Pole immature", "SP_STR_PCT": 40},
            {"SCPTDATA_I": 1, "SPECIES": "Gorse *+", "STRUCTURE": "Shrub", "SP_STR_PCT": 50},
            {"SCPTDATA_I": 1, "SPECIES": "Rowan *", "STRUCTURE": "Visible regeneration", "SP_STR_PCT": 30},
            {"SCPTDATA_I": 2, "SPECIES": "Ash *", "STRUCTURE": "Mature", "SP_STR_PCT": 100}],
        "osm_trees": [],
    }


def test_type_precedence_nwss_over_nfi_and_default_outside():
    import numpy as np
    w = _woodland()
    x = np.array([300020.0, 300075.0, 300250.0, 300700.0, 300625.0])
    y = np.array([700050.0, 700025.0, 700050.0, 700050.0, 700025.0])
    c = trees.classify(x, y, np.array([12.0, 12.0, 15.0, 10.0, 10.0]), w)
    A, S = trees.ARCHETYPES, trees.SOURCES
    assert (A[c["archetype"][0]], S[c["source"][0]]) == ("spruce", "nfi")          # NFI conifer
    assert S[c["source"][1]] == "nwss" and A[c["archetype"][1]] in ("birch", "scots_pine")   # NWSS wins
    assert c["drop"][2] and c["warnings"]                                           # felled + tall -> dropped, warned
    assert (A[c["archetype"][3]], S[c["source"][3]]) == ("broadleaf", "default")     # outside everything
    assert S[c["source"][4]] == "default"                                           # open-land NWSS ignored


def test_nwss_proportions_follow_canopy_species_only():
    import numpy as np
    w = _woodland()
    rng = np.random.default_rng(3)
    x = rng.uniform(300051, 300099, 4000); y = rng.uniform(700001, 700049, 4000)
    c = trees.classify(x, y, np.full(4000, 10.0), w)
    a = np.array(trees.ARCHETYPES)[c["archetype"]]
    birch = (a == "birch").mean(); pine = (a == "scots_pine").mean()
    assert abs(birch - 0.6) < 0.03 and abs(pine - 0.4) < 0.03       # gorse (shrub) and regeneration ignored
    c2 = trees.classify(x, y, np.full(4000, 10.0), w)
    assert (c2["archetype"] == c["archetype"]).all()                 # deterministic


def test_nfi_mixed_mainly_conifer_is_70_30():
    import numpy as np
    w = _woodland()
    rng = np.random.default_rng(4)
    x = rng.uniform(300401, 300499, 5000); y = rng.uniform(700001, 700099, 5000)
    a = np.array(trees.ARCHETYPES)[trees.classify(x, y, np.full(5000, 10.0), w)["archetype"]]
    assert abs((a == "spruce").mean() - 0.7) < 0.03


def test_species_and_osm_mapping():
    assert trees.nwss_archetype("Scots pine *") == "scots_pine"
    assert trees.nwss_archetype("Downy birch *") == "birch"
    assert trees.nwss_archetype("Dwarf birch *+") is None
    assert trees.nwss_archetype("Hybrid larch") == "spruce"
    assert trees.nwss_archetype("Sessile oak *") == "broadleaf"
    assert trees.osm_archetype({"species": "Pinus sylvestris"}) == "scots_pine"
    assert trees.osm_archetype({"genus": "Betula"}) == "birch"
    assert trees.osm_archetype({"leaf_type": "needleleaved"}) == "spruce"
    assert trees.osm_archetype({"leaf_type": "broadleaved"}) == "broadleaf"
    assert trees.osm_archetype({}) is None


def test_osm_tree_within_3m_wins():
    import numpy as np
    from pyproj import Transformer
    w = _woodland()
    lon, lat = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True).transform(300021.0, 700051.0)
    w["osm_trees"] = [{"lon": lon, "lat": lat, "tags": {"genus": "Betula"}}]
    c = trees.classify(np.array([300020.0, 300030.0]), np.array([700050.0, 700050.0]), np.array([10.0, 10.0]), w)
    assert trees.SOURCES[c["source"][0]] == "osm" and trees.ARCHETYPES[c["archetype"][0]] == "birch"
    assert trees.SOURCES[c["source"][1]] == "nfi"                    # 10 m away: not matched
