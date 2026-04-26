import pytest

from carve_api.auth.models import User, UserRole
from carve_api.auth.passwords import verify_password
from carve_api.auth.service import AuthService, EmailTaken, InvalidCredentials


def test_register_creates_member(db_session) -> None:
    db_session.query(User).delete()
    db_session.flush()
    svc = AuthService(db_session)
    u1 = svc.register(email="boss@x.com", password="hunter22")
    u2 = svc.register(email="staff@x.com", password="hunter22")
    assert u1.role == UserRole.admin
    assert u2.role == UserRole.member
    assert verify_password("hunter22", u2.password_hash)


def test_register_rejects_duplicate(db_session) -> None:
    svc = AuthService(db_session)
    svc.register(email="dup@x.com", password="hunter22")
    db_session.flush()
    with pytest.raises(EmailTaken):
        svc.register(email="dup@x.com", password="hunter22")


def test_authenticate_correct(db_session) -> None:
    svc = AuthService(db_session)
    svc.register(email="a@x.com", password="hunter22")
    db_session.flush()
    found = svc.authenticate(email="a@x.com", password="hunter22")
    assert found.email == "a@x.com"


def test_authenticate_wrong_password(db_session) -> None:
    svc = AuthService(db_session)
    svc.register(email="a2@x.com", password="hunter22")
    db_session.flush()
    with pytest.raises(InvalidCredentials):
        svc.authenticate(email="a2@x.com", password="wrong")


def test_authenticate_unknown_email(db_session) -> None:
    svc = AuthService(db_session)
    with pytest.raises(InvalidCredentials):
        svc.authenticate(email="ghost@x.com", password="anything")
