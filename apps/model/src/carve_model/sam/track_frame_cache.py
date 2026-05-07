# Armin Mehri — mehri.armin@gmail.com
"""Asset-hash-keyed JPEG frame cache for the SAM 3.1 track session.

Each tracking session needs the full per-frame JPEG sequence on local disk
so the native multiplex predictor's ``start_session`` can read them. We
key by ``Asset.xxh3_128`` so subsequent sessions on the same video reuse
the same cache directory.
"""
from __future__ import annotations

import logging
import urllib.parse
from pathlib import Path

import httpx

logger = logging.getLogger(__name__)

_CACHE_ROOT = "/tmp/sam-frames"
_DOWNLOAD_TIMEOUT_S = 30.0


def cache_dir(asset_hash: str) -> Path:
    """Return the on-disk directory used to cache one asset's frames."""
    return Path(_CACHE_ROOT) / asset_hash


def ensure_cached(asset_hash: str, frame_urls: list[str]) -> Path:
    """Download each presigned URL into ``cache_dir(asset_hash)`` if missing.

    Filenames are zero-padded ``%06d.jpg`` so ``int(stem)`` sort order
    matches index order — the SAM 3.1 native predictor relies on this.

    Raises ``ValueError`` when any URL is not http(s) (blocks SSRF abuse).
    Raises ``RuntimeError`` when a download fails (caller decides whether to retry).
    """
    for url in frame_urls:
        scheme = urllib.parse.urlparse(url).scheme
        if scheme not in ("http", "https"):
            raise ValueError(f"frame_url_scheme_not_allowed: {scheme!r}")

    cdir = cache_dir(asset_hash)
    cdir.mkdir(parents=True, exist_ok=True)

    targets = [(cdir / f"{i:06d}.jpg", url) for i, url in enumerate(frame_urls)]
    missing = [(p, u) for (p, u) in targets if not p.exists()]
    if not missing:
        return cdir

    with httpx.Client(timeout=_DOWNLOAD_TIMEOUT_S) as client:
        for path, url in missing:
            try:
                resp = client.get(url)
                resp.raise_for_status()
                path.write_bytes(resp.content)
            except Exception as exc:  # noqa: BLE001
                raise RuntimeError(f"frame_cache_failed: {exc!r}") from exc

    return cdir
