"""The context section of a site bundle (schema @4): coarse terrain and the
main infrastructure in a band round the model area, for the screen-only
context apron (docs/claude-code-prompt-context-apron-sections.md, stage 1).

Nothing here touches the print model: the bundle's ``osm`` and ``elevation``
sections are left as they are.

Frame: the web app's local frame (web/js/geo.js makeProjection), metres east
and north of the model bbox's SW corner, as the props section.

Elevation grid
  Vertex-registered and snapped to the model edges: cells are W/round(W/20)
  by H/round(H/20) metres, the pad is a whole number of cells (at least
  ``pad_m``), so the model's four corners are grid vertices. Row 0 is the
  north edge; values are decimetres, int16, delta-coded along each row (the
  LiDAR grid's ``int16-dm-rowdelta``). ``offset_m`` (already added) is the
  median of (model terrain - context) at the grid vertices on the model
  boundary, so the two surfaces meet at the edge.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import math
import time
from pathlib import Path

import numpy as np

from .paths import data_dir
from .providers import DEFAULT_CACHE, USER_AGENT, BBox, overpass_query
from .providers import elevation as elev_provider
from .provenance import lookup as lookup_source

PAD_M = 1600.0          # one constant; a site may set properties.context_pad_m
CELL_M = 20.0           # target cell size; the actual size snaps to the model edges
M_PER_DEG_LAT = 111_320.0
COORD_DP = 5            # lat/lon decimals kept for context features (about 1 m)
# Tags the web app needs from the context features (everything else is dropped).
KEEP_TAGS = {"name", "power", "voltage", "highway", "railway", "waterway", "natural", "landuse",
             "man_made", "building", "place", "tunnel", "bridge", "layer", "substance"}
QUERY_KEYS = {"power", "highway", "railway", "waterway", "natural", "landuse", "man_made", "building", "place"}


# ---------------------------------------------------------------- the grid

def grid_spec(W: float, H: float, pad_m: float = PAD_M, cell_m: float = CELL_M) -> dict:
    """The snapped context grid for a model W x H metres (app frame)."""
    nx, ny = max(1, round(W / cell_m)), max(1, round(H / cell_m))
    dx, dy = W / nx, H / ny
    px, py = math.ceil(pad_m / dx - 1e-9), math.ceil(pad_m / dy - 1e-9)
    return {"dx": dx, "dy": dy, "pad_cells_x": px, "pad_cells_y": py,
            "model_cells_x": nx, "model_cells_y": ny,
            "w": nx + 2 * px + 1, "h": ny + 2 * py + 1,
            "x0": -px * dx, "y_top": H + py * dy}


def vertex_xy(spec: dict):
    """Vertex coordinates (app frame): x per column, y per row (row 0 north)."""
    xs = spec["x0"] + np.arange(spec["w"]) * spec["dx"]
    ys = spec["y_top"] - np.arange(spec["h"]) * spec["dy"]
    return xs, ys


def model_corner_index(spec: dict) -> dict:
    """Grid (column, row) of each model corner."""
    c0, c1 = spec["pad_cells_x"], spec["pad_cells_x"] + spec["model_cells_x"]
    r_n, r_s = spec["pad_cells_y"], spec["pad_cells_y"] + spec["model_cells_y"]
    return {"sw": (c0, r_s), "se": (c1, r_s), "ne": (c1, r_n), "nw": (c0, r_n)}


def boundary_index(spec: dict) -> list:
    """(column, row) of every grid vertex on the model boundary."""
    k = model_corner_index(spec)
    (c0, r_s), (c1, r_n) = k["sw"], k["ne"]
    out = [(c, r) for c in range(c0, c1 + 1) for r in (r_n, r_s)]
    out += [(c, r) for r in range(r_n + 1, r_s) for c in (c0, c1)]
    return out


def projection(bb: dict):
    """App frame <-> lon/lat (web/js/geo.js makeProjection)."""
    mlon = M_PER_DEG_LAT * math.cos(math.radians((bb["min_lat"] + bb["max_lat"]) / 2))
    W = (bb["max_lon"] - bb["min_lon"]) * mlon
    H = (bb["max_lat"] - bb["min_lat"]) * M_PER_DEG_LAT
    to_ll = lambda x, y: (bb["min_lon"] + np.asarray(x) / mlon, bb["min_lat"] + np.asarray(y) / M_PER_DEG_LAT)
    return to_ll, W, H


def padded_bbox(bb: dict, spec: dict, margin_m: float = 60.0) -> BBox:
    to_ll, _, _ = projection(bb)
    xs, ys = vertex_xy(spec)
    w, s = to_ll(xs[0] - margin_m, ys[-1] - margin_m)
    e, n = to_ll(xs[-1] + margin_m, ys[0] + margin_m)
    return BBox(float(s), float(n), float(w), float(e))


# ---------------------------------------------------------------- encoding

def encode_grid(z: np.ndarray) -> str:
    dm = np.round(np.asarray(z, dtype=np.float64) * 10).astype(np.int32)
    delta = np.diff(dm, axis=1, prepend=0)
    if np.abs(delta).max(initial=0) > 32767:
        raise ValueError("elevation step too large for int16")
    return base64.b64encode(delta.astype("<i2").tobytes()).decode()


def decode_grid(data: str, w: int, h: int) -> np.ndarray:
    d = np.frombuffer(base64.b64decode(data), dtype="<i2").reshape(h, w).astype(np.int32)
    return np.cumsum(d, axis=1) / 10.0


# ---------------------------------------------------------------- samplers

def raster_sampler(elev: np.ndarray, extent: dict):
    """Bilinear sampler for a north-up lat/lon raster whose extent is the
    outer edges of its cells (the provider's windowed Copernicus read)."""
    rows, cols = elev.shape
    def sample(lon, lat):
        fx = (np.asarray(lon) - extent["west"]) / (extent["east"] - extent["west"]) * cols - 0.5
        fy = (extent["north"] - np.asarray(lat)) / (extent["north"] - extent["south"]) * rows - 0.5
        return _bilinear(elev, fx, fy)
    return sample


def _bilinear(z, fx, fy):
    rows, cols = z.shape
    c, r = np.floor(fx).astype(int), np.floor(fy).astype(int)
    tx, ty = fx - c, fy - r
    at = lambda cc, rr: z[np.clip(rr, 0, rows - 1), np.clip(cc, 0, cols - 1)]
    return ((1 - tx) * (1 - ty) * at(c, r) + tx * (1 - ty) * at(c + 1, r)
            + (1 - tx) * ty * at(c, r + 1) + tx * ty * at(c + 1, r + 1))


def model_sampler(bundle: dict):
    """The model terrain as the web app reads it from the bundle (web/js/data/
    elevation.js): the LiDAR grid, or the Terrarium tiles. Returns
    (sample(lon, lat), name)."""
    bb, L = bundle["bbox"], bundle["elevation"].get("lidar")
    if L:
        z = decode_grid(L["data"], L["w"], L["h"])
        def sample(lon, lat):
            fx = (np.asarray(lon) - bb["min_lon"]) / (bb["max_lon"] - bb["min_lon"]) * L["w"] - 0.5
            fy = (bb["max_lat"] - np.asarray(lat)) / (bb["max_lat"] - bb["min_lat"]) * L["h"] - 0.5
            return _bilinear(z, fx, fy)
        return sample, L["source"]
    from PIL import Image
    zoom, tiles = bundle["elevation"]["zoom"], {}
    for key, b64 in bundle["elevation"]["tiles"].items():
        a = np.asarray(Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB"), dtype=np.float64)
        tiles[key] = a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768
    n = 2 ** zoom
    def sample(lon, lat):
        lon, lat = np.atleast_1d(lon), np.atleast_1d(lat)
        X = (lon + 180) / 360 * n
        rl = np.radians(lat)
        Y = (1 - np.log(np.tan(rl) + 1 / np.cos(rl)) / math.pi) / 2 * n
        out = np.full(lon.shape, np.nan)
        for i in range(lon.size):
            t = tiles.get(f"{zoom}/{int(X[i])}/{int(Y[i])}")
            if t is not None:
                out[i] = _bilinear(t, np.array((X[i] % 1) * 256 - 0.5), np.array((Y[i] % 1) * 256 - 0.5))
        return out
    return sample, "terrarium"


# ---------------------------------------------------------------- elevation

def context_elevation(bundle: dict, pad_m: float = PAD_M, cache_dir: Path = DEFAULT_CACHE) -> dict:
    bb = bundle["bbox"]
    to_ll, W, H = projection(bb)
    spec = grid_spec(W, H, pad_m)
    r = elev_provider.fetch(padded_bbox(bb, spec, margin_m=120), cache_dir, prefer="copernicus")
    sample = raster_sampler(r.data["elev"].astype(np.float64), r.data["extent"])
    xs, ys = vertex_xy(spec)
    X, Y = np.meshgrid(xs, ys)
    lon, lat = to_ll(X, Y)
    z = sample(lon, lat)
    # offset: median of (model terrain - context) on the model boundary
    model, model_src = model_sampler(bundle)
    bi = boundary_index(spec)
    cols, rows = np.array([b[0] for b in bi]), np.array([b[1] for b in bi])
    blon, blat = to_ll(xs[cols], ys[rows])
    diff = np.asarray(model(blon, blat)) - z[rows, cols]
    diff = diff[np.isfinite(diff)]
    offset = float(np.median(diff)) if diff.size else 0.0
    z = z + offset
    src = lookup_source(r.source)
    return {"format": "int16-dm-rowdelta", "registration": "vertex", "w": spec["w"], "h": spec["h"],
            "dx_m": round(spec["dx"], 4), "dy_m": round(spec["dy"], 4),
            "x0_m": round(spec["x0"], 3), "y_top_m": round(spec["y_top"], 3),
            "pad_cells_x": spec["pad_cells_x"], "pad_cells_y": spec["pad_cells_y"],
            "model_cells_x": spec["model_cells_x"], "model_cells_y": spec["model_cells_y"],
            "res_m": round((spec["dx"] + spec["dy"]) / 2, 2),
            "source": r.source, "source_res_m": 30,
            "note": "Copernicus GLO-30 (about 30 m) interpolated bilinearly onto this grid",
            "offset_m": round(offset, 2), "offset_against": model_src,
            "offset_spread_m": round(float(np.percentile(np.abs(diff - offset), 90)), 2) if diff.size else None,
            "data": encode_grid(z), "attribution": src["attribution"]}


# ---------------------------------------------------------------- OSM

def query(box: BBox) -> str:
    return (data_dir() / "overpass" / "context.ql").read_text().replace(
        "{{bbox}}", f"{box.min_lat},{box.min_lon},{box.max_lat},{box.max_lon}")


def fetch_osm(box: BBox, cache_dir: Path = DEFAULT_CACHE) -> dict:
    """The context query's response, cached by query text."""
    q = query(box)
    cache = Path(cache_dir) / "context"
    cache.mkdir(parents=True, exist_ok=True)
    f = cache / f"osm_{hashlib.sha256(q.encode()).hexdigest()[:16]}.json"
    if f.exists():
        return json.loads(f.read_text())
    osm = overpass_query(q, timeout=300)
    f.write_text(json.dumps(osm))
    return osm


def _pt(p):
    return {"lat": round(p["lat"], COORD_DP), "lon": round(p["lon"], COORD_DP)}


def strip_osm(osm: dict, bb: dict) -> dict:
    """Geometry and the needed tags only. Features lying wholly inside the
    model bbox are dropped: the bundle's own OSM has them."""
    inside = lambda p: bb["min_lat"] <= p["lat"] <= bb["max_lat"] and bb["min_lon"] <= p["lon"] <= bb["max_lon"]
    out, dropped = [], 0
    for e in osm.get("elements", []):
        tags = {k: v for k, v in (e.get("tags") or {}).items() if k in KEEP_TAGS}
        if e["type"] == "node":
            pts = [e]
            el = {"type": "node", "id": e["id"], **_pt(e), "tags": tags}
        elif e["type"] == "way":
            pts = e.get("geometry") or []
            el = {"type": "way", "id": e["id"], "tags": tags, "geometry": [_pt(p) for p in pts if p]}
        elif e["type"] == "relation":
            mem = [{"type": "way", "role": m.get("role", ""), "geometry": [_pt(p) for p in m["geometry"] if p]}
                   for m in e.get("members", []) if m.get("type") == "way" and m.get("geometry")]
            pts = [p for m in e.get("members", []) for p in (m.get("geometry") or []) if p]
            el = {"type": "relation", "id": e["id"], "tags": tags, "members": mem}
        else:
            continue
        pts = [p for p in pts if p]
        if not pts:
            continue
        if all(inside(p) for p in pts):
            dropped += 1
            continue
        out.append(el)
    return {"elements": out, "dropped_inside": dropped}


def context_power(osm: dict, bb: dict) -> dict:
    """Pylons, poles and overhead lines outside the model area, from the raw
    (unstripped) context response, by the same rules as the props section
    (structures.extract: heights from OSM or the stated defaults, bearings
    from the line). Supports inside the model bbox are left out (the props
    section has them); lines are kept whole (the web app clips them at the
    model edge)."""
    from . import structures
    mlon = M_PER_DEG_LAT * math.cos(math.radians((bb["min_lat"] + bb["max_lat"]) / 2))
    to_xy = lambda lon, lat: ((lon - bb["min_lon"]) * mlon, (lat - bb["min_lat"]) * M_PER_DEG_LAT)
    inside = lambda lon, lat: bb["min_lat"] <= lat <= bb["max_lat"] and bb["min_lon"] <= lon <= bb["max_lon"]
    s = structures.extract(osm.get("elements", []), to_xy)
    r1 = lambda v: round(float(v), 1)
    supports = [{"x": r1(to_xy(o["lon"], o["lat"])[0]), "y": r1(to_xy(o["lon"], o["lat"])[1]),
                 "kind": o["kind"], "voltage_kv": o["voltage_kv"], "height": o["height"],
                 "height_source": o["height_source"], "bearing": o["bearing"], "osm": o["osm"]}
                for o in s["supports"] if not inside(o["lon"], o["lat"])]
    lines = [{"kind": o["kind"], "voltage_kv": o["voltage_kv"], "osm": o["osm"],
              "xy": [[r1(v) for v in to_xy(*c)] for c in o["coords"]]}
             for o in s["lines"] if not all(inside(*c) for c in o["coords"])]
    hs = {}
    for o in supports:
        hs[o["height_source"]] = hs.get(o["height_source"], 0) + 1
    return {"supports": supports, "lines": lines,
            "summary": {"supports": len(supports), "support_height_sources": hs,
                        "towers": sum(o["kind"] in ("tower", "portal") for o in supports),
                        "poles": sum(o["kind"] == "pole" for o in supports), "lines": len(lines)},
            "rules": "as the props section (structures.py SUPPORT_DEFAULTS)"}


def context_section(site: dict, bundle: dict, cache_dir: Path = DEFAULT_CACHE) -> dict:
    bb = bundle["bbox"]
    pad = float(site["properties"].get("context_pad_m") or PAD_M)
    elevation = context_elevation(bundle, pad, cache_dir)
    to_ll, W, H = projection(bb)
    spec = grid_spec(W, H, pad)
    box = padded_bbox(bb, spec)
    osm = fetch_osm(box, cache_dir)
    stripped = strip_osm(osm, bb)
    return {"pad_m": pad, "fetched": time.strftime("%Y-%m-%d"), "frame": "metres east and north of the bbox SW corner (web/js/geo.js makeProjection)",
            "bbox": {"min_lat": round(box.min_lat, 6), "max_lat": round(box.max_lat, 6),
                     "min_lon": round(box.min_lon, 6), "max_lon": round(box.max_lon, 6)},
            "label": "CONTEXT", "elevation": elevation, "power": context_power(osm, bb),
            "osm": {"query": "context-v1", "elements": stripped["elements"],
                    "dropped_inside": stripped["dropped_inside"],
                    "attribution": lookup_source("osm-overpass")["attribution"]}}
