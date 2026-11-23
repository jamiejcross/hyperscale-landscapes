"""Data providers: one module per layer, each with a global fallback.

Every provider exposes ``fetch(bbox, cache_dir, **kwargs) -> ProviderResult``.
It tries its sources in priority order and returns the first success; the
``source`` field names what was actually used, and ``provenance()`` turns
that into the licence and attribution text recorded in the manifest and
printed on every export.

Ported from ElchoMaps (``elcho-maps/scripts/providers``).
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, NamedTuple

from .. import __version__


class BBox(NamedTuple):
    min_lat: float
    max_lat: float
    min_lon: float
    max_lon: float


@dataclass
class ProviderResult:
    """Standard return type for all providers."""
    data: Any                        # provider-specific payload
    source: str = "unknown"          # e.g. "copernicus-30m", "osm-overpass"
    cached: bool = False             # True if served from cache
    metadata: dict = field(default_factory=dict)  # extra info for manifest


def default_cache_dir() -> Path:
    """Per-user cache, outside the repository (PLAN.md D8).

    Override with the HYPERSCALE_CACHE environment variable (tests use this
    to point at offline fixtures).
    """
    env = os.environ.get("HYPERSCALE_CACHE")
    if env:
        return Path(env)
    try:
        from platformdirs import user_cache_dir
        return Path(user_cache_dir("hyperscale-landscapes"))
    except ImportError:  # pragma: no cover
        return Path.home() / ".cache" / "hyperscale-landscapes"


DEFAULT_CACHE = default_cache_dir()

# A polite, generic client identifier. It names the project, never the user.
USER_AGENT = (f"hyperscale-landscapes/{__version__} "
              "(+https://github.com/jamiejcross/hyperscale-landscapes)")


def offline() -> bool:
    """True when network access is forbidden (CI and tests).

    Providers must then serve from cache or raise, never fetch.
    """
    return os.environ.get("HYPERSCALE_OFFLINE", "") not in ("", "0", "false")


class OfflineError(RuntimeError):
    """Raised when a provider would need the network in offline mode."""


def require_online(what: str) -> None:
    if offline():
        raise OfflineError(f"HYPERSCALE_OFFLINE is set and {what} is not cached")


# ---------------------------------------------------------------------------
# Shared Overpass client: mirrors, retry rounds, exponential backoff.
# Overpass public servers regularly return 504 under load; one pass over
# the mirrors is not enough resilience for a pipeline step that runs after
# minutes of other fetching.
# ---------------------------------------------------------------------------

OVERPASS_MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]


def overpass_query(query: str, timeout: int = 240, rounds: int = 3):
    """POST a query to Overpass, trying every mirror up to `rounds` times.

    Waits 10 s, then 20 s between rounds.  Raises RuntimeError only after
    every mirror has failed in every round.
    """
    import json
    import logging
    import time
    import urllib.parse
    import urllib.request

    require_online("an Overpass query")
    log = logging.getLogger(__name__)
    data = urllib.parse.urlencode({"data": query}).encode()
    headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
    }

    last_err = None
    for rnd in range(rounds):
        for url in OVERPASS_MIRRORS:
            try:
                log.info("Overpass query via %s (round %d/%d)",
                         url, rnd + 1, rounds)
                req = urllib.request.Request(url, data=data, headers=headers)
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    return json.loads(resp.read())
            except Exception as e:
                last_err = e
                log.warning("Mirror failed: %s", e)
                time.sleep(2)
        if rnd < rounds - 1:
            wait = 10 * (rnd + 1)
            log.info("All mirrors failed; retrying in %d s...", wait)
            time.sleep(wait)

    raise RuntimeError(
        f"All Overpass mirrors failed after {rounds} rounds; "
        f"last error: {last_err}")
