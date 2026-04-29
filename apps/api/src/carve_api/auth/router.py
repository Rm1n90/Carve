from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from carve_api.auth.jwt import (
    InvalidToken,
    create_access_token,
    create_refresh_token,
    decode_token,
)
from carve_api.auth.models import User
from carve_api.auth.schemas import (
    ChangePasswordIn,
    LoginIn,
    RefreshIn,
    RegisterIn,
    TokenPair,
    UserOut,
)
from carve_api.auth.service import (
    AuthService,
    CurrentPasswordWrong,
    EmailTaken,
    InvalidCredentials,
)
from carve_api.deps import _bearer_token, get_current_user, get_db
from carve_api.errors import AppError
from carve_api.ratelimit import limiter

router = APIRouter(prefix="/auth", tags=["auth"])


def _tokens_for(user: User) -> TokenPair:
    return TokenPair(
        access_token=create_access_token(subject=str(user.id), role=user.role.value),
        refresh_token=create_refresh_token(subject=str(user.id), role=user.role.value),
    )


def _to_http(err: AppError) -> HTTPException:
    return HTTPException(status_code=err.http_status, detail=err.code)


@router.get("/bootstrap-status")
@limiter.limit("60/minute")
def bootstrap_status(request: Request, db: Session = Depends(get_db)) -> dict:
    exists = db.execute(select(User.id).limit(1)).scalar_one_or_none() is not None
    return {"users_exist": exists}


@router.post("/register", response_model=UserOut, status_code=status.HTTP_201_CREATED)
@limiter.limit("5/minute")
def register(
    request: Request,
    payload: RegisterIn,
    db: Session = Depends(get_db),
    authorization: str | None = Header(default=None),
) -> UserOut:
    bootstrapped = (
        db.execute(select(User.id).limit(1)).scalar_one_or_none() is not None
    )
    if bootstrapped:
        # After the first user exists, only admins may create new accounts.
        try:
            token = _bearer_token(authorization)
            claims = decode_token(token, expected_type="access")
        except HTTPException as exc:
            raise HTTPException(
                status_code=401, detail="bootstrapped_admin_only"
            ) from exc
        except InvalidToken as exc:
            raise HTTPException(
                status_code=401, detail="bootstrapped_admin_only"
            ) from exc
        if claims.get("role") != "admin":
            raise HTTPException(status_code=403, detail="bootstrapped_admin_only")
    try:
        user = AuthService(db).register(email=payload.email, password=payload.password)
    except EmailTaken as exc:
        raise _to_http(exc) from exc
    db.commit()
    return UserOut.from_orm_user(user)


@router.post("/login", response_model=TokenPair)
@limiter.limit("10/minute")
def login(request: Request, payload: LoginIn, db: Session = Depends(get_db)) -> TokenPair:
    try:
        user = AuthService(db).authenticate(email=payload.email, password=payload.password)
    except InvalidCredentials as exc:
        raise _to_http(exc) from exc
    return _tokens_for(user)


@router.post("/refresh", response_model=TokenPair)
def refresh(payload: RefreshIn, db: Session = Depends(get_db)) -> TokenPair:
    try:
        claims = decode_token(payload.refresh_token, expected_type="refresh")
    except InvalidToken as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    user = db.get(User, claims["sub"])
    if user is None:
        raise HTTPException(status_code=401, detail="user not found")
    return _tokens_for(user)


@router.get("/me", response_model=UserOut)
def me(current: User = Depends(get_current_user)) -> UserOut:
    return UserOut.from_orm_user(current)


@router.post("/password", status_code=204)
@limiter.limit("5/minute")
def change_password(
    request: Request,  # required by slowapi for rate-limit key extraction
    payload: ChangePasswordIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    """Self-service password rotation (audit Bug 16).

    Authenticated user verifies their current password and chooses a new one
    (>= 8 chars, enforced by Pydantic). On success returns 204 with no body.
    Rate-limited to 5/min/IP to slow brute-force against the current password.
    """
    try:
        AuthService(db).change_password(
            user,
            current_password=payload.current_password,
            new_password=payload.new_password,
        )
    except CurrentPasswordWrong:
        raise HTTPException(status_code=401, detail="current_password_wrong")
    return Response(status_code=204)
