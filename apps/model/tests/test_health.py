import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from fastapi.testclient import TestClient

from carve_model.main import create_app


def test_health() -> None:
    client = TestClient(create_app())
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_capabilities_reports_models_and_device() -> None:
    client = TestClient(create_app())
    r = client.get("/capabilities")
    assert r.status_code == 200
    body = r.json()
    assert "yolo" in body["models"]
    # v3.25 — resolver returns the highest-free CUDA device on multi-GPU
    # hosts (or "mps"/"cpu" elsewhere). Accept any well-formed device id.
    dev = body["device"]
    assert dev == "cpu" or dev == "mps" or dev.startswith("cuda:"), dev
