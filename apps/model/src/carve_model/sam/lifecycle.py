"""SAM lifecycle manager — unified ownership of the one resident SAM variant.

Replaces the three-singleton sprawl (_SESSION, _NATIVE_IMAGE_PREDICTOR,
_TEXT_PREDICTOR_FACTORY) with one state machine + one strategy protocol.
See docs/superpowers/specs/2026-05-14-sam-lifecycle-manager-design.md.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

__all__ = [
    "SamCapabilityError",
    "SamNotReadyError",
    "SamLoadError",
    "LoadStateKind",
    "LoadState",
    "SamVariant",
    "Sam2Variant",
    "Sam3p1Variant",
    "SamLifecycleManager",
    "_build_variant",
    "manager",
    "_LegacyTestVariant",
]


class SamCapabilityError(Exception):
    """Raised when a variant does not support the requested inference mode.

    sam2 variants raise this from predict_text / predict_box / predict_visual.
    Mapped to HTTP 409 by the router.
    """


class SamNotReadyError(Exception):
    """Raised when lease() is called but the manager is not in 'ready' state.

    state is one of 'idle', 'loading', 'error'. Mapped to HTTP 503 by the
    router with a state-specific detail string.
    """

    def __init__(self, state: str) -> None:
        super().__init__(f"sam not ready: state={state}")
        self.state = state


class SamLoadError(Exception):
    """Raised when ensure_loaded() fails to build the requested variant.

    The original exception is set as __cause__. The router does not catch
    this directly — load happens in a background thread; status reflects
    the failure via /sam/status.
    """

    def __init__(self, variant: str, cause: BaseException) -> None:
        super().__init__(f"load failed for {variant}: {cause!r}")
        self.variant = variant


LoadStateKind = Literal["idle", "loading", "ready", "error"]


@dataclass(frozen=True)
class LoadState:
    """Immutable snapshot of the manager's current load state.

    Mirrors the shape that today's predictor.py LoadState exposes; routers
    that today read from p_mod._LOAD_STATE will read manager.status() and
    get this object.
    """

    kind: LoadStateKind
    variant: str | None = None
    loaded_at: str | None = None
    started_at: str | None = None
    error: str | None = None

    @classmethod
    def idle(cls) -> LoadState:
        return cls(kind="idle")

    @classmethod
    def loading(cls, variant: str, *, started_at: str) -> LoadState:
        return cls(kind="loading", variant=variant, started_at=started_at)

    @classmethod
    def ready(cls, variant: str, *, loaded_at: str) -> LoadState:
        return cls(kind="ready", variant=variant, loaded_at=loaded_at)

    @classmethod
    def error_(cls, variant: str | None, error: str) -> LoadState:
        return cls(kind="error", variant=variant, error=error)


from typing import Any, Iterator, Protocol, runtime_checkable


@runtime_checkable
class SamVariant(Protocol):
    """One SAM model variant. Owns its weights, image cache, and the four
    inference paths.

    The manager holds at most one of these. Implementations:
    Sam2Variant (no text/box/visual), Sam3p1Variant (all four).
    """

    name: str
    device: str | None
    build_key: tuple[str, str, str]

    # ---- lifecycle ----
    def load(self, device: str | None) -> None: ...
    def unload(self) -> None: ...

    # ---- image cache ----
    def set_image(self, image: "Any", *, image_hash: str | None = None) -> str: ...
    def cached_image_hash(self) -> str | None: ...
    def cached_image_shape(self) -> tuple[int, int] | None: ...
    def extract_embedding(self) -> bytes | None: ...

    # ---- iterative-refinement state ----
    def set_prev_logits(self, low_res_logits: Any | None, n_points: int) -> None: ...
    def get_prev_logits(self) -> tuple[Any | None, int]: ...

    # ---- inference ----
    def predict_point(
        self,
        *,
        point_coords: Any | None,
        point_labels: Any | None,
        box: Any | None = None,
        mask_input: Any | None = None,
        multimask_output: bool = True,
    ) -> tuple[Any, Any, Any]: ...

    def predict_text(
        self,
        *,
        image_b64: str,
        text: str,
        threshold: float | None = None,
        use_vlm_fo1: bool = False,
    ) -> list[dict]: ...

    def predict_text_multi(
        self,
        *,
        image_b64: str,
        texts: list[str],
        threshold: float | None = None,
        use_vlm_fo1: bool = False,
        epsilon_factor: float | None = None,
    ) -> list[list[dict]]: ...

    def predict_box(
        self,
        *,
        image_b64: str,
        boxes: list[list[float]],
        box_labels: list[int],
        text: str | None = None,
    ) -> list[dict]: ...

    def predict_visual(
        self,
        *,
        target_b64: str,
        refer_b64: str,
        regions: list[dict],
        threshold: float | None = None,
        text_hint: str | None = None,
    ) -> list[dict]: ...

    # ---- capability flags ----
    @property
    def supports_text(self) -> bool: ...
    @property
    def supports_box(self) -> bool: ...
    @property
    def supports_visual(self) -> bool: ...


import hashlib


def _build_sam2_adapter(name: str, *, device: str | None) -> Any:
    """Thin indirection so tests can patch this name without importing torch."""
    from carve_model.sam import sam2_adapter
    return sam2_adapter.build_sam2_image_predictor(name, device=device)


def _hash_image(image: Any) -> str:
    """sha256 of an HxWx3 RGB uint8 numpy array (image-content-addressed cache key)."""
    return hashlib.sha256(memoryview(image).tobytes()).hexdigest()


class Sam2Variant:
    """SAM 2.x image predictor variant — point + box prompts, no text/visual."""

    supports_text = False
    supports_box = False
    supports_visual = False

    def __init__(self, name: str) -> None:
        self.name = name
        self.device: str | None = None
        self.build_key: tuple[str, str, str] = (name, "fp32", "sdpa")
        self._adapter: Any | None = None
        self._cached_hash: str | None = None
        self._cached_shape: tuple[int, int] | None = None
        self._prev_logits: Any | None = None
        self._prev_n_points: int = 0

    def load(self, device: str | None) -> None:
        self._adapter = _build_sam2_adapter(self.name, device=device)
        self.device = device

    def warmup(self) -> None:
        """Force a synthetic encoder forward pass so the next real
        /sam/encode doesn't pay lazy-init costs we'd otherwise hide
        behind a premature ``state=ready`` signal. See
        ``SamLifecycleManager.ensure_loaded`` for the caller."""
        _run_warmup(self)

    def unload(self) -> None:
        self._adapter = None
        self._cached_hash = None
        self._cached_shape = None
        self._prev_logits = None
        self._prev_n_points = 0

    def set_image(self, image: Any, *, image_hash: str | None = None) -> str:
        if self._adapter is None:
            raise RuntimeError("Sam2Variant.set_image called before load()")
        self._adapter.set_image(image)
        h = image_hash if image_hash is not None else _hash_image(image)
        self._cached_hash = h
        self._cached_shape = (int(image.shape[0]), int(image.shape[1]))
        self._prev_logits = None
        self._prev_n_points = 0
        return h

    def cached_image_hash(self) -> str | None:
        return self._cached_hash

    def cached_image_shape(self) -> tuple[int, int] | None:
        return self._cached_shape

    def extract_embedding(self) -> bytes | None:
        if self._adapter is None:
            return None
        getter = getattr(self._adapter, "extract_embedding", None)
        if getter is None:
            return None
        return getter()

    def set_prev_logits(self, low_res_logits: Any | None, n_points: int) -> None:
        self._prev_logits = low_res_logits
        self._prev_n_points = int(n_points)

    def get_prev_logits(self) -> tuple[Any | None, int]:
        return (self._prev_logits, self._prev_n_points)

    def predict_point(
        self, *,
        point_coords: Any | None,
        point_labels: Any | None,
        box: Any | None = None,
        mask_input: Any | None = None,
        multimask_output: bool = True,
    ) -> tuple[Any, Any, Any]:
        if self._adapter is None:
            raise RuntimeError("Sam2Variant.predict_point called before load()")
        return self._adapter.predict(
            point_coords=point_coords,
            point_labels=point_labels,
            box=box,
            mask_input=mask_input,
            multimask_output=multimask_output,
        )

    def predict_text(self, **kw: Any) -> list[dict]:
        raise SamCapabilityError("sam2 variants do not support text prompts")

    def predict_text_multi(self, **kw: Any) -> list[list[dict]]:
        raise SamCapabilityError("sam2 variants do not support text prompts")

    def predict_box(self, **kw: Any) -> list[dict]:
        raise SamCapabilityError("sam2 variants do not support /sam/box-prompt")

    def predict_visual(self, **kw: Any) -> list[dict]:
        raise SamCapabilityError("sam2 variants do not support visual prompts")


def _build_sam3p1_adapter(*, device: str | None) -> Any:
    """Thin indirection for testing."""
    from carve_model.sam import sam3p1_adapter
    return sam3p1_adapter.build_sam3p1_image_predictor(device=device)


class Sam3p1Variant:
    """SAM 3.1 native predictor variant — point + box + text + visual, all
    four modes served by a single Sam3p1NativeImagePredictorAdapter
    instance. This unification is the structural fix for the double-load
    OOM bug."""

    name = "sam3.1"
    supports_text = True
    supports_box = True
    supports_visual = True

    def __init__(self) -> None:
        self.device: str | None = None
        self.build_key: tuple[str, str, str] = ("sam3.1", "bf16", "sdpa")
        self._adapter: Any | None = None
        self._cached_hash: str | None = None
        self._cached_shape: tuple[int, int] | None = None
        self._prev_logits: Any | None = None
        self._prev_n_points: int = 0

    def load(self, device: str | None) -> None:
        self._adapter = _build_sam3p1_adapter(device=device)
        self.device = device

    def warmup(self) -> None:
        """Mirrors :meth:`Sam2Variant.warmup` — primes the encoder so the
        first real /sam/encode after ``state=ready`` doesn't pay the
        lazy-init tax that previously made the "SAM ready" toast lie."""
        _run_warmup(self)

    def unload(self) -> None:
        if self._adapter is not None:
            for attr in ("_state", "_model", "_processor", "_features"):
                try:
                    setattr(self._adapter, attr, None)
                except Exception:
                    pass
        self._adapter = None
        self._cached_hash = None
        self._cached_shape = None
        self._prev_logits = None
        self._prev_n_points = 0

    def set_image(self, image: Any, *, image_hash: str | None = None) -> str:
        if self._adapter is None:
            raise RuntimeError("Sam3p1Variant.set_image called before load()")
        self._adapter.set_image(image)
        h = image_hash if image_hash is not None else _hash_image(image)
        self._cached_hash = h
        self._cached_shape = (int(image.shape[0]), int(image.shape[1]))
        self._prev_logits = None
        self._prev_n_points = 0
        return h

    def cached_image_hash(self) -> str | None:
        return self._cached_hash

    def cached_image_shape(self) -> tuple[int, int] | None:
        return self._cached_shape

    def extract_embedding(self) -> bytes | None:
        return None

    def set_prev_logits(self, low_res_logits: Any | None, n_points: int) -> None:
        self._prev_logits = low_res_logits
        self._prev_n_points = int(n_points)

    def get_prev_logits(self) -> tuple[Any | None, int]:
        return (self._prev_logits, self._prev_n_points)

    def predict_point(
        self, *,
        point_coords: Any | None,
        point_labels: Any | None,
        box: Any | None = None,
        mask_input: Any | None = None,
        multimask_output: bool = True,
    ) -> tuple[Any, Any, Any]:
        if self._adapter is None:
            raise RuntimeError("Sam3p1Variant.predict_point called before load()")
        return self._adapter.predict(
            point_coords=point_coords,
            point_labels=point_labels,
            box=box,
            mask_input=mask_input,
            multimask_output=multimask_output,
        )

    def predict_text(
        self,
        *,
        image_b64: str,
        text: str,
        threshold: float | None = None,
        use_vlm_fo1: bool = False,
        epsilon_factor: float | None = None,
    ) -> list[dict]:
        """Run a text prompt and return [{counts, size, score, bbox, polygon}, ...]
        sorted by score desc.

        Uses self._adapter — the same instance as predict_point. No second
        Sam3p1NativeImagePredictorAdapter is built; this is the structural
        fix for the double-load OOM bug.

        ``epsilon_factor`` is the Douglas-Peucker simplification tolerance
        the editor sends from its "Polygon approximation points" slider
        (0..100 → 0.01..0.0001 via the frontend formula). ``None`` keeps
        the polygonize default. Previously this auto-annotate path
        ignored the slider — the bug Armin reported when setting 25 or
        75 had no visible effect on auto-annotated polygons.
        """
        if self._adapter is None:
            raise RuntimeError("Sam3p1Variant.predict_text called before load()")

        torch = _import_torch()

        image_np = _decode_image_b64_to_numpy(image_b64)
        # CRITICAL: route through self.set_image() so cache state AND
        # _prev_logits/_prev_n_points are all atomically updated.
        # Direct adapter.set_image() would leave stale refinement logits.
        self.set_image(image_np)

        adapter = self._adapter  # local alias after set_image succeeded
        state = adapter._state
        if state is None:
            return []

        # Single-text: encode image then run one text. Behaviour is
        # byte-identical to before — the per-text work now lives in the
        # shared helper so predict_text_multi can reuse one set_image().
        return self._text_on_loaded_state(
            adapter=adapter,
            state=state,
            text=text,
            threshold=threshold,
            use_vlm_fo1=use_vlm_fo1,
            epsilon_factor=epsilon_factor,
            image_b64=image_b64,
            torch=torch,
        )

    def predict_text_multi(
        self,
        *,
        image_b64: str,
        texts: list[str],
        threshold: float | None = None,
        use_vlm_fo1: bool = False,
        epsilon_factor: float | None = None,
    ) -> list[list[dict]]:
        """Run many text prompts against ONE image encode.

        ``result[i]`` is byte-identical to a standalone
        ``predict_text(text=texts[i])`` call. Why this is safe (verified
        against the native ``Sam3Processor`` source):

          * ``set_image`` (the expensive ViT backbone) is a pure
            function of the image — computing it once vs N times yields
            the same ``backbone_out`` features.
          * ``_text_on_loaded_state`` begins with
            ``reset_all_prompts``, which deletes every ``language_*``
            key + prior boxes/masks/scores from the state.
          * ``set_text_prompt`` then recomputes ``forward_text`` for the
            new prompt and ``.update()``s ``backbone_out`` ("will erase
            the previous text prompt").

        So there is zero cross-text contamination; only the redundant
        per-prompt image encode (and the per-prompt MinIO fetch / b64 /
        HTTP on the API side) is eliminated. This is the dominant
        auto-annotate speed win for multi-class tasks.
        """
        if self._adapter is None:
            raise RuntimeError(
                "Sam3p1Variant.predict_text_multi called before load()"
            )
        torch = _import_torch()
        if not texts:
            return []

        image_np = _decode_image_b64_to_numpy(image_b64)
        # The ONE expensive backbone encode for the whole prompt list.
        self.set_image(image_np)

        adapter = self._adapter
        state = adapter._state
        if state is None:
            return [[] for _ in texts]

        out: list[list[dict]] = []
        for t in texts:
            out.append(
                self._text_on_loaded_state(
                    adapter=adapter,
                    state=state,
                    text=t,
                    threshold=threshold,
                    use_vlm_fo1=use_vlm_fo1,
                    epsilon_factor=epsilon_factor,
                    image_b64=image_b64,
                    torch=torch,
                )
            )
        return out

    def _text_on_loaded_state(
        self,
        *,
        adapter: Any,
        state: Any,
        text: str,
        threshold: float | None,
        use_vlm_fo1: bool,
        epsilon_factor: float | None,
        image_b64: str,
        torch: Any,
    ) -> list[dict]:
        """Per-text work against an already-``set_image``'d state.

        Verbatim extraction of the original predict_text body (from
        ``reset_all_prompts`` onward) — unchanged so single-call results
        stay byte-identical; shared by predict_text + predict_text_multi.
        """
        adapter._processor.reset_all_prompts(state)

        processor = adapter._processor
        original_threshold = None
        if threshold is not None:
            original_threshold = getattr(processor, "confidence_threshold", 0.5)
            try:
                processor.set_confidence_threshold(float(threshold))
            except Exception:
                original_threshold = None

        try:
            if adapter._device == "cuda" and torch is not None:
                with torch.no_grad():
                    with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
                        processor.set_text_prompt(text, state)
            else:
                if torch is not None:
                    with torch.no_grad():
                        processor.set_text_prompt(text, state)
                else:
                    processor.set_text_prompt(text, state)
        finally:
            if original_threshold is not None:
                try:
                    processor.set_confidence_threshold(original_threshold)
                except Exception:
                    pass

        detections = _extract_text_detections(state)
        boxes = state.get("boxes")
        boxes_np = to_numpy_safe(boxes) if boxes is not None else None

        rows: list[dict] = []
        for i, (mask_np, score) in enumerate(detections):
            counts, size = encode_mask_rle(mask_np)
            polygon = mask_to_polygon(mask_np, epsilon_factor=epsilon_factor)
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

        top_score = rows[0]["score"] if rows else 0.0
        min_score = rows[-1]["score"] if rows else 0.0
        log.info(
            "sam3.1 text-prompt: text=%r threshold=%s detections=%d "
            "score_range=[%.3f, %.3f]",
            text,
            f"{threshold:.3f}" if threshold is not None else "default",
            len(rows),
            min_score,
            top_score,
        )

        # GPU-hygiene: drop state tensors before next call
        if "masks_logits" in state: state["masks_logits"] = None
        if "masks" in state: state["masks"] = None
        if "boxes" in state: state["boxes"] = None
        if "scores" in state: state["scores"] = None
        if adapter._device == "cuda" and torch is not None:
            try:
                torch.cuda.empty_cache()
            except Exception:
                pass

        if not use_vlm_fo1 or not rows:
            return rows

        import os
        try:
            top_k = int(os.environ.get("SAM3_TOPK_PROPOSALS", "64"))
        except ValueError:
            top_k = 64
        if top_k > 0 and len(rows) > top_k:
            rows = rows[:top_k]

        from carve_model.sam import predictor as p_mod
        vlm_filter = p_mod.get_vlm_fo1_filter()
        if vlm_filter is None:
            return rows

        try:
            from io import BytesIO
            from PIL import Image  # type: ignore[import-not-found]
            img_bytes = base64.b64decode(image_b64)
            pil = Image.open(BytesIO(img_bytes)).convert("RGB")
            boxes_xyxy = [list(r["bbox"]) for r in rows]
            indexes = vlm_filter(image=pil, text=text, boxes=boxes_xyxy)
        except Exception as exc:
            log.warning("vlm_fo1 filter failed (%s); degrading to passthrough", exc)
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

    def predict_box(
        self,
        *,
        image_b64: str,
        boxes: list[list[float]],
        box_labels: list[int],
        text: str | None = None,
        epsilon_factor: float | None = None,
    ) -> list[dict]:
        """For each positive box (label=1), run predict_inst with
        multimask_output=False and keep the resulting mask. Optional text
        is applied first via set_text_prompt to bias the concept. Negative
        boxes (label=0) subtract from the union of positive masks.

        Uses self._adapter — same instance as predict_point/predict_text.

        ``epsilon_factor`` — Douglas-Peucker tolerance from the editor's
        polygon-approximation slider; ``None`` keeps the polygonize
        default. See ``predict_text`` for the full rationale.
        """
        if self._adapter is None:
            raise RuntimeError("Sam3p1Variant.predict_box called before load()")

        import numpy as np
        torch = _import_torch()

        image_np = _decode_image_b64_to_numpy(image_b64)
        # Route through self.set_image() to atomically refresh cache + clear prev_logits
        self.set_image(image_np)

        adapter = self._adapter
        state = adapter._state
        if state is None:
            return []

        adapter._processor.reset_all_prompts(state)

        if text:
            if adapter._device == "cuda" and torch is not None:
                with torch.no_grad():
                    with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
                        adapter._processor.set_text_prompt(text, state)
            else:
                if torch is not None:
                    with torch.no_grad():
                        adapter._processor.set_text_prompt(text, state)
                else:
                    adapter._processor.set_text_prompt(text, state)

        positive_masks: list[Any] = []
        negative_masks: list[Any] = []
        positive_scores: list[float] = []
        positive_boxes: list[list[float]] = []

        for box, label in zip(boxes, box_labels, strict=False):
            box_arr = np.asarray(box, dtype=np.float32).reshape(-1)
            result = self._run_box_predict_inst(state=state, box_arr=box_arr)
            if not result:
                continue
            best_mask, best_score = result
            if int(label) == 1:
                positive_masks.append(best_mask)
                positive_scores.append(best_score)
                positive_boxes.append([float(x) for x in box_arr.tolist()])
            else:
                negative_masks.append(best_mask)

        if not positive_masks:
            return []

        # Subtract union of negatives from each positive mask
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
            polygon = mask_to_polygon(mask_np, epsilon_factor=epsilon_factor)
            rows.append({
                "counts": counts,
                "size": size,
                "score": score,
                "bbox": bbox,
                "polygon": polygon,
            })
        rows.sort(key=lambda r: r["score"], reverse=True)

        # GPU-hygiene: clear state-dict tensors + empty_cache
        if "masks_logits" in state: state["masks_logits"] = None
        if "masks" in state: state["masks"] = None
        if "boxes" in state: state["boxes"] = None
        if "scores" in state: state["scores"] = None
        if adapter._device == "cuda" and torch is not None:
            try:
                torch.cuda.empty_cache()
            except Exception:
                pass

        return rows

    def _run_box_predict_inst(
        self,
        *,
        state: dict,
        box_arr: Any,
    ) -> tuple[Any, float] | None:
        """Run one box prediction via adapter._model.predict_inst. Returns
        (best_mask, best_score) or None when no mask produced. Factored
        out so tests can stub without importing torch."""
        if self._adapter is None:
            return None

        import numpy as np
        torch = _import_torch()
        adapter = self._adapter

        if adapter._device == "cuda" and torch is not None:
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
            if torch is not None:
                with torch.no_grad():
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
            return None
        best_idx = int(np.argmax(np.asarray(scores)))
        best_mask = np.asarray(masks[best_idx]).astype(np.uint8)
        best_score = float(np.asarray(scores)[best_idx])
        return (best_mask, best_score)

    def predict_visual(
        self,
        *,
        target_b64: str,
        refer_b64: str,
        regions: list[dict],
        threshold: float | None = None,
        text_hint: str | None = None,  # noqa: ARG002 — kept for API parity
        epsilon_factor: float | None = None,
    ) -> list[dict]:
        """SAM 3.1 visual prompt via CLIP image-image similarity.

        Uses self._adapter — same instance as predict_point/text/box. This
        completes the OOM-fix invariant: one Sam3p1NativeImagePredictorAdapter
        serves all four predict_* methods.

        Algorithm pedigree (CLIP-based scoring of SAM 3.1 PCS proposals with
        adaptive baseline rescaling + greedy NMS) originated in the legacy
        ``sam3_adapter.make_sam3_visual_predictor`` (deleted in Phase 6; see
        git history for the original implementation).
        """
        if self._adapter is None:
            raise RuntimeError("Sam3p1Variant.predict_visual called before load()")

        import logging as _log
        import numpy as np

        if not regions:
            return []

        log_v = _log.getLogger("carve_model.sam.visual_prompt")
        target = _decode_image_b64_to_numpy(target_b64)
        refer = _decode_image_b64_to_numpy(refer_b64)

        # 1. Encode each refer region with CLIP — keep ALL embeddings
        #    (max-similarity scoring over the set, not a mean prototype).
        ref_embeds: list[Any] = []
        for region in regions:
            crop, mask_in_crop = _crop_refer_with_mask(
                refer, region, pad_ratio=0.20,
            )
            if crop is None or crop.size == 0:
                continue
            emb = embed_image(crop, mask=mask_in_crop)
            if np.linalg.norm(emb) < 1e-6:
                continue
            ref_embeds.append(emb)
        if not ref_embeds:
            log_v.warning("SAM Visual Prompt: no usable refer crops")
            return []
        ref_stack = np.stack(ref_embeds, axis=0)  # (R, 512)
        log_v.info(
            "SAM Visual Prompt: encoded %d ref region(s)", ref_stack.shape[0],
        )

        # 2. Run the SAM inference + CLIP candidate scoring in a helper
        #    that tests can stub without torch / CLIP / SAM dependencies.
        return self._run_visual_inference(
            target=target,
            ref_stack=ref_stack,
            threshold=threshold,
            epsilon_factor=epsilon_factor,
        )

    def _run_visual_inference(
        self,
        *,
        target: Any,
        ref_stack: Any,
        threshold: float | None,
        epsilon_factor: float | None = None,
    ) -> list[dict]:
        """Run SAM 3.1 proposals on target + CLIP-score against ref_stack.

        Factored out so tests can stub without numpy/torch/CLIP dependencies.
        Returns the rows list. Operates on self._adapter, routed through
        self.set_image(target) for atomic cache + prev_logits refresh.
        """
        if self._adapter is None:
            return []

        import logging as _log
        import numpy as np
        torch = _import_torch()

        log_v = _log.getLogger("carve_model.sam.visual_prompt")
        adapter = self._adapter

        # CRITICAL: route through self.set_image() so cache state AND
        # _prev_logits/_prev_n_points are all atomically updated. Direct
        # adapter.set_image() would leave stale refinement logits.
        self.set_image(target)
        state = adapter._state
        if state is None:
            return []

        # Empirical (sam3.1 native): empty string is the high-recall
        # "concept-free" mode, returning 100+ object proposals on real
        # photos. Lower confidence floor (0.05) to see them all; CLIP
        # filters by visual similarity afterwards.
        original_thr = getattr(adapter._processor, "confidence_threshold", 0.5)
        try:
            adapter._processor.set_confidence_threshold(0.05)
        except Exception:  # noqa: BLE001
            pass

        try:
            if torch is not None:
                with torch.inference_mode():
                    if adapter._device == "cuda":
                        with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
                            adapter._processor.set_text_prompt("", state)
                    else:
                        adapter._processor.set_text_prompt("", state)
            else:
                adapter._processor.set_text_prompt("", state)
        finally:
            try:
                adapter._processor.set_confidence_threshold(original_thr)
            except Exception:  # noqa: BLE001
                pass

        masks = state.get("masks")
        boxes = state.get("boxes")
        if masks is None or boxes is None:
            log_v.warning("SAM Visual Prompt: no proposals from SAM 3.1")
            return []
        masks_np = to_numpy_safe(masks)
        if masks_np.ndim == 4 and masks_np.shape[1] == 1:
            masks_np = masks_np[:, 0]
        masks_np = (masks_np > 0).astype(np.uint8)
        boxes_np = to_numpy_safe(boxes)
        if masks_np.shape[0] == 0 or boxes_np.shape[0] == 0:
            return []

        # 3. Crop target at each proposal bbox + per-proposal mask. Drop
        #    proposals that are clearly too big — SAM occasionally emits
        #    whole-scene patches that match anything visually. 60% of
        #    image area is the cutoff; real objects rarely exceed this in
        #    well-framed photos.
        H, W = target.shape[:2]
        image_area = float(H * W)
        MAX_PROPOSAL_AREA_FRAC = 0.60

        candidate_crops: list[Any] = []
        candidate_masks: list[Any] = []
        valid_idx: list[int] = []
        n_oversized = 0
        for i, b in enumerate(boxes_np):
            x1, y1, x2, y2 = (
                int(max(0, b[0])), int(max(0, b[1])),
                int(min(W, b[2])), int(min(H, b[3])),
            )
            if x2 - x1 < 4 or y2 - y1 < 4:
                continue
            box_area = float((x2 - x1) * (y2 - y1))
            if image_area > 0 and box_area / image_area > MAX_PROPOSAL_AREA_FRAC:
                n_oversized += 1
                continue
            crop = target[y1:y2, x1:x2]
            m_full = masks_np[i]
            if m_full.shape == (H, W):
                m_crop = m_full[y1:y2, x1:x2]
            else:
                m_crop = None
            candidate_crops.append(crop)
            candidate_masks.append(m_crop)
            valid_idx.append(i)

        if not candidate_crops:
            log_v.info(
                "SAM Visual Prompt: %d proposals all degenerate (oversized: %d)",
                len(boxes_np), n_oversized,
            )
            return []
        if n_oversized:
            log_v.info(
                "SAM Visual Prompt: dropped %d oversized proposals (>%.0f%% of image)",
                n_oversized, MAX_PROPOSAL_AREA_FRAC * 100,
            )

        cand_embeds = embed_image_batch(candidate_crops, masks=candidate_masks)
        # Max-similarity over per-ref embeddings (not mean prototype).
        all_sims = cand_embeds @ ref_stack.T  # (N, R)
        raw_sim = all_sims.max(axis=1) if all_sims.size else np.zeros(0, dtype=np.float32)

        # Adaptive per-image rescale: anchor "0 rescaled" at the median
        # raw cosine across all candidates on this target image, "1
        # rescaled" at 1.0. Floor the baseline at 0.70 so easy-case
        # images still produce confident scores.
        if raw_sim.size:
            median_cos = float(np.median(raw_sim))
        else:
            median_cos = 0.70
        baseline = max(0.70, median_cos)
        denom = max(1e-3, 1.0 - baseline)
        sim = np.clip((raw_sim - baseline) / denom, 0.0, 1.0)

        # 4. Apply user threshold on the rescaled score. Default 0.4
        #    mirrors the slider default.
        sim_threshold = float(threshold) if threshold is not None else 0.4
        keep_mask = sim >= sim_threshold

        if sim.size:
            top_idx = np.argsort(-sim)[:5]
            top_pairs = [
                f"{float(raw_sim[i]):.3f}/{float(sim[i]):.3f}" for i in top_idx
            ]
        else:
            top_pairs = []
        log_v.info(
            "SAM Visual Prompt: %d proposals, %d refs, "
            "raw cos [%.3f, %.3f] med=%.3f baseline=%.3f, "
            "rescaled [%.3f, %.3f], top5(raw/rescaled)=%s, "
            "threshold %.3f keeps %d",
            len(sim), ref_stack.shape[0],
            float(raw_sim.min()) if raw_sim.size else 0.0,
            float(raw_sim.max()) if raw_sim.size else 0.0,
            median_cos, baseline,
            float(sim.min()) if sim.size else 0.0,
            float(sim.max()) if sim.size else 0.0,
            ", ".join(top_pairs),
            sim_threshold, int(keep_mask.sum()),
        )
        if not keep_mask.any():
            return []

        kept = np.where(keep_mask)[0]
        kept_sims = sim[kept]
        kept_orig_idx = [valid_idx[k] for k in kept]
        order = np.argsort(-kept_sims)[:50]
        ordered_orig_idx = [kept_orig_idx[k] for k in order]
        ordered_boxes = np.asarray(
            [boxes_np[i] for i in ordered_orig_idx], dtype=np.float32,
        )
        ordered_sims = np.asarray([kept_sims[k] for k in order], dtype=np.float32)
        keep_after_nms = _greedy_nms_indices(
            ordered_boxes, ordered_sims, iou_threshold=0.5,
        )

        out: list[dict] = []
        for k in keep_after_nms:
            orig_idx = ordered_orig_idx[k]
            m = masks_np[orig_idx]
            if m.sum() == 0:
                continue
            counts, size = encode_mask_rle(m)
            polygon = mask_to_polygon(m, epsilon_factor=epsilon_factor)
            ys, xs = np.where(m)
            tight_bbox = [
                float(xs.min()), float(ys.min()),
                float(xs.max() + 1), float(ys.max() + 1),
            ]
            out.append({
                "counts": counts,
                "size": list(size),
                "score": float(ordered_sims[k]),
                "bbox": tight_bbox,
                "polygon": polygon,
                "concept": "clip-image-similarity",
            })
        return out


import base64
import gc
import logging
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone

log = logging.getLogger(__name__)


def _extract_text_detections(state: dict) -> list[tuple[Any, float]]:
    from carve_model.sam.sam3p1_adapter import _extract_text_detections as _impl
    return _impl(state)


def _decode_image_b64_to_numpy(image_b64: str) -> Any:
    from carve_model.sam.sam3p1_adapter import _decode_image_b64_to_numpy as _impl
    return _impl(image_b64)


def encode_mask_rle(mask_np: Any) -> tuple[str, list[int]]:
    from carve_model.sam.codec import encode_mask_rle as _impl
    return _impl(mask_np)


def mask_to_polygon(
    mask_np: Any,
    *,
    epsilon_factor: float | None = None,
) -> list:
    """Wrapper used by the auto-annotate paths (predict_text/box/visual)
    so they honour the editor's "Polygon approximation points" slider.
    ``None`` keeps the polygonize default; otherwise the value is
    forwarded as the Douglas-Peucker tolerance."""
    from carve_model.sam.polygonize import mask_to_polygon as _impl
    if epsilon_factor is None:
        return _impl(mask_np)
    return _impl(mask_np, epsilon_factor=epsilon_factor)


def to_numpy_safe(x: Any) -> Any:
    from carve_model.sam.perf import to_numpy_safe as _impl
    return _impl(x)


def _crop_refer_with_mask(
    refer_image: Any,
    region: dict,
    *,
    pad_ratio: float = 0.20,
):
    """Crop the refer image at a bbox/polygon region, returning the
    crop AND a foreground mask aligned to the crop coordinates.

    For ``bbox`` regions the mask is ``None`` (the whole crop is the
    object — there's no foreground/background distinction the user
    intended).

    For ``polygon`` regions the mask is the rasterised polygon shifted
    into the cropped frame, so the caller can fade out background pixels
    inside the bbox-but-outside-the-polygon.

    Relocated from ``sam3_adapter.py`` so the helper survives the
    Task 6.3 deletion of that module.
    """
    import numpy as np
    from carve_model.sam.visual_prompt_preprocess import rasterise_polygon

    H, W = refer_image.shape[:2]
    if region["kind"] == "bbox":
        x1, y1, x2, y2 = (float(v) for v in region["xyxy"])
        polygon_pts = None
    elif region["kind"] == "polygon":
        pts = np.asarray(region["points"], dtype=float)
        if pts.size == 0:
            return None, None
        x1, y1 = pts[:, 0].min(), pts[:, 1].min()
        x2, y2 = pts[:, 0].max(), pts[:, 1].max()
        polygon_pts = pts
    else:
        return None, None

    w = x2 - x1
    h = y2 - y1
    pad_x = w * pad_ratio
    pad_y = h * pad_ratio
    cx1 = max(0, int(x1 - pad_x))
    cy1 = max(0, int(y1 - pad_y))
    cx2 = min(W, int(x2 + pad_x))
    cy2 = min(H, int(y2 + pad_y))
    if cx2 <= cx1 or cy2 <= cy1:
        return None, None
    crop = refer_image[cy1:cy2, cx1:cx2]
    if polygon_pts is None:
        return crop, None

    # Shift the polygon into crop coordinates and rasterise at crop size.
    shifted = polygon_pts.copy()
    shifted[:, 0] -= cx1
    shifted[:, 1] -= cy1
    crop_h, crop_w = crop.shape[:2]
    mask = rasterise_polygon(shifted.tolist(), crop_h, crop_w)
    return crop, mask


def _greedy_nms_indices(
    boxes: Any,
    scores: Any,
    *,
    iou_threshold: float = 0.5,
    containment_threshold: float = 0.85,
) -> Any:
    """Greedy suppression that handles two failure modes plain IoU misses:

    1. **Nested boxes** (small inside big, or big around small). Plain
       IoU is small/big which can be far below the threshold even when
       one box is fully inside the other. We add ``containment`` =
       ``inter / min(area_a, area_b)`` which goes to 1.0 when one box
       is contained in the other regardless of relative size, and
       suppress when ``containment >= containment_threshold``.
    2. **Slightly-different segmentations of the same object**. Two
       SAM proposals for the same object may have IoU ~ 0.4-0.5 from
       boundary jitter alone. Suppressing on ``max(iou, containment)``
       and a slightly looser IoU threshold (default 0.5 still) catches
       both cases.

    ``boxes`` is (N, 4) xyxy. Returns kept indices (highest-score-first).

    Relocated from ``sam3_adapter.py`` so the helper survives the
    Task 6.3 deletion of that module.
    """
    import numpy as np
    if boxes.shape[0] == 0:
        return np.zeros((0,), dtype=np.int64)
    x1 = boxes[:, 0]; y1 = boxes[:, 1]
    x2 = boxes[:, 2]; y2 = boxes[:, 3]
    areas = np.maximum(0.0, x2 - x1) * np.maximum(0.0, y2 - y1)
    order = np.argsort(-scores)
    keep: list[int] = []
    while order.size > 0:
        i = int(order[0])
        keep.append(i)
        if order.size == 1:
            break
        rest = order[1:]
        xx1 = np.maximum(x1[i], x1[rest])
        yy1 = np.maximum(y1[i], y1[rest])
        xx2 = np.minimum(x2[i], x2[rest])
        yy2 = np.minimum(y2[i], y2[rest])
        inter = np.maximum(0.0, xx2 - xx1) * np.maximum(0.0, yy2 - yy1)
        union = areas[i] + areas[rest] - inter
        iou = np.where(union > 0, inter / union, 0.0)
        smaller = np.minimum(areas[i], areas[rest])
        containment = np.where(smaller > 0, inter / smaller, 0.0)
        suppress = (iou >= iou_threshold) | (containment >= containment_threshold)
        order = rest[~suppress]
    return np.asarray(keep, dtype=np.int64)


def embed_image(image: Any, mask: Any = None) -> Any:
    from carve_model.sam.clip_embed import embed_image as _impl
    return _impl(image, mask=mask)


def embed_image_batch(images: Any, masks: Any = None) -> Any:
    from carve_model.sam.clip_embed import embed_image_batch as _impl
    return _impl(images, masks=masks)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _short_repr(exc: BaseException, maxlen: int = 200) -> str:
    s = repr(exc)
    return s if len(s) <= maxlen else s[: maxlen - 3] + "..."


_ALLOWED_VARIANTS = frozenset({
    "sam2.1-tiny",
    "sam2.1-small",
    "sam2.1-base-plus",
    "sam2.1-large",
    "sam3.1",
})


def _import_torch() -> Any | None:
    """Lazy torch import for cleanup helpers. Returns None when torch is absent."""
    try:
        import torch  # type: ignore[import-not-found]
        return torch
    except Exception:
        return None


def _build_variant(name: str) -> SamVariant:
    """Build a fresh variant instance for `name`. Does not call load()."""
    if name.startswith("sam2"):
        return Sam2Variant(name)
    if name == "sam3.1":
        return Sam3p1Variant()
    raise ValueError(f"unknown SAM variant: {name!r}")


# Tiny synthetic image used to prime the encoder. 64×64 keeps the forward
# pass cheap on CUDA (<100 ms) while still exercising the full
# preprocess → backbone → embedding path the user's first click would
# otherwise pay for. The bright square avoids a fully-black input that
# some preprocessors short-circuit.
_WARMUP_IMAGE_SIDE = 64


def _build_warmup_image() -> Any:
    import numpy as np

    dummy = np.zeros(
        (_WARMUP_IMAGE_SIDE, _WARMUP_IMAGE_SIDE, 3), dtype=np.uint8,
    )
    quarter = _WARMUP_IMAGE_SIDE // 4
    dummy[quarter : -quarter, quarter : -quarter] = 255
    return dummy


def _run_warmup(variant: "SamVariant") -> None:
    """Synthetic ``set_image`` against ``variant`` so the next real call
    doesn't pay encoder-forward lazy-init costs (torch.compile graph
    capture, CUDA kernel autotuning, allocator warmup). Resets the
    variant's cached_hash + prev_logits so the user's first /sam/encode
    re-encodes against the real image instead of accepting our dummy.

    Exceptions propagate to ``ensure_loaded``'s existing handler so a
    genuinely-broken model surfaces as ``state=error`` (correct) rather
    than a silent "ready" lie."""
    variant.set_image(_build_warmup_image())
    variant._cached_hash = None  # type: ignore[attr-defined]
    variant._cached_shape = None  # type: ignore[attr-defined]
    variant._prev_logits = None  # type: ignore[attr-defined]
    variant._prev_n_points = 0  # type: ignore[attr-defined]


def _is_cuda_oom(exc: BaseException) -> bool:
    """Best-effort detection of torch.cuda.OutOfMemoryError without importing torch."""
    cls_name = type(exc).__name__
    if "OutOfMemory" in cls_name:
        return True
    msg = str(exc).lower()
    return "out of memory" in msg or "cuda oom" in msg


class SamLifecycleManager:
    """Single owner of the resident SAM variant.

    Two locks:
    - _inference_lock: held during the full load operation AND during each
      inference call. Serializes everything against everything.
    - _load_lock: short critical sections only — state field mutation.

    Acquire order if both are needed: _inference_lock OUTER, _load_lock INNER.
    """

    DEFAULT_IDLE_TIMEOUT_S = 15 * 60  # 15 minutes

    def __init__(self) -> None:
        self._active: SamVariant | None = None
        self._test_variant: SamVariant | None = None
        self._state: LoadState = LoadState.idle()
        self._last_used_at: float | None = None
        self._remembered_variant: str | None = None
        self._inference_lock = threading.Lock()
        self._load_lock = threading.Lock()

    def status(self) -> LoadState:
        with self._load_lock:
            return self._state

    def install_test_variant(self, v: SamVariant | None) -> None:
        """Install a fake variant — bypasses load()/lease() locks entirely.

        When set, lease() yields this directly without acquiring locks or
        checking state. ensure_loaded/force_unload/evict_if_idle become
        no-ops. Pass None to uninstall."""
        self._test_variant = v

    def remembered_variant(self) -> str | None:
        with self._load_lock:
            return self._remembered_variant

    def _reset_for_tests(self) -> None:
        """Pytest-only reset to a clean post-construction state."""
        with self._inference_lock:
            with self._load_lock:
                self._active = None
                self._test_variant = None
                self._state = LoadState.idle()
                self._last_used_at = None
                self._remembered_variant = None

    def _run_cuda_cleanup(self) -> None:
        """Full eviction cleanup: 3x gc + sync + empty_cache + ipc_collect + dynamo.reset.

        Same sequence as predictor.py's force_evict_predictor() — centralized
        here so every unload path (idle, force, switch) gets identical cleanup."""
        torch = _import_torch()
        for _ in range(3):
            gc.collect()
            if torch is not None:
                try:
                    if torch.cuda.is_available():
                        torch.cuda.synchronize()
                        torch.cuda.empty_cache()
                except Exception:
                    pass
        try:
            import torch._dynamo  # type: ignore[import-not-found]
            torch._dynamo.reset()
        except Exception:
            pass
        if torch is not None:
            try:
                if torch.cuda.is_available():
                    torch.cuda.ipc_collect()
            except Exception:
                pass

    def _run_cuda_cleanup_light(self) -> None:
        """Best-effort empty_cache only. Used after inference OOM."""
        torch = _import_torch()
        if torch is None:
            return
        try:
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass

    def ensure_loaded(self, variant: str, *, device: str | None = None) -> None:
        """Switch the manager to `variant`. Idempotent if already loaded.

        Synchronous. Callers that need a 202-style endpoint should run this
        in a background thread.

        Raises ValueError for unknown variants, SamLoadError on load failure.
        """
        if self._test_variant is not None:
            return  # test mode — never touches real lifecycle

        if variant not in _ALLOWED_VARIANTS:
            raise ValueError(f"unknown SAM variant: {variant!r}")

        # Fast-path: already on it
        with self._load_lock:
            if (
                self._state.kind == "ready"
                and self._active is not None
                and self._active.name == variant
            ):
                self._remembered_variant = variant
                return

        # Slow-path: take inference lock first (waits for in-flight inference)
        self._inference_lock.acquire()
        try:
            # Re-check under both locks
            with self._load_lock:
                if (
                    self._state.kind == "ready"
                    and self._active is not None
                    and self._active.name == variant
                ):
                    self._remembered_variant = variant
                    return
                self._state = LoadState.loading(variant, started_at=_now_iso())

            # Unload existing (if any)
            if self._active is not None:
                self._try_unload_locked(self._active)
                self._active = None
                self._run_cuda_cleanup()

            # Build + load new
            new_variant: SamVariant | None = None
            try:
                new_variant = _build_variant(variant)
                resolved = self._resolve_device(device)
                new_variant.load(device=resolved)
                # Surface lazy-init costs BEFORE flipping state→ready so
                # the frontend's "SAM ready" toast doesn't lie. Optional
                # on the variant — _LegacyTestVariant has no warmup, so
                # we attribute-probe instead of relying on the Protocol.
                warmup = getattr(new_variant, "warmup", None)
                if callable(warmup):
                    warmup()
            except Exception as exc:
                if new_variant is not None:
                    self._try_unload_locked(new_variant)
                self._run_cuda_cleanup()
                with self._load_lock:
                    self._state = LoadState.error_(variant, _short_repr(exc))
                    self._active = None
                    self._remembered_variant = variant
                raise SamLoadError(variant, exc) from exc

            with self._load_lock:
                self._active = new_variant
                self._state = LoadState.ready(variant, loaded_at=_now_iso())
                self._last_used_at = time.monotonic()
                self._remembered_variant = variant
        finally:
            self._inference_lock.release()

    def _try_unload_locked(self, v: SamVariant) -> None:
        """Best-effort unload — logs and swallows exceptions."""
        try:
            v.unload()
        except Exception:
            log.exception("variant %s unload raised; continuing with GC", v.name)

    def _resolve_device(self, device: str | None) -> str | None:
        """Device resolution wiring. Phase 1 returns the caller's value as-is."""
        return device

    @contextmanager
    def lease(self):
        """Acquire exclusive use of the active variant.

        Yields the SamVariant. Acquires _inference_lock; ticks _last_used_at
        on enter and exit. Raises SamNotReadyError when not in 'ready' state.
        CUDA OOM during the lease block triggers a light cleanup before reraising.
        """
        if self._test_variant is not None:
            yield self._test_variant
            return
        self._inference_lock.acquire()
        try:
            with self._load_lock:
                if self._state.kind != "ready" or self._active is None:
                    raise SamNotReadyError(self._state.kind)
                self._last_used_at = time.monotonic()
                active = self._active
            try:
                yield active
            except Exception as exc:
                if _is_cuda_oom(exc):
                    self._run_cuda_cleanup_light()
                    log.warning("inference OOM in %s: %s", active.name, exc)
                raise
        finally:
            with self._load_lock:
                self._last_used_at = time.monotonic()
            self._inference_lock.release()

    def _idle_timeout_s(self) -> int:
        """Return SAM_IDLE_TIMEOUT_S env var (default 900s; 0 disables)."""
        import os
        raw = os.environ.get("SAM_IDLE_TIMEOUT_S", str(self.DEFAULT_IDLE_TIMEOUT_S))
        try:
            v = int(raw)
            return max(0, v)
        except ValueError:
            return self.DEFAULT_IDLE_TIMEOUT_S

    def force_unload(self) -> bool:
        """Drop the active variant + run GPU cleanup. Returns True iff freed."""
        if self._test_variant is not None:
            return False
        self._inference_lock.acquire()
        try:
            with self._load_lock:
                if self._active is None and self._state.kind == "idle":
                    return False
                old = self._active
                self._active = None
            if old is not None:
                self._try_unload_locked(old)
            self._run_cuda_cleanup()
            with self._load_lock:
                self._state = LoadState.idle()
                self._last_used_at = None
            return True
        finally:
            self._inference_lock.release()

    def evict_if_idle(self) -> bool:
        """No-op when not idle, when timeout=0, or when last_used is fresh."""
        if self._test_variant is not None:
            return False
        timeout = self._idle_timeout_s()
        if timeout == 0:
            return False
        with self._load_lock:
            if self._active is None or self._last_used_at is None:
                return False
            if (time.monotonic() - self._last_used_at) < timeout:
                return False
        self._inference_lock.acquire()
        try:
            with self._load_lock:
                if self._active is None or self._last_used_at is None:
                    return False
                if (time.monotonic() - self._last_used_at) < timeout:
                    return False
                old = self._active
                self._active = None
            self._try_unload_locked(old)
            self._run_cuda_cleanup()
            with self._load_lock:
                self._state = LoadState.idle()
                self._last_used_at = None
            log.info("sam_lifecycle: evicted_on_idle variant=%s", old.name)
            return True
        finally:
            self._inference_lock.release()

    @contextmanager
    def lease_or_load(self):
        """Canonical router entry point: lease the active variant; lazily
        load the last-known variant if currently idle.

        Other not-ready states (loading, error) propagate as SamNotReadyError.
        """
        try:
            with self.lease() as sam:
                yield sam
                return
        except SamNotReadyError as e:
            if e.state != "idle":
                raise
        variant = self.remembered_variant() or self._env_default_variant()
        self.ensure_loaded(variant)
        with self.lease() as sam:
            yield sam

    def _env_default_variant(self) -> str:
        """Read SAM_MODEL env var with the production default fallback."""
        import os
        return os.environ.get("SAM_MODEL", "sam2.1-large")


# Module-level singleton — the production manager.
manager = SamLifecycleManager()


class _LegacyTestVariant:
    """Aggregator that wraps the four old test-injection callables into one
    SamVariant. Used by predictor.py back-compat shims so existing tests
    work unchanged while the routers migrate to manager.lease_or_load().

    Each _<op>_impl is initially None; capability flags follow `is not None`.
    """

    name = "legacy-test"
    device = None
    build_key = ("legacy-test", "fp32", "sdpa")

    def __init__(self) -> None:
        self._point_impl: Any | None = None
        self._text_impl: Any | None = None
        self._box_impl: Any | None = None
        self._visual_impl: Any | None = None
        self._cached_hash: str | None = None
        self._cached_shape: tuple[int, int] | None = None
        self._prev_logits: Any | None = None
        self._prev_n_points: int = 0

    @property
    def supports_text(self) -> bool: return self._text_impl is not None
    @property
    def supports_box(self) -> bool: return self._box_impl is not None
    @property
    def supports_visual(self) -> bool: return self._visual_impl is not None

    def load(self, device): pass
    def unload(self): pass

    def set_image(self, image: Any, *, image_hash: str | None = None) -> str:
        h = image_hash if image_hash is not None else _hash_image(image)
        self._cached_hash = h
        self._cached_shape = (int(image.shape[0]), int(image.shape[1]))
        if self._point_impl is not None and hasattr(self._point_impl, "set_image"):
            self._point_impl.set_image(image)
        return h

    def cached_image_hash(self) -> str | None: return self._cached_hash
    def cached_image_shape(self) -> tuple[int, int] | None: return self._cached_shape

    def extract_embedding(self) -> bytes | None:
        if self._point_impl is None:
            return None
        getter = getattr(self._point_impl, "extract_embedding", None)
        return getter() if getter is not None else None

    def set_prev_logits(self, low_res_logits, n_points):
        self._prev_logits = low_res_logits
        self._prev_n_points = int(n_points)

    def get_prev_logits(self):
        return (self._prev_logits, self._prev_n_points)

    def predict_point(self, **kw):
        if self._point_impl is None:
            raise SamCapabilityError("legacy variant: no point impl injected")
        if callable(self._point_impl):
            return self._point_impl(**kw)
        return self._point_impl.predict(**kw)

    def predict_text(self, **kw):
        if self._text_impl is None:
            raise SamCapabilityError("legacy variant: no text impl injected")
        return self._text_impl(**kw)

    def predict_text_multi(self, *, image_b64, texts, **kw):
        # Legacy variants have no batched impl — loop the single path so
        # behaviour is preserved (correct, just no encode-once speedup;
        # the SAM 3.1 native variant is the one that matters for speed).
        if self._text_impl is None:
            raise SamCapabilityError("legacy variant: no text impl injected")
        return [
            self._text_impl(image_b64=image_b64, text=t, **kw) for t in texts
        ]

    def predict_box(self, **kw):
        if self._box_impl is None:
            raise SamCapabilityError("legacy variant: no box impl injected")
        return self._box_impl(**kw)

    def predict_visual(self, **kw):
        if self._visual_impl is None:
            raise SamCapabilityError("legacy variant: no visual impl injected")
        return self._visual_impl(**kw)
