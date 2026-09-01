# Armin Mehri — mehri.armin@gmail.com
import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from carve_api.auth.jwt import (
    InvalidToken,
    create_access_token,
    create_refresh_token,
    decode_token,
)
from carve_api.auth.models import ADMIN_LEVEL_ROLES, User, UserRole
from carve_api.auth.passwords import hash_password
from carve_api.auth.schemas import (
    ChangePasswordIn,
    LoginIn,
    RefreshIn,
    RegisterIn,
    TokenPair,
    UserOut,
)
from carve_api.auth.service import (
    AccountBlocked,
    AuthService,
    CurrentPasswordWrong,
    EmailTaken,
    InvalidCredentials,
)
from carve_api.auth.sso import (
    OIDCError,
    SSOState,
    build_provider,
    generate_nonce,
    generate_pkce_pair,
    generate_state,
    pop_state,
    store_state,
)
from carve_api.config import get_enabled_sso_providers
from carve_api.deps import _bearer_token, get_current_user, get_db
from carve_api.errors import AppError
router = APIRouter(prefix="/auth", tags=["auth"])


def _tokens_for(user: User) -> TokenPair:
    return TokenPair(
        access_token=create_access_token(subject=str(user.id), role=user.role.value),
        refresh_token=create_refresh_token(subject=str(user.id), role=user.role.value),
    )


def _to_http(err: AppError) -> HTTPException:
    return HTTPException(status_code=err.http_status, detail=err.code)


@router.get("/bootstrap-status")
def bootstrap_status(request: Request, db: Session = Depends(get_db)) -> dict:
    exists = db.execute(select(User.id).limit(1)).scalar_one_or_none() is not None
    return {"users_exist": exists}


@router.post("/register", response_model=UserOut, status_code=status.HTTP_201_CREATED)
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
        # Compare against the admin-level set, not the literal "admin":
        # a superadmin's token carries role="superadmin", and the tier
        # above admin must never be refused something admin can do.
        if claims.get("role") not in {r.value for r in ADMIN_LEVEL_ROLES}:
            raise HTTPException(status_code=403, detail="bootstrapped_admin_only")
    try:
        user = AuthService(db).register(email=payload.email, password=payload.password)
    except EmailTaken as exc:
        raise _to_http(exc) from exc
    db.commit()
    return UserOut.from_orm_user(user)


@router.post("/login", response_model=TokenPair)
def login(request: Request, payload: LoginIn, db: Session = Depends(get_db)) -> TokenPair:
    try:
        user = AuthService(db).authenticate(email=payload.email, password=payload.password)
    except AccountBlocked as exc:
        # Structured so the login screen can explain the block (and show
        # the reason) instead of implying the password was wrong.
        raise HTTPException(
            status_code=exc.http_status,
            detail={
                "error": exc.code,
                "message": (
                    "This account has been blocked. Contact your workspace "
                    "administrator."
                ),
                "reason": exc.reason,
            },
        ) from exc
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
    if user is None or user.deleted_at is not None:
        raise HTTPException(status_code=401, detail="user not found")
    # Without these two checks the refresh endpoint would be a bypass:
    # a blocked or force-logged-out user could keep minting fresh access
    # tokens from a refresh token issued before the change.
    if user.blocked_at is not None:
        raise HTTPException(status_code=403, detail="account_blocked")
    cutoff = user.sessions_valid_from
    if cutoff is not None:
        iat = claims.get("iat")
        if iat is None or datetime.fromtimestamp(int(iat), tz=timezone.utc) < cutoff:
            raise HTTPException(status_code=401, detail="session_revoked")
    return _tokens_for(user)


@router.get("/me", response_model=UserOut)
def me(current: User = Depends(get_current_user)) -> UserOut:
    return UserOut.from_orm_user(current)


@router.post("/password", status_code=204)
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


# ---------------------------------------------------------------------------
# SSO (Plan-13 Phase 7 Task 5) -- OIDC entry point.
# ---------------------------------------------------------------------------


def _random_password_hash() -> str:
    """Argon2 hash of a 32-byte random token. Used when provisioning a
    user via SSO so the password column is non-null and unguessable; the
    user must continue authenticating via SSO (or use the
    change-password flow if they ever set a real password).
    """
    return hash_password(secrets.token_urlsafe(32))


@router.get("/sso/{provider}/start")
async def sso_start(
    request: Request,
    provider: str,
    redirect_url: str = "/",
) -> RedirectResponse:
    enabled = get_enabled_sso_providers()
    if provider.lower() not in enabled:
        raise HTTPException(status_code=404, detail="sso_provider_unknown")
    try:
        oidc = build_provider(provider)
    except OIDCError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    state = generate_state()
    nonce = generate_nonce()
    verifier, challenge = generate_pkce_pair()
    store_state(
        state,
        SSOState(
            provider=provider.lower(),
            redirect_url=redirect_url,
            code_verifier=verifier,
            nonce=nonce,
        ),
    )
    try:
        url = await oidc.authorize_url(state, nonce, challenge)
    except OIDCError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return RedirectResponse(url, status_code=302)


@router.get("/sso/{provider}/callback")
async def sso_callback(
    request: Request,
    provider: str,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    db: Session = Depends(get_db),
) -> RedirectResponse:
    enabled = get_enabled_sso_providers()
    if provider.lower() not in enabled:
        raise HTTPException(status_code=404, detail="sso_provider_unknown")
    if error:
        raise HTTPException(status_code=400, detail=f"sso_error:{error}")
    if not code or not state:
        raise HTTPException(status_code=400, detail="sso_missing_code_or_state")
    s = pop_state(state)
    if s is None or s.provider != provider.lower():
        raise HTTPException(
            status_code=400, detail="sso_invalid_or_replayed_state"
        )
    try:
        oidc = build_provider(provider)
        tokens = await oidc.exchange_code(code, s.code_verifier)
        claims = await oidc.verify_id_token(
            tokens["id_token"], expected_nonce=s.nonce
        )
    except OIDCError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    email = (claims.get("email") or "").lower()
    sub = claims.get("sub")
    if not email or not sub:
        raise HTTPException(status_code=400, detail="id_token_missing_email_or_sub")
    user = db.execute(
        select(User).where(User.email == email, User.deleted_at.is_(None))
    ).scalar_one_or_none()
    if user is None:
        user = User(
            email=email,
            password_hash=_random_password_hash(),
            role=UserRole.member,
            sso_subject=sub,
        )
        db.add(user)
        db.flush()
    else:
        if user.sso_subject is None:
            user.sso_subject = sub
        elif user.sso_subject != sub:
            raise HTTPException(status_code=409, detail="sso_subject_conflict")
    db.commit()
    jwt_token = create_access_token(subject=str(user.id), role=user.role.value)
    # Token is delivered via URL fragment so it never appears in HTTP
    # access logs (the fragment is stripped before the request leaves the
    # browser). Front-end JS reads it via ``location.hash``.
    target = f"{s.redirect_url}#token={jwt_token}"
    return RedirectResponse(target, status_code=302)
