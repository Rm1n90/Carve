"""Settings saved in Carve (Settings → Configuration) for the model service:
read from the API at start, into the environment, never stopping the
service when the API cannot be asked; and a restart only the API can ask
for."""
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import pytest
from fastapi.testclient import TestClient

from carve_model import remote_settings
from carve_model.main import create_app


@pytest.fixture()
def api(monkeypatch):
    """A stand-in for the API's /internal/service-settings/model."""
    seen = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            seen["token"] = self.headers.get("X-Carve-Service-Token")
            body = json.dumps({
                "env": {"SAM_DTYPE": "fp16", "HF_TOKEN": "hf_x", "LD_PRELOAD": "/evil.so"},
                "version": "abc123",
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_a):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setenv("MINIO_ROOT_PASSWORD", "storage-secret")
    monkeypatch.setenv("CARVE_SETTINGS_URL", f"http://127.0.0.1:{server.server_port}/s")
    monkeypatch.setenv("SAM_DTYPE", "bf16")
    monkeypatch.delenv("LD_PRELOAD", raising=False)
    monkeypatch.setattr(remote_settings, "version", "")
    yield seen
    server.shutdown()


def test_saved_settings_go_into_the_environment(api, monkeypatch) -> None:
    import os

    monkeypatch.setenv("HF_TOKEN", "")
    remote_settings.apply()
    assert os.environ["SAM_DTYPE"] == "fp16" and os.environ["HF_TOKEN"] == "hf_x"
    # Only the variables the page offers; anything else is ignored.
    assert "LD_PRELOAD" not in os.environ
    assert remote_settings.version == "abc123"
    assert api["token"] == remote_settings.token()
    assert TestClient(create_app()).get("/health").json()["settings_version"] == "abc123"


def test_the_service_starts_even_when_the_api_cannot_be_asked(monkeypatch) -> None:
    import os

    monkeypatch.setenv("MINIO_ROOT_PASSWORD", "storage-secret")
    monkeypatch.setenv("CARVE_SETTINGS_URL", "http://127.0.0.1:9/nothing-listens-here")
    monkeypatch.setenv("SAM_DTYPE", "bf16")
    monkeypatch.setattr(remote_settings, "version", "")
    remote_settings.apply(attempts=2, wait_s=0)
    assert os.environ["SAM_DTYPE"] == "bf16" and remote_settings.version == ""
    # Without the URL (tests, local runs) nothing is asked at all.
    monkeypatch.delenv("CARVE_SETTINGS_URL")
    remote_settings.apply()


def test_only_the_api_can_restart_the_service(monkeypatch) -> None:
    monkeypatch.setenv("MINIO_ROOT_PASSWORD", "storage-secret")
    started = []

    class FakeTimer:
        def __init__(self, delay, fn, args=()):
            started.append((delay, fn, args))

        def start(self):
            pass

    monkeypatch.setattr(threading, "Timer", FakeTimer)
    client = TestClient(create_app())
    assert client.post("/system/restart").status_code == 403
    assert client.post("/system/restart", headers={"X-Carve-Service-Token": "x"}).status_code == 403
    assert started == []
    r = client.post("/system/restart", headers={"X-Carve-Service-Token": remote_settings.token()})
    assert r.status_code == 200 and r.json() == {"restarting": True}
    assert len(started) == 1 and started[0][2] == (0,)
