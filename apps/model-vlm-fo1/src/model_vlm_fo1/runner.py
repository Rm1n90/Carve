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
from io import BytesIO
from typing import Any

logger = logging.getLogger(__name__)


DEFAULT_MODEL_PATH = "omlab/VLM-FO1_Qwen2.5-VL-3B-v01"
DEFAULT_MAX_BOXES = 64
DEFAULT_MAX_NEW_TOKENS = 4096


_REGION_TOKEN_RE = re.compile(r"<\s*r(?:egion)?\s*_?\s*(\d+)\s*>")
_BARE_REGION_RE = re.compile(r"\bregion[\s_]*(\d+)\b")


_state: dict[str, Any] = {}
_load_lock = threading.Lock()


def is_loaded() -> bool:
    return "model" in _state


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
    if "model" in _state:
        return
    with _load_lock:
        _load_model()


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

    _ensure_loaded()

    capped_boxes = boxes[:max_boxes]
    capped_n = len(capped_boxes)

    image = _decode_image(image_b64)
    output_text = _generate(image, text, capped_boxes, max_new_tokens)
    indexes = _extract_indexes(output_text, n_boxes=capped_n)

    return {
        "indexes": indexes,
        "raw_output": output_text,
        "model_path": _state["model_path"],
        "quant": _state["quant"],
    }
