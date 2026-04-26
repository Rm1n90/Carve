"""SAM 2 / SAM 3 video-tracker HTTP endpoints.

POST /sam-track/start                 — open a session (optionally seed obj_id=1)
POST /sam-track/{session}/objects     — add a new object's prompt at any frame
POST /sam-track/{session}/step?frames=N — propagate N frames; per-object masks
DELETE /sam-track/{session}           — release a session
"""

from typing import Any

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from vaa_model.sam.codec import encode_mask_rle
from vaa_model.sam.predictor import autocast_ctx, get_sam_model
from vaa_model.sam.sam3_adapter import ConceptModeError
from vaa_model.sam.tracker import (
    TrackerSession,
    add_object_to_session,
    get_session,
    release_session,
    start_session,
    touch_session,
)

router = APIRouter(prefix="/sam-track", tags=["sam-track"])


class StartIn(BaseModel):
    video_url: str
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


class StepFrameEntry(BaseModel):
    frame_idx: int
    objects: list[StepObjectEntry]


class StepOut(BaseModel):
    steps: list[StepFrameEntry]


@router.post("/start", response_model=StartOut)
def start(payload: StartIn) -> StartOut:
    # Reject non-http(s) schemes first (block file:// / ftp:// SSRF-style abuse).
    import urllib.parse

    parsed = urllib.parse.urlparse(payload.video_url)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=422, detail="video_url_scheme_not_allowed")

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
            video_url=payload.video_url,
            frame_idx=payload.frame_idx,
            points=forwarded_points,
            labels=forwarded_labels,
        )
    except Exception as exc:  # noqa: BLE001 — wrap upstream init failure
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
                    obj_entries.append(StepObjectEntry(
                        obj_id=int(obj_id),
                        counts=counts,
                        size=size,
                        score=1.0,
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
    if hasattr(arr, "cpu"):
        return arr.cpu().numpy()
    return np.asarray(arr)
