#!/usr/bin/env python3
"""Fetch planning-application red lines from councils' Idox Public Access map services.

Idox Public Access sites publish application boundaries through the WFS behind
their map page (pamap). For each application in tools/datacentre_sources.json:

  1. read https://<host>/PAM/LIVE/pamap/config.json;
  2. resolve its mapBaseUrl (e.g. ../MapServer?map=pa) against that URL;
  3. POST a WFS 2.0 GetFeature for Planning_Application_Polygons, filtered on KEYVAL;
  4. send a Referer of the pamap URL (the servers answer 403 without it).

Coordinates come back as EPSG:27700 gml:posList. The area is computed in 27700 and
compared with the site area stated on the application form; a difference above 5 %
is reported as a warning (it is a fact about the record, not an error).

Writes data/sites/datacentre-red-lines.geojson (WGS84, 7 decimal places).

    python tools/fetch_council_boundaries.py                 # fetch live
    python tools/fetch_council_boundaries.py --raw FILE      # rebuild from a saved 27700 dump
    python tools/fetch_council_boundaries.py --save-raw FILE # also save the 27700 dump

Requires shapely and pyproj (both in the pipeline environment).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

from pyproj import Transformer
from shapely.geometry import MultiPolygon, Polygon

ROOT = Path(__file__).resolve().parents[1]
SOURCES = ROOT / "tools" / "datacentre_sources.json"
OUT = ROOT / "data" / "sites" / "datacentre-red-lines.geojson"

NS = {"gml": "http://www.opengis.net/gml/3.2", "wfs": "http://www.opengis.net/wfs/2.0",
      "ms": "http://mapserver.gis.umn.edu/mapserver"}
KIND = "application boundary (red line), as mapped by the council"
DESC_MAX = 200          # descriptions are cut to this length in the file
AREA_WARN = 0.05        # warn when the mapped area differs from the form by more than this
UA = "hyperscale-landscapes/0.1 (research; non-commercial)"

_to_wgs84 = Transformer.from_crs(27700, 4326, always_xy=True)


# ---------------------------------------------------------------- network

def pamap_url(host: str) -> str:
    return f"https://{host}/PAM/LIVE/pamap/"


def _get(url: str, referer: str, data: bytes | None = None, timeout: int = 60, tries: int = 3) -> bytes:
    for i in range(tries):
        try:
            return _get_once(url, referer, data, timeout)
        except (urllib.error.URLError, TimeoutError, subprocess.CalledProcessError) as e:
            if isinstance(e, urllib.error.HTTPError) and e.code < 500:
                raise
            if i == tries - 1:
                raise
            print(f"  retry {i + 1} for {urllib.parse.urlsplit(url).netloc}: {e}", file=sys.stderr)
            time.sleep(5 * (i + 1))


def _get_once(url: str, referer: str, data: bytes | None, timeout: int) -> bytes:
    headers = {"Referer": referer, "User-Agent": UA}
    if data is not None:
        headers["Content-Type"] = "text/xml"
    req = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read()
    except urllib.error.URLError as e:
        if not isinstance(e.reason, ssl.SSLCertVerificationError):
            raise
    # Some councils' servers omit the intermediate certificate (Inverclyde, Nov 2026). The
    # system curl completes the chain itself; verification stays on.
    cmd = ["curl", "-sSf", "-m", str(timeout)] + [a for k, v in headers.items() for a in ("-H", f"{k}: {v}")]
    if data is not None:
        cmd += ["--data-binary", "@-"]
    return subprocess.run(cmd + [url], input=data, capture_output=True, check=True).stdout


def wfs_url(host: str) -> str:
    """The WFS endpoint, resolved from the map page's config.json."""
    base = pamap_url(host)
    cfg = json.loads(_get(urllib.parse.urljoin(base, "config.json"), base))
    return urllib.parse.urljoin(base, cfg["mapBaseUrl"])


def get_feature_body(keyval: str) -> bytes:
    return (
        '<wfs:GetFeature service="WFS" version="2.0.0" '
        'xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:fes="http://www.opengis.net/fes/2.0">'
        '<wfs:Query typeNames="Planning_Application_Polygons"><fes:Filter><fes:PropertyIsEqualTo>'
        '<fes:ValueReference>KEYVAL</fes:ValueReference>'
        f'<fes:Literal>{keyval}</fes:Literal>'
        '</fes:PropertyIsEqualTo></fes:Filter></wfs:Query></wfs:GetFeature>'
    ).encode()


# ---------------------------------------------------------------- parsing

def _poslist(el) -> list[tuple[float, float]]:
    v = [float(t) for t in el.text.split()]
    return list(zip(v[0::2], v[1::2]))


def parse_wfs(xml: bytes) -> list[dict]:
    """Parse a GetFeature response into [{keyVal, ref, desc, polygons: [[ring, hole...]...]}] in 27700."""
    root = ET.fromstring(xml)
    out = []
    for m in root.iter(f"{{{NS['ms']}}}Planning_Application_Polygons"):
        polys = []
        for p in m.iter(f"{{{NS['gml']}}}Polygon"):
            ext = p.find("gml:exterior//gml:posList", NS)
            holes = [_poslist(h) for h in p.findall("gml:interior//gml:posList", NS)]
            polys.append([_poslist(ext)] + holes)
        txt = lambda tag: (m.findtext(f"ms:{tag}", default="", namespaces=NS) or "").strip()
        out.append({"keyVal": txt("KEYVAL"), "ref": txt("REFVAL"), "desc": txt("DESCRIPTION"), "polygons": polys})
    return out


# ---------------------------------------------------------------- geometry

def area_ha(polygons) -> float:
    return MultiPolygon([Polygon(p[0], p[1:]) for p in polygons]).area / 1e4


def to_wgs84(polygons) -> list:
    def ring(r):
        xs, ys = zip(*r)
        lon, lat = _to_wgs84.transform(xs, ys)
        return [[round(a, 7), round(b, 7)] for a, b in zip(lon, lat)]
    return [[ring(r) for r in p] for p in polygons]


def check_area(mapped_ha: float, form_ha: float | None) -> str | None:
    """A warning string when the mapped area differs from the form's by more than AREA_WARN."""
    if not form_ha:
        return None
    d = (mapped_ha - form_ha) / form_ha
    if abs(d) > AREA_WARN:
        return f"mapped {mapped_ha:.2f} ha vs form {form_ha:g} ha ({d:+.0%})"
    return None


def feature(app: dict, rec: dict, retrieved: str) -> dict:
    return {
        "type": "Feature",
        "properties": {
            "site": app["site"], "ref": app["ref"], "keyVal": app["keyVal"],
            "description": rec["desc"][:DESC_MAX],
            "source": f"{app['host']} public access map (WFS Planning_Application_Polygons)",
            "retrieved": retrieved,
            "area_ha": round(area_ha(rec["polygons"]), 2),
            "kind": KIND,
        },
        "geometry": {"type": "MultiPolygon", "coordinates": to_wgs84(rec["polygons"])},
    }


# ---------------------------------------------------------------- raw dump (27700)

def from_raw(raw: dict, app: dict) -> dict:
    """A record from the saved 27700 dump (rings as flat [x0, y0, x1, y1, ...] lists)."""
    for r in raw.get(app["site"], []):
        if r["keyVal"] == app["keyVal"]:
            polys = [[list(zip(f[0::2], f[1::2]))] for f in r["rings"]]
            return {"keyVal": r["keyVal"], "ref": r["ref"], "desc": r.get("desc", ""), "polygons": polys}
    raise KeyError(f"{app['site']} {app['keyVal']} not in the raw dump")


def to_raw(app: dict, rec: dict, wfs: str) -> dict:
    return {"keyVal": rec["keyVal"], "ref": rec["ref"], "desc": rec["desc"], "host": app["host"], "wfs": wfs,
            "rings": [[c for xy in p[0] for c in xy] for p in rec["polygons"]]}


# ---------------------------------------------------------------- main

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--raw", type=Path, help="rebuild from a saved EPSG:27700 dump instead of fetching")
    ap.add_argument("--save-raw", type=Path, help="write the fetched EPSG:27700 records here")
    ap.add_argument("--retrieved", help="retrieval date to record (default: today, or the dump's date)")
    ap.add_argument("--out", type=Path, default=OUT)
    a = ap.parse_args(argv)

    apps = json.loads(SOURCES.read_text())["applications"]
    raw = json.loads(a.raw.read_text()) if a.raw else None
    retrieved = a.retrieved or dt.date.today().isoformat()
    feats, dump, warnings = [], {}, []
    wfs_cache: dict[str, str] = {}
    for app in apps:
        if raw is not None:
            rec = from_raw(raw, app)
        else:
            host = app["host"]
            if host not in wfs_cache:
                wfs_cache[host] = wfs_url(host)
            recs = parse_wfs(_get(wfs_cache[host], pamap_url(host), get_feature_body(app["keyVal"])))
            if len(recs) != 1:
                print(f"! {app['site']} {app['ref']}: {len(recs)} features returned; skipped", file=sys.stderr)
                continue
            rec = recs[0]
            dump.setdefault(app["site"], []).append(to_raw(app, rec, wfs_cache[host]))
        f = feature(app, rec, retrieved)
        feats.append(f)
        w = check_area(f["properties"]["area_ha"], app.get("form_area_ha"))
        flag = f"  WARNING {w}" if w else ""
        print(f"{app['site']:18} {app['ref']:15} {f['properties']['area_ha']:8.2f} ha{flag}")
        if w:
            warnings.append(f"{app['site']} {app['ref']}: {w}")

    a.out.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False))
    if a.save_raw and dump:
        a.save_raw.write_text(json.dumps(dump))
    print(f"wrote {len(feats)} red lines to {a.out.relative_to(ROOT) if a.out.is_relative_to(ROOT) else a.out}")
    for w in warnings:
        print("area check:", w, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
