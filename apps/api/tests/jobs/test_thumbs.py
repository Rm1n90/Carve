import io
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
