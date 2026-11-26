"""tools/georef_drawing.py on a synthetic drawing: the fit recovers a known transform, and a
building drawn as a clipped fill comes back at its true size and place."""
import sys
from pathlib import Path

import numpy as np
import pytest

pymupdf = pytest.importorskip("pymupdf")
pytest.importorskip("cv2")

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
import georef_drawing as G  # noqa: E402

DENOM = 1000
ROT, SCALE, T = 1.5, 1.01, np.array([300000.0, 700000.0])
# an irregular site, in metres (x east, y north): L-shaped with a notch, so the fit is unique
SITE_M = np.array([[0, 0], [420, 0], [420, 140], [300, 140], [300, 320], [140, 320],
                   [140, 260], [60, 260], [60, 120], [0, 120]], float)
BUILDING_M = np.array([[180, 40], [380, 40], [380, 120], [180, 120]], float)   # 200 x 80 m
OFFSET_PT = np.array([400.0, 1300.0])                                           # page origin of (0, 0)


def to_page(xy_m):
    pt = np.asarray(xy_m, float) / (G.PT_M * DENOM)
    return np.c_[pt[:, 0], -pt[:, 1]] + OFFSET_PT


def to_world(xy_m):
    a = np.radians(ROT)
    R = np.array([[np.cos(a), -np.sin(a)], [np.sin(a), np.cos(a)]]) * SCALE
    return np.asarray(xy_m, float) @ R.T + T


@pytest.fixture(scope="module")
def page():
    doc = pymupdf.open()
    p = doc.new_page(width=2384, height=1684)
    # building: grey fill split by a white "rack row" strip, as on Larbert's layout
    b = to_page(BUILDING_M)
    p.draw_rect(pymupdf.Rect(b[:, 0].min(), b[:, 1].min(), b[:, 0].max(), b[:, 1].max()),
                color=None, fill=(0.75, 0.75, 0.75))
    mid = b[:, 0].mean()
    p.draw_rect(pymupdf.Rect(mid - 3, b[:, 1].min(), mid + 3, b[:, 1].max()), color=None, fill=(1, 1, 1))
    # a legend swatch of the same grey, outside the site (must be ignored)
    p.draw_rect(pymupdf.Rect(2200, 100, 2240, 130), color=None, fill=(0.75, 0.75, 0.75))
    # red line
    s = to_page(SITE_M)
    p.draw_polyline([pymupdf.Point(*q) for q in np.vstack([s, s[:1]])], color=(1, 0, 0), width=4)
    # a short red legend sample (the trimmed fit must ignore it)
    p.draw_line(pymupdf.Point(2200, 200), pymupdf.Point(2240, 200), color=(1, 0, 0), width=4)
    return p


def test_red_line_strokes_are_sampled(page):
    P = G.red_line_points(page, {"type": "s", "color": [1, 0, 0], "width": 4})
    assert len(P) > 1000
    assert np.abs(P[:, 0] - OFFSET_PT[0]).min() < 1


def test_fit_recovers_rotation_scale_and_position(page):
    from shapely.geometry import Polygon
    council = G.sample_ring_m(Polygon(to_world(SITE_M)))
    fit = G.fit_points(G.red_line_points(page, {"type": "s", "color": [1, 0, 0], "width": 4}), council, DENOM)
    assert fit.rms < 0.5
    assert fit.rot_deg == pytest.approx(ROT, abs=0.15)
    assert fit.scale == pytest.approx(SCALE, abs=0.003)
    # a page point lands where it should in the world
    corner = fit.page_to_world(to_page(SITE_M[5:6]))[0]
    assert np.hypot(*(corner - to_world(SITE_M[5:6])[0])) < 1.0
    assert "m RMS, rotation 1.5°, scale ×1.01" in fit.statement()


def test_a_fit_beyond_the_search_range_is_not_accepted(page):
    from shapely.geometry import Polygon
    a = np.radians(12)                       # far outside +-4 deg
    R = np.array([[np.cos(a), -np.sin(a)], [np.sin(a), np.cos(a)]])
    council = G.sample_ring_m(Polygon(SITE_M @ R.T + T))
    fit = G.fit_points(G.red_line_points(page, {"type": "s", "color": [1, 0, 0], "width": 4}), council, DENOM)
    assert fit.rms > G.MAX_RMS


def test_clipped_fill_becomes_a_building_of_the_right_size(page):
    from shapely.geometry import Polygon
    council = G.sample_ring_m(Polygon(to_world(SITE_M)))
    fit = G.fit_points(G.red_line_points(page, {"type": "s", "color": [1, 0, 0], "width": 4}), council, DENOM)
    zoom = 2.0
    img = G.render(page, zoom)
    mask = G.colour_mask(img, [[191, 191, 191]], 8)
    px_per_m = zoom / (G.PT_M * DENOM)
    polys = [Polygon(fit.page_to_world(c / zoom)) for c in G.mask_polygons(mask, px_per_m, close_m=6)]
    site = Polygon(to_world(SITE_M))
    polys = [g for g in polys if g.area > 500 and site.contains(g.centroid)]
    assert len(polys) == 1                                   # strip closed over; legend swatch dropped
    g = polys[0].minimum_rotated_rectangle
    truth = Polygon(to_world(BUILDING_M))
    assert g.area == pytest.approx(truth.area, rel=0.02)
    assert g.intersection(truth).area / g.union(truth).area > 0.97
