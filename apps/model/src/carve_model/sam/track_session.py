# Armin Mehri — mehri.armin@gmail.com
"""SAM 3.1 multiplex track session manager.

Single backend, single code path. The ``sam3`` native package is imported
lazily so unit tests can inject a fake predictor via ``_set_predictor_for_test``.
"""
from __future__ import annotations

import logging
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from carve_model.sam.track_frame_cache import ensure_cached

logger = logging.getLogger(__name__)


@dataclass
class TrackSession:
    """One in-flight tracking session."""

    session_id: str                 # local id (uuid)
    native_session_id: str          # the predictor's id (mirrored in requests)
    image_size: tuple[int, int]     # (h, w)
    frame_dir: Path
    frame_count: int
    asset_hash: str
    obj_classes: dict[int, str] = field(default_factory=dict)
    last_used: float = field(default_factory=time.monotonic)


_SESSIONS: dict[str, TrackSession] = {}
_LOCK = threading.Lock()
_PREDICTOR: Any | None = None
_TEST_PREDICTOR: Any | None = None
_IDLE_TIMEOUT_S = 600.0  # 10 min
_CUDA_DEVICE_INDEX: int | None = None  # set by _get_predictor when on cuda:N


def _device_ctx():
    """Per-call CUDA device pin so any FastAPI worker thread (or RQ worker)
    runs upstream forward passes on the GPU the predictor weights live on,
    not whatever the thread's default happened to be.

    Returns a context manager — use as ``with _device_ctx(): ...``. When
    we're on CPU / MPS / not yet built, returns a null context.
    """
    if _CUDA_DEVICE_INDEX is None:
        from contextlib import nullcontext
        return nullcontext()
    import torch  # type: ignore[import-not-found]
    return torch.cuda.device(_CUDA_DEVICE_INDEX)


def _set_predictor_for_test(predictor: Any | None) -> None:
    """Inject a fake multiplex predictor for unit tests."""
    global _TEST_PREDICTOR
    _TEST_PREDICTOR = predictor


def _get_predictor() -> Any:
    if _TEST_PREDICTOR is not None:
        return _TEST_PREDICTOR
    global _PREDICTOR, _CUDA_DEVICE_INDEX
    if _PREDICTOR is None:
        # v3.27 fix — match the v3.25.3 device dance from predictor.py.
        # The native multiplex video predictor calls ``.cuda()`` /
        # ``device="cuda"`` internally with no per-instance device kwarg.
        # If the SAM image predictor lives on cuda:1 (operator preference)
        # and the multiplex predictor lands on cuda:0, the shared
        # ``vl_combiner.forward_image`` path mismatches devices and a
        # convolution raises ``RuntimeError: Expected all tensors to be
        # on the same device, but found at least two devices, cuda:0
        # and cuda:1!`` (surfaced as ``sam_model_failed`` to the UI).
        #
        # Resolve the SAM preference (same source as the image predictor),
        # call ``torch.cuda.set_device(N)`` so all subsequent ``.cuda()``
        # calls land on the right index, then build the predictor.
        try:
            from carve_model import device_prefs
            from carve_model.devices import (
                MIN_FREE_MB_DEFAULTS,
                resolve_device,
            )

            pref = device_prefs.get_pref("sam")
            resolved = resolve_device(
                pref, min_free_mb=MIN_FREE_MB_DEFAULTS["sam"]
            ).device
        except Exception:  # noqa: BLE001
            resolved = None

        if isinstance(resolved, str) and resolved.startswith("cuda:"):
            try:
                import torch  # type: ignore[import-not-found]

                idx = int(resolved.split(":", 1)[1])
                torch.cuda.set_device(idx)
                _CUDA_DEVICE_INDEX = idx
                logger.info(
                    "track_session: pinned default CUDA device to %d "
                    "before building multiplex video predictor",
                    idx,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "track_session: could not set CUDA index from %s: %s",
                    resolved, exc,
                )
        elif resolved == "cuda":
            try:
                import torch  # type: ignore[import-not-found]

                _CUDA_DEVICE_INDEX = torch.cuda.current_device()
            except Exception:  # noqa: BLE001
                pass

        from sam3.model_builder import (  # type: ignore[import-not-found]
            build_sam3_multiplex_video_predictor,
        )
        # v3.27 fix — upstream defaults use_fa3=True (FlashAttention 3
        # via the optional ``flash_attn_interface`` package). Our model
        # image doesn't include flash_attn_interface (it's a heavy GPU-
        # only optional dep tied to specific CUDA/PyTorch versions);
        # without it every forward pass raises:
        #   ModuleNotFoundError: No module named 'flash_attn_interface'
        # surfaced as ``add_prompt_failed`` / 502 to the UI.
        # Disable FA3 — sam3's vitdet falls back to PyTorch SDPA which
        # is fast enough for interactive editing on a single GPU.
        _PREDICTOR = build_sam3_multiplex_video_predictor(use_fa3=False)

        # v3.27 fix — upstream sam3 base predictor's ``start_session``
        # always passes ``offload_state_to_cpu`` to ``model.init_state``,
        # but the multiplex tracking model's ``init_state`` only accepts
        # ``offload_video_to_cpu`` (and a few other kwargs). The mismatch
        # raises ``TypeError: ... got an unexpected keyword argument
        # 'offload_state_to_cpu'`` on every start_session call (surfaced
        # as ``sam_model_failed`` to the UI).
        #
        # Wrap ``model.init_state`` so it accepts but silently ignores any
        # kwargs the underlying signature doesn't actually take. The
        # filtered call still receives the kwargs the multiplex model does
        # accept (resource_path, offload_video_to_cpu, async_loading_frames,
        # use_torchcodec, use_cv2, input_is_mp4).
        try:
            import inspect

            _model = getattr(_PREDICTOR, "model", None)
            _orig_init_state = getattr(_model, "init_state", None) if _model else None
            if _orig_init_state is not None:
                _accepted = set(
                    inspect.signature(_orig_init_state).parameters.keys()
                )

                def _safe_init_state(*args, **kwargs):
                    filtered = {k: v for k, v in kwargs.items() if k in _accepted}
                    dropped = set(kwargs) - set(filtered)
                    if dropped:
                        logger.debug(
                            "track_session: dropped unsupported init_state "
                            "kwargs %s (multiplex model only accepts %s)",
                            sorted(dropped), sorted(_accepted),
                        )
                    return _orig_init_state(*args, **filtered)

                _model.init_state = _safe_init_state  # type: ignore[assignment]
                logger.info(
                    "track_session: wrapped multiplex model.init_state to "
                    "filter unsupported kwargs from base start_session",
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "track_session: could not patch init_state kwargs filter: %s",
                exc,
            )
    return _PREDICTOR


def _force_rebuild_predictor() -> None:
    """v3.27 — drop the cached multiplex video predictor.

    Called by /devices/sam/reload so the operator's new device preference
    takes effect on the NEXT track session. The current predictor's GPU
    memory is released by the next ``torch.cuda.empty_cache()`` after the
    reference is dropped.
    """
    global _PREDICTOR
    _PREDICTOR = None


def open_session(
    *,
    frame_urls: list[str],
    image_size: tuple[int, int],
    asset_hash: str,
) -> TrackSession:
    frame_dir = ensure_cached(asset_hash=asset_hash, frame_urls=frame_urls)
    predictor = _get_predictor()
    with _device_ctx():
        resp = predictor.handle_request({
            "type": "start_session",
            "resource_path": str(frame_dir),
        })
    if not isinstance(resp, dict) or "session_id" not in resp:
        raise RuntimeError(
            f"start_session_unexpected_response: {resp!r}",
        )
    sess = TrackSession(
        session_id=str(uuid.uuid4()),
        native_session_id=str(resp["session_id"]),
        image_size=image_size,
        frame_dir=frame_dir,
        frame_count=len(frame_urls),
        asset_hash=asset_hash,
    )
    with _LOCK:
        _SESSIONS[sess.session_id] = sess
    return sess


def get_session(session_id: str) -> TrackSession | None:
    with _LOCK:
        sess = _SESSIONS.get(session_id)
    if sess is not None:
        sess.last_used = time.monotonic()
    return sess


def close_session(session_id: str) -> bool:
    with _LOCK:
        sess = _SESSIONS.pop(session_id, None)
    if sess is None:
        return False
    try:
        with _device_ctx():
            _get_predictor().handle_request({
                "type": "close_session",
                "session_id": sess.native_session_id,
            })
    except Exception as exc:  # noqa: BLE001
        logger.warning("close_session best-effort failed: %s", exc)
    return True


def evict_idle_sessions() -> list[str]:
    now = time.monotonic()
    evicted: list[str] = []
    with _LOCK:
        for sid in list(_SESSIONS):
            if (now - _SESSIONS[sid].last_used) >= _IDLE_TIMEOUT_S:
                _SESSIONS.pop(sid, None)
                evicted.append(sid)
    return evicted


def force_evict_all_sessions() -> int:
    """Forcibly close every track session. Returns the number released.

    Called by /sam/clear when the operator chooses to free GPU/track state
    immediately. Replaces the legacy tracker.force_evict_all_sessions().
    """
    with _LOCK:
        sids = list(_SESSIONS.keys())
    n = 0
    for sid in sids:
        if close_session(sid):
            n += 1
    return n


# ---- T3: add_prompt -------------------------------------------------------
import numpy as np


def _abs_to_rel_points(
    points: list[tuple[float, float]], image_size: tuple[int, int],
) -> list[list[float]]:
    h, w = image_size
    if h <= 0 or w <= 0:
        raise RuntimeError(f"invalid_image_size: {image_size}")
    return [[float(x) / float(w), float(y) / float(h)] for x, y in points]


def _abs_xyxy_to_rel_xywh(
    box: tuple[float, float, float, float], image_size: tuple[int, int],
) -> list[float]:
    """Convert canvas xyxy (px) → SAM 3.1's expected xywh (relative).

    The notebook's ``abs_to_rel_coords(..., coord_type="box")`` helper
    uses ``[x, y, w, h]`` — the multiplex predictor's ``boxes_xywh``
    parameter expects exactly this. We receive xyxy from the canvas;
    convert here.
    """
    h, w = image_size
    x1, y1, x2, y2 = box
    bx = min(float(x1), float(x2))
    by = min(float(y1), float(y2))
    bw = abs(float(x2) - float(x1))
    bh = abs(float(y2) - float(y1))
    return [bx / float(w), by / float(h), bw / float(w), bh / float(h)]


def _torch_available() -> bool:
    try:
        import torch  # noqa: F401
        return True
    except ImportError:
        return False


def _extract_masks(resp: Any) -> dict[int, np.ndarray]:
    """Pull ``{obj_id: mask}`` out of a native multiplex response.

    Native multiplex ``add_prompt`` / ``propagate_in_video`` returns
    ``{"frame_index": int, "outputs": {...}}`` where ``outputs`` is the
    dict produced by ``_postprocess_output``:

        {
          "out_obj_ids":     np.ndarray int64    shape (N,)
          "out_probs":       np.ndarray float32  shape (N,)
          "out_boxes_xywh":  np.ndarray float32  shape (N, 4)
          "out_binary_masks":np.ndarray bool     shape (N, H, W)
          "frame_stats":     ...
        }

    Zip ``out_obj_ids[i]`` with ``out_binary_masks[i]`` to produce the
    ``{obj_id: 2D bool mask}`` dict the rest of the system expects.
    """
    if not isinstance(resp, dict):
        return {}
    outputs = resp.get("outputs")
    if not isinstance(outputs, dict):
        return {}
    obj_ids = outputs.get("out_obj_ids")
    binary_masks = outputs.get("out_binary_masks")
    if obj_ids is None or binary_masks is None:
        return {}
    obj_ids = np.asarray(obj_ids)
    binary_masks = np.asarray(binary_masks)
    if obj_ids.size == 0 or binary_masks.size == 0:
        return {}
    if obj_ids.shape[0] != binary_masks.shape[0]:
        return {}
    masks: dict[int, np.ndarray] = {}
    for i, oid in enumerate(obj_ids.tolist()):
        masks[int(oid)] = np.asarray(binary_masks[i], dtype=bool)
    return masks


def add_prompt(
    session_id: str,
    *,
    frame_idx: int,
    obj_id: int | None = None,
    text: str | None = None,
    points: list[tuple[float, float]] | None = None,
    labels: list[int] | None = None,
    box: tuple[float, float, float, float] | None = None,
) -> dict[int, np.ndarray]:
    """Add a prompt to a session and return masks for the prompted frame."""
    sess = get_session(session_id)
    if sess is None:
        raise LookupError("session_not_found")

    has_text = bool(text)
    has_points = bool(points)
    has_box = box is not None

    n_modes = sum([has_text, has_points, has_box])
    if n_modes == 0:
        raise ValueError("prompt_required")
    if n_modes > 1:
        raise ValueError("exclusive_prompt_modes")

    request: dict[str, Any] = {
        "type": "add_prompt",
        "session_id": sess.native_session_id,
        "frame_index": int(frame_idx),
    }
    if obj_id is not None:
        request["obj_id"] = int(obj_id)

    if has_text:
        request["text"] = str(text)
    elif has_points:
        rel = _abs_to_rel_points(points or [], sess.image_size)
        if _torch_available():
            import torch  # type: ignore[import-not-found]
            request["points"] = torch.tensor(rel, dtype=torch.float32)
            request["point_labels"] = torch.tensor(
                [int(label) for label in (labels or [])], dtype=torch.int32,
            )
        else:
            request["points"] = rel
            request["point_labels"] = [int(label) for label in (labels or [])]
    elif has_box:
        # The base predictor's handle_request reads ``bounding_boxes`` /
        # ``bounding_box_labels`` and forwards as ``boxes_xywh`` /
        # ``box_labels`` to the multiplex model. Format must be xywh
        # (relative), not xyxy.
        rel_xywh = _abs_xyxy_to_rel_xywh(box, sess.image_size)
        if _torch_available():
            import torch  # type: ignore[import-not-found]
            # Single positive box per call. Shape: (1, 4) for the box,
            # (1,) for labels=1.
            request["bounding_boxes"] = torch.tensor(
                [rel_xywh], dtype=torch.float32,
            )
            request["bounding_box_labels"] = torch.tensor(
                [1], dtype=torch.int32,
            )
        else:
            request["bounding_boxes"] = [rel_xywh]
            request["bounding_box_labels"] = [1]

    with _device_ctx():
        predictor = _get_predictor()
        # SAM 3.1 multiplex gate: ``_build_sam2_output`` returns ``{}``
        # whenever ``inference_state["cached_frame_outputs"][frame_idx]``
        # is missing. The detector path (text/box) seeds the cache as a
        # side-effect; the point path does not. Point prompts on a fresh
        # frame therefore silently return zero masks even though
        # ``add_sam2_new_points`` produced a valid mask. Pre-seeding the
        # cache to ``{}`` makes ``_build_sam2_output`` enter the merge
        # branch and return ``{obj_id: new_mask_data}``.
        # Box prompts route through the SAM3 detector branch which seeds
        # the cache itself, so we only preseed for point prompts.
        if has_points:
            try:
                inf_state = predictor._all_inference_states[
                    sess.native_session_id
                ]["state"]
                inf_state.setdefault("cached_frame_outputs", {})
                inf_state["cached_frame_outputs"].setdefault(
                    int(frame_idx), {},
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "track_session: cached_frame_outputs preseed skipped: %s",
                    exc,
                )
        resp = predictor.handle_request(request)
    return _extract_masks(resp)


# ---- T4: propagate --------------------------------------------------------


def propagate(
    session_id: str,
    *,
    start_frame: int | None = None,
    end_frame: int | None = None,
) -> list[dict]:
    """Run propagation and return frames in ``[start_frame, end_frame]``.

    Returns ``[{"frame_idx": int, "masks": {obj_id: mask}}, ...]``. The
    server-side filter is post-fetch (the native API streams everything;
    we slice). For chunked clients use ``start_frame=last+1`` until the
    response is empty.
    """
    sess = get_session(session_id)
    if sess is None:
        raise LookupError("session_not_found")
    # v3.27 fix — forward start_frame as ``start_frame_index`` so the
    # multiplex predictor doesn't try to auto-derive it from
    # ``previous_stages_out`` (which is the SAM3 text-prompt state).
    # SAM2 point/box prompts live in ``tracker_metadata`` instead, so
    # without an explicit start_frame_index the predictor raises:
    #   RuntimeError: No prompts are received on any frames.
    # We keep ``propagation_direction='both'`` (the predictor default)
    # so a prompt at frame F propagates both forward and backward.
    request: dict[str, Any] = {
        "type": "propagate_in_video",
        "session_id": sess.native_session_id,
    }
    if start_frame is not None:
        request["start_frame_index"] = int(start_frame)
    if end_frame is not None and start_frame is not None:
        # max_frame_num_to_track is a count, not an upper-bound idx.
        request["max_frame_num_to_track"] = max(
            1, int(end_frame) - int(start_frame) + 1,
        )
    with _device_ctx():
        stream = _get_predictor().handle_stream_request(request)
        out: list[dict] = []
        for resp in stream:
            f = int(resp.get("frame_index", 0))
            if start_frame is not None and f < start_frame:
                continue
            if end_frame is not None and f > end_frame:
                break
            out.append({
                "frame_idx": f,
                "masks": _extract_masks(resp),
            })
    return out


# ---- T5: remove_object + reset_prompts ------------------------------------


def remove_object(session_id: str, *, obj_id: int) -> None:
    sess = get_session(session_id)
    if sess is None:
        raise LookupError("session_not_found")
    with _device_ctx():
        _get_predictor().handle_request({
            "type": "remove_object",
            "session_id": sess.native_session_id,
            "obj_id": int(obj_id),
        })
    sess.obj_classes.pop(obj_id, None)


def reset_prompts(session_id: str) -> None:
    sess = get_session(session_id)
    if sess is None:
        raise LookupError("session_not_found")
    with _device_ctx():
        _get_predictor().handle_request({
            "type": "reset_session",
            "session_id": sess.native_session_id,
        })
    sess.obj_classes.clear()
