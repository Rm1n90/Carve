"""YOLO inference HTTP endpoints.

POST /yolo/load takes a presigned URL pointing at a .pt file stored in MinIO,
downloads it to a temp file, and registers the model in the LRU.

POST /yolo/predict takes a base64-encoded image and runs predict_image.
Returns 409 if the weight isn't loaded.

POST /yolo/inspect takes a multipart .pt upload, parses ``model.names`` (and
the YOLO task hint) without registering the weight in the LRU, and returns
the class table for upstream callers (e.g. the api ``WeightService.upload``
path so it can persist the real class names instead of an empty list).

POST /yolo/train (plan-09 task-05) downloads a YOLO dataset zip, runs
``ultralytics.YOLO(base).train(...)``, hashes the produced ``best.pt`` and
uploads it to MinIO at ``weights/<xxh3>/<new_weight_id>.pt``. Returns a
descriptor the api consumes to register a new ``Weight`` row.
"""

import base64
import io
import logging
import os
import shutil
import tempfile
import urllib.parse
import urllib.request
import uuid
import zipfile
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


# ---------------------------------------------------------------------------
# /yolo/train (plan-09 task-05) — active-learning retrain endpoint.
#
# Downloads a YOLO dataset zip, runs ultralytics training, hashes best.pt and
# uploads it to MinIO. Validation:
#   * epochs in [1, 200]
#   * imgsz in [320, 1280] and divisible by 32
#
# The returned ``weight_id`` is a 32-char hex (uuid4 without dashes) so the
# api can register a new Weight row without forcing the user to pick a UUID.
# ---------------------------------------------------------------------------


_VALID_IMGSZ_MIN = 320
_VALID_IMGSZ_MAX = 1280
_VALID_EPOCHS_MIN = 1
_VALID_EPOCHS_MAX = 200
_DATASET_DOWNLOAD_TIMEOUT_S = 300.0
_MAX_DATASET_BYTES = 10 * 1024 * 1024 * 1024  # 10 GiB cap


class TrainIn(BaseModel):
    """Body for POST /yolo/train.

    ``weight_id_base`` is an optional weight id whose .pt is loaded from the
    registry (or assumed already cached). When ``None`` the endpoint trains
    on top of ``yolov8n.pt`` (Ultralytics auto-downloads on first use).
    ``device`` is forwarded verbatim to Ultralytics ("auto", "cpu", "0", ...).
    """

    weight_id_base: str | None = Field(default=None, max_length=128)
    dataset_zip_url: str = Field(..., min_length=1)
    epochs: int = Field(..., ge=_VALID_EPOCHS_MIN, le=_VALID_EPOCHS_MAX)
    imgsz: int = Field(..., ge=_VALID_IMGSZ_MIN, le=_VALID_IMGSZ_MAX)
    device: str = Field(default="auto", max_length=32)


class TrainOut(BaseModel):
    weight_id: str  # 32-char hex (uuid4 stripped of dashes)
    weights_url: str
    xxh3_128: str
    size_bytes: int
    metrics: dict[str, Any] = Field(default_factory=dict)


def _validate_imgsz(imgsz: int) -> None:
    """Pydantic enforces the bounds; this enforces the divisible-by-32 rule
    that's awkward to express in a Field() validator."""
    if imgsz % 32 != 0:
        raise HTTPException(
            status_code=422,
            detail=f"imgsz_not_divisible_by_32: {imgsz}",
        )


def _download_dataset(url: str, dest: Path) -> None:
    """Stream-download a dataset zip. SSRF-guarded against non-http(s) schemes
    and capped at ``_MAX_DATASET_BYTES`` so a malicious URL can't fill /tmp.

    Mirrors ``_download`` (weights) but with a larger cap and longer timeout
    because dataset zips can be much bigger than a single .pt file.
    """
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"scheme_not_allowed: {parsed.scheme}")
    written = 0
    with urllib.request.urlopen(url, timeout=_DATASET_DOWNLOAD_TIMEOUT_S) as r:  # noqa: S310 — scheme guarded
        with open(dest, "wb") as fh:
            while True:
                chunk = r.read(64 * 1024)
                if not chunk:
                    break
                written += len(chunk)
                if written > _MAX_DATASET_BYTES:
                    raise ValueError("dataset_too_large")
                fh.write(chunk)


def _extract_zip(zip_path: Path, dest: Path) -> None:
    """Extract a zip with path-traversal guard. Refuses absolute member paths
    or '..' segments so a crafted zip can't write outside ``dest``."""
    with zipfile.ZipFile(zip_path, "r") as zf:
        for name in zf.namelist():
            target = (dest / name).resolve()
            if not str(target).startswith(str(dest.resolve())):
                raise ValueError(f"zip_path_traversal: {name}")
        zf.extractall(dest)


def _find_data_yaml(root: Path) -> Path:
    """Find ``data.yaml`` either at root or one level deep (zips often have
    a single top-level dir)."""
    direct = root / "data.yaml"
    if direct.is_file():
        return direct
    for sub in root.iterdir():
        if sub.is_dir() and (sub / "data.yaml").is_file():
            return sub / "data.yaml"
    raise ValueError("data_yaml_not_found")


def _xxh3_128_of_file(path: Path) -> str:
    import xxhash  # type: ignore[import-not-found]

    h = xxhash.xxh3_128()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _build_minio_client():
    """Build a boto3 S3 client from env. Mirrors the api's MinioClient init.

    Reads ``MINIO_ENDPOINT``, ``MINIO_ROOT_USER``, ``MINIO_ROOT_PASSWORD``,
    ``MINIO_BUCKET``. Raises a 502 to the caller via the wrapping handler if
    any are unset.
    """
    import boto3  # type: ignore[import-not-found]
    from botocore.client import Config  # type: ignore[import-not-found]

    endpoint = os.environ["MINIO_ENDPOINT"]
    access = os.environ["MINIO_ROOT_USER"]
    secret = os.environ["MINIO_ROOT_PASSWORD"]
    bucket = os.environ["MINIO_BUCKET"]
    s3 = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access,
        aws_secret_access_key=secret,
        config=Config(signature_version="s3v4"),
        region_name="us-east-1",
    )
    return s3, bucket


def _upload_pt_to_minio(pt_path: Path, key: str) -> str:
    """Upload ``pt_path`` to MinIO at ``key`` and return an internal-presigned
    GET URL valid for 1 hour."""
    s3, bucket = _build_minio_client()
    with open(pt_path, "rb") as fh:
        s3.put_object(
            Bucket=bucket,
            Key=key,
            Body=fh.read(),
            ContentType="application/octet-stream",
        )
    return s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": bucket, "Key": key},
        ExpiresIn=3600,
    )


def _resolve_base_checkpoint(weight_id_base: str | None) -> str:
    """Resolve the base checkpoint path for training.

    When ``weight_id_base`` is given, look it up in the LRU registry (the
    api typically /yolo/load's it before calling /yolo/train). When missing
    or absent, fall back to ``yolov8n.pt`` so Ultralytics auto-downloads it
    in the trainer's CWD.
    """
    if weight_id_base:
        loaded = REGISTRY.get(weight_id_base)
        if loaded is not None:
            ckpt_path = getattr(loaded, "ckpt_path", None) or getattr(
                getattr(loaded, "ckpt", None), "path", None
            )
            if ckpt_path and Path(str(ckpt_path)).is_file():
                return str(ckpt_path)
    return "yolov8n.pt"


def _find_best_pt(runs_root: Path) -> Path:
    """Locate ``best.pt`` under Ultralytics' ``runs/.../weights/`` layout."""
    candidates = list(runs_root.rglob("best.pt"))
    if not candidates:
        raise ValueError("best_pt_not_found")
    # Most-recently modified wins (handles repeated train calls in the same dir).
    candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return candidates[0]


# Indirection so tests can replace the heavy ultralytics call with a stub.
def _run_train(
    base_path: str,
    data_yaml: Path,
    *,
    epochs: int,
    imgsz: int,
    device: str,
    project: Path,
) -> dict[str, Any]:
    """Run ultralytics training and return the metrics dict."""
    from ultralytics import YOLO  # type: ignore[import-not-found]

    model = YOLO(base_path)
    results = model.train(
        data=str(data_yaml),
        epochs=epochs,
        imgsz=imgsz,
        device=device,
        project=str(project),
    )
    metrics: dict[str, Any] = {}
    raw = getattr(results, "results_dict", None)
    if isinstance(raw, dict):
        # Coerce numpy/Tensor scalars to plain floats so JSON serialises cleanly.
        for k, v in raw.items():
            try:
                metrics[str(k)] = float(v)
            except (TypeError, ValueError):
                metrics[str(k)] = str(v)
    return metrics


@router.post("/train", response_model=TrainOut)
def train_weight(payload: TrainIn) -> TrainOut:
    _validate_imgsz(payload.imgsz)

    workdir = Path(tempfile.mkdtemp(prefix="yolo-train-"))
    try:
        # 1. Download dataset zip
        zip_path = workdir / "dataset.zip"
        try:
            _download_dataset(payload.dataset_zip_url, zip_path)
        except Exception as exc:  # noqa: BLE001
            log.exception("yolo_train: dataset download failed")
            raise HTTPException(
                status_code=502, detail=f"dataset_download_failed: {exc}"
            ) from exc

        # 2. Extract
        dataset_root = workdir / "dataset"
        dataset_root.mkdir(parents=True, exist_ok=True)
        try:
            _extract_zip(zip_path, dataset_root)
            data_yaml = _find_data_yaml(dataset_root)
        except Exception as exc:  # noqa: BLE001
            log.exception("yolo_train: dataset extract failed")
            raise HTTPException(
                status_code=502, detail=f"dataset_extract_failed: {exc}"
            ) from exc

        # 3. Resolve base checkpoint
        base_path = _resolve_base_checkpoint(payload.weight_id_base)

        # 4. Train
        runs_root = workdir / "runs"
        try:
            metrics = _run_train(
                base_path,
                data_yaml,
                epochs=payload.epochs,
                imgsz=payload.imgsz,
                device=payload.device,
                project=runs_root,
            )
        except Exception as exc:  # noqa: BLE001
            log.exception("yolo_train: training failed")
            raise HTTPException(
                status_code=502, detail=f"train_failed: {exc}"
            ) from exc

        # 5. Locate best.pt
        try:
            best_pt = _find_best_pt(runs_root)
        except Exception as exc:  # noqa: BLE001
            log.exception("yolo_train: best.pt missing after train")
            raise HTTPException(
                status_code=502, detail=f"best_pt_missing: {exc}"
            ) from exc

        # 6. Hash + upload to MinIO
        try:
            xxh = _xxh3_128_of_file(best_pt)
            size_bytes = best_pt.stat().st_size
            new_weight_id = uuid.uuid4().hex  # 32-char hex
            key = f"weights/{xxh}/{new_weight_id}.pt"
            weights_url = _upload_pt_to_minio(best_pt, key)
        except Exception as exc:  # noqa: BLE001
            log.exception("yolo_train: minio upload failed")
            raise HTTPException(
                status_code=502, detail=f"minio_upload_failed: {exc}"
            ) from exc

        return TrainOut(
            weight_id=new_weight_id,
            weights_url=weights_url,
            xxh3_128=xxh,
            size_bytes=size_bytes,
            metrics=metrics,
        )
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
