# Armin Mehri — mehri.armin@gmail.com
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
        user = User(
            email=email,
            password_hash=hash_password(password),
            role=UserRole.admin if is_first else UserRole.member,
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
        return user

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
