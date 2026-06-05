# Armin Mehri — mehri.armin@gmail.com
"""Storage client must stream large objects via S3 multipart.

A plain ``put_object`` single PUT is capped at 5 GiB by S3/MinIO and holds
the whole body in the request — fatal for the 50 GB source videos the
upload path now accepts. These tests pin the contract that ``put_object``
routes through boto3's managed transfer (``upload_fileobj`` + a
``TransferConfig``) so >5 GiB objects go out as multipart with bounded
memory. No real MinIO or large file is touched; ``_s3`` is a recorder.
"""

from __future__ import annotations

import io

from carve_api.storage.client import MinioClient


class _RecordingS3:
    def __init__(self) -> None:
        self.upload_fileobj_calls: list[dict] = []
        self.put_object_calls: list[dict] = []

    def upload_fileobj(self, Fileobj, Bucket, Key, ExtraArgs=None, Config=None, **kw):  # noqa: N803
        data = Fileobj.read()  # drain like the real transfer manager would
        self.upload_fileobj_calls.append(
            {
                "Bucket": Bucket,
                "Key": Key,
                "ExtraArgs": ExtraArgs,
                "Config": Config,
                "len": len(data),
            }
        )

    def put_object(self, **kw):  # the 5 GiB-capped path that must NOT be used
        self.put_object_calls.append(kw)


def _client() -> MinioClient:
    c = MinioClient(
        endpoint="http://minio:9000",
        access_key="key",
        secret_key="secret-secret",
        bucket="bkt",
    )
    rec = _RecordingS3()
    c._s3 = rec  # type: ignore[assignment]
    c._s3_public = rec  # type: ignore[assignment]
    return c


def test_put_object_streams_via_multipart_transfer() -> None:
    c = _client()
    c.put_object("assets/h/original.mp4", io.BytesIO(b"\x00" * 4096), 4096, "video/mp4")

    s3 = c._s3  # type: ignore[assignment]
    assert len(s3.upload_fileobj_calls) == 1, "must use managed multipart transfer"
    assert len(s3.put_object_calls) == 0, "single-PUT path (5 GiB ceiling) must be retired"

    call = s3.upload_fileobj_calls[0]
    assert call["Key"] == "assets/h/original.mp4"
    assert call["Bucket"] == "bkt"
    assert call["ExtraArgs"]["ContentType"] == "video/mp4"
    assert call["Config"] is not None, "a TransferConfig must drive multipart"
    assert call["len"] == 4096


def test_transfer_config_supports_fifty_gib() -> None:
    """The multipart chunk size must keep a 50 GiB object under S3's 10 000
    part ceiling while triggering multipart well below the 5 GiB single-PUT
    limit (and at/above the 5 MiB minimum part size)."""
    from carve_api.storage.client import _TRANSFER_CONFIG

    fifty_gib = 50 * 1024 * 1024 * 1024
    assert _TRANSFER_CONFIG.multipart_threshold <= 5 * 1024 * 1024 * 1024
    assert _TRANSFER_CONFIG.multipart_chunksize >= 5 * 1024 * 1024
    parts = fifty_gib / _TRANSFER_CONFIG.multipart_chunksize
    assert parts <= 10_000, f"50 GiB would need {parts:.0f} parts (>10000)"
