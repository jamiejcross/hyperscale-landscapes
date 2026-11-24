"""Command-line interface: ``hyperscale build | sites list``.

Examples
  hyperscale build --site auchtertool-cato
  hyperscale build --bbox last_bbox.json
  hyperscale build --polygon site.geojson --pad 600
  hyperscale build --min_lat 56.09158 --max_lat 56.10642 \\
                   --min_lon -3.30543 --max_lon -3.24569
  hyperscale sites list
"""
from __future__ import annotations

import argparse
import json
import logging
import math
import sys
from pathlib import Path

from .paths import data_dir
from .pipeline import BuildOptions, DEFAULT_COLOURS, build
from .providers.roads import ROAD_TYPES_BY_PROFILE

M_PER_DEG_LAT = 111_320.0


def load_sites() -> list[dict]:
    idx = data_dir() / "sites" / "index.json"
    if not idx.exists():
        return []
    return json.loads(idx.read_text())["sites"]


def site_bbox(site_id: str) -> tuple[dict, str, dict]:
    path = data_dir() / "sites" / f"{site_id}.geojson"
    if not path.exists():
        known = ", ".join(s["id"] for s in load_sites()) or "none"
        sys.exit(f"Unknown site '{site_id}'. Known sites: {known}")
    feat = json.loads(path.read_text())
    props = feat.get("properties", {})
    bb = props.get("model_bbox")
    if not bb:
        sys.exit(f"Site '{site_id}' has no model_bbox yet; see data/sites/TODO.md")
    insert = {}
    if feat.get("geometry"):
        # A sourced footprint exists: build the insert from the site record.
        refs = props.get("planning_refs") or []
        insert = {"footprint": str(path),
                  "insert_height_m": props.get("stated_height_m"),
                  "insert_height_source": props.get("massing_source"),
                  "footprint_precision": props.get("footprint_precision"),
                  "planning_ref": (refs[0].get("ref") if refs and isinstance(refs[0], dict)
                                   else (refs[0] if refs else None))}
    return bb, props.get("name") or site_id, insert


def polygon_bbox(path: Path, pad_m: float) -> dict:
    """Bounding box of every coordinate in a GeoJSON file, padded in metres."""
    gj = json.loads(path.read_text())
    coords = []

    def walk(o):
        if isinstance(o, (list, tuple)) and o and isinstance(o[0], (int, float)):
            coords.append(o[:2])
        elif isinstance(o, (list, tuple)):
            for x in o:
                walk(x)
        elif isinstance(o, dict):
            for k in ("features", "geometry", "geometries", "coordinates"):
                if k in o:
                    walk(o[k])
    walk(gj)
    if not coords:
        sys.exit(f"No coordinates found in {path}")
    lons = [c[0] for c in coords]; lats = [c[1] for c in coords]
    mid = (min(lats) + max(lats)) / 2
    dlat = pad_m / M_PER_DEG_LAT
    dlon = pad_m / (M_PER_DEG_LAT * math.cos(math.radians(mid)))
    return {"min_lat": min(lats) - dlat, "max_lat": max(lats) + dlat,
            "min_lon": min(lons) - dlon, "max_lon": max(lons) + dlon}


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="hyperscale", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("build", help="Build a print-ready 3MF (and optional STL)")
    where = b.add_mutually_exclusive_group()
    where.add_argument("--site", help="Curated site id (see `hyperscale sites list`)")
    where.add_argument("--bbox", type=Path, help="bbox JSON from the web app")
    where.add_argument("--polygon", type=Path, help="GeoJSON polygon of the area")
    b.add_argument("--pad", type=float, default=500.0,
                   help="Padding around --polygon in metres (default 500)")
    for k in ("min_lat", "max_lat", "min_lon", "max_lon"):
        b.add_argument(f"--{k}", type=float)
    b.add_argument("--name", default="", help="Title for the model and captions")
    b.add_argument("--print_size", type=float, default=150.0,
                   help="Longest edge in mm (default 150)")
    b.add_argument("--z_exag", type=float, default=2.0,
                   help="Terrain vertical exaggeration (default 2)")
    b.add_argument("--river_exag", type=float, default=0.6)
    b.add_argument("--building_exag", type=float, default=1.0,
                   help="Building height exaggeration (default 1 = true height)")
    b.add_argument("--roads", default="major-residential",
                   choices=list(ROAD_TYPES_BY_PROFILE))
    b.add_argument("--base", type=float, default=5.0, help="Base thickness mm (default 5)")
    b.add_argument("--road_raise", type=float, default=0.5)
    b.add_argument("--river_width", type=float, default=45.0)
    b.add_argument("--sea_level", type=float, default=3.0)
    b.add_argument("--elevation", default="auto", choices=["auto", "srtm", "copernicus"])
    b.add_argument("--buildings_source", default="osm", choices=["osm", "overture"])
    b.add_argument("--no_buildings", action="store_true")
    b.add_argument("--max_buildings", type=int)
    b.add_argument("--stl", action="store_true",
                   help="Also write a single-colour watertight STL (boolean union)")
    b.add_argument("--no_bambu_metadata", action="store_true",
                   help="Omit Bambu Studio filament-slot metadata from the 3MF")
    b.add_argument("--out_dir", default="output")
    b.add_argument("--cache_dir", default=None)
    b.add_argument("--force", action="store_true", help="Re-fetch cached data")
    b.add_argument("--preset", default="power-and-place",
                   help="Print preset: power-and-place, residues, full, classic, single-colour")
    b.add_argument("--no_features", action="store_true",
                   help="Leave out power, rail, residues and receptors")
    b.add_argument("--no_pegs", action="store_true", help="No pylon or turbine pegs")
    b.add_argument("--no_labels", action="store_true", help="No engraved base labels")
    b.add_argument("--viewer", action="store_true",
                   help="Also write the offline interactive 3D viewer (one HTML file)")
    ins = b.add_argument_group("data-centre insert")
    ins.add_argument("--footprint", help="GeoJSON polygon of the proposed facility")
    ins.add_argument("--insert_height_m", type=float,
                     help="Height of the facility in metres (stated or estimated)")
    ins.add_argument("--insert_height_source",
                     help="Where the height comes from, e.g. a planning document")
    ins.add_argument("--footprint_precision",
                     choices=["exact from plans", "digitised from images", "approximate"])
    ins.add_argument("--planning_ref", help="Planning reference for captions")
    ins.add_argument("--no_magnets", action="store_true")
    b.add_argument("-q", "--quiet", action="store_true")

    s = sub.add_parser("sites", help="Curated sites")
    s.add_argument("action", choices=["list"])
    return p


def main(argv=None) -> int:
    args = _build_parser().parse_args(argv)
    if args.cmd == "sites":
        sites = load_sites()
        if not sites:
            print("No curated sites found.")
        for site in sites:
            print(f"{site['id']:24} {site['name']}  [{site.get('status') or 'status unknown'}]")
        return 0

    logging.basicConfig(level=logging.WARNING if args.quiet else logging.INFO,
                        format="[%(name)s] %(message)s")
    name = args.name
    opts_extra = {}
    if args.site:
        bb, site_name, site_insert = site_bbox(args.site)
        name = name or site_name
        if site_insert and not args.footprint:
            opts_extra.update({k: v for k, v in site_insert.items() if v is not None})
    elif args.bbox:
        data = json.loads(args.bbox.read_text())
        bb = data.get("bbox", data)
        keymap = {"print_size_mm": "print_size", "base_mm": "base",
                  "road_raise_mm": "road_raise", "river_half_width_m": "river_width"}
        for k, v in data.get("options", {}).items():
            opts_extra[keymap.get(k, k)] = v
        if data.get("colours"):
            opts_extra["colours"] = {**DEFAULT_COLOURS, **data["colours"]}
    elif args.polygon:
        bb = polygon_bbox(args.polygon, args.pad)
    else:
        bb = {k: getattr(args, k) for k in ("min_lat", "max_lat", "min_lon", "max_lon")}
        if any(v is None for v in bb.values()):
            sys.exit("Give --site, --bbox, --polygon, or all four of "
                     "--min_lat/--max_lat/--min_lon/--max_lon")

    fields = BuildOptions.__dataclass_fields__
    opts = BuildOptions(
        **{k: bb[k] for k in ("min_lat", "max_lat", "min_lon", "max_lon")},
        **{k: getattr(args, k) for k in vars(args) if k in fields
           and k not in ("min_lat", "max_lat", "min_lon", "max_lon", "name")},
        name=name,
        bambu_metadata=not args.no_bambu_metadata,
        features=not args.no_features, pegs=not args.no_pegs,
        labels=not args.no_labels, magnets=not args.no_magnets,
    )
    for k, v in opts_extra.items():
        if k in fields:
            setattr(opts, k, v)

    span_km = max((opts.max_lat - opts.min_lat) * M_PER_DEG_LAT,
                  (opts.max_lon - opts.min_lon) * M_PER_DEG_LAT
                  * math.cos(math.radians((opts.min_lat + opts.max_lat) / 2))) / 1000
    if opts.footprint and not opts.insert_height_m:
        sys.exit("--footprint needs --insert_height_m (and ideally --insert_height_source)")
    if opts.footprint and not opts.insert_height_source:
        logging.warning("No source given for the insert height; it will be "
                        "recorded as unsourced in the manifest.")
    if span_km > 3.0:
        logging.warning("Area is %.1f km across: above ~3 km, buildings stop "
                        "being legible at A1 plate size.", span_km)

    m = build(opts)
    st = m["stats"]
    print(json.dumps({"outputs": {k: v for k, v in m["outputs"].items() if v},
                      "print_objects": {k: v["faces"] for k, v in m["print_objects"].items()},
                      "features": {k: sum(v.values()) for k, v in m["features"].items()},
                      "overhang_faces": st["overhang_faces"],
                      "support_free": st["support_free"],
                      "disclosure": m["disclosure"],
                      "seconds": st["build_seconds"]}, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
