"""SAM predictor singleton with test injection hook.

Production calls ``_get_predictor()`` lazily on first request. The default
factory imports SAM 2 and downloads the configured checkpoint, which is
deferred until then. Tests call ``set_test_predictor()`` to inject a stub
without ever importing SAM 2 or Torch.

The SAM 3 text-prompt predictor uses a separate, optional factory that the
operator wires at container start when ``SAM_VARIANT=sam3``. The actual
SAM 3 model is gated on Hugging Face and is not loaded here — see
``apps/docs/admin.md`` for the operator setup.
"""

from typing import Any, Callable, Protocol


class SamPredictor(Protocol):
    """Duck type matching the parts of SAM2ImagePredictor we use."""

    def set_image(self, image: Any) -> None: ...

    def predict(
        self,
        point_coords: Any,
        point_labels: Any,
        multimask_output: bool = True,
    ) -> tuple[Any, Any, Any]: ...


# A SAM 3 text-prompt predictor is any callable with this signature. It
# accepts a base64-encoded image plus a free-form text query and returns
# zero or more candidate masks in ``{counts, size, score, bbox}`` form.
TextPredictor = Callable[..., list[dict]]


_PREDICTOR: SamPredictor | None = None
_TEST_PREDICTOR: SamPredictor | None = None
_TEXT_PREDICTOR_FACTORY: TextPredictor | None = None


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


def set_text_predictor(fn: TextPredictor | None) -> None:
    """Register the SAM 3 text-prompt predictor factory.

    Pass ``None`` to clear (used by tests). The operator calls this once at
    container start when ``SAM_VARIANT=sam3``; tests pass a fake.
    """
    global _TEXT_PREDICTOR_FACTORY
    _TEXT_PREDICTOR_FACTORY = fn


def get_text_predictor() -> TextPredictor:
    """Return the registered SAM 3 text predictor.

    Raises ``RuntimeError`` if no factory was registered. Callers should
    convert this into a 503 ``sam3_predictor_not_loaded`` HTTP error.
    """
    if _TEXT_PREDICTOR_FACTORY is None:
        raise RuntimeError("text predictor not configured")
    return _TEXT_PREDICTOR_FACTORY


def reset_text_predictor() -> None:
    """Clear the text predictor factory. Used by tests."""
    global _TEXT_PREDICTOR_FACTORY
    _TEXT_PREDICTOR_FACTORY = None


def extract_embedding(predictor: Any) -> bytes | None:
    """Return the predictor's image embedding as float16 bytes, or None.

    Real SAM 2 predictors store the encoded image features on
    ``_features["image_embed"]`` (a torch.Tensor) after ``set_image()`` runs.
    This helper extracts that tensor, casts it to float16 on CPU, and
    returns its raw bytes. The browser-side ONNX decoder consumes those
    bytes directly via ``Float16Array``.

    Returns ``None`` when the predictor doesn't expose ``_features`` (e.g.
    the test fake) or when the tensor cannot be converted (e.g. torch
    unavailable). Callers treat ``None`` as "fall back to server-side
    decode".
    """
    feats = getattr(predictor, "_features", None)
    if not isinstance(feats, dict):
        return None
    embed = feats.get("image_embed")
    if embed is None:
        return None
    try:
        # torch is only required when a real predictor is loaded; the
        # conditional import keeps test predictors torch-free.
        import torch  # type: ignore[import-not-found]

        return embed.detach().to(dtype=torch.float16, device="cpu").numpy().tobytes()
    except Exception:
        # Best-effort fallback for predictors whose tensor mimics the API
        # but doesn't need torch (used by tests).
        try:
            arr = embed.detach().to(dtype="float16", device="cpu").numpy()
            return arr.tobytes()
        except Exception:
            return None
