"""Labels engraved into the underside of the base (PLAN.md §6).

The model is evidence, so the base carries the site name, the vertical
exaggeration, the data attribution, the build date, a north arrow and a
scale bar.  Text is engraved ``ENGRAVE_MM`` deep into the bottom face and
mirrored so it reads correctly when the model is turned over.

At 0.4 mm the engraving sits below the overhang check's 0.5 mm bed
threshold and bridges trivially (the gaps are a few stroke-widths across),
so it never needs supports.

The font is Aileron Regular, embedded in Pillow (dotcolon.net, released
as CC0).  Its limited character set lacks ×, – and accented letters, so
text is folded to safe equivalents first.
"""
from __future__ import annotations

import logging
import textwrap
import unicodedata

import numpy as np
import trimesh
from shapely.affinity import scale as shp_scale, translate
from shapely.geometry import Polygon, box
from shapely.ops import unary_union

log = logging.getLogger(__name__)

ENGRAVE_MM = 0.4
MARGIN_MM = 6.0
NAME_MM = 6.0          # cap height of the title line
TEXT_MM = 3.6          # cap height of the other lines (>= ~0.45 mm strokes)
LINE_GAP = 0.55        # gap between lines, as a fraction of the line height
GROW_MM = 0.06         # thicken strokes slightly so they print cleanly
_PX = 96               # raster size (px) of one font em


def fold(text: str) -> str:
    """Replace characters the embedded font cannot draw."""
    text = (text.replace("×", "x").replace("–", "-").replace("—", "-")
            .replace("‘", "'").replace("’", "'").replace("“", '"').replace("”", '"')
            .replace("²", "2").replace("³", "3").replace("°", " deg"))
    keep = {"©", "·"}
    out = []
    for ch in text:
        if ch in keep or ord(ch) < 128:
            out.append(ch)
        else:
            base = unicodedata.normalize("NFKD", ch).encode("ascii", "ignore").decode()
            out.append(base or "?")
    return "".join(out)


def text_polygon(text: str, cap_mm: float):
    """Outline polygons of ``text`` in mm, baseline-left at the origin."""
    from PIL import Image, ImageDraw, ImageFont
    font = ImageFont.load_default(_PX)
    text = fold(text)
    l, t, r, b = font.getbbox(text)
    w, h = r - l + 4, b - t + 4
    img = Image.new("1", (w, h), 0)
    ImageDraw.Draw(img).text((2 - l, 2 - t), text, font=font, fill=1)
    a = np.array(img, dtype=bool)
    boxes = []
    for y in range(a.shape[0]):
        row = a[y]
        if not row.any():
            continue
        d = np.diff(np.concatenate([[0], row.astype(np.int8), [0]]))
        starts, ends = np.where(d == 1)[0], np.where(d == -1)[0]
        boxes.extend(box(s, h - y - 1, e, h - y) for s, e in zip(starts, ends))
    if not boxes:
        return Polygon()
    g = unary_union(boxes).simplify(0.6)
    cap_px = font.getbbox("H")[3] - font.getbbox("H")[1]
    k = cap_mm / cap_px
    g = shp_scale(g, k, k, origin=(0, 0))
    return g.buffer(GROW_MM, join_style=2) if GROW_MM else g


def north_arrow(size_mm: float):
    s = size_mm
    arrow = Polygon([(0, s), (-0.38 * s, -0.1 * s), (0, 0.12 * s), (0.38 * s, -0.1 * s)])
    n = text_polygon("N", 0.45 * s)
    nb = n.bounds
    n = translate(n, -(nb[0] + nb[2]) / 2, -0.75 * s)
    return unary_union([arrow, n])


def scale_bar(width_m: float, mm_per_m: float, max_mm: float):
    """A bar of a round length (m) no longer than ``max_mm``, with its label."""
    for metres in (2000, 1000, 500, 250, 200, 100, 50, 20, 10):
        if metres * mm_per_m <= max_mm and metres < width_m:
            break
    length = metres * mm_per_m
    bar = unary_union([box(0, 0, length, 1.2), box(0, 0, 0.8, 3.0),
                       box(length - 0.8, 0, length, 3.0)])
    label = text_polygon(f"{metres:g} m" if metres < 1000 else f"{metres / 1000:g} km",
                         TEXT_MM)
    lb = label.bounds
    label = translate(label, length / 2 - (lb[0] + lb[2]) / 2, 3.0 + 1.0)
    return unary_union([bar, label]), metres


def layout(lines_spec, plate_w: float, plate_h: float, mm_per_m: float, width_m: float):
    """Compose the underside label (mm, model coordinates, NOT yet mirrored).

    ``lines_spec`` is a list of (text, cap_mm).  Long lines are wrapped.
    Returns (geometry, report dict) or (None, report) if it cannot fit.
    """
    usable_w = plate_w - 2 * MARGIN_MM
    geoms = []
    y = plate_h - MARGIN_MM
    report = {"lines": []}
    for text, cap in lines_spec:
        # wrap so each line fits the usable width
        g = text_polygon(text, cap)
        if g.is_empty:
            continue
        per_char = (g.bounds[2] - g.bounds[0]) / max(len(fold(text)), 1)
        width_chars = max(10, int(usable_w / per_char))
        for line in textwrap.wrap(text, width_chars) or [text]:
            lg = text_polygon(line, cap)
            lb = lg.bounds
            if lb[2] - lb[0] > usable_w:
                k = usable_w / (lb[2] - lb[0])
                lg = shp_scale(lg, k, k, origin=(0, 0)); lb = lg.bounds
            y -= cap
            geoms.append(translate(lg, plate_w / 2 - (lb[0] + lb[2]) / 2, y - lb[1]))
            report["lines"].append(fold(line))
            y -= cap * LINE_GAP
    # north arrow (bottom-left) and scale bar (bottom-right)
    arrow_mm = 12.0
    na = north_arrow(arrow_mm)
    nb = na.bounds
    geoms.append(translate(na, MARGIN_MM - nb[0] + 1, MARGIN_MM - nb[1]))
    bar, metres = scale_bar(width_m, mm_per_m, max_mm=min(50.0, usable_w * 0.4))
    bb = bar.bounds
    geoms.append(translate(bar, plate_w - MARGIN_MM - bb[2], MARGIN_MM - bb[1]))
    report["scale_bar_m"] = metres
    if y < MARGIN_MM + arrow_mm + 2:
        report["overflow"] = True
        log.warning("Base label does not fit; dropping the text, keeping arrow and scale")
        geoms = geoms[-2:]
    return unary_union(geoms), report


def engrave_cutter(label_mm, w2mm: float, base_bottom: float):
    """Mirror the label for reading from below and extrude it as a cutter
    (world units) that removes ENGRAVE_MM from the bottom of the base."""
    if label_mm is None or label_mm.is_empty:
        return None
    minx, miny, maxx, maxy = label_mm.bounds
    mirrored = shp_scale(label_mm, -1, 1, origin=((minx + maxx) / 2, 0))
    world = shp_scale(mirrored, 1 / w2mm, 1 / w2mm, origin=(0, 0))
    z0 = base_bottom - 1.0 / w2mm
    z1 = base_bottom + ENGRAVE_MM / w2mm
    polys = list(world.geoms) if hasattr(world, "geoms") else [world]
    meshes = []
    for p in polys:
        if p.geom_type != "Polygon" or p.area <= 0:
            continue
        m = trimesh.creation.extrude_polygon(p, z1 - z0)
        m.apply_translation((0, 0, z0))
        meshes.append(m)
    return trimesh.util.concatenate(meshes) if meshes else None
