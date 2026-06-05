# Armin Mehri — mehri.armin@gmail.com
"""Regression: video frame extraction must upload one frame at a time and
retain ONLY ``(idx_in_video, pts_ms)`` metadata — never every frame's bytes.

Holding all frames in memory (the old ``kept: list[..., bytes]`` accumulator)
OOM'd the worker on a long ``all``-strategy extraction, where 100k+ frames *
~200 KB each runs to tens of GB — fatal beside SAM. These tests lock in the
streaming-upload contract of ``_upload_frames``. Pure unit: no DB, ffmpeg, or
Redis.
"""

from __future__ import annotations

from carve_api.jobs.frames import _frame_key, _upload_frames


class _RecStorage:
    def __init__(self) -> None:
        self.calls: list[tuple[str, int, str]] = []

    def put_object(self, key, body, length, content_type):
        data = body.read()
        assert len(data) == length, (len(data), length)
        self.calls.append((key, len(data), content_type))


def test_upload_frames_streams_and_returns_only_metadata(tmp_path) -> None:
    files = []
    for i in range(4):
        p = tmp_path / f"frame_{i:06d}.jpg"
        p.write_bytes(b"JPEG" + bytes([i]) * 10)
        files.append(p)

    rec = _RecStorage()
    seen: list[int] = []
    meta = _upload_frames(rec, "deadbeef", files, step=3, fps=10.0, progress=seen.append)

    # one content-addressed upload per frame, correct mime
    assert [c[0] for c in rec.calls] == [_frame_key("deadbeef", i * 3) for i in range(4)]
    assert all(c[2] == "image/jpeg" for c in rec.calls)

    # returns ONLY (idx_in_video, pts_ms) int pairs — no bytes retained.
    # If anyone reintroduces a bytes accumulator, this shape assertion fails.
    assert meta == [(0, 0), (3, 300), (6, 600), (9, 900)]
    assert all(len(t) == 2 and all(isinstance(v, int) for v in t) for t in meta)

    # progress fired for the final frame
    assert seen and seen[-1] == 4


def test_upload_frames_zero_fps_is_safe(tmp_path) -> None:
    p = tmp_path / "frame_000000.jpg"
    p.write_bytes(b"x")
    rec = _RecStorage()
    meta = _upload_frames(rec, "h", [p], step=1, fps=0.0)
    assert meta == [(0, 0)]  # fps=0 -> pts_ms 0, no ZeroDivisionError
    assert rec.calls[0][0] == _frame_key("h", 0)
