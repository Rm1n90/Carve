"""VLM-FO1 model runner.

Single-process, single-GPU. Lazy-loads ``omlab/VLM-FO1_Qwen2.5-VL-3B-v01``
on first ``run_filter`` call, then caches the (tokenizer, model, processor,
device) tuple in module-level state for subsequent calls.

This module runs inside a container pinned to ``transformers==4.50.1``,
matching the version upstream FO1 was authored against. None of the
compat shims that the previous in-process implementation needed (for
transformers 5.0) are present here — the version pin makes them
unnecessary.
"""

from __future__ import annotations

import base64
import logging
import os
import re
import threading
import time
from io import BytesIO
from typing import Any

logger = logging.getLogger(__name__)


DEFAULT_MODEL_PATH = "omlab/VLM-FO1_Qwen2.5-VL-3B-v01"
DEFAULT_MAX_BOXES = 64
DEFAULT_MAX_NEW_TOKENS = 4096
# v3.22 — match the SAM idle eviction default. FO1 + SAM 3 together
# saturate a 24 GB card; freeing FO1 weights when nobody's using them
# is what gives the editor (SAM) full GPU access for routine work.
DEFAULT_IDLE_TIMEOUT_S = 15 * 60


_REGION_TOKEN_RE = re.compile(r"<\s*r(?:egion)?\s*_?\s*(\d+)\s*>")
_BARE_REGION_RE = re.compile(r"\bregion[\s_]*(\d+)\b")


_state: dict[str, Any] = {}
_load_lock = threading.Lock()
_last_used_at: float = 0.0


def is_loaded() -> bool:
    return "model" in _state


def _idle_timeout_s() -> int:
    raw = os.environ.get("VLM_FO1_IDLE_TIMEOUT_S", str(DEFAULT_IDLE_TIMEOUT_S))
    try:
        v = int(raw)
        return max(0, v)
    except (TypeError, ValueError):
        return DEFAULT_IDLE_TIMEOUT_S


def _empty_cuda_cache() -> None:
    """Best-effort ``torch.cuda.empty_cache()`` — silent on failure."""
    try:
        import torch  # type: ignore[import-not-found]

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001
        pass


def evict_if_idle() -> bool:
    """Free FO1 weights + GPU memory if idle longer than the timeout.

    Returns True when eviction happened. No-op when no model is loaded,
    the timeout is 0 (disabled), or the last-used timestamp is within
    the timeout window. Mirrors ``carve_model.sam.predictor.evict_predictor_if_idle``.
    """
    timeout = _idle_timeout_s()
    if timeout == 0:
        return False
    with _load_lock:
        if "model" not in _state:
            return False
        if (time.monotonic() - _last_used_at) < timeout:
            return False
        _state.clear()
    _empty_cuda_cache()
    logger.info(
        "FO1 weights evicted after %ds idle; will lazy-load on next request",
        timeout,
    )
    return True


def gpu_used_bytes() -> int | None:
    """Best-effort current-process GPU memory (bytes), or None when no CUDA."""
    try:
        import torch  # type: ignore[import-not-found]

        if not torch.cuda.is_available():
            return None
        return int(torch.cuda.memory_reserved())
    except Exception:  # noqa: BLE001
        return None


def force_evict() -> bool:
    """Unconditionally free the cached model + GPU memory.

    v3.22 — runs ``gc.collect()`` AFTER clearing ``_state`` so Python
    actually drops references to the model module before torch tries
    to reclaim its tensors. Without the gc pass the cache call is a
    no-op when ``_state`` was the only Python ref keeping the model
    alive (the common case). Also adds ``ipc_collect`` for symmetry
    with the model service's force_evict_predictor.
    """
    import gc

    with _load_lock:
        had_model = "model" in _state
        _state.clear()
    gc.collect()
    _empty_cuda_cache()
    try:
        import torch  # type: ignore[import-not-found]

        if torch.cuda.is_available():
            torch.cuda.ipc_collect()
    except Exception:  # noqa: BLE001
        pass
    return had_model


def _resolve_model_path() -> str:
    return os.environ.get("VLM_FO1_MODEL_PATH") or DEFAULT_MODEL_PATH


def _resolve_quant() -> str | None:
    q = os.environ.get("VLM_FO1_QUANT")
    return q if q else None


def _patch_omchat_attn_to_sdpa() -> None:
    """Force every FO1 model load onto PyTorch SDPA instead of flash_attn 2.

    Upstream FO1 has at least two hardcoded ``attn_implementation="flash_attention_2"``
    sites (language model and vision tower), and flash_attn would
    require a ~30-min CUDA-toolkit compile we don't ship. Rather than
    chase each call site, we monkey-patch transformers' centralized
    flash_attn check to be a no-op that re-routes the config to SDPA.
    Result: every model class that ``_autoset_attn_implementation``
    routes through this gate quietly downgrades.

    Equivalent inference for our use case — the FO1 paper's quality
    measurements are insensitive to the attention backend.

    Idempotent — guarded by a sentinel attribute on the transformers
    class.
    """
    from transformers.modeling_utils import PreTrainedModel  # type: ignore[import-not-found]

    if getattr(PreTrainedModel, "_carve_sdpa_patched", False):
        return

    @classmethod
    def _check_and_enable_sdpa_instead(cls, config, *_args, **_kwargs):  # noqa: ANN001
        # Mirror the success branch of the original method: just record
        # sdpa as the chosen implementation and return the config.
        config._attn_implementation = "sdpa"
        return config

    PreTrainedModel._check_and_enable_flash_attn_2 = _check_and_enable_sdpa_instead
    PreTrainedModel._carve_sdpa_patched = True


def _load_model() -> None:
    if "model" in _state:
        return

    import torch  # type: ignore[import-not-found]
    from vlm_fo1.model.builder import load_pretrained_model  # type: ignore[import-not-found]

    _patch_omchat_attn_to_sdpa()

    model_path = _resolve_model_path()
    quant = _resolve_quant()
    load_4bit = quant == "4bit"
    device = "cuda" if torch.cuda.is_available() else "cpu"

    logger.info(
        "loading FO1 weights model_path=%s quant=%s device=%s",
        model_path, quant or "bf16", device,
    )

    tokenizer, model, image_processors = load_pretrained_model(
        model_path,
        load_8bit=False,
        load_4bit=load_4bit,
        device=device,
    )

    _state["tokenizer"] = tokenizer
    _state["model"] = model
    _state["processor"] = image_processors
    _state["device"] = device
    _state["model_path"] = model_path
    _state["quant"] = quant

    logger.info("FO1 weights loaded successfully")


def _ensure_loaded() -> None:
    global _last_used_at
    if "model" in _state:
        _last_used_at = time.monotonic()
        return
    with _load_lock:
        _load_model()
        _last_used_at = time.monotonic()


def _decode_image(image_b64: str) -> Any:
    from PIL import Image  # type: ignore[import-not-found]

    if image_b64.startswith("data:"):
        comma = image_b64.find(",")
        if comma >= 0:
            image_b64 = image_b64[comma + 1 :]

    raw = base64.b64decode(image_b64)
    img = Image.open(BytesIO(raw))
    img.load()
    return img.convert("RGB")


def _extract_indexes(output_text: str, n_boxes: int) -> list[int]:
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


def _generate(
    image: Any,
    text: str,
    boxes: list[list[float]],
    max_new_tokens: int,
) -> str:
    import torch  # type: ignore[import-not-found]
    from vlm_fo1.mm_utils import prepare_inputs  # type: ignore[import-not-found]

    from model_vlm_fo1.prompts import OD_TEMPLATE

    tokenizer = _state["tokenizer"]
    model = _state["model"]
    processor = _state["processor"]
    model_path = _state["model_path"]

    bbox_list = [list(b) for b in boxes]

    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": image}},
                {"type": "text", "text": OD_TEMPLATE.format(text)},
            ],
            "bbox_list": bbox_list,
        },
    ]

    try:
        device = next(model.parameters()).device
        device_str = str(device)
    except (AttributeError, StopIteration, TypeError):
        device_str = "cuda"

    generation_kwargs = prepare_inputs(
        model_path,
        model,
        processor,
        tokenizer,
        messages,
        device=device_str,
        max_tokens=max_new_tokens,
        top_p=0.05,
        temperature=0.0,
        do_sample=False,
    )

    with torch.inference_mode():
        output_ids = model.generate(**generation_kwargs)

    try:
        prompt_len = int(generation_kwargs["inputs"].shape[1])
    except (KeyError, AttributeError, IndexError, TypeError, ValueError):
        prompt_len = 0
    try:
        sliced = output_ids[0, prompt_len:] if prompt_len > 0 else output_ids[0]
    except (TypeError, IndexError):
        sliced = output_ids

    decoded = tokenizer.decode(sliced)
    return decoded.strip() if isinstance(decoded, str) else str(decoded)


def _generate_freeform(
    image: Any,
    prompt: str,
    max_new_tokens: int,
) -> str:
    """Generate freeform text for an image — used by the /caption path.

    Mirrors ``_generate`` but bypasses ``OD_TEMPLATE`` because captioning
    asks for a noun phrase, not an OD-style "find regions" instruction.
    Empty bbox_list means the model attends to the whole image.
    """
    import torch  # type: ignore[import-not-found]
    from vlm_fo1.mm_utils import prepare_inputs  # type: ignore[import-not-found]

    tokenizer = _state["tokenizer"]
    model = _state["model"]
    processor = _state["processor"]
    model_path = _state["model_path"]

    # vlm_fo1.mm_utils.prepare_inputs raises on empty bbox_list ("Input
    # lists cannot be empty."), so we pass a single full-image dummy
    # box. The box doesn't contribute to the freeform output beyond
    # giving the helper a non-empty list.
    try:
        W, H = image.size
    except AttributeError:
        W, H = 224, 224
    dummy_box = [[0.0, 0.0, float(W), float(H)]]
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": image}},
                {"type": "text", "text": prompt},
            ],
            "bbox_list": dummy_box,
        },
    ]

    try:
        device = next(model.parameters()).device
        device_str = str(device)
    except (AttributeError, StopIteration, TypeError):
        device_str = "cuda"

    generation_kwargs = prepare_inputs(
        model_path,
        model,
        processor,
        tokenizer,
        messages,
        device=device_str,
        max_tokens=max_new_tokens,
        top_p=0.05,
        temperature=0.0,
        do_sample=False,
    )

    with torch.inference_mode():
        output_ids = model.generate(**generation_kwargs)

    try:
        prompt_len = int(generation_kwargs["inputs"].shape[1])
    except (KeyError, AttributeError, IndexError, TypeError, ValueError):
        prompt_len = 0
    try:
        sliced = output_ids[0, prompt_len:] if prompt_len > 0 else output_ids[0]
    except (TypeError, IndexError):
        sliced = output_ids

    decoded = tokenizer.decode(sliced)
    return decoded.strip() if isinstance(decoded, str) else str(decoded)


def run_caption(
    *,
    image_b64: str,
    prompt: str | None = None,
    max_new_tokens: int = 50,
) -> dict[str, Any]:
    """Caption an image as a short noun phrase.

    v3.28 — supports the SAM Visual Prompt feature. The caller crops the
    user's reference region (with surrounding context) and posts it
    here; we return e.g. ``"red metal chair"`` which SAM 3.1's native
    text-prompt path can then use to find similar instances.

    Why FO1 instead of a dedicated captioning model: FO1 is already
    deployed, and Qwen2.5-VL (its base) has strong native captioning.
    The OD fine-tune doesn't catastrophically forget freeform generation.
    """
    from model_vlm_fo1.prompts import CAPTION_TEMPLATE

    global _last_used_at

    _ensure_loaded()
    image = _decode_image(image_b64)
    text_prompt = prompt or CAPTION_TEMPLATE
    try:
        raw = _generate_freeform(image, text_prompt, max_new_tokens=max_new_tokens)
    finally:
        _empty_cuda_cache()

    # Clean output: strip region tokens, any HTML-ish tags, leading
    # punctuation/quotes, and keep only the first line. Despite the
    # noun-phrase instruction the model can still emit follow-up text;
    # we drop it.
    cleaned = _REGION_TOKEN_RE.sub("", raw)
    cleaned = re.sub(r"<[^>]+>", "", cleaned)
    cleaned = cleaned.strip().strip(".\"'`,;:!? ").strip()
    cleaned = cleaned.splitlines()[0].strip() if cleaned else ""

    _last_used_at = time.monotonic()
    return {
        "text": cleaned,
        "raw_output": raw,
        "model_path": _state["model_path"],
        "quant": _state["quant"],
    }


def run_filter(
    *,
    image_b64: str,
    text: str,
    boxes: list[list[float]],
    max_boxes: int = DEFAULT_MAX_BOXES,
    max_new_tokens: int = DEFAULT_MAX_NEW_TOKENS,
) -> dict[str, Any]:
    n = len(boxes)
    if n == 0:
        return {
            "indexes": [],
            "raw_output": "",
            "model_path": _resolve_model_path(),
            "quant": _resolve_quant(),
        }
    if not text or not text.strip():
        return {
            "indexes": list(range(n)),
            "raw_output": "",
            "model_path": _resolve_model_path(),
            "quant": _resolve_quant(),
        }

    global _last_used_at

    _ensure_loaded()

    capped_boxes = boxes[:max_boxes]
    capped_n = len(capped_boxes)

    image = _decode_image(image_b64)
    try:
        output_text = _generate(image, text, capped_boxes, max_new_tokens)
    finally:
        # Free generation activations even if /generate raised partway.
        _empty_cuda_cache()
    indexes = _extract_indexes(output_text, n_boxes=capped_n)
    _last_used_at = time.monotonic()

    return {
        "indexes": indexes,
        "raw_output": output_text,
        "model_path": _state["model_path"],
        "quant": _state["quant"],
    }
