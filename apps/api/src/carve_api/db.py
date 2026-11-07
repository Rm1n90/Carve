# Armin Mehri — mehri.armin@gmail.com
import os
from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from carve_api.config import get_env_settings


class Base(DeclarativeBase):
    """Base for all ORM models."""


_engine = None
_SessionLocal: sessionmaker[Session] | None = None


def get_engine():
    global _engine
    if _engine is None:
        _engine = create_engine(
            get_env_settings().database_url, pool_pre_ping=True, future=True
        )
    return _engine


def _forget_pool_in_child() -> None:
    # A forked process (an RQ work horse) must not reuse its parent's
    # pooled connections: both would talk over the same socket. Reading
    # the saved settings opens one in whatever process asks first.
    if _engine is not None:
        _engine.dispose(close=False)


os.register_at_fork(after_in_child=_forget_pool_in_child)


def get_session_factory() -> sessionmaker[Session]:
    global _SessionLocal
    if _SessionLocal is None:
        _SessionLocal = sessionmaker(
            bind=get_engine(),
            autoflush=False,
            autocommit=False,
            expire_on_commit=False,
            future=True,
        )
    return _SessionLocal


def db_session() -> Iterator[Session]:
    SessionLocal = get_session_factory()
    s = SessionLocal()
    try:
        yield s
        s.commit()
    except Exception:
        s.rollback()
        raise
    finally:
        s.close()
