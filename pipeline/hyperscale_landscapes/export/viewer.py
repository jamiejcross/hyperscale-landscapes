"""Offline viewer from a Python build: the same single-file HTML viewer the
web app downloads (web/viewer.html + web/js/viewer/main.js and the shared
scene/studio/caption modules), filled with the full-resolution meshes.

Needs a repository checkout (it reads web/) and Pillow (for the land-cover
drape).
"""
from __future__ import annotations

import base64
import gzip
import json
import time
from pathlib import Path

import numpy as np

from ..paths import data_dir

MODULES = {
    "three": "vendor/three/three.module.min.js",
    "three/addons/OrbitControls.js": "vendor/three/addons/OrbitControls.js",
    "three/addons/RoomEnvironment.js": "vendor/three/addons/RoomEnvironment.js",
    "hl/scene": "js/scene/scene.js",
    "hl/ink": "js/scene/ink.js",
    "hl/urlstate": "js/urlstate.js",
    "hl/studio": "js/scene/studio.js",
    "hl/caption": "js/scene/caption.js",
    "hl/turntable": "js/scene/turntable.js",
    "gifenc": "vendor/gifenc.js",
}

# Keep in step with LANDCOVER_COLOURS in web/js/scene/scene.js.
LANDCOVER_COLOURS = {
    "landuse:farmland": "#C9C08A", "landuse:meadow": "#B5C98A", "landuse:grass": "#B5C98A",
    "landuse:forest": "#6E8B5A", "natural:wood": "#6E8B5A", "natural:scrub": "#8FA06A",
    "natural:heath": "#A8937A", "natural:moor": "#A8937A", "natural:grassland": "#B5C98A",
    "natural:wetland": "#94A9A0", "landuse:residential": "#CFC6B8", "landuse:farmyard": "#C2B49A",
    "landuse:cemetery": "#A9B898", "landuse:allotments": "#B9C08A", "landuse:recreation_ground": "#B5C98A",
    "landuse:commercial": "#C8BFC0", "landuse:retail": "#C8BFC0", "landuse:railway": "#BDB5AA",
    "natural:bare_rock": "#B3ADA4", "natural:scree": "#B3ADA4",
}
LAND_BASE = "#BDB08E"


def web_dir() -> Path:
    d = data_dir().parent / "web"
    if not (d / "viewer.html").exists():
        raise FileNotFoundError("The offline viewer needs a repository checkout (web/viewer.html not found)")
    return d


def _data_url(text: str) -> str:
    return "data:text/javascript;base64," + base64.b64encode(text.encode()).decode()


def landcover_drape(features, bbox, width_px=2048):
    """Land-cover colours as a JPEG data URL covering the model area, north up."""
    from io import BytesIO
    from PIL import Image, ImageDraw
    import math
    mid = (bbox["min_lat"] + bbox["max_lat"]) / 2
    w_m = (bbox["max_lon"] - bbox["min_lon"]) * 111_320 * math.cos(math.radians(mid))
    h_m = (bbox["max_lat"] - bbox["min_lat"]) * 111_320
    H = max(1, round(width_px * h_m / w_m))
    img = Image.new("RGB", (width_px, H), LAND_BASE)
    d = ImageDraw.Draw(img)
    px = lambda lon, lat: ((lon - bbox["min_lon"]) / (bbox["max_lon"] - bbox["min_lon"]) * width_px,  # noqa: E731
                           (bbox["max_lat"] - lat) / (bbox["max_lat"] - bbox["min_lat"]) * H)
    order = ["landuse:residential", "landuse:farmland", "landuse:meadow", "landuse:grass"]
    fs = [f for f in features if f["layer"] == "landcover" and f["kind"] in LANDCOVER_COLOURS]
    fs.sort(key=lambda f: -order.index(f["kind"]) if f["kind"] in order else 1)
    for f in fs:
        g = f["geometry"]
        polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"] if g["type"] == "MultiPolygon" else []
        for rings in polys:
            d.polygon([px(*p) for p in rings[0]], fill=LANDCOVER_COLOURS[f["kind"]])
            for hole in rings[1:]:
                d.polygon([px(*p) for p in hole], fill=LAND_BASE)
    buf = BytesIO(); img.save(buf, "JPEG", quality=85)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def write_viewer(path, *, layer_meshes: dict, opts, preset: dict, features,
                 sources_text: str, disclosure: str, report: dict) -> int:
    from ..paths import load_layers
    layers_meta = load_layers()
    parts, layout, ids, offset = [], {}, [], 0

    def add(key, arr, typ):
        nonlocal offset
        b = arr.tobytes()
        layout[key] = [offset, len(b), typ]; parts.append(b); offset += len(b)

    for lid, m in layer_meshes.items():
        if m is None or not len(m.faces):
            continue
        ids.append(lid)
        add(f"{lid}_p", np.asarray(m.vertices, dtype=np.float32), "float32")
        add(f"{lid}_i", np.asarray(m.faces, dtype=np.uint32), "uint32")
    geom = base64.b64encode(gzip.compress(b"".join(parts), 9)).decode()

    terrain = layer_meshes["terrain"]
    ext = np.asarray(terrain.vertices).max(axis=0)
    name = opts.name or "Terrain model"
    lt = time.localtime(); date = f"{lt.tm_mday} {time.strftime('%B %Y', lt)}"
    caption = {"title": name, "disclosure": disclosure, "sources": sources_text,
               "footer": f"Made {date} with Hyperscale Landscapes",
               "top": f"{name} · {disclosure} · {sources_text.split(';')[0]} and others · {date}"}
    shown = [l for l in ["terrain", "water", "buildings", "roads", "rail", "power", "residues", "receptors"] if l in ids]
    colours = {k: v["colour_screen"] for k, v in layers_meta.items()}
    print_colours = {l: o["colour"] for o in preset["objects"] for l in o["layers"]}
    bb = {"min_lat": opts.min_lat, "max_lat": opts.max_lat, "min_lon": opts.min_lon, "max_lon": opts.max_lon}
    D = {
        "schema": "hyperscale-landscapes/viewer@1", "layers": ids, "layout": layout, "geom": geom,
        "grid": {"Wmm": float(ext[0]), "Hmm": float(ext[1])},
        "colours": colours, "printColours": print_colours,
        "legend": [{"id": l, "name": layers_meta[l]["name"], "colour": layers_meta[l]["colour_screen"],
                    "why": layers_meta[l]["why"]} for l in shown],
        "caption": caption, "zExag": opts.z_exag,
        "sub": (f"{opts.min_lat:.3f}–{opts.max_lat:.3f}°N, {abs(opts.max_lon):.3f}–{abs(opts.min_lon):.3f}°W · "
                f"from the {opts.print_size:g} mm print model (full resolution)"),
        "slug": "".join(c if c.isalnum() else "-" for c in name.lower()).strip("-") or "terrain",
        "alt": (f"Oblique 3D view of a terrain model of {name}. {disclosure}. "
                f"Shows {report.get('buildings', 0)} buildings."),
        "drape": landcover_drape(features or [], bb),
        "drapeKind": "landcover",
    }
    w = web_dir()
    imports = {}
    for spec, rel in MODULES.items():
        text = ((w / rel).read_text().replace("from './caption.js'", "from 'hl/caption'")
                .replace("from './turntable.js'", "from 'hl/turntable'")
                .replace("from './scene.js'", "from 'hl/scene'")
                .replace("from './ink.js'", "from 'hl/ink'"))
        imports[spec] = _data_url(text)
    html = (w / "viewer.html").read_text()
    faces = "".join(
        '@font-face{font-family:"Inter";font-weight:%d;src:url(data:font/woff2;base64,%s) format("woff2")}'
        % (wt, base64.b64encode((w / f"vendor/fonts/inter-latin-{wt}.woff2").read_bytes()).decode())
        for wt in (400, 700))
    html = html.replace("<!--FONTS-->", f"<style>{faces}</style>")
    html = html.replace("<!--IMPORTMAP-->", f'<script type="importmap">{json.dumps({"imports": imports})}</script>')
    html = html.replace("<!--DATA-->", '<script id="terrain-data" type="application/json">'
                        + json.dumps(D, ensure_ascii=False).replace("<", "\\u003c") + "</script>")
    html = html.replace("<!--MAIN-->", '<script type="module">\n' + (w / "js/viewer/main.js").read_text() + "\n</script>")
    Path(path).write_text(html, encoding="utf-8")
    return Path(path).stat().st_size
