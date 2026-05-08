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
"""
from __future__ import annotations

import threading
from typing import Any

_state: dict[str, Any] = {}
_load_lock = threading.Lock()


def _ensure_loaded(device: str | None = None) -> None:
    """Lazy-load CLIP ViT-B/32 + its preprocessor on first call."""
    if "model" in _state:
        return
    with _load_lock:
        if "model" in _state:
            return
        import clip  # type: ignore[import-not-found]
        import torch  # type: ignore[import-not-found]

        dev = device or ("cuda" if torch.cuda.is_available() else "cpu")
        model, preprocess = clip.load("ViT-B/32", device=dev)
        model.eval()
        _state["model"] = model
        _state["preprocess"] = preprocess
        _state["device"] = dev


def embed_image(image: Any, *, device: str | None = None) -> "np.ndarray":
    """Return an L2-normed (512,) float32 CLIP embedding for the image.

    ``image`` may be a PIL Image or a HxWx3 uint8 numpy array. Empty/
    degenerate input returns a zero vector — the caller should treat
    similarity against zero as "no match".
    """
    import numpy as np
    import torch  # type: ignore[import-not-found]
    from PIL import Image

    _ensure_loaded(device=device)
    model = _state["model"]
    preprocess = _state["preprocess"]
    dev = _state["device"]

    if isinstance(image, np.ndarray):
        if image.ndim != 3 or image.shape[2] != 3:
            return np.zeros(512, dtype=np.float32)
        if image.shape[0] < 4 or image.shape[1] < 4:
            return np.zeros(512, dtype=np.float32)
        pil = Image.fromarray(image.astype(np.uint8))
    else:
        pil = image
    if pil.size[0] < 4 or pil.size[1] < 4:
        return np.zeros(512, dtype=np.float32)

    tensor = preprocess(pil).unsqueeze(0).to(dev)
    with torch.no_grad():
        feats = model.encode_image(tensor)
    feats = feats / feats.norm(dim=-1, keepdim=True).clamp(min=1e-12)
    return feats.detach().to("cpu", dtype=torch.float32).numpy()[0]


def embed_image_batch(
    images: list[Any], *, device: str | None = None,
) -> "np.ndarray":
    """Encode N images at once. Returns L2-normed (N, 512) float32."""
    import numpy as np
    import torch  # type: ignore[import-not-found]
    from PIL import Image

    _ensure_loaded(device=device)
    model = _state["model"]
    preprocess = _state["preprocess"]
    dev = _state["device"]

    if not images:
        return np.zeros((0, 512), dtype=np.float32)

    pils: list[Image.Image] = []
    valid_idx: list[int] = []
    for i, img in enumerate(images):
        if isinstance(img, np.ndarray):
            if img.ndim != 3 or img.shape[2] != 3:
                continue
            if img.shape[0] < 4 or img.shape[1] < 4:
                continue
            pils.append(Image.fromarray(img.astype(np.uint8)))
            valid_idx.append(i)
        else:
            if img.size[0] < 4 or img.size[1] < 4:
                continue
            pils.append(img)
            valid_idx.append(i)

    out = np.zeros((len(images), 512), dtype=np.float32)
    if not pils:
        return out

    batch = torch.stack([preprocess(p) for p in pils]).to(dev)
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
