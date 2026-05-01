"""HTTP-level tests for /yolo/train (plan-09 task-05).

We patch the heavy bits so neither Ultralytics nor MinIO is actually used:
  * ``_download_dataset`` writes a tiny no-op zip we built in tmp_path
  * ``_run_train`` returns a fake metrics dict and writes a stub best.pt
  * ``_upload_pt_to_minio`` returns a fake presigned URL

The endpoint format choice for ``weight_id`` is documented as a 32-char
lowercase hex (``uuid.uuid4().hex``) — matches the regex ``^[0-9a-f]{32}$``
in the task spec.
"""

import re
import zipfile
from pathlib import Path

from fastapi.testclient import TestClient

from carve_model.main import create_app
from carve_model.yolo import router as router_mod


_HEX32_RE = re.compile(r"^[0-9a-f]{32}$")


def _client() -> TestClient:
    return TestClient(create_app())


def _make_dataset_zip(zip_path: Path) -> None:
    """Create a minimal valid YOLO dataset zip with a data.yaml."""
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            "data.yaml",
            'path: .\ntrain: images/train\nval: images/val\nnc: 1\nnames: ["car"]\n',
        )
        zf.writestr("images/train/.gitkeep", "")
        zf.writestr("labels/train/.gitkeep", "")


def _patch_train_pipeline(monkeypatch, tmp_path: Path) -> dict:
    """Wire up no-op stubs for the heavy bits of /yolo/train. Returns the
    captured-args dict the test asserts against.
    """
    captured: dict = {}

    src_zip = tmp_path / "src.zip"
    _make_dataset_zip(src_zip)

    def fake_download(url, dest):
        captured["dataset_url"] = url
        Path(dest).write_bytes(src_zip.read_bytes())

    def fake_run_train(base_path, data_yaml, *, epochs, imgsz, device, project):
        captured["base_path"] = base_path
        captured["epochs"] = epochs
        captured["imgsz"] = imgsz
        captured["device"] = device
        # Simulate ultralytics writing best.pt under runs/detect/train/weights/
        weights_dir = Path(project) / "detect" / "train" / "weights"
        weights_dir.mkdir(parents=True, exist_ok=True)
        (weights_dir / "best.pt").write_bytes(b"fake-trained-weights")
        return {"metrics/mAP50": 0.78, "metrics/mAP50-95": 0.61}

    def fake_upload(pt_path, key):
        captured["upload_key"] = key
        captured["upload_size"] = Path(pt_path).stat().st_size
        return f"https://minio.internal/{key}?signed=1"

    monkeypatch.setattr(router_mod, "_download_dataset", fake_download)
    monkeypatch.setattr(router_mod, "_run_train", fake_run_train)
    monkeypatch.setattr(router_mod, "_upload_pt_to_minio", fake_upload)
    return captured


def test_train_returns_descriptor(monkeypatch, tmp_path) -> None:
    captured = _patch_train_pipeline(monkeypatch, tmp_path)
    r = _client().post(
        "/yolo/train",
        json={
            "weight_id_base": None,
            "dataset_zip_url": "https://example/ds.zip",
            "epochs": 3,
            "imgsz": 640,
            "device": "cpu",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    # weight_id is documented as a 32-char hex string (uuid4.hex).
    assert _HEX32_RE.match(body["weight_id"])
    assert body["weights_url"].startswith("https://minio.internal/weights/")
    assert isinstance(body["xxh3_128"], str) and len(body["xxh3_128"]) == 32
    assert body["size_bytes"] == len(b"fake-trained-weights")
    assert body["metrics"] == {"metrics/mAP50": 0.78, "metrics/mAP50-95": 0.61}
    assert captured["upload_key"] == f"weights/{body['xxh3_128']}/{body['weight_id']}.pt"
    assert captured["epochs"] == 3
    assert captured["imgsz"] == 640
    assert captured["device"] == "cpu"


def test_train_rejects_bad_epochs() -> None:
    r = _client().post(
        "/yolo/train",
        json={
            "dataset_zip_url": "https://example/ds.zip",
            "epochs": 999,
            "imgsz": 640,
        },
    )
    assert r.status_code == 422


def test_train_rejects_bad_imgsz() -> None:
    """imgsz must be in [320, 1280] AND divisible by 32."""
    r = _client().post(
        "/yolo/train",
        json={
            "dataset_zip_url": "https://example/ds.zip",
            "epochs": 5,
            "imgsz": 100,
        },
    )
    assert r.status_code == 422
    r = _client().post(
        "/yolo/train",
        json={
            "dataset_zip_url": "https://example/ds.zip",
            "epochs": 5,
            "imgsz": 641,
        },
    )
    assert r.status_code == 422


def test_train_failure_returns_502(monkeypatch, tmp_path) -> None:
    src_zip = tmp_path / "src.zip"
    _make_dataset_zip(src_zip)

    def fake_download(url, dest):
        Path(dest).write_bytes(src_zip.read_bytes())

    def fake_train_raises(*a, **k):
        raise RuntimeError("cuda OOM")

    monkeypatch.setattr(router_mod, "_download_dataset", fake_download)
    monkeypatch.setattr(router_mod, "_run_train", fake_train_raises)

    r = _client().post(
        "/yolo/train",
        json={
            "dataset_zip_url": "https://example/ds.zip",
            "epochs": 3,
            "imgsz": 640,
        },
    )
    assert r.status_code == 502
    assert "cuda OOM" in r.json()["detail"]
