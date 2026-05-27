# Armin Mehri — mehri.armin@gmail.com
"""Plans which frame timestamps to extract for the mixed-upload video flow.

Pure function over ``(mode, n_or_k, frame_count, fps, duration_s)`` that
returns an ordered list of timestamps in seconds. Kept separate from the
worker entry point so it can be unit-tested without ffmpeg, Redis, or
the DB.
"""
from __future__ import annotations

from typing import Literal


ExtractMode = Literal["auto", "all", "every_nth", "count"]
_AUTO_CAP = 500


def compute_extraction_timestamps(
    *,
    mode: ExtractMode,
    n_or_k: int,
    frame_count: int,
    fps: float,
    duration_s: float,
) -> list[float]:
    """Return an ordered list of timestamps (seconds) to extract.

    Modes:
      ``all``        — every frame (frame_count timestamps).
      ``every_nth``  — frame indices 0, N, 2N, …, clipped to last frame.
      ``count``      — n_or_k evenly-spaced timestamps in [0, duration_s].
                       Collapses to ``all`` if n_or_k >= frame_count.
      ``auto``       — ``all`` if frame_count <= 500, else 500 evenly-spaced.

    Raises ``ValueError`` for non-positive frame_count / fps.
    """
    if frame_count <= 0:
        raise ValueError("frame_count must be > 0")
    if fps <= 0:
        raise ValueError("fps must be > 0")

    if mode == "all":
        return [i / fps for i in range(frame_count)]

    if mode == "every_nth":
        step = max(1, int(n_or_k))
        return [i / fps for i in range(0, frame_count, step)]

    if mode == "count":
        k = max(1, int(n_or_k))
        if k >= frame_count:
            return [i / fps for i in range(frame_count)]
        if k == 1:
            return [0.0]
        spacing = duration_s / (k - 1)
        return [i * spacing for i in range(k)]

    if mode == "auto":
        if frame_count <= _AUTO_CAP:
            return [i / fps for i in range(frame_count)]
        spacing = duration_s / (_AUTO_CAP - 1)
        return [i * spacing for i in range(_AUTO_CAP)]

    raise ValueError(f"unknown mode: {mode!r}")
