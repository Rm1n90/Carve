"""Inference performance config for SAM models — dtype + attention impl + compile.

Env vars:
  SAM_DTYPE       bf16 | fp16 | fp32   (default: bf16 on cuda, fp32 on cpu)
  SAM_ATTN_IMPL   sdpa | flash_attention_2 | eager   (default: sdpa)
  SAM_COMPILE     true | false   (default: false)

FlashAttention 4 is Hopper/Blackwell only and intentionally NOT supported here —
the user's hardware is Ampere/Ada (RTX 3090 / 4070 Ti). Use sdpa as the default.
"""
import logging
import os

import numpy as np
import torch

logger = logging.getLogger(__name__)


def get_device() -> str:
    return "cuda" if torch.cuda.is_available() else "cpu"


def get_dtype() -> torch.dtype:
    raw = os.environ.get("SAM_DTYPE", "").lower()
    if raw == "" or raw == "auto":
        return torch.bfloat16 if get_device() == "cuda" else torch.float32
    if raw == "bf16" or raw == "bfloat16":
        return torch.bfloat16
    if raw == "fp16" or raw == "float16" or raw == "half":
        return torch.float16
    if raw == "fp32" or raw == "float32":
        return torch.float32
    logger.warning("SAM_DTYPE=%s not recognised; falling back to bf16/fp32", raw)
    return torch.bfloat16 if get_device() == "cuda" else torch.float32


def _flash_attn_available() -> bool:
    try:
        import flash_attn  # noqa: F401
        return True
    except Exception:
        return False


def get_attn_impl() -> str:
    raw = os.environ.get("SAM_ATTN_IMPL", "sdpa").lower()
    if raw == "flash_attention_2":
        if _flash_attn_available():
            return "flash_attention_2"
        logger.warning(
            "SAM_ATTN_IMPL=flash_attention_2 requested but flash_attn package "
            "not installed; falling back to sdpa",
        )
        return "sdpa"
    if raw in ("sdpa", "eager"):
        return raw
    logger.warning("SAM_ATTN_IMPL=%s not recognised; falling back to sdpa", raw)
    return "sdpa"


def get_compile_enabled() -> bool:
    return os.environ.get("SAM_COMPILE", "false").lower() in ("1", "true", "yes")


_GLOBAL_PERF_APPLIED = False


def apply_global_perf() -> None:
    """Enable TF32 + the cuDNN autotuner once, at process startup.

    Safe and high-value on the target Ampere/Ada GPUs (RTX 3090 /
    4070 Ti):

      * TF32 matmul/conv — ~1.3–2x on the SAM ViT backbone for a
        negligible, well-characterised precision change (the model
        already runs bf16 autocast inference; fp32 fallbacks now use
        TF32 tensor cores instead of full fp32).
      * ``cudnn.benchmark`` — SAM resizes every image to a FIXED input
        resolution, so the autotuner picks the fastest conv kernels
        once and reuses them for the whole (long) batch. The usual
        downside (re-autotune on varying shapes) does not apply here.

    Idempotent + best-effort: a failure here must never crash model
    startup (mirrors the rest of the lifespan's defensive style).
    Honors ``SAM_DISABLE_TF32=1`` as an escape hatch.
    """
    global _GLOBAL_PERF_APPLIED
    if _GLOBAL_PERF_APPLIED:
        return
    _GLOBAL_PERF_APPLIED = True
    if os.environ.get("SAM_DISABLE_TF32", "").lower() in ("1", "true", "yes"):
        logger.info("SAM_DISABLE_TF32 set — leaving torch.backends defaults")
        return
    try:
        if not torch.cuda.is_available():
            return
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        torch.backends.cudnn.benchmark = True
        try:
            torch.set_float32_matmul_precision("high")
        except Exception:  # noqa: BLE001 — older torch lacks this API
            pass
        logger.info(
            "global perf: TF32 matmul/cudnn ON, cudnn.benchmark ON "
            "(fixed SAM input size)",
        )
    except Exception as exc:  # noqa: BLE001 — never crash startup
        logger.warning("apply_global_perf failed (%s); using torch defaults", exc)


def apply_compile_to_image_encoder(model) -> None:
    """Wrap the image/vision encoder with torch.compile when SAM_COMPILE=true.

    NOTE on the SAM 3.1 path: native ``build_sam3_image_model`` already
    consumes the SAM_COMPILE flag (``compile=True`` →
    ``compile_mode="default"`` is threaded into the package's own
    ``_create_vision_backbone`` + ``_create_segmentation_head``). This
    helper is therefore NOT on the SAM 3.1 hot path — calling it on a
    SAM 3.1 model would *double-compile* and is intentionally not done.
    It's the fallback for SAM 2 / legacy variants whose model objects
    expose the encoder as a plain attribute. ``backbone`` is included
    in the candidate list because that's the SAM 3-family attribute
    name, in case a future caller routes through here.

    Compiles only the encoder (not the full model) — the mask-decoder
    loop has dynamic shapes that don't compile cleanly under
    reduce-overhead mode.
    """
    if not get_compile_enabled():
        return
    # ``backbone`` covers SAM 3-family models; ``vision_encoder`` /
    # ``image_encoder`` cover SAM 2 + most HF vision wrappers.
    candidates = ("vision_encoder", "image_encoder", "backbone")
    for name in candidates:
        encoder = getattr(model, name, None)
        if encoder is not None:
            try:
                compiled = torch.compile(encoder, mode="reduce-overhead", fullgraph=False)
                setattr(model, name, compiled)
                logger.info(
                    "torch.compile applied to %s.%s",
                    model.__class__.__name__,
                    name,
                )
                return
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "torch.compile failed on %s.%s: %s; continuing uncompiled",
                    model.__class__.__name__,
                    name,
                    exc,
                )
                return
    logger.debug(
        "No vision/image/backbone encoder attribute found on %s; skipping compile",
        model.__class__.__name__,
    )


def to_numpy_safe(arr) -> np.ndarray:
    """Convert a torch tensor (or array-like) to a numpy float32 array.

    bf16 / fp16 tensors raise on .numpy(); cast to fp32 first.
    """
    if hasattr(arr, "cpu"):
        cpu_arr = arr.cpu()
        dtype = getattr(cpu_arr, "dtype", None)
        dname = str(dtype) if dtype is not None else ""
        if "bfloat16" in dname or "float16" in dname:
            cpu_arr = cpu_arr.float()
        return cpu_arr.numpy()
    return np.asarray(arr)
