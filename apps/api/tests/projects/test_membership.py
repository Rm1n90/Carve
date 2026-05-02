"""Plan-13 Phase 7 Task 1 -- project_members table tests.

The test conftest provisions the schema via ``Base.metadata.create_all``
rather than Alembic, so we exercise the backfill logic by running the
same SQL the migration runs against the test DB. This is the fallback
path explicitly called out in the task spec.

Covers:
1. Backfill INSERT picks up ``projects.owner_id`` -> single ``owner``
   row per project; idempotent on re-run.
2. Backfill picks up the oldest admin for projects with NULL ``owner_id``
   (we synthesise the no-owner case at the SQL level since the live
   schema has ``owner_id NOT NULL``).
3. Composite PK rejects duplicate ``(project_id, user_id)``.
4. CHECK constraint rejects unknown roles.
5. ``ProjectIn`` round-trips with valid ``members`` and rejects bad
   roles.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from carve_api.auth.models import User, UserRole
from carve_api.projects.models import Project, ProjectMember
from carve_api.projects.schemas import (
    PROJECT_MEMBER_ROLES,
    ProjectIn,
    ProjectMemberInIn,
)


# Backfill SQL kept in sync with alembic 0023. If the migration changes,
# update both. The test asserts behavioural parity, not source-string
# equality.
_BACKFILL_OWNERS_FROM_OWNER_ID = """
INSERT INTO project_members (project_id, user_id, role, added_by, added_at)
SELECT p.id, p.owner_id, 'owner', NULL, now()
FROM projects p
WHERE p.owner_id IS NOT NULL
ON CONFLICT (project_id, user_id) DO NOTHING
"""

_BACKFILL_OWNERS_FROM_OLDEST_ADMIN = """
INSERT INTO project_members (project_id, user_id, role, added_by, added_at)
SELECT
    p.id,
    (
        SELECT u.id
        FROM users u
        WHERE u.role = 'admin'
        ORDER BY u.created_at ASC
        LIMIT 1
    ) AS user_id,
    'owner',
    NULL,
    now()
FROM projects p
WHERE p.owner_id IS NULL
  AND EXISTS (SELECT 1 FROM users u WHERE u.role = 'admin')
ON CONFLICT (project_id, user_id) DO NOTHING
"""


def test_backfill_picks_owner_id_for_each_project(db_session) -> None:
    creator = User(email="creator@example.com", password_hash="x", role=UserRole.member)
    other = User(email="other@example.com", password_hash="x", role=UserRole.admin)
    db_session.add_all([creator, other])
    db_session.flush()

    p_a = Project(name="A", owner_id=creator.id)
    p_b = Project(name="B", owner_id=other.id)
    db_session.add_all([p_a, p_b])
    db_session.flush()

    db_session.execute(text(_BACKFILL_OWNERS_FROM_OWNER_ID))
    db_session.flush()

    rows = (
        db_session.query(ProjectMember)
        .filter(ProjectMember.project_id.in_([p_a.id, p_b.id]))
        .all()
    )
    by_project = {r.project_id: r for r in rows}
    assert by_project[p_a.id].user_id == creator.id
    assert by_project[p_a.id].role == "owner"
    assert by_project[p_b.id].user_id == other.id
    assert by_project[p_b.id].role == "owner"

    # Idempotent: re-running does not duplicate or error.
    db_session.execute(text(_BACKFILL_OWNERS_FROM_OWNER_ID))
    db_session.flush()
    after = (
        db_session.query(ProjectMember)
        .filter(ProjectMember.project_id.in_([p_a.id, p_b.id]))
        .count()
    )
    assert after == 2


def test_backfill_falls_back_to_oldest_admin_when_owner_null(db_session) -> None:
    older = User(
        email="older-admin@example.com",
        password_hash="x",
        role=UserRole.admin,
        created_at=datetime(2020, 1, 1, tzinfo=timezone.utc),
    )
    newer = User(
        email="newer-admin@example.com",
        password_hash="x",
        role=UserRole.admin,
        created_at=datetime(2020, 1, 1, tzinfo=timezone.utc) + timedelta(days=10),
    )
    placeholder_owner = User(
        email="ph-owner@example.com", password_hash="x", role=UserRole.member
    )
    db_session.add_all([older, newer, placeholder_owner])
    db_session.flush()

    p = Project(name="Owner-less", owner_id=placeholder_owner.id)
    db_session.add(p)
    db_session.flush()

    # Drop NOT NULL within the open transaction so we can synthesise the
    # NULL-owner_id branch. The savepoint rollback restores schema.
    db_session.execute(
        text("ALTER TABLE projects ALTER COLUMN owner_id DROP NOT NULL")
    )
    db_session.execute(
        text("UPDATE projects SET owner_id = NULL WHERE id = :pid"),
        {"pid": p.id},
    )
    db_session.flush()

    db_session.execute(text(_BACKFILL_OWNERS_FROM_OLDEST_ADMIN))
    db_session.flush()

    row = (
        db_session.query(ProjectMember)
        .filter(ProjectMember.project_id == p.id)
        .one()
    )
    assert row.user_id == older.id
    assert row.role == "owner"


def test_composite_primary_key_rejects_duplicate(db_session) -> None:
    user = User(email="dup@example.com", password_hash="x", role=UserRole.member)
    db_session.add(user)
    db_session.flush()
    p = Project(name="DupProj", owner_id=user.id)
    db_session.add(p)
    db_session.flush()

    db_session.add(ProjectMember(project_id=p.id, user_id=user.id, role="owner"))
    db_session.flush()

    with pytest.raises(IntegrityError):
        db_session.add(
            ProjectMember(project_id=p.id, user_id=user.id, role="member")
        )
        db_session.flush()


def test_check_constraint_rejects_unknown_role(db_session) -> None:
    user = User(email="bad-role@example.com", password_hash="x", role=UserRole.member)
    db_session.add(user)
    db_session.flush()
    p = Project(name="BadRole", owner_id=user.id)
    db_session.add(p)
    db_session.flush()

    with pytest.raises(IntegrityError):
        db_session.add(
            ProjectMember(project_id=p.id, user_id=user.id, role="superuser")
        )
        db_session.flush()


def test_project_in_members_round_trips_valid_payload() -> None:
    uid = uuid.uuid4()
    payload = ProjectIn.model_validate(
        {"name": "x", "members": [{"user_id": str(uid), "role": "viewer"}]}
    )
    assert payload.members is not None
    assert len(payload.members) == 1
    assert payload.members[0].user_id == uid
    assert payload.members[0].role == "viewer"


def test_project_in_rejects_garbage_role() -> None:
    with pytest.raises(ValidationError):
        ProjectIn.model_validate(
            {
                "name": "x",
                "members": [
                    {"user_id": str(uuid.uuid4()), "role": "garbage"}
                ],
            }
        )


def test_project_in_omitted_members_defaults_to_none() -> None:
    payload = ProjectIn.model_validate({"name": "x"})
    assert payload.members is None


def test_project_member_role_constants_match_check_constraint() -> None:
    assert PROJECT_MEMBER_ROLES == ("owner", "admin", "member", "viewer")


def test_project_member_in_in_accepts_all_valid_roles() -> None:
    uid = uuid.uuid4()
    for role in PROJECT_MEMBER_ROLES:
        m = ProjectMemberInIn.model_validate({"user_id": str(uid), "role": role})
        assert m.role == role
