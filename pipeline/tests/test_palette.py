"""Screen colours must stay distinguishable under common colour-vision
deficiencies (PLAN.md §4).  Simulation: Machado, Oliveira & Fernandes
(2009), severity 1.0; distance: CIEDE2000."""
import math

import numpy as np

from hyperscale_landscapes.paths import load_layers, load_preset

MACHADO = {
    "deuteranopia": [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413],
                     [-0.011820, 0.042940, 0.968881]],
    "protanopia": [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216],
                   [-0.003882, -0.048116, 1.051998]],
    "tritanopia": [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602],
                   [0.004733, 0.691367, 0.303900]],
}
MIN_DE = 10.0   # comfortably distinguishable side by side


def _lin(c):
    c = c / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _lab(rgb_lin):
    m = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722],
                  [0.0193, 0.1192, 0.9505]])
    x, y, z = m @ rgb_lin / np.array([0.95047, 1.0, 1.08883])
    f = lambda t: t ** (1 / 3) if t > 216 / 24389 else (24389 / 27 * t + 16) / 116  # noqa: E731
    fx, fy, fz = f(x), f(y), f(z)
    return 116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)


def ciede2000(lab1, lab2):
    L1, a1, b1 = lab1; L2, a2, b2 = lab2
    C1, C2 = math.hypot(a1, b1), math.hypot(a2, b2)
    Cb = (C1 + C2) / 2
    G = 0.5 * (1 - math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)))
    a1p, a2p = (1 + G) * a1, (1 + G) * a2
    C1p, C2p = math.hypot(a1p, b1), math.hypot(a2p, b2)
    h1p = math.degrees(math.atan2(b1, a1p)) % 360
    h2p = math.degrees(math.atan2(b2, a2p)) % 360
    dLp, dCp = L2 - L1, C2p - C1p
    dh = h2p - h1p
    if C1p * C2p == 0:
        dh = 0
    elif dh > 180:
        dh -= 360
    elif dh < -180:
        dh += 360
    dHp = 2 * math.sqrt(C1p * C2p) * math.sin(math.radians(dh / 2))
    Lbp, Cbp = (L1 + L2) / 2, (C1p + C2p) / 2
    if C1p * C2p == 0:
        hbp = h1p + h2p
    elif abs(h1p - h2p) <= 180:
        hbp = (h1p + h2p) / 2
    else:
        hbp = (h1p + h2p + 360) / 2 if h1p + h2p < 360 else (h1p + h2p - 360) / 2
    T = (1 - 0.17 * math.cos(math.radians(hbp - 30)) + 0.24 * math.cos(math.radians(2 * hbp))
         + 0.32 * math.cos(math.radians(3 * hbp + 6)) - 0.20 * math.cos(math.radians(4 * hbp - 63)))
    dtheta = 30 * math.exp(-(((hbp - 275) / 25) ** 2))
    Rc = 2 * math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7))
    Sl = 1 + 0.015 * (Lbp - 50) ** 2 / math.sqrt(20 + (Lbp - 50) ** 2)
    Sc, Sh = 1 + 0.045 * Cbp, 1 + 0.015 * Cbp * T
    Rt = -math.sin(math.radians(2 * dtheta)) * Rc
    return math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2
                     + Rt * (dCp / Sc) * (dHp / Sh))


def _hex(h):
    return np.array([int(h[i:i + 2], 16) for i in (1, 3, 5)], float)


def _sim(hexcol, matrix):
    lin = _lin(_hex(hexcol))
    return _lab(np.clip(np.array(matrix) @ lin if matrix else lin, 0, 1))


def test_ciede2000_reference_pair():
    # Sharma, Wu & Dalal (2005) test data, pair 1: ΔE00 = 2.0425
    assert abs(ciede2000((50, 2.6772, -79.7751), (50, 0, -82.7485)) - 2.0425) < 1e-3


def test_screen_palette_is_colour_blind_safe():
    layers = load_layers()
    ids = ["terrain", "water", "buildings", "roads", "rail", "power", "residues",
           "receptors"]
    failures = []
    for vision, mat in [("normal", None)] + list(MACHADO.items()):
        labs = {i: _sim(layers[i]["colour_screen"], mat) for i in ids}
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                d = ciede2000(labs[ids[i]], labs[ids[j]])
                if d < MIN_DE:
                    failures.append(f"{vision}: {ids[i]} vs {ids[j]} ΔE00={d:.1f}")
    assert not failures, "\n".join(failures)


def test_print_presets_distinct_under_deuteranopia():
    for pid in ("power-and-place", "residues", "classic"):
        objs = load_preset(pid)["objects"]
        labs = [_sim(o["colour"], MACHADO["deuteranopia"]) for o in objs]
        for i in range(len(objs)):
            for j in range(i + 1, len(objs)):
                d = ciede2000(labs[i], labs[j])
                assert d >= MIN_DE, f"{pid}: {objs[i]['name']} vs {objs[j]['name']} ΔE00={d:.1f}"
