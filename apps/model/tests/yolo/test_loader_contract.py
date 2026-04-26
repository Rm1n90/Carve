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

from carve_model.yolo.registry import WeightRegistry


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
    from carve_model.yolo import registry as r_mod
    # Inspect the default loader function source — must reference ultralytics.YOLO
    import inspect
    src = inspect.getsource(r_mod._default_loader)
    assert "from ultralytics import YOLO" in src
    assert "YOLO(str(weights_path))" in src


# All 25 YOLO26 variant filenames. The loader is version-agnostic — these
# names just hit the disk, the actual ultralytics.YOLO() detects the
# architecture from the .pt magic bytes / metadata. Our test seeds a fake
# .pt file to confirm the registry layer doesn't filter or rewrite the
# filename.
YOLO26_VARIANTS = [
    "yolo26n.pt", "yolo26s.pt", "yolo26m.pt", "yolo26l.pt", "yolo26x.pt",
    "yolo26n-seg.pt", "yolo26s-seg.pt", "yolo26m-seg.pt", "yolo26l-seg.pt", "yolo26x-seg.pt",
    "yolo26n-cls.pt", "yolo26s-cls.pt", "yolo26m-cls.pt", "yolo26l-cls.pt", "yolo26x-cls.pt",
    "yolo26n-pose.pt", "yolo26s-pose.pt", "yolo26m-pose.pt", "yolo26l-pose.pt", "yolo26x-pose.pt",
    "yolo26n-obb.pt", "yolo26s-obb.pt", "yolo26m-obb.pt", "yolo26l-obb.pt", "yolo26x-obb.pt",
]


@pytest.mark.parametrize("filename", YOLO26_VARIANTS)
def test_registry_accepts_yolo26_variant_filenames(tmp_path, filename):
    """All 25 YOLO26 variants flow through the existing loader factory.
    The registry doesn't filter on filename pattern — it accepts any path
    and forwards it to the loader callable."""
    weights = tmp_path / filename
    weights.write_bytes(b"\x00" * 16)  # fake .pt; the fake loader doesn't parse it

    captured: dict[str, object] = {}

    def _capture_loader(p):
        captured["path"] = p
        return _FakeYoloModel(p)

    reg = WeightRegistry(capacity=2, loader=_capture_loader)
    model = reg.load(filename, weights)
    assert hasattr(model, "predict")
    assert captured["path"] == weights
