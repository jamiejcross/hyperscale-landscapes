"""Tree tops from a canopy height model (CHM), for the 3D view's tree symbols.

Method (a standard local-maximum filter with a height-dependent window):
  1. Smooth the CHM with a Gaussian (sigma ~1 m) so a single crown has one peak.
  2. A pixel is a tree top if it is the highest point within a circular window
     whose radius grows with height, r = clamp(1.5 + 0.08 h, 1.5, 4) m, and
     h >= 4 m. Flat-topped ties are merged to one top per connected plateau.
  3. Each top keeps its position, its height (the unsmoothed CHM maximum
     within 1 m) and a crown radius of 0.6 x the window width (2r), i.e. 1.2 r.

For display, tops are thinned to the tallest one per grid cell (10 m), with
the number detected in each cell kept, and capped at 30,000 symbols per site
by enlarging the cell. Every choice is returned in the summary so the caption
and manifest can state it ("N crowns detected, M symbols drawn").
"""
from __future__ import annotations

import math

import numpy as np

SIGMA_M = 1.0
MIN_HEIGHT_M = 4.0
R_MIN_M, R_MAX_M = 1.5, 4.0
R_A, R_B = 1.5, 0.08          # r = R_A + R_B * h
CROWN_FACTOR = 0.6            # crown radius = 0.6 x window width (2r)
THIN_CELL_M = 10.0
MAX_SYMBOLS = 30_000
CLIP_M = 45.0                 # the CHM's clip: a top that reaches it has no measured height
REVIEW_M = 35.0               # tall enough to list for review (real conifers can be this tall)


def window_radius(h):
    return np.clip(R_A + R_B * np.asarray(h, dtype=np.float64), R_MIN_M, R_MAX_M)


def _disc(r_px: float) -> np.ndarray:
    n = int(math.floor(r_px))
    y, x = np.ogrid[-n:n + 1, -n:n + 1]
    return (x * x + y * y) <= r_px * r_px + 1e-9


def detect_tops(chm: np.ndarray, res_m: float = 1.0) -> dict:
    """Tree tops in a CHM (metres, 0 = not tree). Returns arrays in pixel space:
    {"row", "col" (float, plateau centroid), "h" (m), "crown_r" (m)}."""
    from scipy import ndimage as ndi

    chm = np.nan_to_num(np.asarray(chm, dtype=np.float32), nan=0.0)
    sm = ndi.gaussian_filter(chm, SIGMA_M / res_m, mode="nearest")
    tall = sm >= MIN_HEIGHT_M
    if not tall.any():
        return {k: np.zeros(0) for k in ("row", "col", "h", "crown_r")}
    # One maximum filter per distinct window radius (in 0.5 m steps).
    radii = np.round(window_radius(sm) * 2) / 2
    is_top = np.zeros(chm.shape, bool)
    for r in np.unique(radii[tall]):
        mx = ndi.maximum_filter(sm, footprint=_disc(r / res_m), mode="nearest")
        is_top |= tall & (radii == r) & (sm >= mx - 1e-6)
    # Merge plateaus (equal-height neighbours) into one top each.
    lab, n = ndi.label(is_top, structure=np.ones((3, 3)))
    if n == 0:
        return {k: np.zeros(0) for k in ("row", "col", "h", "crown_r")}
    idx = np.arange(1, n + 1)
    cen = np.array(ndi.center_of_mass(is_top, lab, idx), dtype=np.float64).reshape(-1, 2)
    raw_max = ndi.maximum_filter(chm, footprint=_disc(1.0 / res_m), mode="nearest")
    rr = np.clip(np.round(cen[:, 0]).astype(int), 0, chm.shape[0] - 1)
    cc = np.clip(np.round(cen[:, 1]).astype(int), 0, chm.shape[1] - 1)
    h = raw_max[rr, cc].astype(np.float64)
    crown = CROWN_FACTOR * 2 * window_radius(h)
    return {"row": cen[:, 0], "col": cen[:, 1], "h": h, "crown_r": crown}


def thin(tops: dict, res_m: float = 1.0, cell_m: float = THIN_CELL_M, cap: int = MAX_SYMBOLS) -> dict:
    """Keep the tallest top per cell_m grid cell; enlarge the cell until at most
    `cap` remain. Adds "count" (tops detected in that symbol's cell)."""
    n = len(tops["h"])
    cell = cell_m
    while True:
        if n == 0:
            kept = np.zeros(0, int); counts = np.zeros(0, int); break
        cx = np.floor(tops["col"] * res_m / cell).astype(np.int64)
        cy = np.floor(tops["row"] * res_m / cell).astype(np.int64)
        key = cy * 1_000_003 + cx
        order = np.lexsort((-tops["h"], key))          # by cell, tallest first
        k_sorted = key[order]
        first = np.ones(len(order), bool); first[1:] = k_sorted[1:] != k_sorted[:-1]
        kept = order[first]
        _, counts = np.unique(k_sorted, return_counts=True)
        if len(kept) <= cap:
            break
        cell *= 1.25
    out = {k: v[kept] for k, v in tops.items()}
    out["count"] = counts
    out["summary"] = {"detected": int(n), "drawn": int(len(kept)), "thin_cell_m": round(cell, 2),
                      "capped": cell != cell_m, "cap": cap}
    return out


def rules() -> dict:
    """The method's parameters, for the manifest."""
    return {"smoothing_sigma_m": SIGMA_M, "min_height_m": MIN_HEIGHT_M,
            "window_radius_m": f"clamp({R_A} + {R_B} x h, {R_MIN_M}, {R_MAX_M})",
            "crown_radius": f"{CROWN_FACTOR} x window width (2r)", "thin_cell_m": THIN_CELL_M,
            "max_symbols": MAX_SYMBOLS, "excluded": f"tops at the {CLIP_M:g} m clip (listed)"}


def for_site(site_id: str, cache_dir=None, force: bool = False) -> dict:
    """Tree tops for a curated site: National Grid x, y (m), h, crown_r, count,
    plus the summary and the CHM's provenance. Cached next to the CHM."""
    import gzip
    import json
    from pathlib import Path

    from .paths import data_dir
    from .providers import DEFAULT_CACHE, canopy

    cache_dir = Path(cache_dir or DEFAULT_CACHE)
    site = json.loads((data_dir() / "sites" / f"{site_id}.geojson").read_text())
    bb = site["properties"]["model_bbox"]
    key = cache_dir / "canopy" / (f"trees_v1_{canopy.CACHE_VERSION}_{bb['min_lat']:.5f}_{bb['max_lat']:.5f}_"
                                  f"{bb['min_lon']:.5f}_{bb['max_lon']:.5f}.npz")
    if key.exists() and not force:
        z = np.load(key, allow_pickle=False)
        return {**{k: z[k] for k in ("x", "y", "h", "crown_r", "count")}, **json.loads(str(z["info"]))}
    bundle = json.loads(gzip.decompress((data_dir() / "sites" / f"{site_id}.bundle.json.gz").read_bytes()))
    c = canopy.compute(bb, bundle["osm"]["elements"], cache_dir)
    t = detect_tops(c["chm"], canopy.RES_M)
    tr = c["transform"]
    to_xy = lambda row, col: (tr.c + (col + 0.5) * tr.a, tr.f + (row + 0.5) * tr.e)
    # Tops at the clip have no measured height and are most likely structures
    # missing from OSM (masts, cranes, chimneys): left out, and listed.
    clipped = t["h"] >= CLIP_M - 0.05
    excluded = [[round(v, 1) for v in to_xy(r, cc)] for r, cc in zip(t["row"][clipped], t["col"][clipped])]
    t = {k: v[~clipped] for k, v in t.items()}
    th = thin(t, canopy.RES_M)
    x = tr.c + (th["col"] + 0.5) * tr.a
    y = tr.f + (th["row"] + 0.5) * tr.e
    th["summary"]["excluded_at_clip"] = {"count": len(excluded), "osgb_xy": excluded[:50],
                                         "reason": f"reached the {CLIP_M:g} m clip; probably a structure not in OSM"}
    th["summary"]["review_over_m"] = {"threshold": REVIEW_M, "count": int((th["h"] >= REVIEW_M).sum())}
    info = {"summary": th["summary"], "rules": rules(), "chm": c["meta"],
            "height_m": {"min": float(th["h"].min()) if len(th["h"]) else None,
                         "median": float(np.median(th["h"])) if len(th["h"]) else None,
                         "max": float(th["h"].max()) if len(th["h"]) else None}}
    np.savez_compressed(key, x=x, y=y, h=th["h"], crown_r=th["crown_r"], count=th["count"],
                        info=np.array(json.dumps(info)))
    return {"x": x, "y": y, "h": th["h"], "crown_r": th["crown_r"], "count": th["count"], **info}
