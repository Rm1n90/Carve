# Armin Mehri — mehri.armin@gmail.com
#
# /system/reclaim — backs the System page's "Free memory" button. Drops the
# YOLO + YOLOE checkpoints and returns freed heap to the OS (gc + CUDA
# empty_cache + malloc_trim).
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from fastapi.testclient import TestClient

from carve_model.main import create_app
from carve_model.yolo.registry import WeightRegistry


def test_weight_registry_evict_all_drops_everything_idempotently() -> None:
    reg = WeightRegistry(capacity=2, loader=lambda _p: object())
    reg.load("a", Path("a.pt"))
    reg.load("b", Path("b.pt"))
    assert len(reg) == 2

    evicted = reg.evict_all()
    assert set(evicted) == {"a", "b"}
    assert len(reg) == 0
    # Idempotent — a second call frees nothing and never raises.
    assert reg.evict_all() == []


def test_system_reclaim_endpoint_returns_stable_shape() -> None:
    client = TestClient(create_app())
    r = client.post("/system/reclaim")
    assert r.status_code == 200
    body = r.json()
    for key in (
        "yolo_evicted",
        "yoloe_evicted",
        "malloc_trimmed",
        "rss_before_mb",
        "rss_after_mb",
        "rss_freed_mb",
        "gpu_freed_mb",
    ):
        assert key in body, key
    assert isinstance(body["yolo_evicted"], list)
    assert isinstance(body["yoloe_evicted"], list)
    assert isinstance(body["malloc_trimmed"], bool)


def test_system_reclaim_is_idempotent() -> None:
    client = TestClient(create_app())
    first = client.post("/system/reclaim")
    second = client.post("/system/reclaim")
    assert first.status_code == 200
    assert second.status_code == 200
    # Nothing loaded → nothing to evict on either call.
    assert second.json()["yolo_evicted"] == []
