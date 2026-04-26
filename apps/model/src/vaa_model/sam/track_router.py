"""SAM 2 video-tracker HTTP endpoints.

POST /sam-track/start
POST /sam-track/{session}/step?frames=N
DELETE /sam-track/{session}
"""

from typing import Any

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from vaa_model.sam.codec import encode_mask_rle
from vaa_model.sam.predictor import autocast_ctx, get_sam_model
from vaa_model.sam.tracker import (
    TrackerSession,
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
    points: list[list[int]] = Field(default_factory=list)
    labels: list[int] = Field(default_factory=list)
    text: str | None = Field(default=None, max_length=200)


class StartOut(BaseModel):
    session_id: str
    mask_at_start: dict


class StepEntry(BaseModel):
    frame_idx: int
    counts: str
    size: list[int]
    score: float


class StepOut(BaseModel):
    steps: list[StepEntry]


@router.post("/start", response_model=StartOut)
def start(payload: StartIn) -> StartOut:
    # Reject non-http(s) schemes first (block file:// / ftp:// SSRF-style abuse).
    import urllib.parse

    parsed = urllib.parse.urlparse(payload.video_url)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=422, detail="video_url_scheme_not_allowed")

    # SAM 3 video tracking is text-based (concept tracking). The legacy SAM 2
    # tracker uses click points. Branch the validation + payload forwarding
    # based on the configured model. The adapter contract for SAM 3 is to
    # forward the text via the ``points`` slot — see Sam3VideoTrackerAdapter.
    forwarded_points: list
    forwarded_labels: list
    if get_sam_model() == "sam3":
        if not payload.text:
            raise HTTPException(status_code=422, detail="sam3_track_requires_text")
        forwarded_points = [payload.text]
        forwarded_labels = []
    else:
        if len(payload.points) < 1:
            raise HTTPException(status_code=422, detail="track_requires_points")
        if len(payload.points) != len(payload.labels):
            raise HTTPException(status_code=422, detail="points and labels must have equal length")
        forwarded_points = payload.points
        forwarded_labels = payload.labels

    try:
        session = start_session(
            video_url=payload.video_url,
            frame_idx=payload.frame_idx,
            points=forwarded_points,
            labels=forwarded_labels,
        )
    except Exception as exc:  # noqa: BLE001 — wrap upstream init failure
        raise HTTPException(status_code=502, detail=f"tracker_init_failed: {exc!r}") from exc

    # The seed mask is the result of the add_new_points call. Some predictor
    # implementations expose this via the inference_state directly; for v1 we
    # return an empty mask placeholder and rely on /step to start streaming.
    seed_mask = _seed_mask_for(session)
    return StartOut(session_id=session.session_id, mask_at_start=seed_mask)


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
                session.propagation_iter = iter(session.tracker.propagate_in_video(session.inference_state))
            out: list[StepEntry] = []
            for _ in range(frames):
                try:
                    frame_idx, mask = next(session.propagation_iter)
                except StopIteration:
                    break
                mask_np = _to_numpy(mask)
                counts, size = encode_mask_rle(mask_np)
                out.append(StepEntry(frame_idx=int(frame_idx), counts=counts, size=size, score=1.0))
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
