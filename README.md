# Hyperscale Landscapes

**See, hold and share the landscape that a proposed data centre would be fused to.**

Planning documents reduce proposed data-centre sites to red lines and grid
references. This toolkit turns a site into evidence people can hold and share:

- **3D-printable models.** These are multi-colour terrain models showing rivers,
  power lines and substations, old mines and bings, homes and schools. A
  removable block shows the proposed building wherever its footprint is
  known.
- **Digital artefacts.** These are rotating GIFs, landscape images, cross-sections and
  interactive 3D viewers, sized for Facebook, WhatsApp, slides and
  leaflets.

Every model and image states its data sources and its vertical
exaggeration, because these are used as evidence.

> **Status: early development (Phase 3 of 7).** The browser app and the Python
> command-line tool both build multi-colour print files with power, residue and
> receptor layers. The digital artefacts (GIFs, images, viewers)
> and the beginners' guides are still to come. See [PLAN.md](PLAN.md).

## For organisers

You don't need to install anything. Open the web app, pick a curated site or
draw an area, preview it in 3D, and download a print file. It all runs in
your browser. The browser's print files are lower resolution than the
command-line tool's. For exhibitions or planning hearings, ask a maker or
researcher to run the command-line tool.

To run the web app locally: `python3 -m http.server --directory web`, then open
<http://localhost:8000>.

## For technical users

```bash
pip install -e "pipeline[uk]"          # from a checkout; Python 3.10+
hyperscale sites list
hyperscale build --site auchtertool-cato
hyperscale build --min_lat 56.0916 --max_lat 56.1064 --min_lon -3.3054 --max_lon -3.2457 --stl
```

### Presets, layers and the insert

```bash
hyperscale build --site auchtertool-cato --preset residues
hyperscale build --polygon proposal.geojson --footprint proposal.geojson \
                 --insert_height_m 24 --insert_height_source "Planning statement, p. 12" \
                 --footprint_precision "digitised from images" --planning_ref 25/01234/EIA
```

| Preset | Filament slots |
|---|---|
| `power-and-place` (default) | Land · Water · Power, roads and rail · Buildings |
| `residues` | Land · Water · Industrial residues · Buildings, roads and rail |
| `full` | up to eight objects |
| `classic` | Land · Water · Roads · Buildings (the original layout) |
| `single-colour` | one watertight STL |

A proposed facility is printed as a **separate, removable block**, at true height by
default. It sits in a recess with 0.2 mm clearance and optional 6 × 2 mm magnet holes.
The underside of the base is engraved with the site name, the height exaggeration,
the data sources, the date, a north arrow and a scale bar. Turn the model over to
read them.

Outputs go to `./output/`:

- `terrain_*.3mf`: one object each for Land, Water, Roads and Buildings, pre-assigned to filament slots 1–4
- `terrain_*.stl`: with `--stl`, a single watertight body for one-colour printing
- `insert_*.stl`: the removable data-centre block, when a footprint is given
- `features_*.geojson`: power, rail, residues, receptors and land cover, for the viewer
- `manifest_*.json`: statistics, printability check, pause heights for single-extruder colour changes, and full data provenance

Downloads are cached in your user cache folder (`~/.cache/hyperscale-landscapes`
on Linux, `~/Library/Caches/hyperscale-landscapes` on macOS).

Defaults: 150 mm print, terrain height ×2, buildings at true height, 5 mm
base. The models are designed to print **without supports**.

## Data and licences

Map data © OpenStreetMap contributors (ODbL). Elevation, coastline and other
sources are listed with their licences in [DATA_LICENCES.md](DATA_LICENCES.md).
Curated site data is CC BY 4.0. The code is GPL-3.0-or-later.

## Credits

Jamie Cross (University of Glasgow) and Alex Nading (Cornell University).
See [CITATION.cff](CITATION.cff).
