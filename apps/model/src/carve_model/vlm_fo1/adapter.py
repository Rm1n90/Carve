"""VLM-FO1 precision filter — turns SAM 3's mask proposals into a
filtered subset that actually matches the user's text query.

Pipeline shape (image-only path; video out per spec):

  1. SAM 3 ``Sam3Model.post_process_instance_segmentation`` returns N
     candidate (mask, box, score) proposals for a text concept.
  2. The caller drops the lowest-confidence boxes by ``score`` and
     hands the survivors to this filter as ``(image, text, boxes)``.
  3. We build a Qwen2.5-VL-style chat message with the image + the FO1
     OD prompt + the bbox list, run inference, and parse the model's
     ``<region N>`` tokens out of the decoded text.
  4. We return the matched indexes — the caller subsets masks/boxes/
     scores accordingly.

Heavy imports (``torch``, ``transformers``, ``PIL``) are deferred to
function bodies. The module itself can be imported in the dev path
without GPU extras installed; mirrors the policy used in
``carve_model.sam.sam3_adapter``.

The default checkpoint ``omlab/VLM-FO1_Qwen2.5-VL-3B-v01`` is the
Qwen2.5-VL-3B base + the FO1 Hybrid Fine-grained Region Encoder head.
~3 GB at 4-bit quantization.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Protocol, runtime_checkable

logger = logging.getLogger(__name__)


# --- public surface ---------------------------------------------------------


DEFAULT_MODEL_PATH = "omlab/VLM-FO1_Qwen2.5-VL-3B-v01"
"""Hugging Face repo for the FO1 Qwen2.5-VL-3B checkpoint."""

DEFAULT_MAX_BOXES = 64
"""Cap on box count sent to FO1 per call.

Higher values increase recall but also context length and inference
time. The FO1 reference (``inference_with_sam3.py``) uses 100; 64 is a
conservative default that keeps P95 latency reasonable on 24 GB GPUs.
"""


@runtime_checkable
class VlmFo1Filter(Protocol):
    """Callable contract for the VLM-FO1 precision filter."""

    def __call__(
        self,
        *,
        image: Any,
        text: str,
        boxes: list[list[float]],
    ) -> list[int]: ...


# --- output parsing ---------------------------------------------------------


# Native FO1 envelope: ``<ground>label</ground><objects><region0></objects>``.
# We do not enforce the envelope because some decodes truncate it; bare
# ``<region\d+>`` tokens are common enough to handle without the wrapper.
_REGION_TOKEN_RE = re.compile(r"<\s*r(?:egion)?\s*_?\s*(\d+)\s*>")
"""Tolerates: ``<region0>``, ``<region_0>``, ``<r0>``, ``<r 0>``,
``<region 0>``. Captures the integer index."""

_BARE_REGION_RE = re.compile(r"\bregion[\s_]*(\d+)\b")
"""Fallback for unwrapped tokens like ``region 0`` or ``region_2``
inside a bracket like ``[region_2]``."""


def _extract_indexes_from_output(output_text: str, n_boxes: int) -> list[int]:
    """Parse VLM-FO1's decoded text into a list of valid box indexes.

    Behaviour:
      - Empty input → empty list.
      - Out-of-range indexes (≥ ``n_boxes`` or < 0) silently dropped.
      - Duplicates removed, first-seen order preserved (the model emits
        higher-confidence picks first; downstream callers honor order).
      - ``n_boxes <= 0`` → empty list (nothing valid can match).
    """
    if not output_text or n_boxes <= 0:
        return []

    seen: set[int] = set()
    out: list[int] = []

    for match in _REGION_TOKEN_RE.finditer(output_text):
        try:
            idx = int(match.group(1))
        except (ValueError, TypeError):
            continue
        if 0 <= idx < n_boxes and idx not in seen:
            seen.add(idx)
            out.append(idx)

    for match in _BARE_REGION_RE.finditer(output_text):
        try:
            idx = int(match.group(1))
        except (ValueError, TypeError):
            continue
        if 0 <= idx < n_boxes and idx not in seen:
            seen.add(idx)
            out.append(idx)

    return out


# --- lazy model loader ------------------------------------------------------


def _build_vlm_fo1_pair(
    model_path: str = DEFAULT_MODEL_PATH,
    quant: str | None = None,
) -> tuple[Any, Any, Any, str]:
    """Load (tokenizer, model, image_processor, device) lazily.

    Triggered on the first ``filter(...)`` call. Imports torch +
    transformers only here so the dev path stays import-clean.

    Patched in tests to return cheap fakes — see
    ``apps/model/tests/vlm_fo1/test_adapter.py``.
    """
    import torch  # type: ignore[import-not-found]
    from transformers import (  # type: ignore[import-not-found]
        AutoModelForCausalLM,
        AutoProcessor,
        AutoTokenizer,
    )

    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16 if device == "cuda" else torch.float32

    load_kwargs: dict[str, Any] = {"trust_remote_code": True}
    if quant == "4bit":
        try:
            from transformers import BitsAndBytesConfig  # type: ignore[import-not-found]

            load_kwargs["quantization_config"] = BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_compute_dtype=dtype,
                bnb_4bit_quant_type="nf4",
                bnb_4bit_use_double_quant=True,
            )
        except ImportError:
            logger.warning(
                "VLM_FO1_QUANT=4bit requested but bitsandbytes not installed; "
                "falling back to bf16",
            )
            load_kwargs["dtype"] = dtype
    else:
        load_kwargs["dtype"] = dtype

    tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
    processor = AutoProcessor.from_pretrained(model_path, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(model_path, **load_kwargs)
    if "quantization_config" not in load_kwargs:
        model = model.to(device)
    model.eval()

    return tokenizer, model, processor, device


# --- filter factory ---------------------------------------------------------


def make_vlm_fo1_filter(
    *,
    model_path: str = DEFAULT_MODEL_PATH,
    quant: str | None = None,
    max_boxes: int = DEFAULT_MAX_BOXES,
    max_new_tokens: int = 4096,
) -> VlmFo1Filter:
    """Return a closure-private FO1 filter.

    The closure caches a singleton (tokenizer, model, processor, device)
    tuple so repeated calls reuse the loaded weights. Tests patch
    ``_build_vlm_fo1_pair`` to skip the real load.

    Failure handling:
      - ``boxes == []``         → return ``[]`` immediately, no load.
      - blank ``text``          → degrade to passthrough (return
        ``list(range(len(boxes)))``) — SAM 3 already produced the
        proposals, dropping them all on missing query is worse UX.
      - model raises mid-call   → degrade to passthrough, log once.
      - parser finds 0 indexes  → return ``[]`` (legitimate "no match").
    """
    state: dict[str, Any] = {}

    def _ensure_loaded() -> tuple[Any, Any, Any, str]:
        if "model" not in state:
            tok, model, proc, device = _build_vlm_fo1_pair(
                model_path=model_path, quant=quant,
            )
            state["tokenizer"] = tok
            state["model"] = model
            state["processor"] = proc
            state["device"] = device
        return (
            state["tokenizer"],
            state["model"],
            state["processor"],
            state["device"],
        )

    def _filter(
        *,
        image: Any,
        text: str,
        boxes: list[list[float]],
    ) -> list[int]:
        n = len(boxes)
        if n == 0:
            return []
        if not text or not text.strip():
            return list(range(n))

        capped_boxes = boxes[:max_boxes]
        capped_n = len(capped_boxes)

        try:
            tokenizer, model, processor, _device = _ensure_loaded()
            output_text = _run_inference(
                tokenizer=tokenizer,
                model=model,
                processor=processor,
                image=image,
                text=text,
                boxes=capped_boxes,
                max_new_tokens=max_new_tokens,
            )
        except Exception as exc:  # noqa: BLE001 -- graceful degradation
            logger.warning(
                "vlm_fo1 filter failed (%s); degrading to passthrough", exc,
            )
            return list(range(n))

        return _extract_indexes_from_output(output_text, n_boxes=capped_n)

    return _filter


# --- inference ---------------------------------------------------------------


def _run_inference(
    *,
    tokenizer: Any,
    model: Any,
    processor: Any,
    image: Any,
    text: str,
    boxes: list[list[float]],
    max_new_tokens: int,
) -> str:
    """Build the FO1 chat message, run ``model.generate``, decode output.

    Mirrors the upstream reference at
    ``om-ai-lab/VLM-FO1/scripts/inference_with_sam3.py`` — image + text
    + ``bbox_list`` keyword, deterministic decode (``do_sample=False``,
    ``temperature=0.0``).
    """
    from carve_model.vlm_fo1.prompts import OD_TEMPLATE

    bbox_list = [list(b) for b in boxes]

    inputs = processor(
        image=image,
        text=text,
        bbox_list=bbox_list,
        prompt=OD_TEMPLATE.format(text),
        return_tensors="pt",
    )
    if hasattr(inputs, "to"):
        try:
            device = next(model.parameters()).device  # type: ignore[arg-type]
            inputs = inputs.to(device)
        except (AttributeError, StopIteration, TypeError):
            pass

    gen_kwargs: dict[str, Any] = {
        "max_new_tokens": max_new_tokens,
        "do_sample": False,
        "temperature": 0.0,
    }
    if isinstance(inputs, dict):
        gen_kwargs.update(inputs)
    else:
        try:
            gen_kwargs.update(dict(inputs))
        except (TypeError, ValueError):
            gen_kwargs["inputs"] = inputs

    output_ids = model.generate(**gen_kwargs)

    try:
        prompt_len = int(getattr(inputs, "shape", (0, 0))[1])
    except (AttributeError, IndexError, TypeError, ValueError):
        prompt_len = 0
    try:
        sliced = output_ids[0, prompt_len:] if prompt_len > 0 else output_ids[0]
    except (TypeError, IndexError):
        sliced = output_ids

    decoded = tokenizer.decode(sliced)
    return decoded.strip() if isinstance(decoded, str) else str(decoded)
