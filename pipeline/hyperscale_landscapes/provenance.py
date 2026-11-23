"""Data provenance: map each provider ``source`` id to its licence and
attribution text.

Every manifest records the full provenance, and every export prints the
short attribution.  ``status`` says whether the licence wording has been
checked against the publisher's own licence page; anything still
``"to verify"`` is listed in DATA_LICENCES.md for review before release.
"""
from __future__ import annotations

SOURCES: dict[str, dict] = {
    "osm-overpass": {
        "name": "OpenStreetMap (via the Overpass API)",
        "licence": "ODbL-1.0",
        "attribution": "© OpenStreetMap contributors",
        "url": "https://www.openstreetmap.org/copyright",
        "status": "verified",
    },
    "srtm-30m": {
        "name": "SRTM 1 arc-second (via AWS Terrain Tiles, 'skadi')",
        "licence": "Public domain (NASA/USGS)",
        "attribution": "Elevation: NASA/USGS SRTM",
        "url": "https://registry.opendata.aws/terrain-tiles/",
        "status": "to verify",
    },
    "copernicus-30m": {
        "name": "Copernicus DEM GLO-30",
        "licence": "Copernicus DEM licence (free, attribution required)",
        "attribution": ("Elevation: Copernicus DEM GLO-30 © DLR e.V. 2010–2014 "
                        "and © Airbus Defence and Space GmbH 2014–2018, provided "
                        "under COPERNICUS by the European Union and ESA"),
        "url": "https://registry.opendata.aws/copernicus-dem/",
        "status": "to verify",
    },
    "scottish-lidar": {
        "name": "Scottish Public Sector LiDAR (Scottish Remote Sensing Portal)",
        "licence": "OGL-UK-3.0",
        "attribution": ("Elevation: Scottish Government LiDAR. Contains public "
                        "sector information licensed under the Open Government "
                        "Licence v3.0"),
        "url": "https://remotesensingdata.gov.scot/",
        "status": "to verify",
    },
    "gshhg": {
        "name": "GSHHG shoreline database (Wessel & Smith)",
        "licence": "LGPL-3.0",
        "attribution": "Coastline: GSHHG (Wessel & Smith)",
        "url": "https://www.soest.hawaii.edu/pwessel/gshhg/",
        "status": "to verify",
    },
    "overture-maps": {
        "name": "Overture Maps Foundation",
        "licence": "Mixed (ODbL-1.0 / CDLA-Permissive-2.0, by theme)",
        "attribution": "© Overture Maps Foundation; © OpenStreetMap contributors",
        "url": "https://docs.overturemaps.org/attribution/",
        "status": "to verify",
    },
    "none": {
        "name": "No features in this area",
        "licence": None, "attribution": "", "url": None, "status": "n/a",
    },
}


def lookup(source: str) -> dict:
    """Resolve a provider source id (prefix match: 'scottish-lidar-phase-3')."""
    if source in SOURCES:
        return {"id": source, **SOURCES[source]}
    for key, val in SOURCES.items():
        if source.startswith(key):
            return {"id": source, **val}
    if source.startswith("osm"):
        return {"id": source, **SOURCES["osm-overpass"]}
    return {"id": source, "name": source, "licence": None, "attribution": source,
            "url": None, "status": "unknown"}


def attribution_line(sources: dict[str, str]) -> str:
    """Short, de-duplicated attribution string for captions and the 3MF."""
    seen, parts = set(), []
    for src in sources.values():
        text = lookup(src).get("attribution") or ""
        if text and text not in seen:
            seen.add(text); parts.append(text)
    return "; ".join(parts)
