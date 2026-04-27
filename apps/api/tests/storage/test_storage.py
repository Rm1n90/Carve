import io

from carve_api.storage.hashing import stream_xxh3_128


def test_stream_xxh3_128_returns_32_hex_for_known_input() -> None:
    h = stream_xxh3_128(io.BytesIO(b"hello world"))
    assert len(h) == 32
    assert all(c in "0123456789abcdef" for c in h)


def test_stream_xxh3_128_is_deterministic() -> None:
    a = stream_xxh3_128(io.BytesIO(b"vaa-test-payload"))
    b = stream_xxh3_128(io.BytesIO(b"vaa-test-payload"))
    assert a == b


def test_stream_xxh3_128_differs_for_different_input() -> None:
    a = stream_xxh3_128(io.BytesIO(b"alpha"))
    b = stream_xxh3_128(io.BytesIO(b"beta"))
    assert a != b


def test_stream_xxh3_128_handles_chunked_reads() -> None:
    payload = b"x" * (256 * 1024)  # 256 KiB → forces multi-chunk path
    h = stream_xxh3_128(io.BytesIO(payload))
    assert len(h) == 32


def test_minio_client_from_settings_constructs() -> None:
    # Don't require a live MinIO; just verify construction reads env.
    from carve_api.storage.client import MinioClient
    client = MinioClient.from_settings()
    assert client.bucket  # attribute exists


def test_minio_client_falls_back_when_public_endpoint_missing() -> None:
    # When public_endpoint is None (or equal to internal), both clients are
    # the same instance (back-compat).
    from carve_api.storage.client import MinioClient
    client = MinioClient(
        endpoint="http://internal:9000",
        access_key="k",
        secret_key="s",
        bucket="b",
        public_endpoint=None,
    )
    assert client._s3 is client._s3_public


def test_minio_client_uses_separate_clients_for_public_endpoint() -> None:
    # When public_endpoint differs, presigned URLs go through a distinct
    # client whose endpoint is the host-reachable one.
    from carve_api.storage.client import MinioClient
    client = MinioClient(
        endpoint="http://internal:9000",
        access_key="k",
        secret_key="s",
        bucket="b",
        public_endpoint="http://localhost:9000",
    )
    assert client._s3 is not client._s3_public
    url = client.presigned_get("a/b.png", expires_seconds=60)
    assert url.startswith("http://localhost:9000/")
    assert "/b/a/b.png" in url
