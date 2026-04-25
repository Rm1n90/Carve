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


def test_capabilities_empty_at_startup() -> None:
    client = TestClient(create_app())
    r = client.get("/capabilities")
    assert r.status_code == 200
    assert r.json() == {"models": []}
