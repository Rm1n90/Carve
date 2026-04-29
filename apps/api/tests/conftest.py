import os
import sys
from collections.abc import Generator
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))


def _set_test_env() -> None:
    os.environ.setdefault("JWT_SECRET", "j" * 64)
    os.environ.setdefault("PASSWORD_PEPPER", "p" * 32)
    # Test infrastructure references a locally-provisioned Postgres role/DB
    # (and MinIO bucket). These are persistent external identifiers, not
    # internal package names — leave as-is across the Carve rename so existing
    # local test setups keep working. The .env.example defaults use `carve`.
    os.environ.setdefault("POSTGRES_USER", "vaa")
    os.environ.setdefault("POSTGRES_PASSWORD", "vaa")
    os.environ.setdefault("POSTGRES_HOST", "localhost")
    os.environ.setdefault("POSTGRES_PORT", "5432")
    os.environ.setdefault("POSTGRES_DB", "vaa_test")
    os.environ.setdefault("MINIO_ROOT_USER", "vaa")
    os.environ.setdefault("MINIO_ROOT_PASSWORD", "vaa")
    os.environ.setdefault("MINIO_ENDPOINT", "http://localhost:9000")
    os.environ.setdefault("MINIO_BUCKET", "vaa-assets-test")
    os.environ.setdefault("MODEL_BASE_URL", "http://model-test")


# Set env vars at import time so module-level `app = create_app()` in main.py
# can resolve Settings during pytest's collection phase (before fixtures run).
_set_test_env()


@pytest.fixture(scope="session", autouse=True)
def _env() -> None:
    _set_test_env()


@pytest.fixture(scope="session")
def engine():
    _set_test_env()
    from carve_api.db import Base
    import carve_api.auth.models  # noqa: F401
    import carve_api.assets.models  # noqa: F401
    import carve_api.annotations.models  # noqa: F401
    import carve_api.weights.models  # noqa: F401
    import carve_api.exports.models  # noqa: F401
    import carve_api.api_keys.models  # noqa: F401
    import carve_api.workspace.models  # noqa: F401

    url = (
        f"postgresql+psycopg://{os.environ['POSTGRES_USER']}:{os.environ['POSTGRES_PASSWORD']}"
        f"@{os.environ['POSTGRES_HOST']}:{os.environ['POSTGRES_PORT']}/{os.environ['POSTGRES_DB']}"
    )
    eng = create_engine(url, future=True)
    Base.metadata.drop_all(eng)
    Base.metadata.create_all(eng)
    yield eng
    Base.metadata.drop_all(eng)


@pytest.fixture(autouse=True)
def _reset_limiter() -> Generator[None, None, None]:
    # The slowapi Limiter is a module-level singleton with in-memory storage that
    # persists across tests; reset it so existing tests aren't accidentally throttled
    # and rate-limit tests start from a clean state.
    from carve_api.ratelimit import limiter

    limiter.reset()
    yield
    limiter.reset()


@pytest.fixture
def db_session(engine) -> Generator[Session, None, None]:
    connection = engine.connect()
    transaction = connection.begin()
    SessionLocal = sessionmaker(
        bind=connection,
        autoflush=False,
        expire_on_commit=False,
        future=True,
        join_transaction_mode="create_savepoint",
    )
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()
        transaction.rollback()
        connection.close()
