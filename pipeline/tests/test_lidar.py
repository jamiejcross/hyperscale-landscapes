"""Scottish LiDAR tile naming -> National Grid extents (offline)."""
from hyperscale_landscapes.providers.lidar import tile_extent, _rank


def test_tile_extents_from_names():
    assert tile_extent("NT27SW_50CM_DTM_PHASE3.tif") == (320000, 670000, 5000)
    assert tile_extent("NT27NE_50CM_DTM_PHASE3.tif") == (325000, 675000, 5000)
    assert tile_extent("NG2004_50cm_DTM_ScotlandNationalLiDAR.tif") == (120000, 804000, 1000)
    assert tile_extent("HY20_1M_DTM_PHASE1.tif") == (320000, 1000000, 10000)
    assert tile_extent("README.txt") is None


def test_newest_programme_ranks_first():
    tiles = [{"programme": "phase-1", "size": 10000}, {"programme": "phase-5", "size": 5000},
             {"programme": "national-lidar-programme", "size": 1000}]
    assert [t["programme"] for t in sorted(tiles, key=_rank)] == \
        ["national-lidar-programme", "phase-5", "phase-1"]
