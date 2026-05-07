# Armin Mehri — mehri.armin@gmail.com
"""Frame cache: asset_hash-keyed JPEG cache used by the SAM 3.1 tracker."""
from unittest.mock import MagicMock, patch
import pytest

from carve_model.sam.track_frame_cache import ensure_cached, cache_dir


@pytest.mark.unit
def test_ensure_cached_downloads_each_url(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "carve_model.sam.track_frame_cache._CACHE_ROOT", str(tmp_path),
    )
    fake_resp = MagicMock(content=b"\xff\xd8\xff" + b"\x00" * 64)
    fake_resp.raise_for_status = MagicMock()
    fake_client = MagicMock()
    fake_client.get.return_value = fake_resp
    fake_client.__enter__ = lambda self: self
    fake_client.__exit__ = lambda *a: None

    with patch("httpx.Client", return_value=fake_client):
        d = ensure_cached(
            asset_hash="abc123",
            frame_urls=[f"http://x/{i}.jpg" for i in range(3)],
        )

    assert d == cache_dir("abc123")
    files = sorted((tmp_path / "abc123").iterdir())
    assert [f.name for f in files] == ["000000.jpg", "000001.jpg", "000002.jpg"]


@pytest.mark.unit
def test_ensure_cached_reuses_existing(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "carve_model.sam.track_frame_cache._CACHE_ROOT", str(tmp_path),
    )
    target = tmp_path / "h" / "000000.jpg"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b"\xff\xd8\xff" + b"\x00" * 64)
    target_two = tmp_path / "h" / "000001.jpg"
    target_two.write_bytes(b"\xff\xd8\xff" + b"\x00" * 64)

    fake_client = MagicMock()
    fake_client.__enter__ = lambda self: self
    fake_client.__exit__ = lambda *a: None
    with patch("httpx.Client", return_value=fake_client):
        d = ensure_cached(
            asset_hash="h",
            frame_urls=["http://x/0.jpg", "http://x/1.jpg"],
        )
    assert d == tmp_path / "h"
    fake_client.get.assert_not_called()


@pytest.mark.unit
def test_ensure_cached_rejects_non_http_url(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "carve_model.sam.track_frame_cache._CACHE_ROOT", str(tmp_path),
    )
    with pytest.raises(ValueError, match="scheme_not_allowed"):
        ensure_cached(
            asset_hash="abc",
            frame_urls=["file:///etc/passwd"],
        )
