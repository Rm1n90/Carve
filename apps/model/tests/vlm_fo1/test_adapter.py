"""Tests for the VLM-FO1 HTTP-client adapter.

After the sidecar split, this module is just a thin httpx wrapper:
serialize the PIL image, POST to /filter, parse the response, handle
errors. We verify behaviour by intercepting httpx.Client and feeding
canned responses — no real network or model.
"""

from __future__ import annotations

import sys
from io import BytesIO
from types import ModuleType, SimpleNamespace
from typing import Any

import pytest

from carve_model.vlm_fo1 import adapter as a_mod


# --- shared fakes -----------------------------------------------------------


class _FakeImage:
    """Minimal PIL.Image-like object with a .save() that writes PNG bytes."""

    def __init__(self, width: int = 64, height: int = 64) -> None:
        self.size = (width, height)
        self.mode = "RGB"

    def save(self, buf: BytesIO, format: str = "PNG") -> None:  # noqa: A002
        # Emit a minimal but distinct payload so b64 round-trips
        # produce a deterministic string in assertions.
        buf.write(b"\x89PNG\r\n\x1a\n" + bytes([self.size[0], self.size[1]]))

    def convert(self, _mode: str) -> "_FakeImage":
        return self


class _FakeResponse:
    def __init__(self, body: dict[str, Any] | None = None, status: int = 200) -> None:
        self._body = body or {}
        self.status_code = status

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self) -> dict[str, Any]:
        return self._body


class _FakeClient:
    """Drop-in for ``httpx.Client``.

    The closure under test calls ``client.post("/filter", json=...)``;
    we record the request and return whatever the test queued via
    ``responses`` (a list of dicts to wrap in ``_FakeResponse``, or
    bare exceptions to raise).
    """

    last_instance: "_FakeClient | None" = None

    def __init__(self, base_url: str = "", timeout: float = 0.0) -> None:
        self.base_url = base_url
        self.timeout = timeout
        self.posts: list[dict[str, Any]] = []
        self.responses: list[Any] = []
        self._index = 0
        _FakeClient.last_instance = self

    def post(self, path: str, json: dict[str, Any] | None = None) -> _FakeResponse:
        self.posts.append({"path": path, "json": json})
        if not self.responses:
            return _FakeResponse({"indexes": []})
        r = self.responses[min(self._index, len(self.responses) - 1)]
        self._index += 1
        if isinstance(r, BaseException):
            raise r
        if isinstance(r, _FakeResponse):
            return r
        return _FakeResponse(r)

    def close(self) -> None:
        pass


# --- shared fixtures --------------------------------------------------------


@pytest.fixture
def fake_httpx(monkeypatch):
    """Replace ``httpx.Client`` with ``_FakeClient`` for the duration of a test.

    Returns a SimpleNamespace with a ``set_responses(seq)`` helper so
    individual tests don't need to dig into ``_FakeClient.last_instance``.
    The pending response list is queued *before* ``make_vlm_fo1_filter``
    is called because that's when the client is constructed.
    """
    fake_module = ModuleType("httpx")
    fake_module.Client = _FakeClient  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "httpx", fake_module)

    state = SimpleNamespace(pending_responses=[])

    def _install_pending() -> None:
        client = _FakeClient.last_instance
        if client is not None:
            client.responses = list(state.pending_responses)

    state.install_pending = _install_pending
    return state


def _make_filter_with_responses(fake_httpx, responses: list[Any], **kwargs):
    """Helper: queue responses, build the filter, return (fn, fake-client)."""
    fake_httpx.pending_responses = responses
    fn = a_mod.make_vlm_fo1_filter(**kwargs)
    fake_httpx.install_pending()
    return fn, _FakeClient.last_instance


# --- behavioural tests -----------------------------------------------------


def test_filter_short_circuits_on_empty_boxes(fake_httpx):
    fn, client = _make_filter_with_responses(fake_httpx, [{"indexes": [0]}])
    image = _FakeImage()

    out = fn(image=image, text="lion", boxes=[])

    assert out == []
    assert client.posts == []  # no HTTP call


def test_filter_short_circuits_on_blank_text(fake_httpx):
    """Blank text → degrade to passthrough; no HTTP call."""
    fn, client = _make_filter_with_responses(fake_httpx, [{"indexes": [0]}])
    image = _FakeImage()
    boxes = [[0.0, 0.0, 10.0, 10.0], [5.0, 5.0, 15.0, 15.0]]

    out = fn(image=image, text="   ", boxes=boxes)

    assert out == [0, 1]
    assert client.posts == []


def test_filter_returns_indexes_from_sidecar(fake_httpx):
    fn, client = _make_filter_with_responses(
        fake_httpx, [{"indexes": [2, 0]}],
    )
    image = _FakeImage()
    boxes = [[i, i, i + 5, i + 5] for i in range(4)]

    out = fn(image=image, text="ball nearest the bear", boxes=boxes)

    assert out == [2, 0]
    assert len(client.posts) == 1
    body = client.posts[0]["json"]
    assert body["text"] == "ball nearest the bear"
    assert len(body["boxes"]) == 4
    assert isinstance(body["image_b64"], str) and len(body["image_b64"]) > 0


def test_filter_caps_box_count_in_request(fake_httpx):
    fn, client = _make_filter_with_responses(
        fake_httpx, [{"indexes": [0]}], max_boxes=3,
    )
    image = _FakeImage()
    boxes = [[i, i, i + 5, i + 5] for i in range(10)]

    fn(image=image, text="lion", boxes=boxes)

    assert len(client.posts) == 1
    # max_boxes flows through as the cap on what the sidecar runs over,
    # but the wire request still carries the per-call max_boxes hint
    # so the sidecar can defensively cap a second time.
    assert client.posts[0]["json"]["max_boxes"] == 3


def test_filter_degrades_to_passthrough_on_sidecar_error(fake_httpx):
    """A 5xx / connect error must NOT crash the request."""
    fn, _client = _make_filter_with_responses(
        fake_httpx, [RuntimeError("simulated connection refused")],
    )
    image = _FakeImage()
    boxes = [[0.0, 0.0, 10.0, 10.0], [5.0, 5.0, 15.0, 15.0]]

    out = fn(image=image, text="lion", boxes=boxes)

    assert out == [0, 1]


def test_filter_degrades_to_passthrough_on_5xx(fake_httpx):
    fn, _client = _make_filter_with_responses(
        fake_httpx, [_FakeResponse({"detail": "boom"}, status=500)],
    )
    image = _FakeImage()
    boxes = [[0.0, 0.0, 10.0, 10.0]]

    out = fn(image=image, text="lion", boxes=boxes)

    assert out == [0]


def test_filter_returns_empty_when_sidecar_returns_no_matches(fake_httpx):
    fn, _client = _make_filter_with_responses(fake_httpx, [{"indexes": []}])
    image = _FakeImage()
    boxes = [[i, i, i + 5, i + 5] for i in range(3)]

    out = fn(image=image, text="unicorn", boxes=boxes)

    assert out == []


def test_filter_drops_indexes_outside_box_range(fake_httpx):
    """Defensive — sidecar shouldn't emit OOB indexes, but if it does
    we strip them before returning."""
    fn, _client = _make_filter_with_responses(
        fake_httpx, [{"indexes": [77, 1]}],
    )
    image = _FakeImage()
    boxes = [[0.0, 0.0, 10.0, 10.0], [5.0, 5.0, 15.0, 15.0]]

    out = fn(image=image, text="lion", boxes=boxes)

    assert out == [1]


def test_filter_reuses_same_http_client_across_calls(fake_httpx):
    """Repeated calls share the closure's httpx client (connection
    pooling); we don't construct a new client per call."""
    fn, _client = _make_filter_with_responses(
        fake_httpx,
        [{"indexes": [0]}, {"indexes": [0]}, {"indexes": [0]}],
    )
    image = _FakeImage()
    boxes = [[0.0, 0.0, 10.0, 10.0]]

    fn(image=image, text="a", boxes=boxes)
    fn(image=image, text="b", boxes=boxes)
    fn(image=image, text="c", boxes=boxes)

    # Only one client got constructed; that client received 3 posts.
    assert len(_FakeClient.last_instance.posts) == 3
