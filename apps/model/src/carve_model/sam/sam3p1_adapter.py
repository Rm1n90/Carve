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


# ============================================================================
# Plan 12 — native SAM 3.1 image predictor (point + box + text)
# ============================================================================


def _sam3_bpe_path() -> str:
    """Resolve the bundled ``bpe_simple_vocab_16e6.txt.gz`` path inside the
    installed ``sam3`` wheel.

    The native sam3 package places its assets at ``<sam3>/assets/...`` (NOT
    ``<sam3>/../assets/...``) — verified inside the model container.
    """
    import os
    import sam3  # type: ignore[import-not-found]

    return os.path.join(os.path.dirname(sam3.__file__), "assets", "bpe_simple_vocab_16e6.txt.gz")


class Sam3p1NativeImagePredictorAdapter:
    """Wrap the native ``sam3`` image model + ``Sam3Processor`` to look like
    SAM 2's image predictor.

    Mirrors the public surface of ``Sam3ImagePredictorAdapter`` so the
    factory in ``predictor.py`` can swap them transparently. The native
    package handles its own embedding caching internally; we don't expose
    a usable ``extract_embedding`` for this path — the router handles
    ``None`` by falling back to server-side decode.

    Verified state-key contract for the native processor (Plan 12 probe):

    - ``processor.set_image(pil_image)`` → returns dict with
      ``original_height``, ``original_width``, ``backbone_out``.
    - ``processor.set_text_prompt(prompt, state)`` → mutates state to add
      ``geometric_prompt``, ``masks_logits``, ``masks``, ``boxes``,
      ``scores``.
    - ``model.predict_inst(state, point_coords=..., point_labels=...,
      box=..., multimask_output=...)`` → returns
      ``(masks: ndarray (K, H, W), scores: ndarray (K,), logits: ndarray)``.

    The native processor expects **PIL images**, not numpy arrays — passing
    a raw HxWx3 numpy array silently misinterprets dims (verified: it
    writes ``original_width=3``, the channel count). We always convert.
    """

    def __init__(self, model: Any, processor: Any, device: str) -> None:
        self._model = model
        self._processor = processor
        self._device = device
        self._state: dict | None = None
        self._original_size: tuple[int, int] | None = None  # (h, w)
        # Native image model owns its own embedding cache; we don't expose
        # one (router falls back to server-side decode without speedup).
        self._features: dict | None = None

    def set_image(self, image: Any) -> None:
        """Cache the image inside the native processor's state dict.

        ``image`` is a numpy ``HxWx3`` RGB uint8 array (per router contract).
        Converted to PIL before handing to the native processor.

        The forward pass is wrapped in ``torch.autocast(cuda, bf16)``:
        the native sam3 image stack uses a fused ``addmm_act`` MLP
        kernel that internally casts to bf16, plus
        ``with autocast(enabled=False)`` blocks in the decoder that
        force specific FFNs back to float32. PyTorch's autocast handles
        the per-op rules; trying to manually cast everything to a
        single dtype breaks the design.
        """
        from PIL import Image  # type: ignore[import-not-found]
        import torch  # type: ignore[import-not-found]

        h, w = int(image.shape[0]), int(image.shape[1])
        self._original_size = (h, w)
        pil = Image.fromarray(image)
        if self._device == "cuda":
            with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
                self._state = self._processor.set_image(pil)
        else:
            self._state = self._processor.set_image(pil)

    def predict(
        self,
        point_coords: Any,
        point_labels: Any,
        multimask_output: bool = True,
        box: Any = None,
    ) -> tuple[Any, Any, Any]:
        """Run a click/box prompt forward pass and return ``(masks, scores, logits)``.

        Returns numpy arrays. Shape:
          - ``multimask_output=True``  → masks (K, H, W), scores (K,)
          - ``multimask_output=False`` → masks (1, H, W), scores (1,)
        """
        if self._state is None or self._original_size is None:
            raise RuntimeError("set_image must be called before predict")
        import numpy as np

        pc: Any = None
        pl: Any = None
        if point_coords is not None:
            arr = np.asarray(point_coords, dtype=np.float32).reshape(-1, 2)
            if len(arr) > 0:
                pc = arr
        if point_labels is not None:
            arr_l = np.asarray(point_labels, dtype=np.int64).reshape(-1)
            if len(arr_l) > 0:
                pl = arr_l
        b: Any = None
        if box is not None:
            b = np.asarray(box, dtype=np.float32).reshape(-1)

        import torch  # type: ignore[import-not-found]
        if self._device == "cuda":
            with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
                masks, scores, logits = self._model.predict_inst(
                    self._state,
                    point_coords=pc,
                    point_labels=pl,
                    box=b,
                    multimask_output=multimask_output,
                )
        else:
            masks, scores, logits = self._model.predict_inst(
                self._state,
                point_coords=pc,
                point_labels=pl,
                box=b,
                multimask_output=multimask_output,
            )
        return masks, scores, logits

    def extract_embedding(self) -> dict | None:
        """The native image model's encoder cache is internal — no clean
        serializable embedding handoff. Return None so the router falls
        back to server-side decode (verified-acceptable per Plan 12).
        """
        return None


def build_sam3p1_image_predictor(device: str | None = None) -> Sam3p1NativeImagePredictorAdapter:
    """Build the native sam3 image model + processor and wrap them.

    Imports ``sam3`` lazily — raises ``ImportError`` if the native package
    is not installed. Honors ``SAM_COMPILE`` via ``perf.get_compile_enabled``;
    dtype/attention selection is owned by the native package's build
    flags (bf16-on-cuda is the default there).
    """
    from sam3 import build_sam3_image_model  # type: ignore[import-not-found]
    from sam3.model.sam3_image_processor import Sam3Processor  # type: ignore[import-not-found]

    from carve_model.sam import perf

    dev = device or perf.get_device()
    bpe = _sam3_bpe_path()

    model = build_sam3_image_model(
        bpe_path=bpe,
        device=dev,
        enable_segmentation=True,
        enable_inst_interactivity=True,
        compile=perf.get_compile_enabled(),
    )
    # Model + transform stay float32 (native default). The forward
    # passes are wrapped in ``torch.autocast(cuda, bfloat16)`` inside
    # ``Sam3p1NativeImagePredictorAdapter`` — that's what the native
    # package's ``addmm_act`` fused MLP kernel and the
    # ``with autocast(enabled=False)`` blocks in ``decoder.py`` were
    # designed for: outer autocast(bf16), specific layers opt out.
    processor = Sam3Processor(model)
    return Sam3p1NativeImagePredictorAdapter(model=model, processor=processor, device=dev)


# --- module-level cache for text/box predictors -----------------------------


_NATIVE_IMAGE_PREDICTOR: Sam3p1NativeImagePredictorAdapter | None = None


def _get_or_build_native_image_predictor() -> Sam3p1NativeImagePredictorAdapter:
    global _NATIVE_IMAGE_PREDICTOR
    if _NATIVE_IMAGE_PREDICTOR is None:
        _NATIVE_IMAGE_PREDICTOR = build_sam3p1_image_predictor()
    return _NATIVE_IMAGE_PREDICTOR


def _set_native_image_predictor_for_tests(adapter: Any) -> None:
    """Test-only seam to inject a pre-built adapter."""
    global _NATIVE_IMAGE_PREDICTOR
    _NATIVE_IMAGE_PREDICTOR = adapter


def _decode_image_b64_to_numpy(image_b64: str) -> Any:
    import base64
    from io import BytesIO

    import numpy as np
    from PIL import Image  # type: ignore[import-not-found]

    img_bytes = base64.b64decode(image_b64)
    pil = Image.open(BytesIO(img_bytes)).convert("RGB")
    return np.asarray(pil, dtype="uint8")


def _extract_text_detections(state: dict) -> list[tuple[Any, float]]:
    """Pull (mask_HxW_uint8, score) pairs out of a post-set_text_prompt state.

    Verified state keys (Plan 12 probe inside the model container):
      ``masks_logits``, ``masks``, ``boxes``, ``scores``, ``geometric_prompt``,
      ``backbone_out``, ``original_height``, ``original_width``.

    ``masks`` is a torch tensor of shape ``(N, 1, H, W)`` dtype=bool.
    ``scores`` is a torch tensor of shape ``(N,)`` (bf16 on cuda).
    """
    import numpy as np

    from carve_model.sam.perf import to_numpy_safe

    masks = state.get("masks")
    scores = state.get("scores")
    if masks is None or scores is None:
        logger.warning(
            "sam3.1 native text prompt: state missing 'masks'/'scores'; keys=%s",
            list(state.keys()) if isinstance(state, dict) else type(state).__name__,
        )
        return []

    masks_np = to_numpy_safe(masks)
    scores_np = to_numpy_safe(scores)
    n = int(masks_np.shape[0])
    out: list[tuple[Any, float]] = []
    for i in range(n):
        m = masks_np[i]
        # Squeeze possible (1, H, W) → (H, W).
        if m.ndim == 3 and m.shape[0] == 1:
            m = m[0]
        out.append((m.astype(np.uint8), float(scores_np[i])))
    return out


def make_sam3p1_text_predictor():
    """Return ``fn(*, image_b64, text) -> list[dict]`` for /sam/text-prompt.

    Each dict: ``{counts, size, score, polygon, bbox}``. Sorted score desc.
    """

    def _predict_from_text(
        *, image_b64: str, text: str, use_vlm_fo1: bool = False,
    ) -> list[dict]:
        import logging
        import os

        from carve_model.sam import predictor as p_mod
        from carve_model.sam.codec import encode_mask_rle
        from carve_model.sam.perf import to_numpy_safe
        from carve_model.sam.polygonize import mask_to_polygon

        import torch  # type: ignore[import-not-found]

        _logger = logging.getLogger(__name__)

        adapter = _get_or_build_native_image_predictor()
        image_np = _decode_image_b64_to_numpy(image_b64)
        adapter.set_image(image_np)
        state = adapter._state
        if state is None:
            return []
        # Reset any prior prompts before applying the new text concept.
        adapter._processor.reset_all_prompts(state)
        if adapter._device == "cuda":
            with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
                adapter._processor.set_text_prompt(text, state)
        else:
            adapter._processor.set_text_prompt(text, state)

        detections = _extract_text_detections(state)
        boxes = state.get("boxes")
        boxes_np = to_numpy_safe(boxes) if boxes is not None else None

        rows: list[dict] = []
        for i, (mask_np, score) in enumerate(detections):
            counts, size = encode_mask_rle(mask_np)
            polygon = mask_to_polygon(mask_np)
            if boxes_np is not None and i < len(boxes_np):
                bbox = [float(x) for x in boxes_np[i].tolist()]
            else:
                bbox = [0.0, 0.0, 0.0, 0.0]
            rows.append({
                "counts": counts,
                "size": size,
                "score": score,
                "bbox": bbox,
                "polygon": polygon,
            })
        rows.sort(key=lambda r: r["score"], reverse=True)

        # v3.21+ — VLM-FO1 precision filter pass for the native sam3.1
        # backend. Mirrors the transformers-side path in sam3_adapter so
        # /sam/text-prompt behaves the same regardless of which SAM 3
        # runtime the operator selected.
        if not use_vlm_fo1 or not rows:
            return rows

        try:
            top_k = int(os.environ.get("SAM3_TOPK_PROPOSALS", "64"))
        except ValueError:
            top_k = 64
        if top_k > 0 and len(rows) > top_k:
            rows = rows[:top_k]

        vlm_filter = p_mod.get_vlm_fo1_filter()
        if vlm_filter is None:
            return rows

        try:
            import base64
            from io import BytesIO

            from PIL import Image  # type: ignore[import-not-found]

            img_bytes = base64.b64decode(image_b64)
            pil = Image.open(BytesIO(img_bytes)).convert("RGB")
            boxes_xyxy = [list(r["bbox"]) for r in rows]
            indexes = vlm_filter(image=pil, text=text, boxes=boxes_xyxy)
        except Exception as exc:  # noqa: BLE001 — graceful degradation
            _logger.warning(
                "vlm_fo1 filter failed (%s); degrading to passthrough", exc,
            )
            return rows

        seen: set[int] = set()
        clean: list[int] = []
        for idx in indexes:
            try:
                ii = int(idx)
            except (TypeError, ValueError):
                continue
            if 0 <= ii < len(rows) and ii not in seen:
                seen.add(ii)
                clean.append(ii)
        return [rows[i] for i in clean]

    return _predict_from_text


def make_sam3p1_box_predictor():
    """Return ``fn(*, image_b64, boxes, box_labels, text=None) -> list[dict]``.

    For each positive box (label=1), runs ``model.predict_inst`` with
    ``multimask_output=False`` and keeps the resulting mask. Optional
    ``text`` is applied first via ``set_text_prompt`` to bias the
    concept. Negative boxes (label=0) subtract from the union of
    positive masks (mirrors the SAM 3 transformers dispatcher behavior).
    """

    def _predict_from_boxes(
        *,
        image_b64: str,
        boxes,
        box_labels,
        text: str | None = None,
    ) -> list[dict]:
        import numpy as np

        from carve_model.sam.codec import encode_mask_rle
        from carve_model.sam.polygonize import mask_to_polygon

        import torch  # type: ignore[import-not-found]
        adapter = _get_or_build_native_image_predictor()
        image_np = _decode_image_b64_to_numpy(image_b64)
        adapter.set_image(image_np)
        state = adapter._state
        if state is None:
            return []
        adapter._processor.reset_all_prompts(state)

        if text:
            if adapter._device == "cuda":
                with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
                    adapter._processor.set_text_prompt(text, state)
            else:
                adapter._processor.set_text_prompt(text, state)

        positive_masks: list[Any] = []
        negative_masks: list[Any] = []
        positive_scores: list[float] = []
        positive_boxes: list[list[float]] = []

        for box, label in zip(boxes, box_labels, strict=False):
            box_arr = np.asarray(box, dtype=np.float32).reshape(-1)
            if adapter._device == "cuda":
                with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
                    masks, scores, _ = adapter._model.predict_inst(
                        state,
                        point_coords=None,
                        point_labels=None,
                        box=box_arr,
                        multimask_output=False,
                    )
            else:
                masks, scores, _ = adapter._model.predict_inst(
                    state,
                    point_coords=None,
                    point_labels=None,
                    box=box_arr,
                    multimask_output=False,
                )
            if masks is None or len(masks) == 0:
                continue
            best_idx = int(np.argmax(np.asarray(scores)))
            best_mask = np.asarray(masks[best_idx]).astype(np.uint8)
            best_score = float(np.asarray(scores)[best_idx])
            if int(label) == 1:
                positive_masks.append(best_mask)
                positive_scores.append(best_score)
                positive_boxes.append([float(x) for x in box_arr.tolist()])
            else:
                negative_masks.append(best_mask)

        if not positive_masks:
            return []

        # Subtract union of negatives from each positive mask.
        if negative_masks:
            neg_union = negative_masks[0].copy()
            for m in negative_masks[1:]:
                neg_union = np.logical_or(neg_union, m).astype(np.uint8)
            for i, m in enumerate(positive_masks):
                positive_masks[i] = np.logical_and(
                    m, np.logical_not(neg_union),
                ).astype(np.uint8)

        rows: list[dict] = []
        for mask_np, score, bbox in zip(
            positive_masks, positive_scores, positive_boxes, strict=False,
        ):
            counts, size = encode_mask_rle(mask_np)
            polygon = mask_to_polygon(mask_np)
            rows.append({
                "counts": counts,
                "size": size,
                "score": score,
                "bbox": bbox,
                "polygon": polygon,
            })
        rows.sort(key=lambda r: r["score"], reverse=True)
        return rows

    return _predict_from_boxes
