# Armin Mehri — mehri.armin@gmail.com
"""Our own copy of what a provider batch returned.

A finished batch is paid for, and the provider only keeps its results
for about a month. So before a part's results are parsed they are
stored here, in the asset bucket, exactly as they came. From then on
reading them does not depend on the provider: a failure further down
(the database away, a bug in the parser) is retried from this copy for
as long as it takes.
"""

from __future__ import annotations

import gzip
import uuid
from io import BytesIO

from botocore.exceptions import ClientError

from carve_api.storage.client import MinioClient

_MISSING = frozenset({"NoSuchKey", "404", "NotFound"})


def key_for(job_id: uuid.UUID, seq: int, batch_id: str) -> str:
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in batch_id)
    return f"logo-ai/results/{job_id}/part-{seq:04d}-{safe}.jsonl.gz"


def save(key: str, data: bytes) -> None:
    packed = gzip.compress(data)
    MinioClient.from_settings().put_object(
        key, BytesIO(packed), len(packed), "application/gzip"
    )


def load(key: str) -> bytes | None:
    """The stored copy, or ``None`` if there is none yet."""
    try:
        body = MinioClient.from_settings().get_object(key)
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") in _MISSING:
            return None
        raise
    try:
        return gzip.decompress(body.read())
    finally:
        body.close()
