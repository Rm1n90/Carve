"""SAM 3.1 native multiplex video adapter — TrackerProtocol implementation.

Plan 11 Task 3. Wraps the native ``sam3`` git package's
``MultiplexVideoPredictor`` in the ``TrackerProtocol`` contract used by the
rest of the pipeline (track_router, sam_track API).

The native multiplex API is request-style. Every operation goes through
``predictor.handle_request({"type": ..., ...})`` (or
``handle_stream_request`` for propagation). Sessions are identified by a
``session_id`` returned from ``start_session``. Coordinates are normalized
relative to image size (``[0, 1]``) — this adapter converts the absolute
ABS pixel coords used internally by the rest of the system into the REL
coords the predictor expects.

This adapter is loaded ONLY when the operator opts in via
``SAM_VIDEO_BACKEND=multiplex`` (or ``SAM_MODEL=sam3.1``). Imports of
``sam3`` and ``torch`` are deferred so the dev path (no native sam3 in the
venv) keeps working — the broader 182 model test suite must stay
torch/transformers-free unless ``SAM3P1_AVAILABLE=1``.
"""

from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger(__name__)


# --- coord conversion helpers -----------------------------------------------


def _abs_to_rel_point(p: tuple[float, float], h: int, w: int) -> list[float]:
    """ABS (px) → REL ([0, 1]) point conversion. Returns [x_rel, y_rel]."""
    if h <= 0 or w <= 0:
        raise ValueError(f"image size must be positive, got h={h}, w={w}")
    return [float(p[0]) / float(w), float(p[1]) / float(h)]


def _abs_to_rel_box(
    box: tuple[float, float, float, float], h: int, w: int,
) -> list[float]:
    """ABS xyxy (px) → REL ([0, 1]) box conversion. Returns [x1, y1, x2, y2]."""
    if h <= 0 or w <= 0:
        raise ValueError(f"image size must be positive, got h={h}, w={w}")
    x1, y1, x2, y2 = box
    return [
        float(x1) / float(w),
        float(y1) / float(h),
        float(x2) / float(w),
        float(y2) / float(h),
    ]


# --- image-size discovery ---------------------------------------------------


def _probe_image_size(video_path: str) -> tuple[int, int] | None:
    """Best-effort image-size probe. Returns ``(h, w)`` or None.

    Tries (in order):
      1. PIL.Image on the first jpg/png in a directory of frames.
      2. cv2.VideoCapture on a single video file.
    """
    try:
        if os.path.isdir(video_path):
            from PIL import Image  # type: ignore[import-not-found]

            for name in sorted(os.listdir(video_path)):
                if name.lower().endswith((".jpg", ".jpeg", ".png")):
                    full = os.path.join(video_path, name)
                    with Image.open(full) as im:
                        w, h = im.size
                    return int(h), int(w)
            return None
        # Treat as a single video file.
        try:
            import cv2  # type: ignore[import-not-found]
        except ImportError:
            return None
        cap = cv2.VideoCapture(video_path)
        try:
            ok, frame = cap.read()
            if not ok or frame is None:
                return None
            h, w = int(frame.shape[0]), int(frame.shape[1])
            return h, w
        finally:
            cap.release()
    except Exception as exc:  # noqa: BLE001
        logger.warning("sam3.1 multiplex: image-size probe failed: %s", exc)
        return None


def _capture_image_size_from_response(resp: Any) -> tuple[int, int] | None:
    """Extract ``(h, w)`` from a native sam3 response dict if present."""
    if not isinstance(resp, dict):
        return None
    h = resp.get("image_height") or resp.get("height")
    w = resp.get("image_width") or resp.get("width")
    if h and w:
        return int(h), int(w)
    return None


# --- adapter ----------------------------------------------------------------


class Sam3p1MultiplexVideoAdapter:
    """``TrackerProtocol`` implementation backed by the native sam3 multiplex
    predictor.

    State dict shape (returned from ``init_state``):
      - ``session_id``: str
      - ``predictor``: native sam3 predictor instance
      - ``image_size``: ``(h, w)`` | None — captured on first add_prompt
      - ``mode``: ``"multiplex"``
      - ``tmpdir``: None (mirrors Sam2VideoTrackerAdapter; populated by caller)
      - ``video_path``: str — for lazy image-size discovery
    """

    def __init__(self, predictor: Any) -> None:
        self._predictor = predictor

    # -- TrackerProtocol -----------------------------------------------------

    def init_state(self, video_path: str) -> dict:
        """Open a multiplex session and return state dict.

        The native predictor's ``start_session`` may or may not return
        image dimensions in the response — we capture them when present
        and otherwise lazily probe via ``cv2`` / ``PIL`` on first prompt.
        """
        resp = self._predictor.handle_request({
            "type": "start_session",
            "resource_path": video_path,
        })
        if not isinstance(resp, dict) or "session_id" not in resp:
            raise RuntimeError(
                f"sam3.1 multiplex start_session returned unexpected response: {resp!r}",
            )
        image_size = _capture_image_size_from_response(resp)
        return {
            "session_id": str(resp["session_id"]),
            "predictor": self._predictor,
            "image_size": image_size,
            "mode": "multiplex",
            "tmpdir": None,
            "video_path": video_path,
        }

    def add_new_points(
        self, inference_state: Any, frame_idx: int, points: Any, labels: Any,
    ) -> tuple[Any, Any, Any]:
        """Legacy single-object entrypoint — routes to add_inputs_at_frame."""
        is_text_mode = isinstance(points, str) or (
            isinstance(points, list)
            and len(points) > 0
            and all(isinstance(t, str) for t in points)
        )
        if is_text_mode:
            text = points if isinstance(points, str) else points[0]
            self.add_text_prompt(inference_state, frame_idx, text)
            return None, None, None
        self.add_inputs_at_frame(
            inference_state,
            frame_idx=frame_idx,
            obj_id=1,
            points=points,
            labels=labels,
        )
        return None, None, None

    def add_inputs_at_frame(
        self,
        inference_state: Any,
        frame_idx: int,
        obj_id: int,
        points: Any = None,
        labels: Any = None,
        boxes: Any = None,
    ) -> Any:
        """Add a point or box prompt for a specific obj_id at a frame.

        The native multiplex API accepts box OR points per request — we
        enforce one-or-the-other here so callers see a clear error rather
        than an opaque native exception.
        """
        if points and boxes:
            raise ValueError(
                "sam3.1 multiplex: pass either points or boxes per call, not both",
            )
        if not points and not boxes:
            raise RuntimeError(
                "sam3.1 multiplex add_inputs_at_frame requires points or boxes",
            )

        h, w = self._ensure_image_size(inference_state)
        request: dict[str, Any] = {
            "type": "add_prompt",
            "session_id": inference_state["session_id"],
            "frame_index": int(frame_idx),
            "obj_id": int(obj_id),
        }
        if points:
            import torch  # type: ignore[import-not-found]

            rel_points = [_abs_to_rel_point(p, h, w) for p in points]
            request["points"] = torch.tensor(rel_points, dtype=torch.float32)
            request["point_labels"] = torch.tensor(
                [int(label) for label in (labels or [])], dtype=torch.int32,
            )
        elif boxes:
            import torch  # type: ignore[import-not-found]

            # Single-box-per-call contract (matches the native API).
            box = boxes[0] if isinstance(boxes, (list, tuple)) and len(boxes) > 0 else boxes
            rel_box = _abs_to_rel_box(tuple(box), h, w)
            request["box"] = torch.tensor(rel_box, dtype=torch.float32)

        resp = inference_state["predictor"].handle_request(request)
        if inference_state.get("image_size") is None:
            sz = _capture_image_size_from_response(resp)
            if sz is not None:
                inference_state["image_size"] = sz
        return resp

    def add_text_prompt(
        self, inference_state: Any, frame_idx: int, text: str,
    ) -> Any:
        """Add a text concept prompt — multiplex auto-creates obj_ids per detection."""
        resp = inference_state["predictor"].handle_request({
            "type": "add_prompt",
            "session_id": inference_state["session_id"],
            "frame_index": int(frame_idx),
            "text": str(text),
        })
        if inference_state.get("image_size") is None:
            sz = _capture_image_size_from_response(resp)
            if sz is not None:
                inference_state["image_size"] = sz
        return resp

    def propagate_in_video(self, inference_state: Any) -> Any:
        """Stream propagation results.

        Yields ``(int frame_idx, dict[int obj_id, np.ndarray mask])``
        translated from the native ``{frame_index, outputs: {<obj_id>:
        {"mask": tensor, ...}}}`` response shape.
        """
        from carve_model.sam.perf import to_numpy_safe

        stream = inference_state["predictor"].handle_stream_request({
            "type": "propagate_in_video",
            "session_id": inference_state["session_id"],
        })
        for response in stream:
            frame_idx = int(response.get("frame_index", 0))
            outputs = response.get("outputs", {}) or {}
            obj_masks: dict[int, Any] = {}
            for obj_id_key, payload in outputs.items():
                if not isinstance(payload, dict):
                    continue
                mask = payload.get("mask")
                if mask is None:
                    continue
                obj_masks[int(obj_id_key)] = to_numpy_safe(mask)
            yield frame_idx, obj_masks

    def remove_object(self, inference_state: Any, obj_id: int) -> Any:
        return inference_state["predictor"].handle_request({
            "type": "remove_object",
            "session_id": inference_state["session_id"],
            "obj_id": int(obj_id),
        })

    def reset_session(self, inference_state: Any) -> Any:
        return inference_state["predictor"].handle_request({
            "type": "reset_session",
            "session_id": inference_state["session_id"],
        })

    def release(self, inference_state: Any) -> None:
        """Best-effort session close + tmpdir cleanup."""
        try:
            inference_state["predictor"].handle_request({
                "type": "close_session",
                "session_id": inference_state["session_id"],
            })
        except Exception as exc:  # noqa: BLE001
            logger.debug("sam3.1 multiplex close_session best-effort failed: %s", exc)
        tmpdir = inference_state.get("tmpdir")
        if tmpdir:
            import shutil

            shutil.rmtree(tmpdir, ignore_errors=True)
        inference_state["predictor"] = None

    # -- helpers -------------------------------------------------------------

    def _ensure_image_size(self, inference_state: dict) -> tuple[int, int]:
        size = inference_state.get("image_size")
        if size is not None:
            return size
        probed = _probe_image_size(inference_state["video_path"])
        if probed is None:
            raise RuntimeError(
                "sam3.1 multiplex: could not determine image size for "
                f"video_path={inference_state['video_path']!r}; cannot convert "
                "absolute coordinates to relative coordinates",
            )
        inference_state["image_size"] = probed
        return probed


# --- factory ----------------------------------------------------------------


def build_sam3p1_multiplex_video_tracker() -> Sam3p1MultiplexVideoAdapter:
    """Build the native sam3 multiplex video predictor and wrap it.

    Imports ``sam3.model_builder`` lazily — when the native package is not
    installed (dev environment), the import raises ``ImportError`` and the
    caller (the tracker resolver in ``tracker.py``) falls back to the
    transformers SAM 3 dispatcher.
    """
    from sam3.model_builder import (  # type: ignore[import-not-found]
        build_sam3_multiplex_video_predictor,
    )

    predictor = build_sam3_multiplex_video_predictor()
    return Sam3p1MultiplexVideoAdapter(predictor=predictor)
