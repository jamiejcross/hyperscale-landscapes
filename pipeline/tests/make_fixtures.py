"""Regenerate the offline fixture cache (needs network).

    python tests/make_fixtures.py

Writes provider caches for FIXTURE_BBOX into tests/fixtures/cache/, keeping
only the small bbox-keyed result files (not whole DEM tiles or GSHHG).
"""
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
from conftest import FIXTURE_BBOX  # noqa: E402

from hyperscale_landscapes.pipeline import BuildOptions, build  # noqa: E402
from hyperscale_landscapes.providers import default_cache_dir  # noqa: E402

def _keys(bb):
    k4 = f"{bb['min_lat']:.4f}_{bb['max_lat']:.4f}_{bb['min_lon']:.4f}_{bb['max_lon']:.4f}"
    k5 = f"{bb['min_lat']:.5f}_{bb['max_lat']:.5f}_{bb['min_lon']:.5f}_{bb['max_lon']:.5f}"
    return k4, k5


def main():
    # Use the shared user cache so large inputs (DEM tiles, GSHHG) are reused,
    # then copy only the small files keyed to the fixture bbox.
    cache = default_cache_dir()
    with tempfile.TemporaryDirectory() as tmp:
        build(BuildOptions(**FIXTURE_BBOX, elevation="srtm", cache_dir=str(cache),
                           out_dir=str(Path(tmp) / "out")))
    dst = HERE / "fixtures" / "cache"
    shutil.rmtree(dst, ignore_errors=True)
    keys = _keys(FIXTURE_BBOX)
    for f in cache.rglob("*"):
        if f.is_file() and any(k in f.name for k in keys):
            rel = f.relative_to(cache)
            (dst / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, dst / rel)
            print("  +", rel)
    total = sum(f.stat().st_size for f in dst.rglob("*") if f.is_file())
    print(f"Fixture cache: {total / 1e6:.2f} MB")
    assert total < 1_000_000, "fixture cache must stay under 1 MB"


if __name__ == "__main__":
    main()
