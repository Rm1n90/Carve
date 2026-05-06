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


class ConceptModeError(RuntimeError):
    """Raised when /objects is called on a SAM 3 concept (text) session.

    The dispatcher commits to ``state["mode"] == "concept"`` on the first
    text prompt; subsequent ``add_inputs_at_frame`` (the multi-object
    /objects entrypoint) cannot be served because the concept sub-tracker
    has no per-object click API. Surfacing a typed exception lets the HTTP
    boundary map to a clean 422 instead of a generic 502.
    """


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
        box: list[float] | None = None,
        mask_input: Any | None = None,
    ) -> tuple[Any, Any, Any]:
        """Run a click-prompt forward pass.

        Returns ``(masks, scores, low_res_logits_all)``:
          * ``masks``: post-processed binary masks at original image
            size, shape ``(K, H, W)``.
          * ``scores``: K iou scores.
          * ``low_res_logits_all``: raw ``outputs.pred_masks`` tensor
            of shape ``[1, 1, K, 256, 256]`` (kept on device). The
            router slices the chosen channel and stores it on the
            session for the next refinement call.

        v3.22 — fixes two related bugs:

          1. ``multimask_output`` was accepted as a kwarg but never
             forwarded to the model (the call was simply
             ``self._model(**inputs)``). The router's
             "multimask=False on refinement" decision was silently
             ignored, so SAM 3 always returned 3 candidates and the
             best-score selection often picked the broadest
             interpretation that ignored negatives.

          2. ``mask_input`` (the previous decode's chosen low-res
             logits) was not supported, so SAM 3 had no notion of
             "build on the previous mask" — every click set was a
             fresh independent prompt, producing holes, jagged
             boundaries, and negatives that "expanded" the mask.
             ``Sam3TrackerModel.forward`` accepts the kwarg natively;
             we simply forward it.

        Both fixes mirror the SAM 2 transformers patch and the
        sam3.1 native patch in the same v3.22 cycle.
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
        proc_kwargs: dict[str, Any] = {
            "images": self._raw_image,
            "return_tensors": "pt",
        }
        if pts:
            proc_kwargs["input_points"] = [[[[float(p[0]), float(p[1])] for p in pts]]]
            proc_kwargs["input_labels"] = [[[int(label) for label in lbls]]]
        if box is not None:
            x1, y1, x2, y2 = (float(v) for v in box)
            proc_kwargs["input_boxes"] = [[[x1, y1, x2, y2]]]
        inputs = self._processor(**proc_kwargs).to(self._device)

        # Cast mask_input prior (if any) to the model device + dtype.
        forward_kwargs: dict[str, Any] = {"multimask_output": multimask_output}
        if mask_input is not None:
            mi = mask_input
            try:
                model_dtype = next(self._model.parameters()).dtype
                if hasattr(mi, "to"):
                    mi = mi.to(self._device, dtype=model_dtype)
            except StopIteration:
                pass
            except Exception:  # noqa: BLE001 — cast is best-effort
                pass
            forward_kwargs["input_masks"] = mi

        with torch.no_grad():
            outputs = self._model(**inputs, **forward_kwargs)

        # outputs.pred_masks shape: [batch=1, num_obj=1, K, 256, 256]
        # Detached GPU-side tensor so the router can slice the chosen
        # channel and stash it on SamSession for the next call.
        pred_masks_raw = (
            outputs.pred_masks.detach()
            if hasattr(outputs.pred_masks, "detach")
            else outputs.pred_masks
        )
        pred_masks_cpu = (
            pred_masks_raw.cpu()
            if hasattr(pred_masks_raw, "cpu")
            else pred_masks_raw
        )
        original_sizes = inputs["original_sizes"] if "original_sizes" in inputs else [
            [self._original_size[0], self._original_size[1]],
        ]
        masks = self._processor.post_process_masks(pred_masks_cpu, original_sizes)[0]
        # masks shape after post_process_masks for a single image:
        # [num_obj=1, K, H, W] (we collapse batch in the call above).
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

        # GPU hygiene: drop refs the caller doesn't need.
        del outputs, pred_masks_cpu, inputs
        if self._device == "cuda":
            torch.cuda.empty_cache()

        return masks_for_router, scores_for_router, pred_masks_raw


def build_sam3_image_predictor(device: str | None = None) -> Sam3ImagePredictorAdapter:
    """Eager construction. Imports transformers + torch — only call when
    ``SAM_MODEL=sam3`` and the GPU extras are installed.

    Loads the **Tracker** image classes (the drop-in SAM 2 replacement)
    so /sam/decode click prompts work. Text and box concept prompts use
    Sam3Model + Sam3Processor via ``_build_concept_image_pair`` below.

    v3.6 — brackets HF ``from_pretrained`` with ``_set_load_progress``
    so ``GET /sam/status`` shows a "downloading" indicator. MVP is
    indeterminate; real byte progress is the v3.7 follow-up.
    """
    import torch  # type: ignore[import-not-found]
    from transformers import (  # type: ignore[import-not-found]
        Sam3TrackerModel,
        Sam3TrackerProcessor,
    )

    from carve_model.sam.perf import (
        apply_compile_to_image_encoder,
        get_attn_impl,
        get_dtype,
    )
    from carve_model.sam.predictor import _set_load_progress

    dev = device or ("cuda" if torch.cuda.is_available() else "cpu")
    dtype = get_dtype()
    attn_impl = get_attn_impl()
    _set_load_progress(progress_bytes=0, progress_total=-1)
    try:
        model = Sam3TrackerModel.from_pretrained(
            "facebook/sam3",
            dtype=dtype,
            attn_implementation=attn_impl,
        ).to(dev, dtype=dtype)
        processor = Sam3TrackerProcessor.from_pretrained("facebook/sam3")
    finally:
        _set_load_progress(progress_bytes=None, progress_total=None)
    apply_compile_to_image_encoder(model)
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

    from carve_model.sam.perf import (
        apply_compile_to_image_encoder,
        get_attn_impl,
        get_dtype,
    )

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = get_dtype()
    attn_impl = get_attn_impl()
    model = Sam3Model.from_pretrained(
        "facebook/sam3",
        dtype=dtype,
        attn_implementation=attn_impl,
    ).to(dev, dtype=dtype)
    processor = Sam3Processor.from_pretrained("facebook/sam3")
    apply_compile_to_image_encoder(model)
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

    def _predict_from_text(
        *, image_b64: str, text: str, use_vlm_fo1: bool = False,
    ) -> list[dict]:
        import base64
        import logging
        import os
        from io import BytesIO

        import numpy as np
        import torch  # type: ignore[import-not-found]
        from PIL import Image  # type: ignore[import-not-found]

        from carve_model.sam import predictor as p_mod
        from carve_model.sam.codec import encode_mask_rle
        from carve_model.sam.perf import to_numpy_safe
        from carve_model.sam.polygonize import mask_to_polygon

        _logger = logging.getLogger(__name__)

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

        # v3.21+ — when the request opts into VLM-FO1 we lower the SAM 3
        # post-processing threshold so FO1 sees more candidate proposals
        # to filter. Without FO1 the existing 0.5 default is preserved
        # byte-for-byte (zero behavior change for existing callers).
        if use_vlm_fo1:
            try:
                threshold = float(os.environ.get("SAM3_PROPOSAL_THRESHOLD", "0.2"))
            except ValueError:
                threshold = 0.2
        else:
            threshold = 0.5

        results = proc.post_process_instance_segmentation(
            outputs,
            threshold=threshold,
            mask_threshold=0.5,
            target_sizes=[[h, w]],
        )[0]
        masks = results.get("masks") if hasattr(results, "get") else None
        scores = results.get("scores") if hasattr(results, "get") else None
        boxes = results.get("boxes") if hasattr(results, "get") else None
        out: list[dict] = []
        if masks is None:
            # Free GPU refs before returning even on the empty path.
            del inputs, outputs, results
            if device == "cuda":
                torch.cuda.empty_cache()
            return out
        for i in range(len(masks)):
            # bf16 / f16 tensors raise on .numpy(); to_numpy_safe casts up.
            mask_np = to_numpy_safe(masks[i]).astype(np.uint8)
            counts, size = encode_mask_rle(mask_np)
            polygon = mask_to_polygon(mask_np)
            if boxes is not None:
                box = to_numpy_safe(boxes[i]).tolist()
            else:
                box = [0, 0, 0, 0]
            score_val = float(scores[i].item()) if scores is not None else 1.0
            out.append({
                "counts": counts,
                "size": size,
                "score": score_val,
                "bbox": [float(x) for x in box],
                # v3.8 Phase 3 — polygon added so the editor commits an
                # editable polygon annotation; empty when the mask had no
                # usable contour. Falls back to mask_rle on the client.
                "polygon": polygon,
            })

        # v3.22 GPU-hygiene: drop the GPU tensors we copied to numpy so
        # they don't survive the function call. Without this, every
        # batch auto-annotate iteration leaks ~50–500 MB of activations
        # and the 24 GB card OOMs around the ~30th asset.
        del inputs, outputs, results, masks, scores, boxes
        if device == "cuda":
            torch.cuda.empty_cache()

        # v3.21+ — VLM-FO1 precision filter pass. Cheap-exit if the
        # request didn't opt in or SAM 3 produced nothing for FO1 to
        # filter. Errors degrade to passthrough so the user still sees
        # SAM 3's raw output rather than a 500.
        if not use_vlm_fo1 or not out:
            return out

        try:
            top_k = int(os.environ.get("SAM3_TOPK_PROPOSALS", "64"))
        except ValueError:
            top_k = 64
        if top_k > 0 and len(out) > top_k:
            out = sorted(out, key=lambda d: d["score"], reverse=True)[:top_k]

        vlm_filter = p_mod.get_vlm_fo1_filter()
        if vlm_filter is None:
            # Server gate may say "available" but the operator never
            # wired a real filter — silent passthrough is the safest UX.
            return out

        try:
            boxes_xyxy = [list(d["bbox"]) for d in out]
            indexes = vlm_filter(image=pil, text=text, boxes=boxes_xyxy)
        except Exception as exc:  # noqa: BLE001 — graceful degradation
            _logger.warning(
                "vlm_fo1 filter failed (%s); degrading to passthrough", exc,
            )
            return out

        # Defensive: drop indexes outside the valid range, dedup, keep
        # the model's emission order (higher-confidence first).
        seen: set[int] = set()
        clean: list[int] = []
        for idx in indexes:
            try:
                i = int(idx)
            except (TypeError, ValueError):
                continue
            if 0 <= i < len(out) and i not in seen:
                seen.add(i)
                clean.append(i)
        return [out[i] for i in clean]

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

        from carve_model.sam.codec import encode_mask_rle
        from carve_model.sam.perf import to_numpy_safe
        from carve_model.sam.polygonize import mask_to_polygon

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

        # v3.22 dtype-fix: when the model was loaded as bf16 (default on
        # CUDA per perf.get_dtype()), the Sam3Processor returns float32
        # tensors that mismatch the model's Linear layer weights —
        # ``geometry_encoder._encode_boxes -> boxes_direct_project``
        # raises ``mat1 and mat2 must have the same dtype, but got
        # Float and BFloat16``. Cast every floating-point input tensor
        # to the model dtype to match. Integer label tensors are left
        # alone (they're indexed, not matmul'd).
        try:
            model_dtype = next(model.parameters()).dtype
            if hasattr(inputs, "items"):
                for k, v in list(inputs.items()):
                    if hasattr(v, "dtype") and hasattr(v, "to") and v.is_floating_point():
                        if v.dtype != model_dtype:
                            inputs[k] = v.to(dtype=model_dtype)
        except (StopIteration, AttributeError, TypeError):
            pass

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
            del inputs, outputs, results
            if device == "cuda":
                torch.cuda.empty_cache()
            return out
        for i in range(len(masks)):
            # bf16 / f16 tensors raise on .numpy(); to_numpy_safe casts up.
            mask_np = to_numpy_safe(masks[i]).astype(np.uint8)
            counts, size = encode_mask_rle(mask_np)
            polygon = mask_to_polygon(mask_np)
            if boxes_out is not None:
                box = to_numpy_safe(boxes_out[i]).tolist()
            else:
                box = [0.0, 0.0, 0.0, 0.0]
            score_val = float(scores[i].item()) if scores is not None else 1.0
            out.append({
                "counts": counts,
                "size": size,
                "score": score_val,
                "bbox": [float(x) for x in box],
                # v3.8 Phase 3 — polygon for editable commit on the
                # client. Empty when the mask had no usable contour.
                "polygon": polygon,
            })

        # v3.22 GPU-hygiene: same release pattern as text_predictor.
        del inputs, outputs, results, masks, scores, boxes_out
        if device == "cuda":
            torch.cuda.empty_cache()
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

            # v3.8 Phase 4-video step F8 — runtime patch for an upstream
            # transformers typo. ``modeling_sam3_tracker_video.py`` line
            # ~1912 reads ``image_outputs.fpn_position_embeddings`` but
            # both ``Sam3VisionEncoderOutput`` and
            # ``Sam3TrackerVideoVisionEncoderOutput`` actually expose the
            # field as ``fpn_position_encoding``. Without this alias the
            # tracker forward raises AttributeError on every step. We add
            # a property so the wrong attribute name still resolves.
            from transformers.models.sam3 import modeling_sam3 as _sam3_mod
            from transformers.models.sam3_tracker_video import (
                modeling_sam3_tracker_video as _sam3t_mod,
            )

            for cls in (
                _sam3_mod.Sam3VisionEncoderOutput,
                _sam3t_mod.Sam3TrackerVideoVisionEncoderOutput,
            ):
                if not hasattr(cls, "fpn_position_embeddings"):
                    setattr(
                        cls,
                        "fpn_position_embeddings",
                        property(lambda self: self.fpn_position_encoding),
                    )

            from carve_model.sam.perf import (
                apply_compile_to_image_encoder,
                get_attn_impl,
                get_dtype,
            )

            dtype = get_dtype()
            attn_impl = get_attn_impl()
            self._tracker_model = Sam3TrackerVideoModel.from_pretrained(
                "facebook/sam3",
                dtype=dtype,
                attn_implementation=attn_impl,
            ).to(self._device, dtype=dtype)
            self._tracker_processor = Sam3TrackerVideoProcessor.from_pretrained(
                "facebook/sam3",
            )
            apply_compile_to_image_encoder(self._tracker_model)
        return self._tracker_model, self._tracker_processor

    def _load_concept(self) -> tuple[Any, Any]:
        if self._concept_model is None:
            import torch  # type: ignore[import-not-found]
            from transformers import (  # type: ignore[import-not-found]
                Sam3VideoModel,
                Sam3VideoProcessor,
            )

            from carve_model.sam.perf import (
                apply_compile_to_image_encoder,
                get_attn_impl,
                get_dtype,
            )

            dtype = get_dtype()
            attn_impl = get_attn_impl()
            self._concept_model = Sam3VideoModel.from_pretrained(
                "facebook/sam3",
                dtype=dtype,
                attn_implementation=attn_impl,
            ).to(self._device, dtype=dtype)
            self._concept_processor = Sam3VideoProcessor.from_pretrained(
                "facebook/sam3",
            )
            apply_compile_to_image_encoder(self._concept_model)
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
            self._add_points(inference_state, frame_idx, points, labels, obj_id=1)
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
        """v1.4 multi-object entrypoint — delegates to the tracker pair
        (Sam3TrackerVideoModel + Sam3TrackerVideoProcessor).

        ``points`` and ``boxes`` are exclusive in this code path (the SAM 3
        tracker processor accepts both at once but the router validates
        that at the HTTP boundary). Concept (text) mode is NOT handled
        here — text prompts belong on /sam-track/start, not /objects.

        If the session was already started in concept mode (text prompt at
        /start), a ``ConceptModeError`` is raised. Without this guard the
        previous implementation would silently switch to tracker mode and
        re-init the video session, orphaning the concept session.
        """
        # v3.8 Phase 4-video step F7 — text seed at session start arrives
        # here too (start_session forwards ``points=[<text>]`` for SAM 3
        # callers). Detect it BEFORE the concept-mode guard so the very
        # first text-seed call can lazily create the concept session.
        is_text_mode = (
            isinstance(points, str)
            or (
                isinstance(points, list)
                and len(points) > 0
                and all(isinstance(t, str) for t in points)
            )
        )
        if is_text_mode:
            self._add_text(inference_state, points)
            return None
        if (
            isinstance(inference_state, dict)
            and inference_state.get("mode") == "concept"
        ):
            raise ConceptModeError(
                "/objects is not supported in concept (text) mode",
            )
        if not points and not boxes:
            raise RuntimeError(
                "add_inputs_at_frame requires points or boxes",
            )
        self._add_points(
            inference_state,
            frame_idx,
            points or [],
            labels or [],
            obj_id=obj_id,
            boxes=boxes,
        )
        return None

    def propagate_in_video(self, inference_state: Any) -> Any:
        if inference_state.get("session") is None:
            return
        if inference_state["mode"] == "tracker":
            yield from self._propagate_tracker(inference_state)
        elif inference_state["mode"] == "concept":
            yield from self._propagate_concept(inference_state)

    # -- internal helpers ----------------------------------------------------

    def _add_text(self, state: dict, points: Any) -> None:
        from carve_model.sam.perf import get_dtype

        model, processor = self._load_concept()
        if state["session"] is None:
            dtype = get_dtype()
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
        *,
        obj_id: int = 1,
        boxes: Any = None,
    ) -> None:
        from carve_model.sam.perf import get_dtype

        model, processor = self._load_tracker()
        if state["session"] is None:
            dtype = get_dtype()
            state["session"] = processor.init_video_session(
                video=state["video_frames"],
                inference_device=self._device,
                dtype=dtype,
            )
            state["model"] = model
            state["processor"] = processor
            state["mode"] = "tracker"

        # Sam3TrackerVideoProcessor.add_inputs_to_inference_session expects:
        #   obj_ids: int (single object per call) or list[int]
        #   input_points: [batch=1][num_obj=1][num_pts][xy]   (or None)
        #   input_labels: [batch=1][num_obj=1][num_pts]       (or None)
        #   input_boxes:  [batch=1][num_obj=1][4]             (or None)
        # Record the seed frame_idx so propagate_in_video_iterator gets a
        # start_frame_idx — without it Sam3TrackerVideoModel raises
        # "Cannot determine the starting frame index".
        if state.get("seed_frame_idx") is None:
            state["seed_frame_idx"] = int(frame_idx)
        kwargs: dict[str, Any] = {
            "inference_session": state["session"],
            "frame_idx": int(frame_idx),
            "obj_ids": obj_id,
        }
        if points:
            kwargs["input_points"] = [[[list(p) for p in points]]]
            kwargs["input_labels"] = [[list(labels)]]
        if boxes:
            # Single-object box prompt: [batch][num_obj][4].
            kwargs["input_boxes"] = [[[float(x) for x in boxes[0]]]]
        processor.add_inputs_to_inference_session(**kwargs)

    def _propagate_tracker(self, state: dict) -> Any:
        import numpy as np

        session = state["session"]
        height = getattr(session, "video_height", 0) or 0
        width = getattr(session, "video_width", 0) or 0
        original_sizes = [[int(height), int(width)]] if height and width else None
        start_frame_idx = state.get("seed_frame_idx")
        for output in state["model"].propagate_in_video_iterator(
            session, start_frame_idx=start_frame_idx
        ):
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
