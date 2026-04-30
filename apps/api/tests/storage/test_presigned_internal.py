"""Tests for MinioClient.presigned_get_internal — the internal-endpoint
variant used for service-to-service downloads (model service over
Docker DNS), distinct from presigned_get which is browser-facing."""

from carve_api.storage.client import MinioClient


def test_presigned_get_internal_uses_internal_endpoint() -> None:
    # Arrange: configure two distinct endpoints so internal != public.
    client = MinioClient(
        endpoint="http://minio:9000",
        access_key="k",
        secret_key="s",
        bucket="b",
        public_endpoint="http://localhost:9000",
    )

    # Act: produce both URLs for the same key.
    internal_url = client.presigned_get_internal("weights/x.pt", expires_seconds=60)
    public_url = client.presigned_get("weights/x.pt", expires_seconds=60)

    # Assert: internal points at minio (Docker DNS), public at localhost.
    assert internal_url.startswith("http://minio:9000/")
    assert "/b/weights/x.pt" in internal_url
    assert public_url.startswith("http://localhost:9000/")
    assert "/b/weights/x.pt" in public_url
    assert internal_url != public_url


def test_presigned_get_internal_falls_back_when_no_public_endpoint() -> None:
    # Arrange: no public endpoint configured, both clients are the same.
    client = MinioClient(
        endpoint="http://minio:9000",
        access_key="k",
        secret_key="s",
        bucket="b",
        public_endpoint=None,
    )

    # Act
    internal_url = client.presigned_get_internal("weights/x.pt", expires_seconds=60)
    public_url = client.presigned_get("weights/x.pt", expires_seconds=60)

    # Assert: both URLs target the only known endpoint.
    assert internal_url.startswith("http://minio:9000/")
    assert public_url.startswith("http://minio:9000/")
    assert "/b/weights/x.pt" in internal_url


def test_presigned_get_internal_includes_expiry_param() -> None:
    # Arrange
    client = MinioClient(
        endpoint="http://minio:9000",
        access_key="k",
        secret_key="s",
        bucket="b",
        public_endpoint="http://localhost:9000",
    )

    # Act
    url = client.presigned_get_internal("weights/x.pt", expires_seconds=120)

    # Assert: SigV4 presigned URLs include X-Amz-Expires query string.
    assert "X-Amz-Expires=120" in url
