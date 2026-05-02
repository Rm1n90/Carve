# Armin Mehri — mehri.armin@gmail.com
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from carve_api.api_keys.schemas import ApiKeyCreatedOut, ApiKeyCreateIn, ApiKeyOut
from carve_api.api_keys.service import ApiKeyNotFound, ApiKeyService
from carve_api.auth.models import User
from carve_api.deps import get_current_user, get_db
from carve_api.errors import AppError

router = APIRouter(prefix="/auth/api-keys", tags=["api-keys"])


def _http(err: AppError) -> HTTPException:
    return HTTPException(status_code=err.http_status, detail=err.code)


@router.get("", response_model=list[ApiKeyOut])
def list_api_keys(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[ApiKeyOut]:
    return [
        ApiKeyOut.from_orm_key(k)
        for k in ApiKeyService(db).list_for_user(user=user)
    ]


@router.post("", response_model=ApiKeyCreatedOut, status_code=status.HTTP_201_CREATED)
def create_api_key(
    payload: ApiKeyCreateIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ApiKeyCreatedOut:
    created = ApiKeyService(db).create(user=user, name=payload.name)
    db.commit()
    base = ApiKeyOut.from_orm_key(created.key)
    return ApiKeyCreatedOut(**base.model_dump(), token=created.raw_token)


@router.delete("/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_api_key(
    key_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    try:
        ApiKeyService(db).revoke(user=user, key_id=key_id)
    except ApiKeyNotFound as exc:
        raise _http(exc) from exc
    db.commit()
