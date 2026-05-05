"""VLM-FO1 — vision-language fine-grained perception filter.

Public surface:

  - ``make_vlm_fo1_filter`` — factory returning a ``VlmFo1Filter``
    callable. Used by the model service's lifespan setup to register
    the filter with ``carve_model.sam.predictor`` when the operator
    enables ``VLM_FO1_AVAILABLE=1``.

The filter takes (image, text, boxes) and returns the subset of box
indexes that match the prompt, per the VLM-FO1 paper:
"VLM-FO1: Bridging the Gap Between High-Level Reasoning and Fine-Grained
Perception in VLMs" (Liu et al., 2025, arXiv:2509.25916).

Default model: ``omlab/VLM-FO1_Qwen2.5-VL-3B-v01`` (Qwen2.5-VL-3B base
+ Hybrid Fine-grained Region Encoder head, ~3B params total).
"""

from carve_model.vlm_fo1.adapter import (
    DEFAULT_MAX_BOXES,
    DEFAULT_MODEL_PATH,
    VlmFo1Filter,
    make_vlm_fo1_filter,
)

__all__ = [
    "DEFAULT_MAX_BOXES",
    "DEFAULT_MODEL_PATH",
    "VlmFo1Filter",
    "make_vlm_fo1_filter",
]
