"""Single-colour path: boolean-union every solid into one watertight body.

Ported from ``scripts/build_terrain.py``.  Two hard-won rules:

1. Slabs must have CCW exterior and CW interior rings or manifold3d
   returns zero triangles (``slab_from_poly`` enforces this with ``orient``).
2. The union can leave sub-mm³ sliver bodies at intersection edges.  Keep
   the largest body plus any body of at least 1 mm³; discard the rest.

Do not change this logic without re-running the geometry tests.
"""
from __future__ import annotations

import logging

import numpy as np
import trimesh

log = logging.getLogger(__name__)

SLIVER_MIN_VOLUME_MM3 = 1.0


def _to_manifold(tm):
    import manifold3d as m3d
    return m3d.Manifold(m3d.Mesh(np.asarray(tm.vertices, dtype=np.float32),
                                 np.asarray(tm.faces, dtype=np.uint32)))


def union_solids(base: trimesh.Trimesh, extras: list[trimesh.Trimesh]):
    """Union ``base`` with every mesh in ``extras``; return (mesh, stats)."""
    import manifold3d as m3d

    mf_base = _to_manifold(base)
    parts, rejected = [], 0
    for m in extras:
        if m is None or len(m.faces) == 0:
            continue
        # Concatenated objects hold many shells: union each shell.
        for shell in m.split(only_watertight=False):
            try:
                mf = _to_manifold(shell)
                if mf.num_tri() > 0:
                    parts.append(mf)
                else:
                    rejected += 1
            except Exception:
                rejected += 1
    log.info("Union: 1 base + %d shells (%d rejected by manifold3d)",
             len(parts), rejected)
    final = (mf_base + m3d.Manifold.batch_boolean(parts, m3d.OpType.Add)
             if parts else mf_base)
    md = final.to_mesh()
    tm = trimesh.Trimesh(vertices=np.asarray(md.vert_properties[:, :3]),
                         faces=np.asarray(md.tri_verts), process=True)
    tm.merge_vertices()

    bodies = sorted(tm.split(only_watertight=False), key=lambda b: -len(b.faces))
    keep, discarded = [], 0
    for b in bodies:
        if not keep or abs(b.volume) >= SLIVER_MIN_VOLUME_MM3:
            keep.append(b)
        else:
            discarded += 1
    out = trimesh.util.concatenate(keep) if len(keep) > 1 else keep[0]
    log.info("Union: kept %d body/bodies, discarded %d slivers; watertight=%s",
             len(keep), discarded, out.is_watertight)
    return out, {"bodies": len(keep), "slivers_discarded": discarded,
                 "shells_rejected": rejected,
                 "watertight": bool(out.is_watertight)}


def subtract(base: trimesh.Trimesh, cutter: trimesh.Trimesh) -> trimesh.Trimesh:
    """Boolean difference (used for the data-centre recess, Phase 2)."""
    md = (_to_manifold(base) - _to_manifold(cutter)).to_mesh()
    return trimesh.Trimesh(vertices=np.asarray(md.vert_properties[:, :3]),
                           faces=np.asarray(md.tri_verts), process=True)
