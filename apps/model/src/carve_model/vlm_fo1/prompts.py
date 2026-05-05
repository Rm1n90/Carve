"""VLM-FO1 prompt templates.

These are the templates the FO1 model was fine-tuned to recognize. The
exact wording matters — drift here regresses accuracy. Sourced from the
upstream training-time templates at
``om-ai-lab/VLM-FO1/vlm_fo1/task_templates.py``.

Only the OD template is wired into the precision filter. The other
templates (counting, REC, region OCR, captioning) are intentionally not
imported until a concrete use case lands — fewer surprises, fewer
prompt-template footguns.
"""

# Object Detection template — the prompt we send when the caller wants
# to filter SAM 3 box proposals down to the ones matching a free-form
# text query. ``{}`` is replaced with the user's query verbatim.
OD_TEMPLATE = (
    "Please detect {} in this image. Answer the question with object indexes."
)
