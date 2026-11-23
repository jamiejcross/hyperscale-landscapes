import os
import shutil
from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent / "fixtures"

# A ~650 m square at the western edge of Auchtertool, Fife: buildings, roads and
# water, small enough to keep the cached fixture data under 1 MB.
FIXTURE_BBOX = dict(min_lat=56.0960, max_lat=56.1020,
                    min_lon=-3.2660, max_lon=-3.2560)


@pytest.fixture
def offline_cache(tmp_path, monkeypatch):
    """A writable copy of the fixture cache, with the network forbidden."""
    src = FIXTURES / "cache"
    if not src.exists():
        pytest.skip("fixture cache missing; run tests/make_fixtures.py")
    dst = tmp_path / "cache"
    shutil.copytree(src, dst)
    monkeypatch.setenv("HYPERSCALE_OFFLINE", "1")
    monkeypatch.setenv("HYPERSCALE_CACHE", str(dst))
    return dst


def pytest_collection_modifyitems(config, items):
    if os.environ.get("HYPERSCALE_OFFLINE"):
        skip = pytest.mark.skip(reason="network test; HYPERSCALE_OFFLINE is set")
        for item in items:
            if "network" in item.keywords:
                item.add_marker(skip)
