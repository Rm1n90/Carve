# Armin Mehri — mehri.armin@gmail.com
"""Regression: video frame extraction streams through a pipe — one frame in
memory, nothing staged to disk — and the JPEG splitter is marker-aware so it
never truncates a frame on an ``FF D9`` byte pair that happens to sit inside a
segment payload.

Holding all frames (the old ``kept`` list) OOM'd the worker on long videos;
staging every frame to disk filled ``/tmp``. Both are gone. Pure unit tests:
no DB, ffmpeg, or Redis.
"""

from __future__ import annotations

import io

from PIL import Image

from carve_api.jobs.frames import (
    _frame_key,
    _iter_jpeg_frames,
    _stream_upload_frames,
)


def _real_jpeg(color: tuple[int, int, int]) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (16, 16), color).save(buf, format="JPEG")
    return buf.getvalue()


class _RecStorage:
    def __init__(self) -> None:
        self.calls: list[tuple[str, int, str]] = []

    def put_object(self, key, body, length, content_type):
        data = body.read()
        assert len(data) == length, (len(data), length)
        self.calls.append((key, len(data), content_type))


def test_iter_jpeg_frames_splits_real_concatenated_jpegs() -> None:
    f1 = _real_jpeg((200, 30, 30))
    f2 = _real_jpeg((30, 200, 30))
    f3 = _real_jpeg((30, 30, 200))
    stream = io.BytesIO(f1 + f2 + f3)
    # Tiny chunks force frame boundaries (and SOI/EOI) to straddle reads.
    out = list(_iter_jpeg_frames(stream, chunk_size=7))
    assert out == [f1, f2, f3]


def test_iter_jpeg_frames_skips_ffd9_inside_a_segment() -> None:
    """A raw ``FF D9`` inside a marker segment (here a COM payload) must NOT be
    mistaken for the frame's EOI — the splitter parses segment lengths."""
    trap = bytes(
        [
            0xFF, 0xD8,                                # SOI
            0xFF, 0xFE, 0x00, 0x06, 0xFF, 0xD9, 0x41, 0x42,  # COM len=6, payload has FF D9
            0xFF, 0xDA, 0x00, 0x03, 0x00,             # SOS len=3 (1 header byte)
            0x01, 0x02, 0x03,                         # entropy data (no FF)
            0xFF, 0xD9,                               # real EOI
        ]
    )
    out = list(_iter_jpeg_frames(io.BytesIO(trap), chunk_size=4))
    assert out == [trap], "splitter truncated on an in-segment FF D9"


def test_iter_jpeg_frames_drops_incomplete_trailing_frame() -> None:
    f1 = _real_jpeg((120, 120, 120))
    partial = b"\xff\xd8\xff\xfe\x00\x04ab"  # SOI + a segment, no EOI
    out = list(_iter_jpeg_frames(io.BytesIO(f1 + partial), chunk_size=5))
    assert out == [f1]  # the incomplete trailing frame is never yielded


def test_stream_upload_frames_streams_and_returns_metadata() -> None:
    f0, f1, f2 = b"frame0", b"frame-1", b"f2"
    rec = _RecStorage()
    seen: list[int] = []
    meta, first = _stream_upload_frames(
        rec, "deadbeef", iter([f0, f1, f2]), step=3, fps=10.0, on_frame=seen.append
    )

    assert [c[0] for c in rec.calls] == [_frame_key("deadbeef", i * 3) for i in range(3)]
    assert all(c[2] == "image/jpeg" for c in rec.calls)
    # only (idx, pts_ms) int pairs retained; first frame kept for the thumbnail
    assert meta == [(0, 0), (3, 300), (6, 600)]
    assert all(len(t) == 2 and all(isinstance(v, int) for v in t) for t in meta)
    assert first == f0
    assert seen and seen[-1] == 3


def test_stream_upload_frames_zero_fps_is_safe() -> None:
    rec = _RecStorage()
    meta, first = _stream_upload_frames(rec, "h", iter([b"x"]), step=1, fps=0.0)
    assert meta == [(0, 0)]  # fps=0 -> pts_ms 0, no ZeroDivisionError
    assert first == b"x"
    assert rec.calls[0][0] == _frame_key("h", 0)
