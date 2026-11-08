# Armin Mehri — mehri.armin@gmail.com
"""The AI-image, watermark and keyword (off-topic) filters, run by the
model service.

Images are shrunk to 768 px before they are sent: both classifiers look
at 256–336 px, so the full file would only cost transfer time. Not
smaller: at 512 px the extra resampling pushed a real photo to 0.895 on
the AI detector (0.18 at most at 768 px or at full size; 2026-11-07).
"""

from __future__ import annotations

import base64
import io

import httpx
from PIL import Image

from carve_api.config import get_settings

SEND_SIDE = 768


class FiltersUnavailable(Exception):
    """The model service could not score the images (down, restarting,
    no GPU). The run waits; it never adds unfiltered images."""


def _small_jpeg(body: bytes) -> str:
    with Image.open(io.BytesIO(body)) as im:
        im = im.convert("RGB")
        im.thumbnail((SEND_SIDE, SEND_SIDE))
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=90)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def score(
    bodies: list[bytes], checks: list[str], keywords: list[str] | None = None
) -> list[dict[str, float]]:
    """One ``{"ai": p, "watermark": p, "relevance": cos}`` per image (only
    the asked checks). ``keywords``: each image's keyword, for "relevance"."""
    if not bodies or not checks:
        return [{} for _ in bodies]
    s = get_settings()
    payload: dict = {"images": [_small_jpeg(b) for b in bodies], "checks": checks}
    if "relevance" in checks:
        payload["texts"] = list(keywords or [])
    try:
        with httpx.Client(base_url=s.model_base_url, timeout=120.0) as c:
            r = c.post("/quality/score", json=payload)
    except httpx.HTTPError as exc:
        raise FiltersUnavailable(f"model service unreachable ({type(exc).__name__})") from exc
    if r.status_code != 200:
        raise FiltersUnavailable(f"model service answered {r.status_code}: {r.text[:200]}")
    scores = r.json().get("scores")
    if not isinstance(scores, list) or len(scores) != len(bodies):
        raise FiltersUnavailable("model service sent an unexpected answer")
    # An older model service ignores checks it does not know; never let
    # that pass images unchecked.
    if any(c not in sc for sc in scores for c in checks):
        raise FiltersUnavailable("model service does not know every check (needs an update)")
    return scores
