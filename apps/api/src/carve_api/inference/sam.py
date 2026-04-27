"""App-side SAM proxy.

The api fetches the asset's bytes from MinIO and forwards a base64-encoded
copy to the model service. The model service returns ``{image_hash, shape,
embedding_b64?}``. The api caches that dict in Redis under
``sam:embed:<image_hash>`` with a 30-minute TTL so repeated SAM activations
on the same image skip the model round-trip and the embedding extraction.

Redis is best-effort: a missing/down Redis simply falls through to the
model. Mirrors the pattern in ``carve_api/io/import_job.py``.
"""

import base64
import json

from carve_api.assets.models import Asset
from carve_api.config import get_settings
from carve_api.errors import AppError
from carve_api.inference.autoannotate import fetch_asset_bytes
from carve_api.inference.model_client import ModelServiceError, sam_decode, sam_encode


class SamModelFailed(AppError):
    http_status = 502
    code = "sam_model_failed"


class SamModelUnreachable(AppError):
    """Model service is offline (DNS/connect/timeout) — distinct from 5xx.

    Raised when the carve api can't even open a connection to the model
    service (e.g. the docker-compose ``inference`` profile isn't running).
    Maps to a 503 response with ``error: model_service_unreachable`` so the
    SAM tool in the web app can show a clear "model service is offline"
    toast instead of treating it as a generic upstream error.
    """

    http_status = 503
    code = "model_service_unreachable"


class SamEmbeddingMissing(AppError):
    http_status = 409
    code = "sam_embedding_missing"


_SAM_EMBED_TTL_SECONDS = 30 * 60  # 30 minutes


def _redis_or_none():
    """Return a live Redis client or ``None`` if Redis isn't reachable.

    Best-effort — never raises. Tests monkeypatch this module attribute to
    inject a fake or to simulate "Redis is down".
    """
    from redis import Redis

    s = get_settings()
    try:
        client = Redis(host=s.redis_host, port=s.redis_port, socket_connect_timeout=1)
        client.ping()
        return client
    except Exception:
        return None


def _cache_key(image_hash: str) -> str:
    return f"sam:embed:{image_hash}"


def sam_encode_for_asset(asset: Asset) -> dict:
    """Encode the asset on the model service. Cache the result in Redis.

    The asset's pre-computed ``xxh3_128`` matches the hash the model service
    derives from the same bytes (both use xxh3_128), so we can probe Redis
    before fetching bytes from MinIO. If Redis is unavailable, the existing
    fetch + model invoke path runs unchanged.
    """
    redis_client = _redis_or_none()
    cache_key = _cache_key(asset.xxh3_128)
    if redis_client is not None:
        try:
            cached = redis_client.get(cache_key)
            if cached:
                return json.loads(cached)
        except Exception:
            # Fall through on any cache read failure.
            pass

    body = fetch_asset_bytes(asset)
    b64 = base64.b64encode(body).decode("ascii")
    try:
        result = sam_encode(b64)
    except ModelServiceError as exc:
        if exc.status_code == 503:
            raise SamModelUnreachable(f"encode: {exc.body!r}") from exc
        raise SamModelFailed(f"encode: {exc.body!r}") from exc

    if redis_client is not None:
        try:
            redis_client.setex(
                cache_key, _SAM_EMBED_TTL_SECONDS, json.dumps(result)
            )
        except Exception:
            # Best-effort write — never fail the request because Redis hiccuped.
            pass
    return result


def sam_decode_with_hash(image_hash: str, points: list[list[int]], labels: list[int]) -> dict:
    if len(points) != len(labels):
        raise SamModelFailed("points and labels must have equal length")
    try:
        return sam_decode(image_hash, points, labels)
    except ModelServiceError as exc:
        if exc.status_code == 409:
            raise SamEmbeddingMissing("embedding not loaded; call /sam/encode first") from exc
        if exc.status_code == 503:
            raise SamModelUnreachable(f"decode: {exc.body!r}") from exc
        raise SamModelFailed(f"decode: {exc.body!r}") from exc
