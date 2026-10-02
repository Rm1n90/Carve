# Armin Mehri — mehri.armin@gmail.com
"""Logo AI — logo detection (bounding boxes only) through hosted vision
LLMs (Anthropic / OpenAI), in realtime or through the providers' 24h
batch APIs.

Module map:

    catalog     providers, models, effort levels, prices, vision geometry
    imaging     pre-resize to the model's native patch grid, tiling, crops
    prompt      the cached prompt prefix + the strict JSON schema
    detections  parse → map back to original pixels → merge → persist
    providers   one adapter per vendor SDK (request shape, batch calls)
    service     per-asset orchestration shared by every entry point
    jobs        RQ callables (realtime batch, batch submit, batch poll)
    router      HTTP surface
"""
