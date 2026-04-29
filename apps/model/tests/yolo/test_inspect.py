"""HTTP-level tests for POST /yolo/inspect.

We monkeypatch the heavy ``_inspect_pt_file`` helper so torch is never
imported in CI. Two-axis coverage:

  * happy path: dict[int, str] names → returned sorted by index
  * happy path: list names → returned as-is
  * malformed file → 422 with the underlying error
  * empty body → 422 (`empty_file`)

Class-extraction normalisation logic (``_normalise_names``,
``_infer_task_kind``) is also unit-tested directly so future refactors don't
silently regress the index-sorted contract the api relies on.
"""

import io
from pathlib import Path

from fastapi.testclient import TestClient

from carve_model.main import create_app
from carve_model.yolo import router as router_mod
from carve_model.yolo.router import (
    InspectOut,
    _infer_task_kind,
    _normalise_names,
)


def _client() -> TestClient:
    return TestClient(create_app())


def _fake_pt_bytes(n: int = 64) -> bytes:
    return b"PK\x03\x04" + b"x" * n


# ---------- _normalise_names ----------


def test_normalise_names_dict_sorted_by_index() -> None:
    names = {2: "car", 0: "person", 1: "bicycle"}
    assert _normalise_names(names) == ["person", "bicycle", "car"]


def test_normalise_names_list_passthrough() -> None:
    assert _normalise_names(["a", "b", "c"]) == ["a", "b", "c"]


def test_normalise_names_handles_string_keys() -> None:
    # Some Ultralytics checkpoints serialise ``names`` with string keys.
    names = {"1": "bicycle", "0": "person"}
    assert _normalise_names(names) == ["person", "bicycle"]


def test_normalise_names_unknown_shape_returns_empty() -> None:
    assert _normalise_names(None) == []
    assert _normalise_names(42) == []


# ---------- _infer_task_kind ----------


def test_infer_task_kind_from_ckpt_dict() -> None:
    assert _infer_task_kind({"task": "segment"}, None) == "segment"


def test_infer_task_kind_from_train_args() -> None:
    assert _infer_task_kind({"train_args": {"task": "pose"}}, None) == "pose"


def test_infer_task_kind_from_model_attr() -> None:
    class _Stub:
        task = "classify"

    assert _infer_task_kind({}, _Stub()) == "classify"


def test_infer_task_kind_unknown_returns_none() -> None:
    assert _infer_task_kind({"task": "weird-thing"}, None) is None
    assert _infer_task_kind({}, None) is None


# ---------- HTTP /yolo/inspect ----------


def test_inspect_returns_class_names_and_task(monkeypatch) -> None:
    """Happy path: monkeypatched parser → 200 with sorted class_names."""

    def fake_inspect(path: Path) -> InspectOut:
        assert Path(path).exists()  # endpoint wrote the multipart bytes here
        return InspectOut(class_names=["person", "bicycle", "car"], task_kind="detect")

    monkeypatch.setattr(router_mod, "_inspect_pt_file", fake_inspect)

    r = _client().post(
        "/yolo/inspect",
        files={"file": ("yolov8n.pt", io.BytesIO(_fake_pt_bytes()), "application/octet-stream")},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["class_names"] == ["person", "bicycle", "car"]
    assert body["task_kind"] == "detect"


def test_inspect_returns_422_when_loading_fails(monkeypatch) -> None:
    def fake_inspect(_path: Path) -> InspectOut:
        raise ValueError("failed_to_load: UnpicklingError: bad magic number")

    monkeypatch.setattr(router_mod, "_inspect_pt_file", fake_inspect)

    r = _client().post(
        "/yolo/inspect",
        files={"file": ("broken.pt", io.BytesIO(b"not-a-pickle"), "application/octet-stream")},
    )
    assert r.status_code == 422
    assert "failed_to_load" in r.json()["detail"]


def test_inspect_rejects_empty_body(monkeypatch) -> None:
    # Even with a working parser, the endpoint must reject 0-byte uploads.
    monkeypatch.setattr(
        router_mod,
        "_inspect_pt_file",
        lambda _p: InspectOut(class_names=[], task_kind=None),
    )

    r = _client().post(
        "/yolo/inspect",
        files={"file": ("empty.pt", io.BytesIO(b""), "application/octet-stream")},
    )
    assert r.status_code == 422
    assert r.json()["detail"] == "empty_file"


def test_inspect_does_not_touch_registry(monkeypatch) -> None:
    """The inspect path must not register the weight in the LRU.

    Regression guard: if a future refactor accidentally calls REGISTRY.load,
    /predict for unrelated weights could be silently evicted by capacity=2.
    """
    from carve_model.yolo.registry import REGISTRY

    before = len(REGISTRY)
    monkeypatch.setattr(
        router_mod,
        "_inspect_pt_file",
        lambda _p: InspectOut(class_names=["car"], task_kind="detect"),
    )
    r = _client().post(
        "/yolo/inspect",
        files={"file": ("y.pt", io.BytesIO(_fake_pt_bytes()), "application/octet-stream")},
    )
    assert r.status_code == 200
    assert len(REGISTRY) == before
