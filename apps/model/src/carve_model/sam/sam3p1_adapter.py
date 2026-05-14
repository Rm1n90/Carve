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

        The forward pass is wrapped in ``torch.no_grad()`` (we never
        backprop through inference) and ``torch.autocast(cuda, bf16)``:
        the native sam3 image stack uses a fused ``addmm_act`` MLP
        kernel that internally casts to bf16, plus
        ``with autocast(enabled=False)`` blocks in the decoder that
        force specific FFNs back to float32. PyTorch's autocast handles
        the per-op rules; trying to manually cast everything to a
        single dtype breaks the design.

        v3.22 GPU-hygiene: the prior ``self._state`` dict holds GPU
        tensors (image embedding, encoder feats). Drop the reference and
        run ``torch.cuda.empty_cache()`` BEFORE building a new state so
        the allocator can reuse those bytes — without this, batch
        auto-annotate accumulates one stale image-embedding's worth of
        VRAM per asset (≈ 0.5–1 GB), eventually OOM-ing.
        """
        from PIL import Image  # type: ignore[import-not-found]
        import torch  # type: ignore[import-not-found]

        h, w = int(image.shape[0]), int(image.shape[1])
        self._original_size = (h, w)
        pil = Image.fromarray(image)

        if self._state is not None:
            self._state = None
            if self._device == "cuda" and torch.cuda.is_available():
                torch.cuda.empty_cache()

        if self._device == "cuda":
            with torch.no_grad():
                with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
                    self._state = self._processor.set_image(pil)
        else:
            with torch.no_grad():
                self._state = self._processor.set_image(pil)

    def predict(
        self,
        point_coords: Any,
        point_labels: Any,
        multimask_output: bool = True,
        box: Any = None,
        mask_input: Any | None = None,
    ) -> tuple[Any, Any, Any]:
        """Run a click/box prompt forward pass and return ``(masks, scores, logits)``.

        Returns numpy arrays. Shape:
          - ``multimask_output=True``  → masks (K, H, W), scores (K,)
          - ``multimask_output=False`` → masks (1, H, W), scores (1,)

        v3.22 — ``mask_input`` is the canonical SAM 2 iterative-refinement
        signal. The native sam3 ``predict_inst`` forwards it to its inner
        ``SAM3InteractiveImagePredictor.predict(... mask_input=...)``.
        Without it, multi-click sequences produce contradictory masks
        (holes, negatives that expand the mask, jagged boundaries).
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

        # Build the kwargs dict so we only send mask_input when present.
        # The native predictor accepts numpy or torch; we pass through.
        predict_kwargs: dict[str, Any] = {
            "point_coords": pc,
            "point_labels": pl,
            "box": b,
            "multimask_output": multimask_output,
        }
        if mask_input is not None:
            predict_kwargs["mask_input"] = mask_input

        import torch  # type: ignore[import-not-found]
        if self._device == "cuda":
            with torch.no_grad():
                with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
                    masks, scores, logits = self._model.predict_inst(
                        self._state, **predict_kwargs,
                    )
        else:
            with torch.no_grad():
                masks, scores, logits = self._model.predict_inst(
                    self._state, **predict_kwargs,
                )
        return masks, scores, logits

    def predict_with_visual_prompt(self, pooled_embed):
        """Run the SAM 3.1 grounding pass with a visual concept (text disabled).

        Delegates to ``self._model.predict_visual_prompt`` (bound by
        ``build_sam3p1_image_predictor`` to ``_native_visual_forward``).
        Unit tests stub the model attribute to bypass native execution.

        On CUDA we wrap in ``autocast(bf16)`` for parity with the
        text/box/point native paths — the native sam3 stack's fused
        ``addmm_act`` MLP and ``with autocast(enabled=False)`` decoder
        blocks are designed for an outer bf16 autocast.
        """
        import numpy as np

        if self._state is None:
            raise RuntimeError(
                "set_image must be called on the target before predict_with_visual_prompt",
            )
        embed = pooled_embed.reshape(1, 1, -1)
        if self._device == "cuda":
            import torch  # type: ignore[import-not-found]

            with torch.no_grad():
                with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
                    masks, scores, boxes = self._model.predict_visual_prompt(
                        self._state, visual_prompt_embed=embed, encode_text=False,
                    )
        else:
            masks, scores, boxes = self._model.predict_visual_prompt(
                self._state, visual_prompt_embed=embed, encode_text=False,
            )
        return np.asarray(masks), np.asarray(scores), np.asarray(boxes)

    def set_visual_prompt(
        self,
        refer_image,
        region,
        *,
        fusion_mode="dense_plus_global",
        pad_ratio=0.15,
        multi_scale=True,
        tta_hflip=False,
        tta_vflip=False,
        tta_rot90=False,
        color_aug=False,
        self_attn_pool=False,
        ximg_refine=False,
        target_state=None,
    ):
        """Compute a pooled visual_prompt_embed for one (refer_image, region) pair.

        See spec Section 5.5 + 5.6. Optional levers are env-gated, off by default.
        """
        import os
        import numpy as np
        from carve_model.sam.visual_prompt_pool import l2norm, cross_image_refine

        flags = {
            "tta_hflip": tta_hflip or os.environ.get("SAM_VISUAL_PROMPT_TTA_HFLIP") == "1",
            "tta_vflip": tta_vflip or os.environ.get("SAM_VISUAL_PROMPT_TTA_VFLIP") == "1",
            "tta_rot90": tta_rot90 or os.environ.get("SAM_VISUAL_PROMPT_TTA_ROT90") == "1",
            "color_aug": color_aug or os.environ.get("SAM_VISUAL_PROMPT_COLOR_AUG") == "1",
            "self_attn": self_attn_pool or os.environ.get("SAM_VISUAL_PROMPT_SELF_ATTN") == "1",
            "ximg":      ximg_refine    or os.environ.get("SAM_VISUAL_PROMPT_XIMG_REFINE") == "1",
        }

        crops = self._build_tta_crops(
            refer_image, region, pad_ratio=pad_ratio, flags=flags,
        )
        per_ref_vecs = [
            self._encode_one(crop, region_in_crop, multi_scale, flags["self_attn"])
            for crop, region_in_crop in crops
        ]
        pooled = l2norm(np.mean(per_ref_vecs, axis=0))
        if flags["ximg"] and target_state is not None:
            pooled = cross_image_refine(
                pooled,
                self._extract_dense(target_state, scale="hi"),
                k=int(os.environ.get("SAM_VISUAL_PROMPT_XIMG_K", "10")),
                beta=float(os.environ.get("SAM_VISUAL_PROMPT_XIMG_BETA", "0.2")),
            )
        return pooled

    def _build_tta_crops(self, refer_image, region, *, pad_ratio, flags):
        """Build list of (crop_array, region_in_crop) tuples for TTA variants.

        Applies crop preprocessing (expand, min_size_guard, slice, square_pad).
        Returns augmented crops based on enabled flags: hflip, vflip, rot90, color_aug.
        """
        import numpy as np
        from PIL import Image
        from carve_model.sam.visual_prompt_preprocess import (
            expand_region_with_padding, min_size_guard,
            rasterise_polygon, square_pad_replicate,
        )

        H, W = refer_image.shape[:2]
        expanded = expand_region_with_padding(region, image_h=H, image_w=W, pad_ratio=pad_ratio)
        crop_xyxy = expanded["xyxy"] if expanded["kind"] == "bbox" else expanded["crop_xyxy"]
        crop_xyxy = min_size_guard(crop_xyxy, min_side=64)
        cx1 = max(0, int(crop_xyxy[0])); cy1 = max(0, int(crop_xyxy[1]))
        cx2 = min(W, int(crop_xyxy[2])); cy2 = min(H, int(crop_xyxy[3]))
        crop = refer_image[cy1:cy2, cx1:cx2]
        crop = square_pad_replicate(crop)
        crop_h, crop_w = crop.shape[:2]

        pad_top = (crop_h - (cy2 - cy1)) // 2
        pad_left = (crop_w - (cx2 - cx1)) // 2

        # Compute region_in_crop (region coords in crop-local space)
        if region["kind"] == "bbox":
            rx1, ry1, rx2, ry2 = (float(v) for v in region["xyxy"])
            rx1_crop = pad_left + (rx1 - cx1); rx2_crop = pad_left + (rx2 - cx1)
            ry1_crop = pad_top + (ry1 - cy1);  ry2_crop = pad_top + (ry2 - cy1)
            region_in_crop_orig = {"kind": "bbox", "xyxy": [rx1_crop, ry1_crop, rx2_crop, ry2_crop]}
        else:
            pts = [[pad_left + (p[0] - cx1), pad_top + (p[1] - cy1)] for p in region["points"]]
            region_in_crop_orig = {"kind": "polygon", "points": pts}

        crops = []

        # Original
        crops.append((crop.copy(), region_in_crop_orig))

        # Build TTA variants
        if flags["tta_rot90"]:
            # rot90 replaces the original list
            crops = []
            for k in range(4):
                rotated = np.rot90(crop, k=k).copy()
                # Rotate region coords
                if region_in_crop_orig["kind"] == "bbox":
                    rx1, ry1, rx2, ry2 = region_in_crop_orig["xyxy"]
                    # For k=0: no change
                    # For k=1: (x,y) → (y, crop_h-x)  [90° ccw]
                    # For k=2: (x,y) → (crop_w-x, crop_h-y) [180°]
                    # For k=3: (x,y) → (crop_w-y, x) [270° ccw]
                    if k == 0:
                        region_rot = {"kind": "bbox", "xyxy": [rx1, ry1, rx2, ry2]}
                    elif k == 1:
                        # 90° ccw: (x,y) → (y, crop_h-x)
                        region_rot = {"kind": "bbox", "xyxy": [ry1, crop_h - rx2, ry2, crop_h - rx1]}
                    elif k == 2:
                        # 180°: (x,y) → (crop_w-x, crop_h-y)
                        region_rot = {"kind": "bbox", "xyxy": [crop_w - rx2, crop_h - ry2, crop_w - rx1, crop_h - ry1]}
                    else:  # k == 3
                        # 270° ccw: (x,y) → (crop_w-y, x)
                        region_rot = {"kind": "bbox", "xyxy": [crop_w - ry2, rx1, crop_w - ry1, rx2]}
                else:
                    # Polygon rotation
                    pts = region_in_crop_orig["points"]
                    if k == 0:
                        pts_rot = pts
                    elif k == 1:
                        pts_rot = [[p[1], crop_h - p[0]] for p in pts]
                    elif k == 2:
                        pts_rot = [[crop_w - p[0], crop_h - p[1]] for p in pts]
                    else:  # k == 3
                        pts_rot = [[crop_w - p[1], p[0]] for p in pts]
                    region_rot = {"kind": "polygon", "points": pts_rot}
                crops.append((rotated, region_rot))
        else:
            # hflip/vflip/color_aug compose
            if flags["tta_hflip"]:
                # hflip: (x,y) → (crop_w-x, y)
                if region_in_crop_orig["kind"] == "bbox":
                    rx1, ry1, rx2, ry2 = region_in_crop_orig["xyxy"]
                    region_hflip = {"kind": "bbox", "xyxy": [crop_w - rx2, ry1, crop_w - rx1, ry2]}
                else:
                    pts = region_in_crop_orig["points"]
                    region_hflip = {"kind": "polygon", "points": [[crop_w - p[0], p[1]] for p in pts]}
                crops.append((crop[:, ::-1].copy(), region_hflip))

            if flags["tta_vflip"]:
                # vflip: (x,y) → (x, crop_h-y)
                if region_in_crop_orig["kind"] == "bbox":
                    rx1, ry1, rx2, ry2 = region_in_crop_orig["xyxy"]
                    region_vflip = {"kind": "bbox", "xyxy": [rx1, crop_h - ry2, rx2, crop_h - ry1]}
                else:
                    pts = region_in_crop_orig["points"]
                    region_vflip = {"kind": "polygon", "points": [[p[0], crop_h - p[1]] for p in pts]}
                crops.append((crop[::-1, :].copy(), region_vflip))

            if flags["tta_hflip"] and flags["tta_vflip"]:
                # hflip+vflip: (x,y) → (crop_w-x, crop_h-y)
                if region_in_crop_orig["kind"] == "bbox":
                    rx1, ry1, rx2, ry2 = region_in_crop_orig["xyxy"]
                    region_hvflip = {"kind": "bbox", "xyxy": [crop_w - rx2, crop_h - ry2, crop_w - rx1, crop_h - ry1]}
                else:
                    pts = region_in_crop_orig["points"]
                    region_hvflip = {"kind": "polygon", "points": [[crop_w - p[0], crop_h - p[1]] for p in pts]}
                crops.append((crop[::-1, ::-1].copy(), region_hvflip))

        if flags["color_aug"]:
            aug_crop = self._color_jitter(crop)
            crops.append((aug_crop, region_in_crop_orig))

        return crops

    def _encode_one(self, crop, region_in_crop, multi_scale, use_self_attn):
        """Encode a single (pre-cropped) image and region into a pooled vector.

        Takes a crop array + region_in_crop (in crop-local coords), runs processor,
        extracts dense/global features, builds mask, pools, and returns L2-normed vector.
        """
        import numpy as np
        from PIL import Image
        from carve_model.sam.visual_prompt_preprocess import rasterise_polygon
        from carve_model.sam.visual_prompt_pool import (
            masked_mean, l2norm, fuse_dense_global, self_attn_pool,
        )

        crop_h, crop_w = crop.shape[:2]
        state = self._processor.set_image(Image.fromarray(crop))
        dense_hi = self._extract_dense(state, scale="hi")
        dense_lo = self._extract_dense(state, scale="lo") if multi_scale else None
        global_vec = self._extract_global(state)

        # Build mask from region_in_crop
        if region_in_crop["kind"] == "bbox":
            rx1, ry1, rx2, ry2 = region_in_crop["xyxy"]
            mask_hi = self._bbox_mask((rx1, ry1, rx2, ry2), crop_h, crop_w, dense_hi.shape[:2])
            mask_lo = (
                self._bbox_mask((rx1, ry1, rx2, ry2), crop_h, crop_w, dense_lo.shape[:2])
                if dense_lo is not None else None
            )
        else:
            pts = region_in_crop["points"]
            full_mask = rasterise_polygon(pts, crop_h, crop_w)
            mask_hi = self._downsample_bool(full_mask, dense_hi.shape[:2])
            mask_lo = self._downsample_bool(full_mask, dense_lo.shape[:2]) if dense_lo is not None else None

        # Pool dense features
        if use_self_attn:
            dense_vec_hi = self_attn_pool(dense_hi, mask_hi, l2norm(global_vec))
        else:
            dense_vec_hi = l2norm(masked_mean(dense_hi, mask_hi))

        if dense_lo is not None and mask_lo is not None:
            if use_self_attn:
                dense_vec_lo = self_attn_pool(dense_lo, mask_lo, l2norm(global_vec))
            else:
                dense_vec_lo = l2norm(masked_mean(dense_lo, mask_lo))
            dense_vec = l2norm(0.5 * (dense_vec_hi + dense_vec_lo))
        else:
            dense_vec = dense_vec_hi

        global_vec = l2norm(global_vec)
        return fuse_dense_global(dense_vec, global_vec, alpha=self._alpha())

    @staticmethod
    def _color_jitter(crop):
        """Apply a simple color augmentation: 1.1x brightness."""
        import numpy as np
        return np.clip(crop.astype(np.int32) * 1.1, 0, 255).astype(np.uint8)

    @staticmethod
    def _bbox_mask(xyxy, crop_h, crop_w, feat_hw):
        import numpy as np
        H_f, W_f = feat_hw
        x1, y1, x2, y2 = xyxy
        fx1 = max(0, int(x1 / crop_w * W_f))
        fx2 = min(W_f, int(np.ceil(x2 / crop_w * W_f)))
        fy1 = max(0, int(y1 / crop_h * H_f))
        fy2 = min(H_f, int(np.ceil(y2 / crop_h * H_f)))
        m = np.zeros((H_f, W_f), dtype=bool)
        m[fy1:fy2, fx1:fx2] = True
        return m

    @staticmethod
    def _downsample_bool(mask, out_hw):
        import numpy as np
        H_out, W_out = out_hw
        H_in, W_in = mask.shape
        ys = (np.arange(H_out) * (H_in / H_out)).astype(int)
        xs = (np.arange(W_out) * (W_in / W_out)).astype(int)
        return mask[np.ix_(ys, xs)]

    def _extract_dense(self, state, *, scale):
        if f"_stub_dense_{scale}" in state:
            return state[f"_stub_dense_{scale}"]
        return self._extract_dense_from_native(state, scale=scale)

    def _extract_global(self, state):
        if "_stub_global" in state:
            return state["_stub_global"]
        return self._extract_global_from_native(state)

    def _alpha(self):
        import os
        try:
            return float(os.environ.get("SAM_VISUAL_PROMPT_ALPHA", "0.7"))
        except ValueError:
            return 0.7

    def _extract_dense_from_native(self, state, *, scale):
        """Read dense feature map from the native sam3 state.

        ``Sam3Processor.set_image`` stores backbone outputs under
        ``state["backbone_out"]`` with FPN levels in ``backbone_fpn``
        (highest-resolution stage first per the Hiera default config
        verified inside the model container):

          ``scale="hi"`` → ``backbone_fpn[0]`` (stride-4, 288x288x256)
          ``scale="lo"`` → ``backbone_fpn[1]`` (stride-8, 144x144x256)

        Returns an ``(H, W, C)`` float32 numpy array on CPU.
        """
        import torch  # type: ignore[import-not-found]

        fpn = state["backbone_out"]["backbone_fpn"]
        idx = 0 if scale == "hi" else 1
        feats = fpn[idx]
        if feats.dim() == 4:
            feats = feats[0]
        feats = feats.permute(1, 2, 0).contiguous()
        return feats.detach().to("cpu", dtype=torch.float32).numpy()

    def _extract_global_from_native(self, state):
        """Build a global pooled vector by mean-pooling the hi-res FPN."""
        import numpy as np

        dense_hi = self._extract_dense_from_native(state, scale="hi")
        return dense_hi.reshape(-1, dense_hi.shape[-1]).mean(axis=0)

    def extract_embedding(self) -> dict | None:
        """The native image model's encoder cache is internal — no clean
        serializable embedding handoff. Return None so the router falls
        back to server-side decode (verified-acceptable per Plan 12).
        """
        return None


def find_via_similarity_heatmap(
    adapter: "Sam3p1NativeImagePredictorAdapter",
    exemplar_vec: "np.ndarray",
    *,
    threshold: float = 0.5,
    top_k: int = 20,
) -> list[tuple[list[float], float]]:
    """Find candidate object boxes in the target image by cosine-similarity
    heatmap against the exemplar vector.

    v3.28 — replaces the broken ``predict_with_visual_prompt`` path that
    fed raw FPN features into the model's prompt slot (which expects
    prompt-space embeddings, not backbone features). Cosine similarity
    in dense feature space is well-behaved for visual concept matching.

    Pipeline:
      1. Pull dense feature map from the cached target state.
      2. L2-normalise both the dense map and the exemplar.
      3. Compute (Hf, Wf) cosine similarity heatmap.
      4. Threshold + 8-connectivity components → candidate regions.
      5. Project each component's bbox from feature grid to image space.
      6. Score each by the peak cosine similarity inside the component.
      7. NMS in image space; cap to ``top_k``.

    Args:
        adapter: a Sam3p1NativeImagePredictorAdapter with set_image already
            called on the target.
        exemplar_vec: L2-normed (D,) exemplar feature vector pooled from
            the source ref(s).
        threshold: minimum cosine similarity to count a region as a match.
            0.5 is a sensible default — visually similar regions usually
            score >= 0.5 in dense SAM features. Below 0.3 is essentially
            random.
        top_k: cap on returned candidates.

    Returns:
        List of ``(bbox_xyxy_image_space, peak_cosine_score)`` tuples,
        sorted by score descending. Empty list when no region clears the
        threshold.
    """
    import numpy as np

    if adapter._state is None:
        raise RuntimeError(
            "set_image must be called on the target before find_via_similarity_heatmap"
        )

    dense = adapter._extract_dense(adapter._state, scale="hi")  # (Hf, Wf, D)
    Hf, Wf, D = dense.shape
    flat = dense.reshape(-1, D)
    norms = np.linalg.norm(flat, axis=-1, keepdims=True)
    flat_n = flat / np.maximum(norms, 1e-12)
    heatmap = (flat_n @ exemplar_vec).reshape(Hf, Wf).astype(np.float32)

    if heatmap.max() < threshold:
        return []

    binary = (heatmap >= threshold).astype(np.uint8)

    # Connected components — cv2 if present, numpy fallback otherwise.
    try:
        import cv2  # type: ignore[import-not-found]

        n_components, labels = cv2.connectedComponents(binary, connectivity=8)
    except ImportError:
        n_components, labels = _numpy_connected_components(binary)

    H_img = adapter._original_size[0]
    W_img = adapter._original_size[1]
    sx = float(W_img) / float(Wf)
    sy = float(H_img) / float(Hf)

    candidates: list[tuple[list[float], float]] = []
    for label in range(1, n_components):
        mask = labels == label
        if not mask.any():
            continue
        peak_score = float(heatmap[mask].max())
        ys, xs = np.where(mask)
        y1, y2 = int(ys.min()), int(ys.max())
        x1, x2 = int(xs.min()), int(xs.max())
        ix1 = max(0.0, x1 * sx)
        iy1 = max(0.0, y1 * sy)
        ix2 = min(float(W_img), (x2 + 1) * sx)
        iy2 = min(float(H_img), (y2 + 1) * sy)
        if ix2 - ix1 < 4 or iy2 - iy1 < 4:
            continue
        candidates.append(([ix1, iy1, ix2, iy2], peak_score))

    candidates.sort(key=lambda t: -t[1])
    return _nms_candidates(candidates, iou_threshold=0.3)[:top_k]


def _numpy_connected_components(binary: "np.ndarray") -> tuple[int, "np.ndarray"]:
    """8-connectivity connected components without cv2.

    Iterative two-pass scan with union-find. Returns (n_labels_including_bg, labels).
    """
    import numpy as np

    H, W = binary.shape
    labels = np.zeros((H, W), dtype=np.int32)
    parent: list[int] = [0]

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)

    next_label = 1
    for y in range(H):
        for x in range(W):
            if not binary[y, x]:
                continue
            neighbors: list[int] = []
            if y > 0 and labels[y - 1, x] > 0:
                neighbors.append(int(labels[y - 1, x]))
            if x > 0 and labels[y, x - 1] > 0:
                neighbors.append(int(labels[y, x - 1]))
            if y > 0 and x > 0 and labels[y - 1, x - 1] > 0:
                neighbors.append(int(labels[y - 1, x - 1]))
            if y > 0 and x + 1 < W and labels[y - 1, x + 1] > 0:
                neighbors.append(int(labels[y - 1, x + 1]))
            if not neighbors:
                labels[y, x] = next_label
                parent.append(next_label)
                next_label += 1
            else:
                m = min(neighbors)
                labels[y, x] = m
                for n in neighbors:
                    union(m, n)

    # Second pass: resolve to roots and renumber compactly.
    root_to_compact: dict[int, int] = {0: 0}
    next_compact = 1
    for y in range(H):
        for x in range(W):
            if labels[y, x] == 0:
                continue
            r = find(int(labels[y, x]))
            if r not in root_to_compact:
                root_to_compact[r] = next_compact
                next_compact += 1
            labels[y, x] = root_to_compact[r]
    return next_compact, labels


def _nms_candidates(
    candidates: list[tuple[list[float], float]],
    *,
    iou_threshold: float = 0.3,
) -> list[tuple[list[float], float]]:
    """Greedy NMS over (bbox, score) tuples. Bboxes are xyxy floats."""
    if not candidates:
        return []
    kept: list[tuple[list[float], float]] = []
    for box, score in candidates:
        ok = True
        for kbox, _ in kept:
            if _bbox_iou(box, kbox) >= iou_threshold:
                ok = False
                break
        if ok:
            kept.append((box, score))
    return kept


def _bbox_iou(a: list[float], b: list[float]) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1 = max(ax1, bx1)
    iy1 = max(ay1, by1)
    ix2 = min(ax2, bx2)
    iy2 = min(ay2, by2)
    iw = max(0.0, ix2 - ix1)
    ih = max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def _native_visual_forward(
    model: Any,
    processor: Any,
    state: dict,
    *,
    visual_prompt_embed: Any,
    encode_text: bool = False,
) -> tuple[Any, Any, Any]:
    """Run a SAM 3.1 grounding forward with a visual concept (text disabled).

    The native ``Sam3Image.forward_grounding`` does not expose
    ``visual_prompt_embed`` through its kwargs — it always calls
    ``self._encode_prompt(backbone_out, find_input, geometric_prompt)``
    with no visual slot. To inject the visual embedding without forking
    the package, we monkey-patch ``model._encode_prompt`` for the
    duration of this call so the inner ``_encode_prompt`` receives our
    ``visual_prompt_embed`` and ``encode_text=False`` flags.

    Mirrors ``Sam3Processor.set_text_prompt`` + ``_forward_grounding``:
      1. Populate ``state["backbone_out"]`` with language features for
         the dummy ``"visual"`` token (so ``find_input.text_ids`` is
         valid even though we will skip text in encode_prompt).
      2. Install a dummy geometric prompt if absent.
      3. Patch ``_encode_prompt`` and invoke
         ``processor._forward_grounding(state)`` — this writes
         ``masks``, ``scores``, ``boxes`` onto ``state`` and returns it.
      4. Read masks/scores/boxes off ``state`` and return numpy arrays.
    """
    import numpy as np
    import torch  # type: ignore[import-not-found]

    if "backbone_out" not in state:
        raise RuntimeError(
            "native visual forward: state missing 'backbone_out' "
            "(set_image must be called first)",
        )

    # Coerce visual_prompt_embed into a torch tensor of shape (N, B, C)
    # on the model device. The adapter passes a numpy (1, 1, C) reshape.
    if isinstance(visual_prompt_embed, np.ndarray):
        embed_t = torch.from_numpy(visual_prompt_embed).to(
            device=processor.device, dtype=torch.float32,
        )
    elif isinstance(visual_prompt_embed, torch.Tensor):
        embed_t = visual_prompt_embed.to(
            device=processor.device, dtype=torch.float32,
        )
    else:
        embed_t = torch.tensor(
            visual_prompt_embed, device=processor.device, dtype=torch.float32,
        )
    if embed_t.dim() == 1:
        embed_t = embed_t.view(1, 1, -1)
    elif embed_t.dim() == 2:
        embed_t = embed_t.unsqueeze(1)

    n_tokens = int(embed_t.shape[0])
    batch_size = int(embed_t.shape[1])

    # mask shape is (batch, num_tokens) per torch.cat([..., visual_prompt_mask], dim=1)
    # in Sam3Image._encode_prompt. False means "valid" (not padded) for the
    # transformer's key_padding_mask convention used by the native model
    # (see geo_masks built in geometry_encoders).
    visual_prompt_mask = torch.zeros(
        (batch_size, n_tokens), device=processor.device, dtype=torch.bool,
    )

    # 1) Make sure language_features exist on the backbone_out so the
    #    find_stage's text_ids index is valid. We only need this because
    #    _encode_prompt indexes language_features even when encode_text
    #    is False (the index is computed but the slice is dropped).
    if "language_features" not in state["backbone_out"]:
        with torch.inference_mode():
            text_outputs = model.backbone.forward_text(
                ["visual"], device=processor.device,
            )
        state["backbone_out"].update(text_outputs)

    # 2) Install a dummy geometric prompt if none was provided.
    if "geometric_prompt" not in state:
        state["geometric_prompt"] = model._get_dummy_prompt()

    # 3) Monkey-patch _encode_prompt to inject our visual slot.
    original_encode_prompt = model._encode_prompt

    def patched_encode_prompt(
        backbone_out, find_input, geometric_prompt, **_unused,
    ):
        return original_encode_prompt(
            backbone_out,
            find_input,
            geometric_prompt,
            visual_prompt_embed=embed_t,
            visual_prompt_mask=visual_prompt_mask,
            encode_text=encode_text,
        )

    # Force the processor's internal confidence threshold to 0 during the
    # visual forward. SAM 3.1 PCS scores for visual prompts are
    # systematically much lower (~0.01-0.05) than text prompts, so the
    # processor's default 0.5 wipes every candidate before the api-side
    # threshold ever sees them. We restore the original threshold after.
    original_threshold = getattr(processor, "confidence_threshold", 0.5)
    try:
        processor.set_confidence_threshold(0.0)
    except Exception:  # noqa: BLE001 — best-effort
        pass

    model._encode_prompt = patched_encode_prompt
    try:
        with torch.inference_mode():
            processor._forward_grounding(state)
    finally:
        model._encode_prompt = original_encode_prompt
        try:
            processor.set_confidence_threshold(original_threshold)
        except Exception:  # noqa: BLE001
            pass

    # 4) Pull masks/scores/boxes off the state and return numpy.
    from carve_model.sam.perf import to_numpy_safe

    masks = state.get("masks")
    scores = state.get("scores")
    boxes = state.get("boxes")
    if masks is None or scores is None:
        return (
            np.zeros((0, state["original_height"], state["original_width"]), dtype=bool),
            np.zeros((0,), dtype=np.float32),
            np.zeros((0, 4), dtype=np.float32),
        )

    masks_np = to_numpy_safe(masks)
    if masks_np.ndim == 4 and masks_np.shape[1] == 1:
        masks_np = masks_np[:, 0]
    scores_np = to_numpy_safe(scores)
    boxes_np = to_numpy_safe(boxes) if boxes is not None else np.zeros(
        (masks_np.shape[0], 4), dtype=np.float32,
    )
    return masks_np, scores_np, boxes_np


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

    # Wire native visual-prompt forward onto ``model.predict_visual_prompt``
    # so ``Sam3p1NativeImagePredictorAdapter.predict_with_visual_prompt``
    # dispatches into the native sam3 grounding pass with text disabled
    # and our pooled embedding injected via the monkey-patched
    # ``_encode_prompt`` slot. Tests stub this attribute directly on
    # the model to bypass the native forward.
    def _bound_predict_visual_prompt(
        state, *, visual_prompt_embed, encode_text=False,
    ):
        return _native_visual_forward(
            model,
            processor,
            state,
            visual_prompt_embed=visual_prompt_embed,
            encode_text=encode_text,
        )

    model.predict_visual_prompt = _bound_predict_visual_prompt
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


def reset_native_image_predictor() -> bool:
    """Drop the module-level sam3.1 native image-predictor singleton.

    Returns True if a singleton was actually present. Used by the
    System page's force-unload path so the native sam3.1 model
    (~5 GB on GPU) gets released alongside SAM 3 transformers
    factories. The next text/box/point call rebuilds lazily.
    """
    global _NATIVE_IMAGE_PREDICTOR
    if _NATIVE_IMAGE_PREDICTOR is None:
        return False
    adapter = _NATIVE_IMAGE_PREDICTOR
    # Clear inner refs so the model + state dict become collectable.
    try:
        adapter._state = None  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass
    try:
        adapter._model = None  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass
    try:
        adapter._processor = None  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass
    _NATIVE_IMAGE_PREDICTOR = None
    return True


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
        *,
        image_b64: str,
        text: str,
        use_vlm_fo1: bool = False,
        threshold: float | None = None,
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

        # Mirror the visual-prompt path: temporarily lower the processor's
        # internal confidence floor to the user's UI threshold so SAM 3.1
        # returns its mid-confidence candidates. The default 0.5 used to
        # silently wipe everything below before the api-side gate ever
        # saw it — exactly the "obvious pants not detected even at 0.20"
        # accuracy regression. Restore the original floor afterwards so
        # we don't mutate global predictor state across calls.
        processor = adapter._processor
        if threshold is not None:
            original_threshold = getattr(processor, "confidence_threshold", 0.5)
            try:
                processor.set_confidence_threshold(float(threshold))
            except Exception:  # noqa: BLE001 — best-effort
                original_threshold = None
        else:
            original_threshold = None

        try:
            if adapter._device == "cuda":
                with torch.no_grad():
                    with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
                        processor.set_text_prompt(text, state)
            else:
                with torch.no_grad():
                    processor.set_text_prompt(text, state)
        finally:
            if original_threshold is not None:
                try:
                    processor.set_confidence_threshold(original_threshold)
                except Exception:  # noqa: BLE001
                    pass

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

        # Diagnostic: emit the score envelope so "no matches" reports are
        # easy to root-cause from logs (model returned zero proposals vs.
        # model returned proposals all below the user's threshold).
        if rows:
            top_score = rows[0]["score"]
            min_score = rows[-1]["score"]
        else:
            top_score = 0.0
            min_score = 0.0
        _logger.info(
            "sam3.1 text-prompt: text=%r threshold=%s detections=%d "
            "score_range=[%.3f, %.3f]",
            text,
            f"{threshold:.3f}" if threshold is not None else "default",
            len(rows),
            min_score,
            top_score,
        )

        # v3.22 GPU-hygiene: drop GPU tensors from the state dict
        # (masks_logits, masks, boxes, scores, text features) and run
        # empty_cache so the allocator can reclaim them before the next
        # batch iteration. Without this, sequential auto-annotate
        # requests accumulate intermediate tensors and OOM.
        boxes_np = None  # noqa: F841 — drop GPU ref
        boxes = None  # noqa: F841
        if "masks_logits" in state:
            state["masks_logits"] = None
        if "masks" in state:
            state["masks"] = None
        if "boxes" in state:
            state["boxes"] = None
        if "scores" in state:
            state["scores"] = None
        if adapter._device == "cuda":
            torch.cuda.empty_cache()

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
                with torch.no_grad():
                    with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
                        adapter._processor.set_text_prompt(text, state)
            else:
                with torch.no_grad():
                    adapter._processor.set_text_prompt(text, state)

        positive_masks: list[Any] = []
        negative_masks: list[Any] = []
        positive_scores: list[float] = []
        positive_boxes: list[list[float]] = []

        for box, label in zip(boxes, box_labels, strict=False):
            box_arr = np.asarray(box, dtype=np.float32).reshape(-1)
            if adapter._device == "cuda":
                with torch.no_grad():
                    with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
                        masks, scores, _ = adapter._model.predict_inst(
                            state,
                            point_coords=None,
                            point_labels=None,
                            box=box_arr,
                            multimask_output=False,
                        )
            else:
                with torch.no_grad():
                    masks, scores, _ = adapter._model.predict_inst(
                        state,
                        point_coords=None,
                        point_labels=None,
                        box=box_arr,
                        multimask_output=False,
                    )
            if masks is None or len(masks) == 0:
                # Drop GPU refs even on the no-mask path, then continue.
                masks = None  # noqa: F841
                scores = None  # noqa: F841
                continue
            best_idx = int(np.argmax(np.asarray(scores)))
            best_mask = np.asarray(masks[best_idx]).astype(np.uint8)
            best_score = float(np.asarray(scores)[best_idx])
            # v3.22 GPU-hygiene: free the per-iteration GPU outputs
            # AFTER copying to numpy. Without this, K-output × N-box
            # accumulates VRAM in a multi-box request.
            masks = None  # noqa: F841
            scores = None  # noqa: F841
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

        # v3.22 GPU-hygiene: clear residual state-dict GPU tensors and
        # run empty_cache so the allocator returns memory between
        # /sam/box-prompt requests.
        if "masks_logits" in state:
            state["masks_logits"] = None
        if "masks" in state:
            state["masks"] = None
        if "boxes" in state:
            state["boxes"] = None
        if "scores" in state:
            state["scores"] = None
        if adapter._device == "cuda":
            torch.cuda.empty_cache()

        return rows

    return _predict_from_boxes
