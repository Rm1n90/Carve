from sqlalchemy import select
from sqlalchemy.orm import Session

from vaa_api.auth.models import User, UserRole
from vaa_api.auth.passwords import hash_password, verify_password
from vaa_api.errors import AppError


class EmailTaken(AppError):
    http_status = 409
    code = "email_taken"


class InvalidCredentials(AppError):
    http_status = 401
    code = "invalid_credentials"


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
