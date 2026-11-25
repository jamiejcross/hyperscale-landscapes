"""Subsurface geology and coal for a site's slab walls and surface
(docs/claude-code-prompt-subsurface-geology.md, Stage 1).

Sources, all public BGS services (checked 25 Nov 2026):

  * BGS Geology 50k (WMS GetFeatureInfo): bedrock, superficial deposits,
    artificial ground and mass movement, sampled along each wall edge.
    Used under JC's BGS non-commercial licence: outputs carry
    ``nonCommercial: true`` and "Contains British Geological Survey
    materials © UKRI <year>".
  * BGS minerals WMS: ``Shallow.Coal`` (opencast coal resource areas) at the
    same wall points, and ``Mines.and.quarries`` (BritPits) for pits. BritPits
    has no query support, so we draw it as a transparent PNG, find the symbol
    blobs, and identify each blob. Positions come from the record's own
    EASTING/NORTHING, not the blob.
  * BGS Borehole Index (ArcGIS REST query): boreholes in the bbox and within
    100 m outside it.
  * BGS Mine Plans (OGC API): abandonment plans looked up by exact upper-case
    mine name for each pit name and simple variants, kept only when the
    record's gazetteer names the site's council area.

Every request is cached on disk (one JSON line per request), so a run that
stops part-way resumes where it left off. At most 8 requests are in flight.

    python -m hyperscale_landscapes.providers.subsurface auchtertool-cato
    python -m hyperscale_landscapes.providers.subsurface --report      # all sites
"""
from __future__ import annotations

import html
import io
import json
import logging
import math
import os
import re
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import DEFAULT_CACHE, USER_AGENT, require_online

log = logging.getLogger(__name__)

GEOLOGY_WMS = "https://map.bgs.ac.uk/arcgis/services/BGS_Detailed_Geology/MapServer/WMSServer"
MINERALS_WMS = "https://map.bgs.ac.uk/arcgis/services/GeoIndex_Onshore/minerals_wms/MapServer/WMSServer"
BOREHOLES_REST = "https://map.bgs.ac.uk/arcgis/rest/services/GeoIndex_Onshore/boreholes/MapServer/0/query"
MINE_PLANS_OGC = "https://ogcapi.bgs.ac.uk/collections/mine_plans/items"

GEOLOGY_LAYERS = {"bedrock": "BGS.50k.Bedrock", "superficial": "BGS.50k.Superficial.deposits",
                  "artificial": "BGS.50k.Artificial.ground", "mass_movement": "BGS.50k.Mass.movement"}
UNIT_FIELDS = ("LEX", "LEX_D", "RCS", "RCS_D", "TYPE_D", "MAX_PERIOD", "BGSRED", "BGSGREEN", "BGSBLUE",
               "MAP_SRC", "VERSION", "RELEASED")
PIT_FIELDS = ("PIT_NAME", "PIT_STATUS", "EASTING", "NORTHING", "BGS_REFERENCE")
PLAN_FIELDS = ("mine_name", "mineral_trans_comma_list", "seam_name", "year_abandoned", "mra_catalogue_number",
               "has_public_visible_scans_yn", "scan_url_comma_list", "gaz_feature_name_comma_list")

STEP_M = 40.0             # wall sample spacing
BOREHOLE_MARGIN_M = 100.0
MAX_IN_FLIGHT = 8
CACHE_VERSION = "v1"
SIDES = ("south", "east", "north", "west")

# ASSUMED thicknesses (metres), used where no borehole log gives the real value.
NOMINAL_THICKNESS_M = {
    "superficial": {"till": 6, "glaciofluvial": 5, "alluvium": 4, "peat": 2, "made ground": 3},
    "sheets": {"sill": [20, 30], "limestone bed": [4, 5]},
}

ATTRIBUTION = "Contains British Geological Survey materials © UKRI {year}"
M_PER_DEG_LAT = 111_320.0


# ---------------------------------------------------------------- parsing

def parse_fields(xml: str) -> list[dict]:
    """Every <FIELDS ...> record in an Esri WMS GetFeatureInfo response, as a dict.

    Values can contain '>' (e.g. "MDST + ... > 50%"), so the tag cannot be
    matched as a whole: take the text after each '<FIELDS ' up to its closing
    tag and pull the name="value" pairs out of it.
    """
    out = []
    for chunk in xml.split("<FIELDS ")[1:]:
        body = re.split(r"/>|</FIELDS>", chunk, maxsplit=1)[0]
        out.append({k: html.unescape(v) for k, v in re.findall(r'(\w+)="([^"]*)"', body)})
    return out


def pit_base_name(name: str) -> str:
    """'Little Raith Quarries' -> 'LITTLE RAITH'; 'Dundonald Colliery' -> 'DUNDONALD'."""
    s = re.sub(r"\s+", " ", name.upper()).strip()
    s = re.sub(r"\s*\((.*?)\)\s*", " ", s).strip()
    s = re.sub(r"\b(COLLIERY|COLLIERIES|PIT|PITS|MINE|MINES|QUARRY|QUARRIES|WORKS|NO\.?\s*\d+)$", "", s).strip()
    return s


def name_variants(name: str) -> list[str]:
    base = pit_base_name(name)
    seen, out = set(), []
    for v in (name.upper().strip(), base, f"{base} COLLIERY", f"{base} PIT"):
        if v and v not in seen:
            seen.add(v); out.append(v)
    return out


def council_tokens(local_authority: str) -> list[str]:
    la = local_authority.upper().replace("&", "AND")
    toks = {la, la.removeprefix("CITY OF ").strip()}
    return sorted(t for t in toks if t)


def is_coal_plan(plan: dict) -> bool:
    return "COAL" in (plan.get("minerals") or "").upper()


def classify_pit(pit: dict, plans: list[dict], commodity: str | None = None) -> str:
    """coal | quarry | unknown (brief, Stage 1). A coal Mine Plans record in the
    same council area wins; then a quarry name or non-coal commodity; then a
    name saying "Colliery" (a colliery is a coal mine: flagged coal_by_name)."""
    if commodity:
        return "coal" if "coal" in commodity.lower() else "quarry"
    if any(is_coal_plan(p) for p in plans):
        return "coal"
    if re.search(r"quarr", pit.get("name", ""), re.I):
        return "quarry"
    if is_colliery_name(pit.get("name", "")):
        return "coal"
    return "unknown"


def is_colliery_name(name: str) -> bool:
    return bool(re.search(r"\bcollier(y|ies)\b", name or "", re.I))


# ---------------------------------------------------------------- network, cached

class _RequestCache:
    """One JSON line per request: {"k": key, "v": value}. Thread-safe append."""

    def __init__(self, path: Path):
        self.path, self.lock, self.mem = path, threading.Lock(), {}
        if path.exists():
            for line in path.read_text().splitlines():
                try:
                    d = json.loads(line); self.mem[d["k"]] = d["v"]
                except (ValueError, KeyError):
                    continue

    def get(self, key):
        return self.mem.get(key, _MISSING)

    def put(self, key, value):
        with self.lock:
            self.mem[key] = value
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a") as f:
                f.write(json.dumps({"k": key, "v": value}) + "\n")


_MISSING = object()
_sem = threading.BoundedSemaphore(MAX_IN_FLIGHT)


def _fetch(url: str, binary: bool = False, timeout: int = 60):
    require_online("BGS subsurface data")
    last = None
    for attempt in range(7):     # BGS services return 503 under load: back off up to ~2 min
        try:
            with _sem, urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": USER_AGENT}),
                                              timeout=timeout) as r:
                b = r.read()
            return b if binary else b.decode("utf-8", "replace")
        except Exception as e:     # noqa: BLE001 - retried, then raised
            last = e
            time.sleep(min(60, 3 * 2 ** attempt))
    raise RuntimeError(f"BGS request failed after retries: {last}")


def _cached_text(cache: _RequestCache, url: str) -> str:
    v = cache.get(url)
    if v is _MISSING:
        v = _fetch(url)
        cache.put(url, v)
    return v


def _feature_info_url(base: str, layer: str, lat: float, lon: float, e: float = 0.01) -> str:
    # Layers are scale-limited: a ±0.01° box at 101 px, querying the centre pixel.
    q = {"service": "WMS", "version": "1.3.0", "request": "GetFeatureInfo", "layers": layer,
         "query_layers": layer, "styles": "", "crs": "EPSG:4326",
         "bbox": f"{lat - e:.6f},{lon - e:.6f},{lat + e:.6f},{lon + e:.6f}",
         "width": 101, "height": 101, "i": 50, "j": 50, "info_format": "text/xml"}
    return base + "?" + urllib.parse.urlencode(q)


# ---------------------------------------------------------------- walls

def wall_points(bb: dict, step_m: float = STEP_M) -> dict[str, list[tuple[float, float, float]]]:
    """Sample points per side as (lon, lat, metres along), each side running left
    to right as seen from outside: S west->east, E south->north, N east->west,
    W north->south."""
    mlon = M_PER_DEG_LAT * math.cos(math.radians((bb["min_lat"] + bb["max_lat"]) / 2))
    W = (bb["max_lon"] - bb["min_lon"]) * mlon
    H = (bb["max_lat"] - bb["min_lat"]) * M_PER_DEG_LAT
    SW, SE = (bb["min_lon"], bb["min_lat"]), (bb["max_lon"], bb["min_lat"])
    NE, NW = (bb["max_lon"], bb["max_lat"]), (bb["min_lon"], bb["max_lat"])

    def pts(a, b, L):
        n = max(2, int(L / step_m) + 1)
        return [(a[0] + (b[0] - a[0]) * k / (n - 1), a[1] + (b[1] - a[1]) * k / (n - 1), L * k / (n - 1))
                for k in range(n)]
    return {"south": pts(SW, SE, W), "east": pts(SE, NE, H), "north": pts(NE, NW, W), "west": pts(NW, SW, H)}


def sample_walls(bb: dict, cache: _RequestCache, step_m: float = STEP_M) -> dict:
    """Per-side arrays in a compact form: a unit table (one entry per distinct
    BGS unit) and, per side and layer, an index into it (-1 = none), plus a
    Shallow.Coal flag per point."""
    sides = wall_points(bb, step_m)
    jobs = []
    for s, P in sides.items():
        for k, (lon, lat, _) in enumerate(P):
            for name, layer in GEOLOGY_LAYERS.items():
                jobs.append((s, k, name, _feature_info_url(GEOLOGY_WMS, layer, lat, lon)))
            jobs.append((s, k, "shallow_coal", _feature_info_url(MINERALS_WMS, "Shallow.Coal", lat, lon)))
    with ThreadPoolExecutor(MAX_IN_FLIGHT) as ex:
        texts = list(ex.map(lambda j: _cached_text(cache, j[3]), jobs))

    units, unit_index = [], {}
    out = {s: {"m": [round(p[2], 1) for p in P], **{n: [-1] * len(P) for n in GEOLOGY_LAYERS},
               "shallow_coal": [0] * len(P)} for s, P in sides.items()}
    for (s, k, name, _), text in zip(jobs, texts):
        recs = parse_fields(text)
        if name == "shallow_coal":
            out[s]["shallow_coal"][k] = int(any("opencast coal" in (r.get("MIN_RES") or "").lower() for r in recs))
            continue
        if not recs:
            continue
        r = recs[0]
        u = {f: r.get(f) for f in UNIT_FIELDS}
        u["layer"] = name
        key = (name, u["LEX"], u["RCS"], u["LEX_D"])
        if key not in unit_index:
            unit_index[key] = len(units)
            units.append(u)
        out[s][name][k] = unit_index[key]
    for s in out:
        out[s]["lonlat"] = [[round(p[0], 6), round(p[1], 6)] for p in sides[s]]
    return {"step_m": step_m, "units": units, "sides": out}


# ---------------------------------------------------------------- boreholes

def boreholes(bb: dict, cache: _RequestCache, margin_m: float = BOREHOLE_MARGIN_M) -> list[dict]:
    dlat = margin_m / M_PER_DEG_LAT
    dlon = margin_m / (M_PER_DEG_LAT * math.cos(math.radians(bb["min_lat"])))
    env = f"{bb['min_lon'] - dlon},{bb['min_lat'] - dlat},{bb['max_lon'] + dlon},{bb['max_lat'] + dlat}"
    out, offset = [], 0
    while True:
        q = {"geometry": env, "geometryType": "esriGeometryEnvelope", "inSR": 4326, "outSR": 4326,
             "spatialRel": "esriSpatialRelIntersects", "outFields": "REFERENCE,NAME,LENGTH,YEAR_KNOWN,SCAN_URL,AGS_LOG_URL",
             "returnGeometry": "true", "f": "json", "resultOffset": offset, "resultRecordCount": 1000}
        d = json.loads(_cached_text(cache, BOREHOLES_REST + "?" + urllib.parse.urlencode(q)))
        if "error" in d:
            raise RuntimeError(f"BGS borehole query: {d['error']}")
        feats = d.get("features", [])
        for f in feats:
            a, g = f["attributes"], f.get("geometry") or {}
            inside = bb["min_lon"] <= g.get("x", 1e9) <= bb["max_lon"] and bb["min_lat"] <= g.get("y", 1e9) <= bb["max_lat"]
            out.append({"ref": a.get("REFERENCE"), "name": a.get("NAME"), "length_m": a.get("LENGTH"),
                        "year": a.get("YEAR_KNOWN"), "lon": g.get("x"), "lat": g.get("y"), "inside": inside,
                        "scan_url": a.get("SCAN_URL"), "ags_url": a.get("AGS_LOG_URL")})
        if len(feats) < 1000 and not d.get("exceededTransferLimit"):
            return out
        offset += len(feats)


# ---------------------------------------------------------------- pits and plans

def _getmap_url(bb: dict, w: int, h: int, pad: float) -> tuple[str, dict]:
    dlat, dlon = (bb["max_lat"] - bb["min_lat"]) * pad, (bb["max_lon"] - bb["min_lon"]) * pad
    box = {"min_lat": bb["min_lat"] - dlat, "max_lat": bb["max_lat"] + dlat,
           "min_lon": bb["min_lon"] - dlon, "max_lon": bb["max_lon"] + dlon}
    q = {"service": "WMS", "version": "1.3.0", "request": "GetMap", "layers": "Mines.and.quarries", "styles": "",
         "crs": "EPSG:4326", "bbox": f"{box['min_lat']},{box['min_lon']},{box['max_lat']},{box['max_lon']}",
         "width": w, "height": h, "format": "image/png", "transparent": "true"}
    return MINERALS_WMS + "?" + urllib.parse.urlencode(q), box


def britpits(bb: dict, cache: _RequestCache, width_px: int = 1200) -> list[dict]:
    """BritPits records inside the bbox (blob workflow; see module docstring)."""
    import numpy as np
    from PIL import Image
    from pyproj import Transformer
    from scipy import ndimage

    mlon = math.cos(math.radians((bb["min_lat"] + bb["max_lat"]) / 2))
    aspect = (bb["max_lat"] - bb["min_lat"]) / ((bb["max_lon"] - bb["min_lon"]) * mlon)
    w = width_px; h = max(50, round(w * aspect))
    url, box = _getmap_url(bb, w, h, pad=0.02)
    png = cache.get(url)
    if png is _MISSING:
        import base64
        raw = _fetch(url, binary=True)
        cache.put(url, base64.b64encode(raw).decode())
    else:
        import base64
        raw = base64.b64decode(png)
    a = np.array(Image.open(io.BytesIO(raw)).convert("RGBA"))
    lab, n = ndimage.label(a[..., 3] > 0)
    centres = ndimage.center_of_mass(a[..., 3] > 0, lab, range(1, n + 1)) if n else []
    recs = {}

    def identify(c):
        j, i = round(c[0]), round(c[1])
        q = {"service": "WMS", "version": "1.3.0", "request": "GetFeatureInfo", "layers": "Mines.and.quarries",
             "query_layers": "Mines.and.quarries", "styles": "", "crs": "EPSG:4326",
             "bbox": f"{box['min_lat']},{box['min_lon']},{box['max_lat']},{box['max_lon']}",
             "width": w, "height": h, "i": i, "j": j, "feature_count": 5, "info_format": "text/xml"}
        return parse_fields(_cached_text(cache, MINERALS_WMS + "?" + urllib.parse.urlencode(q)))
    with ThreadPoolExecutor(MAX_IN_FLIGHT) as ex:
        for found in ex.map(identify, centres):
            for r in found:
                if r.get("BGS_REFERENCE"):
                    recs[r["BGS_REFERENCE"]] = r
    tr = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)
    out = []
    for r in recs.values():
        try:
            lon, lat = tr.transform(float(r["EASTING"]), float(r["NORTHING"]))
        except (TypeError, ValueError, KeyError):
            continue
        if bb["min_lon"] <= lon <= bb["max_lon"] and bb["min_lat"] <= lat <= bb["max_lat"]:
            out.append({"ref": r["BGS_REFERENCE"], "name": (r.get("PIT_NAME") or "").strip(),
                        "status": r.get("PIT_STATUS"), "easting": float(r["EASTING"]),
                        "northing": float(r["NORTHING"]), "lon": round(lon, 6), "lat": round(lat, 6)})
    out.sort(key=lambda p: (p["name"], p["ref"]))
    return out


def mine_plans(names: list[str], local_authority: str, cache: _RequestCache) -> dict[str, list[dict]]:
    """For each pit name: the Mine Plans records (grouped by MRA catalogue number)
    found under its exact upper-case name or a simple variant, in the council area.
    (bbox and q= searches do not work on this collection; see the brief.)"""
    toks = council_tokens(local_authority)

    def lookup(variant):
        url = MINE_PLANS_OGC + "?" + urllib.parse.urlencode({"mine_name": variant, "limit": 500, "f": "json"})
        return variant, json.loads(_cached_text(cache, url)).get("features", [])
    variants = sorted({v for n in names for v in name_variants(n)})
    with ThreadPoolExecutor(MAX_IN_FLIGHT) as ex:
        by_variant = dict(ex.map(lookup, variants))
    out = {}
    for n in names:
        groups = {}
        for v in name_variants(n):
            for f in by_variant.get(v, []):
                p = f.get("properties", {})
                gaz = (p.get("gaz_feature_name_comma_list") or "").upper().split(",")
                if not any(t in [g.strip() for g in gaz] for t in toks):
                    continue
                cat = p.get("mra_catalogue_number") or f"?{p.get('mine_name')}"
                g = groups.setdefault(cat, {"catalogue": p.get("mra_catalogue_number"), "mine_name": p.get("mine_name"),
                                            "matched_as": v, "minerals": p.get("mineral_trans_comma_list"),
                                            "year_abandoned": (p.get("year_abandoned") or "")[:4] or None,
                                            "seams": set(), "public_scans": False, "scan_urls": set()})
                if p.get("seam_name"):
                    g["seams"].add(p["seam_name"].strip().title())
                if (p.get("has_public_visible_scans_yn") or "").upper() == "Y":
                    g["public_scans"] = True
                for u in (p.get("scan_url_comma_list") or "").split(","):
                    if u.strip():
                        g["scan_urls"].add(u.strip())
        out[n] = [{**g, "seams": sorted(g["seams"]), "scan_urls": sorted(g["scan_urls"])} for g in groups.values()]
    return out


# ---------------------------------------------------------------- the provider

def fetch(site: dict, cache_dir: Path = DEFAULT_CACHE, step_m: float = STEP_M) -> dict:
    """The subsurface section for one site (a data/sites/*.geojson Feature)."""
    props = site["properties"]
    bb = props["model_bbox"]
    if os.environ.get("BGS_GEOLOGY_50K_PATH") or os.environ.get("BGS_BRITPITS_PATH"):
        # The brief asks for local licensed extracts to replace WMS when present.
        # No such file exists yet to test against, so refuse rather than guess its schema.
        raise NotImplementedError("Local BGS extracts are configured, but their reader is written only once a "
                                  "file is available to test against. Unset BGS_GEOLOGY_50K_PATH / BGS_BRITPITS_PATH.")
    cache = _RequestCache(Path(cache_dir) / "subsurface" / f"requests_{CACHE_VERSION}.jsonl")
    walls = sample_walls(bb, cache, step_m)
    bores = boreholes(bb, cache)
    pits = britpits(bb, cache)
    plans = mine_plans(sorted({p["name"] for p in pits if p["name"]}), props.get("local_authority", ""), cache)
    for p in pits:
        p["plans"] = plans.get(p["name"], [])
        p["class"] = classify_pit(p, p["plans"])
        # Flag the case where a quarry-named pit is called coal through a stripped name.
        p["coal_by_stripped_name"] = bool(p["class"] == "coal" and re.search(r"quarr", p["name"], re.I)
                                          and all(pl["matched_as"] != p["name"].upper() for pl in p["plans"]))
        # Coal by the name alone ("... Colliery"), with no coal mine plan matched.
        p["coal_by_name"] = bool(p["class"] == "coal" and not any(is_coal_plan(pl) for pl in p["plans"])
                                 and is_colliery_name(p["name"]))
    versions = sorted({(u.get("VERSION"), u.get("RELEASED")) for u in walls["units"] if u.get("VERSION")})
    year = time.strftime("%Y")
    return {
        "fetched": time.strftime("%Y-%m-%d"),
        "walls": walls, "boreholes": bores, "pits": pits,
        "nominal_thickness_m": NOMINAL_THICKNESS_M,
        "sources": {
            "geology_50k": {"service": GEOLOGY_WMS, "versions": [{"version": v, "released": r} for v, r in versions],
                            "map_sheets": sorted({u["MAP_SRC"] for u in walls["units"] if u.get("MAP_SRC")})},
            "shallow_coal": MINERALS_WMS + " (Shallow.Coal)",
            "britpits": MINERALS_WMS + " (Mines.and.quarries)",
            "boreholes": BOREHOLES_REST, "mine_plans": MINE_PLANS_OGC,
        },
        "nonCommercial": True,
        "attribution": ATTRIBUTION.format(year=year),
        "labels": {"DATA": ["unit extents along walls", "opencast coal resource extent", "borehole position and depth",
                            "pit positions and names", "plan seam names"],
                   "ASSUMED": ["superficial thickness", "sheet thickness", "vertical projection of bedrock contacts"],
                   "SCHEMATIC": ["seam count, spacing and thickness", "cyclothem patterns"]},
    }


def summary(site_id: str, sub: dict) -> dict:
    """One row of the Stage 1 report."""
    units = sub["walls"]["units"]
    row = {"site": site_id}
    coal_pts = total = 0
    for s in SIDES:
        side = sub["walls"]["sides"][s]
        names = [units[i]["LEX_D"] for i in side["bedrock"] if i >= 0]
        row[f"{s[0].upper()} units"] = len(set(names)) + len({units[i]["LEX_D"] for i in side["superficial"] if i >= 0})
        for k in range(len(side["m"])):
            total += 1
            b = side["bedrock"][k]
            if side["shallow_coal"][k] or (b >= 0 and "coal" in (units[b]["LEX_D"] or "").lower()):
                coal_pts += 1
    row["% wall coal-bearing"] = round(100 * coal_pts / max(1, total))
    row["Shallow.Coal hits"] = sum(sum(sub["walls"]["sides"][s]["shallow_coal"]) for s in SIDES)
    b = sub["boreholes"]
    row["boreholes"] = len(b)
    row["with AGS log"] = sum(1 for x in b if x.get("ags_url"))
    for c in ("coal", "quarry", "unknown"):
        row[f"pits {c}"] = sum(1 for p in sub["pits"] if p["class"] == c)
    row["plan matches"] = sum(len(p["plans"]) for p in sub["pits"])
    row["flag"] = "coalfield, no plan match" if (row["% wall coal-bearing"] > 0 or row["Shallow.Coal hits"]) \
        and row["plan matches"] == 0 else ""
    if any(p.get("coal_by_stripped_name") for p in sub["pits"]):
        row["flag"] = (row["flag"] + "; " if row["flag"] else "") + "quarry-named pit matched a coal plan"
    return row


def _main(argv: list[str]) -> None:
    from ..paths import data_dir
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    sites_dir = data_dir() / "sites"
    ids = [a for a in argv if not a.startswith("--")] or sorted(p.name[:-8] for p in sites_dir.glob("*.geojson"))
    rows = []
    out_dir = Path(DEFAULT_CACHE) / "subsurface"
    for sid in ids:
        t0 = time.time()
        site = json.loads((sites_dir / f"{sid}.geojson").read_text())
        sub = fetch(site)
        (out_dir / f"{sid}.json").write_text(json.dumps(sub))
        rows.append(summary(sid, sub))
        print(f"{sid}: {time.time() - t0:.0f} s  {rows[-1]}", flush=True)
    if "--report" in argv:
        cols = list(rows[0])
        print("\n| " + " | ".join(cols) + " |\n|" + "---|" * len(cols))
        for r in rows:
            print("| " + " | ".join(str(r[c]) for c in cols) + " |")


if __name__ == "__main__":
    import sys
    _main(sys.argv[1:])
