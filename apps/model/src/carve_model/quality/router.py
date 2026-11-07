# Armin Mehri — mehri.armin@gmail.com
"""Image filters for Collect from web: is it AI-made, is it watermarked.

    POST /quality/score   {"images": [base64 …], "checks": ["ai", "watermark"]}
                          → {"scores": [{"ai": p, "watermark": p}, …]}
    GET  /quality/status

* **AI-made** — ``haywoodsloan/ai-image-detector-deploy`` (SwinV2,
  labels artificial / real). Chosen in an earlier dataset build where it
  held up on real photos while a SigLIP-based detector flagged half of
  them. Measured 2026-11-07 on 326 images: 0 of 36 real photos flagged;
  renders and AI art at ~1.0; about 5 % of flat logo graphics above 0.9.
* **Watermarked** — a linear probe on CLIP ViT-L/14@336px image
  features (``watermark_probe.json``), trained 2026-11-07 on 700 stock
  agency previews against 1,619 ordinary search results. Cross-validated
  at 0.5: 91 % of previews caught, 1.7 % of ordinary images flagged; on
  held-out images 57/60 previews and 0/36 real photos. The LAION
  watermark classifier was tried first and rejected: it flags text, so
  15 of 36 clean photos and most logos.

Both are small; they load on first use and share the GPU slot with the
other models through ``admit``.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import threading
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from carve_model.admission import CostClass, admit

log = logging.getLogger(__name__)

router = APIRouter(prefix="/quality", tags=["quality"])

AI_MODEL = "haywoodsloan/ai-image-detector-deploy"
CLIP_NAME = "ViT-L/14@336px"
_PROBE_PATH = Path(__file__).with_name("watermark_probe.json")
MAX_IMAGES = 64

_state: dict[str, Any] = {}
_lock = threading.Lock()


def _device() -> str:
    import torch

    return "cuda" if torch.cuda.is_available() else "cpu"


def _ai() -> tuple[Any, Any, int]:
    if "ai" not in _state:
        with _lock:
            if "ai" not in _state:
                from transformers import AutoImageProcessor, AutoModelForImageClassification

                proc = AutoImageProcessor.from_pretrained(AI_MODEL)
                model = AutoModelForImageClassification.from_pretrained(AI_MODEL).to(_device()).eval()
                labels = {v.lower(): int(k) for k, v in model.config.id2label.items()}
                idx = next((labels[n] for n in ("artificial", "fake", "ai") if n in labels), 0)
                _state["ai"] = (proc, model, idx)
    return _state["ai"]


def _clip() -> tuple[Any, Any, Any, Any]:
    """CLIP ViT-L/14@336px and the probe. Reuses the copy the visual
    prompt already loaded when it is that model, so it is held once."""
    if "wm" not in _state:
        with _lock:
            if "wm" not in _state:
                import torch

                from carve_model.sam import clip_embed

                model = preprocess = None
                try:
                    clip_embed._ensure_loaded()
                    if clip_embed._state.get("name") == CLIP_NAME:
                        model = clip_embed._state["model"]
                        preprocess = clip_embed._state["preprocess"]
                except Exception:  # noqa: BLE001
                    log.warning("quality.clip_shared_unavailable", exc_info=True)
                if model is None:
                    import clip  # type: ignore[import-not-found]

                    model, preprocess = clip.load(CLIP_NAME, device=_device())
                    model.eval()
                probe = json.loads(_PROBE_PATH.read_text())
                dev = next(model.parameters()).device
                w = torch.tensor(probe["w"], dtype=torch.float32, device=dev)
                b = torch.tensor(probe["b"], dtype=torch.float32, device=dev)
                _state["wm"] = (model, preprocess, w, b)
    return _state["wm"]


class ScoreIn(BaseModel):
    images: list[str] = Field(..., min_length=1, max_length=MAX_IMAGES)
    checks: list[str] = Field(default_factory=lambda: ["ai", "watermark"])


def _decode(images: list[str]):  # noqa: ANN202
    from PIL import Image

    out = []
    for i, b64 in enumerate(images):
        try:
            out.append(Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB"))
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(400, {"error": "bad_image", "index": i, "detail": str(exc)}) from exc
    return out


@router.post("/score")
def score(payload: ScoreIn) -> dict:
    import torch

    ims = _decode(payload.images)
    scores: list[dict[str, float]] = [{} for _ in ims]
    with admit(CostClass.QUALITY), torch.no_grad():
        if "ai" in payload.checks:
            proc, model, idx = _ai()
            x = proc(images=ims, return_tensors="pt").to(next(model.parameters()).device)
            p = model(**x).logits.float().softmax(-1)[:, idx].cpu().tolist()
            for s, v in zip(scores, p, strict=True):
                s["ai"] = round(float(v), 4)
        if "watermark" in payload.checks:
            model, preprocess, w, b = _clip()
            x = torch.stack([preprocess(im) for im in ims]).to(w.device)
            f = model.encode_image(x).float()
            f = f / f.norm(dim=-1, keepdim=True)
            p = torch.sigmoid(f @ w + b).cpu().tolist()
            for s, v in zip(scores, p, strict=True):
                s["watermark"] = round(float(v), 4)
    return {"scores": scores}


@router.get("/status")
def status() -> dict:
    return {"ai_loaded": "ai" in _state, "watermark_loaded": "wm" in _state, "ai_model": AI_MODEL,
            "watermark_clip": CLIP_NAME}
