"""Stage-0 golden parity check for client-side SAM decode (SAM 3 tracker).

Validates that the CVAT-style split — encoder on the server, decoder in the
browser — reproduces the masks we serve today. Runs the transformers-exported
ONNX pipeline (`onnx-community/sam3-tracker-ONNX`: vision_encoder +
prompt_encoder_mask_decoder) and compares to the LIVE native server
`/sam/decode` (sam3.pt) on the same image + prompts.

Results (2026-06-08, SAM truck image):
    single positive            IoU 0.9912  PASS
    two positive (refine)      IoU 0.9876  PASS
    positive+negative (refine) IoU 0.9863  PASS   (track-prev selection)
    box only                   IoU 0.54    DIVERGES -> server fallback

CRITICAL DESIGN RULE (mask selection — the decoder has NO mask_input, so we
replicate its tracking statelessly): the decoder always returns 3 candidate
masks. First click -> pick best by `iou_scores`. Refinement clicks (a
previous mask exists) -> pick the candidate with the highest IoU to the
PREVIOUS mask (not best-by-score). The client always has the previous mask,
so this is free, and it reproduces the server's mask_input refinement.

Box prompts diverge from the server's box decode (no previous mask to track)
-> the production wiring uses the server `/sam/decode` fallback for boxes.

Context: image clicks run SAM 3 (`sam3.pt`), NOT SAM 3.1 — there is no
SAM 3.1 image model. See
docs/superpowers/specs/2026-06-08-client-side-sam-decode-design.md.

Run (host model venv; ~960 MB download first run; model service up on :8100):
    apps/model/.venv/bin/pip install -q onnxruntime onnx huggingface_hub pillow numpy
    apps/model/.venv/bin/python apps/model/scripts/sam_tracker_parity_check.py
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
INPUT = 1008
NORM_MEAN = 0.5  # preprocessor_config.json — NOT ImageNet
NORM_STD = 0.5
TARGET = 0.98


def _sessions() -> tuple[ort.InferenceSession, ort.InferenceSession]:
    enc = hf_hub_download(REPO, "onnx/vision_encoder_fp16.onnx")
    hf_hub_download(REPO, "onnx/vision_encoder_fp16.onnx_data")
    dec = hf_hub_download(REPO, "onnx/prompt_encoder_mask_decoder.onnx")
    hf_hub_download(REPO, "onnx/prompt_encoder_mask_decoder.onnx_data")
    p = ["CPUExecutionProvider"]
    return ort.InferenceSession(enc, providers=p), ort.InferenceSession(dec, providers=p)


def _embeddings(enc, pil: Image.Image) -> dict[str, np.ndarray]:
    rs = pil.resize((INPUT, INPUT), Image.BILINEAR)
    arr = (np.asarray(rs, np.float32) / 255.0 - NORM_MEAN) / NORM_STD
    pix = np.transpose(arr, (2, 0, 1))[None].astype(np.float32)
    return {o.name: e for o, e in zip(enc.get_outputs(), enc.run(None, {"pixel_values": pix}))}


def _candidates(dec, emb, W, H, points, labels, box=None):
    """Return (iou_scores, [binary masks at orig HxW]) for the 3 decoder masks."""
    sx, sy = INPUT / W, INPUT / H
    if points:
        ip = np.array([[[[x * sx, y * sy] for x, y in points]]], np.float32)
        il = np.array([[labels]], np.int64)
    else:
        ip = np.zeros((1, 1, 0, 2), np.float32)
        il = np.zeros((1, 1, 0), np.int64)
    ib = (
        np.array([[[box[0] * sx, box[1] * sy, box[2] * sx, box[3] * sy]]], np.float32)
        if box
        else np.zeros((1, 0, 4), np.float32)
    )
    feed = {"input_points": ip, "input_labels": il, "input_boxes": ib}
    for i in dec.get_inputs():
        if i.name.startswith("image_embeddings"):
            feed[i.name] = emb[i.name].astype(np.float32)
    o = {n.name: v for n, v in zip(dec.get_outputs(), dec.run(None, feed))}
    iou = np.asarray(o["iou_scores"]).reshape(-1)
    pm = np.asarray(o["pred_masks"])[0, 0]
    masks = [
        (np.asarray(Image.fromarray((pm[k] > 0).astype(np.uint8) * 255).resize((W, H), Image.NEAREST)) > 127).astype(np.uint8)
        for k in range(pm.shape[0])
    ]
    return iou, masks


def _iou(a: np.ndarray, b: np.ndarray) -> float:
    a = a.astype(bool)
    b = b.astype(bool)
    u = (a | b).sum()
    return float((a & b).sum() / u) if u else 0.0


def onnx_click_sequence(dec, emb, W, H, clicks):
    """Simulate the client: decode after each click, tracking the previous
    mask. clicks = [(x, y, label), ...]. Returns the final binary mask."""
    prev = None
    pts, lbls = [], []
    for x, y, lab in clicks:
        pts.append((x, y))
        lbls.append(lab)
        iou, masks = _candidates(dec, emb, W, H, pts, lbls)
        if prev is None:
            prev = masks[int(np.argmax(iou[: len(masks)]))]  # first click: best score
        else:
            prev = masks[int(np.argmax([_iou(prev, m) for m in masks]))]  # refine: track prev
    return prev


def _server(hash_, body_extra) -> dict:
    body = {"image_hash": hash_, **body_extra}
    req = urllib.request.Request(
        SERVER + "/sam/decode", data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def _rle_to_mask(d: dict) -> np.ndarray:
    h, w = d["size"]
    runs = [int(x) for x in d["counts"].split(",")]
    flat = np.zeros(sum(runs), np.uint8)
    idx, val = 0, 0
    for r in runs:
        flat[idx : idx + r] = val
        idx += r
        val ^= 1
    return flat.reshape((w, h)).T


def server_click_sequence(hash_, clicks):
    """Incremental server decode (uses mask_input refinement between calls)."""
    pts, lbls = [], []
    out = None
    for x, y, lab in clicks:
        pts.append([x, y])
        lbls.append(lab)
        out = _server(hash_, {"points": pts, "labels": lbls})
    return _rle_to_mask(out)


def main(img_path: str = "/tmp/sam_truck.jpg") -> None:
    pil = Image.open(img_path).convert("RGB")
    W, H = pil.size
    enc, dec = _sessions()
    emb = _embeddings(enc, pil)
    with open(img_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    req = urllib.request.Request(
        SERVER + "/sam/encode", data=json.dumps({"image_b64": b64}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        hash_ = json.load(r)["image_hash"]

    P1, P2, NEG, BOX = (700, 600), (1150, 650), (900, 300), (300, 400, 1520, 1050)
    cases = {
        "single positive":          [(P1[0], P1[1], 1)],
        "two positive (refine)":    [(P1[0], P1[1], 1), (P2[0], P2[1], 1)],
        "positive+negative (refine)": [(P1[0], P1[1], 1), (NEG[0], NEG[1], 0)],
    }
    for name, clicks in cases.items():
        om = onnx_click_sequence(dec, emb, W, H, clicks)
        sm = server_click_sequence(hash_, clicks)
        v = _iou(om, sm)
        print(f"  {name:28s} IoU={v:.4f}  {'PASS' if v >= TARGET else 'CHECK'}")

    # Box: known to diverge -> production uses server fallback. Reported for the record.
    _, bmasks = _candidates(dec, emb, W, H, [], [], box=BOX)
    bi, _ = _candidates(dec, emb, W, H, [], [], box=BOX)
    om_box = bmasks[int(np.argmax(bi[: len(bmasks)]))]
    sm_box = _rle_to_mask(_server(hash_, {"box": list(BOX)}))
    print(f"  {'box only (server fallback)':28s} IoU={_iou(om_box, sm_box):.4f}  (expected divergence)")


if __name__ == "__main__":
    main()
