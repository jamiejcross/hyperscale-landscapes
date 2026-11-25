"""The web app and the Python tool must ask Overpass for the same features
and keep the same tags for the 3D props (trees, supports, turbines)."""
import re
from pathlib import Path

from hyperscale_landscapes.providers import features

ROOT = Path(__file__).resolve().parents[2]


def _js_keep() -> set:
    src = (ROOT / "web/js/data/overpass.js").read_text()
    body = re.search(r"const KEEP = set\((.*?)\);", src, re.S).group(1)
    return set(re.findall(r"'([^']+)'", body))


def test_both_queries_ask_for_trees_and_tree_rows():
    web = (ROOT / "data/overpass/web.ql").read_text()
    py = features._query(features.BBox(56.0, 56.1, -3.3, -3.2))
    for q in (web, py):
        assert 'node["natural"="tree"]' in q
        assert 'way["natural"="tree_row"]' in q
        assert 'nwr["power"]' in q


def test_prop_tags_are_kept_on_both_sides():
    assert features.PROP_TAGS <= features.KEEP_TAGS
    assert features.PROP_TAGS <= _js_keep()


def test_trees_classified_on_both_sides():
    assert features.classify({"natural": "tree"}) == ("trees", "tree")
    assert features.classify({"natural": "tree_row"}) == ("trees", "tree_row")
    js = (ROOT / "web/js/data/overpass.js").read_text()
    assert "t.natural === 'tree'" in js and "['trees', t.natural]" in js
