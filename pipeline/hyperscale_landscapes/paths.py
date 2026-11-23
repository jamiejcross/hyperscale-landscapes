"""Locate the shared ``data/`` folder (layers, presets, sites)."""
from __future__ import annotations

import json
import os
from pathlib import Path


def data_dir() -> Path:
    env = os.environ.get("HYPERSCALE_DATA")
    if env:
        return Path(env)
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "data" / "layers.json").is_file():
            return parent / "data"
    return Path.cwd() / "data"


def load_preset(preset_id: str) -> dict:
    path = data_dir() / "presets" / f"{preset_id}.json"
    if not path.exists():
        known = sorted(p.stem for p in (data_dir() / "presets").glob("*.json"))
        raise ValueError(f"Unknown preset '{preset_id}'. Known: {', '.join(known)}")
    return json.loads(path.read_text())


def load_layers() -> dict:
    return {l["id"]: l for l in json.loads((data_dir() / "layers.json").read_text())["layers"]}
