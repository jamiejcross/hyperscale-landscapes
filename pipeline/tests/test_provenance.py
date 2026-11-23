from hyperscale_landscapes import provenance
from hyperscale_landscapes.pipeline import BuildOptions, exaggeration_note


def test_lookup_prefixes():
    assert provenance.lookup("scottish-lidar-phase-3")["licence"] == "OGL-UK-3.0"
    assert provenance.lookup("gshhg-h")["licence"] == "LGPL-3.0"
    assert provenance.lookup("osm-coastline")["licence"] == "ODbL-1.0"


def test_attribution_deduplicates():
    line = provenance.attribution_line({"roads": "osm-overpass",
                                        "water": "osm-overpass",
                                        "elevation": "srtm-30m"})
    assert line.count("OpenStreetMap") == 1 and "SRTM" in line


def test_exaggeration_is_always_disclosed():
    o = BuildOptions(0, 1, 0, 1)
    assert exaggeration_note(o) == "Height exaggerated ×2; buildings at true height"
    o.building_exag = 2
    assert "buildings ×2" in exaggeration_note(o)
