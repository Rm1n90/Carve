"""SAM predictor singleton with test injection hook.

Production calls ``_get_predictor()`` lazily on first request. The default
factory imports SAM 2 and downloads the configured checkpoint, which is
deferred until then. Tests call ``set_test_predictor()`` to inject a stub
without ever importing SAM 2 or Torch.

The SAM 3 text-prompt predictor uses a separate, optional factory that the
operator wires at container start when ``SAM_MODEL=sam3`` (or the legacy
``SAM_VARIANT=sam3`` from Plan 08). The actual SAM 3 model is gated on
Hugging Face and is not loaded here — see ``apps/docs/admin.md`` for the
operator setup.
"""

import logging
import os
from typing import Any, Callable, Protocol

log = logging.getLogger(__name__)


# Allowed values for SAM_MODEL. Keep this in lockstep with the README and
# the .env.example. Order matches the size progression for readability.
ALLOWED_SAM_MODELS = (
    "sam2.1-tiny",
    "sam2.1-small",
    "sam2.1-base-plus",
    "sam2.1-large",
    "sam3",
)
DEFAULT_SAM_MODEL = "sam2.1-large"

# Hugging Face repo ids for each variant. The four sam2.1 entries follow
# the canonical naming on HF; sam3 is a separate (gated) repo whose
# weights are loaded by the operator-registered SAM 3 text predictor.
_HF_REPO_BY_MODEL = {
    "sam2.1-tiny":      "facebook/sam2.1-hiera-tiny",
    "sam2.1-small":     "facebook/sam2.1-hiera-small",
    "sam2.1-base-plus": "facebook/sam2.1-hiera-base-plus",
    "sam2.1-large":     "facebook/sam2.1-hiera-large",
    "sam3":             "facebook/sam3",
}


def get_sam_model() -> str:
    """Return the configured SAM model id.

    Reads ``SAM_MODEL`` first; falls back to the legacy ``SAM_VARIANT`` env
    (Plan 08) so existing operator setups don't break. Defaults to
    ``DEFAULT_SAM_MODEL``. Unknown values fall back to the default with a
    one-line warning.
    """
    raw = os.getenv("SAM_MODEL") or os.getenv("SAM_VARIANT") or DEFAULT_SAM_MODEL
    # Backward compat: SAM_VARIANT=sam2 (no size) → use the default size.
    if raw == "sam2":
        raw = DEFAULT_SAM_MODEL
    if raw not in ALLOWED_SAM_MODELS:
        log.warning("unknown SAM_MODEL=%r; falling back to %s", raw, DEFAULT_SAM_MODEL)
        return DEFAULT_SAM_MODEL
    return raw


def get_sam_variant() -> str:
    """Return ``"sam3"`` if SAM 3 is selected, otherwise ``"sam2"``.

    Preserves the Plan 08 contract used by the SAM 3 text-prompt 409 gate.
    """
    return "sam3" if get_sam_model() == "sam3" else "sam2"


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
    """Production factory: load the configured SAM 2.1 image predictor.

    Imports torch + sam2 lazily so the test path stays import-free.
    Pulls the HF repo id from ``get_sam_model()``. Raises a clear error
    when ``SAM_MODEL=sam3`` (image predictor for SAM 3 is wired in v1.1
    T6, not here).
    """
    model = get_sam_model()
    if model == "sam3":
        # T6 wires the SAM 3 click-prompt path through a separate factory.
        # If we hit this default factory with sam3 selected, the operator
        # forgot to register the SAM 3 predictor.
        raise RuntimeError(
            "SAM_MODEL=sam3 selected but SAM 3 click predictor not registered; "
            "see apps/docs/admin.md SAM 3 setup."
        )
    repo = _HF_REPO_BY_MODEL[model]

    import torch  # type: ignore[import-not-found]
    from sam2.sam2_image_predictor import SAM2ImagePredictor  # type: ignore[import-not-found]

    p = SAM2ImagePredictor.from_pretrained(repo)
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
