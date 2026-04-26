import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from fastapi.testclient import TestClient

from vaa_model.main import create_app


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
    assert body["device"] in ("cpu", "cuda:0")
