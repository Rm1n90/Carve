"""YOLOE — Real-Time Seeing Anything (v3.23).

Two checkpoints, three modes:

* ``yoloe-26l-seg.pt`` — text + visual prompts (open-vocabulary).
* ``yoloe-26l-seg-pf.pt`` — prompt-free (1200+ class internal vocab).

The package mirrors ``carve_model.yolo``: a small registry that holds
the loaded Ultralytics objects in memory, a ``predict`` module that
shapes the Ultralytics output to the same ``{detections, polygons}``
contract as YOLO, and a FastAPI ``router`` that exposes the three
predict endpoints + a ``/yoloe/status`` capability probe.
"""
