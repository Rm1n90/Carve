"""SAM 2 / SAM 3 video-tracker HTTP endpoints.

POST /sam-track/start                 — open a session (optionally seed obj_id=1)
POST /sam-track/{session}/objects     — add a new object's prompt at any frame
POST /sam-track/{session}/step?frames=N — propagate N frames; per-object masks
DELETE /sam-track/{session}           — release a session
"""

import logging
from typing import Any

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

from carve_model.sam.codec import encode_mask_rle
from carve_model.sam.polygonize import mask_to_polygon
from carve_model.sam.predictor import autocast_ctx, get_sam_model
from carve_model.sam.sam3_adapter import ConceptModeError
from carve_model.sam.tracker import (
    TrackerSession,
    add_object_to_session,
    get_session,
    release_session,
    start_session,
    touch_session,
)

router = APIRouter(prefix="/sam-track", tags=["sam-track"])


class StartIn(BaseModel):
    # v3.8 Phase 4-video step F6 -- ``video_url`` is now optional. When
    # ``frame_urls`` is non-empty, the router downloads each URL to a
    # temp dir and uses that as the tracker's init_state path. This is
    # how post-extract video assets (whose mp4 has been deleted) get
    # tracked: the API supplies the per-frame JPEG URLs.
    video_url: str = ""
    frame_urls: list[str] = Field(default_factory=list)
    frame_idx: int = Field(default=0, ge=0)
    # ``points``/``labels`` are required for the SAM 2 click-based tracker
    # but unused for SAM 3 (concept tracking via ``text``). Both default to
    # empty lists so SAM 3 callers can omit them; the handler validates
    # the right combination based on the configured SAM model.
    # v1.4: empty points + empty text is also OK — callers can add objects
    # one at a time via /sam-track/{sid}/objects.
    points: list[list[int]] = Field(default_factory=list)
    labels: list[int] = Field(default_factory=list)
    text: str | None = Field(default=None, max_length=200)


class StartOut(BaseModel):
    session_id: str
    mask_at_start: dict


class AddObjectIn(BaseModel):
    frame_idx: int = Field(ge=0)
    # Cap obj_id at 256: tracking that many distinct objects in a single
    # video session is already unusual, and the bound prevents a buggy or
    # malicious caller from triggering unbounded dict growth in the
    # tracker's per-session state.
    obj_id: int = Field(ge=1, le=256)
    points: list[list[int]] = Field(default_factory=list)
    labels: list[int] = Field(default_factory=list)
    boxes: list[list[float]] = Field(default_factory=list)


class AddObjectOut(BaseModel):
    obj_id: int
    frame_idx: int


class StepObjectEntry(BaseModel):
    obj_id: int
    counts: str
    size: list[int]
    score: float
    # v3.8 Phase 4.1 — Douglas-Peucker simplified outer contour so the
    # client commits editable polygon annotations (matches the Phase 1
    # commit contract). Empty when the mask had no usable contour;
    # client falls back to ``counts`` (mask_rle) in that case.
    polygon: list[list[float]] = []


class StepFrameEntry(BaseModel):
    frame_idx: int
    objects: list[StepObjectEntry]


class StepOut(BaseModel):
    steps: list[StepFrameEntry]


@router.post("/start", response_model=StartOut)
def start(payload: StartIn) -> StartOut:
    # v3.8 Phase 4-video step F6 -- prefer the per-frame URL list when
    # provided. Download each to a temp dir; the tracker's init_state
    # treats a directory of JPEGs as a frame sequence. Falls back to
    # the single-video path for legacy callers / image-only assets.
    import urllib.parse

    init_path: str
    tmpdir: str | None = None
    if payload.frame_urls:
        import os
        import tempfile

        import httpx

        # Reject non-http(s) URLs to block file:// / ftp:// SSRF abuse.
        for url in payload.frame_urls:
            parsed = urllib.parse.urlparse(url)
            if parsed.scheme not in ("http", "https"):
                raise HTTPException(
                    status_code=422,
                    detail="frame_url_scheme_not_allowed",
                )
        tmpdir = tempfile.mkdtemp(prefix="track-")
        try:
            with httpx.Client(timeout=30.0) as client:
                for i, url in enumerate(payload.frame_urls):
                    r = client.get(url)
                    r.raise_for_status()
                    with open(
                        os.path.join(tmpdir, f"{i:06d}.jpg"), "wb"
                    ) as f:
                        f.write(r.content)
        except Exception as exc:  # noqa: BLE001
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)
            raise HTTPException(
                status_code=502,
                detail=f"frame_download_failed: {exc!r}",
            ) from exc

        # v3.8 Phase 4-video step F6 — transformers' Sam2VideoModel /
        # Sam3VideoModel init_state goes through ``load_video``, which
        # only accepts a video URL or a local video file path (NOT a
        # directory of JPEGs, despite the upstream README implying so).
        # Stitch the downloaded frames into a temp mp4 here so
        # init_state has the format it expects.
        try:
            import ffmpeg as _ff

            video_path = os.path.join(tmpdir, "__video.mp4")
            (
                _ff.input(
                    os.path.join(tmpdir, "%06d.jpg"),
                    framerate=30,
                    pattern_type="sequence",
                )
                .output(video_path, vcodec="libx264", pix_fmt="yuv420p")
                .run(capture_stdout=True, capture_stderr=True, overwrite_output=True)
            )
        except _ff.Error as exc:  # type: ignore[name-defined]
            import shutil

            err = (exc.stderr or b"").decode("utf-8", errors="replace")
            shutil.rmtree(tmpdir, ignore_errors=True)
            raise HTTPException(
                status_code=502,
                detail=f"frames_to_video_failed: {err[-300:]}",
            ) from exc
        init_path = video_path
    else:
        # Legacy single-video path (image asset at idx=0, or pre-extract
        # video). Reject non-http(s) schemes first (block file:// /
        # ftp:// SSRF-style abuse).
        parsed = urllib.parse.urlparse(payload.video_url)
        if parsed.scheme not in ("http", "https"):
            raise HTTPException(status_code=422, detail="video_url_scheme_not_allowed")
        init_path = payload.video_url

    # SAM 3 supports BOTH point-based and text-based video tracking via a
    # dispatcher adapter (Sam3VideoDispatcherAdapter). The dispatcher routes:
    #   - string prompts → Sam3VideoModel.add_text_prompt (concept tracking)
    #   - numeric points → Sam3TrackerVideoModel.add_inputs_to_inference_session
    # When SAM_MODEL=sam3, the router accepts EITHER text OR points (or both;
    # text wins when present and points are otherwise absent). When
    # SAM_MODEL=sam2.x (default), only numeric points are accepted.
    forwarded_points: list
    forwarded_labels: list
    if get_sam_model() == "sam3":
        if payload.text and not payload.points:
            forwarded_points = [payload.text]
            forwarded_labels = []
        elif payload.points:
            if len(payload.points) != len(payload.labels):
                raise HTTPException(status_code=422, detail="points and labels must have equal length")
            forwarded_points = payload.points
            forwarded_labels = payload.labels
        else:
            # v1.4: empty prompts → defer object creation to /objects.
            forwarded_points = []
            forwarded_labels = []
    else:
        if payload.points:
            if len(payload.points) != len(payload.labels):
                raise HTTPException(status_code=422, detail="points and labels must have equal length")
            forwarded_points = payload.points
            forwarded_labels = payload.labels
        else:
            forwarded_points = []
            forwarded_labels = []

    try:
        session = start_session(
            video_url=init_path,
            tmpdir=tmpdir,
            frame_idx=payload.frame_idx,
            points=forwarded_points,
            labels=forwarded_labels,
        )
    except Exception as exc:  # noqa: BLE001 — wrap upstream init failure
        # v3.8 Phase 4-video step F6 — clean up the downloaded frames
        # if init_state failed; otherwise the tmpdir leaks until pod
        # restart.
        if tmpdir is not None:
            import shutil as _sh
            _sh.rmtree(tmpdir, ignore_errors=True)
        logger.exception("tracker_init_failed")
        raise HTTPException(status_code=502, detail=f"tracker_init_failed: {exc!r}") from exc

    # The seed mask is the result of the add_new_points / add_inputs_at_frame
    # call. Some predictor implementations expose this via the inference_state
    # directly; for v1 we return an empty mask placeholder and rely on /step
    # to start streaming.
    seed_mask = _seed_mask_for(session)
    return StartOut(session_id=session.session_id, mask_at_start=seed_mask)


@router.post("/{session_id}/objects", response_model=AddObjectOut)
def add_object(session_id: str, payload: AddObjectIn) -> AddObjectOut:
    session = get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="session_not_found")
    touch_session(session_id)
    if not payload.points and not payload.boxes:
        raise HTTPException(status_code=422, detail="object_requires_points_or_boxes")
    if payload.points and len(payload.points) != len(payload.labels):
        raise HTTPException(status_code=422, detail="points and labels must have equal length")
    if payload.points and any(label not in (0, 1) for label in payload.labels):
        raise HTTPException(status_code=422, detail="labels must be 0 or 1")
    try:
        add_object_to_session(
            session,
            frame_idx=payload.frame_idx,
            obj_id=payload.obj_id,
            points=payload.points or None,
            labels=payload.labels or None,
            boxes=payload.boxes or None,
        )
    except ConceptModeError as exc:
        # The session was started in SAM 3 concept (text) mode; /objects
        # is unsupported there. Map to 422 so the client knows the request
        # is structurally invalid (vs. a 502 transient upstream error).
        raise HTTPException(
            status_code=422,
            detail="add_object_unsupported_in_concept_mode",
        ) from exc
    except Exception as exc:  # noqa: BLE001 — wrap upstream failure
        logger.exception("add_object_failed sid=%s obj_id=%s", session_id, payload.obj_id)
        raise HTTPException(status_code=502, detail=f"add_object_failed: {exc!r}") from exc
    return AddObjectOut(obj_id=payload.obj_id, frame_idx=payload.frame_idx)


@router.post("/{session_id}/step", response_model=StepOut)
def step(session_id: str, frames: int = 1) -> StepOut:
    if frames < 1 or frames > 1000:
        raise HTTPException(status_code=422, detail="frames must be in [1, 1000]")
    session = get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="session_not_found")
    touch_session(session_id)
    try:
        with autocast_ctx():
            if session.propagation_iter is None:
                session.propagation_iter = iter(
                    session.tracker.propagate_in_video(session.inference_state),
                )
            out: list[StepFrameEntry] = []
            for _ in range(frames):
                try:
                    frame_idx, masks_per_obj = next(session.propagation_iter)
                except StopIteration:
                    break
                # Backward-compat: legacy fakes / single-object trackers yield
                # ``(frame_idx, single_mask)``. Wrap as ``{1: mask}`` so
                # downstream emits a valid per-object response.
                if not isinstance(masks_per_obj, dict):
                    masks_per_obj = {1: masks_per_obj}
                obj_entries: list[StepObjectEntry] = []
                for obj_id, mask in masks_per_obj.items():
                    mask_np = _to_numpy(mask)
                    counts, size = encode_mask_rle(mask_np)
                    polygon = mask_to_polygon(mask_np)
                    obj_entries.append(StepObjectEntry(
                        obj_id=int(obj_id),
                        counts=counts,
                        size=size,
                        score=1.0,
                        polygon=polygon,
                    ))
                out.append(StepFrameEntry(
                    frame_idx=int(frame_idx),
                    objects=obj_entries,
                ))
                session.last_frame_idx = int(frame_idx)
        return StepOut(steps=out)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception("tracker_step_failed sid=%s frames=%s", session_id, frames)
        raise HTTPException(status_code=502, detail=f"tracker_step_failed: {exc!r}") from exc


@router.delete("/{session_id}", status_code=204)
def release(session_id: str) -> None:
    if not release_session(session_id):
        raise HTTPException(status_code=404, detail="session_not_found")


def _seed_mask_for(session: TrackerSession) -> dict:
    """Return a placeholder seed mask. Real predictors expose the seed-frame
    mask directly; for v1 we emit an empty 1x1 zero mask so callers know the
    session is alive. The client typically calls /step to start receiving
    real masks anyway.
    """
    return {"counts": "1", "size": [1, 1], "score": 1.0}


def _to_numpy(arr: Any) -> np.ndarray:
    """Convert a torch tensor (or array-like) to numpy.

    v3.8 Phase 4.1 -- bfloat16 / float16 tensors raise ``TypeError: Got
    unsupported ScalarType BFloat16`` on ``.numpy()``. Cast to float32
    first. Mirrors the same fix in ``sam/router.py`` and the SAM 3
    factories.
    """
    if hasattr(arr, "cpu"):
        cpu_arr = arr.cpu()
        dtype = getattr(cpu_arr, "dtype", None)
        if dtype is not None and hasattr(cpu_arr, "float"):
            dname = str(dtype)
            if "bfloat16" in dname or "float16" in dname:
                cpu_arr = cpu_arr.float()
        return cpu_arr.numpy()
    return np.asarray(arr)
