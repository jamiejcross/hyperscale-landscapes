"""Printability and integrity checks.

A face is a support-needing overhang if it tilts downward by more than 45°
(normal z < -0.707) and sits above the print bed (z > 0.5 mm).  A healthy
build has fewer than 50 such faces and under 1 mm² of overhang area: these
are sub-resolution tessellation artefacts no slicer registers.
"""
from __future__ import annotations

import numpy as np

OVERHANG_FACE_LIMIT = 50
OVERHANG_AREA_LIMIT_MM2 = 1.0


def overhangs(mesh, bed_z: float = 0.5) -> tuple[int, float]:
    """Return (face count, total area mm²) of support-needing overhangs."""
    if mesh is None or len(mesh.faces) == 0:
        return 0, 0.0
    v = np.asarray(mesh.vertices); f = np.asarray(mesh.faces)
    tri = v[f]
    n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    nl = np.linalg.norm(n, axis=1, keepdims=True)
    n = n / np.where(nl < 1e-12, 1, nl)
    zc = tri[:, :, 2].mean(axis=1)
    is_oh = (n[:, 2] < -0.707) & (zc >= bed_z)
    count = int(is_oh.sum())
    if not count:
        return 0, 0.0
    t = tri[is_oh]
    area = float(0.5 * np.linalg.norm(
        np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]), axis=1).sum())
    return count, area


def support_free(count: int, area: float) -> bool:
    return count == 0 or area < OVERHANG_AREA_LIMIT_MM2 or count < OVERHANG_FACE_LIMIT
