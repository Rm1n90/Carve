"""Verify our YOLO loader contract is stable across Ultralytics versions.

Ultralytics' YOLO() class is documented as a unified loader: it auto-
detects the architecture from the .pt file's metadata. We don't want to
encode any assumption about specific YOLO versions in our code — the
operator points us at a .pt file via /yolo/load and we trust the
ultralytics import to handle architecture detection.

This test verifies our minimal contract: a loader function that returns
an object with a `predict(image, conf, iou, verbose)` method returning a
list of result objects each having `.boxes`, `.masks`, and `.names`.
"""
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from vaa_model.yolo.registry import WeightRegistry


class _FakeBoxes:
    def __init__(self):
        self.xyxy = np.array([[10.0, 12.0, 30.0, 32.0]])
        self.conf = np.array([0.85])
        self.cls = np.array([0])


class _FakeYoloModel:
    """Minimum surface area we depend on, regardless of YOLO version."""
    def __init__(self, weights_path: Path):
        self._weights = weights_path
    def predict(self, _img, conf=0.25, iou=0.7, verbose=False):
        return [SimpleNamespace(boxes=_FakeBoxes(), masks=None, names={0: "car"})]


def test_loader_factory_returns_predict_capable_object(tmp_path):
    """Whatever Ultralytics version is installed, our loader contract
    requires a callable that returns an object with .predict()."""
    fake_pt = tmp_path / "fake.pt"
    fake_pt.write_bytes(b"\x00" * 16)
    reg = WeightRegistry(capacity=2, loader=lambda p: _FakeYoloModel(p))
    model = reg.load("test-key", fake_pt)
    assert hasattr(model, "predict")
    results = model.predict(np.zeros((48, 64, 3), dtype=np.uint8), conf=0.4, iou=0.5)
    assert isinstance(results, list)
    assert hasattr(results[0], "boxes")
    assert hasattr(results[0], "names")


def test_default_loader_is_ultralytics_yolo():
    """The production default loader imports `ultralytics.YOLO`. We can't
    actually call it (no torch in test venv), but verify it's wired."""
    from vaa_model.yolo import registry as r_mod
    # Inspect the default loader function source — must reference ultralytics.YOLO
    import inspect
    src = inspect.getsource(r_mod._default_loader)
    assert "from ultralytics import YOLO" in src
    assert "YOLO(str(weights_path))" in src
