import io
import sys
import types
import uuid

from PIL import Image

from carve_api.jobs import thumbs as thumbs_mod


def _png_bytes(w: int = 1024, h: int = 768) -> bytes:
    img = Image.new("RGB", (w, h), color=(64, 128, 192))
    out = io.BytesIO()
    img.save(out, format="PNG")
    return out.getvalue()


def test_generate_image_thumbnail_writes_jpeg(monkeypatch) -> None:
    captured: dict[str, object] = {}

    class _FakeStorage:
        @classmethod
        def from_settings(cls): return cls()
        def get_object(self, key):
            captured["get_key"] = key
            return io.BytesIO(_png_bytes(1024, 768))
        def put_object(self, key, body, length, content_type):
            captured.update({"put_key": key, "length": length, "content_type": content_type})
            captured["body"] = body.read() if hasattr(body, "read") else bytes(body)

    monkeypatch.setattr(thumbs_mod, "MinioClient", _FakeStorage)
    key = thumbs_mod.generate_image_thumbnail("aabbccdd", "png")

    assert captured["get_key"] == "assets/aabbccdd/original.png"
    assert captured["put_key"] == "assets/aabbccdd/thumb-200.jpg"
    assert captured["content_type"] == "image/jpeg"
    assert key == "assets/aabbccdd/thumb-200.jpg"
    out_img = Image.open(io.BytesIO(captured["body"]))
    assert max(out_img.size) <= 200
    assert out_img.format == "JPEG"
    out_img.close()


def test_generate_image_thumbnail_max_side_respected(monkeypatch) -> None:
    captured: dict[str, object] = {}

    class _FakeStorage:
        @classmethod
        def from_settings(cls): return cls()
        def get_object(self, key): return io.BytesIO(_png_bytes(2000, 500))
        def put_object(self, key, body, length, content_type):
            captured["body"] = body.read() if hasattr(body, "read") else bytes(body)

    monkeypatch.setattr(thumbs_mod, "MinioClient", _FakeStorage)
    thumbs_mod.generate_image_thumbnail("xxx", "png", max_side=128)
    out_img = Image.open(io.BytesIO(captured["body"]))
    assert max(out_img.size) <= 128
    out_img.close()


def test_generate_image_thumbnail_persists_key_when_asset_id(monkeypatch) -> None:
    """When an asset_id is passed, the new thumbnail key is written to the DB."""
    persisted: dict[str, object] = {}

    class _FakeStorage:
        @classmethod
        def from_settings(cls): return cls()
        def get_object(self, key): return io.BytesIO(_png_bytes(64, 48))
        def put_object(self, key, body, length, content_type): pass

    def _fake_persist(asset_id: str, key: str) -> None:
        persisted["asset_id"] = asset_id
        persisted["key"] = key

    monkeypatch.setattr(thumbs_mod, "MinioClient", _FakeStorage)
    monkeypatch.setattr(thumbs_mod, "_persist_thumbnail_key", _fake_persist)

    aid = str(uuid.uuid4())
    thumbs_mod.generate_image_thumbnail("hashy", "png", asset_id=aid)

    assert persisted == {"asset_id": aid, "key": "assets/hashy/thumb-200.jpg"}


def test_probe_video_metadata_uses_internal_presigned_url(monkeypatch) -> None:
    """probe_video_metadata runs in the RQ worker container and feeds the URL
    to ffmpeg.probe / ffmpeg.input. It MUST use presigned_get_internal so the
    Docker DNS hostname (``minio``) is resolvable inside the worker network —
    presigned_get returns a public URL pointing at ``localhost:9000`` which
    fails to resolve from inside Docker.
    """
    calls: dict[str, object] = {"used_internal": False, "used_public": False, "url": None}

    class _FakeStorage:
        @classmethod
        def from_settings(cls): return cls()
        def presigned_get(self, key, expires_seconds=600):
            calls["used_public"] = True
            return f"http://localhost:9000/{key}"
        def presigned_get_internal(self, key, expires_seconds=600):
            calls["used_internal"] = True
            calls["url"] = f"http://minio:9000/{key}"
            return calls["url"]

    monkeypatch.setattr(thumbs_mod, "MinioClient", _FakeStorage)

    # Stub ffmpeg.probe / ffmpeg.input so we can assert the URL passed to them.
    fake_ffmpeg = types.ModuleType("ffmpeg")

    def _probe(url, *a, **k):
        calls["probe_url"] = url
        # Return zero video streams so the function exits early without DB writes.
        return {"streams": [], "format": {}}

    fake_ffmpeg.probe = _probe  # type: ignore[attr-defined]
    fake_ffmpeg.input = lambda *a, **k: None  # not reached when streams empty
    monkeypatch.setitem(sys.modules, "ffmpeg", fake_ffmpeg)

    thumbs_mod.probe_video_metadata(
        asset_id=str(uuid.uuid4()), asset_hash="vidhash", ext="mp4"
    )

    assert calls["used_internal"] is True
    assert calls["used_public"] is False
    assert calls["probe_url"] == "http://minio:9000/assets/vidhash/original.mp4"


def test_generate_image_thumbnail_handles_rgba(monkeypatch) -> None:
    """RGBA PNGs (common upload format) must flatten without raising."""
    rgba = Image.new("RGBA", (256, 256), (255, 0, 0, 128))
    buf = io.BytesIO()
    rgba.save(buf, format="PNG")
    rgba_png = buf.getvalue()

    captured: dict[str, object] = {}

    class _FakeStorage:
        @classmethod
        def from_settings(cls): return cls()
        def get_object(self, key): return io.BytesIO(rgba_png)
        def put_object(self, key, body, length, content_type):
            captured["body"] = body.read() if hasattr(body, "read") else bytes(body)

    monkeypatch.setattr(thumbs_mod, "MinioClient", _FakeStorage)
    thumbs_mod.generate_image_thumbnail("rgba", "png")

    out = Image.open(io.BytesIO(captured["body"]))
    assert out.format == "JPEG"
    assert out.mode == "RGB"
    out.close()
