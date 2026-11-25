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
    key = cache_dir / "canopy" / (f"trees_v2_{canopy.CACHE_VERSION}_{bb['min_lat']:.5f}_{bb['max_lat']:.5f}_"
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


# ---------------------------------------------------------------------------
# Stage 3: tree type, by precedence OSM > NWSS > NFI > default
# ---------------------------------------------------------------------------

ARCHETYPES = ["broadleaf", "spruce", "scots_pine", "birch", "young"]      # uint8 codes 0..4
SOURCES = ["default", "osm", "nwss", "nfi"]                               # uint8 codes 0..3
OSM_RADIUS_M = 3.0

# NWSS: canopy-forming structures only (regeneration and shrub layers are
# mostly below the 4 m tree-top threshold); species marked "+" are shrubs.
NWSS_STRUCTURES = {"Mature", "Veteran", "Pole immature"}
NWSS_TYPES = {"Native woodland", "Nearly-native woodland"}               # plus any PAWS-surveyed wood
SCOTS_PINE = {"Scots pine"}
BIRCH = {"Birch", "Downy birch", "Silver birch"}
CONIFERS = {"Austrian pine", "Bishop pine", "Coast redwood", "Corsican pine", "Douglas fir", "European larch",
            "Grand fir", "Hybrid larch", "Japanese cedar", "Japanese larch", "Lawsons cypress", "Leyland cypress",
            "Lodgepole pine", "Maritime pine", "Noble fir", "Norway spruce", "Omorika spruce", "Other pines",
            "Radiata pine", "Silver fir", "Sitka spruce", "Wellingtonia", "Western hemlock", "Western red cedar", "Yew"}

# NFI interpreted forest type -> archetype proportions (None: no symbol).
NFI_RULES = {
    "Conifer": {"spruce": 1.0},
    "Broadleaved": {"broadleaf": 1.0},
    "Mixed mainly conifer": {"spruce": 0.7, "broadleaf": 0.3},
    "Mixed mainly broadleaved": {"spruce": 0.3, "broadleaf": 0.7},
    "Young trees": {"young": 1.0},
    "Coppice": {"broadleaf": 1.0},
    "Coppice with standards": {"broadleaf": 1.0},
    "Shrub": {"young": 1.0},
    "Ground prep": {"young": 1.0},
    "Failed": {"young": 1.0},
    "Felled": None,
}   # anything else (Assumed woodland, Low density, Windblow, non-woodland) falls through to the default


def nwss_archetype(species: str):
    """Archetype for an NWSS species name, or None for shrubs."""
    if "+" in species:
        return None
    name = species.replace("*", "").strip()
    if name in SCOTS_PINE:
        return "scots_pine"
    if name in BIRCH:
        return "birch"
    if name in CONIFERS:
        return "spruce"
    return "broadleaf"


def osm_archetype(tags: dict):
    g = (tags.get("genus") or "").lower()
    sp = (tags.get("species") or tags.get("taxon") or "").lower()
    if "pinus sylvestris" in sp:
        return "scots_pine"
    if g == "betula" or sp.startswith("betula"):
        return "birch"
    if g in ("picea", "abies", "larix", "pseudotsuga", "pinus", "taxus", "thuja", "tsuga", "cupressus", "cedrus") \
            or tags.get("leaf_type") == "needleleaved":
        return "spruce"
    if g or sp or tags.get("leaf_type") == "broadleaved":
        return "broadleaf"
    return None


def _unit_hash(x, y):
    """Deterministic value in [0, 1) per position (decimetres), for by-proportion picks."""
    xi = np.round(np.asarray(x) * 10).astype(np.int64).astype(np.uint64)
    yi = np.round(np.asarray(y) * 10).astype(np.int64).astype(np.uint64)
    h = xi * np.uint64(0x9E3779B97F4A7C15) ^ (yi + np.uint64(0x632BE59BD9B4E019)) * np.uint64(0xBF58476D1CE4E5B9)
    h ^= h >> np.uint64(31)
    h *= np.uint64(0x94D049BB133111EB)
    h ^= h >> np.uint64(29)
    return (h >> np.uint64(11)).astype(np.float64) / float(1 << 53)


def _pick(weights: dict, u: float) -> str:
    total = sum(weights.values())
    acc = 0.0
    for k in sorted(weights):            # sorted: the same answer on every run
        acc += weights[k] / total
        if u < acc:
            return k
    return sorted(weights)[-1]


def classify(x, y, h, woodland: dict, crs_transform=None) -> dict:
    """Archetype and source per tree top (National Grid x, y in metres).

    Returns {"archetype": uint8[], "source": uint8[], "drop": bool[] (felled),
    "warnings": [...], "unmapped_species": [...], "rules": {...}}.
    """
    from pyproj import Transformer
    from shapely import STRtree, points
    from shapely.geometry import shape

    n = len(x)
    arche = np.zeros(n, np.uint8)
    src = np.zeros(n, np.uint8)
    drop = np.zeros(n, bool)
    done = np.zeros(n, bool)
    u = _unit_hash(x, y)
    pts = points(np.column_stack([x, y])) if n else []
    warnings, unmapped = [], set()

    # 1. OSM individual trees within 3 m.
    tr = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)
    osm = [(tr.transform(t["lon"], t["lat"]), osm_archetype(t["tags"])) for t in woodland.get("osm_trees", [])]
    osm = [(p, a) for p, a in osm if a]
    if osm and n:
        ox = np.array([p[0] for p, _ in osm]); oy = np.array([p[1] for p, _ in osm])
        for i in range(n):
            d = np.hypot(ox - x[i], oy - y[i]); j = int(np.argmin(d))
            if d[j] <= OSM_RADIUS_M:
                arche[i] = ARCHETYPES.index(osm[j][1]); src[i] = 1; done[i] = True

    # 2. NWSS woods, by species proportions.
    by_wood: dict = {}
    for r in woodland.get("nwss_species", []):
        if r.get("STRUCTURE") not in NWSS_STRUCTURES or not r.get("SP_STR_PCT"):
            continue
        a = nwss_archetype(r["SPECIES"] or "")
        if a is None:
            continue
        w = by_wood.setdefault(r["SCPTDATA_I"], {})
        w[a] = w.get(a, 0) + float(r["SP_STR_PCT"])
    nwss = [f for f in woodland.get("nwss", []) if f.get("geometry") and
            (f["properties"].get("TYPE") in NWSS_TYPES or f["properties"].get("PAWS_SURVY") == "Yes")
            and by_wood.get(f["properties"].get("SCPTDATA_I"))]
    if nwss and n:
        tree = STRtree([shape(f["geometry"]) for f in nwss])
        pi, gi = tree.query(pts, predicate="within")
        for i, g in zip(pi, gi):
            if done[i]:
                continue
            arche[i] = ARCHETYPES.index(_pick(by_wood[nwss[g]["properties"]["SCPTDATA_I"]], u[i]))
            src[i] = 2; done[i] = True

    # 3. NFI interpreted forest type.
    nfi = [f for f in woodland.get("nfi", []) if f.get("geometry") and f["properties"].get("IFT_IOA") in NFI_RULES]
    felled_tall = 0
    if nfi and n:
        tree = STRtree([shape(f["geometry"]) for f in nfi])
        pi, gi = tree.query(pts, predicate="within")
        for i, g in zip(pi, gi):
            if done[i]:
                continue
            rule = NFI_RULES[nfi[g]["properties"]["IFT_IOA"]]
            done[i] = True
            if rule is None:                     # felled: no symbol
                drop[i] = True
                felled_tall += int(h[i] >= 8)
                continue
            arche[i] = ARCHETYPES.index(_pick(rule, u[i])); src[i] = 3
    if felled_tall:
        warnings.append(f"{felled_tall} tree tops of 8 m or more fall in NFI 'Felled' woodland: "
                        "the LiDAR and NFI dates differ (felled after the survey, or regrown)")

    # 4. Default: broadleaf (park, street and hedgerow trees).
    for r in woodland.get("nwss_species", []):
        if r.get("SPECIES") and nwss_archetype(r["SPECIES"]) == "broadleaf":
            name = r["SPECIES"].replace("*", "").strip()
            if name not in {"Ash", "Aspen", "Beech", "Sycamore", "Hazel", "Hawthorn", "Holly", "Rowan", "Elder",
                            "Common alder", "Goat willow", "Grey willow", "Sessile oak", "Pedunculate oak",
                            "Intermediate oak", "Other oak", "Wych elm", "Gean wild cherry", "Bird cherry"}:
                unmapped.add(name)          # mapped to broadleaf by default; listed so it can be checked
    return {"archetype": arche, "source": src, "drop": drop, "warnings": warnings,
            "broadleaf_by_default_species": sorted(unmapped),
            "rules": {"precedence": "OSM tree within 3 m > NWSS wood (species proportions) > NFI type > broadleaf",
                      "nwss_structures": sorted(NWSS_STRUCTURES), "nwss_types": sorted(NWSS_TYPES) + ["PAWS-surveyed"],
                      "nfi": {k: v for k, v in NFI_RULES.items()}, "by_proportion": "deterministic, seeded by position"}}


def typed_for_site(site_id: str, cache_dir=None, force: bool = False) -> dict:
    """Stage-2 tops plus Stage-3 types for a curated site (felled tops removed)."""
    import json
    from .paths import data_dir
    from .providers import DEFAULT_CACHE, woodland as wl

    t = for_site(site_id, cache_dir, force)
    import gzip
    bb = json.loads((data_dir() / "sites" / f"{site_id}.geojson").read_text())["properties"]["model_bbox"]
    elements = json.loads(gzip.decompress((data_dir() / "sites" / f"{site_id}.bundle.json.gz").read_bytes()))["osm"]["elements"]
    w = wl.fetch(bb, cache_dir or DEFAULT_CACHE, osm_elements=elements)
    c = classify(t["x"], t["y"], t["h"], w)
    keep = ~c["drop"]
    out = {k: t[k][keep] for k in ("x", "y", "h", "crown_r", "count")}
    out.update(archetype=c["archetype"][keep], source=c["source"][keep])
    out["typing"] = {"warnings": c["warnings"], "rules": c["rules"], "dropped_felled": int(c["drop"].sum()),
                     "broadleaf_by_default_species": c["broadleaf_by_default_species"],
                     "woodland_fetched": w["fetched"], "sources": w["sources"],
                     "by_archetype": {a: int((out["archetype"] == i).sum()) for i, a in enumerate(ARCHETYPES)},
                     "by_source": {s: int((out["source"] == i).sum()) for i, s in enumerate(SOURCES)}}
    out.update({k: t[k] for k in ("summary", "rules", "chm", "height_m")})
    return out
