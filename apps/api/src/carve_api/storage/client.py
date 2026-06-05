# Armin Mehri — mehri.armin@gmail.com
from typing import BinaryIO

import boto3
from boto3.s3.transfer import TransferConfig
from botocore.client import Config
from botocore.exceptions import ClientError

from carve_api.config import get_settings

# Managed-transfer settings for object PUTs. boto3 switches to S3 multipart
# once a body exceeds ``multipart_threshold`` and uploads parts in parallel,
# reading the source in bounded ``multipart_chunksize`` chunks. This is what
# lets a 50 GB video go up at all (single PUT is capped at 5 GiB) and keeps
# API memory flat (~max_concurrency * chunksize peak) instead of buffering
# the whole body. 64 MiB chunks keep a 50 GiB object at ~800 parts, well
# under S3's 10 000-part ceiling.
_PART_SIZE = 64 * 1024 * 1024  # 64 MiB
_TRANSFER_CONFIG = TransferConfig(
    multipart_threshold=_PART_SIZE,
    multipart_chunksize=_PART_SIZE,
    max_concurrency=4,
    use_threads=True,
)


def _build_s3(endpoint: str, access_key: str, secret_key: str):
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        config=Config(signature_version="s3v4"),
        region_name="us-east-1",
    )


class MinioClient:
    """Storage client backed by two boto3 S3 clients.

    `_s3` uses the internal docker-network endpoint for server-side I/O
    (`put_object`, `get_object`, `head_bucket`, `create_bucket`,
    `delete_object`).

    `_s3_public` uses a host-reachable public endpoint, and is only used
    when generating presigned URLs that the browser will follow. When no
    public endpoint is configured, both clients share the internal one
    so existing behavior (and tests) is preserved.
    """

    def __init__(
        self,
        *,
        endpoint: str,
        access_key: str,
        secret_key: str,
        bucket: str,
        public_endpoint: str | None = None,
    ) -> None:
        self.bucket = bucket
        self._s3 = _build_s3(endpoint, access_key, secret_key)
        if public_endpoint and public_endpoint != endpoint:
            self._s3_public = _build_s3(public_endpoint, access_key, secret_key)
        else:
            # Back-compat: same client for both internal and public use.
            self._s3_public = self._s3

    @classmethod
    def from_settings(cls) -> "MinioClient":
        s = get_settings()
        return cls(
            endpoint=s.minio_endpoint,
            access_key=s.minio_root_user,
            secret_key=s.minio_root_password,
            bucket=s.minio_bucket,
            public_endpoint=s.minio_public_endpoint,
        )

    def ensure_bucket(self) -> None:
        try:
            self._s3.head_bucket(Bucket=self.bucket)
        except ClientError:
            self._s3.create_bucket(Bucket=self.bucket)

    def put_object(self, key: str, body: BinaryIO, length: int, content_type: str) -> None:
        """Store ``body`` at ``key`` via boto3's managed transfer.

        ``length`` is accepted for call-site back-compat but the transfer
        manager derives it from the (seekable) stream. Using ``upload_fileobj``
        rather than a raw ``put_object`` means bodies over the 5 GiB single-PUT
        ceiling go out as S3 multipart, and the body streams in bounded chunks
        instead of being held whole in memory — required for 50 GB videos.
        """
        body.seek(0)
        self._s3.upload_fileobj(
            Fileobj=body,
            Bucket=self.bucket,
            Key=key,
            ExtraArgs={"ContentType": content_type},
            Config=_TRANSFER_CONFIG,
        )

    def get_object(self, key: str):
        return self._s3.get_object(Bucket=self.bucket, Key=key)["Body"]

    def remove_object(self, key: str) -> None:
        self._s3.delete_object(Bucket=self.bucket, Key=key)

    def presigned_get(
        self,
        key: str,
        expires_seconds: int = 600,
        download_filename: str | None = None,
        content_type: str | None = None,
    ) -> str:
        """Plan-20.4 — when ``download_filename`` is set, the presigned
        URL also rewrites the response headers
        (``Content-Disposition: attachment; filename="…"`` and an
        optional ``Content-Type``) so the browser saves the file with
        the requested name instead of navigating to the URL or opening
        it inline. This is the only reliable way to force download
        behaviour for a cross-origin (MinIO) URL — the page-side
        ``<a download>`` attribute is ignored across origins, so the
        response disposition has to do the work."""
        params: dict[str, object] = {"Bucket": self.bucket, "Key": key}
        if download_filename:
            # boto3 percent-encodes this value into the URL — pre-quote
            # nothing here.
            params["ResponseContentDisposition"] = (
                f'attachment; filename="{download_filename}"'
            )
        if content_type:
            params["ResponseContentType"] = content_type
        return self._s3_public.generate_presigned_url(
            "get_object",
            Params=params,
            ExpiresIn=expires_seconds,
        )

    def presigned_get_internal(self, key: str, expires_seconds: int = 600) -> str:
        """Presigned URL using INTERNAL minio endpoint, for service-to-service download
        (e.g. model service downloading a YOLO weight from MinIO over Docker DNS).
        Browser-facing flows MUST use presigned_get() (public endpoint)."""
        return self._s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": self.bucket, "Key": key},
            ExpiresIn=expires_seconds,
        )

    def presigned_put(
        self, key: str, expires_seconds: int = 600, content_type: str | None = None
    ) -> str:
        params: dict[str, object] = {"Bucket": self.bucket, "Key": key}
        if content_type:
            params["ContentType"] = content_type
        return self._s3_public.generate_presigned_url(
            "put_object",
            Params=params,
            ExpiresIn=expires_seconds,
        )
