"""
Plan 11 / Task 1 smoke test: verifies that the native `sam3` git package is
importable inside the model container. This is required for SAM 3.1's Object
Multiplex multi-object joint tracker, which the transformers `Sam3VideoModel`
cannot load (the `facebook/sam3.1` Hub repo ships only `sam3.1_multiplex.pt`,
no `model.safetensors`).

The test is gated on the `SAM3P1_AVAILABLE` env var so it skips cleanly in
environments where the package has not been installed (e.g. CPU-only CI,
local dev without the [gpu] extras).

Notes for later tasks:
- Production code paths must NOT import sam3 at module top-level. They should
  attempt the import lazily and fall back to the existing transformers paths
  if it fails.
- This smoke test only verifies that the import is reachable; it does not
  load the multiplex predictor (which would download multi-GB checkpoints).
"""

from __future__ import annotations

import os

import pytest


@pytest.mark.skipif(
    os.environ.get("SAM3P1_AVAILABLE", "1") == "0",
    reason="sam3.1 not installed",
)
def test_sam3_model_builder_import() -> None:
    """The native sam3 package exposes `build_sam3_multiplex_video_predictor`."""
    # Arrange / Act
    from sam3.model_builder import build_sam3_multiplex_video_predictor

    # Assert
    assert callable(build_sam3_multiplex_video_predictor)
