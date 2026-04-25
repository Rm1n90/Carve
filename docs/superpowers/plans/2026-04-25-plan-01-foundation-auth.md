# Plan 01 — Foundation & Auth

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a runnable monorepo skeleton — Docker Compose stack with Postgres, Redis, MinIO, Caddy, an empty React+Vite web app, a FastAPI app service with multi-user auth and role separation, and an empty FastAPI model service — so subsequent plans can build features on top.

**Architecture:** Three Python/TS services orchestrated by Docker Compose on one Linux host. The API service owns the database and JWT-based auth; the model service is a GPU-pinned stub that will receive SAM/YOLO logic in a later plan; the web service is a Vite-built SPA reverse-proxied by Caddy.

**Tech Stack:** FastAPI 0.115 · SQLAlchemy 2 · Alembic · PostgreSQL 16 · Redis 7 · MinIO · Argon2id (passlib) · python-jose (JWT) · Pydantic v2 · React 19 · TypeScript 5 · Vite 6 · Zustand · TanStack Query · TanStack Router · Tailwind v4 · Vitest · Pytest · Docker Compose v2 · Caddy 2

---

## Plan series overview (context only — only this plan is in scope)

- **Plan 01 — Foundation & Auth** ← *this plan*
- Plan 02 — Projects, Tasks, Classes (CRUD + nav UI)
- Plan 03 — Asset ingestion (uploads, MinIO, content hashing, thumbnails)
- Plan 04 — Manual annotation canvas (Pixi.js, bbox/polygon/mask/tag)
- Plan 05 — YOLO model service + auto-annotate
- Plan 06 — Annotation import + YOLO/COCO export with class remap
- Plan 07 — Analytics dashboards
- Plan 08 — Deployment polish, Caddy TLS, first-run wizard, docs

---

## File Structure

Files this plan creates (paths relative to repo root):

```
VisualAutoAnnotator/
├── README.md
├── .env.example
├── .editorconfig
├── docker-compose.yml
├── docker-compose.override.yml
├── pnpm-workspace.yaml
├── apps/
│   ├── api/
│   │   ├── Dockerfile
│   │   ├── pyproject.toml
│   │   ├── alembic.ini
│   │   ├── alembic/
│   │   │   ├── env.py
│   │   │   └── versions/0001_users.py
│   │   ├── src/vaa_api/
│   │   │   ├── __init__.py
│   │   │   ├── main.py
│   │   │   ├── config.py
│   │   │   ├── db.py
│   │   │   ├── deps.py
│   │   │   ├── health.py
│   │   │   ├── errors.py
│   │   │   └── auth/
│   │   │       ├── __init__.py
│   │   │       ├── models.py
│   │   │       ├── schemas.py
│   │   │       ├── passwords.py
│   │   │       ├── jwt.py
│   │   │       ├── service.py
│   │   │       └── router.py
│   │   └── tests/
│   │       ├── conftest.py
│   │       ├── test_health.py
│   │       └── auth/
│   │           ├── __init__.py
│   │           ├── test_passwords.py
│   │           ├── test_jwt.py
│   │           ├── test_user_model.py
│   │           ├── test_service.py
│   │           ├── test_register.py
│   │           ├── test_login.py
│   │           ├── test_refresh.py
│   │           └── test_roles.py
│   ├── model/
│   │   ├── Dockerfile
│   │   ├── pyproject.toml
│   │   ├── src/vaa_model/
│   │   │   ├── __init__.py
│   │   │   └── main.py
│   │   └── tests/test_health.py
│   └── web/
│       ├── Dockerfile
│       ├── package.json
│       ├── tsconfig.json
│       ├── vite.config.ts
│       ├── index.html
│       ├── src/
│       │   ├── main.tsx
│       │   ├── App.tsx
│       │   ├── api/client.ts
│       │   ├── auth/
│       │   │   ├── store.ts
│       │   │   ├── api.ts
│       │   │   ├── LoginPage.tsx
│       │   │   ├── RegisterPage.tsx
│       │   │   └── RequireAuth.tsx
│       │   ├── routes/
│       │   │   ├── _root.tsx
│       │   │   ├── index.tsx
│       │   │   ├── login.tsx
│       │   │   └── register.tsx
│       │   └── styles/global.css
│       └── tests/
│           ├── setup.ts
│           ├── auth-store.test.ts
│           └── login-page.test.tsx
├── infra/caddy/Caddyfile
└── scripts/smoke.sh
```

---

## Conventions used in this plan

- **Python package layout** uses `src/`. Imports are `from vaa_api.x import y`.
- **Frontend tests** use Vitest + Testing Library.
- **Backend tests** use Pytest with FastAPI `TestClient` and a Postgres test database.
- **Commits** are conventional commits (`feat:`, `fix:`, `chore:`, `test:`, `docs:`, `refactor:`).
- **Each task ends with a commit**; commits bundle the failing-test → passing-test cycle for one unit of behavior.
- Run commands assume you're at the repo root unless otherwise noted.

---

## Task 1: Repo skeleton

**Files:**
- Create: `.editorconfig`
- Create: `pnpm-workspace.yaml`

- [ ] **Step 1.1: `.editorconfig`**

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = space
indent_size = 2
trim_trailing_whitespace = true

[*.{py,md}]
indent_size = 4

[Makefile]
indent_style = tab
```

- [ ] **Step 1.2: `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/web"
  - "packages/*"
```

- [ ] **Step 1.3: Commit**

```bash
git add .editorconfig pnpm-workspace.yaml
git commit -m "chore: editorconfig and pnpm workspace declaration"
```

---

## Task 2: `.env.example`

**Files:**
- Create: `.env.example`

- [ ] **Step 2.1: Write `.env.example`**

```dotenv
POSTGRES_USER=vaa
POSTGRES_PASSWORD=devpassword_change_me
POSTGRES_DB=vaa
POSTGRES_HOST=postgres
POSTGRES_PORT=5432

REDIS_HOST=redis
REDIS_PORT=6379

MINIO_ROOT_USER=vaa
MINIO_ROOT_PASSWORD=devpassword_change_me
MINIO_ENDPOINT=http://minio:9000
MINIO_BUCKET=vaa-assets

API_HOST=0.0.0.0
API_PORT=8000
API_ENV=development
JWT_SECRET=change_me_to_a_long_random_string_at_least_32_chars
JWT_ACCESS_TTL_MIN=15
JWT_REFRESH_TTL_DAYS=14
PASSWORD_PEPPER=change_me_to_a_long_random_string
CORS_ORIGINS=http://localhost:5173,http://localhost

MODEL_HOST=0.0.0.0
MODEL_PORT=8100
MODEL_DEVICE=cuda:0

VITE_API_BASE=/api
```

- [ ] **Step 2.2: Commit**

```bash
git add .env.example
git commit -m "chore: env template for app, model, web, postgres, redis, minio"
```

---

## Task 3: API — pyproject + minimal app + /health

**Files:**
- Create: `apps/api/pyproject.toml`
- Create: `apps/api/src/vaa_api/__init__.py`
- Create: `apps/api/src/vaa_api/main.py`
- Create: `apps/api/src/vaa_api/health.py`
- Create: `apps/api/tests/conftest.py`
- Create: `apps/api/tests/test_health.py`

- [ ] **Step 3.1: `apps/api/pyproject.toml`**

```toml
[project]
name = "vaa-api"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
  "fastapi==0.115.6",
  "uvicorn[standard]==0.34.0",
  "sqlalchemy==2.0.36",
  "alembic==1.14.0",
  "psycopg[binary]==3.2.3",
  "pydantic==2.10.4",
  "pydantic-settings==2.7.0",
  "python-jose[cryptography]==3.3.0",
  "passlib[argon2]==1.7.4",
  "argon2-cffi==23.1.0",
  "python-multipart==0.0.20",
  "redis==5.2.0",
  "rq==2.0.0",
  "boto3==1.36.5",
  "httpx==0.28.1",
  "email-validator==2.2.0",
]

[project.optional-dependencies]
dev = [
  "pytest==8.3.4",
  "pytest-asyncio==0.25.0",
  "pytest-cov==6.0.0",
  "ruff==0.8.4",
  "mypy==1.13.0",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/vaa_api"]

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]

[tool.ruff]
line-length = 100
target-version = "py312"

[tool.ruff.lint]
select = ["E", "F", "I", "B", "UP", "S", "ASYNC"]
ignore = ["S101"]
```

- [ ] **Step 3.2: Failing test `apps/api/tests/test_health.py`**

```python
from fastapi.testclient import TestClient

from vaa_api.main import create_app


def test_health_endpoint_returns_ok():
    app = create_app()
    client = TestClient(app)
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
```

- [ ] **Step 3.3: `apps/api/tests/conftest.py`** (initial — replaced in Task 7)

```python
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
```

- [ ] **Step 3.4: Run, verify failure**

```bash
cd apps/api
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
pytest tests/test_health.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'vaa_api.main'`

- [ ] **Step 3.5: Implement minimal app**

`apps/api/src/vaa_api/__init__.py`:

```python
__version__ = "0.1.0"
```

`apps/api/src/vaa_api/health.py`:

```python
from fastapi import APIRouter

router = APIRouter(tags=["health"])


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
```

`apps/api/src/vaa_api/main.py`:

```python
from fastapi import FastAPI

from vaa_api.health import router as health_router


def create_app() -> FastAPI:
    app = FastAPI(title="VisualAutoAnnotator API", version="0.1.0")
    app.include_router(health_router)
    return app


app = create_app()
```

- [ ] **Step 3.6: Run, verify pass**

```bash
pytest tests/test_health.py -v
```

Expected: 1 PASS

- [ ] **Step 3.7: Commit**

```bash
git add apps/api/pyproject.toml apps/api/src apps/api/tests
git commit -m "feat(api): minimal FastAPI app with /health endpoint"
```

---

## Task 4: API config + DB engine + Alembic init

**Files:**
- Create: `apps/api/src/vaa_api/config.py`
- Create: `apps/api/src/vaa_api/db.py`
- Create: `apps/api/alembic.ini`
- Create: `apps/api/alembic/env.py`
- Create: `apps/api/alembic/script.py.mako`
- Create: `apps/api/alembic/versions/.gitkeep`
- Create: `apps/api/tests/test_config.py`

- [ ] **Step 4.1: Failing test `apps/api/tests/test_config.py`**

```python
import pytest

from vaa_api.config import Settings, get_settings


def _base_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("POSTGRES_USER", "u")
    monkeypatch.setenv("POSTGRES_PASSWORD", "p")
    monkeypatch.setenv("POSTGRES_DB", "n")


def test_settings_load_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    _base_env(monkeypatch)
    monkeypatch.setenv("POSTGRES_HOST", "db.example")
    monkeypatch.setenv("POSTGRES_PORT", "5433")
    monkeypatch.setenv("JWT_SECRET", "x" * 64)
    monkeypatch.setenv("PASSWORD_PEPPER", "y" * 32)
    get_settings.cache_clear()
    s = Settings()
    assert s.database_url.startswith("postgresql+psycopg://u:p@db.example:5433/n")


def test_settings_rejects_short_jwt_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    _base_env(monkeypatch)
    monkeypatch.setenv("JWT_SECRET", "short")
    monkeypatch.setenv("PASSWORD_PEPPER", "y" * 32)
    get_settings.cache_clear()
    with pytest.raises(ValueError):
        Settings()
```

- [ ] **Step 4.2: Run, verify failure**

```bash
pytest tests/test_config.py -v
```

Expected: FAIL

- [ ] **Step 4.3: Implement `apps/api/src/vaa_api/config.py`**

```python
from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    postgres_user: str = Field(alias="POSTGRES_USER")
    postgres_password: str = Field(alias="POSTGRES_PASSWORD")
    postgres_host: str = Field(default="postgres", alias="POSTGRES_HOST")
    postgres_port: int = Field(default=5432, alias="POSTGRES_PORT")
    postgres_db: str = Field(alias="POSTGRES_DB")

    jwt_secret: str = Field(alias="JWT_SECRET")
    jwt_access_ttl_min: int = Field(default=15, alias="JWT_ACCESS_TTL_MIN")
    jwt_refresh_ttl_days: int = Field(default=14, alias="JWT_REFRESH_TTL_DAYS")
    password_pepper: str = Field(alias="PASSWORD_PEPPER")

    cors_origins: str = Field(default="", alias="CORS_ORIGINS")
    api_env: str = Field(default="development", alias="API_ENV")

    @field_validator("jwt_secret")
    @classmethod
    def _jwt_long(cls, v: str) -> str:
        if len(v) < 32:
            raise ValueError("JWT_SECRET must be at least 32 characters")
        return v

    @field_validator("password_pepper")
    @classmethod
    def _pepper_long(cls, v: str) -> str:
        if len(v) < 16:
            raise ValueError("PASSWORD_PEPPER must be at least 16 characters")
        return v

    @property
    def database_url(self) -> str:
        return (
            f"postgresql+psycopg://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
```

- [ ] **Step 4.4: Run tests, verify pass**

```bash
pytest tests/test_config.py -v
```

Expected: 2 PASS

- [ ] **Step 4.5: `apps/api/src/vaa_api/db.py`**

```python
from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from vaa_api.config import get_settings


class Base(DeclarativeBase):
    """Base for all ORM models."""


_engine = None
_SessionLocal: sessionmaker[Session] | None = None


def get_engine():
    global _engine
    if _engine is None:
        _engine = create_engine(
            get_settings().database_url, pool_pre_ping=True, future=True
        )
    return _engine


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
```

- [ ] **Step 4.6: Initialize Alembic**

```bash
cd apps/api
alembic init -t async alembic
```

Replace generated files with the versions below.

`apps/api/alembic.ini` (only relevant lines shown — keep the rest of the alembic.ini as generated):

```ini
[alembic]
script_location = alembic
prepend_sys_path = .
sqlalchemy.url =
```

`apps/api/alembic/env.py`:

```python
import sys
from logging.config import fileConfig
from pathlib import Path

from sqlalchemy import engine_from_config, pool

from alembic import context

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from vaa_api.config import get_settings  # noqa: E402
from vaa_api.db import Base  # noqa: E402
import vaa_api.auth.models  # noqa: F401, E402  (populate metadata)

config = context.config
config.set_main_option("sqlalchemy.url", get_settings().database_url)
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
```

- [ ] **Step 4.7: Commit**

```bash
git add apps/api/src/vaa_api/config.py apps/api/src/vaa_api/db.py
git add apps/api/alembic apps/api/alembic.ini apps/api/tests/test_config.py
git commit -m "feat(api): pydantic-settings config, SQLAlchemy session, Alembic init"
```

---

## Task 5: Argon2id password hashing with HMAC pepper

**Files:**
- Create: `apps/api/src/vaa_api/auth/__init__.py`
- Create: `apps/api/src/vaa_api/auth/passwords.py`
- Create: `apps/api/tests/auth/__init__.py`
- Create: `apps/api/tests/auth/test_passwords.py`

- [ ] **Step 5.1: Failing test `apps/api/tests/auth/test_passwords.py`**

```python
import pytest

from vaa_api.auth.passwords import hash_password, verify_password
from vaa_api.config import get_settings


@pytest.fixture(autouse=True)
def env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("POSTGRES_USER", "u")
    monkeypatch.setenv("POSTGRES_PASSWORD", "p")
    monkeypatch.setenv("POSTGRES_DB", "n")
    monkeypatch.setenv("JWT_SECRET", "j" * 64)
    monkeypatch.setenv("PASSWORD_PEPPER", "p" * 32)
    get_settings.cache_clear()


def test_hash_format() -> None:
    assert hash_password("hunter22").startswith("$argon2id$")


def test_verify_correct() -> None:
    h = hash_password("hunter22")
    assert verify_password("hunter22", h) is True


def test_verify_wrong() -> None:
    h = hash_password("hunter22")
    assert verify_password("nope", h) is False


def test_pepper_changes_hash(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PASSWORD_PEPPER", "a" * 32)
    get_settings.cache_clear()
    h1 = hash_password("same-pw")
    monkeypatch.setenv("PASSWORD_PEPPER", "b" * 32)
    get_settings.cache_clear()
    h2 = hash_password("same-pw")
    assert h1 != h2
```

- [ ] **Step 5.2: Run, verify failure**

```bash
pytest tests/auth/test_passwords.py -v
```

Expected: FAIL

- [ ] **Step 5.3: Implement `apps/api/src/vaa_api/auth/passwords.py`**

```python
import hmac
from hashlib import sha256

from passlib.hash import argon2

from vaa_api.config import get_settings


def _peppered(password: str) -> str:
    pepper = get_settings().password_pepper.encode()
    return hmac.new(pepper, password.encode("utf-8"), sha256).hexdigest()


def hash_password(password: str) -> str:
    return argon2.using(
        type="ID", time_cost=3, memory_cost=64 * 1024, parallelism=1
    ).hash(_peppered(password))


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return argon2.verify(_peppered(password), password_hash)
    except (ValueError, TypeError):
        return False
```

`apps/api/src/vaa_api/auth/__init__.py` and `apps/api/tests/auth/__init__.py`: empty files.

- [ ] **Step 5.4: Run, verify pass**

```bash
pytest tests/auth/test_passwords.py -v
```

Expected: 4 PASS

- [ ] **Step 5.5: Commit**

```bash
git add apps/api/src/vaa_api/auth apps/api/tests/auth
git commit -m "feat(api): argon2id password hashing with HMAC pepper"
```

---

## Task 6: JWT issue + verify

**Files:**
- Create: `apps/api/src/vaa_api/auth/jwt.py`
- Create: `apps/api/tests/auth/test_jwt.py`

- [ ] **Step 6.1: Failing test `apps/api/tests/auth/test_jwt.py`**

```python
import time

import pytest

from vaa_api.auth.jwt import (
    InvalidToken,
    create_access_token,
    create_refresh_token,
    decode_token,
)
from vaa_api.config import get_settings


@pytest.fixture(autouse=True)
def env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("POSTGRES_USER", "u")
    monkeypatch.setenv("POSTGRES_PASSWORD", "p")
    monkeypatch.setenv("POSTGRES_DB", "n")
    monkeypatch.setenv("JWT_SECRET", "j" * 64)
    monkeypatch.setenv("PASSWORD_PEPPER", "p" * 32)
    get_settings.cache_clear()


def test_access_round_trip() -> None:
    t = create_access_token(subject="u-1", role="admin")
    c = decode_token(t, expected_type="access")
    assert c["sub"] == "u-1"
    assert c["role"] == "admin"
    assert c["typ"] == "access"


def test_refresh_round_trip() -> None:
    t = create_refresh_token(subject="u-2", role="member")
    c = decode_token(t, expected_type="refresh")
    assert c["typ"] == "refresh"


def test_wrong_type_rejected() -> None:
    t = create_access_token(subject="x", role="member")
    with pytest.raises(InvalidToken):
        decode_token(t, expected_type="refresh")


def test_tampered_rejected() -> None:
    t = create_access_token(subject="x", role="member")
    bad = t[:-2] + ("aa" if not t.endswith("aa") else "bb")
    with pytest.raises(InvalidToken):
        decode_token(bad, expected_type="access")


def test_expired_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("JWT_ACCESS_TTL_MIN", "0")
    get_settings.cache_clear()
    t = create_access_token(subject="x", role="member")
    time.sleep(1)
    with pytest.raises(InvalidToken):
        decode_token(t, expected_type="access")
```

- [ ] **Step 6.2: Run, verify failure**

```bash
pytest tests/auth/test_jwt.py -v
```

Expected: FAIL

- [ ] **Step 6.3: Implement `apps/api/src/vaa_api/auth/jwt.py`**

```python
from datetime import UTC, datetime, timedelta
from typing import Literal

from jose import JWTError, jwt

from vaa_api.config import get_settings

ALGORITHM = "HS256"
TokenType = Literal["access", "refresh"]


class InvalidToken(Exception):
    """Raised when a token cannot be decoded, has the wrong type, or is expired."""


def _now() -> datetime:
    return datetime.now(UTC)


def create_access_token(*, subject: str, role: str) -> str:
    s = get_settings()
    now = _now()
    claims = {
        "sub": subject,
        "role": role,
        "typ": "access",
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=s.jwt_access_ttl_min)).timestamp()),
    }
    return jwt.encode(claims, s.jwt_secret, algorithm=ALGORITHM)


def create_refresh_token(*, subject: str, role: str) -> str:
    s = get_settings()
    now = _now()
    claims = {
        "sub": subject,
        "role": role,
        "typ": "refresh",
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(days=s.jwt_refresh_ttl_days)).timestamp()),
    }
    return jwt.encode(claims, s.jwt_secret, algorithm=ALGORITHM)


def decode_token(token: str, *, expected_type: TokenType) -> dict:
    try:
        claims = jwt.decode(token, get_settings().jwt_secret, algorithms=[ALGORITHM])
    except JWTError as exc:
        raise InvalidToken(str(exc)) from exc
    if claims.get("typ") != expected_type:
        raise InvalidToken(f"expected {expected_type}, got {claims.get('typ')}")
    return claims
```

- [ ] **Step 6.4: Run, verify pass**

```bash
pytest tests/auth/test_jwt.py -v
```

Expected: 5 PASS

- [ ] **Step 6.5: Commit**

```bash
git add apps/api/src/vaa_api/auth/jwt.py apps/api/tests/auth/test_jwt.py
git commit -m "feat(api): JWT access/refresh with type binding and expiry"
```

---

## Task 7: User model + first migration + db_session test fixture

**Files:**
- Create: `apps/api/src/vaa_api/auth/models.py`
- Create: `apps/api/alembic/versions/0001_users.py`
- Create: `apps/api/tests/auth/test_user_model.py`
- Modify: `apps/api/tests/conftest.py`

- [ ] **Step 7.1: Failing test `apps/api/tests/auth/test_user_model.py`**

```python
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
```

- [ ] **Step 7.2: Replace `apps/api/tests/conftest.py`**

```python
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
    os.environ.setdefault("POSTGRES_USER", "vaa")
    os.environ.setdefault("POSTGRES_PASSWORD", "vaa")
    os.environ.setdefault("POSTGRES_HOST", "localhost")
    os.environ.setdefault("POSTGRES_PORT", "5432")
    os.environ.setdefault("POSTGRES_DB", "vaa_test")


@pytest.fixture(scope="session", autouse=True)
def _env() -> None:
    _set_test_env()


@pytest.fixture(scope="session")
def engine():
    _set_test_env()
    from vaa_api.db import Base
    import vaa_api.auth.models  # noqa: F401

    url = (
        f"postgresql+psycopg://{os.environ['POSTGRES_USER']}:{os.environ['POSTGRES_PASSWORD']}"
        f"@{os.environ['POSTGRES_HOST']}:{os.environ['POSTGRES_PORT']}/{os.environ['POSTGRES_DB']}"
    )
    eng = create_engine(url, future=True)
    Base.metadata.drop_all(eng)
    Base.metadata.create_all(eng)
    yield eng
    Base.metadata.drop_all(eng)


@pytest.fixture
def db_session(engine) -> Generator[Session, None, None]:
    SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()
```

- [ ] **Step 7.3: Run, verify failure**

```bash
# Make sure Postgres is reachable on localhost:5432 with a 'vaa_test' DB.
createdb -h localhost -U vaa vaa_test || true
pytest tests/auth/test_user_model.py -v
```

Expected: FAIL — `ModuleNotFoundError: vaa_api.auth.models`

- [ ] **Step 7.4: Implement `apps/api/src/vaa_api/auth/models.py`**

```python
import enum
import uuid
from datetime import datetime

from sqlalchemy import DateTime, Enum, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from vaa_api.db import Base


class UserRole(str, enum.Enum):
    admin = "admin"
    member = "member"
    viewer = "viewer"


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[UserRole] = mapped_column(
        Enum(UserRole, name="user_role"), nullable=False, default=UserRole.member
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
```

- [ ] **Step 7.5: Write migration `apps/api/alembic/versions/0001_users.py`**

```python
"""users table

Revision ID: 0001
Revises:
Create Date: 2026-04-25
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


user_role = postgresql.ENUM("admin", "member", "viewer", name="user_role")


def upgrade() -> None:
    user_role.create(op.get_bind(), checkfirst=True)
    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("email", sa.String(255), nullable=False),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column(
            "role",
            postgresql.ENUM(name="user_role", create_type=False),
            nullable=False,
            server_default="member",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_unique_constraint("uq_users_email", "users", ["email"])
    op.create_index("ix_users_email", "users", ["email"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_users_email", table_name="users")
    op.drop_constraint("uq_users_email", "users", type_="unique")
    op.drop_table("users")
    user_role.drop(op.get_bind(), checkfirst=True)
```

- [ ] **Step 7.6: Run model tests**

```bash
pytest tests/auth/test_user_model.py -v
```

Expected: 2 PASS

- [ ] **Step 7.7: Commit**

```bash
git add apps/api/src/vaa_api/auth/models.py apps/api/alembic/versions/0001_users.py
git add apps/api/tests/auth/test_user_model.py apps/api/tests/conftest.py
git commit -m "feat(api): User model with admin/member/viewer roles + migration"
```

---

## Task 8: Auth schemas + service layer (register/authenticate)

**Files:**
- Create: `apps/api/src/vaa_api/errors.py`
- Create: `apps/api/src/vaa_api/auth/schemas.py`
- Create: `apps/api/src/vaa_api/auth/service.py`
- Create: `apps/api/tests/auth/test_service.py`

- [ ] **Step 8.1: Failing test `apps/api/tests/auth/test_service.py`**

```python
import pytest

from vaa_api.auth.models import User, UserRole
from vaa_api.auth.passwords import verify_password
from vaa_api.auth.service import AuthService, EmailTaken, InvalidCredentials


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
```

- [ ] **Step 8.2: Run, verify failure**

```bash
pytest tests/auth/test_service.py -v
```

Expected: FAIL

- [ ] **Step 8.3: Implement `apps/api/src/vaa_api/errors.py`**

```python
class AppError(Exception):
    """Base for application-level errors with an HTTP-friendly code."""

    http_status: int = 400
    code: str = "app_error"

    def __init__(self, message: str = "") -> None:
        super().__init__(message or self.code)
        self.message = message or self.code
```

- [ ] **Step 8.4: Implement `apps/api/src/vaa_api/auth/schemas.py`**

```python
from pydantic import BaseModel, EmailStr, Field

from vaa_api.auth.models import UserRole


class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "Bearer"


class UserOut(BaseModel):
    id: str
    email: EmailStr
    role: UserRole

    @classmethod
    def from_orm_user(cls, u) -> "UserOut":
        return cls(id=str(u.id), email=u.email, role=u.role)


class RefreshIn(BaseModel):
    refresh_token: str
```

- [ ] **Step 8.5: Implement `apps/api/src/vaa_api/auth/service.py`**

```python
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
```

- [ ] **Step 8.6: Run, verify pass**

```bash
pytest tests/auth/test_service.py -v
```

Expected: 5 PASS

- [ ] **Step 8.7: Commit**

```bash
git add apps/api/src/vaa_api/errors.py apps/api/src/vaa_api/auth/schemas.py
git add apps/api/src/vaa_api/auth/service.py apps/api/tests/auth/test_service.py
git commit -m "feat(api): AuthService.register + .authenticate; first user is admin"
```

---

## Task 9: Auth router + FastAPI deps

**Files:**
- Create: `apps/api/src/vaa_api/deps.py`
- Create: `apps/api/src/vaa_api/auth/router.py`
- Create: `apps/api/tests/auth/test_register.py`
- Create: `apps/api/tests/auth/test_login.py`
- Create: `apps/api/tests/auth/test_refresh.py`
- Modify: `apps/api/src/vaa_api/main.py`

- [ ] **Step 9.1: Failing tests**

`apps/api/tests/auth/test_register.py`:

```python
from fastapi.testclient import TestClient

from vaa_api.deps import get_db
from vaa_api.main import create_app


def _client(db_session) -> TestClient:
    app = create_app()

    def _override():
        try:
            yield db_session
        finally:
            db_session.rollback()

    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def test_register_returns_user(db_session) -> None:
    client = _client(db_session)
    r = client.post(
        "/auth/register", json={"email": "u1@example.com", "password": "hunter22"}
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["email"] == "u1@example.com"
    assert body["role"] in {"admin", "member"}


def test_register_short_password() -> None:
    from vaa_api.main import create_app
    client = TestClient(create_app())
    r = client.post(
        "/auth/register", json={"email": "u2@example.com", "password": "short"}
    )
    assert r.status_code == 422


def test_register_duplicate(db_session) -> None:
    client = _client(db_session)
    client.post("/auth/register", json={"email": "u3@example.com", "password": "hunter22"})
    r = client.post(
        "/auth/register", json={"email": "u3@example.com", "password": "hunter22"}
    )
    assert r.status_code == 409
    assert r.json()["error"] == "email_taken"
```

`apps/api/tests/auth/test_login.py`:

```python
from fastapi.testclient import TestClient

from vaa_api.deps import get_db
from vaa_api.main import create_app


def _client(db_session) -> TestClient:
    app = create_app()

    def _override():
        try:
            yield db_session
        finally:
            db_session.rollback()

    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def test_login_returns_token_pair(db_session) -> None:
    client = _client(db_session)
    client.post("/auth/register", json={"email": "lg@example.com", "password": "hunter22"})
    r = client.post("/auth/login", json={"email": "lg@example.com", "password": "hunter22"})
    assert r.status_code == 200
    body = r.json()
    assert body["access_token"]
    assert body["refresh_token"]
    assert body["token_type"] == "Bearer"


def test_login_wrong_password(db_session) -> None:
    client = _client(db_session)
    client.post("/auth/register", json={"email": "lg2@example.com", "password": "hunter22"})
    r = client.post("/auth/login", json={"email": "lg2@example.com", "password": "wrong"})
    assert r.status_code == 401


def test_me_requires_token() -> None:
    client = TestClient(create_app())
    r = client.get("/auth/me")
    assert r.status_code == 401


def test_me_with_token(db_session) -> None:
    client = _client(db_session)
    client.post("/auth/register", json={"email": "me@example.com", "password": "hunter22"})
    login = client.post(
        "/auth/login", json={"email": "me@example.com", "password": "hunter22"}
    ).json()
    r = client.get("/auth/me", headers={"Authorization": f"Bearer {login['access_token']}"})
    assert r.status_code == 200
    assert r.json()["email"] == "me@example.com"
```

`apps/api/tests/auth/test_refresh.py`:

```python
from fastapi.testclient import TestClient

from vaa_api.deps import get_db
from vaa_api.main import create_app


def _client(db_session) -> TestClient:
    app = create_app()

    def _override():
        try:
            yield db_session
        finally:
            db_session.rollback()

    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def test_refresh_issues_new_access(db_session) -> None:
    client = _client(db_session)
    client.post("/auth/register", json={"email": "rf@example.com", "password": "hunter22"})
    login = client.post(
        "/auth/login", json={"email": "rf@example.com", "password": "hunter22"}
    ).json()
    r = client.post("/auth/refresh", json={"refresh_token": login["refresh_token"]})
    assert r.status_code == 200
    assert r.json()["access_token"]


def test_refresh_rejects_access_token(db_session) -> None:
    client = _client(db_session)
    client.post("/auth/register", json={"email": "rf2@example.com", "password": "hunter22"})
    login = client.post(
        "/auth/login", json={"email": "rf2@example.com", "password": "hunter22"}
    ).json()
    r = client.post("/auth/refresh", json={"refresh_token": login["access_token"]})
    assert r.status_code == 401
```

- [ ] **Step 9.2: Run, verify failure**

```bash
pytest tests/auth/test_register.py tests/auth/test_login.py tests/auth/test_refresh.py -v
```

Expected: import errors / fail

- [ ] **Step 9.3: Implement `apps/api/src/vaa_api/deps.py`**

```python
from collections.abc import Iterator

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy.orm import Session

from vaa_api.auth.jwt import InvalidToken, decode_token
from vaa_api.auth.models import User, UserRole
from vaa_api.db import db_session


def get_db() -> Iterator[Session]:
    yield from db_session()


def _bearer_token(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return authorization.split(" ", 1)[1].strip()


def get_current_user(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> User:
    token = _bearer_token(authorization)
    try:
        claims = decode_token(token, expected_type="access")
    except InvalidToken as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(exc),
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc
    user = db.get(User, claims["sub"])
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="user not found")
    return user


def require_role(*roles: UserRole):
    def _checker(user: User = Depends(get_current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="forbidden")
        return user

    return _checker
```

- [ ] **Step 9.4: Implement `apps/api/src/vaa_api/auth/router.py`**

```python
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from vaa_api.auth.jwt import (
    InvalidToken,
    create_access_token,
    create_refresh_token,
    decode_token,
)
from vaa_api.auth.models import User
from vaa_api.auth.schemas import LoginIn, RefreshIn, RegisterIn, TokenPair, UserOut
from vaa_api.auth.service import AuthService, EmailTaken, InvalidCredentials
from vaa_api.deps import get_current_user, get_db
from vaa_api.errors import AppError

router = APIRouter(prefix="/auth", tags=["auth"])


def _tokens_for(user: User) -> TokenPair:
    return TokenPair(
        access_token=create_access_token(subject=str(user.id), role=user.role.value),
        refresh_token=create_refresh_token(subject=str(user.id), role=user.role.value),
    )


def _to_http(err: AppError) -> HTTPException:
    return HTTPException(status_code=err.http_status, detail=err.code)


@router.post("/register", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def register(payload: RegisterIn, db: Session = Depends(get_db)) -> UserOut:
    try:
        user = AuthService(db).register(email=payload.email, password=payload.password)
    except EmailTaken as exc:
        raise _to_http(exc) from exc
    db.commit()
    return UserOut.from_orm_user(user)


@router.post("/login", response_model=TokenPair)
def login(payload: LoginIn, db: Session = Depends(get_db)) -> TokenPair:
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
```

- [ ] **Step 9.5: Update `apps/api/src/vaa_api/main.py`**

```python
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from vaa_api.auth.router import router as auth_router
from vaa_api.config import get_settings
from vaa_api.errors import AppError
from vaa_api.health import router as health_router


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="VisualAutoAnnotator API", version="0.1.0")

    if settings.cors_origin_list:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origin_list,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    app.include_router(health_router)
    app.include_router(auth_router)

    @app.exception_handler(AppError)
    async def _app_error(_: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(status_code=exc.http_status, content={"error": exc.code})

    @app.exception_handler(HTTPException)
    async def _http_error(_: Request, exc: HTTPException) -> JSONResponse:
        if isinstance(exc.detail, dict):
            return JSONResponse(status_code=exc.status_code, content=exc.detail)
        return JSONResponse(status_code=exc.status_code, content={"error": str(exc.detail)})

    return app


app = create_app()
```

- [ ] **Step 9.6: Run all auth tests**

```bash
pytest tests/auth -v
```

Expected: all green

- [ ] **Step 9.7: Commit**

```bash
git add apps/api/src/vaa_api/main.py apps/api/src/vaa_api/deps.py
git add apps/api/src/vaa_api/auth/router.py apps/api/tests/auth
git commit -m "feat(api): /auth/register, /auth/login, /auth/refresh, /auth/me with RBAC dep"
```

---

## Task 10: Role-protected endpoint demo

**Files:**
- Modify: `apps/api/src/vaa_api/main.py`
- Create: `apps/api/tests/auth/test_roles.py`

- [ ] **Step 10.1: Failing test `apps/api/tests/auth/test_roles.py`**

```python
from fastapi.testclient import TestClient

from vaa_api.auth.models import User
from vaa_api.deps import get_db
from vaa_api.main import create_app


def _client(db_session) -> TestClient:
    app = create_app()

    def _override():
        try:
            yield db_session
        finally:
            db_session.rollback()

    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def _login(client, email: str, password: str) -> dict:
    return client.post("/auth/login", json={"email": email, "password": password}).json()


def test_admin_only_allows_admin(db_session) -> None:
    db_session.query(User).delete()
    db_session.flush()
    client = _client(db_session)
    client.post("/auth/register", json={"email": "boss@x.com", "password": "hunter22"})
    tokens = _login(client, "boss@x.com", "hunter22")
    r = client.get("/admin/ping", headers={"Authorization": f"Bearer {tokens['access_token']}"})
    assert r.status_code == 200


def test_admin_only_rejects_member(db_session) -> None:
    db_session.query(User).delete()
    db_session.flush()
    client = _client(db_session)
    client.post("/auth/register", json={"email": "boss2@x.com", "password": "hunter22"})
    client.post("/auth/register", json={"email": "staff@x.com", "password": "hunter22"})
    tokens = _login(client, "staff@x.com", "hunter22")
    r = client.get("/admin/ping", headers={"Authorization": f"Bearer {tokens['access_token']}"})
    assert r.status_code == 403
```

- [ ] **Step 10.2: Add an admin-only endpoint inside `create_app` in `apps/api/src/vaa_api/main.py`**

After the `app.include_router(auth_router)` line, add:

```python
    from fastapi import APIRouter, Depends

    from vaa_api.auth.models import UserRole
    from vaa_api.deps import require_role

    admin_router = APIRouter(prefix="/admin", tags=["admin"])

    @admin_router.get("/ping")
    def admin_ping(_=Depends(require_role(UserRole.admin))) -> dict[str, str]:
        return {"pong": "admin"}

    app.include_router(admin_router)
```

- [ ] **Step 10.3: Run tests**

```bash
pytest tests/auth/test_roles.py -v
```

Expected: 2 PASS

- [ ] **Step 10.4: Commit**

```bash
git add apps/api/src/vaa_api/main.py apps/api/tests/auth/test_roles.py
git commit -m "feat(api): role-gated endpoint demo and tests for require_role"
```

---

## Task 11: API Dockerfile

**Files:**
- Create: `apps/api/Dockerfile`

- [ ] **Step 11.1: Write `apps/api/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.7
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential libpq5 curl \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml ./
RUN pip install -e .

COPY alembic.ini ./
COPY alembic ./alembic
COPY src ./src

ENV PYTHONPATH=/app/src

EXPOSE 8000

CMD ["bash", "-c", "alembic upgrade head && uvicorn vaa_api.main:app --host 0.0.0.0 --port 8000"]
```

- [ ] **Step 11.2: Smoke build**

```bash
docker build -t vaa-api:dev apps/api
```

Expected: image builds.

- [ ] **Step 11.3: Commit**

```bash
git add apps/api/Dockerfile
git commit -m "build(api): Dockerfile with auto migration on container start"
```

---

## Task 12: Model service stub

**Files:**
- Create: `apps/model/pyproject.toml`
- Create: `apps/model/src/vaa_model/__init__.py`
- Create: `apps/model/src/vaa_model/main.py`
- Create: `apps/model/tests/test_health.py`
- Create: `apps/model/Dockerfile`

- [ ] **Step 12.1: `apps/model/pyproject.toml`**

```toml
[project]
name = "vaa-model"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
  "fastapi==0.115.6",
  "uvicorn[standard]==0.34.0",
  "pydantic==2.10.4",
  "pydantic-settings==2.7.0",
]

[project.optional-dependencies]
dev = ["pytest==8.3.4"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/vaa_model"]
```

- [ ] **Step 12.2: Failing test `apps/model/tests/test_health.py`**

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from fastapi.testclient import TestClient

from vaa_model.main import create_app


def test_health() -> None:
    client = TestClient(create_app())
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_capabilities_empty_at_startup() -> None:
    client = TestClient(create_app())
    r = client.get("/capabilities")
    assert r.status_code == 200
    assert r.json() == {"models": []}
```

- [ ] **Step 12.3: Run, verify failure**

```bash
cd apps/model
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
pytest tests -v
```

Expected: FAIL

- [ ] **Step 12.4: Implement `apps/model/src/vaa_model/main.py`**

```python
from fastapi import FastAPI


def create_app() -> FastAPI:
    app = FastAPI(title="VisualAutoAnnotator Model Service", version="0.1.0")

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/capabilities")
    def capabilities() -> dict[str, list[str]]:
        # Plan 05 will populate this with actual models loaded in VRAM.
        return {"models": []}

    return app


app = create_app()
```

`apps/model/src/vaa_model/__init__.py`:

```python
__version__ = "0.1.0"
```

- [ ] **Step 12.5: Run, verify pass**

```bash
pytest tests -v
```

Expected: 2 PASS

- [ ] **Step 12.6: `apps/model/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.7
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY pyproject.toml ./
RUN pip install -e .
COPY src ./src
ENV PYTHONPATH=/app/src
EXPOSE 8100
CMD ["uvicorn", "vaa_model.main:app", "--host", "0.0.0.0", "--port", "8100"]
```

- [ ] **Step 12.7: Commit**

```bash
git add apps/model
git commit -m "feat(model): stub FastAPI service with /health and /capabilities"
```

---

## Task 13: Web — Vite + React + TS skeleton

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/App.tsx`
- Create: `apps/web/src/styles/global.css`
- Create: `apps/web/Dockerfile`

- [ ] **Step 13.1: `apps/web/package.json`**

```json
{
  "name": "vaa-web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview --port 4173 --host",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@tanstack/react-query": "5.62.0",
    "@tanstack/react-router": "1.95.0",
    "axios": "1.7.9",
    "react": "19.0.0",
    "react-dom": "19.0.0",
    "zustand": "5.0.2"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "6.6.3",
    "@testing-library/react": "16.1.0",
    "@types/react": "19.0.2",
    "@types/react-dom": "19.0.2",
    "@vitejs/plugin-react": "4.3.4",
    "jsdom": "25.0.1",
    "tailwindcss": "4.0.0",
    "typescript": "5.7.2",
    "vite": "6.0.5",
    "vitest": "2.1.8"
  }
}
```

- [ ] **Step 13.2: `apps/web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["vite/client", "vitest/globals", "@testing-library/jest-dom"],
    "baseUrl": "./src",
    "paths": { "@/*": ["*"] }
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 13.3: `apps/web/vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": "/src",
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
  },
});
```

- [ ] **Step 13.4: `apps/web/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>VisualAutoAnnotator</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 13.5: `apps/web/src/styles/global.css`**

```css
@import "tailwindcss";

:root {
  color-scheme: dark;
  --color-bg: oklch(15% 0.01 250);
  --color-fg: oklch(96% 0.005 250);
  --color-accent: oklch(72% 0.15 220);
}
html, body, #root { height: 100%; }
body {
  margin: 0;
  background: var(--color-bg);
  color: var(--color-fg);
  font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
}
```

- [ ] **Step 13.6: `apps/web/src/App.tsx`**

```tsx
export default function App() {
  return (
    <main style={{ padding: 32 }}>
      <h1>VisualAutoAnnotator</h1>
      <p>Foundation skeleton ready. Auth UI loads in Task 15.</p>
    </main>
  );
}
```

- [ ] **Step 13.7: `apps/web/src/main.tsx`** (initial — replaced in Task 15)

```tsx
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/global.css";

const el = document.getElementById("root");
if (!el) throw new Error("root element not found");
createRoot(el).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

- [ ] **Step 13.8: `apps/web/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
RUN printf 'server {\n  listen 80;\n  server_name _;\n  root /usr/share/nginx/html;\n  index index.html;\n  location / { try_files $uri /index.html; }\n}\n' > /etc/nginx/conf.d/default.conf
EXPOSE 80
```

- [ ] **Step 13.9: Smoke build**

```bash
cd apps/web
npm install
npm run build
```

Expected: `dist/` produced.

- [ ] **Step 13.10: Commit**

```bash
git add apps/web/package.json apps/web/tsconfig.json apps/web/vite.config.ts
git add apps/web/index.html apps/web/src apps/web/Dockerfile
git commit -m "feat(web): Vite+React+TS skeleton with proxy to API"
```

---

## Task 14: Web — auth store + axios client

**Files:**
- Create: `apps/web/src/api/client.ts`
- Create: `apps/web/src/auth/store.ts`
- Create: `apps/web/src/auth/api.ts`
- Create: `apps/web/tests/setup.ts`
- Create: `apps/web/tests/auth-store.test.ts`

- [ ] **Step 14.1: Failing test `apps/web/tests/auth-store.test.ts`**

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { useAuth } from "@/auth/store";

describe("auth store", () => {
  beforeEach(() => {
    useAuth.getState().clear();
    localStorage.clear();
  });

  it("starts unauthenticated", () => {
    const s = useAuth.getState();
    expect(s.accessToken).toBeNull();
    expect(s.user).toBeNull();
  });

  it("stores tokens and user after setSession", () => {
    useAuth.getState().setSession({
      accessToken: "a.b.c",
      refreshToken: "r.s.t",
      user: { id: "1", email: "u@x.com", role: "member" },
    });
    const s = useAuth.getState();
    expect(s.accessToken).toBe("a.b.c");
    expect(s.refreshToken).toBe("r.s.t");
    expect(s.user?.email).toBe("u@x.com");
  });

  it("persists tokens to localStorage", () => {
    useAuth.getState().setSession({
      accessToken: "a",
      refreshToken: "r",
      user: { id: "1", email: "u@x.com", role: "member" },
    });
    expect(localStorage.getItem("vaa.accessToken")).toBe("a");
    expect(localStorage.getItem("vaa.refreshToken")).toBe("r");
  });

  it("clear removes tokens and user", () => {
    useAuth.getState().setSession({
      accessToken: "a",
      refreshToken: "r",
      user: { id: "1", email: "u@x.com", role: "member" },
    });
    useAuth.getState().clear();
    expect(useAuth.getState().accessToken).toBeNull();
    expect(localStorage.getItem("vaa.accessToken")).toBeNull();
  });
});
```

- [ ] **Step 14.2: `apps/web/tests/setup.ts`**

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 14.3: Run, verify failure**

```bash
cd apps/web
npm test -- --run
```

Expected: FAIL

- [ ] **Step 14.4: Implement `apps/web/src/auth/store.ts`**

```ts
import { create } from "zustand";

export type Role = "admin" | "member" | "viewer";

export interface User {
  id: string;
  email: string;
  role: Role;
}

interface Session {
  accessToken: string;
  refreshToken: string;
  user: User;
}

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  user: User | null;
  setSession: (s: Session) => void;
  setAccessToken: (t: string) => void;
  clear: () => void;
}

const ACCESS_KEY = "vaa.accessToken";
const REFRESH_KEY = "vaa.refreshToken";
const USER_KEY = "vaa.user";

function readUser(): User | null {
  const raw = localStorage.getItem(USER_KEY);
  return raw ? (JSON.parse(raw) as User) : null;
}

export const useAuth = create<AuthState>((set) => ({
  accessToken: localStorage.getItem(ACCESS_KEY),
  refreshToken: localStorage.getItem(REFRESH_KEY),
  user: readUser(),
  setSession: (s) => {
    localStorage.setItem(ACCESS_KEY, s.accessToken);
    localStorage.setItem(REFRESH_KEY, s.refreshToken);
    localStorage.setItem(USER_KEY, JSON.stringify(s.user));
    set({ accessToken: s.accessToken, refreshToken: s.refreshToken, user: s.user });
  },
  setAccessToken: (t) => {
    localStorage.setItem(ACCESS_KEY, t);
    set({ accessToken: t });
  },
  clear: () => {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(USER_KEY);
    set({ accessToken: null, refreshToken: null, user: null });
  },
}));
```

- [ ] **Step 14.5: Run, verify pass**

```bash
npm test -- --run
```

Expected: 4 PASS

- [ ] **Step 14.6: Implement `apps/web/src/api/client.ts`**

```ts
import axios, { AxiosError, type AxiosInstance } from "axios";
import { useAuth } from "@/auth/store";

const baseURL = import.meta.env.VITE_API_BASE ?? "/api";

export const api: AxiosInstance = axios.create({ baseURL });

api.interceptors.request.use((config) => {
  const token = useAuth.getState().accessToken;
  if (token) {
    config.headers ??= {};
    (config.headers as Record<string, string>).Authorization = `Bearer ${token}`;
  }
  return config;
});

let refreshing: Promise<string | null> | null = null;

api.interceptors.response.use(
  (r) => r,
  async (error: AxiosError) => {
    const original = error.config as (typeof error.config & { __retried?: boolean }) | undefined;
    if (error.response?.status === 401 && original && !original.__retried) {
      const refresh = useAuth.getState().refreshToken;
      if (!refresh) {
        useAuth.getState().clear();
        return Promise.reject(error);
      }
      refreshing ??= (async () => {
        try {
          const r = await axios.post(`${baseURL}/auth/refresh`, { refresh_token: refresh });
          useAuth.getState().setAccessToken(r.data.access_token);
          return r.data.access_token as string;
        } catch {
          useAuth.getState().clear();
          return null;
        } finally {
          refreshing = null;
        }
      })();
      const newToken = await refreshing;
      if (!newToken) return Promise.reject(error);
      original.__retried = true;
      original.headers ??= {};
      (original.headers as Record<string, string>).Authorization = `Bearer ${newToken}`;
      return api.request(original);
    }
    return Promise.reject(error);
  },
);
```

- [ ] **Step 14.7: Implement `apps/web/src/auth/api.ts`**

```ts
import { api } from "@/api/client";
import { useAuth, type User } from "./store";

interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: string;
}

export async function register(email: string, password: string): Promise<User> {
  const r = await api.post<User>("/auth/register", { email, password });
  return r.data;
}

export async function login(email: string, password: string): Promise<void> {
  const tokens = (await api.post<TokenPair>("/auth/login", { email, password })).data;
  const me = (
    await api.get<User>("/auth/me", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
  ).data;
  useAuth.getState().setSession({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    user: me,
  });
}

export function logout(): void {
  useAuth.getState().clear();
}
```

- [ ] **Step 14.8: Commit**

```bash
git add apps/web/src/api apps/web/src/auth apps/web/tests
git commit -m "feat(web): zustand auth store + axios client with refresh interceptor"
```

---

## Task 15: Web — login & register pages with router

**Files:**
- Create: `apps/web/src/auth/LoginPage.tsx`
- Create: `apps/web/src/auth/RegisterPage.tsx`
- Create: `apps/web/src/auth/RequireAuth.tsx`
- Create: `apps/web/src/routes/_root.tsx`
- Create: `apps/web/src/routes/index.tsx`
- Create: `apps/web/src/routes/login.tsx`
- Create: `apps/web/src/routes/register.tsx`
- Modify: `apps/web/src/main.tsx`
- Create: `apps/web/tests/login-page.test.tsx`

- [ ] **Step 15.1: Failing test `apps/web/tests/login-page.test.tsx`**

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { LoginPage } from "@/auth/LoginPage";

vi.mock("@/auth/api", () => ({
  login: vi.fn(),
  register: vi.fn(),
  logout: vi.fn(),
}));

import * as authApi from "@/auth/api";

describe("LoginPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("submits credentials", async () => {
    (authApi.login as any).mockResolvedValue(undefined);
    render(<LoginPage onSuccess={() => {}} />);
    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: "u@example.com" },
    });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: "hunter22" },
    });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => {
      expect(authApi.login).toHaveBeenCalledWith("u@example.com", "hunter22");
    });
  });

  it("shows error on rejection", async () => {
    (authApi.login as any).mockRejectedValue({
      response: { data: { error: "invalid_credentials" } },
    });
    render(<LoginPage onSuccess={() => {}} />);
    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: "u@example.com" },
    });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: "wrong" },
    });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    expect(await screen.findByText(/invalid/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 15.2: Implement `apps/web/src/auth/LoginPage.tsx`**

```tsx
import { useState } from "react";
import { login } from "./api";

interface Props {
  onSuccess: () => void;
}

export function LoginPage({ onSuccess }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email, password);
      onSuccess();
    } catch (err: any) {
      const code = err?.response?.data?.error ?? "unknown_error";
      setError(code === "invalid_credentials" ? "Invalid email or password." : code);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} style={{ maxWidth: 360, margin: "8vh auto", display: "grid", gap: 12 }}>
      <h1>Sign in</h1>
      <label>
        Email
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label>
        Password
        <input
          type="password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {error && (
        <div role="alert" style={{ color: "tomato" }}>
          {error}
        </div>
      )}
      <button type="submit" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
```

- [ ] **Step 15.3: Implement `apps/web/src/auth/RegisterPage.tsx`**

```tsx
import { useState } from "react";
import { login, register } from "./api";

interface Props {
  onSuccess: () => void;
}

export function RegisterPage({ onSuccess }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await register(email, password);
      await login(email, password);
      onSuccess();
    } catch (err: any) {
      const code = err?.response?.data?.error ?? "unknown_error";
      setError(code === "email_taken" ? "That email is already registered." : code);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} style={{ maxWidth: 360, margin: "8vh auto", display: "grid", gap: 12 }}>
      <h1>Create account</h1>
      <label>
        Email
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label>
        Password (min 8)
        <input
          type="password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {error && (
        <div role="alert" style={{ color: "tomato" }}>
          {error}
        </div>
      )}
      <button type="submit" disabled={busy}>
        {busy ? "Creating…" : "Create account"}
      </button>
    </form>
  );
}
```

- [ ] **Step 15.4: Implement `apps/web/src/auth/RequireAuth.tsx`**

```tsx
import type { ReactNode } from "react";
import { Navigate } from "@tanstack/react-router";
import { useAuth } from "./store";

export function RequireAuth({ children }: { children: ReactNode }) {
  const token = useAuth((s) => s.accessToken);
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}
```

- [ ] **Step 15.5: Routes**

`apps/web/src/routes/_root.tsx`:

```tsx
import { Outlet, createRootRoute } from "@tanstack/react-router";

export const rootRoute = createRootRoute({
  component: () => (
    <div>
      <Outlet />
    </div>
  ),
});
```

`apps/web/src/routes/index.tsx`:

```tsx
import { createRoute, useNavigate } from "@tanstack/react-router";
import { rootRoute } from "./_root";
import { useAuth } from "@/auth/store";
import { logout } from "@/auth/api";
import { RequireAuth } from "@/auth/RequireAuth";

function Home() {
  const user = useAuth((s) => s.user);
  const nav = useNavigate();
  return (
    <main style={{ padding: 32 }}>
      <h1>VisualAutoAnnotator</h1>
      <p>
        Signed in as {user?.email} ({user?.role})
      </p>
      <button
        onClick={() => {
          logout();
          nav({ to: "/login" });
        }}
      >
        Sign out
      </button>
    </main>
  );
}

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => (
    <RequireAuth>
      <Home />
    </RequireAuth>
  ),
});
```

`apps/web/src/routes/login.tsx`:

```tsx
import { Link, createRoute, useNavigate } from "@tanstack/react-router";
import { rootRoute } from "./_root";
import { LoginPage } from "@/auth/LoginPage";

function LoginRoute() {
  const nav = useNavigate();
  return (
    <div>
      <LoginPage onSuccess={() => nav({ to: "/" })} />
      <p style={{ textAlign: "center" }}>
        No account? <Link to="/register">Create one</Link>
      </p>
    </div>
  );
}

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginRoute,
});
```

`apps/web/src/routes/register.tsx`:

```tsx
import { Link, createRoute, useNavigate } from "@tanstack/react-router";
import { rootRoute } from "./_root";
import { RegisterPage } from "@/auth/RegisterPage";

function RegisterRoute() {
  const nav = useNavigate();
  return (
    <div>
      <RegisterPage onSuccess={() => nav({ to: "/" })} />
      <p style={{ textAlign: "center" }}>
        Have an account? <Link to="/login">Sign in</Link>
      </p>
    </div>
  );
}

export const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/register",
  component: RegisterRoute,
});
```

- [ ] **Step 15.6: Replace `apps/web/src/main.tsx`**

```tsx
import React from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { rootRoute } from "./routes/_root";
import { indexRoute } from "./routes/index";
import { loginRoute } from "./routes/login";
import { registerRoute } from "./routes/register";
import "./styles/global.css";

const routeTree = rootRoute.addChildren([indexRoute, loginRoute, registerRoute]);
const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const el = document.getElementById("root");
if (!el) throw new Error("root element not found");
createRoot(el).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
```

- [ ] **Step 15.7: Run all web tests**

```bash
cd apps/web
npm test -- --run
```

Expected: all green

- [ ] **Step 15.8: Manual smoke**

```bash
npm run dev &
# Open http://localhost:5173/login in a browser
```

Expected: login form renders.

- [ ] **Step 15.9: Commit**

```bash
git add apps/web/src/auth apps/web/src/routes apps/web/src/main.tsx apps/web/tests/login-page.test.tsx
git commit -m "feat(web): login + register pages, RequireAuth guard, TanStack Router setup"
```

---

## Task 16: Caddy reverse proxy

**Files:**
- Create: `infra/caddy/Caddyfile`

- [ ] **Step 16.1: Write `infra/caddy/Caddyfile`**

```caddyfile
{
  email admin@localhost
  auto_https off
}

:80, :443 {
  encode zstd gzip

  @api path /api/*
  handle @api {
    uri strip_prefix /api
    reverse_proxy api:8000
  }

  @model path /model/*
  handle @model {
    uri strip_prefix /model
    reverse_proxy model:8100
  }

  handle {
    reverse_proxy web:80
  }

  log {
    output stdout
    format console
  }
}
```

- [ ] **Step 16.2: Commit**

```bash
git add infra/caddy/Caddyfile
git commit -m "infra: Caddy reverse proxy for /api, /model, and the web SPA"
```

---

## Task 17: docker-compose.yml — full stack

**Files:**
- Create: `docker-compose.yml`
- Create: `docker-compose.override.yml`

- [ ] **Step 17.1: `docker-compose.yml`**

```yaml
name: vaa
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes:
      - pg_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 5s
      timeout: 3s
      retries: 10

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10

  minio:
    image: minio/minio:RELEASE.2025-02-07T23-21-09Z
    restart: unless-stopped
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}
    volumes:
      - minio_data:/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 10s
      timeout: 3s
      retries: 5

  api:
    build: ./apps/api
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
      POSTGRES_HOST: postgres
      POSTGRES_PORT: 5432
      REDIS_HOST: redis
      REDIS_PORT: 6379
      JWT_SECRET: ${JWT_SECRET}
      PASSWORD_PEPPER: ${PASSWORD_PEPPER}
      JWT_ACCESS_TTL_MIN: ${JWT_ACCESS_TTL_MIN:-15}
      JWT_REFRESH_TTL_DAYS: ${JWT_REFRESH_TTL_DAYS:-14}
      CORS_ORIGINS: ${CORS_ORIGINS:-}
      API_ENV: ${API_ENV:-development}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy

  model:
    build: ./apps/model
    restart: unless-stopped
    environment:
      MODEL_HOST: 0.0.0.0
      MODEL_PORT: 8100

  web:
    build: ./apps/web
    restart: unless-stopped

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./infra/caddy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - api
      - model
      - web

volumes:
  pg_data:
  redis_data:
  minio_data:
  caddy_data:
  caddy_config:
```

- [ ] **Step 17.2: `docker-compose.override.yml`**

```yaml
services:
  postgres:
    ports: ["5432:5432"]
  redis:
    ports: ["6379:6379"]
  minio:
    ports:
      - "9000:9000"
      - "9001:9001"
  api:
    ports: ["8000:8000"]
    volumes:
      - ./apps/api/src:/app/src
      - ./apps/api/alembic:/app/alembic
    command: ["bash", "-c", "alembic upgrade head && uvicorn vaa_api.main:app --host 0.0.0.0 --port 8000 --reload"]
  model:
    ports: ["8100:8100"]
    volumes:
      - ./apps/model/src:/app/src
    command: ["uvicorn", "vaa_model.main:app", "--host", "0.0.0.0", "--port", "8100", "--reload"]
  web:
    ports: ["5173:80"]
```

- [ ] **Step 17.3: Smoke `docker compose up`**

```bash
cp .env.example .env
sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 32)|" .env
sed -i "s|^PASSWORD_PEPPER=.*|PASSWORD_PEPPER=$(openssl rand -hex 16)|" .env
docker compose up -d --build
docker compose ps
```

Wait until everything is healthy, then:

```bash
curl -s http://localhost:8000/health        # → {"status":"ok"}
curl -s http://localhost:8100/health        # → {"status":"ok"}
curl -s http://localhost/api/health         # → {"status":"ok"} (via Caddy)
```

Then exercise auth:

```bash
curl -s -X POST http://localhost:8000/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"hunter22"}'

LOGIN=$(curl -s -X POST http://localhost:8000/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"hunter22"}')
ACCESS=$(echo "$LOGIN" | jq -r .access_token)
curl -s http://localhost:8000/auth/me -H "Authorization: Bearer $ACCESS"
```

Expected: 201 → 200 → 200 with `role: "admin"`.

- [ ] **Step 17.4: Commit**

```bash
git add docker-compose.yml docker-compose.override.yml
git commit -m "infra: docker-compose stack — postgres, redis, minio, api, model, web, caddy"
```

---

## Task 18: README quickstart

**Files:**
- Create: `README.md`

- [ ] **Step 18.1: `README.md`**

````markdown
# VisualAutoAnnotator

On-prem, web-based annotation editor for computer-vision datasets — detection, segmentation, classification — with auto-annotation (custom YOLO weights), interactive smart annotation (SAM 2/3), and video object tracking.

> **Status:** in development. See [the design spec](docs/superpowers/specs/2026-04-25-visual-auto-annotator-design.md) and the [implementation plans](docs/superpowers/plans/) for the per-sprint breakdown.

## Quickstart (development)

Requirements: Docker 26+, Docker Compose v2, ~12 GB free disk for images. An NVIDIA GPU + NVIDIA Container Toolkit will be required from Plan 05 onward.

```bash
git clone <this repo>
cd VisualAutoAnnotator
cp .env.example .env
sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 32)|" .env
sed -i "s|^PASSWORD_PEPPER=.*|PASSWORD_PEPPER=$(openssl rand -hex 16)|" .env

docker compose up -d --build
```

Once healthy:

- Web app: <http://localhost>
- API docs: <http://localhost/api/docs>
- MinIO console: <http://localhost:9001>

The first registered user becomes the admin.

## Repository layout

| Path | What it is |
|---|---|
| `apps/api`    | FastAPI app service |
| `apps/model`  | FastAPI inference service |
| `apps/web`    | React + Vite + TS frontend |
| `infra/caddy` | Caddy reverse-proxy config |
| `docs/superpowers/specs` | Design specs |
| `docs/superpowers/plans` | Implementation plans |

## Local development without Docker

```bash
# API
cd apps/api && python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
alembic upgrade head
uvicorn vaa_api.main:app --reload --port 8000

# Model
cd apps/model && python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
uvicorn vaa_model.main:app --reload --port 8100

# Web
cd apps/web && npm install && npm run dev
```

The web dev server proxies `/api` → `http://localhost:8000`.

## Tests

```bash
cd apps/api && pytest
cd apps/model && pytest
cd apps/web && npm test
```

## Architecture

Three Docker services on one machine: a FastAPI **app service** (Postgres + Redis + MinIO + REST/WS), a FastAPI **model service** pinned to the GPU (SAM, YOLO, encode/decode/predict endpoints), and a Vite-built React **web service** behind Caddy. The browser SAM decoder runs in WebGPU so click-to-mask is < 30 ms after the encoder runs once on the server.

## License

TBD.
````

- [ ] **Step 18.2: Commit**

```bash
git add README.md
git commit -m "docs: README quickstart, repository layout, dev guide"
```

---

## Task 19: Smoke script

**Files:**
- Create: `scripts/smoke.sh`

- [ ] **Step 19.1: Write `scripts/smoke.sh`**

```bash
#!/usr/bin/env bash
# End-to-end smoke test: register, login, /me, refresh, /admin/ping.
set -euo pipefail

API="${API:-http://localhost:8000}"
EMAIL="smoke-$(date +%s)@example.com"
PASS="hunter22-smoke"

echo ">>> health"
curl -fsS "$API/health" | jq

echo ">>> register"
curl -fsS -X POST "$API/auth/register" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" | jq

echo ">>> login"
TOK=$(curl -fsS -X POST "$API/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}")
ACCESS=$(echo "$TOK" | jq -r .access_token)
REFRESH=$(echo "$TOK" | jq -r .refresh_token)

echo ">>> /auth/me"
curl -fsS "$API/auth/me" -H "Authorization: Bearer $ACCESS" | jq

echo ">>> /auth/refresh"
NEW=$(curl -fsS -X POST "$API/auth/refresh" \
  -H 'content-type: application/json' \
  -d "{\"refresh_token\":\"$REFRESH\"}" | jq -r .access_token)
echo "new access token starts with: ${NEW:0:20}..."

echo ">>> /admin/ping"
HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$API/admin/ping" \
  -H "Authorization: Bearer $ACCESS")
echo "got $HTTP"

echo ">>> done"
```

- [ ] **Step 19.2: `chmod +x` and run**

```bash
chmod +x scripts/smoke.sh
docker compose up -d --build
./scripts/smoke.sh
```

Expected: each step prints JSON; `/admin/ping` returns 200 if the smoke script's user is the very first user, else 403.

- [ ] **Step 19.3: Commit**

```bash
git add scripts/smoke.sh
git commit -m "test: end-to-end smoke script for register/login/refresh/me/admin"
```

---

## Task 20: Tag the milestone

- [ ] **Step 20.1: Tag and verify history**

```bash
git tag -a v0.1.0-foundation -m "Plan 01 complete: docker compose stack with multi-user auth"
git log --oneline | head -25
```

Expected: ~20 conventional commits ending at the foundation tag.

---

## Self-Review Notes (author)

**Spec coverage cross-check** (each spec section → which task implements it):

| Spec § | Implemented in |
|---|---|
| §6 architecture (3 services on 1 box) | Tasks 11, 12, 13, 16, 17 |
| §14 auth (multi-user, Admin/Member/Viewer, JWT, Argon2id) | Tasks 5–10 |
| §15 tech stack (FastAPI, Postgres 16, Redis 7, MinIO, React 19, Vite 6, TanStack Router) | Tasks 3, 13, 17 |
| §16 deployment (`docker compose up`) | Task 17 (gpu profile lands in Plan 05) |
| §17 security (Argon2id pepper) | Task 5 ✓; CSP/rate-limit pushed to Plan 08 |
| §3a confirmed multi-user from day 1 | Tasks 7–10 |

Sections explicitly **not** implemented in this plan and pushed forward (with the plan that implements them):
- Projects/Tasks/Classes CRUD → **Plan 02**
- Asset upload, content hashing, MinIO bucket setup → **Plan 03**
- Annotation canvas + tools → **Plan 04**
- YOLO + SAM inference → **Plan 05**
- Annotation import/export with class remap → **Plan 06**
- Analytics dashboards → **Plan 07**
- TLS + first-run wizard + backups + CSP + rate limit → **Plan 08**

**Placeholder scan:** README "License: TBD" is the only TBD; deliberate per spec §23.

**Type consistency:** `User`, `UserRole`, `Session`, `TokenPair`, `RegisterIn`, `LoginIn`, `RefreshIn`, `UserOut` all match between API code, schemas, and frontend store interfaces.
