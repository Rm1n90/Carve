"""SAM 3 adapters that conform to the SamPredictor + TrackerProtocol contracts.

Loaded ONLY when ``SAM_MODEL=sam3``. ``transformers`` and ``torch`` imports
are deferred to method bodies and registration helpers so the dev path
(no torch/transformers in the venv) keeps working — the broader 123 model
test suite must stay torch/transformers-free.

The image-side adapter handles:

- Click/point prompts (positive=1, negative=0) via the processor's
  ``input_points`` + ``input_labels`` slots.
- A separate text-prompt callable for the ``/sam/text-prompt`` endpoint
  shell registered via ``set_text_predictor``.

The video-side adapter implements ``TrackerProtocol`` but uses *text*
prompts internally — SAM 3's video tracker is concept-based, not
point-based. ``add_new_points`` accepts the text prompt(s) via the
``points`` slot (the tracker router forwards ``[payload.text]`` when
``SAM_MODEL=sam3``); numeric points raise a ``RuntimeError`` with a clear
message so callers don't silently get unexpected behavior.
"""

from __future__ import annotations

from typing import Any


# --- image adapter ----------------------------------------------------------


class Sam3ImagePredictorAdapter:
    """Wrap ``Sam3Model`` + ``Sam3Processor`` to look like SAM 2's image predictor.

    Lifecycle: ``set_image(img)`` caches the processed pixel_values + the
    original ``(h, w)`` size. ``predict(points, labels, multimask_output)``
    then reuses that cache, runs the model, and returns
    ``(masks, scores, _)`` where ``masks`` is shape ``(K, H, W)`` matching
    the existing ``/sam/decode`` contract — the router picks the highest
    scoring mask via ``np.argmax(scores)``.
    """

    def __init__(self, model: Any, processor: Any, device: str) -> None:
        self._model = model
        self._processor = processor
        self._device = device
        # Cache populated by set_image().
        self._pixel_values: Any = None
        self._original_size: tuple[int, int] | None = None  # (h, w)
        # Mirror SAM 2's _features dict so extract_embedding() works without
        # a special case in router.py:encode.
        self._features: dict[str, Any] | None = None

    def set_image(self, image: Any) -> None:
        """Cache processor outputs + best-effort vision embedding for one image.

        ``image`` is a numpy ``HxWx3`` RGB array (set by router.py:encode).
        """
        from PIL import Image  # transformers expects PIL  # type: ignore[import-not-found]
        import torch  # type: ignore[import-not-found]

        h, w = int(image.shape[0]), int(image.shape[1])
        pil = Image.fromarray(image)
        inputs = self._processor(images=pil, return_tensors="pt").to(self._device)
        self._pixel_values = inputs["pixel_values"]
        self._original_size = (h, w)
        # Best-effort: pre-compute vision embeddings so extract_embedding()
        # has something to serialize. Fail closed — None means "no embedding"
        # which the router handles by falling back to server-side decode.
        try:
            with torch.no_grad():
                feats = self._model.get_vision_features(pixel_values=self._pixel_values)
            self._features = {"image_embed": feats}
        except Exception:
            self._features = None

    def predict(
        self,
        point_coords: Any,
        point_labels: Any,
        multimask_output: bool = True,
    ) -> tuple[Any, Any, Any]:
        """Run a click-prompt forward pass and return (masks, scores, None)."""
        if self._pixel_values is None or self._original_size is None:
            raise RuntimeError("set_image must be called before predict")
        import numpy as np
        import torch  # type: ignore[import-not-found]

        pts = np.asarray(point_coords, dtype=np.float32).reshape(-1, 2).tolist()
        lbls = np.asarray(point_labels, dtype=np.int64).reshape(-1).tolist()
        # The processor expects [batch, num_objects, num_points, 2] for
        # input_points and [batch, num_objects, num_points] for input_labels.
        # We treat the click set as a single object (matches /sam/decode).
        proc_inputs = self._processor(
            images=None,
            input_points=[[pts]],
            input_labels=[[lbls]],
            return_tensors="pt",
        ).to(self._device)
        # Pixel values were cached from set_image; merge them in so the
        # model sees the original image alongside the new prompts.
        merged = {**dict(proc_inputs), "pixel_values": self._pixel_values}

        with torch.no_grad():
            outputs = self._model(**merged)

        h, w = self._original_size
        results = self._processor.post_process_instance_segmentation(
            outputs,
            threshold=0.0,
            mask_threshold=0.5,
            target_sizes=[[h, w]],
        )[0]

        masks = results.get("masks") if hasattr(results, "get") else None
        scores = results.get("scores") if hasattr(results, "get") else None
        if masks is None or scores is None or len(masks) == 0:
            # No detections → emit a single zero mask so the existing router
            # produces a benign empty RLE rather than 500.
            empty = torch.zeros((1, h, w), dtype=torch.bool)
            empty_score = torch.zeros((1,), dtype=torch.float32)
            return empty, empty_score, None
        return masks, scores, None


def build_sam3_image_predictor(device: str | None = None) -> Sam3ImagePredictorAdapter:
    """Eager construction. Imports transformers + torch — only call when
    ``SAM_MODEL=sam3`` and the GPU extras are installed.
    """
    import torch  # type: ignore[import-not-found]
    from transformers import Sam3Model, Sam3Processor  # type: ignore[import-not-found]

    dev = device or ("cuda" if torch.cuda.is_available() else "cpu")
    dtype = torch.bfloat16 if dev == "cuda" else torch.float32
    model = Sam3Model.from_pretrained("facebook/sam3").to(dev, dtype=dtype)
    processor = Sam3Processor.from_pretrained("facebook/sam3")
    return Sam3ImagePredictorAdapter(model=model, processor=processor, device=dev)


# --- text predictor for /sam/text-prompt ------------------------------------


def make_sam3_text_predictor():
    """Return a callable matching the ``TextPredictor`` contract.

    Signature: ``fn(*, image_b64: str, text: str) -> list[dict]`` where each
    dict has keys ``counts, size, score, bbox``.

    Maintains a closure-private singleton of the underlying Sam3Model +
    Sam3Processor so the model is loaded at most once across calls.
    """
    _state: dict[str, Any] = {}

    def _ensure_loaded() -> None:
        if "model" in _state:
            return
        adapter = build_sam3_image_predictor()
        _state["model"] = adapter._model  # noqa: SLF001 — adapter exposes internals deliberately
        _state["processor"] = adapter._processor  # noqa: SLF001
        _state["device"] = adapter._device  # noqa: SLF001

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


# --- video tracker adapter --------------------------------------------------


class Sam3VideoTrackerAdapter:
    """``TrackerProtocol``-compatible wrapper around ``Sam3VideoModel``.

    Important: SAM 3's video tracker uses TEXT prompts, not points. The
    adapter expects ``add_new_points`` to receive text via the ``points``
    slot. The ``/sam-track/start`` router forwards ``[payload.text]`` when
    ``SAM_MODEL=sam3`` is selected. If a numeric point list is passed,
    ``add_new_points`` raises ``RuntimeError`` with a helpful message so
    the caller doesn't silently get unexpected concept tracking behavior.

    Internal state lives on the inference_session returned by ``init_state``.
    """

    def __init__(self, model: Any, processor: Any, device: str) -> None:
        self._model = model
        self._processor = processor
        self._device = device

    def init_state(self, video_path: str) -> Any:
        """Load the video and create a Sam3VideoProcessor inference session."""
        from transformers.video_utils import load_video  # type: ignore[import-not-found]
        import torch  # type: ignore[import-not-found]

        frames, _ = load_video(video_path)
        dtype = (
            torch.bfloat16 if self._device == "cuda" else torch.float32
        )
        return self._processor.init_video_session(
            video=frames,
            inference_device=self._device,
            processing_device="cpu",
            video_storage_device="cpu",
            dtype=dtype,
        )

    def add_new_points(
        self,
        inference_state: Any,
        frame_idx: int,
        points: Any,
        labels: Any,
    ) -> tuple[Any, Any, Any]:
        """Forward the prompt text(s) to ``processor.add_text_prompt``.

        ``points`` may be a single string or a list of strings. Numeric
        click-style points raise ``RuntimeError`` — the existing
        ``/sam-track/start`` route forwards ``[payload.text]`` when SAM 3
        is selected, so this only fires on programmer error.
        """
        if not points:
            raise RuntimeError("SAM 3 video tracker requires text prompt(s)")
        texts: list[str]
        if isinstance(points, str):
            texts = [points]
        elif isinstance(points, list) and all(isinstance(t, str) for t in points):
            texts = list(points)
        else:
            raise RuntimeError(
                "SAM 3 video tracker expected text prompts; got numeric points. "
                "Use the `text` field on /sam-track/start when SAM_MODEL=sam3.",
            )
        for t in texts:
            self._processor.add_text_prompt(inference_session=inference_state, text=t)
        return None, None, None

    def propagate_in_video(self, inference_state: Any) -> Any:
        """Yield ``(frame_idx, mask)`` tuples shaped like SAM 2's tracker.

        SAM 3 returns multi-instance per-frame outputs; we collapse to the
        highest-scoring object so the existing ``/sam-track/{sid}/step``
        single-mask-per-frame contract still holds. Multi-object support
        is a future enhancement.
        """
        import numpy as np

        for model_outputs in self._model.propagate_in_video_iterator(
            inference_session=inference_state,
        ):
            processed = self._processor.postprocess_outputs(inference_state, model_outputs)
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


def build_sam3_video_tracker(device: str | None = None) -> Sam3VideoTrackerAdapter:
    """Eager construction. Imports transformers + torch — only call when
    ``SAM_MODEL=sam3`` and the GPU extras are installed.
    """
    import torch  # type: ignore[import-not-found]
    from transformers import Sam3VideoModel, Sam3VideoProcessor  # type: ignore[import-not-found]

    dev = device or ("cuda" if torch.cuda.is_available() else "cpu")
    dtype = torch.bfloat16 if dev == "cuda" else torch.float32
    model = Sam3VideoModel.from_pretrained("facebook/sam3").to(dev, dtype=dtype)
    processor = Sam3VideoProcessor.from_pretrained("facebook/sam3")
    return Sam3VideoTrackerAdapter(model=model, processor=processor, device=dev)
