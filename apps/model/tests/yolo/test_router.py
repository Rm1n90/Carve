"""HTTP-level tests for /yolo/load and /yolo/predict.

We pre-seed REGISTRY with a fake loader and stub the urllib download so no
network is touched and Ultralytics is never imported.
"""

import base64
import io
from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image

from carve_model.main import create_app
from carve_model.yolo import registry as registry_mod
from carve_model.yolo.registry import REGISTRY


class _FakeBoxes:
    def __init__(self):
        self.xyxy = np.array([[10.0, 12.0, 30.0, 32.0]])
        self.conf = np.array([0.9])
        self.cls = np.array([0])


class _FakeResults:
    boxes = _FakeBoxes()
    masks = None
    names = {0: "car"}


class _FakeModel:
    def predict(self, _img, conf=0.25, iou=0.7, verbose=False):
        return [_FakeResults()]


def _png_b64(w: int = 64, h: int = 48) -> str:
    img = Image.new("RGB", (w, h), color=(10, 20, 30))
    out = io.BytesIO()
    img.save(out, format="PNG")
    return base64.b64encode(out.getvalue()).decode("ascii")


def _client() -> TestClient:
    return TestClient(create_app())


def test_capabilities_lists_yolo() -> None:
    r = _client().get("/capabilities")
    assert r.status_code == 200
    body = r.json()
    assert "yolo" in body["models"]
    assert body["device"] in ("cpu", "cuda:0")


def test_load_then_predict(monkeypatch, tmp_path) -> None:
    # Stub urllib download to write a small placeholder file
    def fake_download(url: str, dest: str) -> None:
        Path(dest).write_bytes(b"fake-pt-bytes")

    from carve_model.yolo import router as router_mod
    monkeypatch.setattr(router_mod, "_download", fake_download)

    # Inject a fake loader that ignores the file and returns _FakeModel
    REGISTRY.set_loader(lambda _p: _FakeModel())
    REGISTRY.evict("w-1")  # ensure clean state

    client = _client()
    r = client.post(
        "/yolo/load",
        json={"weight_id": "w-1", "weights_url": "https://example/test.pt"},
    )
    assert r.status_code == 200
    assert r.json() == {"loaded": "w-1"}

    r = client.post(
        "/yolo/predict",
        json={"weight_id": "w-1", "image_b64": _png_b64(), "conf": 0.4, "iou": 0.5},
    )
    assert r.status_code == 200
    body = r.json()
    assert len(body["detections"]) == 1
    assert body["detections"][0]["class_name"] == "car"

    # Restore default loader for subsequent tests / production parity
    registry_mod.install_default_loader()


def test_predict_unknown_weight_returns_409() -> None:
    REGISTRY.evict("missing")
    r = _client().post(
        "/yolo/predict",
        json={"weight_id": "missing", "image_b64": _png_b64()},
    )
    assert r.status_code == 409
    assert r.json()["detail"] == "weight_not_loaded"


def test_predict_bad_image_b64_returns_400() -> None:
    REGISTRY.set_loader(lambda _p: _FakeModel())
    REGISTRY.evict("w-bad")

    from carve_model.yolo import router as router_mod
    # need to load a weight first
    def fake_download(url: str, dest: str) -> None:
        Path(dest).write_bytes(b"x")

    import pytest
    with pytest.MonkeyPatch.context() as m:
        m.setattr(router_mod, "_download", fake_download)
        client = _client()
        client.post(
            "/yolo/load",
            json={"weight_id": "w-bad", "weights_url": "https://example/x.pt"},
        )
    r = _client().post(
        "/yolo/predict",
        json={"weight_id": "w-bad", "image_b64": "***NOT-BASE64!!!"},
    )
    assert r.status_code == 400


def test_load_url_failure_returns_502(monkeypatch) -> None:
    REGISTRY.set_loader(lambda _p: _FakeModel())

    def fake_download(url: str, dest: str) -> None:
        raise OSError("network is down")

    from carve_model.yolo import router as router_mod
    monkeypatch.setattr(router_mod, "_download", fake_download)

    r = _client().post(
        "/yolo/load",
        json={"weight_id": "w-fail", "weights_url": "https://example/x.pt"},
    )
    assert r.status_code == 502
    assert r.json()["detail"] == "weight_download_failed"


def test_load_without_loader_returns_503() -> None:
    """If REGISTRY has no loader configured, /yolo/load returns 503."""
    REGISTRY._loader = None  # noqa: SLF001 — direct reset for test
    REGISTRY.evict("any")

    from carve_model.yolo import router as router_mod
    import pytest
    with pytest.MonkeyPatch.context() as m:
        m.setattr(router_mod, "_download", lambda u, d: Path(d).write_bytes(b"x"))
        r = _client().post(
            "/yolo/load",
            json={"weight_id": "any", "weights_url": "https://example/x.pt"},
        )
    assert r.status_code == 503

    # Restore default loader so subsequent tests in the same session work
    from carve_model.yolo.registry import install_default_loader
    install_default_loader()


def test_load_rejects_file_scheme_url() -> None:
    """SSRF guard: file:// schemes must be refused by _download.

    The endpoint wraps the ValueError as 502 'weight_download_failed' — that's
    fine for the threat model (no signal leaked about why the URL was rejected).
    What matters is the request never opens a local file or hits the loader.
    """
    REGISTRY.set_loader(lambda _p: _FakeModel())
    REGISTRY.evict("file-scheme")
    r = TestClient(create_app()).post(
        "/yolo/load",
        json={"weight_id": "file-scheme", "weights_url": "file:///etc/passwd"},
    )
    assert r.status_code == 502
    # And the registry stayed empty
    assert REGISTRY.get("file-scheme") is None
