#!/usr/bin/env python3
"""Georeference planning drawings (PDF) against councils' red lines and extract building outlines.

How the drawn outlines in data/sites/datacentre-sites.geojson were made, as a reproducible tool.
Each drawing has a small YAML file in tools/georef/ (file, scale, red-line style, shapes).

1. Red line. Take the drawing's red-line strokes (or fills), apply the page rotation
   (page.rotation_matrix), sample them every 0.5 pt, convert to metres at the stated scale
   (1 pt = 0.35278 mm x scale denominator) and flip y.
2. Fit. Match them to the council-mapped red line (data/sites/datacentre-red-lines.geojson,
   in EPSG:27700, sampled every 1 m) by translation-only ICP with trimmed matching (best 80 %),
   over a grid of rotations (+-4 deg) and scales (+-2 %), refined coarse to fine. A fit is
   accepted only when the trimmed RMS is 5 m or less; it is recorded on every feature.
3. Shapes. Classify colours in the rendered page (the drawings use clipped or translucent
   fills, so vector paths are not reliable polygons), close small gaps, fill holes and
   vectorise the contours. Optionally reduce each shape to its minimum rotated rectangle
   (rectilinear buildings). Shapes outside the red line are ignored (legend swatches).
4. Output. GeoJSON features (WGS84, 7 dp) with name, kind, evidence, height, source and the
   fit statement; a check overlay PNG per drawing (docs/reference/check-<id>.png).

    python tools/georef_drawing.py                     # all drawings: fit, extract, compare
    python tools/georef_drawing.py larbert             # one drawing
    python tools/georef_drawing.py --write             # also replace those features in
                                                       #   datacentre-sites.geojson

Needs the optional tools extra: pip install -e "pipeline[tools]" (pymupdf, opencv, pyyaml).
The PDFs live in data/sites/docs/<site>/ (git-ignored; see _portal_index).
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from pyproj import Transformer
from scipy.spatial import cKDTree
from shapely.geometry import MultiPolygon, Polygon, shape
from shapely.ops import transform as shp_transform, unary_union

ROOT = Path(__file__).resolve().parents[1]
CONF = ROOT / "tools" / "georef"
DOCS = ROOT / "data" / "sites" / "docs"
SITES = ROOT / "data" / "sites" / "datacentre-sites.geojson"
RED_LINES = ROOT / "data" / "sites" / "datacentre-red-lines.geojson"
CHECKS = ROOT / "docs" / "reference"

PT_M = 0.35278e-3          # one PDF point on paper, in metres
MAX_RMS = 5.0              # accept a fit only at or below this trimmed RMS (m)
TRIM = 0.8                 # fraction of closest matches used by the ICP
SAMPLE_PT = 0.5            # red-line stroke sampling on the page (pt)
SAMPLE_M = 1.0             # council red-line sampling (m)
N_FIT = 1500               # drawing points used for the fit (seeded subsample)

_to_bng = Transformer.from_crs(4326, 27700, always_xy=True)
_to_wgs = Transformer.from_crs(27700, 4326, always_xy=True)


# ------------------------------------------------------------------ fitting (pure numpy)

@dataclass
class Fit:
    rms: float
    rot_deg: float
    scale: float
    t: np.ndarray          # translation (27700)
    c0: np.ndarray         # centre of the drawing points (metres, y up)
    denom: float

    def _R(self):
        a = np.radians(self.rot_deg)
        return np.array([[np.cos(a), -np.sin(a)], [np.sin(a), np.cos(a)]]) * self.scale

    def page_to_world(self, pts_pt: np.ndarray) -> np.ndarray:
        m = np.asarray(pts_pt, float) * PT_M * self.denom
        m = np.c_[m[:, 0], -m[:, 1]]
        return (m - self.c0) @ self._R().T + self.t

    def world_to_page(self, xy: np.ndarray) -> np.ndarray:
        m = (np.asarray(xy, float) - self.t) @ np.linalg.inv(self._R()).T + self.c0
        return np.c_[m[:, 0], -m[:, 1]] / (PT_M * self.denom)

    def statement(self) -> str:
        return (f"fitted to council red line: {self.rms:.1f} m RMS, "
                f"rotation {self.rot_deg:.1f}°, scale ×{self.scale:.2f}")


def _icp(Q, C, tree, t, iters=30):
    for _ in range(iters):
        d, i = tree.query(Q + t)
        k = d <= np.quantile(d, TRIM)
        dt = (C[i[k]] - (Q[k] + t)).mean(0)
        t = t + dt
        if np.hypot(*dt) < 0.01:
            break
    d, _ = tree.query(Q + t)
    k = d <= np.quantile(d, TRIM)
    return float(np.sqrt((d[k] ** 2).mean())), t


def fit_points(page_pts: np.ndarray, council: np.ndarray, denom: float,
               max_rot: float = 4.0, max_scale: float = 0.02) -> Fit:
    """Fit drawing red-line points (page pt, y down) to council red-line points (27700)."""
    m = np.asarray(page_pts, float) * PT_M * denom
    m = np.c_[m[:, 0], -m[:, 1]]
    if len(m) > N_FIT:
        m = m[np.random.default_rng(0).choice(len(m), N_FIT, replace=False)]
    c0 = m.mean(0)
    tree = cKDTree(council)

    def at(th, s, t=None):
        a = np.radians(th)
        Q = (m - c0) @ (np.array([[np.cos(a), -np.sin(a)], [np.sin(a), np.cos(a)]]) * s).T
        return _icp(Q, council, tree, council.mean(0) - Q.mean(0) if t is None else t)

    grid = [(th, s) for th in np.arange(-max_rot, max_rot + 1e-9, 1.0)
            for s in (1 - max_scale, 1.0, 1 + max_scale)]
    (rms, t), th, s = min(((at(th, s), th, s) for th, s in grid), key=lambda r: r[0][0])
    for dth, ds in ((0.5, 0.01), (0.25, 0.005), (0.1, 0.0025)):
        cand = [(th + a, s + b) for a in (-dth, 0, dth) for b in (-ds, 0, ds)
                if abs(th + a) <= max_rot + 1e-9 and abs(s + b - 1) <= max_scale + 1e-9]
        (rms, t), th, s = min(((at(a, b, t), a, b) for a, b in cand), key=lambda r: r[0][0])
    return Fit(rms, round(float(th), 4), round(float(s), 4), t, c0, denom)


def sample_ring_m(geom_bng, step=SAMPLE_M) -> np.ndarray:
    """Points every `step` metres along the exterior rings of a (Multi)Polygon in metres."""
    polys = geom_bng.geoms if hasattr(geom_bng, "geoms") else [geom_bng]
    pts = []
    for p in polys:
        r = p.exterior
        n = max(4, int(r.length // step))
        pts += [r.interpolate(i / n, normalized=True).coords[0] for i in range(n)]
    return np.array(pts)


# ------------------------------------------------------------------ drawing I/O (pymupdf, opencv)

def _close(a, b, tol=0.02):
    return a is not None and np.allclose(a, b, atol=tol)


def match_path(d: dict, spec: dict) -> bool:
    if "type" in spec and d["type"] != spec["type"]:
        return False
    if "color" in spec and not _close(d.get("color"), spec["color"], spec.get("tol", 0.02)):
        return False
    if "fill" in spec and not _close(d.get("fill"), spec["fill"], spec.get("tol", 0.02)):
        return False
    w = d.get("width") or 0
    if "width" in spec and abs(w - spec["width"]) > 0.05:
        return False
    if "min_width" in spec and w < spec["min_width"]:
        return False
    return True


def red_line_points(page, spec: dict) -> np.ndarray:
    import pymupdf
    M = page.rotation_matrix
    pts = []
    for d in page.get_drawings():
        if not match_path(d, spec):
            continue
        for it in d["items"]:
            op = it[0]
            if op == "l":
                seg = [it[1], it[2]]
            elif op == "c":
                seg = [it[1], it[4]]
            elif op == "re":
                r = it[1]
                seg = [r.tl, r.tr, r.br, r.bl, r.tl]
            elif op == "qu":
                q = it[1]
                seg = [q.ul, q.ur, q.lr, q.ll, q.ul]
            else:
                continue
            seg = [pymupdf.Point(p) * M for p in seg]
            for a, b in zip(seg, seg[1:]):
                n = max(1, int(abs(b - a) / SAMPLE_PT))
                for u in np.linspace(0, 1, n + 1):
                    pts.append((a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u))
    return np.array(pts)


def render(page, zoom: float) -> np.ndarray:
    """The page as displayed (rotation applied), RGB uint8."""
    import pymupdf
    pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
    return np.frombuffer(pix.samples, np.uint8).reshape(pix.h, pix.w, pix.n)[:, :, :3].copy()


def colour_mask(img: np.ndarray, colours, tol: int) -> np.ndarray:
    mask = np.zeros(img.shape[:2], bool)
    im = img.astype(np.int16)
    for c in colours:
        mask |= (np.abs(im - np.array(c, np.int16)).max(-1) <= tol)
    return mask


def absorb_enclosed(img: np.ndarray, mask: np.ndarray, max_px: float, touch_px: int = 3) -> np.ndarray:
    """Add to the mask the small white regions, enclosed by drawn lines, that touch it.

    Chapelcross's outer plant-zone strips are unfilled (white) areas outlined beside each
    building; they belong to the building's extent. Roads and open ground are large
    connected white regions and are left out by the size limit.
    """
    import cv2
    white = (img.min(-1) >= 244).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(white, connectivity=4)
    near = cv2.dilate(mask.astype(np.uint8), np.ones((2 * touch_px + 1,) * 2, np.uint8)) > 0
    hit = np.unique(lab[near & (white > 0)])
    small = [i for i in hit if i > 0 and stats[i, cv2.CC_STAT_AREA] <= max_px]
    return mask | np.isin(lab, small)


def mask_polygons(mask: np.ndarray, px_per_m: float, close_m: float, open_m: float = 0.0) -> list:
    """Contours (in pixels) of the mask after a morphological close and hole fill."""
    import cv2
    m = mask.astype(np.uint8) * 255
    if open_m > 0:
        k = max(1, int(round(open_m * px_per_m)))
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    if close_m > 0:
        k = max(1, int(round(close_m * px_per_m)))
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)   # external = holes filled
    return [c[:, 0, :].astype(float) for c in cs if len(c) >= 3]


# ------------------------------------------------------------------ per drawing

def council_red_line(site: str, ref: str):
    for f in json.loads(RED_LINES.read_text())["features"]:
        p = f["properties"]
        if p["site"] == site and p["ref"] == ref:
            return shp_transform(_to_bng.transform, shape(f["geometry"]))
    raise KeyError(f"no council red line for {site} {ref}")


def to_wgs_geom(g_bng) -> dict:
    g = shp_transform(_to_wgs.transform, g_bng)
    polys = g.geoms if hasattr(g, "geoms") else [g]
    return {"type": "MultiPolygon", "coordinates": [
        [[[round(x, 7), round(y, 7)] for x, y in r.coords] for r in [p.exterior, *p.interiors]]
        for p in polys]}


def load_conf(name: str) -> dict:
    import yaml
    c = yaml.safe_load((CONF / f"{name}.yaml").read_text())
    c["id"] = name
    return c


def zone_height(zones: list, g_bng) -> float | None:
    """Height of the zone with the largest overlap (zones: [(geom_bng, height_m)])."""
    best = max(zones, key=lambda z: z[0].intersection(g_bng).area, default=None)
    return best[1] if best and best[0].intersection(g_bng).area > 0 else None


def run(conf: dict, zones_by_id: dict | None = None, zoom: float | None = None, write_check=True):
    """Fit one drawing and extract its shapes. Returns (fit, features, shapes_bng)."""
    import pymupdf
    zones_by_id = zones_by_id or {}
    page = pymupdf.open(DOCS / conf["file"])[conf.get("page", 0)]
    council = council_red_line(conf["site"], conf["red_line"]["ref"])
    P = red_line_points(page, conf["red_line"]["match"])
    if len(P) == 0:
        raise ValueError(f"{conf['id']}: no red-line paths matched")
    fit = fit_points(P, sample_ring_m(council), conf["scale"])
    if fit.rms > MAX_RMS:
        raise ValueError(f"{conf['id']}: fit rejected, {fit.rms:.1f} m RMS > {MAX_RMS} m")

    zoom = zoom or conf.get("zoom", 2.0)
    img = render(page, zoom)
    px_per_m = zoom / (PT_M * conf["scale"])
    inside = council.buffer(conf.get("inside_buffer_m", 25))
    feats, shapes = [], []
    for spec in conf["shapes"]:
        mask = colour_mask(img, spec["colours"], spec.get("tol", 6))
        if spec.get("absorb_enclosed_m2"):
            mask = absorb_enclosed(img, mask, spec["absorb_enclosed_m2"] * px_per_m ** 2)
        polys = []
        for c in mask_polygons(mask, px_per_m, spec.get("close_m", 2.0), spec.get("open_m", 0.0)):
            g = Polygon(fit.page_to_world(c / zoom))
            if not g.is_valid:
                g = g.buffer(0)
            if g.is_empty or g.area < spec.get("min_area_m2", 500) or not inside.contains(g.centroid):
                continue
            polys.append(g)
        if spec.get("merge"):
            u = unary_union(polys)
            polys = list(u.geoms) if hasattr(u, "geoms") else [u]
        if spec.get("mrr"):
            polys = [g.minimum_rotated_rectangle for g in polys]
        tol = spec.get("simplify_m", 0.5)
        polys = [g.simplify(tol, preserve_topology=True) for g in polys]
        if spec.get("single") and polys:            # one feature, possibly in several parts
            polys = [MultiPolygon([p for g in polys for p in (g.geoms if hasattr(g, "geoms") else [g])])]
        order = spec.get("order")                    # e.g. "north_to_south"
        if order == "north_to_south":
            polys.sort(key=lambda g: -g.centroid.y)
        elif order == "west_to_east":
            polys.sort(key=lambda g: g.centroid.x)
        if "count" in spec and len(polys) != spec["count"]:
            print(f"  ! {conf['id']} {spec.get('name') or spec.get('names')}: "
                  f"{len(polys)} shapes, expected {spec['count']}", file=sys.stderr)
        for i, g in enumerate(polys):
            props = {"site": conf["site"]}
            if "names" in spec:
                props["name"] = spec["names"][i] if i < len(spec["names"]) else f"{spec['names'][-1]} {i + 1}"
            h = spec.get("height_m")
            if "height_from_zones" in spec:
                h = zone_height(zones_by_id.get(spec["height_from_zones"], []), g)
                rule = spec["by_zone_height"].get(h) or spec["by_zone_height"].get(str(h))
                if rule is None:
                    print(f"  ! {conf['id']}: shape at {g.centroid.coords[0]} in no known zone; skipped",
                          file=sys.stderr)
                    continue
                props["name"] = rule["name"]
                props["height_basis"] = rule["height_basis"]
            if "name" in spec:
                props["name"] = spec["name"]
            props["kind"] = spec["kind"]
            props["evidence"] = spec["evidence"]
            if h is not None:
                props["height_m"] = h
            for k in ("height_min_m", "height_basis"):
                if k in spec:
                    props[k] = spec[k]
            props["source"] = spec.get("source", conf["source"])
            props["area_m2"] = int(round(g.area))
            props["georeference"] = fit.statement()
            feats.append({"type": "Feature", "properties": props, "geometry": to_wgs_geom(g)})
            shapes.append((g, props))
    if write_check:
        write_overlay(conf, img, zoom, fit, council, shapes)
    return fit, feats, shapes


def write_overlay(conf, img, zoom, fit: Fit, council, shapes):
    """Check image: council red line (red) and extracted shapes (blue) on the drawing."""
    import cv2
    out = img[:, :, ::-1].copy()
    lw = max(2, int(zoom * 1.5))

    def draw(g, colour):
        for p in (g.geoms if hasattr(g, "geoms") else [g]):
            px = fit.world_to_page(np.array(p.exterior.coords)) * zoom
            cv2.polylines(out, [np.round(px).astype(np.int32)], True, colour, lw, cv2.LINE_AA)

    draw(council, (0, 0, 230))
    for g, _ in shapes:
        draw(g, (230, 60, 0))
    cv2.putText(out, f"{conf['id']}: {fit.statement()}", (int(40 * zoom), int(40 * zoom)),
                cv2.FONT_HERSHEY_SIMPLEX, zoom * 0.6, (0, 0, 0), max(1, int(zoom)), cv2.LINE_AA)
    s = 1600 / out.shape[1]
    out = cv2.resize(out, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    CHECKS.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(CHECKS / f"check-{conf['id']}.png"), out)


# ------------------------------------------------------------------ compare / write

def compare(new: list, current: list) -> list[dict]:
    """Pair each new feature with the current one of the same site/name that overlaps most."""
    rows, used = [], set()
    cur = [(i, f, shp_transform(_to_bng.transform, shape(f["geometry"]))) for i, f in enumerate(current)]
    for f in new:
        g = shp_transform(_to_bng.transform, shape(f["geometry"]))
        p = f["properties"]
        cands = [(i, h) for i, cf, h in cur if i not in used and cf["properties"]["site"] == p["site"]
                 and cf["properties"].get("name") == p.get("name")]
        if not cands:
            rows.append({"name": p.get("name"), "new_m2": round(g.area), "old_m2": None})
            continue
        i, h = max(cands, key=lambda c: c[1].intersection(g).area)
        used.add(i)
        rows.append({"site": p["site"], "name": p.get("name"), "new_m2": round(g.area), "old_m2": round(h.area),
                     "area_pct": round(100 * (g.area - h.area) / h.area, 1),
                     "shift_m": round(g.centroid.distance(h.centroid), 1),
                     "iou": round(g.intersection(h).area / g.union(h).area, 3)})
    return rows


def write_features(new_by_conf: dict[str, list], confs: dict[str, dict]) -> None:
    """Replace, in datacentre-sites.geojson, the features each drawing produces (same site and source)."""
    doc = json.loads(SITES.read_text())
    for cid, feats in new_by_conf.items():
        srcs = {f["properties"]["source"] for f in feats} | \
               {s.get("source", confs[cid]["source"]) for s in confs[cid]["shapes"]}
        site = confs[cid]["site"]
        keep = [f for f in doc["features"]
                if not (f["properties"]["site"] == site and f["properties"].get("source") in srcs
                        and f["properties"]["kind"] != "application boundary")]
        # insert where the old ones were, to keep the file's order stable
        idx = next((i for i, f in enumerate(doc["features"]) if f not in keep), len(keep))
        before = sum(1 for f in doc["features"][:idx] if f in keep)
        doc["features"] = keep[:before] + feats + keep[before:]
    SITES.write_text(json.dumps(doc, ensure_ascii=False))


def all_conf_ids() -> list[str]:
    ids = sorted(p.stem for p in CONF.glob("*.yaml"))
    # drawings whose zones others read go first
    deps = {i for i in ids for s in load_conf(i)["shapes"] if "height_from_zones" in s}
    return sorted(ids, key=lambda i: i in deps)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("drawings", nargs="*", help="ids of tools/georef/*.yaml (default: all)")
    ap.add_argument("--write", action="store_true", help="replace the features in datacentre-sites.geojson")
    ap.add_argument("--no-check-images", action="store_true")
    a = ap.parse_args(argv)
    ids = a.drawings or all_conf_ids()
    need = {s["height_from_zones"] for i in ids for s in load_conf(i)["shapes"] if "height_from_zones" in s}
    ids = [i for i in all_conf_ids() if i in set(ids) | need]
    current = json.loads(SITES.read_text())["features"]
    zones, out, confs = {}, {}, {}
    for cid in ids:
        conf = confs[cid] = load_conf(cid)
        fit, feats, shapes = run(conf, zones, write_check=not a.no_check_images)
        zones[cid] = [(g, p["height_m"]) for g, p in shapes if "height_m" in p]
        out[cid] = feats
        print(f"{cid:20} {fit.statement()}  ({len(feats)} shapes)")
        for r in compare(feats, current):
            if r.get("old_m2") is None:
                print(f"    {r['name']:48} {r['new_m2']:>8} m²   (no current feature)")
            else:
                print(f"    {r['name']:48} {r['new_m2']:>8} m²  was {r['old_m2']:>8}  "
                      f"{r['area_pct']:+6.1f}%  shift {r['shift_m']:5.1f} m  IoU {r['iou']:.3f}")
    if a.write:
        write_features({i: out[i] for i in ids if i in (a.drawings or ids)}, confs)
        print(f"wrote {SITES.relative_to(ROOT)}; now run tools/massing.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
