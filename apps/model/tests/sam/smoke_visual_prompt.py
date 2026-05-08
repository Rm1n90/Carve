"""Smoke test for SAM 3.1 visual prompt — native sam3 wiring (Task A6).

Run inside the model container:

    docker compose exec -T model python /app/apps/model/tests/sam/smoke_visual_prompt.py

Expected output:
  - embed shape: (256,) with norm ~= 1.0
  - masks shape: (N, 480, 640) for some N >= 0
  - scores shape: (N,), boxes shape: (N, 4)
  - no exceptions
"""
import numpy as np

from carve_model.sam.sam3p1_adapter import build_sam3p1_image_predictor


def main() -> None:
    adapter = build_sam3p1_image_predictor()
    img = np.random.default_rng(0).integers(0, 255, (480, 640, 3)).astype(np.uint8)
    adapter.set_image(img)
    emb = adapter.set_visual_prompt(
        img, {"kind": "bbox", "xyxy": [100, 100, 300, 300]},
    )
    print("embed shape:", emb.shape, "norm:", float(np.linalg.norm(emb)))
    masks, scores, boxes = adapter.predict_with_visual_prompt(emb)
    print("masks:", masks.shape, "scores:", scores.shape, "boxes:", boxes.shape)


if __name__ == "__main__":
    main()
