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
        if self.session.execute(
            select(User).where(User.email == email)
        ).scalar_one_or_none():
            raise EmailTaken("email already registered")
        is_first = self.session.execute(select(User).limit(1)).scalar_one_or_none() is None
        user = User(
            email=email,
            password_hash=hash_password(password),
            role=UserRole.admin if is_first else UserRole.member,
        )
        self.session.add(user)
        self.session.flush()
        return user

    def authenticate(self, *, email: str, password: str) -> User:
        user = self.session.execute(
            select(User).where(User.email == email)
        ).scalar_one_or_none()
        if user is None or not verify_password(password, user.password_hash):
            raise InvalidCredentials("email or password is wrong")
        return user

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
