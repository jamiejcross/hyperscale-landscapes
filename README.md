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

> **Status: early development (Phase 1 of 7).** The Python command-line tool
> builds multi-colour print files. The browser app, the new layers and the
> beginners' guides are still to come. See [PLAN.md](PLAN.md).

## For organisers

You will not need to install anything. The browser app (coming in Phase 3)
will run entirely in your browser. Until then, ask a maker or researcher to
run the command-line tool for you.

## For technical users

```bash
pip install -e "pipeline[uk]"          # from a checkout; Python 3.10+
hyperscale sites list
hyperscale build --site auchtertool-cato
hyperscale build --min_lat 56.0916 --max_lat 56.1064 --min_lon -3.3054 --max_lon -3.2457 --stl
```

Outputs go to `./output/`:

- `terrain_*.3mf`: one object each for Land, Water, Roads and Buildings, pre-assigned to filament slots 1–4
- `terrain_*.stl`: with `--stl`, a single watertight body for one-colour printing
- `manifest_*.json`: statistics, printability check, and full data provenance

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
