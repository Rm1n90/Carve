"""SAM 2 adapters that conform to the SamPredictor + TrackerProtocol contracts.

This module is the **transformers-backed** path for SAM 2.x, mirroring the
SAM 3 adapter pattern in ``sam3_adapter.py``. Since v3.4 commit 6 it is
the only path: the legacy ``sam2`` git-package install was removed and
the ``predictor.py`` / ``tracker.py`` factories route every SAM 2.x model
(``sam2.1-tiny``, ``sam2.1-small``, ``sam2.1-base-plus``, ``sam2.1-large``)
through these adapters unconditionally.

The transformers SAM 2 API surface used here:

- ``Sam2Model`` + ``Sam2Processor`` — image segmentation (point/box/mask
  prompts). Used to back ``/sam/encode`` and ``/sam/decode``.
- ``Sam2VideoModel`` + ``Sam2VideoProcessor`` — video tracking (point/box
  prompts at frames). Used to back ``/sam-track/*``.

CRITICAL contract: ``Sam2ImagePredictorAdapter`` MUST expose
``_features = {"image_embed": tensor}`` after ``set_image()`` runs, so
``carve_model.sam.predictor.extract_embedding`` keeps producing bytes for
the browser-side ONNX decoder. SAM 3 does the same at
``sam3_adapter.py:101``.

Imports of torch + transformers + PIL are deferred to method bodies so
this module can be imported in environments where those heavy deps are
absent (the dev test path stubs them via ``sys.modules``).
"""

from __future__ import annotations

import os
from typing import Any

# Hugging Face repo ids for the four SAM 2.1 sizes. We re-declare the map
# here to avoid a circular import with ``predictor.py`` which already owns
# the same constant. The values must stay in lockstep — the resolver tests
# guard the predictor side; the build tests below guard this side.
_HF_REPO_BY_MODEL: dict[str, str] = {
    "sam2.1-tiny":      "facebook/sam2.1-hiera-tiny",
    "sam2.1-small":     "facebook/sam2.1-hiera-small",
    "sam2.1-base-plus": "facebook/sam2.1-hiera-base-plus",
    "sam2.1-large":     "facebook/sam2.1-hiera-large",
}


_TRUTHY_BF16 = ("1", "true", "yes", "on")


def _use_bf16() -> bool:
    """Return True when bf16 should be used for SAM 2 model weights.

    Mirrors the gate in ``predictor.py:use_bf16`` — controlled by the
    ``SAM_BF16`` env (default ``1``) and runtime hardware capability.
    Failing closed (return False) when torch is missing keeps the test
    path import-light.
    """
    if os.getenv("SAM_BF16", "1") not in _TRUTHY_BF16:
        return False
    try:
        import torch  # type: ignore[import-not-found]

        if not torch.cuda.is_available():
            return False
        return bool(torch.cuda.is_bf16_supported())
    except Exception:
        return False


# --- image adapter (clicks → Sam2Model) -------------------------------------


class Sam2ImagePredictorAdapter:
    """Wrap ``Sam2Model`` + ``Sam2Processor`` to look like the legacy
    ``SAM2ImagePredictor`` from the ``sam2`` git package.

    Lifecycle: ``set_image(img)`` caches the raw image and pre-computes
    vision embeddings via ``model.get_image_embeddings(...)``. The result
    is stored on ``self._features["image_embed"]`` so the existing
    ``carve_model.sam.predictor.extract_embedding`` helper continues to
    emit float16 bytes for the browser ONNX decoder.

    ``predict(point_coords, point_labels, multimask_output)`` runs the
    model with the cached image and returns ``(masks, scores, None)``
    — the third value is unused by the router (legacy ``SAM2ImagePredictor``
    returned low-res logits there; we mirror the shape with ``None``).
    """

    def __init__(self, model: Any, processor: Any, device: str) -> None:
        self._model = model
        self._processor = processor
        self._device = device
        # Cache populated by set_image().
        self._raw_image: Any = None
        self._original_size: tuple[int, int] | None = None  # (h, w)
        # Mirror SAM 2 legacy's _features dict so extract_embedding() works.
        self._features: dict[str, Any] | None = None

    def set_image(self, image: Any) -> None:
        """Cache PIL-converted image + vision embeddings.

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
            inputs = self._processor(
                images=self._raw_image, return_tensors="pt",
            ).to(self._device)
            pix = inputs["pixel_values"] if isinstance(inputs, dict) else getattr(
                inputs, "pixel_values", None,
            )
            with torch.no_grad():
                feats = self._model.get_image_embeddings(pixel_values=pix)
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

        ``Sam2Model`` returns ``outputs.pred_masks`` shape
        ``[batch=1, num_obj=1, K, H, W]`` plus ``iou_scores``. We
        post-process via ``processor.post_process_masks`` and return
        shape ``(K, H, W)`` so the router's existing argmax over scores
        keeps working.
        """
        if self._raw_image is None or self._original_size is None:
            raise RuntimeError("set_image must be called before predict")
        import numpy as np
        import torch  # type: ignore[import-not-found]

        pts = np.asarray(point_coords, dtype=np.float32).reshape(-1, 2).tolist()
        lbls = np.asarray(point_labels, dtype=np.int64).reshape(-1).tolist()
        # Sam2Processor expects [batch][num_obj][num_pts][xy] for input_points
        # and [batch][num_obj][num_pts] for input_labels. We treat the click
        # set as a single object (matches /sam/decode).
        input_points = [[[[float(p[0]), float(p[1])] for p in pts]]]
        input_labels = [[[int(label) for label in lbls]]]
        inputs = self._processor(
            images=self._raw_image,
            input_points=input_points,
            input_labels=input_labels,
            return_tensors="pt",
        ).to(self._device)

        with torch.no_grad():
            outputs = self._model(
                **inputs,
                multimask_output=multimask_output,
            )

        # outputs.pred_masks shape: [batch=1, num_obj=1, K, H, W]
        pred_masks = outputs.pred_masks
        if hasattr(pred_masks, "cpu"):
            pred_masks = pred_masks.cpu()
        original_sizes = (
            inputs["original_sizes"]
            if "original_sizes" in inputs
            else [[self._original_size[0], self._original_size[1]]]
        )
        masks = self._processor.post_process_masks(pred_masks, original_sizes)[0]

        scores_tensor = getattr(outputs, "iou_scores", None)
        if scores_tensor is not None and hasattr(scores_tensor, "cpu"):
            scores_tensor = scores_tensor.cpu()

        # Reshape masks to (K, H, W) — take first object — and scores to (K,).
        masks_ndim = getattr(masks, "ndim", None)
        if masks_ndim is None:
            masks_ndim = np.asarray(masks).ndim
        if masks_ndim == 4:
            masks_for_router = masks[0]
        elif masks_ndim == 3:
            masks_for_router = masks
        else:
            raise RuntimeError(
                f"unexpected SAM 2 mask shape: ndim={masks_ndim}",
            )

        try:
            n_masks = len(masks_for_router)
        except TypeError:
            n_masks = int(masks_for_router.shape[0])

        if scores_tensor is not None:
            flat = (
                scores_tensor.flatten()
                if hasattr(scores_tensor, "flatten")
                else scores_tensor
            )
            scores_for_router = (
                flat[:n_masks] if hasattr(flat, "__getitem__") else flat
            )
        else:
            scores_for_router = torch.ones((n_masks,), dtype=torch.float32)

        return masks_for_router, scores_for_router, None


def build_sam2_image_predictor(
    model_name: str,
    device: str | None = None,
) -> Sam2ImagePredictorAdapter:
    """Eager construction. Imports torch + transformers — only call when
    the GPU extras are installed.

    Resolves the HF repo id from the SAM 2.x ``model_name`` (e.g.
    ``sam2.1-tiny``). Raises ``ValueError`` for unknown SAM 2 model
    names; the caller (``predictor._default_factory``) is responsible
    for routing ``sam3`` elsewhere.
    """
    if model_name not in _HF_REPO_BY_MODEL:
        raise ValueError(
            f"unknown SAM 2 model {model_name!r}; "
            f"allowed: {', '.join(sorted(_HF_REPO_BY_MODEL))}",
        )
    repo = _HF_REPO_BY_MODEL[model_name]

    import torch  # type: ignore[import-not-found]
    from transformers import (  # type: ignore[import-not-found]
        Sam2Model,
        Sam2Processor,
    )

    dev = device or ("cuda" if torch.cuda.is_available() else "cpu")
    dtype = torch.bfloat16 if (dev == "cuda" and _use_bf16()) else torch.float32
    model = Sam2Model.from_pretrained(repo).to(dev, dtype=dtype)
    processor = Sam2Processor.from_pretrained(repo)
    return Sam2ImagePredictorAdapter(model=model, processor=processor, device=dev)


# --- video tracker (clicks/boxes → Sam2VideoModel) --------------------------


class Sam2VideoTrackerAdapter:
    """Wrap ``Sam2VideoModel`` + ``Sam2VideoProcessor`` to conform to the
    ``TrackerProtocol`` contract (multi-object dict-of-masks per frame).

    Lazy session bring-up: ``init_state(video_path)`` loads the video
    frames; the inference session is only constructed on the first
    ``add_new_points`` / ``add_inputs_at_frame`` call. This matches the
    SAM 3 dispatcher's lazy-init pattern and lets the tracker exist
    before the caller knows what kind of prompt is coming.
    """

    def __init__(self, model: Any, processor: Any, device: str) -> None:
        self._model = model
        self._processor = processor
        self._device = device

    def init_state(self, video_path: str) -> dict:
        """Load video frames; defer session creation to the first prompt."""
        from transformers.video_utils import load_video  # type: ignore[import-not-found]

        frames, _ = load_video(video_path)
        return {
            "video_frames": frames,
            "session": None,
        }

    def add_new_points(
        self,
        inference_state: Any,
        frame_idx: int,
        points: Any,
        labels: Any,
    ) -> tuple[Any, Any, Any]:
        """Legacy single-object entrypoint — routes to ``add_inputs_at_frame``
        with ``obj_id=1`` so the v1.4 multi-object protocol is the canonical
        path under the hood.
        """
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
        """Forward per-object click/box prompts to the SAM 2 video processor.

        ``Sam2VideoProcessor.add_inputs_to_inference_session`` expects
        ``input_points`` / ``input_labels`` packed as
        ``[batch=1][num_obj=1][num_pts][xy]`` and ``input_boxes`` as
        ``[batch=1][num_obj=1][4]``. We follow the same shape the SAM 3
        tracker dispatcher uses for parity.
        """
        if not points and not boxes:
            raise RuntimeError(
                "add_inputs_at_frame requires points or boxes",
            )

        self._ensure_session(inference_state)
        kwargs: dict[str, Any] = {
            "inference_session": inference_state["session"],
            "frame_idx": int(frame_idx),
            "obj_ids": int(obj_id),
        }
        if points:
            kwargs["input_points"] = [[[list(p) for p in points]]]
            kwargs["input_labels"] = [[list(labels or [])]]
        if boxes:
            kwargs["input_boxes"] = [[[float(x) for x in boxes[0]]]]
        self._processor.add_inputs_to_inference_session(**kwargs)
        return None

    def propagate_in_video(self, inference_state: Any) -> Any:
        """Yield ``(frame_idx, {obj_id: mask})`` for each propagated frame.

        The per-object dict contract is what the v1.4 ``TrackerProtocol``
        speaks; ``track_router`` consumes it directly without translation.
        """
        if inference_state.get("session") is None:
            return
        import numpy as np

        session = inference_state["session"]
        height = getattr(session, "video_height", 0) or 0
        width = getattr(session, "video_width", 0) or 0
        original_sizes = (
            [[int(height), int(width)]] if height and width else None
        )
        for output in self._model.propagate_in_video_iterator(session):
            pred_masks = output.pred_masks
            if hasattr(pred_masks, "cpu"):
                pred_masks = pred_masks.cpu()
            if original_sizes is not None:
                masks = self._processor.post_process_masks(
                    [pred_masks],
                    original_sizes=original_sizes,
                    binarize=True,
                )[0]
            else:
                masks = pred_masks
            obj_ids = getattr(output, "obj_ids", None) or [1]
            arr = (
                masks._arr
                if hasattr(masks, "_arr")
                else (masks.numpy() if hasattr(masks, "numpy") else np.asarray(masks))
            )
            masks_by_obj: dict[int, Any] = {}
            # arr shape: [num_obj, H, W] or [num_obj, K, H, W]; index per obj.
            for i, oid in enumerate(obj_ids):
                if arr.ndim == 4:
                    masks_by_obj[int(oid)] = arr[i, 0]
                elif arr.ndim == 3:
                    masks_by_obj[int(oid)] = arr[i]
                else:
                    masks_by_obj[int(oid)] = arr
            yield int(getattr(output, "frame_idx", 0)), masks_by_obj

    def _ensure_session(self, state: dict) -> None:
        """Lazily build the video inference session on first prompt."""
        if state.get("session") is not None:
            return
        import torch  # type: ignore[import-not-found]

        dtype = (
            torch.bfloat16 if (self._device == "cuda" and _use_bf16()) else torch.float32
        )
        state["session"] = self._processor.init_video_session(
            video=state["video_frames"],
            inference_device=self._device,
            dtype=dtype,
        )


def build_sam2_video_tracker(
    model_name: str,
    device: str | None = None,
) -> Sam2VideoTrackerAdapter:
    """Eager construction of the SAM 2 video tracker adapter.

    Loads ``Sam2VideoModel`` + ``Sam2VideoProcessor`` from the HF repo for
    ``model_name``. Raises ``ValueError`` for unknown SAM 2 model names.
    """
    if model_name not in _HF_REPO_BY_MODEL:
        raise ValueError(
            f"unknown SAM 2 model {model_name!r}; "
            f"allowed: {', '.join(sorted(_HF_REPO_BY_MODEL))}",
        )
    repo = _HF_REPO_BY_MODEL[model_name]

    import torch  # type: ignore[import-not-found]
    from transformers import (  # type: ignore[import-not-found]
        Sam2VideoModel,
        Sam2VideoProcessor,
    )

    dev = device or ("cuda" if torch.cuda.is_available() else "cpu")
    dtype = torch.bfloat16 if (dev == "cuda" and _use_bf16()) else torch.float32
    model = Sam2VideoModel.from_pretrained(repo).to(dev, dtype=dtype)
    processor = Sam2VideoProcessor.from_pretrained(repo)
    return Sam2VideoTrackerAdapter(model=model, processor=processor, device=dev)
