# Plan 05 — YOLO Auto-Annotate + SAM Smart Annotation

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Wire the GPU model service so users can (a) upload custom YOLO `.pt` weights and run them on a single image or a whole task, and (b) use SAM (2.1 by default; 3 admin-toggle) for click-to-mask interactive segmentation. Includes a basic SAM video tracker.

**Architecture:**
- `apps/model` exposes `/yolo/load`, `/yolo/predict`, `/sam/encode`, `/sam/decode`, `/sam-track/*`.
- `apps/api` exposes `/projects/{pid}/weights`, `/assets/{id}/auto-annotate`, `/tasks/{id}/auto-annotate`, `/assets/{id}/sam/encode`, `/assets/{id}/sam/decode`, `/assets/{id}/sam-track/*`.
- VRAM budget on a 4070 (16 GB): SAM 2.1 Hiera-L (~3-4 GB) + one YOLO model (~140 MB-2 GB) co-resident.

---

## Series context
- ✅ Plans 01–04 shipped
- **Plan 05 — YOLO + SAM** ← *this plan*
- Plan 06 — Annotation import/export
- Plan 07 — Analytics
- Plan 08 — Polish

---

## Task 1: Model service deps + Dockerfile (CUDA, Torch, Ultralytics, SAM 2)

**Files:** modify `apps/model/pyproject.toml`; modify `apps/model/Dockerfile`; new `apps/model/src/carve_model/gpu.py`.

**Step 1.1 — `apps/model/pyproject.toml [project].dependencies`:**

```toml
"fastapi==0.115.6",
"uvicorn[standard]==0.34.0",
"pydantic==2.10.4",
"pydantic-settings==2.7.0",
"torch==2.7.1",
"torchvision==0.22.1",
"ultralytics==8.3.55",
"Pillow==11.1.0",
"numpy==2.2.1",
"boto3==1.36.5",
"redis==5.2.0",
"xxhash==3.5.0",
"opencv-python-headless==4.10.0.84",
"pycocotools==2.0.8",
"httpx==0.28.1",
```

**Step 1.2 — `apps/model/Dockerfile`** (replace):

```dockerfile
# syntax=docker/dockerfile:1.7
FROM nvidia/cuda:12.6.0-cudnn-runtime-ubuntu22.04
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.12 python3.12-venv python3.12-dev python3-pip git ffmpeg libgl1 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml ./
RUN pip3 install --no-cache-dir -e .
RUN pip3 install --no-cache-dir git+https://github.com/facebookresearch/sam2.git
COPY src ./src
ENV PYTHONPATH=/app/src
EXPOSE 8100
CMD ["uvicorn", "carve_model.main:app", "--host", "0.0.0.0", "--port", "8100"]
```

In `docker-compose.yml` set:

```yaml
  model:
    build: ./apps/model
    runtime: nvidia
    deploy:
      resources:
        reservations:
          devices: [{ driver: nvidia, count: 1, capabilities: [gpu] }]
```

(Behind a `gpu` profile so `docker compose --profile gpu up` enables it.)

**Step 1.3 — `gpu.py`:**

```python
import torch


def get_device() -> torch.device:
    return torch.device("cuda:0" if torch.cuda.is_available() else "cpu")


def vram_free_mb() -> int:
    if not torch.cuda.is_available():
        return 0
    free, _ = torch.cuda.mem_get_info()
    return int(free // (1024 * 1024))
```

**Step 1.4 — Tests** stub-import the module; mark GPU paths with `pytest.mark.gpu`.

**Step 1.5 — Commit:** `feat(model): CUDA Dockerfile + Torch+Ultralytics+SAM2 deps`

---

## Task 2: YOLO weight LRU registry

**Files:** `apps/model/src/carve_model/yolo/{__init__,registry,predict}.py`; tests.

**Step 2.1 — `registry.py`:**

```python
import threading
from collections import OrderedDict
from pathlib import Path

from ultralytics import YOLO


class WeightRegistry:
    def __init__(self, capacity: int = 2) -> None:
        self._capacity = capacity
        self._cache: OrderedDict[str, YOLO] = OrderedDict()
        self._lock = threading.Lock()

    def load(self, key: str, weights_path: Path) -> YOLO:
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                return self._cache[key]
            model = YOLO(str(weights_path))
            self._cache[key] = model
            while len(self._cache) > self._capacity:
                self._cache.popitem(last=False)
            return model

    def get(self, key: str) -> YOLO | None:
        with self._lock:
            return self._cache.get(key)


REGISTRY = WeightRegistry(capacity=2)
```

**Step 2.2 — `predict.py`:**

```python
import io

import numpy as np
from PIL import Image
from ultralytics import YOLO


def predict_image(model: YOLO, image_bytes: bytes, conf: float = 0.25, iou: float = 0.7) -> dict:
    img = np.array(Image.open(io.BytesIO(image_bytes)).convert("RGB"))
    results = model.predict(img, conf=conf, iou=iou, verbose=False)[0]
    detections: list[dict] = []
    polygons: list[dict] = []
    if results.boxes is not None:
        names = results.names
        xyxy = results.boxes.xyxy.cpu().numpy()
        confs = results.boxes.conf.cpu().numpy()
        cls = results.boxes.cls.cpu().numpy().astype(int)
        for (x1, y1, x2, y2), c, k in zip(xyxy, confs, cls, strict=True):
            detections.append({
                "class_name": names[int(k)],
                "confidence": float(c),
                "bbox": {"x": float(x1), "y": float(y1), "w": float(x2 - x1), "h": float(y2 - y1)},
            })
        if getattr(results, "masks", None) is not None and results.masks.xy is not None:
            for poly, k, c in zip(results.masks.xy, cls, confs, strict=True):
                polygons.append({
                    "class_name": names[int(k)],
                    "confidence": float(c),
                    "points": [[float(p[0]), float(p[1])] for p in poly],
                })
    return {"detections": detections, "polygons": polygons}
```

**Step 2.3 — Tests:** with a fake `YOLO` (monkeypatched class) returning a fixed prediction object; assert the dict shape.

**Step 2.4 — Commit:** `feat(model): YOLO weight LRU registry + predict_image helper`

---

## Task 3: Model service /yolo/load + /yolo/predict

**Files:** `apps/model/src/carve_model/yolo/router.py`; modify `apps/model/src/carve_model/main.py`; tests.

**Step 3.1 — `yolo/router.py`:**

```python
import base64
from pathlib import Path
from tempfile import NamedTemporaryFile

import urllib.request
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from carve_model.yolo.predict import predict_image
from carve_model.yolo.registry import REGISTRY

router = APIRouter(prefix="/yolo", tags=["yolo"])


class LoadIn(BaseModel):
    weight_id: str
    weights_url: str


class PredictIn(BaseModel):
    weight_id: str
    image_b64: str
    conf: float = 0.25
    iou: float = 0.7


@router.post("/load")
async def load_weight(payload: LoadIn) -> dict:
    with NamedTemporaryFile(suffix=".pt", delete=False) as fh:
        urllib.request.urlretrieve(payload.weights_url, fh.name)
        path = Path(fh.name)
    REGISTRY.load(payload.weight_id, path)
    return {"loaded": payload.weight_id}


@router.post("/predict")
async def predict(payload: PredictIn) -> dict:
    model = REGISTRY.get(payload.weight_id)
    if model is None:
        raise HTTPException(status_code=409, detail="weight_not_loaded")
    return predict_image(model, base64.b64decode(payload.image_b64), conf=payload.conf, iou=payload.iou)
```

**Step 3.2 — `main.py`** mounts `yolo_router` and updates `/capabilities`:

```python
from carve_model.yolo.router import router as yolo_router
from carve_model.gpu import get_device

@app.get("/capabilities")
def capabilities() -> dict:
    return {
        "models": ["yolo"],
        "device": str(get_device()),
    }

app.include_router(yolo_router)
```

**Step 3.3 — Tests** mock `REGISTRY.get` to return a fake model; assert `/yolo/predict` returns `{"detections": [...]}`.

**Step 3.4 — Commit:** `feat(model): /yolo/load + /yolo/predict endpoints`

---

## Task 4: App-side `Weight` model + endpoints

**Files:** `apps/api/src/carve_api/weights/{__init__,models,schemas,service,router}.py`; `apps/api/alembic/versions/0005_weights.py`; modify `main.py` and `alembic/env.py`.

**Step 4.1 — `models.py`:**

```python
import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from carve_api.db import Base


class Weight(Base):
    __tablename__ = "weights"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    task_kind: Mapped[str] = mapped_column(String(20), nullable=False)  # detect | segment | classify | pose
    minio_key: Mapped[str] = mapped_column(String(255), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    class_names: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
```

**Step 4.2 — Migration 0005** creates `weights` table with index on `project_id`. Revision `0005`, down_revision `0004`.

**Step 4.3 — Service & router** with endpoints:
- `POST /projects/{pid}/weights` — multipart `.pt` upload. Validate file by spawning a constrained subprocess that does `torch.load(weights_only=True)` + `YOLO(...)` and emits the class_names dict. Reject if loading fails. Save to MinIO at `weights/<xxh3>/<weight_id>.pt`. Owner-or-admin only.
- `GET /projects/{pid}/weights` — list.
- `DELETE /weights/{wid}` — owner-or-admin only.

**Step 4.4 — Tests** with a tiny fake `.pt` (use `YOLO("yolo11n.pt").save("/tmp/w.pt")` in a fixture, or skip if Ultralytics not in API venv). Mock MinIO.

**Step 4.5 — Commit:** `feat(api): weight upload/list/delete with Ultralytics validation`

---

## Task 5: Auto-annotate single image

**Files:** `apps/api/src/carve_api/annotations/router.py` (extend); `apps/api/src/carve_api/jobs/autoannotate.py` (helpers).

**Step 5.1 — Endpoint:**

```python
@router.post("/assets/{asset_id}/auto-annotate", response_model=list[AnnotationOut])
async def auto_annotate_asset(
    asset_id: uuid.UUID,
    weight_id: uuid.UUID,
    overwrite: bool = False,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[AnnotationOut]:
    # Fetch asset + weight, ensure weight is in the same project
    # POST to model:/yolo/load (idempotent) and /yolo/predict with the asset's bytes
    # Map class_name -> class_id (case-insensitive); skip predictions for unmapped names
    # If overwrite, delete existing annotations for this frame first
    # Insert new annotation rows
    ...
```

**Step 5.2 — Tests** mock the model service via `httpx.MockTransport` returning 2 detections; assert 2 `Annotation` rows created.

**Step 5.3 — Commit:** `feat(api): single-image auto-annotate via model service`

---

## Task 6: Batch auto-annotate (RQ job + progress)

**Files:** `apps/api/src/carve_api/jobs/autoannotate.py`; modify `annotations/router.py`.

**Step 6.1 — RQ job iterates assets, calls predict per asset, persists annotations, updates progress.**
- Progress key: `aa:job:<rq_id>` Redis hash with `done`, `total`, `failed` fields.

**Step 6.2 — Endpoints:**
- `POST /tasks/{tid}/auto-annotate?weight_id=<wid>&overwrite=false` returns `{"job_id": "<rq>"}`.
- `GET /tasks/{tid}/auto-annotate/{job_id}` returns `{done, total, failed, status}`.

**Step 6.3 — Web UI:** task page button "Auto-annotate" opens a modal with a weight picker + Overwrite toggle; shows a progress bar polling the GET endpoint every 1s.

**Step 6.4 — Commit:** `feat(api,web): batch auto-annotate RQ job with progress polling`

---

## Task 7: SAM 2 — model loader + encode/decode endpoints

**Files:** `apps/model/src/carve_model/sam/{__init__,model,router}.py`; modify `main.py`.

**Step 7.1 — `model.py`:**

```python
from io import BytesIO

import numpy as np
import torch
import xxhash
from PIL import Image
from pycocotools import mask as cocomask
from sam2.sam2_image_predictor import SAM2ImagePredictor

_PREDICTOR = None
_LAST_HASH: str | None = None  # the predictor is single-instance, so we track which image is loaded


def _ensure() -> SAM2ImagePredictor:
    global _PREDICTOR
    if _PREDICTOR is None:
        p = SAM2ImagePredictor.from_pretrained("facebook/sam2-hiera-large")
        p.model.to("cuda" if torch.cuda.is_available() else "cpu")
        _PREDICTOR = p
    return _PREDICTOR


def encode_image(image_bytes: bytes) -> tuple[str, list[int]]:
    global _LAST_HASH
    h = xxhash.xxh3_128(image_bytes).hexdigest()
    img = np.array(Image.open(BytesIO(image_bytes)).convert("RGB"))
    p = _ensure()
    p.set_image(img)
    _LAST_HASH = h
    return h, list(img.shape[:2])  # (H, W)


def decode(image_hash: str, points: list[list[int]], labels: list[int]) -> dict:
    p = _ensure()
    if _LAST_HASH != image_hash:
        raise KeyError("embedding_not_loaded; call /sam/encode again")
    pts = np.array(points)
    lbl = np.array(labels)
    masks, scores, _ = p.predict(point_coords=pts, point_labels=lbl, multimask_output=True)
    best = int(np.argmax(scores))
    rle = cocomask.encode(np.asfortranarray(masks[best].astype("uint8")))
    return {"counts": rle["counts"].decode("ascii"), "size": list(rle["size"]), "score": float(scores[best])}
```

**Note on sticky predictor:** SAM 2's `SAM2ImagePredictor` keeps the encoded embedding in the model instance, so you'd lose it if a different request encodes another image. v1 simplification: serialize SAM requests per-process; for higher throughput, run multiple model service replicas with sticky session routing in v2.

**Step 7.2 — `router.py`:**

```python
import base64

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from carve_model.sam.model import decode, encode_image

router = APIRouter(prefix="/sam", tags=["sam"])


class EncodeIn(BaseModel):
    image_b64: str


class DecodeIn(BaseModel):
    image_hash: str
    points: list[list[int]]
    labels: list[int]


@router.post("/encode")
async def encode(payload: EncodeIn) -> dict:
    h, shape = encode_image(base64.b64decode(payload.image_b64))
    return {"image_hash": h, "shape": shape}


@router.post("/decode")
async def decode_endpoint(payload: DecodeIn) -> dict:
    try:
        return decode(payload.image_hash, payload.points, payload.labels)
    except KeyError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
```

**Step 7.3 — Tests** mark `--gpu`; CI default skip.

**Step 7.4 — Commit:** `feat(model): SAM 2 encode/decode + image-hash sticky cache`

---

## Task 8: App-side SAM proxy + web SAM tool

**Files:** `apps/api/src/carve_api/sam/{__init__,router}.py`; modify `main.py`. Web: `apps/web/src/canvas/tools/SamTool.ts`; modify Toolbar (add Magic-wand button, hotkey `S`).

**Step 8.1 — API proxy:** for `POST /assets/{asset_id}/sam/encode`, fetch asset bytes from MinIO, b64-encode, POST to `model:/sam/encode`, return `{image_hash, shape}`. For `/decode`, accept `{image_hash, points, labels}` and forward.

**Step 8.2 — `SamTool.ts`:**
- On activation, call `/assets/{id}/sam/encode` once; store `image_hash` + `shape`.
- Each click POST `/sam/decode` with cumulative points + labels (left=1 positive, right=0 negative). Render the returned mask outline as a hover preview (golden-yellow).
- `Enter` commits — decode the RLE to a polygon (Douglas-Peucker simplification, epsilon configurable) and push as a `polygon` annotation. `Esc` cancels.
- Auto-apply mode toggle (default off): commit on each click.

**Step 8.3 — Tests** mock `/sam/encode` and `/sam/decode`; simulate two clicks; assert decode is called with `[[x,y],[x',y']]` and `[1,1]`.

**Step 8.4 — Commit:** `feat(web,api): SAM click-to-mask tool + API proxy`

---

## Task 9: SAM 2 video tracker (forward propagation)

**Files:** `apps/model/src/carve_model/sam/{tracker,track_router}.py`; `apps/api/src/carve_api/sam/track_router.py`; web `tools/TrackPropagateTool.ts`.

**Step 9.1 — Tracker:** wraps `SAM2VideoPredictor`. Sessions keyed by `(asset_id, user_id)`. State held in process memory; the session is sticky to one model worker.
- `POST /sam-track/start` receives `(asset_id, frame_idx, points, labels, video_path_hint)`; initializes the predictor; returns `{session: <uuid>}`.
- `POST /sam-track/{session}/step?frames=N` advances N frames; returns `[{frame_idx, counts, size}]`.

**Step 9.2 — App API proxies:** `POST /assets/{id}/sam-track/start` and `POST /assets/{id}/sam-track/{session}/step?frames=N`.

**Step 9.3 — Web `TrackPropagateTool.ts`:** user clicks the object on frame 0 → "Track →" steps frames; the tool overlays the mask outline on each frame thumbnail in the timeline. "Confirm" converts each frame's mask into a polygon annotation linked by a single new `track_id` UUID generated client-side.

**Step 9.4 — Commit:** `feat(model,api,web): SAM 2 video tracker with sticky session`

---

## Task 10: Tag

```bash
git tag -a v0.5.0-inference -m "Plan 05 complete: YOLO auto-annotate + SAM smart annotation + video tracker"
```

---

## Self-Review

| Spec § | Implemented |
|---|---|
| §9.1 Custom YOLO single + batch | Tasks 4–6 |
| §9.2 SAM click mode | Tasks 7–8 |
| §9.4 Tracking forward across frames | Task 9 |
| §7 Inference strategy on 4070 | Tasks 1, 2, 7 |
| §17 Pickle safety | Task 4 |

Out of scope (deferred):
- SAM 3 text-prompt (PCS) → Plan 08
- In-browser ONNX/WebGPU SAM decoder → Plan 08
- SAM tracker memory persistence to Redis → v2

**Type consistency:** SAM RLE shapes match the `mask` annotation `geometry` from Plan 04 (`{kind:"mask",size:[h,w],counts:"…"}`).
