# Armin Mehri — mehri.armin@gmail.com
"""After v3.26 the upload pipeline stops silently auto-enqueueing
frame extraction. The client always supplies a strategy via
POST /assets/{id}/frames/extract, so probe_video_metadata must NOT
enqueue extract_frames_for_video.
"""
from unittest.mock import patch, MagicMock

import pytest


@pytest.mark.unit
def test_probe_video_metadata_does_not_enqueue_extract():
    from carve_api.jobs import thumbs as thumbs_mod

    with patch("carve_api.jobs.frames.extract_frames_for_video") as fake_extract, \
         patch("carve_api.jobs.queue.enqueue_with_defaults") as fake_enq, \
         patch.object(thumbs_mod, "_make_thumbnail_jpeg", return_value=b""), \
         patch.object(thumbs_mod, "_persist_thumbnail_key"), \
         patch.object(thumbs_mod, "MinioClient") as fake_minio_cls, \
         patch("ffmpeg.probe", return_value={
             "streams": [{
                 "codec_type": "video", "width": 16, "height": 16,
                 "nb_frames": "10", "avg_frame_rate": "30/1",
             }],
             "format": {"duration": "1.0"},
         }), \
         patch("ffmpeg.input") as fake_input, \
         patch("carve_api.db.get_session_factory") as fake_sf:
        fake_minio_cls.from_settings.return_value = MagicMock(
            presigned_get_internal=MagicMock(return_value="http://x"),
            put_object=MagicMock(),
        )
        fake_input.return_value.output.return_value.run.return_value = (b"", b"")
        sess = MagicMock()
        fake_sf.return_value.begin.return_value.__enter__.return_value = sess
        sess.get.return_value = MagicMock(
            xxh3_128="abc", original_name="v.mp4",
        )
        thumbs_mod.probe_video_metadata(
            "00000000-0000-0000-0000-000000000001", "abc", "mp4"
        )

    fake_extract.assert_not_called()
    fake_enq.assert_not_called()
