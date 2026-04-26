"""App-side SAM proxy.

The api fetches the asset's bytes from MinIO and forwards a base64-encoded
copy to the model service. Embeddings live inside the model service's
sticky predictor; the api does not cache them.
"""

import base64

from vaa_api.assets.models import Asset
from vaa_api.errors import AppError
from vaa_api.inference.autoannotate import fetch_asset_bytes
from vaa_api.inference.model_client import ModelServiceError, sam_decode, sam_encode


class SamModelFailed(AppError):
    http_status = 502
    code = "sam_model_failed"


class SamEmbeddingMissing(AppError):
    http_status = 409
    code = "sam_embedding_missing"


def sam_encode_for_asset(asset: Asset) -> dict:
    body = fetch_asset_bytes(asset)
    b64 = base64.b64encode(body).decode("ascii")
    try:
        return sam_encode(b64)
    except ModelServiceError as exc:
        raise SamModelFailed(f"encode: {exc.body!r}") from exc


def sam_decode_with_hash(image_hash: str, points: list[list[int]], labels: list[int]) -> dict:
    if len(points) != len(labels):
        raise SamModelFailed("points and labels must have equal length")
    try:
        return sam_decode(image_hash, points, labels)
    except ModelServiceError as exc:
        if exc.status_code == 409:
            raise SamEmbeddingMissing("embedding not loaded; call /sam/encode first") from exc
        raise SamModelFailed(f"decode: {exc.body!r}") from exc
