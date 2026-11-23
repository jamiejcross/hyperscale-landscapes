"""Multi-object 3MF writer.

Ported from ElchoMaps' ``export_3mf`` (bulk string formatting, 4-decimal
coordinates, every part a component of one parent so the slicer keeps the
parts locked together).  Additions:

- 3MF core ``<metadata>`` carrying title, attribution, licence and the
  vertical-exaggeration disclosure, so the file is self-describing even
  when it is forwarded on its own.
- Optional Bambu Studio ``Metadata/model_settings.config`` that assigns each
  part to a filament slot (1-based), so colours land on AMS slots without
  manual assignment.  Bambu's format is undocumented: keep it minimal and
  re-test when Bambu Studio updates (PLAN.md §6, §12).
- Optional separate build items (e.g. the removable data-centre insert),
  placed beside the main model rather than inside it.
"""
from __future__ import annotations

import logging
import zipfile
from dataclasses import dataclass
from pathlib import Path
from xml.sax.saxutils import escape, quoteattr

import numpy as np

log = logging.getLogger(__name__)

_CONTENT_TYPES_XML = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType='
    '"application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="model" ContentType='
    '"application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>'
    '<Default Extension="config" ContentType="text/xml"/>'
    '</Types>'
)

_RELS_XML = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Target="/3D/3dmodel.model" Id="rel0" '
    'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>'
    '</Relationships>'
)


@dataclass
class Part:
    name: str
    mesh: object          # trimesh.Trimesh, already in print millimetres
    colour: str           # "#RRGGBB"
    slot: int             # 1-based filament slot


def _mesh_xml(mesh) -> str:
    v = np.asarray(mesh.vertices, dtype=np.float64)
    f = np.asarray(mesh.faces, dtype=np.int64)
    return ('<mesh><vertices>'
            + '\n'.join('<vertex x="%.4f" y="%.4f" z="%.4f"/>' % (x, y, z)
                        for x, y, z in v)
            + '</vertices><triangles>'
            + '\n'.join('<triangle v1="%d" v2="%d" v3="%d"/>' % (a, b, c)
                        for a, b, c in f)
            + '</triangles></mesh>')


def export_3mf(path, parts: list[Part], *, title: str = "Terrain",
               metadata: dict | None = None,
               separate: list[Part] | None = None,
               bambu: bool = True) -> dict:
    """Write ``parts`` as components of one parent object, plus any
    ``separate`` parts as their own build items.  Returns per-object ids."""
    parts = [p for p in parts if p.mesh is not None and len(p.mesh.faces)]
    separate = [p for p in (separate or []) if p.mesh is not None and len(p.mesh.faces)]
    all_parts = parts + separate
    # One base material per distinct slot, in slot order.
    slots = sorted({p.slot for p in all_parts})
    slot_index = {s: i for i, s in enumerate(slots)}
    slot_colour = {}
    for p in all_parts:
        slot_colour.setdefault(p.slot, (p.name, p.colour))

    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<model unit="millimeter" xml:lang="en-GB" '
           'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" '
           'xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">']
    meta = {"Title": title, **(metadata or {})}
    for k, v in meta.items():
        out.append(f'<metadata name={quoteattr(str(k))}>{escape(str(v))}</metadata>')
    out.append('<resources><basematerials id="1">')
    for s in slots:
        name, colour = slot_colour[s]
        out.append(f'<base name={quoteattr(name)} displaycolor="{colour}"/>')
    out.append('</basematerials>')

    ids: dict[str, int] = {}
    oid = 2
    for p in all_parts:
        out.append(f'<object id="{oid}" type="model" name={quoteattr(p.name)} '
                   f'pid="1" pindex="{slot_index[p.slot]}">')
        out.append(_mesh_xml(p.mesh))
        out.append('</object>')
        ids[p.name] = oid
        oid += 1

    parent_id = None
    if parts:
        parent_id = oid
        out.append(f'<object id="{parent_id}" type="model" name={quoteattr(title)}>'
                   '<components>')
        for p in parts:
            out.append(f'<component objectid="{ids[p.name]}"/>')
        out.append('</components></object>')
    out.append('</resources><build>')
    if parent_id is not None:
        out.append(f'<item objectid="{parent_id}"/>')
    # Separate items sit beside the main model on +x with a 10 mm gap.
    if separate:
        main_x = max((float(np.asarray(p.mesh.vertices)[:, 0].max()) for p in parts),
                     default=0.0)
        x = main_x + 10.0
        for p in separate:
            vmin = np.asarray(p.mesh.vertices).min(axis=0)
            dx, dy, dz = x - vmin[0], -vmin[1], -vmin[2]
            out.append(f'<item objectid="{ids[p.name]}" '
                       f'transform="1 0 0 0 1 0 0 0 1 {dx:.4f} {dy:.4f} {dz:.4f}"/>')
            x += float(np.ptp(np.asarray(p.mesh.vertices)[:, 0])) + 10.0
    out.append('</build></model>')

    with zipfile.ZipFile(str(path), 'w', zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('[Content_Types].xml', _CONTENT_TYPES_XML)
        zf.writestr('_rels/.rels', _RELS_XML)
        zf.writestr('3D/3dmodel.model', '\n'.join(out))
        if bambu:
            zf.writestr('Metadata/model_settings.config',
                        _bambu_settings(parent_id, parts, separate, ids, title))
    log.info("Exported 3MF -> %s (%.2f MB)", path, Path(path).stat().st_size / 1e6)
    return ids


def _bambu_settings(parent_id, parts, separate, ids, title) -> str:
    """Per-part filament assignment for Bambu Studio / OrcaSlicer."""
    x = ['<?xml version="1.0" encoding="UTF-8"?>', '<config>']
    if parent_id is not None:
        x.append(f'  <object id="{parent_id}">')
        x.append(f'    <metadata key="name" value={quoteattr(title)}/>')
        x.append(f'    <metadata key="extruder" value="{parts[0].slot}"/>')
        for p in parts:
            x.append(f'    <part id="{ids[p.name]}" subtype="normal_part">')
            x.append(f'      <metadata key="name" value={quoteattr(p.name)}/>')
            x.append(f'      <metadata key="extruder" value="{p.slot}"/>')
            x.append('    </part>')
        x.append('  </object>')
    for p in separate:
        x.append(f'  <object id="{ids[p.name]}">')
        x.append(f'    <metadata key="name" value={quoteattr(p.name)}/>')
        x.append(f'    <metadata key="extruder" value="{p.slot}"/>')
        x.append('  </object>')
    x.append('</config>')
    return '\n'.join(x)
