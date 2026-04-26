"""SAM 3 adapters that conform to the SamPredictor + TrackerProtocol contracts.

SAM 3 ships **four** transformers classes (model card, v5.6.x):

- ``Sam3Model`` + ``Sam3Processor`` — image **concept** segmentation
  (text + boxes; **does NOT accept points**). Used by /sam/text-prompt
  and /sam/box-prompt.
- ``Sam3VideoModel`` + ``Sam3VideoProcessor`` — video **concept** tracking
  (text only). Used by /sam-track/start when the caller passes ``text``.
- ``Sam3TrackerModel`` + ``Sam3TrackerProcessor`` — drop-in SAM 2 image
  replacement (points + boxes + masks). Used by /sam/decode for clicks.
- ``Sam3TrackerVideoModel`` + ``Sam3TrackerVideoProcessor`` — drop-in
  SAM 2 video replacement (points + boxes + masks at frames). Used by
  /sam-track/start when the caller passes ``points`` + ``labels``.

The image-side adapter (``Sam3ImagePredictorAdapter``) wraps the
**Tracker** classes — clicks are SAM 2-style, not concept-based.

The video-side adapter (``Sam3VideoDispatcherAdapter``) holds BOTH the
Sam3VideoModel pair (text concept) AND the Sam3TrackerVideoModel pair
(points/boxes). The adapter inspects the first ``add_new_points`` call
and decides which sub-tracker to use:

- ``points=["person"]`` (string list) → text concept → Sam3VideoModel
- ``points=[[x, y], ...], labels=[1/0, ...]`` → click → Sam3TrackerVideoModel

Loaded ONLY when ``SAM_MODEL=sam3``. ``transformers`` and ``torch``
imports are deferred to method bodies so the dev path (no torch /
transformers in the venv) keeps working — the broader 182 model test
suite must stay torch/transformers-free.
"""

from __future__ import annotations

from typing import Any


# --- image adapter (clicks → Sam3TrackerModel) ------------------------------


class Sam3ImagePredictorAdapter:
    """Wrap ``Sam3TrackerModel`` + ``Sam3TrackerProcessor`` to look like
    SAM 2's image predictor.

    The Sam3TrackerModel is the **drop-in SAM 2 replacement** half of SAM 3
    — it accepts point/box/mask prompts (NOT text concepts) and returns
    K=3 multimask candidates per object. The router picks the highest
    scoring mask via ``np.argmax(scores)``.

    Lifecycle: ``set_image(img)`` caches the raw image and best-effort
    vision features. ``predict(points, labels, multimask_output)`` runs
    the model and returns ``(masks, scores, _)`` where ``masks`` is shape
    ``(K, H, W)`` matching the existing ``/sam/decode`` contract.
    """

    def __init__(self, model: Any, processor: Any, device: str) -> None:
        self._model = model
        self._processor = processor
        self._device = device
        # Cache populated by set_image().
        self._raw_image: Any = None
        self._original_size: tuple[int, int] | None = None  # (h, w)
        # Mirror SAM 2's _features dict so extract_embedding() works without
        # a special case in router.py:encode.
        self._features: dict[str, Any] | None = None

    def set_image(self, image: Any) -> None:
        """Cache PIL-converted image + best-effort vision embedding for one image.

        ``image`` is a numpy ``HxWx3`` RGB array (set by router.py:encode).
        """
        from PIL import Image  # type: ignore[import-not-found]
        import torch  # type: ignore[import-not-found]

        h, w = int(image.shape[0]), int(image.shape[1])
        self._raw_image = Image.fromarray(image)
        self._original_size = (h, w)
        # Best-effort: pre-compute vision embeddings so extract_embedding()
        # has something to serialize. Fail closed — None means "no embedding"
        # which the router handles by falling back to server-side decode.
        try:
            inputs = self._processor(images=self._raw_image, return_tensors="pt").to(
                self._device,
            )
            pix = inputs["pixel_values"] if isinstance(inputs, dict) else getattr(
                inputs, "pixel_values", None,
            )
            with torch.no_grad():
                feats = self._model.get_vision_features(pixel_values=pix)
            self._features = {"image_embed": feats}
        except Exception:
            self._features = None

    def predict(
        self,
        point_coords: Any,
        point_labels: Any,
        multimask_output: bool = True,
    ) -> tuple[Any, Any, Any]:
        """Run a click-prompt forward pass and return ``(masks, scores, None)``.

        Sam3TrackerModel returns ``outputs.pred_masks`` of shape
        ``[batch=1, num_obj=1, K=3, H, W]`` plus an ``iou_scores`` tensor.
        We post-process via ``processor.post_process_masks`` (which collapses
        the batch dim) and return shape ``(K, H, W)`` so the router's
        existing argmax logic continues to work.
        """
        if self._raw_image is None or self._original_size is None:
            raise RuntimeError("set_image must be called before predict")
        import numpy as np
        import torch  # type: ignore[import-not-found]

        pts = np.asarray(point_coords, dtype=np.float32).reshape(-1, 2).tolist()
        lbls = np.asarray(point_labels, dtype=np.int64).reshape(-1).tolist()
        # Sam3TrackerProcessor expects [batch][num_obj][num_pts][xy] for
        # input_points and [batch][num_obj][num_pts] for input_labels.
        # We treat the click set as a single object (matches /sam/decode).
        input_points = [[[[float(p[0]), float(p[1])] for p in pts]]]
        input_labels = [[[int(label) for label in lbls]]]
        inputs = self._processor(
            images=self._raw_image,
            input_points=input_points,
            input_labels=input_labels,
            return_tensors="pt",
        ).to(self._device)

        with torch.no_grad():
            outputs = self._model(**inputs)

        # outputs.pred_masks shape: [batch=1, num_obj=1, K=3, H, W]
        pred_masks = outputs.pred_masks
        # Move to cpu before post_process_masks if applicable.
        if hasattr(pred_masks, "cpu"):
            pred_masks = pred_masks.cpu()
        original_sizes = inputs["original_sizes"] if "original_sizes" in inputs else [
            [self._original_size[0], self._original_size[1]],
        ]
        masks = self._processor.post_process_masks(pred_masks, original_sizes)[0]
        # masks shape after post_process_masks for a single image:
        # [num_obj=1, K=3, H, W] (we collapse batch in the call above).
        scores_tensor = getattr(outputs, "iou_scores", None)
        if scores_tensor is not None and hasattr(scores_tensor, "cpu"):
            scores_tensor = scores_tensor.cpu()

        # Reshape masks to (K, H, W) — take first object — and scores to (K,).
        masks_ndim = getattr(masks, "ndim", None)
        if masks_ndim is None:
            import numpy as _np
            masks_ndim = _np.asarray(masks).ndim
        if masks_ndim == 4:
            # [num_obj, K, H, W] → take first object → (K, H, W)
            masks_for_router = masks[0]
        elif masks_ndim == 3:
            # Already (K, H, W) or (num_obj, H, W) — single obj/no-multimask.
            masks_for_router = masks
        else:
            raise RuntimeError(
                f"unexpected SAM 3 tracker mask shape: ndim={masks_ndim}",
            )

        # Number of returned mask candidates determines score length.
        try:
            n_masks = len(masks_for_router)
        except TypeError:
            n_masks = int(masks_for_router.shape[0])

        if scores_tensor is not None:
            # iou_scores shape: [batch=1, num_obj=1, K]; flatten to (K,) and
            # keep only the first n_masks values defensively.
            flat = scores_tensor.flatten() if hasattr(scores_tensor, "flatten") else scores_tensor
            scores_for_router = flat[:n_masks] if hasattr(flat, "__getitem__") else flat
        else:
            scores_for_router = torch.ones((n_masks,), dtype=torch.float32)

        return masks_for_router, scores_for_router, None


def build_sam3_image_predictor(device: str | None = None) -> Sam3ImagePredictorAdapter:
    """Eager construction. Imports transformers + torch — only call when
    ``SAM_MODEL=sam3`` and the GPU extras are installed.

    Loads the **Tracker** image classes (the drop-in SAM 2 replacement)
    so /sam/decode click prompts work. Text and box concept prompts use
    Sam3Model + Sam3Processor via ``_build_concept_image_pair`` below.
    """
    import torch  # type: ignore[import-not-found]
    from transformers import (  # type: ignore[import-not-found]
        Sam3TrackerModel,
        Sam3TrackerProcessor,
    )

    dev = device or ("cuda" if torch.cuda.is_available() else "cpu")
    dtype = torch.bfloat16 if dev == "cuda" else torch.float32
    model = Sam3TrackerModel.from_pretrained("facebook/sam3").to(dev, dtype=dtype)
    processor = Sam3TrackerProcessor.from_pretrained("facebook/sam3")
    return Sam3ImagePredictorAdapter(model=model, processor=processor, device=dev)


# --- helper: load Sam3Model + Sam3Processor for concept (text/box) ----------


def _build_concept_image_pair() -> tuple[Any, Any, str]:
    """Return ``(Sam3Model, Sam3Processor, device)`` lazily.

    Used by ``make_sam3_text_predictor`` and ``make_sam3_box_predictor``.
    Patched in tests to return fakes.
    """
    import torch  # type: ignore[import-not-found]
    from transformers import (  # type: ignore[import-not-found]
        Sam3Model,
        Sam3Processor,
    )

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16 if dev == "cuda" else torch.float32
    model = Sam3Model.from_pretrained("facebook/sam3").to(dev, dtype=dtype)
    processor = Sam3Processor.from_pretrained("facebook/sam3")
    return model, processor, dev


# --- text predictor for /sam/text-prompt (Sam3Model) ------------------------


def make_sam3_text_predictor():
    """Return a callable matching the ``TextPredictor`` contract.

    Signature: ``fn(*, image_b64: str, text: str) -> list[dict]`` where each
    dict has keys ``counts, size, score, bbox``.

    Uses Sam3Model + Sam3Processor (the **concept** classes — these are the
    correct backbone for text-driven concept segmentation; the Tracker
    classes do NOT accept text prompts).

    Maintains a closure-private singleton so the model is loaded at most
    once across calls.
    """
    _state: dict[str, Any] = {}

    def _ensure_loaded() -> None:
        if "model" in _state:
            return
        model, processor, device = _build_concept_image_pair()
        _state["model"] = model
        _state["processor"] = processor
        _state["device"] = device

    def _predict_from_text(*, image_b64: str, text: str) -> list[dict]:
        import base64
        from io import BytesIO

        import numpy as np
        import torch  # type: ignore[import-not-found]
        from PIL import Image  # type: ignore[import-not-found]

        from vaa_model.sam.codec import encode_mask_rle

        _ensure_loaded()
        img_bytes = base64.b64decode(image_b64)
        pil = Image.open(BytesIO(img_bytes)).convert("RGB")
        h, w = pil.size[1], pil.size[0]

        proc = _state["processor"]
        model = _state["model"]
        device = _state["device"]
        inputs = proc(images=pil, text=text, return_tensors="pt").to(device)
        with torch.no_grad():
            outputs = model(**inputs)
        results = proc.post_process_instance_segmentation(
            outputs,
            threshold=0.5,
            mask_threshold=0.5,
            target_sizes=[[h, w]],
        )[0]
        masks = results.get("masks") if hasattr(results, "get") else None
        scores = results.get("scores") if hasattr(results, "get") else None
        boxes = results.get("boxes") if hasattr(results, "get") else None
        out: list[dict] = []
        if masks is None:
            return out
        for i in range(len(masks)):
            mask_np = masks[i].cpu().numpy().astype(np.uint8)
            counts, size = encode_mask_rle(mask_np)
            box = boxes[i].cpu().numpy().tolist() if boxes is not None else [0, 0, 0, 0]
            score_val = float(scores[i].item()) if scores is not None else 1.0
            out.append({
                "counts": counts,
                "size": size,
                "score": score_val,
                "bbox": [float(x) for x in box],
            })
        return out

    return _predict_from_text


# --- box predictor for /sam/box-prompt (Sam3Model) --------------------------


def make_sam3_box_predictor():
    """Return a callable matching the ``BoxPredictor`` contract.

    Signature: ``fn(*, image_b64, boxes, box_labels, text=None) -> list[dict]``
    where each output dict has keys ``counts, size, score, bbox``.

    Uses Sam3Model + Sam3Processor (the **concept** classes). The processor
    accepts ``input_boxes`` (xyxy) plus ``input_boxes_labels`` (1=positive
    include, 0=negative exclude). Combining ``text`` with negative boxes
    refines a text concept by excluding regions that the model would
    otherwise pick up.
    """
    _state: dict[str, Any] = {}

    def _ensure_loaded() -> None:
        if "model" in _state:
            return
        model, processor, device = _build_concept_image_pair()
        _state["model"] = model
        _state["processor"] = processor
        _state["device"] = device

    def _predict_from_boxes(
        *,
        image_b64: str,
        boxes,
        box_labels,
        text: str | None = None,
    ) -> list[dict]:
        import base64
        from io import BytesIO

        import numpy as np
        import torch  # type: ignore[import-not-found]
        from PIL import Image  # type: ignore[import-not-found]

        from vaa_model.sam.codec import encode_mask_rle

        _ensure_loaded()
        img_bytes = base64.b64decode(image_b64)
        pil = Image.open(BytesIO(img_bytes)).convert("RGB")
        h, w = pil.size[1], pil.size[0]

        proc = _state["processor"]
        model = _state["model"]
        device = _state["device"]

        # Sam3Processor box wiring:
        #   input_boxes:        [batch, num_objects, 4]   (xyxy float)
        #   input_boxes_labels: [batch, num_objects]      (1 or 0)
        boxes_arg = [[[float(x) for x in b] for b in boxes]]
        labels_arg = [[int(label) for label in box_labels]]

        inputs = proc(
            images=pil,
            text=text,
            input_boxes=boxes_arg,
            input_boxes_labels=labels_arg,
            return_tensors="pt",
        ).to(device)
        with torch.no_grad():
            outputs = model(**inputs)
        results = proc.post_process_instance_segmentation(
            outputs,
            threshold=0.5,
            mask_threshold=0.5,
            target_sizes=[[h, w]],
        )[0]
        masks = results.get("masks") if hasattr(results, "get") else None
        scores = results.get("scores") if hasattr(results, "get") else None
        boxes_out = results.get("boxes") if hasattr(results, "get") else None
        out: list[dict] = []
        if masks is None:
            return out
        for i in range(len(masks)):
            mask_np = masks[i].cpu().numpy().astype(np.uint8)
            counts, size = encode_mask_rle(mask_np)
            box = (
                boxes_out[i].cpu().numpy().tolist()
                if boxes_out is not None
                else [0.0, 0.0, 0.0, 0.0]
            )
            score_val = float(scores[i].item()) if scores is not None else 1.0
            out.append({
                "counts": counts,
                "size": size,
                "score": score_val,
                "bbox": [float(x) for x in box],
            })
        return out

    return _predict_from_boxes


# --- video dispatcher (points → Tracker; text → Concept) --------------------


class Sam3VideoDispatcherAdapter:
    """Routes points → Sam3TrackerVideoModel; text → Sam3VideoModel.

    This adapter implements ``TrackerProtocol`` but internally holds two
    sub-tracker pairs:

    - **Tracker pair** (Sam3TrackerVideoModel + Sam3TrackerVideoProcessor)
      for SAM 2-style point/box prompting at frames via
      ``add_inputs_to_inference_session(...)``.
    - **Concept pair** (Sam3VideoModel + Sam3VideoProcessor) for
      text-driven concept tracking via ``add_text_prompt(...)``.

    The chosen sub-tracker is decided at the first ``add_new_points`` call
    based on the prompt type passed by the router. Both sub-tracker pairs
    are loaded lazily.
    """

    def __init__(self, device: str) -> None:
        self._device = device
        # Lazy-loaded sub-trackers.
        self._tracker_model: Any = None
        self._tracker_processor: Any = None
        self._concept_model: Any = None
        self._concept_processor: Any = None

    # -- lazy loaders --------------------------------------------------------

    def _load_tracker(self) -> tuple[Any, Any]:
        if self._tracker_model is None:
            import torch  # type: ignore[import-not-found]
            from transformers import (  # type: ignore[import-not-found]
                Sam3TrackerVideoModel,
                Sam3TrackerVideoProcessor,
            )

            dtype = torch.bfloat16 if self._device == "cuda" else torch.float32
            self._tracker_model = Sam3TrackerVideoModel.from_pretrained(
                "facebook/sam3",
            ).to(self._device, dtype=dtype)
            self._tracker_processor = Sam3TrackerVideoProcessor.from_pretrained(
                "facebook/sam3",
            )
        return self._tracker_model, self._tracker_processor

    def _load_concept(self) -> tuple[Any, Any]:
        if self._concept_model is None:
            import torch  # type: ignore[import-not-found]
            from transformers import (  # type: ignore[import-not-found]
                Sam3VideoModel,
                Sam3VideoProcessor,
            )

            dtype = torch.bfloat16 if self._device == "cuda" else torch.float32
            self._concept_model = Sam3VideoModel.from_pretrained(
                "facebook/sam3",
            ).to(self._device, dtype=dtype)
            self._concept_processor = Sam3VideoProcessor.from_pretrained(
                "facebook/sam3",
            )
        return self._concept_model, self._concept_processor

    # -- TrackerProtocol -----------------------------------------------------

    def init_state(self, video_path: str) -> dict:
        """Load the video frames; defer choosing tracker vs. concept until
        ``add_new_points`` reveals the prompt type."""
        from transformers.video_utils import load_video  # type: ignore[import-not-found]

        frames, _ = load_video(video_path)
        return {
            "video_frames": frames,
            "session": None,
            "model": None,
            "processor": None,
            "mode": None,
        }

    def add_new_points(
        self,
        inference_state: Any,
        frame_idx: int,
        points: Any,
        labels: Any,
    ) -> tuple[Any, Any, Any]:
        """Inspect ``points`` to decide which sub-tracker to use.

        - ``points`` is a string or list of strings → text concept →
          Sam3VideoModel.add_text_prompt
        - ``points`` is a list of [x, y] pairs (numeric) with matching
          ``labels`` → click → Sam3TrackerVideoModel.add_inputs_to_inference_session
        """
        if not points:
            raise RuntimeError(
                "SAM 3 video tracker requires points or text — got empty prompt",
            )

        is_text_mode = isinstance(points, str) or (
            isinstance(points, list)
            and len(points) > 0
            and all(isinstance(t, str) for t in points)
        )
        if is_text_mode:
            self._add_text(inference_state, points)
        else:
            self._add_points(inference_state, frame_idx, points, labels)
        return None, None, None

    def propagate_in_video(self, inference_state: Any) -> Any:
        if inference_state.get("session") is None:
            return
        if inference_state["mode"] == "tracker":
            yield from self._propagate_tracker(inference_state)
        elif inference_state["mode"] == "concept":
            yield from self._propagate_concept(inference_state)

    # -- internal helpers ----------------------------------------------------

    def _add_text(self, state: dict, points: Any) -> None:
        import torch  # type: ignore[import-not-found]

        model, processor = self._load_concept()
        if state["session"] is None:
            dtype = torch.bfloat16 if self._device == "cuda" else torch.float32
            state["session"] = processor.init_video_session(
                video=state["video_frames"],
                inference_device=self._device,
                processing_device="cpu",
                video_storage_device="cpu",
                dtype=dtype,
            )
            state["model"] = model
            state["processor"] = processor
            state["mode"] = "concept"
        texts = [points] if isinstance(points, str) else list(points)
        for t in texts:
            processor.add_text_prompt(inference_session=state["session"], text=t)

    def _add_points(
        self,
        state: dict,
        frame_idx: int,
        points: Any,
        labels: Any,
    ) -> None:
        import torch  # type: ignore[import-not-found]

        model, processor = self._load_tracker()
        if state["session"] is None:
            dtype = torch.bfloat16 if self._device == "cuda" else torch.float32
            state["session"] = processor.init_video_session(
                video=state["video_frames"],
                inference_device=self._device,
                dtype=dtype,
            )
            state["model"] = model
            state["processor"] = processor
            state["mode"] = "tracker"

        # Flat list of [x, y] points + a flat list of labels for ONE object.
        # Pack into [batch=1][num_obj=1][num_pts][xy] / [batch=1][num_obj=1][num_pts]
        # ann_obj_id = 1 by default (single-object protocol; multi-object
        # support is a v1.4 enhancement).
        nested_points = [[[ list(p) for p in points ]]]
        nested_labels = [[ list(labels) ]]
        processor.add_inputs_to_inference_session(
            inference_session=state["session"],
            frame_idx=int(frame_idx),
            obj_ids=1,
            input_points=nested_points,
            input_labels=nested_labels,
        )

    def _propagate_tracker(self, state: dict) -> Any:
        import numpy as np

        session = state["session"]
        height = getattr(session, "video_height", 0) or 0
        width = getattr(session, "video_width", 0) or 0
        original_sizes = [[int(height), int(width)]] if height and width else None
        for output in state["model"].propagate_in_video_iterator(session):
            pred_masks = output.pred_masks
            if hasattr(pred_masks, "cpu"):
                pred_masks = pred_masks.cpu()
            if original_sizes is not None:
                masks = state["processor"].post_process_masks(
                    [pred_masks],
                    original_sizes=original_sizes,
                    binarize=True,
                )[0]
            else:
                masks = pred_masks
            mask_np = self._first_mask_to_numpy(masks)
            yield int(getattr(output, "frame_idx", 0)), mask_np

    def _propagate_concept(self, state: dict) -> Any:
        import numpy as np

        for model_outputs in state["model"].propagate_in_video_iterator(
            inference_session=state["session"],
        ):
            processed = state["processor"].postprocess_outputs(
                state["session"], model_outputs,
            )
            masks = processed.get("masks") if hasattr(processed, "get") else None
            scores = processed.get("scores") if hasattr(processed, "get") else None
            frame_idx = getattr(model_outputs, "frame_idx", 0)
            if masks is None or len(masks) == 0:
                yield int(frame_idx), np.zeros((1, 1), dtype=np.uint8)
                continue
            if scores is not None and len(scores) > 0:
                best_idx = int(scores.argmax().item())
            else:
                best_idx = 0
            best_mask = masks[best_idx].cpu().numpy().astype(np.uint8)
            yield int(frame_idx), best_mask

    @staticmethod
    def _first_mask_to_numpy(masks: Any) -> Any:
        """Squeeze ``masks`` down to a 2-D ``(H, W)`` numpy array.

        Tracker masks come out as ``[num_obj, K, H, W]`` or ``[num_obj, H, W]``.
        We take object 0, candidate 0 as the single-object output for v1.3.
        """
        import numpy as np

        if hasattr(masks, "cpu"):
            t = masks.cpu()
            arr = t.numpy() if hasattr(t, "numpy") else np.asarray(t)
        elif hasattr(masks, "numpy"):
            arr = masks.numpy()
        else:
            arr = np.asarray(masks)
        if arr.ndim == 4:
            arr = arr[0, 0]
        elif arr.ndim == 3:
            arr = arr[0]
        return arr.astype(np.uint8)


def build_sam3_video_tracker(device: str | None = None) -> Sam3VideoDispatcherAdapter:
    """Construct the SAM 3 video dispatcher.

    Returns a ``Sam3VideoDispatcherAdapter`` whose underlying transformers
    classes are loaded lazily on the first ``add_new_points`` call. This
    means the dispatcher can be created without touching transformers if
    the caller never starts a session — useful when SAM_MODEL=sam3 is set
    but only the image surface is exercised.
    """
    import torch  # type: ignore[import-not-found]

    dev = device or ("cuda" if torch.cuda.is_available() else "cpu")
    return Sam3VideoDispatcherAdapter(device=dev)
