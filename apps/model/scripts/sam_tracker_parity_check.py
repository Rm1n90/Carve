"""Stage-0 golden parity check for client-side SAM decode (SAM 3 tracker).

Validates that the CVAT-style split — encoder on the server, decoder in the
browser — reproduces the masks we serve today. It runs the transformers-
exported ONNX pipeline (`onnx-community/sam3-tracker-ONNX`: vision_encoder +
prompt_encoder_mask_decoder) and compares the resulting mask to the LIVE
native server `/sam/decode` (sam3.pt) on the same image + click.

Result on 2026-06-08 (single positive click on the SAM truck image):
    PARITY IoU(onnx, server) = 0.9912  (target >= 0.98)  -> PASS

Context: the interactive image/click path runs SAM 3 (`sam3.pt`), NOT
SAM 3.1 — there is no SAM 3.1 image model (see
docs/superpowers/specs/2026-06-08-client-side-sam-decode-design.md). So the
SAM 3 tracker decoder is the correct one and matches the served masks.

Run (host, model venv; downloads ~960 MB of ONNX on first run; needs the
model service up on :8100):
    apps/model/.venv/bin/pip install -q onnxruntime onnx huggingface_hub pillow numpy
    apps/model/.venv/bin/python apps/model/scripts/sam_tracker_parity_check.py

TODO (remaining Stage-0 parity cases): multi-click refinement (this decoder
has NO mask_input — it re-runs the full point set) and box prompts.
"""
from __future__ import annotations

import base64
import json
import urllib.request

import numpy as np
import onnxruntime as ort
from huggingface_hub import hf_hub_download
from PIL import Image

REPO = "onnx-community/sam3-tracker-ONNX"
SERVER = "http://localhost:8100"
INPUT = 1008  # SAM 3 tracker fixed encoder input
# Preprocessing per the repo's preprocessor_config.json — mean=std=0.5 (NOT ImageNet).
NORM_MEAN = 0.5
NORM_STD = 0.5


def _load_sessions() -> tuple[ort.InferenceSession, ort.InferenceSession]:
    enc_p = hf_hub_download(REPO, "onnx/vision_encoder_fp16.onnx")
    hf_hub_download(REPO, "onnx/vision_encoder_fp16.onnx_data")
    dec_p = hf_hub_download(REPO, "onnx/prompt_encoder_mask_decoder.onnx")
    hf_hub_download(REPO, "onnx/prompt_encoder_mask_decoder.onnx_data")
    prov = ["CPUExecutionProvider"]
    return (
        ort.InferenceSession(enc_p, providers=prov),
        ort.InferenceSession(dec_p, providers=prov),
    )


def _preprocess(pil: Image.Image) -> np.ndarray:
    """PIL RGB -> pixel_values [1,3,1008,1008] float32 (I/O is fp32 even for
    fp16 weights)."""
    rs = pil.resize((INPUT, INPUT), Image.BILINEAR)
    arr = np.asarray(rs, dtype=np.float32) / 255.0
    arr = (arr - NORM_MEAN) / NORM_STD
    return np.transpose(arr, (2, 0, 1))[None].astype(np.float32)


def onnx_mask(enc, dec, pil: Image.Image, click_xy: tuple[int, int]) -> np.ndarray:
    """Run encoder+decoder for one positive click; return a binary mask at
    original (H, W)."""
    W, H = pil.size
    emb = enc.run(None, {"pixel_values": _preprocess(pil)})
    emb_by = {o.name: e for o, e in zip(enc.get_outputs(), emb)}
    cx, cy = click_xy
    feed = {
        "input_points": np.array(
            [[[[cx * INPUT / W, cy * INPUT / H]]]], dtype=np.float32
        ),  # [1,1,1,2]
        "input_labels": np.array([[[1]]], dtype=np.int64),  # [1,1,1]
        "input_boxes": np.zeros((1, 0, 4), dtype=np.float32),
    }
    for i in dec.get_inputs():
        if i.name.startswith("image_embeddings"):
            feed[i.name] = emb_by[i.name].astype(np.float32)
    out = dec.run(None, feed)
    out_by = {o.name: v for o, v in zip(dec.get_outputs(), out)}
    iou_scores = np.asarray(out_by["iou_scores"]).reshape(-1)
    pm0 = np.asarray(out_by["pred_masks"])[0, 0]  # [num_masks, h, w] logits
    best = int(np.argmax(iou_scores[: pm0.shape[0]])) if pm0.shape[0] > 1 else 0
    low = (pm0[best] > 0).astype(np.uint8) * 255
    up = np.asarray(Image.fromarray(low).resize((W, H), Image.NEAREST)) > 127
    return up.astype(np.uint8)


def server_mask(pil_path: str, click_xy: tuple[int, int]) -> np.ndarray:
    """Decode the same image+click via the live native server; return binary
    mask at original (H, W). Reverses the column-major RLE in
    carve_model.sam.codec.encode_mask_rle."""
    with open(pil_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()

    def post(path: str, body: dict) -> dict:
        req = urllib.request.Request(
            SERVER + path,
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.load(r)

    enc_r = post("/sam/encode", {"image_b64": b64})
    cx, cy = click_xy
    dec_r = post(
        "/sam/decode",
        {"image_hash": enc_r["image_hash"], "points": [[cx, cy]], "labels": [1]},
    )
    h, w = dec_r["size"]
    runs = [int(x) for x in dec_r["counts"].split(",")]
    flat = np.zeros(sum(runs), np.uint8)
    idx = 0
    val = 0
    for r in runs:
        flat[idx : idx + r] = val
        idx += r
        val ^= 1
    return flat.reshape((w, h)).T  # encode did (h,w).T.flatten()


def iou(a: np.ndarray, b: np.ndarray) -> float:
    a = a.astype(bool)
    b = b.astype(bool)
    union = (a | b).sum()
    return float((a & b).sum() / union) if union else 0.0


def main(img_path: str = "/tmp/sam_truck.jpg", click=(700, 600)) -> None:
    pil = Image.open(img_path).convert("RGB")
    enc, dec = _load_sessions()
    om = onnx_mask(enc, dec, pil, click)
    sm = server_mask(img_path, click)
    val = iou(om, sm)
    print(
        f"onnx area={int(om.sum())} server area={int(sm.sum())} "
        f"IoU={val:.4f}  ({'PASS' if val >= 0.98 else 'FAIL'}; target >= 0.98)"
    )


if __name__ == "__main__":
    main()
