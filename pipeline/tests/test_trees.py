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
