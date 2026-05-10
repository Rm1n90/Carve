"""CLIP image embedding helper for SAM Visual Prompt cross-image matching.

v3.28 — replaces the failed FO1 caption + SAM-text-prompt path. FO1's
OD fine-tune catastrophically forgot freeform captioning; it returned
the same hallucinated phrase ('yellow road pothole') for every input.
CLIP is the proven tool for cross-image visual similarity — it's the
exact task the model was trained for.

We use OpenAI CLIP ViT-B/32 (already in the model container, ~150 MB)
because:
  - ViT-B/32 is fast (~10 ms per crop on a modern GPU).
  - 512-d embeddings give clean cosine similarity.
  - Pre-trained on 400M (image, text) pairs — robust to natural-image
    variations (lighting, scale, occlusion).

Lazy load: weights download on first call, cached in module state for
the rest of the process.

v3.29 — fixes silent center-crop content loss and adds optional
foreground-mask focus:

* CLIP's stock preprocess is ``Resize(short_side → 224) + CenterCrop(224)``.
  For non-square crops this throws away the long-side ends. A wide banner
  becomes "the middle 1/3 of the banner" which matches different objects
  whose centres happen to look similar. We square-pad with the edge-mean
  colour BEFORE the preprocess so CLIP sees the full crop.
* Optional ``mask`` argument lets the caller fade out background pixels
  (polygon-traced refs, SAM-segmented candidates) so CLIP focuses on the
  actual object instead of the surrounding scene.
"""
from __future__ import annotations

import threading
from typing import Any

_state: dict[str, Any] = {}
_load_lock = threading.Lock()


def _ensure_loaded(device: str | None = None) -> None:
    """Lazy-load a CLIP ViT + its preprocessor on first call.

    Model selection via ``CLIP_MODEL`` env var:
      * ``ViT-L/14@336px`` (default) — 304M params, 24×24 patch grid at
        336px input. Strong fine-grained discrimination — needed for
        cases like logos (Pirelli vs Tissot vs Multoa) where ViT-B/32's
        7×7 patch grid blurs text into the same generic "banner-like"
        embedding. ~50 ms/crop on a modern GPU; 100 candidates batched
        in ~1.5 s.
      * ``ViT-B/32`` — fallback for low-VRAM setups or batch-throughput
        bias. 87M params, 7×7 patches. Faster but conflates similar-
        layout objects.
    """
    if "model" in _state:
        return
    with _load_lock:
        if "model" in _state:
            return
        import os
        import clip  # type: ignore[import-not-found]
        import torch  # type: ignore[import-not-found]

        dev = device or ("cuda" if torch.cuda.is_available() else "cpu")
        name = os.environ.get("CLIP_MODEL", "ViT-L/14@336px").strip()
        if name not in clip.available_models():
            # Fall back to ViT-B/32 if the requested model isn't
            # available (e.g., env typo). Log via root since our app
            # logger may not be attached here yet.
            import logging as _log
            _log.getLogger("carve_model.sam.clip_embed").warning(
                "CLIP_MODEL=%r not available, falling back to ViT-B/32. "
                "Available: %s", name, clip.available_models(),
            )
            name = "ViT-B/32"
        model, preprocess = clip.load(name, device=dev)
        model.eval()
        _state["model"] = model
        _state["preprocess"] = preprocess
        _state["device"] = dev
        _state["name"] = name
        # Embedding dim is model-dependent (512 for ViT-B, 768 for
        # ViT-L). Read it from the loaded weights so callers don't
        # hardcode the wrong shape.
        _state["dim"] = int(model.visual.output_dim)


def _to_numpy_rgb(image: Any) -> "np.ndarray | None":
    """Coerce ``image`` (PIL or numpy) to an HxWx3 uint8 numpy array.

    Returns ``None`` for degenerate inputs (wrong shape / too small).
    """
    import numpy as np
    from PIL import Image

    if isinstance(image, Image.Image):
        arr = np.asarray(image.convert("RGB"))
    else:
        arr = image
    if arr is None:
        return None
    if not hasattr(arr, "ndim"):
        return None
    if arr.ndim != 3 or arr.shape[2] != 3:
        return None
    if arr.shape[0] < 4 or arr.shape[1] < 4:
        return None
    return arr.astype(np.uint8, copy=False)


def _apply_foreground_mask(rgb: "np.ndarray", mask: Any) -> "np.ndarray":
    """Soft-mute background pixels so CLIP focuses on the foreground.

    Background pixels are blended toward neutral gray (128) at 70%
    strength rather than zeroed-out. Pure black/white backgrounds bias
    CLIP (it has strong activations for those colours); a desaturated
    gray is the most neutral baseline. The 30% retained signal keeps
    edge cues so the boundary doesn't look unnaturally crisp to CLIP.
    """
    import numpy as np
    if mask is None:
        return rgb
    mh, mw = mask.shape[:2]
    rh, rw = rgb.shape[:2]
    if (mh, mw) != (rh, rw):
        # Caller bug — silently degrade rather than corrupt the embed.
        return rgb
    bool_mask = np.asarray(mask).astype(bool)
    if bool_mask.sum() < 16:
        # Too few foreground pixels — don't mask, would hide everything.
        return rgb
    out = rgb.copy()
    bg = ~bool_mask
    if not bg.any():
        return rgb
    gray = np.array([128, 128, 128], dtype=np.uint8)
    out[bg] = (0.3 * out[bg].astype(np.float32) + 0.7 * gray).astype(np.uint8)
    return out


def _square_pad_edge(rgb: "np.ndarray") -> "np.ndarray":
    """Pad an HxWx3 uint8 image to square using edge replication.

    Edge replication (vs zero/black/white) keeps the dominant background
    colour around the object, which is closer to what CLIP saw in
    pre-training (natural padding from real photo backgrounds) than any
    constant fill. This is the critical fix for non-square crops —
    without it CLIP's ``Resize(224) + CenterCrop(224)`` slices off the
    long-side ends.
    """
    import numpy as np
    h, w = rgb.shape[:2]
    if h == w:
        return rgb
    side = max(h, w)
    pad_top = (side - h) // 2
    pad_bot = side - h - pad_top
    pad_left = (side - w) // 2
    pad_right = side - w - pad_left
    return np.pad(
        rgb,
        ((pad_top, pad_bot), (pad_left, pad_right), (0, 0)),
        mode="edge",
    )


def _preprocess_for_clip(image: Any, mask: Any = None):
    """Apply foreground mask (optional) → square-pad → CLIP preprocess.

    Returns a (3, 224, 224) torch tensor or ``None`` for degenerate
    input.
    """
    from PIL import Image

    rgb = _to_numpy_rgb(image)
    if rgb is None:
        return None
    if mask is not None:
        rgb = _apply_foreground_mask(rgb, mask)
    rgb = _square_pad_edge(rgb)
    pil = Image.fromarray(rgb)
    return _state["preprocess"](pil)


def embed_image(
    image: Any,
    *,
    mask: Any = None,
    device: str | None = None,
) -> "np.ndarray":
    """Return an L2-normed (D,) float32 CLIP embedding for the image.

    Output dim ``D`` depends on the loaded model (512 for ViT-B,
    768 for ViT-L).

    ``image`` may be a PIL Image or an HxWx3 uint8 numpy array.
    ``mask`` (optional) is an HxW bool/uint8 array in the same coords as
    ``image`` — foreground pixels stay, background pixels fade toward
    gray. Use this to focus CLIP on the actual traced/segmented object
    instead of the surrounding scene.

    Empty/degenerate input returns a zero vector — the caller should
    treat similarity against zero as "no match".
    """
    import numpy as np
    import torch  # type: ignore[import-not-found]

    _ensure_loaded(device=device)
    model = _state["model"]
    dev = _state["device"]
    dim = _state["dim"]

    tensor = _preprocess_for_clip(image, mask=mask)
    if tensor is None:
        return np.zeros(dim, dtype=np.float32)

    batch = tensor.unsqueeze(0).to(dev)
    with torch.no_grad():
        feats = model.encode_image(batch)
    feats = feats / feats.norm(dim=-1, keepdim=True).clamp(min=1e-12)
    return feats.detach().to("cpu", dtype=torch.float32).numpy()[0]


def embed_image_batch(
    images: list[Any],
    *,
    masks: list[Any] | None = None,
    device: str | None = None,
) -> "np.ndarray":
    """Encode N images at once. Returns L2-normed (N, D) float32.

    ``masks`` (optional) is a list of HxW bool/uint8 arrays parallel to
    ``images``. Use ``None`` for individual entries that should not be
    masked.
    """
    import numpy as np
    import torch  # type: ignore[import-not-found]

    _ensure_loaded(device=device)
    model = _state["model"]
    dev = _state["device"]
    dim = _state["dim"]

    n = len(images)
    out = np.zeros((n, dim), dtype=np.float32)
    if n == 0:
        return out

    if masks is not None and len(masks) != n:
        masks = None

    tensors: list = []
    valid_idx: list[int] = []
    for i, img in enumerate(images):
        m = masks[i] if masks is not None else None
        t = _preprocess_for_clip(img, mask=m)
        if t is None:
            continue
        tensors.append(t)
        valid_idx.append(i)

    if not tensors:
        return out

    batch = torch.stack(tensors).to(dev)
    with torch.no_grad():
        feats = model.encode_image(batch)
    feats = feats / feats.norm(dim=-1, keepdim=True).clamp(min=1e-12)
    feats_np = feats.detach().to("cpu", dtype=torch.float32).numpy()
    for k, idx in enumerate(valid_idx):
        out[idx] = feats_np[k]
    return out


def reset_for_test() -> None:
    """Test seam: drop the cached model so a re-load happens."""
    _state.clear()
