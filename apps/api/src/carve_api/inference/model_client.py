# Armin Mehri — mehri.armin@gmail.com
"""Synchronous HTTP client for the model service.

We use sync httpx (not async) because FastAPI route handlers run in a thread
pool when the function is plain ``def``, and our service calls are short
enough that a sync round-trip per call is fine. This keeps the wiring simple
and tests trivial via ``httpx.MockTransport``.
"""

import json
from contextlib import contextmanager
from typing import Any, Iterator

import httpx

from carve_api.config import get_settings


class ModelServiceError(Exception):
    """Raised when the model service returns a non-2xx status.

    A ``status_code`` of ``503`` with body ``{"error":
    "model_service_unreachable", ...}`` is reserved for the case where the
    model service hostname doesn't resolve / connection refuses / read times
    out — i.e. the model service itself is down. The carve api translates
    that into a 503 so users see "the model service is offline" rather than
    a generic 500.
    """

    def __init__(self, status_code: int, body: Any) -> None:
        self.status_code = status_code
        self.body = body
        super().__init__(f"model service returned {status_code}: {body!r}")


# httpx exceptions that mean "we never got a real HTTP response from the
# model service" — DNS failure, connection refused, connect/read timeout.
# Treat these as a 503 (Service Unavailable) signalling that the model
# service is offline rather than a 5xx from inside the model service.
_UNREACHABLE_EXCEPTIONS: tuple[type[Exception], ...] = (
    httpx.ConnectError,
    httpx.ConnectTimeout,
    httpx.ReadTimeout,
)


@contextmanager
def _wrap_unreachable(label: str) -> Iterator[None]:
    """Translate connection-level failures into a 503 ModelServiceError.

    The model service is opt-in via the ``inference`` docker-compose profile.
    When it's not running, the api previously raised raw ``httpx.ConnectError``
    which FastAPI converted to a 500 — masking the real cause from operators
    and confusing the SAM tool's UI. We now re-raise as a structured 503 so
    callers (sam.py / sam_track.py / autoannotate.py adapters) can map it to
    a clear ``model_service_unreachable`` user-facing error.
    """
    try:
        yield
    except _UNREACHABLE_EXCEPTIONS as exc:
        raise ModelServiceError(
            503,
            {
                "error": "model_service_unreachable",
                "detail": f"{label}: {exc.__class__.__name__}: {exc}",
            },
        ) from exc


def _build_client() -> httpx.Client:
    s = get_settings()
    return httpx.Client(
        base_url=s.model_base_url,
        timeout=s.model_timeout_seconds,
    )


# Hook for tests to swap the transport without monkeypatching base_url
_TEST_TRANSPORT: httpx.BaseTransport | None = None


def set_test_transport(transport: httpx.BaseTransport | None) -> None:
    global _TEST_TRANSPORT
    _TEST_TRANSPORT = transport


def _client() -> httpx.Client:
    s = get_settings()
    if _TEST_TRANSPORT is not None:
        return httpx.Client(
            base_url=s.model_base_url,
            timeout=s.model_timeout_seconds,
            transport=_TEST_TRANSPORT,
        )
    return _build_client()


def yolo_load(weight_id: str, weights_url: str) -> dict:
    with _wrap_unreachable("yolo_load"), _client() as c:
        r = c.post("/yolo/load", json={"weight_id": weight_id, "weights_url": weights_url})
        if r.status_code >= 400:
            raise ModelServiceError(r.status_code, _safe_json(r))
        return r.json()


def yolo_predict(weight_id: str, image_b64: str, *, conf: float = 0.25, iou: float = 0.7) -> dict:
    with _wrap_unreachable("yolo_predict"), _client() as c:
        r = c.post(
            "/yolo/predict",
            json={"weight_id": weight_id, "image_b64": image_b64, "conf": conf, "iou": iou},
        )
        if r.status_code >= 400:
            raise ModelServiceError(r.status_code, _safe_json(r))
        return r.json()


def yolo_train(
    *,
    weight_id_base: str | None,
    dataset_zip_url: str,
    epochs: int,
    imgsz: int,
    device: str = "auto",
) -> dict:
    """POST /yolo/train — plan-09 task-05 active-learning retrain.

    Returns ``{weight_id, weights_url, xxh3_128, size_bytes, metrics}``.
    The model service handles the dataset download, training, hashing and
    MinIO upload; the api just registers a new ``Weight`` row pointing at
    the produced object.

    Training can take a long time — callers must run this from an RQ worker
    (the retrain RQ job does that). We pass ``timeout=None`` so the request
    is bounded only by the model service's own training duration.
    """
    body: dict = {
        "weight_id_base": weight_id_base,
        "dataset_zip_url": dataset_zip_url,
        "epochs": int(epochs),
        "imgsz": int(imgsz),
        "device": device,
    }
    with _wrap_unreachable("yolo_train"), _client() as c:
        try:
            r = c.post("/yolo/train", json=body, timeout=None)
        except TypeError:
            r = c.post("/yolo/train", json=body)
        if r.status_code >= 400:
            raise ModelServiceError(r.status_code, _safe_json(r))
        return r.json()


def yolo_inspect(file_bytes: bytes, *, filename: str = "weight.pt") -> dict:
    """POST /yolo/inspect — returns ``{class_names: [...], task_kind: "..."}``.

    Used by ``WeightService.upload`` to populate ``Weight.class_names`` from
    the actual checkpoint instead of trusting the form-supplied ``[]``. The
    model service runs torch.load — keeping that off the api container is
    the entire point of delegating here.
    """
    with _wrap_unreachable("yolo_inspect"), _client() as c:
        r = c.post(
            "/yolo/inspect",
            files={"file": (filename, file_bytes, "application/octet-stream")},
        )
        if r.status_code >= 400:
            raise ModelServiceError(r.status_code, _safe_json(r))
        return r.json()


def sam_encode(image_b64: str) -> dict:
    """POST /sam/encode — returns {image_hash, shape}."""
    with _wrap_unreachable("sam_encode"), _client() as c:
        r = c.post("/sam/encode", json={"image_b64": image_b64})
        if r.status_code >= 400:
            raise ModelServiceError(r.status_code, _safe_json(r))
        return r.json()


def sam_decode(
    image_hash: str,
    points: list[list[int]],
    labels: list[int],
    box: list[float] | None = None,
    *,
    epsilon_factor: float | None = None,
) -> dict:
    """POST /sam/decode — returns {counts, size, score, polygon}.

    v3.8 Phase 2 — optional ``box`` (xyxy) is forwarded to the model
    service so the editor's BBox-then-refine flow uses a single decode
    per click via the embedding cache instead of the SAM 3-only
    /sam/box-prompt round-trip.

    v3.22 — ``epsilon_factor`` is the Douglas-Peucker tolerance for
    polygon simplification, mapped from the editor's "Polygon
    approximation points" slider. ``None`` lets the model service use
    its default. Higher slider position → smaller epsilon → more
    polygon vertices → faithful contours.
    """
    body: dict[str, object] = {
        "image_hash": image_hash,
        "points": points,
        "labels": labels,
    }
    if box is not None:
        body["box"] = box
    if epsilon_factor is not None:
        body["epsilon_factor"] = float(epsilon_factor)
    with _wrap_unreachable("sam_decode"), _client() as c:
        r = c.post("/sam/decode", json=body)
        if r.status_code >= 400:
            raise ModelServiceError(r.status_code, _safe_json(r))
        return r.json()


def sam_text_prompt(
    image_b64: str,
    text: str,
    *,
    use_vlm_fo1: bool = False,
    threshold: float | None = None,
    epsilon_factor: float | None = None,
) -> list[dict]:
    """POST /sam/text-prompt — SAM 3 only.

    Returns a list of candidate masks for the supplied text concept.
    The model service answers 409 ``sam3_not_enabled`` when the configured
    SAM model is not SAM 3 (we re-raise as a 409 ModelServiceError so the
    proxy maps it to a UI-friendly response). 503 means the predictor
    factory hasn't been registered yet.

    v3.21+ — ``use_vlm_fo1`` opts into the VLM-FO1 precision filter.

    ``threshold`` (0..1) controls the SAM 3 instance-segmentation
    confidence floor — propagated all the way to the model's
    post_process_instance_segmentation. Without it, the predictor
    silently hardcoded 0.5, so the user-side score gate (applied later
    in auto_text_for_asset) saw nothing below 0.5 even when set lower.
    Both kwargs are forwarded only when supplied so older model service
    deployments that pre-date them keep working unchanged.
    """
    body: dict = {"image_b64": image_b64, "text": text}
    if use_vlm_fo1:
        body["use_vlm_fo1"] = True
    if threshold is not None:
        body["threshold"] = float(threshold)
    if epsilon_factor is not None:
        body["epsilon_factor"] = float(epsilon_factor)
    with _wrap_unreachable("sam_text_prompt"), _client() as c:
        r = c.post("/sam/text-prompt", json=body)
        if r.status_code >= 400:
            raise ModelServiceError(r.status_code, _safe_json(r))
        return r.json()


def sam_visual_prompt(
    *,
    refer_b64: str,
    regions: list[dict],
    target_b64: str,
    threshold: float | None = None,
    text_hint: str | None = None,
    epsilon_factor: float | None = None,
) -> list[dict]:
    """POST /sam/visual-prompt — SAM 3.1 cosine-similarity visual prompt.

    v3.28 — replaces the broken raw-FPN-features-into-prompt-slot path
    with a similarity heatmap + SAM box-prompt refine pipeline. The user
    threshold is now the cosine-similarity floor (0..1), not a normalised
    score, so the model can return EMPTY when nothing similar is found
    instead of forcing low-confidence FPs.

    The model service answers 409 ``sam3p1_not_enabled`` when SAM 3.1
    native isn't the active variant, 422 ``mixed_ref_types`` when regions
    mix bbox and polygon kinds, and 503 ``sam_visual_predictor_not_loaded``
    when the predictor factory isn't registered yet.
    """
    body: dict = {
        "refer_b64": refer_b64,
        "regions": regions,
        "target_b64": target_b64,
    }
    if threshold is not None:
        body["threshold"] = float(threshold)
    if text_hint:
        body["text_hint"] = str(text_hint)
    if epsilon_factor is not None:
        body["epsilon_factor"] = float(epsilon_factor)
    with _wrap_unreachable("sam_visual_prompt"), _client() as c:
        r = c.post("/sam/visual-prompt", json=body)
        if r.status_code >= 400:
            raise ModelServiceError(r.status_code, _safe_json(r))
        return r.json()


# ---------------------------------------------------------------------------
# YOLOE — Real-Time Seeing Anything (v3.23). Three predict modes (text,
# visual, prompt-free) + a status probe + best-effort unload. Mirrors the
# error-mapping conventions of the YOLO/SAM helpers above: 503 means the
# model service is unreachable, 4xx/5xx surface as ``ModelServiceError``.
# ---------------------------------------------------------------------------


def yoloe_status() -> dict:
    """GET /yoloe/status — capability probe.

    Returns ``{"available": False, ...}`` when the model service is
    reachable but YOLOE checkpoints aren't on disk. Raises
    ``ModelServiceError(503)`` only when the model service itself is
    unreachable, so callers can treat "yoloe disabled" and "model
    service offline" distinctly.
    """
    with _wrap_unreachable("yoloe_status"), _client() as c:
        r = c.get("/yoloe/status")
        if r.status_code >= 400:
            raise ModelServiceError(r.status_code, _safe_json(r))
        return r.json()


def yoloe_text_predict(
    image_b64: str,
    classes: list[str],
    *,
    conf: float = 0.25,
    iou: float = 0.7,
) -> dict:
    """POST /yoloe/text-predict — open-vocabulary detection + segmentation.

    ``classes`` is the user-typed class list (e.g. ``["person", "bus"]``).
    Returns ``{detections, polygons}`` matching the YOLO predict shape so
    downstream class-mapping is reused.
    """
    body = {
        "image_b64": image_b64,
        "classes": classes,
        "conf": float(conf),
        "iou": float(iou),
    }
    with _wrap_unreachable("yoloe_text_predict"), _client() as c:
        r = c.post("/yoloe/text-predict", json=body)
        if r.status_code >= 400:
            raise ModelServiceError(r.status_code, _safe_json(r))
        return r.json()


def yoloe_visual_predict(
    target_b64: str,
    refer_b64: str,
    bboxes: list[list[float]],
    cls_indices: list[int],
    class_names: list[str],
    *,
    conf: float = 0.25,
    iou: float = 0.7,
) -> dict:
    """POST /yoloe/visual-predict — reference-image visual prompting."""
    body = {
        "target_b64": target_b64,
        "refer_b64": refer_b64,
        "bboxes": bboxes,
        "cls": cls_indices,
        "class_names": class_names,
        "conf": float(conf),
        "iou": float(iou),
    }
    with _wrap_unreachable("yoloe_visual_predict"), _client() as c:
        r = c.post("/yoloe/visual-predict", json=body)
        if r.status_code >= 400:
            raise ModelServiceError(r.status_code, _safe_json(r))
        return r.json()


def yoloe_prompt_free_predict(
    image_b64: str,
    *,
    conf: float = 0.25,
    iou: float = 0.7,
    max_detections: int | None = None,
) -> dict:
    """POST /yoloe/prompt-free-predict — internal-vocabulary discovery."""
    body: dict = {
        "image_b64": image_b64,
        "conf": float(conf),
        "iou": float(iou),
    }
    if max_detections is not None:
        body["max_detections"] = int(max_detections)
    with _wrap_unreachable("yoloe_prompt_free_predict"), _client() as c:
        r = c.post("/yoloe/prompt-free-predict", json=body)
        if r.status_code >= 400:
            raise ModelServiceError(r.status_code, _safe_json(r))
        return r.json()


def yoloe_unload() -> dict:
    """POST /yoloe/unload — best-effort, never raises."""
    try:
        with _client() as c:
            r = c.post("/yoloe/unload")
            if r.status_code >= 400:
                return {"evicted": []}
            return r.json()
    except Exception:  # noqa: BLE001 — best-effort cleanup, never propagate
        return {"evicted": []}


def sam_unload(which: str = "all") -> dict:
    """POST /sam/unload — best-effort, never raises.

    Frees SAM models (image predictor + tracker sessions) on the model
    service. ``which`` is "image", "tracker", or "all". Used by the
    System page's "Unload all models" button. Returns the model
    service's response dict (empty on error so callers can still
    inspect a uniform shape).
    """
    try:
        with _client() as c:
            r = c.post("/sam/unload", json={"which": which})
            if r.status_code >= 400:
                return {"evicted": [], "sessions_released": 0}
            return r.json()
    except Exception:  # noqa: BLE001 — best-effort cleanup, never propagate
        return {"evicted": [], "sessions_released": 0}


def sam_vlm_fo1_unload() -> bool:
    """POST /sam/vlm-fo1/unload — best-effort, never raises.

    The API worker calls this at the end of an auto-annotate batch (or
    after a single-asset run that opted into FO1) so the FO1 sidecar
    drops its ~6 GB of GPU weights. Returns True when the sidecar
    actually evicted, False on no-op or any error.
    """
    return bool(sam_vlm_fo1_unload_detailed().get("evicted"))


def sam_vlm_fo1_unload_detailed() -> dict:
    """POST /sam/vlm-fo1/unload — best-effort, never raises.

    Returns the full response shape ``{"evicted": bool, "gpu_freed_mb":
    int | None}`` so the System page can show a true freed-bytes
    number even when the FO1 sidecar's bookkeeping thinks nothing was
    loaded.
    """
    try:
        with _client() as c:
            r = c.post("/sam/vlm-fo1/unload")
            if r.status_code >= 400:
                return {"evicted": False, "gpu_freed_mb": None}
            body = r.json() or {}
            return {
                "evicted": bool(body.get("evicted")),
                "gpu_freed_mb": body.get("gpu_freed_mb"),
            }
    except Exception:  # noqa: BLE001 — best-effort cleanup, never propagate
        return {"evicted": False, "gpu_freed_mb": None}


def sam_box_prompt(
    image_b64: str,
    boxes: list[list[float]],
    box_labels: list[int],
    text: str | None = None,
    *,
    epsilon_factor: float | None = None,
) -> list[dict]:
    """POST /sam/box-prompt — SAM 3 only (one-shot).

    ``boxes`` are xyxy floats. ``box_labels`` are 1 (positive include)
    or 0 (negative exclude). ``text`` optionally combines a concept with
    the boxes for refinement. 409 ``sam3_box_prompt_requires_sam3`` is
    returned by the model service when SAM 3 is not the active model.
    """
    body: dict = {
        "image_b64": image_b64,
        "boxes": boxes,
        "box_labels": box_labels,
    }
    if text is not None:
        body["text"] = text
    if epsilon_factor is not None:
        body["epsilon_factor"] = float(epsilon_factor)
    with _wrap_unreachable("sam_box_prompt"), _client() as c:
        r = c.post("/sam/box-prompt", json=body)
        if r.status_code >= 400:
            raise ModelServiceError(r.status_code, _safe_json(r))
        return r.json()


# v3.27 — sam_track_* helpers removed. Replaced by track_open_session,
# track_add_prompt, track_propagate, track_remove_object, track_reset_prompts,
# track_close_session below (defined after _safe_json).


def _safe_json(r: httpx.Response) -> Any:
    try:
        return r.json()
    except ValueError:
        return r.text


# ---- v3.27 SAM 3.1 multiplex track ---------------------------------------


def track_open_session(
    frame_urls: list[str], image_size: tuple[int, int], asset_hash: str,
) -> dict:
    body = {
        "frame_urls": frame_urls,
        "image_size": [int(image_size[0]), int(image_size[1])],
        "asset_hash": asset_hash,
    }
    with _wrap_unreachable("track_open_session"), _client() as c:
        r = c.post("/track/sessions", json=body)
        if r.status_code >= 400:
            raise ModelServiceError(r.status_code, _safe_json(r))
        return r.json()


def track_add_prompt(sid: str, body: dict) -> dict:
    with _wrap_unreachable("track_add_prompt"), _client() as c:
        r = c.post(f"/track/sessions/{sid}/prompts", json=body)
        if r.status_code >= 400:
            raise ModelServiceError(r.status_code, _safe_json(r))
        return r.json()


def track_propagate_stream(
    sid: str, start_frame: int | None, end_frame: int | None,
) -> Iterator[bytes]:
    """Yield NDJSON bytes from the model service streaming endpoint as
    they arrive. Used by the per-frame progress UX in Run-full-track.

    The 600s timeout matches ``track_propagate`` so a full 446-frame
    sweep can complete without httpx truncating mid-stream.
    """
    body = {"start_frame": start_frame, "end_frame": end_frame}
    s = get_settings()
    timeout = max(float(s.model_timeout_seconds), 600.0)
    client = httpx.Client(
        base_url=s.model_base_url,
        timeout=timeout,
        transport=_TEST_TRANSPORT,
    )
    try:
        with client.stream(
            "POST", f"/track/sessions/{sid}/propagate/stream", json=body,
        ) as r:
            if r.status_code >= 400:
                # Drain so the connection can be returned to the pool,
                # then surface the upstream error in the legacy shape.
                raw = b"".join(r.iter_bytes())
                try:
                    detail = json.loads(raw or b"{}")
                except Exception:  # noqa: BLE001
                    detail = {"raw": raw.decode(errors="replace")}
                raise ModelServiceError(r.status_code, detail)
            for chunk in r.iter_bytes():
                if chunk:
                    yield chunk
    except (
        httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout,
    ) as exc:
        raise ModelServiceError(
            503, {"error": "model_service_unreachable",
                  "detail": f"track_propagate_stream: {exc.__class__.__name__}: {exc}"},
        ) from exc
    finally:
        client.close()


def track_propagate(
    sid: str, start_frame: int | None, end_frame: int | None,
) -> dict:
    body = {"start_frame": start_frame, "end_frame": end_frame}
    # v3.27.3 — propagation is the only track call that runs SAM2
    # over the entire video and serializes 100s of mask polygons.
    # On a 446-frame clip it takes ~90s of compute plus 5–15s of JSON
    # serialization; the default 120s client timeout truncates with a
    # ReadTimeout that the api translates into a 503. Override the
    # timeout for this single call so a full-video sweep can land.
    s = get_settings()
    timeout = max(float(s.model_timeout_seconds), 600.0)
    with _wrap_unreachable("track_propagate"), httpx.Client(
        base_url=s.model_base_url,
        timeout=timeout,
        transport=_TEST_TRANSPORT,
    ) as c:
        r = c.post(f"/track/sessions/{sid}/propagate", json=body)
        if r.status_code >= 400:
            raise ModelServiceError(r.status_code, _safe_json(r))
        return r.json()


def track_remove_object(sid: str, obj_id: int) -> None:
    with _wrap_unreachable("track_remove_object"), _client() as c:
        r = c.delete(f"/track/sessions/{sid}/objects/{obj_id}")
        if r.status_code not in (204, 404):
            raise ModelServiceError(r.status_code, _safe_json(r))


def track_reset_prompts(sid: str) -> None:
    with _wrap_unreachable("track_reset_prompts"), _client() as c:
        r = c.delete(f"/track/sessions/{sid}/prompts")
        if r.status_code not in (204, 404):
            raise ModelServiceError(r.status_code, _safe_json(r))


def track_close_session(sid: str) -> None:
    with _wrap_unreachable("track_close_session"), _client() as c:
        r = c.delete(f"/track/sessions/{sid}")
        if r.status_code not in (204, 404):
            raise ModelServiceError(r.status_code, _safe_json(r))
