"""YOLO inference HTTP endpoints.

POST /yolo/load takes a presigned URL pointing at a .pt file stored in MinIO,
downloads it to a temp file, and registers the model in the LRU.

POST /yolo/predict takes a base64-encoded image and runs predict_image.
Returns 409 if the weight isn't loaded.

POST /yolo/inspect takes a multipart .pt upload, parses ``model.names`` (and
the YOLO task hint) without registering the weight in the LRU, and returns
the class table for upstream callers (e.g. the api ``WeightService.upload``
path so it can persist the real class names instead of an empty list).
"""

import base64
import logging
import os
import urllib.parse
import urllib.request
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

from carve_model.yolo.predict import predict_image
from carve_model.yolo.registry import REGISTRY

log = logging.getLogger(__name__)

_VALID_TASK_KINDS = {"detect", "segment", "classify", "pose"}

# Hard cap on downloaded weight size to defend against disk-exhaustion attacks
# via attacker-supplied URLs. 2 GiB matches the api-side WEIGHT upload cap.
_MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024
_DOWNLOAD_TIMEOUT_SECONDS = 60.0

router = APIRouter(prefix="/yolo", tags=["yolo"])


class LoadIn(BaseModel):
    weight_id: str = Field(min_length=1, max_length=128)
    weights_url: str


class LoadOut(BaseModel):
    loaded: str


class PredictIn(BaseModel):
    weight_id: str = Field(min_length=1, max_length=128)
    image_b64: str
    conf: float = Field(default=0.25, ge=0.0, le=1.0)
    iou: float = Field(default=0.7, ge=0.0, le=1.0)
    # v3.7.5 — optional FP16 toggle. When ``None`` the endpoint falls
    # back to the ``YOLO_HALF`` env default (1=enabled). Explicit
    # ``False`` is honoured for accuracy debugging.
    half: bool | None = None


def _env_half_default() -> bool:
    """Resolve the YOLO half-precision default from ``YOLO_HALF``.

    Defaults to enabled. Recognised disable strings: ``"0"``, ``"false"``,
    ``"False"``. Anything else (including ``"1"``, ``"true"``) is treated
    as enabled. Ultralytics auto-falls-back to FP32 on CPU so the
    default is safe regardless of device.
    """
    return os.getenv("YOLO_HALF", "1") not in ("0", "false", "False")


# Indirection so tests can monkeypatch
def _download(url: str, dest: str) -> None:
    """Stream-download a URL to dest. Rejects non-http(s) schemes to block
    file:// / ftp:// SSRF-style abuse. Caps body size and request timeout."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"scheme_not_allowed: {parsed.scheme}")
    written = 0
    with urllib.request.urlopen(url, timeout=_DOWNLOAD_TIMEOUT_SECONDS) as r:  # noqa: S310 — scheme guarded above
        with open(dest, "wb") as fh:
            while True:
                chunk = r.read(64 * 1024)
                if not chunk:
                    break
                written += len(chunk)
                if written > _MAX_DOWNLOAD_BYTES:
                    raise ValueError("download_too_large")
                fh.write(chunk)


@router.post("/load", response_model=LoadOut)
def load_weight(payload: LoadIn) -> LoadOut:
    with NamedTemporaryFile(suffix=".pt", delete=False) as fh:
        path = Path(fh.name)
    try:
        try:
            _download(payload.weights_url, str(path))
        except Exception as exc:  # noqa: BLE001 — wrap any URL/network failure as 502
            path.unlink(missing_ok=True)
            raise HTTPException(status_code=502, detail="weight_download_failed") from exc
        try:
            REGISTRY.load(payload.weight_id, path)
        except RuntimeError as exc:
            # Loader not configured — production should always have one set on startup.
            path.unlink(missing_ok=True)
            raise HTTPException(status_code=503, detail="loader_not_configured") from exc
    finally:
        # The LRU holds the loaded model object in memory; the on-disk .pt is
        # no longer needed once Ultralytics has parsed it. Unlink unconditionally
        # to avoid /tmp leaks across many /yolo/load calls.
        path.unlink(missing_ok=True)
    return LoadOut(loaded=payload.weight_id)


@router.post("/predict")
def predict(payload: PredictIn) -> dict:
    model = REGISTRY.get(payload.weight_id)
    if model is None:
        raise HTTPException(status_code=409, detail="weight_not_loaded")
    try:
        image_bytes = base64.b64decode(payload.image_b64)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="bad_image_b64") from exc
    # v3.7.5 — explicit body field wins; otherwise fall back to env default.
    half = payload.half if payload.half is not None else _env_half_default()
    return predict_image(
        model,
        image_bytes,
        conf=payload.conf,
        iou=payload.iou,
        half=half,
    )


class InspectOut(BaseModel):
    class_names: list[str] = Field(default_factory=list)
    task_kind: str | None = None


def _normalise_names(names: Any) -> list[str]:
    """Take a YOLO ``names`` value and return a list ordered by class index.

    Ultralytics stores ``names`` as either ``dict[int, str]`` (preferred) or a
    plain ``list[str]``. We normalise both into a list ordered by index so the
    api can persist a deterministic ``class_names`` array. Non-str values are
    coerced via ``str()`` to defend against custom training rigs.
    """
    if isinstance(names, dict):
        try:
            ordered = sorted(((int(k), v) for k, v in names.items()), key=lambda p: p[0])
            return [str(v) for _, v in ordered]
        except (TypeError, ValueError):
            return [str(v) for v in names.values()]
    if isinstance(names, (list, tuple)):
        return [str(v) for v in names]
    return []


def _infer_task_kind(ckpt: Any, model_obj: Any) -> str | None:
    """Best-effort task hint from a YOLO checkpoint.

    Returns one of ``detect``/``segment``/``classify``/``pose`` if the
    checkpoint exposes a ``task`` field, else ``None``. We don't fail the
    inspect call when the hint is missing — the upstream caller already
    holds a user-supplied ``task_kind`` to fall back on.
    """
    candidates: list[Any] = []
    if isinstance(ckpt, dict):
        candidates.append(ckpt.get("task"))
        ta = ckpt.get("train_args")
        if isinstance(ta, dict):
            candidates.append(ta.get("task"))
    candidates.append(getattr(model_obj, "task", None))
    for c in candidates:
        if isinstance(c, str) and c in _VALID_TASK_KINDS:
            return c
    return None


# Indirection so tests can monkeypatch the heavy parse without importing torch.
def _inspect_pt_file(path: Path) -> InspectOut:
    """Open a YOLO ``.pt`` checkpoint and pull ``model.names`` + task hint.

    Raises ``ValueError`` on malformed files so the HTTP handler can map to
    422. Imports torch lazily so the dev server stays light when inspect is
    never called.
    """
    try:
        import torch  # type: ignore[import-not-found]
    except ImportError as exc:  # pragma: no cover — torch ships in the model image
        raise ValueError(f"torch_unavailable: {exc}") from exc

    # YOLOv8 checkpoints embed the YOLO class object, so weights_only=True
    # raises UnpicklingError. We trust our own MinIO-uploaded files (api
    # validates extension + size before forwarding); attacker-supplied files
    # would have to defeat the api's auth and rate-limit first.
    try:
        ckpt = torch.load(str(path), map_location="cpu", weights_only=False)
    except Exception as exc:  # noqa: BLE001 — translate any pickle/zip failure to 422
        raise ValueError(f"failed_to_load: {exc.__class__.__name__}: {exc}") from exc

    model_obj: Any = None
    names: Any = None
    if isinstance(ckpt, dict):
        model_obj = ckpt.get("model")
        names = getattr(model_obj, "names", None)
        if names is None:
            names = ckpt.get("names")
    else:
        model_obj = ckpt
        names = getattr(ckpt, "names", None)

    class_names = _normalise_names(names)
    task_kind = _infer_task_kind(ckpt, model_obj)
    return InspectOut(class_names=class_names, task_kind=task_kind)


# Hard cap on inspected file size — matches the api-side upload cap.
_MAX_INSPECT_BYTES = 2 * 1024 * 1024 * 1024


@router.post("/inspect", response_model=InspectOut)
async def inspect(file: UploadFile = File(...)) -> InspectOut:
    """Parse an uploaded YOLO ``.pt`` checkpoint and return its class table.

    Used by the api on weight-upload to populate ``Weight.class_names`` so the
    /models/yolo table doesn't claim ``0 classes`` for files whose pickled
    metadata actually carries the COCO/custom name dict. Does NOT register the
    weight in the LRU — that's still the job of /yolo/load.
    """
    body = await file.read()
    if len(body) == 0:
        raise HTTPException(status_code=422, detail="empty_file")
    if len(body) > _MAX_INSPECT_BYTES:
        raise HTTPException(status_code=413, detail="file_too_large")

    with NamedTemporaryFile(suffix=".pt", delete=False) as fh:
        path = Path(fh.name)
        fh.write(body)
    try:
        try:
            return _inspect_pt_file(path)
        except ValueError as exc:
            log.warning("yolo_inspect: %s", exc)
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    finally:
        path.unlink(missing_ok=True)
