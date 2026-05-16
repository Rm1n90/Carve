# Class Digit Shortcuts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each user, per project, bind digits 1–9 to any 9 of the project's classes via `Shift+digit`. Visible `[N]` badge in the Classes panel. Defaults seed to first nine classes by `class.idx` so today's behaviour is preserved.

**Architecture:** New `class_keybindings` table (PK `(user_id, project_id, digit)`, UNIQUE `(user_id, project_id, class_id)`). Three REST endpoints under the projects router. Single source of truth in a new `effectiveBindings(stored, classes)` helper on the frontend, consumed by `ClassesPanel` (rendering + plain-digit activation) and `AnnotationCanvas` (SAM commit-with-digit). One window-level keydown handler in `ClassesPanel` handles bind / unbind / activate.

**Tech Stack:** FastAPI + SQLAlchemy + Alembic + Pydantic (backend); React 18 + TanStack Query + Zustand + Vitest (frontend). Tests with pytest (backend) and vitest (frontend).

**Spec:** `docs/superpowers/specs/2026-05-16-class-digit-shortcuts-design.md`

---

## File Structure

### Created

| Path | Responsibility |
|---|---|
| `apps/api/alembic/versions/0033_class_keybindings.py` | Alembic migration creating the `class_keybindings` table |
| `apps/api/src/carve_api/projects/keybindings.py` | SQLAlchemy model + Pydantic schemas + service helpers for read/write/seed composition |
| `apps/api/tests/projects/test_class_keybindings.py` | Pytest coverage for migration model + service + router (GET/PUT/DELETE) |
| `apps/web/src/api/keybindings.ts` | Typed REST client for the three endpoints |
| `apps/web/src/lib/class-keybindings.ts` | Pure `effectiveBindings(stored, classes)` helper |
| `apps/web/tests/class-keybindings-effective.test.ts` | Vitest for the pure helper |
| `apps/web/tests/class-keybindings-keyboard.test.tsx` | Vitest for the bind / unbind / activate keyboard contract |

### Modified

| Path | Responsibility |
|---|---|
| `apps/api/src/carve_api/projects/models.py` | Add `ClassKeybinding` SQLAlchemy model |
| `apps/api/src/carve_api/projects/schemas.py` | Add `ClassKeybindingOut` and `ClassKeybindingPutIn` |
| `apps/api/src/carve_api/projects/router.py` | Register the three new endpoints |
| `apps/web/src/components/annotation/ClassesPanel.tsx:913-925` | Replace static `classes[n-1]` digit handler with shared `effectiveBindings` lookup + Shift+digit bind/unbind; render `<Kbd>` badge per row |
| `apps/web/src/components/annotation/AnnotationCanvas.tsx:3725-3734` | Replace `c.idx === digit - 1` with `effectiveBindings[digit]` lookup |
| `apps/web/src/pages/AnnotateAssetPage.tsx` | Add the keybindings TanStack query + thread the result into `ClassesPanel` and `AnnotationCanvas` |

---

## Task 1: Alembic migration

**Files:**
- Create: `apps/api/alembic/versions/0033_class_keybindings.py`

- [ ] **Step 1: Write the migration**

```python
"""class_keybindings: per-user, per-project digit shortcut bindings.

Revision ID: 0033
Revises: 0032
Create Date: 2026-05-16

Adds the ``class_keybindings`` table so each user can bind digits 1-9
to any 9 of a project's classes. PK ``(user_id, project_id, digit)``
allows one class per digit per user-project. UNIQUE ``(user_id,
project_id, class_id)`` enforces one digit per class so the same class
never shows two ``[N]`` badges. ON DELETE CASCADE on project_id and
class_id keeps the table consistent without app-level cleanup.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0033"
down_revision: str | Sequence[str] | None = "0032"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "class_keybindings",
        sa.Column("user_id", sa.dialects.postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("project_id", sa.dialects.postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("digit", sa.SmallInteger(), nullable=False),
        sa.Column("class_id", sa.dialects.postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(
            ["project_id"], ["projects.id"], ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["class_id"], ["classes.id"], ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint(
            "user_id", "project_id", "digit",
            name="pk_class_keybindings",
        ),
        sa.UniqueConstraint(
            "user_id", "project_id", "class_id",
            name="uq_class_keybindings_user_project_class",
        ),
        sa.CheckConstraint(
            "digit BETWEEN 1 AND 9",
            name="ck_class_keybindings_digit_range",
        ),
    )
    op.create_index(
        "ix_class_keybindings_user_project",
        "class_keybindings",
        ["user_id", "project_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_class_keybindings_user_project",
        table_name="class_keybindings",
    )
    op.drop_table("class_keybindings")
```

- [ ] **Step 2: Run migration locally**

```bash
cd apps/api && source .venv/bin/activate && alembic upgrade head
```

Expected: `INFO  [alembic.runtime.migration] Running upgrade 0032 -> 0033`

- [ ] **Step 3: Verify schema in psql**

```bash
docker compose exec postgres psql -U carve -d carve -c "\d class_keybindings"
```

Expected: the table prints with PK `(user_id, project_id, digit)`, UNIQUE on `(user_id, project_id, class_id)`, CHECK on digit range, and the index on `(user_id, project_id)`.

- [ ] **Step 4: Verify downgrade works**

```bash
cd apps/api && source .venv/bin/activate && alembic downgrade -1 && alembic upgrade head
```

Expected: clean down then back up, no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/alembic/versions/0033_class_keybindings.py
git commit -m "feat(db): add class_keybindings table"
```

---

## Task 2: SQLAlchemy model

**Files:**
- Modify: `apps/api/src/carve_api/projects/models.py`

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/projects/test_class_keybindings.py` (the file will be extended in later tasks):

```python
"""Tests for the class_keybindings table + service + router."""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy.exc import IntegrityError

from carve_api.projects.models import Class, ClassKeybinding, Project
from carve_api.auth.models import User


@pytest.fixture
def fixture_project_with_classes(db_session):
    """Builds a User, a Project, and 3 Class rows. Returns the triplet."""
    user = User(
        id=uuid.uuid4(), email="t@test", display_name="T",
        hashed_password="x",
    )
    project = Project(id=uuid.uuid4(), name="P", owner_id=user.id)
    db_session.add_all([user, project])
    db_session.flush()
    classes = [
        Class(
            id=uuid.uuid4(), project_id=project.id,
            idx=i, name=f"c{i}", color="#abcdef",
        )
        for i in range(3)
    ]
    db_session.add_all(classes)
    db_session.commit()
    return user, project, classes


def test_class_keybinding_persists(db_session, fixture_project_with_classes):
    user, project, classes = fixture_project_with_classes
    db_session.add(ClassKeybinding(
        user_id=user.id, project_id=project.id,
        digit=1, class_id=classes[0].id,
    ))
    db_session.commit()
    rows = db_session.query(ClassKeybinding).all()
    assert len(rows) == 1
    assert rows[0].digit == 1


def test_unique_class_per_user_project(
    db_session, fixture_project_with_classes,
):
    """The UNIQUE (user, project, class_id) constraint forbids binding
    the same class to two digits — that's the "one digit per class"
    contract from the spec."""
    user, project, classes = fixture_project_with_classes
    db_session.add(ClassKeybinding(
        user_id=user.id, project_id=project.id,
        digit=1, class_id=classes[0].id,
    ))
    db_session.commit()
    db_session.add(ClassKeybinding(
        user_id=user.id, project_id=project.id,
        digit=2, class_id=classes[0].id,
    ))
    with pytest.raises(IntegrityError):
        db_session.commit()
    db_session.rollback()


def test_digit_range_check(db_session, fixture_project_with_classes):
    user, project, classes = fixture_project_with_classes
    db_session.add(ClassKeybinding(
        user_id=user.id, project_id=project.id,
        digit=10, class_id=classes[0].id,
    ))
    with pytest.raises(IntegrityError):
        db_session.commit()
    db_session.rollback()


def test_class_delete_cascades(db_session, fixture_project_with_classes):
    user, project, classes = fixture_project_with_classes
    db_session.add(ClassKeybinding(
        user_id=user.id, project_id=project.id,
        digit=1, class_id=classes[0].id,
    ))
    db_session.commit()
    db_session.delete(classes[0])
    db_session.commit()
    assert db_session.query(ClassKeybinding).count() == 0
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api && source .venv/bin/activate && python -m pytest tests/projects/test_class_keybindings.py -v
```

Expected: ImportError `cannot import name 'ClassKeybinding' from 'carve_api.projects.models'`.

- [ ] **Step 3: Add the model**

Open `apps/api/src/carve_api/projects/models.py` and append after the existing `Class` class (before `ProjectMember`):

```python
class ClassKeybinding(Base):
    """Per-user, per-project digit→class shortcut binding.

    See docs/superpowers/specs/2026-05-16-class-digit-shortcuts-design.md.
    PK ``(user_id, project_id, digit)``; UNIQUE
    ``(user_id, project_id, class_id)`` enforces one digit per class.
    CASCADE on project_id and class_id keeps the table consistent.
    """

    __tablename__ = "class_keybindings"
    __table_args__ = (
        UniqueConstraint(
            "user_id", "project_id", "class_id",
            name="uq_class_keybindings_user_project_class",
        ),
        CheckConstraint(
            "digit BETWEEN 1 AND 9",
            name="ck_class_keybindings_digit_range",
        ),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id"),
        primary_key=True,
        nullable=False,
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        primary_key=True,
        nullable=False,
    )
    digit: Mapped[int] = mapped_column(
        SmallInteger,
        primary_key=True,
        nullable=False,
    )
    class_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("classes.id", ondelete="CASCADE"),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
```

Also ensure the file's existing imports include `CheckConstraint` and `SmallInteger`. The existing imports already include `UniqueConstraint`, `ForeignKey`, `UUID`, `Mapped`, `mapped_column`, `DateTime`, `func`, `Integer`, `String`, `JSONB`, etc. — add the missing ones to the same `from sqlalchemy import` line:

```python
from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    JSON,
    SmallInteger,
    String,
    UniqueConstraint,
    func,
)
```

(Adjust to match the exact existing import list; only `CheckConstraint` and `SmallInteger` are new additions.)

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/api && source .venv/bin/activate && python -m pytest tests/projects/test_class_keybindings.py -v
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/carve_api/projects/models.py apps/api/tests/projects/test_class_keybindings.py
git commit -m "feat(db): add ClassKeybinding SQLAlchemy model"
```

---

## Task 3: Service layer — seed composition

**Files:**
- Create: `apps/api/src/carve_api/projects/keybindings.py`
- Modify: `apps/api/tests/projects/test_class_keybindings.py`

The service composes effective bindings (stored ∪ computed seed). Stored rows take precedence; empty digits fall back to `class.idx ASC LIMIT 9`, skipping classes already bound by a stored row so no duplicates appear.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/tests/projects/test_class_keybindings.py`:

```python
from carve_api.projects.keybindings import (
    EffectiveBinding,
    compose_effective_bindings,
    set_binding,
    delete_binding,
)


def test_compose_empty_returns_seed_of_first_nine(
    db_session, fixture_project_with_classes,
):
    """No stored rows + 3 classes → 3 seed rows in idx order."""
    user, project, classes = fixture_project_with_classes
    result = compose_effective_bindings(
        db_session, user_id=user.id, project_id=project.id,
    )
    assert result == [
        EffectiveBinding(digit=1, class_id=classes[0].id, source="seed"),
        EffectiveBinding(digit=2, class_id=classes[1].id, source="seed"),
        EffectiveBinding(digit=3, class_id=classes[2].id, source="seed"),
    ]


def test_compose_stored_takes_precedence(
    db_session, fixture_project_with_classes,
):
    user, project, classes = fixture_project_with_classes
    # Bind class[2] to digit 1 explicitly; seed would have given c[0].
    db_session.add(ClassKeybinding(
        user_id=user.id, project_id=project.id,
        digit=1, class_id=classes[2].id,
    ))
    db_session.commit()
    result = compose_effective_bindings(
        db_session, user_id=user.id, project_id=project.id,
    )
    by_digit = {b.digit: b for b in result}
    assert by_digit[1].class_id == classes[2].id
    assert by_digit[1].source == "stored"
    # classes[2] is taken by the stored row → seed must skip it on
    # other digits. The remaining seed slots get classes[0] and [1].
    assert by_digit[2].class_id == classes[0].id
    assert by_digit[2].source == "seed"
    assert by_digit[3].class_id == classes[1].id


def test_set_binding_creates(db_session, fixture_project_with_classes):
    user, project, classes = fixture_project_with_classes
    set_binding(
        db_session,
        user_id=user.id,
        project_id=project.id,
        digit=4,
        class_id=classes[0].id,
    )
    db_session.commit()
    rows = db_session.query(ClassKeybinding).all()
    assert len(rows) == 1
    assert rows[0].digit == 4
    assert rows[0].class_id == classes[0].id


def test_set_binding_moves_existing_class(
    db_session, fixture_project_with_classes,
):
    """Re-binding a class to a different digit must DELETE its old row
    in the same transaction (UNIQUE-driven move-not-duplicate)."""
    user, project, classes = fixture_project_with_classes
    set_binding(
        db_session, user_id=user.id, project_id=project.id,
        digit=1, class_id=classes[0].id,
    )
    db_session.commit()
    set_binding(
        db_session, user_id=user.id, project_id=project.id,
        digit=5, class_id=classes[0].id,
    )
    db_session.commit()
    rows = db_session.query(ClassKeybinding).all()
    assert len(rows) == 1
    assert rows[0].digit == 5


def test_set_binding_overwrites_existing_digit(
    db_session, fixture_project_with_classes,
):
    """Re-binding a digit to a different class replaces the row."""
    user, project, classes = fixture_project_with_classes
    set_binding(
        db_session, user_id=user.id, project_id=project.id,
        digit=1, class_id=classes[0].id,
    )
    db_session.commit()
    set_binding(
        db_session, user_id=user.id, project_id=project.id,
        digit=1, class_id=classes[1].id,
    )
    db_session.commit()
    rows = db_session.query(ClassKeybinding).all()
    assert len(rows) == 1
    assert rows[0].class_id == classes[1].id


def test_delete_binding_removes_row(
    db_session, fixture_project_with_classes,
):
    user, project, classes = fixture_project_with_classes
    set_binding(
        db_session, user_id=user.id, project_id=project.id,
        digit=1, class_id=classes[0].id,
    )
    db_session.commit()
    delete_binding(
        db_session, user_id=user.id, project_id=project.id, digit=1,
    )
    db_session.commit()
    assert db_session.query(ClassKeybinding).count() == 0


def test_delete_binding_idempotent(
    db_session, fixture_project_with_classes,
):
    user, project, _ = fixture_project_with_classes
    delete_binding(
        db_session, user_id=user.id, project_id=project.id, digit=7,
    )
    # No row existed; no error.
    db_session.commit()
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api && source .venv/bin/activate && python -m pytest tests/projects/test_class_keybindings.py -v
```

Expected: ImportError `cannot import name 'compose_effective_bindings' from 'carve_api.projects.keybindings'`.

- [ ] **Step 3: Write the service module**

```python
# apps/api/src/carve_api/projects/keybindings.py
"""Service helpers for class digit-shortcut keybindings.

The composition rules implement the spec's "stored ∪ computed seed"
contract:

  1. Stored rows in ``class_keybindings`` take precedence.
  2. Empty digits fall back to ``class.idx ASC LIMIT 9``, skipping
     classes already bound by a stored row.

Mutation helpers enforce the "move-not-duplicate" invariant: re-binding
a class to a different digit DELETES the prior row in the same
transaction. The UNIQUE (user_id, project_id, class_id) constraint
catches any concurrent violation.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Literal

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from carve_api.projects.models import Class, ClassKeybinding


@dataclass(frozen=True)
class EffectiveBinding:
    digit: int
    class_id: uuid.UUID
    source: Literal["stored", "seed"]


def compose_effective_bindings(
    db: Session,
    *,
    user_id: uuid.UUID,
    project_id: uuid.UUID,
) -> list[EffectiveBinding]:
    """Return the user's effective bindings for this project, with
    stored rows taking precedence over the idx-ASC seed."""
    stored_rows = db.execute(
        select(ClassKeybinding)
        .where(
            ClassKeybinding.user_id == user_id,
            ClassKeybinding.project_id == project_id,
        )
        .order_by(ClassKeybinding.digit.asc())
    ).scalars().all()
    stored_by_digit: dict[int, ClassKeybinding] = {
        r.digit: r for r in stored_rows
    }
    stored_class_ids: set[uuid.UUID] = {r.class_id for r in stored_rows}

    seed_candidates = db.execute(
        select(Class)
        .where(Class.project_id == project_id)
        .order_by(Class.idx.asc())
    ).scalars().all()
    # Drop classes already bound by a stored row so no duplicate badge.
    seed_pool = [c for c in seed_candidates if c.id not in stored_class_ids]

    out: list[EffectiveBinding] = []
    seed_iter = iter(seed_pool)
    for digit in range(1, 10):
        stored = stored_by_digit.get(digit)
        if stored is not None:
            out.append(EffectiveBinding(
                digit=digit, class_id=stored.class_id, source="stored",
            ))
            continue
        try:
            seed_class = next(seed_iter)
        except StopIteration:
            # Fewer than 9 unbound classes — this digit is empty.
            continue
        out.append(EffectiveBinding(
            digit=digit, class_id=seed_class.id, source="seed",
        ))
    return out


def set_binding(
    db: Session,
    *,
    user_id: uuid.UUID,
    project_id: uuid.UUID,
    digit: int,
    class_id: uuid.UUID,
) -> ClassKeybinding:
    """Create or move a binding.

    If the class is already bound at a different digit, that row is
    deleted in the same transaction (move-not-duplicate). If the digit
    is already bound to a different class, that row is replaced. The
    caller commits; this helper only stages.
    """
    if digit < 1 or digit > 9:
        raise ValueError(f"digit out of range: {digit}")
    # 1. Remove the class's prior binding at any other digit.
    db.execute(
        delete(ClassKeybinding)
        .where(
            ClassKeybinding.user_id == user_id,
            ClassKeybinding.project_id == project_id,
            ClassKeybinding.class_id == class_id,
            ClassKeybinding.digit != digit,
        )
    )
    # 2. Remove any prior binding at this digit (different class).
    db.execute(
        delete(ClassKeybinding)
        .where(
            ClassKeybinding.user_id == user_id,
            ClassKeybinding.project_id == project_id,
            ClassKeybinding.digit == digit,
        )
    )
    # 3. Insert the new row.
    row = ClassKeybinding(
        user_id=user_id,
        project_id=project_id,
        digit=digit,
        class_id=class_id,
    )
    db.add(row)
    return row


def delete_binding(
    db: Session,
    *,
    user_id: uuid.UUID,
    project_id: uuid.UUID,
    digit: int,
) -> None:
    """Idempotent — silently no-ops when no row exists."""
    db.execute(
        delete(ClassKeybinding)
        .where(
            ClassKeybinding.user_id == user_id,
            ClassKeybinding.project_id == project_id,
            ClassKeybinding.digit == digit,
        )
    )
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && source .venv/bin/activate && python -m pytest tests/projects/test_class_keybindings.py -v
```

Expected: all tests pass (4 from Task 2 + 7 new from this task).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/carve_api/projects/keybindings.py apps/api/tests/projects/test_class_keybindings.py
git commit -m "feat(projects): class keybinding service with seed composition"
```

---

## Task 4: REST endpoints

**Files:**
- Modify: `apps/api/src/carve_api/projects/schemas.py`
- Modify: `apps/api/src/carve_api/projects/router.py`
- Modify: `apps/api/tests/projects/test_class_keybindings.py`

- [ ] **Step 1: Write the failing test**

Append to `apps/api/tests/projects/test_class_keybindings.py`:

```python
def test_get_returns_seed_when_empty(authed_client, project_factory):
    project, _, classes = project_factory(num_classes=3)
    r = authed_client.get(f"/projects/{project.id}/class-keybindings")
    assert r.status_code == 200
    body = r.json()
    assert body == {
        "bindings": [
            {"digit": 1, "class_id": str(classes[0].id), "source": "seed"},
            {"digit": 2, "class_id": str(classes[1].id), "source": "seed"},
            {"digit": 3, "class_id": str(classes[2].id), "source": "seed"},
        ]
    }


def test_put_creates_binding(authed_client, project_factory):
    project, _, classes = project_factory(num_classes=2)
    r = authed_client.put(
        f"/projects/{project.id}/class-keybindings/1",
        json={"class_id": str(classes[1].id)},
    )
    assert r.status_code == 200
    body = r.json()
    assert body == {
        "digit": 1, "class_id": str(classes[1].id), "source": "stored",
    }


def test_put_invalid_digit_returns_422(authed_client, project_factory):
    project, _, classes = project_factory(num_classes=2)
    for bad_digit in ("0", "10", "x"):
        r = authed_client.put(
            f"/projects/{project.id}/class-keybindings/{bad_digit}",
            json={"class_id": str(classes[0].id)},
        )
        assert r.status_code == 422


def test_put_class_outside_project_returns_422(
    authed_client, project_factory,
):
    project_a, _, _ = project_factory(num_classes=1)
    project_b, _, classes_b = project_factory(num_classes=1)
    r = authed_client.put(
        f"/projects/{project_a.id}/class-keybindings/1",
        json={"class_id": str(classes_b[0].id)},
    )
    assert r.status_code == 422
    assert r.json()["detail"] == "class_not_in_project"


def test_delete_clears_binding(authed_client, project_factory):
    project, _, classes = project_factory(num_classes=2)
    authed_client.put(
        f"/projects/{project.id}/class-keybindings/3",
        json={"class_id": str(classes[0].id)},
    )
    r = authed_client.delete(
        f"/projects/{project.id}/class-keybindings/3"
    )
    assert r.status_code == 204


def test_delete_idempotent(authed_client, project_factory):
    project, _, _ = project_factory(num_classes=1)
    r = authed_client.delete(
        f"/projects/{project.id}/class-keybindings/7"
    )
    assert r.status_code == 204
```

Note: `authed_client` + `project_factory` fixtures are the standard ones already in `apps/api/tests/conftest.py`. If `project_factory` doesn't yet support `num_classes`, extend it within this task's conftest contribution.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/api && source .venv/bin/activate && python -m pytest tests/projects/test_class_keybindings.py -v
```

Expected: HTTP 404 on the new routes — they're not registered yet.

- [ ] **Step 3: Add Pydantic schemas**

Append to `apps/api/src/carve_api/projects/schemas.py`:

```python
class ClassKeybindingOut(BaseModel):
    """One row of the user's effective digit→class map for a project."""
    digit: int = Field(..., ge=1, le=9)
    class_id: uuid.UUID
    source: Literal["stored", "seed"]


class ClassKeybindingListOut(BaseModel):
    bindings: list[ClassKeybindingOut]


class ClassKeybindingPutIn(BaseModel):
    class_id: uuid.UUID
```

If `Literal` isn't already imported in `schemas.py`, add it: `from typing import Literal`.

- [ ] **Step 4: Wire up the router**

Open `apps/api/src/carve_api/projects/router.py`. Add the imports near the existing `from carve_api.projects.schemas import (...)` block:

```python
from carve_api.projects.keybindings import (
    compose_effective_bindings,
    delete_binding,
    set_binding,
)
from carve_api.projects.models import Class, ClassKeybinding
from carve_api.projects.schemas import (
    # ... existing imports ...
    ClassKeybindingListOut,
    ClassKeybindingOut,
    ClassKeybindingPutIn,
)
```

Then append the three endpoints to the bottom of the router file:

```python
# --- /projects/{pid}/class-keybindings ---


@router.get(
    "/{project_id}/class-keybindings",
    response_model=ClassKeybindingListOut,
)
def list_class_keybindings(
    project_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ClassKeybindingListOut:
    """Return the user's effective bindings (stored ∪ computed seed).

    Any project member can read their own bindings — no mutating role
    required. Bindings are personal so no shared-project gating beyond
    "you can see the project".
    """
    try:
        from carve_api.projects.service import require_visible_project
        require_visible_project(db, user, project_id)
    except AppError as exc:
        raise _http(exc) from exc
    rows = compose_effective_bindings(
        db, user_id=user.id, project_id=project_id,
    )
    return ClassKeybindingListOut(
        bindings=[
            ClassKeybindingOut(
                digit=r.digit, class_id=r.class_id, source=r.source,
            )
            for r in rows
        ]
    )


@router.put(
    "/{project_id}/class-keybindings/{digit}",
    response_model=ClassKeybindingOut,
)
def put_class_keybinding(
    project_id: uuid.UUID,
    digit: int,
    payload: ClassKeybindingPutIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ClassKeybindingOut:
    if digit < 1 or digit > 9:
        raise HTTPException(status_code=422, detail="invalid_digit")
    try:
        from carve_api.projects.service import require_visible_project
        require_visible_project(db, user, project_id)
    except AppError as exc:
        raise _http(exc) from exc
    # class_id must belong to project_id — protects the UNIQUE index
    # from cross-project leaks.
    target = db.get(Class, payload.class_id)
    if target is None or target.project_id != project_id:
        raise HTTPException(
            status_code=422, detail="class_not_in_project",
        )
    set_binding(
        db,
        user_id=user.id,
        project_id=project_id,
        digit=digit,
        class_id=payload.class_id,
    )
    db.commit()
    return ClassKeybindingOut(
        digit=digit, class_id=payload.class_id, source="stored",
    )


@router.delete(
    "/{project_id}/class-keybindings/{digit}",
    status_code=204,
)
def delete_class_keybinding(
    project_id: uuid.UUID,
    digit: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    if digit < 1 or digit > 9:
        raise HTTPException(status_code=422, detail="invalid_digit")
    try:
        from carve_api.projects.service import require_visible_project
        require_visible_project(db, user, project_id)
    except AppError as exc:
        raise _http(exc) from exc
    delete_binding(
        db, user_id=user.id, project_id=project_id, digit=digit,
    )
    db.commit()
```

Note: the `_http(exc)` helper and `require_visible_project` are already used in this router — reuse the existing imports.

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd apps/api && source .venv/bin/activate && python -m pytest tests/projects/test_class_keybindings.py -v
```

Expected: all router tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/carve_api/projects/schemas.py apps/api/src/carve_api/projects/router.py apps/api/tests/projects/test_class_keybindings.py
git commit -m "feat(api): class-keybindings GET/PUT/DELETE endpoints"
```

---

## Task 5: Frontend REST client

**Files:**
- Create: `apps/web/src/api/keybindings.ts`

- [ ] **Step 1: Write the typed client**

```ts
// apps/web/src/api/keybindings.ts
// Armin Mehri — mehri.armin@gmail.com
import { api } from "./client";

export interface ClassKeybinding {
  digit: number; // 1..9
  class_id: string;
  source: "stored" | "seed";
}

export interface ClassKeybindingList {
  bindings: ClassKeybinding[];
}

export const keybindingsApi = {
  /** Read the user's effective bindings for a project (stored ∪ seed). */
  list: async (projectId: string): Promise<ClassKeybindingList> =>
    (await api.get<ClassKeybindingList>(
      `/projects/${projectId}/class-keybindings`,
    )).data,

  /** Bind / move a digit. Server enforces the move-not-duplicate rule. */
  put: async (
    projectId: string,
    digit: number,
    classId: string,
  ): Promise<ClassKeybinding> =>
    (await api.put<ClassKeybinding>(
      `/projects/${projectId}/class-keybindings/${digit}`,
      { class_id: classId },
    )).data,

  /** Idempotent — clears the digit. */
  remove: async (projectId: string, digit: number): Promise<void> => {
    await api.delete(`/projects/${projectId}/class-keybindings/${digit}`);
  },
};
```

- [ ] **Step 2: TypeScript check passes**

```bash
cd apps/web && pnpm tsc --noEmit --pretty false
```

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/api/keybindings.ts
git commit -m "feat(web): keybindings REST client"
```

---

## Task 6: `effectiveBindings` pure helper

**Files:**
- Create: `apps/web/src/lib/class-keybindings.ts`
- Create: `apps/web/tests/class-keybindings-effective.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/tests/class-keybindings-effective.test.ts
/**
 * effectiveBindings — pure helper that merges stored rows with the
 * idx-ASC seed. Mirrors the server's compose_effective_bindings so
 * the frontend can react instantly to optimistic updates without
 * waiting for the server round-trip.
 */
import { describe, expect, it } from "vitest";
import { effectiveBindings } from "@/lib/class-keybindings";
import type { ClassRow } from "@/api/classes";

function cls(id: string, idx: number): ClassRow {
  return { id, project_id: "p", name: id, color: "#000", idx } as ClassRow;
}

describe("effectiveBindings", () => {
  it("seeds first nine classes by idx when no stored rows", () => {
    const classes = [cls("a", 0), cls("b", 1), cls("c", 2)];
    expect(effectiveBindings([], classes)).toEqual({
      1: "a", 2: "b", 3: "c",
    });
  });

  it("stored rows take precedence over the seed", () => {
    const classes = [cls("a", 0), cls("b", 1), cls("c", 2)];
    const stored = [{ digit: 1, class_id: "c", source: "stored" as const }];
    const eff = effectiveBindings(stored, classes);
    expect(eff[1]).toBe("c");
  });

  it("seed skips classes already bound by a stored row (no duplicates)", () => {
    const classes = [cls("a", 0), cls("b", 1), cls("c", 2)];
    // Class "a" is bound at digit 5; seed must not also place it at 1.
    const stored = [{ digit: 5, class_id: "a", source: "stored" as const }];
    const eff = effectiveBindings(stored, classes);
    expect(eff[5]).toBe("a");
    // Digits 1 and 2 are filled from remaining classes (b, c) in idx order.
    expect(eff[1]).toBe("b");
    expect(eff[2]).toBe("c");
  });

  it("project with fewer than 9 classes leaves trailing digits empty", () => {
    const classes = [cls("a", 0), cls("b", 1)];
    const eff = effectiveBindings([], classes);
    expect(eff).toEqual({ 1: "a", 2: "b" });
    expect(eff[3]).toBeUndefined();
  });

  it("zero classes → empty map", () => {
    expect(effectiveBindings([], [])).toEqual({});
  });

  it("ignores stored rows for digits outside 1..9 (defensive)", () => {
    const classes = [cls("a", 0)];
    const stored = [
      { digit: 0, class_id: "a", source: "stored" as const },
      { digit: 10, class_id: "a", source: "stored" as const },
    ];
    // Out-of-range stored rows are ignored; seed still places "a" at 1.
    expect(effectiveBindings(stored, classes)).toEqual({ 1: "a" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/web && pnpm vitest run tests/class-keybindings-effective.test.ts
```

Expected: module not found.

- [ ] **Step 3: Write the helper**

```ts
// apps/web/src/lib/class-keybindings.ts
// Armin Mehri — mehri.armin@gmail.com
/**
 * Pure merge of stored bindings + the first-nine-by-idx seed.
 * Mirrors the backend's compose_effective_bindings so optimistic
 * cache updates don't drift from the server's view.
 *
 *   1. Stored rows take precedence at their digit.
 *   2. Empty digits fall back to ``class.idx ASC LIMIT 9``, skipping
 *      classes already bound (no duplicate badges).
 *   3. Returns a {digit: classId} map; digits with no class are absent.
 */
import type { ClassRow } from "@/api/classes";
import type { ClassKeybinding } from "@/api/keybindings";

export function effectiveBindings(
  stored: ReadonlyArray<ClassKeybinding>,
  classes: ReadonlyArray<ClassRow>,
): Record<number, string> {
  const out: Record<number, string> = {};
  const storedByDigit = new Map<number, string>();
  const storedClassIds = new Set<string>();
  for (const row of stored) {
    if (row.digit < 1 || row.digit > 9) continue;  // defensive
    storedByDigit.set(row.digit, row.class_id);
    storedClassIds.add(row.class_id);
  }
  const sortedClasses = [...classes].sort((a, b) => a.idx - b.idx);
  const seedPool = sortedClasses.filter((c) => !storedClassIds.has(c.id));
  let seedIdx = 0;
  for (let digit = 1; digit <= 9; digit += 1) {
    const storedForDigit = storedByDigit.get(digit);
    if (storedForDigit !== undefined) {
      out[digit] = storedForDigit;
      continue;
    }
    if (seedIdx < seedPool.length) {
      out[digit] = seedPool[seedIdx].id;
      seedIdx += 1;
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/web && pnpm vitest run tests/class-keybindings-effective.test.ts
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/class-keybindings.ts apps/web/tests/class-keybindings-effective.test.ts
git commit -m "feat(web): effectiveBindings pure helper"
```

---

## Task 7: Page wiring — query + thread to consumers

**Files:**
- Modify: `apps/web/src/pages/AnnotateAssetPage.tsx`

The page owns the TanStack query and passes the merged `effectiveBindings` map to both `ClassesPanel` (for keyboard + badges) and `AnnotationCanvas` (for SAM-commit-with-digit).

- [ ] **Step 1: Add the query**

Open `apps/web/src/pages/AnnotateAssetPage.tsx`. Near the other TanStack queries (e.g. `taskAssetsQ` around line 435):

```tsx
import { keybindingsApi } from "@/api/keybindings";
import { effectiveBindings } from "@/lib/class-keybindings";
```

Inside the component body (right after `classesQ` is derived around line 426):

```tsx
const keybindingsQ = useQuery({
  queryKey: ["class-keybindings", projectId],
  queryFn: () => keybindingsApi.list(projectId),
  staleTime: 60_000,
});

// Single source of truth for digit→class. Mirrors the server-side
// composition; recomputes when classes or stored bindings change so
// optimistic mutations re-render the kbd badges instantly.
const digitToClassId = useMemo(
  () => effectiveBindings(
    keybindingsQ.data?.bindings ?? [],
    classesQ.data ?? [],
  ),
  [keybindingsQ.data, classesQ.data],
);
```

- [ ] **Step 2: Pass to ClassesPanel + AnnotationCanvas**

Locate the existing `<ClassesPanel ... />` JSX (around line 1751). Add a `digitToClassId={digitToClassId}` prop. Locate the existing `<AnnotationCanvas ... />` JSX (search for `<AnnotationCanvas`) and likewise pass `digitToClassId={digitToClassId}`.

- [ ] **Step 3: TypeScript check passes**

```bash
cd apps/web && pnpm tsc --noEmit --pretty false
```

Expected: exit 0 *only after Tasks 8 and 9 land*; for now the type-check will fail because `ClassesPanel` and `AnnotationCanvas` don't accept the prop yet. That's the intended TDD sequence — finish the wiring tasks below before re-checking.

- [ ] **Step 4: Commit (no compile yet — bundled with the next two tasks)**

Skip the commit for this task; bundle with Task 8.

---

## Task 8: `ClassesPanel` — accept prop + render badges + new keyboard handler

**Files:**
- Modify: `apps/web/src/components/annotation/ClassesPanel.tsx`
- Create: `apps/web/tests/class-keybindings-keyboard.test.tsx`

- [ ] **Step 1: Add the keyboard test (failing)**

```tsx
// apps/web/tests/class-keybindings-keyboard.test.tsx
/**
 * Keyboard contract for class digit shortcuts.
 *
 *   Plain digit → activates the bound class.
 *   Shift+digit (with an active class):
 *     - if the digit isn't bound to the active class → bind.
 *     - if the digit IS bound to the active class    → unbind.
 *   Shift+digit (no active class) → info toast, no mutation.
 *
 * The handler reads the merged map from props (digitToClassId) so the
 * test exercises both the activation path and the mutation paths
 * via mocks for keybindingsApi + showToast.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const setActive = vi.fn();

vi.mock("@/state/tool", () => ({
  useTool: Object.assign(
    () => null,
    {
      getState: () => ({ activeClassId: "c-2" }),
      setState: () => undefined,
      subscribe: () => () => undefined,
    },
  ),
}));

const putMock = vi.fn().mockResolvedValue({});
const removeMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/api/keybindings", () => ({
  keybindingsApi: {
    list: vi.fn().mockResolvedValue({ bindings: [] }),
    put: (...args: unknown[]) => putMock(...args),
    remove: (...args: unknown[]) => removeMock(...args),
  },
}));

const showToastMock = vi.fn();
vi.mock("@/lib/toast", () => ({
  showToast: (...a: unknown[]) => showToastMock(...a),
}));

import { ClassesPanel } from "@/components/annotation/ClassesPanel";

const CLASSES = [
  { id: "c-1", project_id: "p", name: "Bus", color: "#ff0000", idx: 0 },
  { id: "c-2", project_id: "p", name: "Car", color: "#00ff00", idx: 1 },
] as never;

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

beforeEach(() => {
  setActive.mockClear();
  putMock.mockClear();
  removeMock.mockClear();
  showToastMock.mockClear();
});
afterEach(cleanup);

describe("ClassesPanel keyboard", () => {
  it("plain digit activates the bound class from digitToClassId", () => {
    render(wrap(
      <ClassesPanel
        projectId="p"
        classes={CLASSES}
        digitToClassId={{ 1: "c-1", 2: "c-2" }}
        setActiveClassId={setActive}
      />,
    ));
    fireEvent.keyDown(window, { key: "1" });
    expect(setActive).toHaveBeenCalledWith("c-1");
  });

  it("Shift+digit with an active class dispatches put", () => {
    render(wrap(
      <ClassesPanel
        projectId="p"
        classes={CLASSES}
        digitToClassId={{ 1: "c-1", 2: "c-2" }}
        setActiveClassId={setActive}
      />,
    ));
    // Active class is c-2; binding it to digit 5 means PUT(p, 5, c-2).
    fireEvent.keyDown(window, { key: "5", shiftKey: true });
    expect(putMock).toHaveBeenCalledWith("p", 5, "c-2");
  });

  it("Shift+digit on the active class's CURRENT digit unbinds", () => {
    render(wrap(
      <ClassesPanel
        projectId="p"
        classes={CLASSES}
        digitToClassId={{ 1: "c-1", 2: "c-2" }}
        setActiveClassId={setActive}
      />,
    ));
    // c-2 is currently at digit 2; Shift+2 should unbind.
    fireEvent.keyDown(window, { key: "2", shiftKey: true });
    expect(removeMock).toHaveBeenCalledWith("p", 2);
    expect(putMock).not.toHaveBeenCalled();
  });

  it("Shift+digit with no active class shows the prompt toast", () => {
    // Override getState for this test only.
    const { useTool } = require("@/state/tool") as {
      useTool: { getState: () => { activeClassId: string | null } };
    };
    useTool.getState = () => ({ activeClassId: null });
    render(wrap(
      <ClassesPanel
        projectId="p"
        classes={CLASSES}
        digitToClassId={{}}
        setActiveClassId={setActive}
      />,
    ));
    fireEvent.keyDown(window, { key: "1", shiftKey: true });
    expect(showToastMock).toHaveBeenCalledWith(
      expect.stringMatching(/Select a class first/i),
      expect.anything(),
    );
    expect(putMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/web && pnpm vitest run tests/class-keybindings-keyboard.test.tsx
```

Expected: `ClassesPanel` doesn't accept `digitToClassId` prop yet, or the handler doesn't exist — tests fail.

- [ ] **Step 3: Update `ClassesPanel.tsx`**

a) Add the prop to the panel's props type and destructure it:

```ts
interface ClassesPanelProps {
  // ... existing props ...
  /** Merged digit → classId map (see lib/class-keybindings). Used for
   *  both badge rendering and the digit keyboard handler. */
  digitToClassId?: Record<number, string>;
}
```

b) Replace the existing digit handler at `ClassesPanel.tsx:913-925` with:

```tsx
import { keybindingsApi } from "@/api/keybindings";
import { showToast } from "@/lib/toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";

// ... inside the component ...

const qc = useQueryClient();
const putBinding = useMutation({
  mutationFn: ({ digit, classId }: { digit: number; classId: string }) =>
    keybindingsApi.put(projectId, digit, classId),
  onSettled: () => qc.invalidateQueries({
    queryKey: ["class-keybindings", projectId],
  }),
});
const clearBinding = useMutation({
  mutationFn: (digit: number) => keybindingsApi.remove(projectId, digit),
  onSettled: () => qc.invalidateQueries({
    queryKey: ["class-keybindings", projectId],
  }),
});

useEffect(() => {
  function handler(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (!/^[1-9]$/.test(e.key)) return;
    const digit = parseInt(e.key, 10);

    // Shift+digit → bind / unbind.
    if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const activeId = useTool.getState().activeClassId;
      if (!activeId) {
        showToast("Select a class first to bind a hotkey.", {
          variant: "info", duration: 3000,
        });
        return;
      }
      e.preventDefault();
      const current = digitToClassId?.[digit];
      if (current === activeId) {
        clearBinding.mutate(digit);
        showToast(`Digit ${digit} cleared`, { variant: "info" });
      } else {
        const activeClass = classes.find((c) => c.id === activeId);
        putBinding.mutate({ digit, classId: activeId });
        showToast(
          `Digit ${digit} → ${activeClass?.name ?? "class"}`,
          { variant: "success" },
        );
      }
      return;
    }

    // Any other modifier → not our chord.
    if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;

    // Plain digit → activate the bound class.
    const targetId = digitToClassId?.[digit];
    if (targetId) {
      e.preventDefault();
      setActiveClassId(targetId);
    }
  }
  window.addEventListener("keydown", handler);
  return () => window.removeEventListener("keydown", handler);
}, [
  digitToClassId, classes, setActiveClassId, projectId,
  putBinding, clearBinding,
]);
```

c) Render the `<Kbd>` badge per class row. Locate where each class row is rendered (around the `filtered.map(...)` block from line ~927). Compute a reverse map for O(1) lookup at the top of the component body:

```tsx
const digitByClassId = useMemo(() => {
  const r: Record<string, number> = {};
  if (digitToClassId) {
    for (const [d, id] of Object.entries(digitToClassId)) {
      r[id] = parseInt(d, 10);
    }
  }
  return r;
}, [digitToClassId]);
```

In each class row's right-side gutter, render the kbd badge when the class is bound. Import `Kbd` near the other `@/components/ui/*` imports:

```tsx
import { Kbd } from "@/components/ui/Kbd";
```

Inside the row JSX (next to the colour swatch and other right-side indicators):

```tsx
{digitByClassId[cls.id] !== undefined && (
  <Kbd
    data-testid={`class-row-kbd-${cls.id}`}
    aria-label={`Digit shortcut ${digitByClassId[cls.id]}`}
  >
    {digitByClassId[cls.id]}
  </Kbd>
)}
```

d) Add `projectId` as a required prop on `ClassesPanelProps` if it isn't already there — it must be threaded from `AnnotateAssetPage` (Task 7 already passes it).

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/web && pnpm vitest run tests/class-keybindings-keyboard.test.tsx
```

Expected: 4 tests pass.

- [ ] **Step 5: TypeScript check passes**

```bash
cd apps/web && pnpm tsc --noEmit --pretty false
```

Expected: exit 0 *only after Task 9 also lands* — `AnnotationCanvas` still doesn't accept the prop yet. Continue.

- [ ] **Step 6: Commit (bundle with Task 9)**

Skip; bundle with the next task.

---

## Task 9: `AnnotationCanvas` — accept prop + use `digitToClassId`

**Files:**
- Modify: `apps/web/src/components/annotation/AnnotationCanvas.tsx`

- [ ] **Step 1: Add prop + use it**

a) In `AnnotationCanvas.tsx`'s props interface, add:

```ts
/** Merged digit → classId map (see lib/class-keybindings). Replaces
 *  the legacy ``c.idx === digit - 1`` lookup. Optional so older test
 *  mounts that don't pass it fall back to legacy behaviour. */
digitToClassId?: Record<number, string>;
```

b) Replace the existing SAM-commit-with-digit handler at `AnnotationCanvas.tsx:3725-3734`:

```tsx
} else if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
  // v3.x — commit with the class bound to the pressed digit. Reads the
  // effective binding map (shared with the ClassesPanel keyboard
  // handler) so the SAM commit path respects user-customised
  // shortcuts. Falls back to the legacy idx-based lookup when no
  // map is provided (older test mounts).
  const digit = parseInt(e.key, 10);
  const targetId =
    digitToClassId?.[digit]
    ?? (classesProp ?? []).find((c) => c.idx === digit - 1)?.id;
  const target = targetId
    ? (classesProp ?? []).find((c) => c.id === targetId)
    : null;
  if (target) {
    e.preventDefault();
    e.stopPropagation();
    const ok = samTool.commit(target.id);
    if (ok) {
      clearSamPreview();
      clearSamPoints();
      clearPreview();
      // Make the chosen class active so the next candidate
```

Keep the rest of the existing block (everything after the `if (ok) { clearSamPreview...` already in the file) unchanged.

- [ ] **Step 2: TypeScript check passes**

```bash
cd apps/web && pnpm tsc --noEmit --pretty false
```

Expected: exit 0.

- [ ] **Step 3: Run all SAM-related vitest specs to confirm no regression**

```bash
cd apps/web && pnpm vitest run tests/annotation-canvas-sam.test.tsx tests/v36-sam-live-preview.test.tsx tests/sam-tool.test.ts tests/class-keybindings-keyboard.test.tsx tests/class-keybindings-effective.test.ts
```

Expected: at least the new tests pass; pre-existing failures unrelated to this change are tolerated (already-broken specs on master).

- [ ] **Step 4: Commit Tasks 7, 8, 9 together**

```bash
git add apps/web/src/pages/AnnotateAssetPage.tsx \
        apps/web/src/components/annotation/ClassesPanel.tsx \
        apps/web/src/components/annotation/AnnotationCanvas.tsx \
        apps/web/tests/class-keybindings-keyboard.test.tsx
git commit -m "feat(web): wire effectiveBindings into panel + canvas"
```

---

## Task 10: One-time hint toast

**Files:**
- Modify: `apps/web/src/components/annotation/ClassesPanel.tsx`

- [ ] **Step 1: Add the hint effect**

Inside `ClassesPanel`, after the keybindings query data first resolves, fire a single info toast guarded by localStorage:

```tsx
const HINT_KEY = "carve.class-keybindings.hint-seen-v1";

useEffect(() => {
  if (!digitToClassId) return;
  if (Object.keys(digitToClassId).length === 0) return;  // nothing to hint about
  try {
    if (window.localStorage.getItem(HINT_KEY) === "1") return;
    showToast(
      "Tip: select a class and press Shift+digit to assign that key.",
      { variant: "info", duration: 6000 },
    );
    window.localStorage.setItem(HINT_KEY, "1");
  } catch {
    /* localStorage disabled — silently skip */
  }
}, [digitToClassId]);
```

- [ ] **Step 2: Manual smoke**

```bash
docker compose up -d --build --force-recreate api web
```

Then open the editor in two browser tabs (or a private window + a normal one):

- First mount: toast appears.
- Reload: toast does NOT appear.
- Clear localStorage `carve.class-keybindings.hint-seen-v1`: toast appears again.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/annotation/ClassesPanel.tsx
git commit -m "feat(web): one-time hint for class digit shortcuts"
```

---

## Task 11: Full regression sweep + docker rebuild

- [ ] **Step 1: Backend tests pass**

```bash
cd apps/api && source .venv/bin/activate && python -m pytest tests/projects/test_class_keybindings.py -v
```

Expected: all tests pass.

- [ ] **Step 2: Frontend tests pass**

```bash
cd apps/web && pnpm vitest run tests/class-keybindings-effective.test.ts tests/class-keybindings-keyboard.test.tsx tests/class-order.test.ts tests/annotation-filter-nav.test.ts tests/polygon-approx-flow.test.ts tests/sam-loading-error.test.ts tests/sam-switch-watcher.test.tsx
```

Expected: all tests pass.

- [ ] **Step 3: TypeScript build clean**

```bash
cd apps/web && pnpm tsc --noEmit --pretty false
```

Expected: exit 0.

- [ ] **Step 4: Docker rebuild + recreate**

```bash
cd /home/media4us/Documents/Dev/VisualAutoAnnotator && docker compose up -d --build --force-recreate api worker web
```

Then verify health:

```bash
docker compose ps --format "table {{.Service}}\t{{.State}}\t{{.Status}}"
```

Expected: `api`, `worker`, `web` running and healthy.

- [ ] **Step 5: End-to-end manual smoke**

1. Open the editor with a project that has ≥10 classes.
2. Confirm digits 1–9 default to first nine classes (badges visible in the panel, plain digit activates).
3. Click class number 56 in the panel.
4. Press `Shift+8`. Expect toast `Digit 8 → <ClassName>` and a `[8]` badge appearing on row 56.
5. Press `8` (no shift) on the canvas — class 56 becomes active.
6. Press `Shift+8` again with class 56 still selected — expect toast `Digit 8 cleared` and the badge disappears. Pressing `8` now activates whichever class the seed promotes (next un-bound class by idx).
7. Reload the page — the binding persists for this user + project but defaults reset to the seed because the binding was cleared.
8. Open the same project as a different user — that user sees their own bindings, not yours.

- [ ] **Step 6: Final push**

```bash
git push origin master
```

---

## Self-Review

**1. Spec coverage:**

| Spec section                      | Task(s)                |
| --------------------------------- | ---------------------- |
| §1 Data model                     | Task 1 (migration), Task 2 (ORM) |
| §2 API (GET / PUT / DELETE)       | Task 4                 |
| §3 Frontend store                 | Task 5, Task 7         |
| §4 ClassesPanel UI (kbd badges)   | Task 8                 |
| §5 Keyboard wiring                | Task 8 (panel handler), Task 9 (canvas SAM commit) |
| §6 Default seeding + one-time hint | Task 3 (server seed), Task 10 (hint toast) |
| §7 Edge cases                     | Tasks 2 (cascade), 3 (move), 4 (422), 8 (no-active-class toast) |
| §8 Testing                        | Tasks 2, 3, 4 (backend); Tasks 6, 8 (frontend) |

All requirements have an implementing task. No spec section is left unimplemented.

**2. Placeholder scan:** None. All code blocks are concrete; commands have exact paths; expected outputs are stated.

**3. Type consistency:**

- `EffectiveBinding` (backend dataclass) ↔ `ClassKeybinding` (frontend interface): mapped via `ClassKeybindingOut` schema. Fields `digit / class_id / source` align across all three.
- `compose_effective_bindings` (backend) ↔ `effectiveBindings` (frontend): same composition rules; backend returns ordered list, frontend returns `Record<digit, classId>`. Intentional shape difference — frontend consumers (`ClassesPanel`, `AnnotationCanvas`) read by digit lookup.
- `digitToClassId` prop name consistent across page → panel → canvas.
- Mutation names `putBinding` / `clearBinding` consistent inside `ClassesPanel`.

No drift detected.
