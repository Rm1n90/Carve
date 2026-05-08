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

# v3.28 — caption template for the SAM Visual Prompt → text bridge. Used
# to convert a user-picked visual reference (a cropped object) into a
# short noun phrase that SAM 3.1's native text-prompt path can then use
# to find similar instances across other images. The "noun phrase only"
# constraint keeps the output suitable as a SAM concept (no preamble,
# no full sentences, no qualifiers).
CAPTION_TEMPLATE = (
    "Describe the object in this image with a SHORT noun phrase that includes "
    "distinguishing visual attributes — color, material, or shape descriptors "
    "(e.g. 'red metal car', 'wooden brown chair', 'small black dog', "
    "'yellow road pothole'). Do not use a generic noun on its own. Reply with "
    "ONLY the noun phrase, no other words, no punctuation, no explanation."
)
