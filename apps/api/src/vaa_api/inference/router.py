import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from vaa_api.annotations.router import _require_visible_task
from vaa_api.annotations.schemas import AnnotationOut
from vaa_api.assets.models import Asset
from vaa_api.auth.models import User
from vaa_api.deps import get_current_user, get_db
from vaa_api.errors import AppError
from vaa_api.inference.autoannotate import (
    auto_annotate_asset,
    fetch_asset_bytes,
    presigned_url_for_weight,
)
from vaa_api.weights.models import Weight


router = APIRouter(prefix="/assets", tags=["auto-annotate"])


def _http(err: AppError) -> HTTPException:
    return HTTPException(status_code=err.http_status, detail=err.code)


@router.post("/{asset_id}/auto-annotate", response_model=list[AnnotationOut])
def auto_annotate(
    asset_id: uuid.UUID,
    weight_id: uuid.UUID,
    overwrite: bool = False,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[AnnotationOut]:
    asset = db.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="asset_not_found")
    task = _require_visible_task(db, user, asset.task_id)
    weight = db.get(Weight, weight_id)
    if weight is None:
        raise HTTPException(status_code=404, detail="weight_not_found")
    try:
        body = fetch_asset_bytes(asset)
        url = presigned_url_for_weight(weight)
        anns = auto_annotate_asset(
            session=db,
            actor=user,
            task=task,
            asset=asset,
            weight=weight,
            overwrite=overwrite,
            presigned_url_for_weight=url,
            image_bytes=body,
        )
    except AppError as exc:
        raise _http(exc) from exc
    db.commit()
    return [AnnotationOut.from_orm_annotation(a) for a in anns]
