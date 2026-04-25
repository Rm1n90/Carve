import pytest
from sqlalchemy import select

from vaa_api.auth.models import User, UserRole


def test_user_role_enum_values() -> None:
    assert {r.value for r in UserRole} == {"admin", "member", "viewer"}


@pytest.mark.usefixtures("db_session")
def test_create_user(db_session) -> None:
    u = User(email="x@y.com", password_hash="$argon2id$dummy", role=UserRole.admin)
    db_session.add(u)
    db_session.flush()
    fetched = db_session.execute(select(User).where(User.email == "x@y.com")).scalar_one()
    assert fetched.role is UserRole.admin
    assert fetched.id is not None
    assert fetched.created_at is not None
