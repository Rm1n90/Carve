import io
from unittest.mock import MagicMock

from PIL import Image

from carve_api.jobs import thumbs as thumbs_mod


def _png_bytes(w: int = 1024, h: int = 768) -> bytes:
    img = Image.new("RGB", (w, h), color=(64, 128, 192))
    out = io.BytesIO()
    img.save(out, format="PNG")
    return out.getvalue()


def test_generate_image_thumbnail_writes_webp(monkeypatch) -> None:
    captured = {}

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
    thumbs_mod.generate_image_thumbnail("aabbccdd", "png", max_side=320)

    assert captured["get_key"] == "assets/aabbccdd/original.png"
    assert captured["put_key"] == "assets/aabbccdd/thumb.webp"
    assert captured["content_type"] == "image/webp"
    # Sanity: the result must decode as a valid image and fit inside max_side
    out_img = Image.open(io.BytesIO(captured["body"]))
    assert max(out_img.size) <= 320
    out_img.close()


def test_generate_image_thumbnail_max_side_respected(monkeypatch) -> None:
    captured = {}

    class _FakeStorage:
        @classmethod
        def from_settings(cls): return cls()
        def get_object(self, key): return io.BytesIO(_png_bytes(2000, 500))
        def put_object(self, key, body, length, content_type):
            captured["body"] = body.read() if hasattr(body, "read") else bytes(body)

    monkeypatch.setattr(thumbs_mod, "MinioClient", _FakeStorage)
    thumbs_mod.generate_image_thumbnail("xxx", "png", max_side=200)
    out_img = Image.open(io.BytesIO(captured["body"]))
    assert max(out_img.size) <= 200
    out_img.close()
