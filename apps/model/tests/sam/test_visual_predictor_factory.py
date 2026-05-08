"""Tests for the visual predictor factory registry.

Tests the module-level singleton registry for the SAM 3.1 visual-prompt
predictor, mirroring the existing text/box predictor registries.
"""

import pytest
from carve_model.sam.predictor import (
    get_visual_predictor,
    set_visual_predictor,
    _reset_visual_predictor_for_test,
)


def test_get_visual_predictor_raises_when_unset():
    """Raises RuntimeError when factory is not registered."""
    _reset_visual_predictor_for_test()
    with pytest.raises(RuntimeError, match="not_loaded"):
        get_visual_predictor()


def test_set_then_get_visual_predictor():
    """Can set and retrieve a visual predictor factory."""
    _reset_visual_predictor_for_test()
    sentinel = object()
    set_visual_predictor(sentinel)
    assert get_visual_predictor() is sentinel
    _reset_visual_predictor_for_test()
