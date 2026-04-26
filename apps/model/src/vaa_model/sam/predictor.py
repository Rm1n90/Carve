"""SAM predictor singleton with test injection hook.

Production calls ``_get_predictor()`` lazily on first request. The default
factory imports SAM 2 and downloads the configured checkpoint, which is
deferred until then. Tests call ``set_test_predictor()`` to inject a stub
without ever importing SAM 2 or Torch.
"""

from typing import Any, Protocol


class SamPredictor(Protocol):
    """Duck type matching the parts of SAM2ImagePredictor we use."""

    def set_image(self, image: Any) -> None: ...

    def predict(
        self,
        point_coords: Any,
        point_labels: Any,
        multimask_output: bool = True,
    ) -> tuple[Any, Any, Any]: ...


_PREDICTOR: SamPredictor | None = None
_TEST_PREDICTOR: SamPredictor | None = None


def set_test_predictor(p: SamPredictor | None) -> None:
    """Inject a stub for tests; pass None to clear."""
    global _TEST_PREDICTOR
    _TEST_PREDICTOR = p
    # Reset the production singleton too so subsequent tests don't see a stale state
    _reset_singleton()


def _reset_singleton() -> None:
    global _PREDICTOR
    _PREDICTOR = None


def _default_factory() -> SamPredictor:
    """Production factory: load SAM 2 from Hugging Face. Imports lazy."""
    import torch  # type: ignore[import-not-found]
    from sam2.sam2_image_predictor import SAM2ImagePredictor  # type: ignore[import-not-found]

    p = SAM2ImagePredictor.from_pretrained("facebook/sam2-hiera-large")
    p.model.to("cuda" if torch.cuda.is_available() else "cpu")
    return p


def get_predictor() -> SamPredictor:
    """Return the active predictor: test-injected if set, otherwise the lazily
    loaded production singleton."""
    global _PREDICTOR
    if _TEST_PREDICTOR is not None:
        return _TEST_PREDICTOR
    if _PREDICTOR is None:
        _PREDICTOR = _default_factory()
    return _PREDICTOR
