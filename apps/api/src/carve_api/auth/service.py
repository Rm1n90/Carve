# Armin Mehri — mehri.armin@gmail.com
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from carve_api.auth.models import User, UserRole
from carve_api.auth.passwords import hash_password, verify_password
from carve_api.errors import AppError


class EmailTaken(AppError):
    http_status = 409
    code = "email_taken"


class InvalidCredentials(AppError):
    http_status = 401
    code = "invalid_credentials"


class AccountBlocked(AppError):
    """Raised when a blocked account presents correct credentials.

    Distinct from :class:`InvalidCredentials` so the user is told *why*
    they cannot get in — being stonewalled with "wrong password" when
    the password is right is a support ticket waiting to happen. Only
    ever raised after the password has been verified, so it cannot be
    used to enumerate accounts.
    """

    http_status = 403
    code = "account_blocked"

    def __init__(self, reason: str | None = None) -> None:
        super().__init__(self.code)
        self.reason = reason


class CurrentPasswordWrong(Exception):
    """Raised by ``AuthService.change_password`` when the supplied
    ``current_password`` does not match the stored hash. The router maps this
    to HTTP 401 with detail ``current_password_wrong`` (audit Bug 16).
    """


class AuthService:
    def __init__(self, session: Session) -> None:
        self.session = session

    def register(self, *, email: str, password: str) -> User:
        # Email collisions are checked against ACTIVE users only — a soft-
        # deleted account holding a previous owner's email shouldn't block
        # a fresh admin from re-registering it. (Bug 14)
        if self.session.execute(
            select(User).where(User.email == email, User.deleted_at.is_(None))
        ).scalar_one_or_none():
            raise EmailTaken("email already registered")
        # The "first user becomes admin" bootstrap looks at active users only:
        # if every previous user was soft-deleted we treat the workspace as
        # empty so the new admin gets the admin role automatically.
        is_first = (
            self.session.execute(
                select(User).where(User.deleted_at.is_(None)).limit(1)
            ).scalar_one_or_none()
            is None
        )
        # The bootstrap user owns the workspace, so they get the top
        # tier — otherwise a fresh install would have no superadmin and
        # no way to mint one. Existing deployments are handled by the
        # promote step in alembic 0039.
        user = User(
            email=email,
            password_hash=hash_password(password),
            role=UserRole.superadmin if is_first else UserRole.member,
        )
        self.session.add(user)
        self.session.flush()
        return user

    def authenticate(self, *, email: str, password: str) -> User:
        # Soft-deleted users cannot log in — same response as a wrong email
        # (don't leak account existence). (Bug 14)
        user = self.session.execute(
            select(User).where(User.email == email, User.deleted_at.is_(None))
        ).scalar_one_or_none()
        if user is None or not verify_password(password, user.password_hash):
            raise InvalidCredentials("email or password is wrong")
        # Credentials are verified BEFORE the block is reported, so this
        # never becomes an oracle for "does this email exist?" — a wrong
        # password on a blocked account still returns the generic error.
        if user.blocked_at is not None:
            raise AccountBlocked(user.blocked_reason)
        return user

    def force_set_password(self, user: User, *, new_password: str) -> None:
        """Set a password without the current-password challenge.

        Superadmin-only path (the self-serve route is
        :meth:`change_password`). Every existing session is invalidated
        at the same instant: a password reset that leaves the old token
        working is not a reset.
        """
        user.password_hash = hash_password(new_password)
        self.revoke_sessions(user)

    def revoke_sessions(self, user: User) -> None:
        """Invalidate every access/refresh token issued so far.

        One second into the future, not ``now()``: tokens carry ``iat``
        truncated to whole seconds, so a token minted during the same
        second as the cutoff would otherwise compare equal and survive.
        """
        user.sessions_valid_from = datetime.now(timezone.utc) + timedelta(seconds=1)
        self.session.flush()

    def email_exists(self, email: str) -> bool:
        """True if an ACTIVE user with this email exists. Used by the new
        admin-create-member endpoint (Bug 14) before delegating to register().
        """
        return self.session.execute(
            select(User.id).where(User.email == email, User.deleted_at.is_(None))
        ).scalar_one_or_none() is not None

    def change_password(
        self, user: User, *, current_password: str, new_password: str
    ) -> None:
        """Self-service password rotation (audit Bug 16).

        Validates the current password against the stored hash, enforces a
        minimum length of 8 on the new password (defence in depth — the
        Pydantic schema already rejects shorter inputs), then writes the new
        bcrypt hash and commits.
        """
        if not verify_password(current_password, user.password_hash):
            raise CurrentPasswordWrong()
        if len(new_password) < 8:
            raise ValueError("password too short")
        user.password_hash = hash_password(new_password)
        self.session.commit()
