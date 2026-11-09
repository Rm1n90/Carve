# Armin Mehri — mehri.armin@gmail.com
"""Image filters for Collect from web: is it AI-made, is it watermarked,
does it show what its keyword names.

    POST /quality/score   {"images": [base64 …],
                           "checks": ["ai", "watermark", "relevance", "photo"],
                           "texts": [keyword …]}   (one keyword per image, for "relevance")
                          → {"scores": [{"ai": p, "watermark": p, "relevance": cos,
                                         "photo": p}, …]}
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
* **Off topic** — SigLIP2 (``google/siglip2-so400m-patch14-384``) cosine
  between the image and "this is a photo of <keyword>." in lower case
  (mixed case scores far worse: AUC 0.75 against 0.95). Measured
  2026-11-08 on 481 hand-labelled Bing, Commons and Openverse results
  for 29 brand and F1 keywords: at 0.07, 99 % of on-topic images pass
  and 71 % of off-topic ones are caught (all of Bing's). CLIP
  ViT-L/14 caught 57 % at the same pass rate. What still passes is
  mostly another organisation's logo that spells the keyword.
* **Real photo** — the same SigLIP2 features against fixed labels:
  softmax(scale × cosine) over three "a photo …" labels and fifteen
  "a drawing." / "a size chart." / "a sign with text." … labels, summed
  over the photo ones. Measured 2026-11-09 on 655 collected images the
  user kept or deleted: below 0.2 caught 22 of 148 deleted (size charts,
  sketches, cartoons, signs, icons, spec sheets) and 10 of 453 kept in
  float16 (7 in float32), some of them renders and infographics, some
  shirts on a plain background; it also takes 15 of 34 flat logos, so
  the collector skips it for logo keywords. Labels
  such as "a product mockup." or "a poster with text." took people in
  printed shirts (53 kept lost) and were left out.

The first two are small; they load on first use and share the GPU slot
with the other models through ``admit``. SigLIP2 holds ~2.2 GB, so it is
dropped after ``RELEVANCE_IDLE_S`` without use (``evict_idle``).
"""

from __future__ import annotations

import base64
import io
import json
import logging
import threading
import time
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
RELEVANCE_MODEL = "google/siglip2-so400m-patch14-384"
RELEVANCE_IDLE_S = 600.0
_TEXT_CACHE_MAX = 512
PHOTO_LABELS = ("a photo.", "a photo of people.", "a photo of an object.")
NOT_PHOTO_LABELS = (
    "a drawing.",
    "a cartoon.",
    "a clipart illustration.",
    "a vector illustration.",
    "a sketch.",
    "a diagram.",
    "a size chart.",
    "a chart with text.",
    "a screenshot of a website.",
    "a sign with text.",
    "an infographic.",
    "an icon.",
    "a 3D render.",
    "a digital illustration.",
    "a cartoon illustration.",
)

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


def _siglip() -> dict[str, Any]:
    with _lock:
        if "rel" not in _state:
            import torch
            from transformers import AutoImageProcessor, AutoModel, GemmaTokenizerFast

            # AutoProcessor cannot build this checkpoint's tokenizer on
            # transformers 5.0; the parts load fine one by one.
            dev = _device()
            _state["rel"] = {
                "proc": AutoImageProcessor.from_pretrained(RELEVANCE_MODEL, use_fast=False),
                "tok": GemmaTokenizerFast.from_pretrained(RELEVANCE_MODEL),
                "model": AutoModel.from_pretrained(
                    RELEVANCE_MODEL, dtype=torch.float16 if dev == "cuda" else torch.float32
                ).to(dev).eval(),
                "texts": {},
            }
        _state["rel"]["used"] = time.monotonic()
        return _state["rel"]


def _features(out: Any) -> Any:
    """transformers 5 returns an output object, 4.x the tensor."""
    import torch

    f = out if torch.is_tensor(out) else out.pooler_output
    f = f.float()
    return f / f.norm(dim=-1, keepdim=True)


def _prompt(keyword: str) -> str:
    return "this is a photo of " + " ".join(keyword.split()).lower() + "."


def _text_features(rel: dict[str, Any], prompts: list[str]) -> Any:
    model = rel["model"]
    dev = next(model.parameters()).device
    x = rel["tok"](prompts, padding="max_length", max_length=64, truncation=True,
                   return_tensors="pt").to(dev)
    return _features(model.get_text_features(input_ids=x["input_ids"]))


def _image_features(rel: dict[str, Any], ims: list) -> Any:
    import torch

    model = rel["model"]
    dev = next(model.parameters()).device
    out = []
    # 16 at a time: SigLIP2 at 384 px has 729 tokens per image.
    for i in range(0, len(ims), 16):
        x = rel["proc"](images=ims[i : i + 16], return_tensors="pt")["pixel_values"]
        out.append(_features(model.get_image_features(pixel_values=x.to(dev, dtype=model.dtype))))
    return torch.cat(out)


def _relevance(rel: dict[str, Any], feats: Any, texts: list[str]) -> list[float]:
    import torch

    cache: dict[str, Any] = rel["texts"]
    new = [t for t in dict.fromkeys(texts) if t not in cache]
    if new:
        for t, f in zip(new, _text_features(rel, [_prompt(t) for t in new]), strict=True):
            if len(cache) >= _TEXT_CACHE_MAX:
                cache.pop(next(iter(cache)))
            cache[t] = f
    t = torch.stack([cache[k] for k in texts])
    return (feats * t).sum(-1).cpu().tolist()


def _photo(rel: dict[str, Any], feats: Any) -> list[float]:
    """Chance that each image is a real photo (see the top of this file)."""
    if "labels" not in rel:
        rel["labels"] = _text_features(rel, [*PHOTO_LABELS, *NOT_PHOTO_LABELS])
    scale = rel["model"].logit_scale.exp().float()
    p = (scale * feats @ rel["labels"].T).softmax(-1)
    return p[:, : len(PHOTO_LABELS)].sum(-1).cpu().tolist()


def evict_idle() -> bool:
    """Drop SigLIP2 after ``RELEVANCE_IDLE_S`` unused. Called by the
    sweeper in ``main.py``."""
    with _lock:
        rel = _state.get("rel")
        if rel is None or time.monotonic() - rel["used"] < RELEVANCE_IDLE_S:
            return False
        del _state["rel"]
    log.info("quality.relevance_evicted")
    return True


class ScoreIn(BaseModel):
    images: list[str] = Field(..., min_length=1, max_length=MAX_IMAGES)
    checks: list[str] = Field(default_factory=lambda: ["ai", "watermark"])
    # One keyword per image; needed for "relevance".
    texts: list[str] | None = Field(default=None, max_length=MAX_IMAGES)


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

    if "relevance" in payload.checks and (
        payload.texts is None or len(payload.texts) != len(payload.images)
    ):
        raise HTTPException(400, {"error": "texts_required",
                                  "detail": "relevance needs one keyword per image in texts"})
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
        if "relevance" in payload.checks or "photo" in payload.checks:
            rel = _siglip()
            feats = _image_features(rel, ims)
            if "relevance" in payload.checks:
                for s, v in zip(scores, _relevance(rel, feats, payload.texts or []), strict=True):
                    s["relevance"] = round(float(v), 4)
            if "photo" in payload.checks:
                for s, v in zip(scores, _photo(rel, feats), strict=True):
                    s["photo"] = round(float(v), 4)
    return {"scores": scores}


@router.get("/status")
def status() -> dict:
    return {"ai_loaded": "ai" in _state, "watermark_loaded": "wm" in _state,
            "relevance_loaded": "rel" in _state, "ai_model": AI_MODEL,
            "watermark_clip": CLIP_NAME, "relevance_model": RELEVANCE_MODEL}
