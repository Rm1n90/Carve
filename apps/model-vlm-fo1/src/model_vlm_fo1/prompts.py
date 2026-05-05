"""VLM-FO1 prompt template.

Forked verbatim from ``apps/model/src/carve_model/vlm_fo1/prompts.py``
when FO1 was extracted into this sidecar. Wording matches the
upstream training-time template at
``om-ai-lab/VLM-FO1/vlm_fo1/task_templates.py``. Drift here regresses
accuracy.
"""

OD_TEMPLATE = (
    "Please detect {} in this image. Answer the question with object indexes."
)
