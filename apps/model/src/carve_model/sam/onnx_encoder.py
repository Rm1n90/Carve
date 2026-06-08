"""Server-side ONNX vision encoder for CVAT-style client-side SAM decode.

Stage 1 of the client-side decode split (design spec:
``docs/superpowers/specs/2026-06-08-client-side-sam-decode-design.md``).

The server runs the bundle's own ``vision_encoder.onnx`` (Option A — encoder
and the browser decoder are compatible *by construction*, same export) once
per image and ships the 3 feature maps (float16) to the browser, which runs
``prompt_encoder_mask_decoder.onnx`` locally per click. This module owns only
the *encoder* half: preprocess -> run -> serialise. The browser decoder and
the ``SamTool`` wiring come in Stages 2-3; the server ``/sam/decode`` path is
untouched and remains the universal fallback (box prompts, decode errors,
cache misses).

The numeric pipeline mirrors the Stage-0 golden parity reference
(``apps/model/scripts/sam_tracker_parity_check.py``) exactly — resize to
``input_size``, divide by 255, subtract per-channel mean, divide by
per-channel std, transpose to NCHW float32 — so client masks reproduce the
server masks within the verified IoU tolerance (>=0.98 for clicks).

Real ONNX loading is gated behind ``SAM_CLIENT_ENCODE`` (default off) so the
extra resident encoder model (a second model in VRAM, see
``[[project_gpu_admission_queue]]``) is opt-in per deployment and the test
path never triggers a multi-hundred-MB Hub download. Tests inject a fake via
``set_test_encoder``.
"""

from __future__ import annotations

import base64
import logging
import os
import threading
from dataclasses import dataclass
from typing import Protocol

import numpy as np
from PIL import Image

log = logging.getLogger("carve_model.sam.onnx_encoder")


# --------------------------------------------------------------------------
# Encoder registry — Stage-0 verified constants (see design spec)
# --------------------------------------------------------------------------
@dataclass(frozen=True)
class EncoderSpec:
    """Static description of one variant's ONNX vision encoder.

    ``encoder_id`` doubles as the wire identifier the browser uses to select
    its matching decoder ``.onnx``. ``mean``/``std`` are per-channel RGB
    normalisation constants from the bundle's ``preprocessor_config.json``.
    """

    encoder_id: str
    repo: str
    encoder_file: str
    input_size: int
    mean: tuple[float, float, float]
    std: tuple[float, float, float]


# Keyed by the SAM_MODEL value so ``encoder_id == SAM_MODEL`` for proven
# variants and the browser mapping stays trivial. Only the two Stage-0
# proven bundles are listed; every other variant -> server fallback.
ENCODER_SPECS: dict[str, EncoderSpec] = {
    # Image clicks run SAM 3 (sam3.pt); the tracker export shares that
    # lineage. 1008px, symmetric 0.5 normalisation (NOT ImageNet).
    "sam3.1": EncoderSpec(
        encoder_id="sam3.1",
        repo="onnx-community/sam3-tracker-ONNX",
        encoder_file="onnx/vision_encoder_fp16.onnx",
        input_size=1008,
        mean=(0.5, 0.5, 0.5),
        std=(0.5, 0.5, 0.5),
    ),
    # transformers-exported SAM 2.1 large — same contract family (3
    # embeddings, no mask_input), differs only in size + normalisation.
    "sam2.1-large": EncoderSpec(
        encoder_id="sam2.1-large",
        repo="onnx-community/sam2.1-hiera-large-ONNX",
        encoder_file="onnx/vision_encoder_fp16.onnx",
        input_size=1024,
        mean=(0.485, 0.456, 0.406),
        std=(0.229, 0.224, 0.225),
    ),
}


def encoder_id_for(sam_model: str) -> str | None:
    """Map an active SAM model to its client-decode encoder id, or ``None``.

    Only the Stage-0 proven variants (``sam3.1``, ``sam2.1-large``) have a
    matching ONNX bundle + verified parity; all others return ``None`` so the
    endpoint omits the structured payload and the browser falls back to the
    server ``/sam/decode`` path.
    """
    spec = ENCODER_SPECS.get(sam_model)
    return spec.encoder_id if spec is not None else None


# --------------------------------------------------------------------------
# Pure numeric helpers (no onnxruntime — fully unit-testable)
# --------------------------------------------------------------------------
def preprocess(img_rgb: np.ndarray, spec: EncoderSpec) -> np.ndarray:
    """Resize + normalise an RGB uint8 image to the encoder's NCHW input.

    Mirrors the Stage-0 parity script: PIL bilinear resize to
    ``input_size``, scale to [0, 1], per-channel ``(x - mean) / std``,
    transpose HWC -> CHW, add a batch dim. Returns float32 ``[1, 3, S, S]``.
    """
    pil = Image.fromarray(img_rgb)
    rs = pil.resize((spec.input_size, spec.input_size), Image.BILINEAR)
    arr = np.asarray(rs, np.float32) / 255.0
    mean = np.asarray(spec.mean, np.float32)
    std = np.asarray(spec.std, np.float32)
    arr = (arr - mean) / std
    return np.transpose(arr, (2, 0, 1))[None].astype(np.float32)


def serialize_tensor(arr: np.ndarray) -> dict[str, object]:
    """Serialise a tensor as base64 float16 + dtype + shape (halves payload)."""
    # Cast + guarantee C-contiguous in one step so ``tobytes()`` emits the
    # bytes in row-major order the browser expects (a non-contiguous source
    # would otherwise serialise a transposed/strided view incorrectly).
    a16 = np.ascontiguousarray(arr, dtype=np.float16)
    return {
        "b64": base64.b64encode(a16.tobytes()).decode("ascii"),
        "dtype": "float16",
        "shape": [int(x) for x in a16.shape],
    }


# --------------------------------------------------------------------------
# Encoder protocol + payload
# --------------------------------------------------------------------------
class ClientEncoder(Protocol):
    """Runs the ONNX vision encoder and returns named float feature maps."""

    def encode(self, img_rgb: np.ndarray) -> dict[str, np.ndarray]: ...


@dataclass(frozen=True)
class ClientEncodePayload:
    """Assembled structured payload for the extended ``/sam/encode`` response."""

    encoder_id: str
    input_size: int
    mean: list[float]
    std: list[float]
    tensors: dict[str, dict[str, object]]


# --------------------------------------------------------------------------
# Encoder acquisition — test seam + opt-in lazy real loader
# --------------------------------------------------------------------------
_UNSET = object()
# _UNSET => not configured; None => explicitly disabled. This is a test-only
# seam set during single-process test setup; it is not synchronised (the GIL
# makes the assignment atomic and pytest-xdist isolates workers in separate
# processes, so there is no shared-state race in practice).
_TEST_ENCODER: object = _UNSET
_SESSIONS: dict[str, ClientEncoder] = {}
_LOCK = threading.Lock()


def set_test_encoder(encoder: ClientEncoder | None) -> None:
    """Inject a fake encoder for tests (bypasses the real loader + env gate)."""
    global _TEST_ENCODER
    _TEST_ENCODER = encoder


def reset_test_encoder() -> None:
    """Restore the default (production) encoder acquisition path."""
    global _TEST_ENCODER
    _TEST_ENCODER = _UNSET


def _client_encode_enabled() -> bool:
    """Real ONNX loading is opt-in (extra resident encoder model in VRAM)."""
    return os.getenv("SAM_CLIENT_ENCODE", "0").strip().lower() in ("1", "true", "yes", "on")


def _providers() -> list[str]:
    """Prefer CUDA (onnxruntime-gpu); fall back to CPU if unavailable."""
    try:
        import onnxruntime as ort  # noqa: PLC0415

        avail = set(ort.get_available_providers())
    except Exception:  # noqa: BLE001
        return ["CPUExecutionProvider"]
    ordered = ["CUDAExecutionProvider", "CPUExecutionProvider"]
    return [p for p in ordered if p in avail] or ["CPUExecutionProvider"]


class _OnnxSessionEncoder:
    """Wraps an onnxruntime ``InferenceSession`` for one encoder bundle."""

    def __init__(self, spec: EncoderSpec, session: object) -> None:
        self._spec = spec
        self._session = session
        self._output_names = [o.name for o in session.get_outputs()]  # type: ignore[attr-defined]

    def encode(self, img_rgb: np.ndarray) -> dict[str, np.ndarray]:
        pix = preprocess(img_rgb, self._spec)
        outs = self._session.run(None, {"pixel_values": pix})  # type: ignore[attr-defined]
        return {name: np.asarray(o) for name, o in zip(self._output_names, outs)}


def _load_session_encoder(spec: EncoderSpec) -> ClientEncoder | None:
    """Download (cached) + open the ONNX encoder; ``None`` on any failure."""
    try:
        import onnxruntime as ort  # noqa: PLC0415
        from huggingface_hub import hf_hub_download  # noqa: PLC0415
    except ImportError:
        log.warning("onnxruntime/huggingface_hub unavailable; client encode disabled")
        return None
    try:
        enc_path = hf_hub_download(spec.repo, spec.encoder_file)
        # transformers ONNX exports store weights in an external ``_data``
        # sidecar that must sit beside the graph file.
        try:
            hf_hub_download(spec.repo, spec.encoder_file + "_data")
        except Exception:  # noqa: BLE001
            pass  # small models inline their weights; absence is fine
        session = ort.InferenceSession(enc_path, providers=_providers())
        log.info("loaded ONNX encoder %s (%s)", spec.encoder_id, spec.repo)
        return _OnnxSessionEncoder(spec, session)
    except Exception:  # noqa: BLE001
        log.exception("failed to load ONNX encoder %s", spec.encoder_id)
        return None


def get_client_encoder(encoder_id: str) -> ClientEncoder | None:
    """Resolve the encoder for ``encoder_id``: test seam, then opt-in loader."""
    if _TEST_ENCODER is not _UNSET:
        return _TEST_ENCODER  # type: ignore[return-value]
    if not _client_encode_enabled():
        return None
    spec = ENCODER_SPECS.get(encoder_id)
    if spec is None:
        return None
    with _LOCK:
        cached = _SESSIONS.get(encoder_id)
        if cached is not None:
            return cached
        enc = _load_session_encoder(spec)
        if enc is not None:
            _SESSIONS[encoder_id] = enc
        return enc


def reset_encoders() -> None:
    """Drop resident ONNX sessions (lifecycle / eviction hook)."""
    with _LOCK:
        _SESSIONS.clear()


def _evict_encoder(encoder_id: str) -> None:
    """Drop a single resident session (e.g. after a CUDA-context encode error)
    so the next request re-loads it instead of failing silently forever."""
    with _LOCK:
        _SESSIONS.pop(encoder_id, None)


# --------------------------------------------------------------------------
# Payload assembly — registry metadata + encoder tensors
# --------------------------------------------------------------------------
def build_encode_payload(img_rgb: np.ndarray, sam_model: str) -> ClientEncodePayload | None:
    """Build the structured client-decode payload, or ``None`` to fall back.

    Returns ``None`` (browser uses server ``/sam/decode``) when the active
    variant has no proven ONNX bundle, no encoder is available (gate off /
    load failed), or the encode itself errors. Never raises — the caller's
    native embedding path is the fallback and must keep working.
    """
    eid = encoder_id_for(sam_model)
    if eid is None:
        return None
    spec = ENCODER_SPECS[eid]
    encoder = get_client_encoder(eid)
    if encoder is None:
        return None
    try:
        named = encoder.encode(img_rgb)
    except Exception:  # noqa: BLE001
        log.exception("ONNX encode failed for %s; falling back to server decode", eid)
        # A resident session that fails at inference (CUDA context loss, OOM)
        # would otherwise stay cached and fail every future request. Evict it
        # so the next encode re-loads a fresh session.
        _evict_encoder(eid)
        return None
    tensors = {name: serialize_tensor(arr) for name, arr in named.items()}
    return ClientEncodePayload(
        encoder_id=spec.encoder_id,
        input_size=spec.input_size,
        mean=list(spec.mean),
        std=list(spec.std),
        tensors=tensors,
    )
