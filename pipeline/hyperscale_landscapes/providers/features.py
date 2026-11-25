"""Features provider: power, rail, industrial residues, receptors and land
cover from OpenStreetMap, in a single Overpass query.

Each feature is normalised to::

    {"layer": "power", "kind": "substation", "status": "existing",
     "geometry": <GeoJSON geometry, lon/lat>, "tags": {...}}

``status`` is one of existing / proposed / construction / disused, and is
read from the tags only, never inferred.  ``tags`` keeps a short
allow-list (voltage, operator, start_date, ...).  ``name`` is kept only
for institutions and infrastructure, never for homes (brief §7, data
ethics).
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

from . import BBox, DEFAULT_CACHE, ProviderResult, overpass_query

log = logging.getLogger(__name__)

CACHE_VERSION = "v1"

KEEP_TAGS = {"voltage", "operator", "start_date", "end_date", "frequency",
             "generator:source", "generator:method", "generator:output:electricity",
             "plant:source", "plant:output:electricity", "plant:storage",
             "height", "railway", "usage", "historic", "man_made", "landuse",
             "natural", "amenity", "social_facility", "healthcare", "substance",
             "resource", "industrial", "construction", "proposed", "disused",
             "abandoned",
             # supports and turbines (3D symbols): dimensions and design
             "height:hub", "hub_height", "rotor:diameter", "manufacturer", "model", "structure", "design",
             "line_attachment", "direction",
             # individual trees and tree rows
             "genus", "species", "leaf_type", "leaf_cycle", "taxon", "denotation"}
# The tags the 3D props rely on; the web app's KEEP must include them too
# (tests/test_query_parity.py).
PROP_TAGS = {"height", "height:hub", "rotor:diameter", "generator:source", "generator:output:electricity",
             "manufacturer", "model", "voltage", "structure", "design", "line_attachment",
             "genus", "species", "leaf_type"}

RAIL_KINDS = {"rail", "light_rail", "narrow_gauge", "subway", "tram",
              "abandoned", "disused", "razed", "dismantled", "preserved",
              "construction", "proposed"}
RESIDUE_HISTORIC = {"mine", "mine_shaft", "mine_adit", "industrial", "kiln",
                    "ruins", "charcoal_pile", "bunker"}
RESIDUE_MAN_MADE = {"spoil_heap", "mineshaft", "adit", "works", "gasometer",
                    "chimney", "storage_tank", "wastewater_plant", "kiln",
                    "slurry_tank", "silo"}
RESIDUE_LANDUSE = {"quarry", "landfill", "brownfield", "industrial", "military"}
LANDCOVER_LANDUSE = {"farmland", "meadow", "forest", "residential", "grass",
                     "farmyard", "orchard", "allotments", "cemetery", "railway",
                     "construction", "greenfield", "commercial", "retail",
                     "recreation_ground", "village_green"}
LANDCOVER_NATURAL = {"wood", "heath", "scrub", "wetland", "grassland",
                     "bare_rock", "scree", "moor", "fell"}
RECEPTOR_AMENITY = {"school", "kindergarten", "college", "university",
                    "hospital", "clinic", "doctors", "prison",
                    "community_centre", "place_of_worship", "library",
                    "social_facility", "nursing_home", "childcare"}


def _query(bbox: BBox) -> str:
    b = f"{bbox.min_lat},{bbox.min_lon},{bbox.max_lat},{bbox.max_lon}"
    rx = lambda s: "^(" + "|".join(sorted(s)) + ")$"  # noqa: E731
    return f"""
[out:json][timeout:180];
(
  nwr["power"]({b});
  nwr["construction:power"]({b});
  nwr["proposed:power"]({b});
  nwr["disused:power"]({b});
  nwr["generator:source"]({b});
  nwr["plant:source"]({b});
  way["railway"~"{rx(RAIL_KINDS)}"]({b});
  way["disused:railway"]({b});
  way["abandoned:railway"]({b});
  nwr["historic"~"{rx(RESIDUE_HISTORIC)}"]({b});
  nwr["man_made"~"{rx(RESIDUE_MAN_MADE)}"]({b});
  nwr["landuse"~"{rx(RESIDUE_LANDUSE | LANDCOVER_LANDUSE)}"]({b});
  nwr["natural"~"{rx(LANDCOVER_NATURAL)}"]({b});
  nwr["amenity"~"{rx(RECEPTOR_AMENITY)}"]({b});
  nwr["social_facility"]({b});
  nwr["healthcare"]({b});
  node["natural"="tree"]({b});
  way["natural"="tree_row"]({b});
);
out tags geom({b});
"""


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------

def _status(tags: dict) -> str:
    v = " ".join(f"{k}={val}" for k, val in tags.items())
    if tags.get("power") == "construction" or "construction:power" in tags \
            or tags.get("railway") == "construction":
        return "construction"
    if tags.get("power") == "proposed" or "proposed:power" in tags \
            or tags.get("railway") == "proposed":
        return "proposed"
    if (tags.get("railway") in {"abandoned", "disused", "razed", "dismantled"}
            or "disused:" in v or "abandoned:" in v
            or tags.get("disused") == "yes" or tags.get("abandoned") == "yes"):
        return "disused"
    return "existing"


def classify(tags: dict) -> tuple[str, str] | None:
    """Return (layer, kind) for a tag set, or None if not wanted."""
    power = (tags.get("power") or tags.get("construction:power")
             or tags.get("proposed:power") or tags.get("disused:power"))
    if power in ("construction", "proposed"):
        # power=construction + construction=substation, etc.
        power = tags.get(power) or power
    if power or "generator:source" in tags or "plant:source" in tags:
        if (tags.get("generator:source") == "battery" or tags.get("plant:storage")
                or tags.get("generator:method") == "battery-storage"):
            return "power", "battery"
        if power in (None, "generator") and "generator:source" in tags:
            return "power", f"generator:{tags['generator:source']}"
        if power in (None, "plant") and "plant:source" in tags:
            return "power", f"plant:{tags['plant:source']}"
        return "power", power or "generator"

    rail = tags.get("railway")
    if rail in RAIL_KINDS or "disused:railway" in tags or "abandoned:railway" in tags:
        return "rail", rail or tags.get("disused:railway") or tags.get("abandoned:railway")

    if tags.get("historic") in RESIDUE_HISTORIC:
        return "residues", f"historic:{tags['historic']}"
    if tags.get("man_made") in RESIDUE_MAN_MADE:
        return "residues", f"man_made:{tags['man_made']}"
    if tags.get("landuse") in RESIDUE_LANDUSE:
        return "residues", f"landuse:{tags['landuse']}"

    if (tags.get("amenity") in RECEPTOR_AMENITY or "social_facility" in tags
            or "healthcare" in tags):
        kind = (tags.get("amenity") or tags.get("social_facility")
                or tags.get("healthcare"))
        return "receptors", kind

    if tags.get("landuse") in LANDCOVER_LANDUSE:
        return "landcover", f"landuse:{tags['landuse']}"
    if tags.get("natural") in LANDCOVER_NATURAL:
        return "landcover", f"natural:{tags['natural']}"
    if tags.get("natural") in ("tree", "tree_row"):
        return "trees", tags["natural"]
    return None


def _clean_tags(tags: dict, layer: str) -> dict:
    out = {k: v for k, v in tags.items() if k in KEEP_TAGS}
    # Names only for public institutions and infrastructure, never homes.
    if "name" in tags and layer in ("power", "rail", "residues", "receptors"):
        out["name"] = tags["name"]
    return out


# ---------------------------------------------------------------------------
# Geometry assembly from `out geom`
# ---------------------------------------------------------------------------

def _closed(coords) -> bool:
    return len(coords) >= 4 and coords[0] == coords[-1]


AREA_KINDS_LINE = {"line", "minor_line", "cable"}


def _geometry(el: dict, layer: str, kind: str):
    if el["type"] == "node":
        return {"type": "Point", "coordinates": [el["lon"], el["lat"]]}
    if el["type"] == "way":
        coords = [[p["lon"], p["lat"]] for p in el.get("geometry", []) if p]
        if len(coords) < 2:
            return None
        linear = layer == "rail" or kind in AREA_KINDS_LINE
        if _closed(coords) and not linear:
            return {"type": "Polygon", "coordinates": [coords]}
        return {"type": "LineString", "coordinates": coords}
    if el["type"] == "relation":
        from shapely.geometry import LineString, mapping
        from shapely.ops import polygonize, unary_union
        outers, inners = [], []
        for m in el.get("members", []):
            g = [(p["lon"], p["lat"]) for p in m.get("geometry", []) or [] if p]
            if len(g) < 2:
                continue
            (inners if m.get("role") == "inner" else outers).append(LineString(g))
        if not outers:
            return None
        polys = list(polygonize(unary_union(outers)))
        if not polys:
            return None
        shape = unary_union(polys)
        if inners:
            holes = list(polygonize(unary_union(inners)))
            if holes:
                shape = shape.difference(unary_union(holes))
        return mapping(shape) if not shape.is_empty else None
    return None


def parse(osm: dict) -> list[dict]:
    feats = []
    for el in osm.get("elements", []):
        tags = el.get("tags") or {}
        cls = classify(tags)
        if cls is None:
            continue
        layer, kind = cls
        geom = _geometry(el, layer, kind)
        if geom is None:
            continue
        feats.append({"layer": layer, "kind": kind, "status": _status(tags),
                      "osm": f"{el['type'][0]}{el['id']}",
                      "geometry": geom, "tags": _clean_tags(tags, layer)})
    return feats


def fetch(bbox: BBox, cache_dir: Path = DEFAULT_CACHE, **kwargs) -> ProviderResult:
    cache = Path(cache_dir) / "features"
    cache.mkdir(parents=True, exist_ok=True)
    key = (f"{bbox.min_lat:.4f}_{bbox.max_lat:.4f}"
           f"_{bbox.min_lon:.4f}_{bbox.max_lon:.4f}")
    cache_file = cache / f"osm_features_{CACHE_VERSION}_{key}.json"
    cached = cache_file.exists() and not kwargs.get("force")
    if cached:
        log.info("Using cached OSM features")
        raw = json.loads(cache_file.read_text())
    else:
        log.info("Fetching power, rail, residues, receptors and land cover...")
        raw = overpass_query(_query(bbox), timeout=240)
        cache_file.write_text(json.dumps(raw))
    feats = parse(raw)
    counts: dict[str, int] = {}
    for f in feats:
        counts[f["layer"]] = counts.get(f["layer"], 0) + 1
    log.info("Features: %s", counts)
    return ProviderResult(data=feats, source="osm-overpass", cached=cached,
                          metadata={"counts": counts})
