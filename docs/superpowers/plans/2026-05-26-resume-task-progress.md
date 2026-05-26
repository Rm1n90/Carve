# Resume Task Progress — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a user reopens a task they have previously annotated, show a non-intrusive banner: *"You last annotated **N of M** images here — last activity **{relative time}**."* with **[ Resume there ]** and **[ Dismiss ]** buttons. Per-user, per-task. Derived from the existing `annotations` table — no schema change beyond one new index.

**Architecture:** Backend exposes `GET /projects/{pid}/tasks/{tid}/resume`. The handler joins `Annotation → Frame` to find the most recent annotation by the authenticated user, returns `last_asset_id`, `last_frame_id`, `annotated_assets`, `total_assets`, `last_activity_at`. Frontend fetches once via TanStack Query on `AnnotateAssetPage` mount and renders `<ResumeProgressBanner />` between toolbar and canvas.

**Tech Stack:** FastAPI + SQLAlchemy + Alembic (backend), React + TanStack Query + React Router + vitest + Testing Library (frontend).

**Spec:** [`docs/superpowers/specs/2026-05-26-resume-task-progress-design.md`](../specs/2026-05-26-resume-task-progress-design.md)

---

## File Map

**Create**
- `apps/api/alembic/versions/0036_annotation_resume_index.py` — partial index migration
- `apps/api/tests/projects/test_task_resume.py` — backend integration tests
- `apps/web/src/hooks/useTaskResume.ts` — TanStack Query wrapper
- `apps/web/src/components/annotation/ResumeProgressBanner.tsx` — banner component
- `apps/web/src/components/annotation/__tests__/ResumeProgressBanner.test.tsx` — banner unit tests
- `apps/web/src/lib/relativeTime.ts` — `Intl.RelativeTimeFormat` helper
- `apps/web/src/lib/__tests__/relativeTime.test.ts` — helper unit tests

**Modify**
- `apps/api/src/carve_api/projects/schemas.py` — add `TaskResumeStatus`
- `apps/api/src/carve_api/projects/router.py` — add the GET resume route (next to `task_completion_status`)
- `apps/web/src/api/tasks.ts` — add `TaskResumeStatusResponse` + `fetchTaskResumeStatus`
- `apps/web/src/pages/AnnotateAssetPage.tsx` — mount `<ResumeProgressBanner />` between toolbar and canvas

---

## Conventions

- **Working directory** for all bash commands: `/home/media4us/Documents/Dev/VisualAutoAnnotator`
- **Backend tests:** `uv run pytest ...` from `apps/api/`
- **Frontend tests:** `pnpm --filter @carve/web test ...` from repo root
- **TypeScript check:** `pnpm --filter @carve/web tsc --noEmit`
- **Frequent commits:** each task ends with a single commit; subject is conventional (`feat:`, `test:`, `chore:`)
- **Never run `git add -A`** — stage explicit paths only.

---

## Task 1 — Add `TaskResumeStatus` Pydantic schema

**Files:**
- Modify: `apps/api/src/carve_api/projects/schemas.py`
- Test: `apps/api/tests/projects/test_task_resume.py` (new file, schema-only test in this task)

- [ ] **Step 1 — Write the failing test**

Create `apps/api/tests/projects/test_task_resume.py`:

```python
import uuid
from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

from carve_api.projects.schemas import TaskResumeStatus


def test_resume_schema_accepts_populated_payload() -> None:
    asset_id = uuid.uuid4()
    frame_id = uuid.uuid4()
    ts = datetime(2026, 5, 26, 16, 4, tzinfo=timezone.utc)
    s = TaskResumeStatus(
        last_asset_id=asset_id,
        last_frame_id=frame_id,
        annotated_assets=350,
        total_assets=1000,
        last_activity_at=ts,
    )
    assert s.last_asset_id == asset_id
    assert s.annotated_assets == 350


def test_resume_schema_accepts_empty_payload() -> None:
    s = TaskResumeStatus(
        last_asset_id=None,
        last_frame_id=None,
        annotated_assets=0,
        total_assets=0,
        last_activity_at=None,
    )
    assert s.last_asset_id is None
    assert s.last_activity_at is None


def test_resume_schema_rejects_negative_counts() -> None:
    with pytest.raises(ValidationError):
        TaskResumeStatus(
            last_asset_id=None,
            last_frame_id=None,
            annotated_assets=-1,
            total_assets=10,
            last_activity_at=None,
        )
```

- [ ] **Step 2 — Run and verify failure**

```bash
cd apps/api && uv run pytest tests/projects/test_task_resume.py -v
```

Expected: ImportError / collection failure (`TaskResumeStatus` does not exist).

- [ ] **Step 3 — Add the schema**

At the bottom of `apps/api/src/carve_api/projects/schemas.py`, add:

```python
import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class TaskResumeStatus(BaseModel):
    """Per-user resume payload returned by
    ``GET /projects/{pid}/tasks/{tid}/resume``. Drives the editor's
    "You last annotated N of M" banner.

    All four ``last_*`` fields are ``None`` together when the
    authenticated user has no annotations in this task.
    """

    model_config = ConfigDict(from_attributes=True)

    last_asset_id: uuid.UUID | None
    last_frame_id: uuid.UUID | None
    annotated_assets: int = Field(ge=0)
    total_assets: int = Field(ge=0)
    last_activity_at: datetime | None
```

> If the file already imports `uuid`, `datetime`, `BaseModel`, `ConfigDict`, or `Field`, do **not** duplicate the imports — extend the existing import line.

- [ ] **Step 4 — Run tests and verify pass**

```bash
cd apps/api && uv run pytest tests/projects/test_task_resume.py -v
```

Expected: 3 passed.

- [ ] **Step 5 — Commit**

```bash
git add apps/api/src/carve_api/projects/schemas.py apps/api/tests/projects/test_task_resume.py
git commit -m "feat(api): add TaskResumeStatus schema"
```

---

## Task 2 — Alembic migration: partial index for resume query

**Files:**
- Create: `apps/api/alembic/versions/0036_annotation_resume_index.py`

The query `WHERE task_id = ? AND created_by = ? AND frame_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1` runs on every task open. A partial composite index keeps it O(log n).

- [ ] **Step 1 — Identify the previous migration head**

```bash
ls apps/api/alembic/versions/ | sort | tail -3
```

Expected: `0035_project_default_sam_variant.py` is the latest. Confirm before proceeding. If a newer head exists, use that as `down_revision` instead.

- [ ] **Step 2 — Create the migration file**

Create `apps/api/alembic/versions/0036_annotation_resume_index.py`:

```python
"""annotations: partial index for per-user resume query

Revision ID: 0036_annotation_resume_index
Revises: 0035_project_default_sam_variant
Create Date: 2026-05-26
"""
from alembic import op

# revision identifiers, used by Alembic.
revision = "0036_annotation_resume_index"
down_revision = "0035_project_default_sam_variant"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_annotations_task_user_updated",
        "annotations",
        ["task_id", "created_by", "updated_at"],
        postgresql_where="frame_id IS NOT NULL",
        postgresql_ops={"updated_at": "DESC"},
    )


def downgrade() -> None:
    op.drop_index("ix_annotations_task_user_updated", table_name="annotations")
```

- [ ] **Step 3 — Run the migration**

```bash
cd apps/api && uv run alembic upgrade head
```

Expected: `Running upgrade 0035_project_default_sam_variant -> 0036_annotation_resume_index`.

- [ ] **Step 4 — Verify the index exists**

```bash
cd apps/api && uv run python -c "
from sqlalchemy import create_engine, text
from carve_api.config import settings
e = create_engine(settings.database_url)
with e.connect() as c:
    rows = c.execute(text(\"SELECT indexname FROM pg_indexes WHERE tablename='annotations' AND indexname='ix_annotations_task_user_updated'\")).all()
    print(rows)
"
```

Expected output: `[('ix_annotations_task_user_updated',)]`.

- [ ] **Step 5 — Verify downgrade then re-upgrade**

```bash
cd apps/api && uv run alembic downgrade -1 && uv run alembic upgrade head
```

Expected: clean down then clean up.

- [ ] **Step 6 — Commit**

```bash
git add apps/api/alembic/versions/0036_annotation_resume_index.py
git commit -m "feat(api): add partial index for per-user task resume query"
```

---

## Task 3 — Backend route: `GET /projects/{pid}/tasks/{tid}/resume`

**Files:**
- Modify: `apps/api/src/carve_api/projects/router.py` (add new route immediately below `task_completion_status`, around line 330)
- Test: `apps/api/tests/projects/test_task_resume.py` (extend with route tests)

- [ ] **Step 1 — Write the failing integration tests**

Append to `apps/api/tests/projects/test_task_resume.py`:

```python
from fastapi.testclient import TestClient

from carve_api.deps import get_db
from carve_api.main import create_app


def _client(db_session) -> TestClient:
    app = create_app()

    def _override():
        try:
            yield db_session
        finally:
            db_session.rollback()

    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def _register_and_login(client, email: str) -> str:
    client.post("/auth/register", json={"email": email, "password": "hunter22"})
    return client.post(
        "/auth/login", json={"email": email, "password": "hunter22"}
    ).json()["access_token"]


def _hdr(t: str) -> dict:
    return {"Authorization": f"Bearer {t}"}


def test_resume_returns_empty_payload_when_no_annotations(db_session) -> None:
    client = _client(db_session)
    token = _register_and_login(client, "r1@x.com")
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    tid = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "T", "kind": "image"},
        headers=_hdr(token),
    ).json()["id"]

    r = client.get(f"/projects/{pid}/tasks/{tid}/resume", headers=_hdr(token))

    assert r.status_code == 200, r.text
    body = r.json()
    assert body == {
        "last_asset_id": None,
        "last_frame_id": None,
        "annotated_assets": 0,
        "total_assets": 0,
        "last_activity_at": None,
    }


def test_resume_requires_auth(db_session) -> None:
    client = _client(db_session)
    fake_pid = "00000000-0000-0000-0000-000000000000"
    fake_tid = "00000000-0000-0000-0000-000000000000"
    r = client.get(f"/projects/{fake_pid}/tasks/{fake_tid}/resume")
    assert r.status_code == 401


def test_resume_404_for_unknown_task(db_session) -> None:
    client = _client(db_session)
    token = _register_and_login(client, "r2@x.com")
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    bogus_tid = "00000000-0000-0000-0000-000000000000"
    r = client.get(f"/projects/{pid}/tasks/{bogus_tid}/resume", headers=_hdr(token))
    assert r.status_code == 404


def test_resume_403_for_non_member(db_session) -> None:
    client = _client(db_session)
    owner_token = _register_and_login(client, "owner@x.com")
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(owner_token)).json()["id"]
    tid = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "T", "kind": "image"},
        headers=_hdr(owner_token),
    ).json()["id"]

    outsider_token = _register_and_login(client, "outsider@x.com")
    r = client.get(
        f"/projects/{pid}/tasks/{tid}/resume", headers=_hdr(outsider_token)
    )
    assert r.status_code == 403
```

- [ ] **Step 2 — Run and verify failure**

```bash
cd apps/api && uv run pytest tests/projects/test_task_resume.py -v
```

Expected: schema tests pass; four route tests fail with 404 (route does not exist yet).

- [ ] **Step 3 — Add the route handler**

In `apps/api/src/carve_api/projects/router.py`, immediately after the `task_completion_status` function (around line 330), add:

```python
@router.get(
    "/{project_id}/tasks/{task_id}/resume",
    response_model=TaskResumeStatus,
)
def task_resume(
    project_id: uuid.UUID,
    task_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TaskResumeStatus:
    """Per-user resume status for the editor banner.

    Returns the asset id of the user's most recently updated annotation
    in this task (joined via ``Frame.asset_id``), plus a distinct count
    of assets they've annotated. All four ``last_*`` fields are ``None``
    together when the user has no annotations here yet.
    """
    try:
        project = ProjectService(db).get(actor=user, project_id=project_id)
        task = TaskService(db).get(project=project, task_id=task_id)
    except AppError as exc:
        raise _http(exc) from exc

    total_assets = int(
        db.execute(
            select(func.count(Asset.id)).where(Asset.task_id == task.id)
        ).scalar_one()
        or 0
    )

    last_row = db.execute(
        select(Annotation.frame_id, Annotation.updated_at, Frame.asset_id)
        .join(Frame, Frame.id == Annotation.frame_id)
        .where(
            Annotation.task_id == task.id,
            Annotation.created_by == user.id,
            Annotation.frame_id.is_not(None),
        )
        .order_by(Annotation.updated_at.desc())
        .limit(1)
    ).first()

    annotated_assets = int(
        db.execute(
            select(func.count(func.distinct(Frame.asset_id)))
            .select_from(Annotation)
            .join(Frame, Frame.id == Annotation.frame_id)
            .where(
                Annotation.task_id == task.id,
                Annotation.created_by == user.id,
            )
        ).scalar_one()
        or 0
    )

    if last_row is None:
        return TaskResumeStatus(
            last_asset_id=None,
            last_frame_id=None,
            annotated_assets=annotated_assets,
            total_assets=total_assets,
            last_activity_at=None,
        )

    return TaskResumeStatus(
        last_asset_id=last_row.asset_id,
        last_frame_id=last_row.frame_id,
        annotated_assets=annotated_assets,
        total_assets=total_assets,
        last_activity_at=last_row.updated_at,
    )
```

- [ ] **Step 4 — Add the schema import**

In `apps/api/src/carve_api/projects/router.py`, find the existing block:

```python
from carve_api.projects.schemas import (
    ...
    TaskCompletionStatus,
    TaskIn,
    ...
)
```

Insert `TaskResumeStatus` alphabetically (after `TaskPatch`). Do not duplicate any existing import.

- [ ] **Step 5 — Run tests and verify pass**

```bash
cd apps/api && uv run pytest tests/projects/test_task_resume.py -v
```

Expected: 7 passed (3 schema + 4 route).

- [ ] **Step 6 — Run the broader project test directory for regression check**

```bash
cd apps/api && uv run pytest tests/projects/ -v
```

Expected: all green.

- [ ] **Step 7 — Commit**

```bash
git add apps/api/src/carve_api/projects/router.py apps/api/tests/projects/test_task_resume.py
git commit -m "feat(api): add per-user task resume endpoint"
```

---

## Task 4 — Backend route: happy-path and isolation coverage

The previous task covered empty/auth/404/403. This task covers the **happy path**: create real annotations and assert the response matches.

**Files:**
- Test: `apps/api/tests/projects/test_task_resume.py` (extend)

- [ ] **Step 1 — Inspect existing model constructors**

```bash
grep -nE "^class (Asset|Frame|Class)\b" apps/api/src/carve_api/assets/models.py apps/api/src/carve_api/projects/models.py
```

Then read each class definition to see required fields. The test below assumes:
- `Asset(id, task_id, kind, filename)` is sufficient
- `Frame(id, asset_id, index)` is sufficient
- `Class(id, project_id, name, color)` is sufficient

If any of these need additional non-nullable columns (e.g. width/height on `Asset`, `frame_count`, etc.), fill in real values rather than NULL. **Read the model — do not guess.**

- [ ] **Step 2 — Add the happy-path tests**

Append to `apps/api/tests/projects/test_task_resume.py`:

```python
import uuid as _uuid

from carve_api.annotations.models import Annotation, AnnotationKind
from carve_api.assets.models import Asset, Frame
from carve_api.projects.models import Class


def _make_class(db_session, project_id, name: str = "obj"):
    cls = Class(id=_uuid.uuid4(), project_id=project_id, name=name, color="#fff")
    db_session.add(cls)
    db_session.flush()
    return cls


def _make_asset_with_frame(db_session, task_id):
    asset = Asset(id=_uuid.uuid4(), task_id=task_id, kind="image", filename="x.jpg")
    db_session.add(asset)
    db_session.flush()
    frame = Frame(id=_uuid.uuid4(), asset_id=asset.id, index=0)
    db_session.add(frame)
    db_session.flush()
    return asset, frame


def _make_bbox(db_session, task_id, frame_id, class_id, user_id):
    ann = Annotation(
        id=_uuid.uuid4(),
        task_id=task_id,
        frame_id=frame_id,
        class_id=class_id,
        kind=AnnotationKind.bbox,
        geometry={"x": 0, "y": 0, "w": 10, "h": 10},
        created_by=user_id,
    )
    db_session.add(ann)
    db_session.flush()
    return ann


def test_resume_returns_latest_asset_and_correct_counts(db_session) -> None:
    """User annotates three assets. Resume points at the most recent
    one and counts distinct assets correctly."""
    client = _client(db_session)
    token = _register_and_login(client, "happy@x.com")
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    tid = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "T", "kind": "image"},
        headers=_hdr(token),
    ).json()["id"]

    me = client.get("/auth/me", headers=_hdr(token)).json()
    user_id = _uuid.UUID(me["id"])

    cls = _make_class(db_session, _uuid.UUID(pid))

    a1, f1 = _make_asset_with_frame(db_session, _uuid.UUID(tid))
    a2, f2 = _make_asset_with_frame(db_session, _uuid.UUID(tid))
    a3, f3 = _make_asset_with_frame(db_session, _uuid.UUID(tid))

    _make_bbox(db_session, _uuid.UUID(tid), f1.id, cls.id, user_id)
    _make_bbox(db_session, _uuid.UUID(tid), f2.id, cls.id, user_id)
    _make_bbox(db_session, _uuid.UUID(tid), f3.id, cls.id, user_id)
    db_session.commit()

    r = client.get(f"/projects/{pid}/tasks/{tid}/resume", headers=_hdr(token))
    assert r.status_code == 200, r.text
    body = r.json()

    assert body["last_asset_id"] == str(a3.id)
    assert body["last_frame_id"] == str(f3.id)
    assert body["annotated_assets"] == 3
    assert body["total_assets"] == 3
    assert body["last_activity_at"] is not None


def test_resume_isolates_users(db_session) -> None:
    """User B's annotations do not leak into User A's resume."""
    client = _client(db_session)
    token_a = _register_and_login(client, "a@x.com")
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token_a)).json()["id"]
    tid = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "T", "kind": "image"},
        headers=_hdr(token_a),
    ).json()["id"]

    token_b = _register_and_login(client, "b@x.com")
    client.post(
        f"/projects/{pid}/members",
        json={"email": "b@x.com", "role": "annotator"},
        headers=_hdr(token_a),
    )

    me_a = client.get("/auth/me", headers=_hdr(token_a)).json()
    me_b = client.get("/auth/me", headers=_hdr(token_b)).json()
    uid_a = _uuid.UUID(me_a["id"])
    uid_b = _uuid.UUID(me_b["id"])

    cls = _make_class(db_session, _uuid.UUID(pid))
    a1, f1 = _make_asset_with_frame(db_session, _uuid.UUID(tid))
    a2, f2 = _make_asset_with_frame(db_session, _uuid.UUID(tid))

    _make_bbox(db_session, _uuid.UUID(tid), f1.id, cls.id, uid_a)
    _make_bbox(db_session, _uuid.UUID(tid), f2.id, cls.id, uid_b)
    db_session.commit()

    body_a = client.get(
        f"/projects/{pid}/tasks/{tid}/resume", headers=_hdr(token_a)
    ).json()
    body_b = client.get(
        f"/projects/{pid}/tasks/{tid}/resume", headers=_hdr(token_b)
    ).json()

    assert body_a["last_asset_id"] == str(a1.id)
    assert body_a["annotated_assets"] == 1
    assert body_b["last_asset_id"] == str(a2.id)
    assert body_b["annotated_assets"] == 1


def test_resume_ignores_null_frame_id(db_session) -> None:
    """Tag-kind annotations (frame_id=NULL) must not become the resume target."""
    client = _client(db_session)
    token = _register_and_login(client, "null@x.com")
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    tid = client.post(
        f"/projects/{pid}/tasks",
        json={"name": "T", "kind": "image"},
        headers=_hdr(token),
    ).json()["id"]
    me = client.get("/auth/me", headers=_hdr(token)).json()
    uid = _uuid.UUID(me["id"])

    cls = _make_class(db_session, _uuid.UUID(pid))
    a1, f1 = _make_asset_with_frame(db_session, _uuid.UUID(tid))

    db_session.add(
        Annotation(
            id=_uuid.uuid4(),
            task_id=_uuid.UUID(tid),
            frame_id=None,
            class_id=cls.id,
            kind=AnnotationKind.tag,
            geometry={"label": "scene"},
            created_by=uid,
        )
    )
    _make_bbox(db_session, _uuid.UUID(tid), f1.id, cls.id, uid)
    db_session.commit()

    body = client.get(
        f"/projects/{pid}/tasks/{tid}/resume", headers=_hdr(token)
    ).json()
    assert body["last_asset_id"] == str(a1.id)
    assert body["last_frame_id"] == str(f1.id)
```

- [ ] **Step 3 — Run and verify pass**

```bash
cd apps/api && uv run pytest tests/projects/test_task_resume.py -v
```

Expected: 10 passed (3 schema + 4 auth/empty + 3 happy-path).

- [ ] **Step 4 — Commit**

```bash
git add apps/api/tests/projects/test_task_resume.py
git commit -m "test(api): cover resume endpoint happy paths and user isolation"
```

---

## Task 5 — Frontend API client

**Files:**
- Modify: `apps/web/src/api/tasks.ts`

- [ ] **Step 1 — Find the existing call shape**

Look at how `fetchTaskCompletionStatus` is implemented around line 124 of `apps/web/src/api/tasks.ts`. The new call must mirror it exactly (same `api(...)` helper, same error handling).

```bash
sed -n '115,140p' apps/web/src/api/tasks.ts
```

- [ ] **Step 2 — Add the response type and fetch function**

At the bottom of `apps/web/src/api/tasks.ts`, add:

```typescript
/**
 * Per-user resume payload returned by
 * ``GET /projects/{pid}/tasks/{tid}/resume``. Drives the
 * <ResumeProgressBanner /> on AnnotateAssetPage.
 *
 * All four ``last_*`` fields are null together when the user has no
 * annotations in this task yet.
 */
export interface TaskResumeStatusResponse {
  last_asset_id: string | null;
  last_frame_id: string | null;
  annotated_assets: number;
  total_assets: number;
  last_activity_at: string | null;
}

export async function fetchTaskResumeStatus(
  projectId: string,
  taskId: string,
): Promise<TaskResumeStatusResponse> {
  return api<TaskResumeStatusResponse>(
    `/projects/${projectId}/tasks/${taskId}/resume`,
  );
}
```

> If the local `api(...)` helper has a different signature than shown, adapt to match the surrounding code. Do **not** introduce a new HTTP utility.

- [ ] **Step 3 — Type-check**

```bash
pnpm --filter @carve/web tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4 — Commit**

```bash
git add apps/web/src/api/tasks.ts
git commit -m "feat(web): add fetchTaskResumeStatus client"
```

---

## Task 6 — `relativeTime` helper

**Files:**
- Create: `apps/web/src/lib/relativeTime.ts`
- Test: `apps/web/src/lib/__tests__/relativeTime.test.ts`

- [ ] **Step 1 — Write the failing test**

Create `apps/web/src/lib/__tests__/relativeTime.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { formatRelativeTime } from "../relativeTime";

describe("formatRelativeTime", () => {
  const now = new Date("2026-05-26T12:00:00Z").getTime();

  it("returns 'moments ago' under 60 seconds", () => {
    const past = new Date("2026-05-26T11:59:30Z").toISOString();
    expect(formatRelativeTime(past, now)).toBe("moments ago");
  });

  it("returns minutes for under an hour", () => {
    const past = new Date("2026-05-26T11:30:00Z").toISOString();
    expect(formatRelativeTime(past, now)).toMatch(/30 minutes ago|half an hour ago/);
  });

  it("returns hours for under a day", () => {
    const past = new Date("2026-05-26T06:00:00Z").toISOString();
    expect(formatRelativeTime(past, now)).toMatch(/6 hours ago/);
  });

  it("returns 'yesterday' for 24-48h", () => {
    const past = new Date("2026-05-25T12:00:00Z").toISOString();
    expect(formatRelativeTime(past, now)).toMatch(/yesterday|1 day ago/);
  });

  it("returns days for longer ranges", () => {
    const past = new Date("2026-05-20T12:00:00Z").toISOString();
    expect(formatRelativeTime(past, now)).toMatch(/6 days ago/);
  });

  it("returns empty string for null input", () => {
    expect(formatRelativeTime(null, now)).toBe("");
  });
});
```

- [ ] **Step 2 — Run and verify failure**

```bash
pnpm --filter @carve/web test --run src/lib/__tests__/relativeTime.test.ts
```

Expected: module not found.

- [ ] **Step 3 — Implement**

Create `apps/web/src/lib/relativeTime.ts`:

```typescript
const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Format an ISO-8601 timestamp as a relative phrase like
 * "moments ago", "30 minutes ago", "yesterday", "6 days ago".
 *
 * @param iso  past timestamp, or null (returns empty string)
 * @param now  optional reference time in ms — for deterministic tests
 */
export function formatRelativeTime(
  iso: string | null,
  now: number = Date.now(),
): string {
  if (iso === null) return "";
  const past = new Date(iso).getTime();
  const diff = now - past;
  if (diff < MINUTE) return "moments ago";
  if (diff < HOUR) return formatter.format(-Math.floor(diff / MINUTE), "minute");
  if (diff < DAY) return formatter.format(-Math.floor(diff / HOUR), "hour");
  return formatter.format(-Math.floor(diff / DAY), "day");
}
```

- [ ] **Step 4 — Run tests and verify pass**

```bash
pnpm --filter @carve/web test --run src/lib/__tests__/relativeTime.test.ts
```

Expected: 6 passed.

- [ ] **Step 5 — Commit**

```bash
git add apps/web/src/lib/relativeTime.ts apps/web/src/lib/__tests__/relativeTime.test.ts
git commit -m "feat(web): add formatRelativeTime helper"
```

---

## Task 7 — `useTaskResume` hook

**Files:**
- Create: `apps/web/src/hooks/useTaskResume.ts`

This task has no dedicated hook test — the hook is a thin TanStack Query wrapper, fully exercised through the banner component tests in Task 8.

- [ ] **Step 1 — Implement the hook**

Create `apps/web/src/hooks/useTaskResume.ts`:

```typescript
import { useQuery } from "@tanstack/react-query";

import {
  fetchTaskResumeStatus,
  type TaskResumeStatusResponse,
} from "../api/tasks";

export function useTaskResume(
  projectId: string | undefined,
  taskId: string | undefined,
) {
  return useQuery<TaskResumeStatusResponse>({
    queryKey: ["task-resume", projectId, taskId],
    queryFn: () => fetchTaskResumeStatus(projectId!, taskId!),
    enabled: Boolean(projectId) && Boolean(taskId),
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });
}
```

Why `staleTime: 0` + `refetchOnMount: "always"`: each task page mount is a fresh "did I work here before" question. We never want a cached banner that's already stale.

- [ ] **Step 2 — Type-check**

```bash
pnpm --filter @carve/web tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3 — Commit**

```bash
git add apps/web/src/hooks/useTaskResume.ts
git commit -m "feat(web): add useTaskResume TanStack query hook"
```

---

## Task 8 — `<ResumeProgressBanner />` component

**Files:**
- Create: `apps/web/src/components/annotation/ResumeProgressBanner.tsx`
- Create: `apps/web/src/components/annotation/__tests__/ResumeProgressBanner.test.tsx`

- [ ] **Step 1 — Write the failing tests**

Create `apps/web/src/components/annotation/__tests__/ResumeProgressBanner.test.tsx`:

```typescript
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { ResumeProgressBanner } from "../ResumeProgressBanner";

const mockFetch = vi.fn();
vi.mock("../../../api/tasks", () => ({
  fetchTaskResumeStatus: (...args: unknown[]) => mockFetch(...args),
}));

function withClient(ui: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe("<ResumeProgressBanner />", () => {
  it("renders nothing while loading", () => {
    mockFetch.mockReturnValue(new Promise(() => {}));
    render(
      withClient(
        <ResumeProgressBanner
          projectId="p1"
          taskId="t1"
          currentAssetId="a-current"
          onResume={() => undefined}
        />,
      ),
    );
    expect(
      screen.queryByText(/you last annotated/i),
    ).not.toBeInTheDocument();
  });

  it("renders nothing when last_asset_id is null", async () => {
    mockFetch.mockResolvedValue({
      last_asset_id: null,
      last_frame_id: null,
      annotated_assets: 0,
      total_assets: 10,
      last_activity_at: null,
    });
    render(
      withClient(
        <ResumeProgressBanner
          projectId="p1"
          taskId="t1"
          currentAssetId="a-current"
          onResume={() => undefined}
        />,
      ),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(/you last annotated/i)).not.toBeInTheDocument();
  });

  it("renders nothing when the resume target is the current asset", async () => {
    mockFetch.mockResolvedValue({
      last_asset_id: "a-current",
      last_frame_id: "f1",
      annotated_assets: 5,
      total_assets: 10,
      last_activity_at: new Date(Date.now() - 60_000).toISOString(),
    });
    render(
      withClient(
        <ResumeProgressBanner
          projectId="p1"
          taskId="t1"
          currentAssetId="a-current"
          onResume={() => undefined}
        />,
      ),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(/you last annotated/i)).not.toBeInTheDocument();
  });

  it("shows banner with counts and offers Resume + Dismiss", async () => {
    mockFetch.mockResolvedValue({
      last_asset_id: "a-resume",
      last_frame_id: "f-resume",
      annotated_assets: 350,
      total_assets: 1000,
      last_activity_at: new Date(Date.now() - 60_000).toISOString(),
    });
    render(
      withClient(
        <ResumeProgressBanner
          projectId="p1"
          taskId="t1"
          currentAssetId="a-current"
          onResume={() => undefined}
        />,
      ),
    );
    expect(
      await screen.findByText((t) => /350 of 1000/.test(t)),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /resume/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /dismiss/i })).toBeInTheDocument();
  });

  it("calls onResume with the last_asset_id when Resume clicked", async () => {
    const onResume = vi.fn();
    mockFetch.mockResolvedValue({
      last_asset_id: "a-resume",
      last_frame_id: "f-resume",
      annotated_assets: 5,
      total_assets: 10,
      last_activity_at: new Date(Date.now() - 60_000).toISOString(),
    });
    render(
      withClient(
        <ResumeProgressBanner
          projectId="p1"
          taskId="t1"
          currentAssetId="a-current"
          onResume={onResume}
        />,
      ),
    );
    const btn = await screen.findByRole("button", { name: /resume/i });
    await userEvent.click(btn);
    expect(onResume).toHaveBeenCalledWith("a-resume");
  });

  it("hides itself permanently after Dismiss in this session", async () => {
    mockFetch.mockResolvedValue({
      last_asset_id: "a-resume",
      last_frame_id: "f-resume",
      annotated_assets: 5,
      total_assets: 10,
      last_activity_at: new Date(Date.now() - 60_000).toISOString(),
    });
    render(
      withClient(
        <ResumeProgressBanner
          projectId="p1"
          taskId="t1"
          currentAssetId="a-current"
          onResume={() => undefined}
        />,
      ),
    );
    const dismiss = await screen.findByRole("button", { name: /dismiss/i });
    await userEvent.click(dismiss);
    expect(screen.queryByText(/you last annotated/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2 — Run and verify failure**

```bash
pnpm --filter @carve/web test --run src/components/annotation/__tests__/ResumeProgressBanner.test.tsx
```

Expected: module not found.

- [ ] **Step 3 — Implement the component**

Create `apps/web/src/components/annotation/ResumeProgressBanner.tsx`:

```typescript
import { useState } from "react";

import { useTaskResume } from "../../hooks/useTaskResume";
import { formatRelativeTime } from "../../lib/relativeTime";

interface ResumeProgressBannerProps {
  projectId: string | undefined;
  taskId: string | undefined;
  /** asset id currently displayed in the editor */
  currentAssetId: string | undefined;
  /** parent navigates to (taskId, assetId) on Resume click */
  onResume: (assetId: string) => void;
}

/**
 * Editor banner. Tells the user where they left off in this task and
 * offers to jump there. Per-user, per-task. In-memory dismiss only —
 * re-opening the task brings the banner back.
 *
 * Hidden when:
 *   - the resume query is loading
 *   - the user has no annotations here yet
 *   - the resume target is the asset already on screen
 *   - the user dismissed it in this session
 */
export function ResumeProgressBanner({
  projectId,
  taskId,
  currentAssetId,
  onResume,
}: ResumeProgressBannerProps) {
  const [dismissed, setDismissed] = useState(false);
  const { data, isLoading } = useTaskResume(projectId, taskId);

  if (isLoading || !data || dismissed) return null;
  if (data.last_asset_id === null) return null;
  if (data.last_asset_id === currentAssetId) return null;

  const relativeTime = formatRelativeTime(data.last_activity_at);
  const targetAssetId = data.last_asset_id;

  return (
    <div
      role="status"
      className="flex items-center justify-between gap-3 border-b border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-100"
      data-testid="resume-progress-banner"
    >
      <p>
        You last annotated{" "}
        <strong>
          {data.annotated_assets} of {data.total_assets}
        </strong>{" "}
        images here
        {relativeTime ? ` — last activity ${relativeTime}` : ""}.
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          className="rounded bg-blue-600 px-3 py-1 text-white hover:bg-blue-500"
          onClick={() => onResume(targetAssetId)}
        >
          Resume there
        </button>
        <button
          type="button"
          className="rounded border border-zinc-600 px-3 py-1 text-zinc-200 hover:bg-zinc-800"
          onClick={() => setDismissed(true)}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
```

> The Tailwind classes above match the codebase's existing dark editor surface. If the project's actual Tailwind theme tokens differ, swap them for the closest existing utility classes already used in `apps/web/src/components/annotation/`. **Do not introduce new tokens for this banner.**

- [ ] **Step 4 — Run tests and verify pass**

```bash
pnpm --filter @carve/web test --run src/components/annotation/__tests__/ResumeProgressBanner.test.tsx
```

Expected: 6 passed.

- [ ] **Step 5 — Type-check**

```bash
pnpm --filter @carve/web tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6 — Commit**

```bash
git add apps/web/src/components/annotation/ResumeProgressBanner.tsx apps/web/src/components/annotation/__tests__/ResumeProgressBanner.test.tsx
git commit -m "feat(web): add ResumeProgressBanner component"
```

---

## Task 9 — Mount the banner in `AnnotateAssetPage`

**Files:**
- Modify: `apps/web/src/pages/AnnotateAssetPage.tsx`

- [ ] **Step 1 — Locate the right mount point**

Open `apps/web/src/pages/AnnotateAssetPage.tsx` and identify:

1. The line where `projectId`, `taskId`, and `assetId` are read from URL params. Search: `useParams`.
2. The line where the editor canvas is rendered, immediately after the toolbar. The banner must mount **after** the toolbar and **before** the canvas, full editor width.
3. The function that navigates to a different asset within the same task. Search for existing `navigate(...)` calls inside the file that switch assets — the banner's `onResume` will reuse the same call.

Run:

```bash
grep -nE "useParams|navigate\(.*assets|setAssetId\(" apps/web/src/pages/AnnotateAssetPage.tsx | head -20
```

- [ ] **Step 2 — Import the banner**

Near the top of the file (with the other component imports), add:

```typescript
import { ResumeProgressBanner } from "../components/annotation/ResumeProgressBanner";
```

- [ ] **Step 3 — Mount the banner**

Inside the JSX, between the toolbar and the canvas container, add:

```tsx
<ResumeProgressBanner
  projectId={projectId}
  taskId={taskId}
  currentAssetId={assetId}
  onResume={(targetAssetId) => {
    // Reuse the existing intra-task navigation pattern found in Step 1.
    // Example shape (replace with the exact local call already in this file):
    //   navigate(`/projects/${projectId}/tasks/${taskId}/assets/${targetAssetId}`);
    navigateToAsset(targetAssetId);
  }}
/>
```

> Replace `navigateToAsset(...)` with whatever this file already uses for asset switching. **Do not invent a new navigation function** — reuse the existing one.

- [ ] **Step 4 — Type-check**

```bash
pnpm --filter @carve/web tsc --noEmit
```

Expected: no errors. If `projectId` / `taskId` / `assetId` have different local names, fix the prop bindings to match.

- [ ] **Step 5 — Run frontend tests for regression check**

```bash
pnpm --filter @carve/web test --run src/components/annotation src/lib src/hooks
```

Expected: green (or no worse than the existing baseline; the file `annotation-context-menu.test.tsx` has pre-existing failures from prior work — **do not fix them in this plan**).

- [ ] **Step 6 — Commit**

```bash
git add apps/web/src/pages/AnnotateAssetPage.tsx
git commit -m "feat(web): mount ResumeProgressBanner in AnnotateAssetPage"
```

---

## Task 10 — Manual verification in the running app

The codebase has no Playwright harness today. Final verification is manual but scripted.

- [ ] **Step 1 — Rebuild the web container**

```bash
docker compose up -d --build carve-web && docker compose restart carve-web
```

Expected: container reports healthy.

- [ ] **Step 2 — Verify "no annotations" path**

1. Sign in as a user who has not annotated in any task.
2. Open any task in the editor.
3. **Confirm:** no banner appears.

- [ ] **Step 3 — Verify happy path**

1. As that user, draw a bbox on three images in a row in the same task.
2. Close the tab.
3. Reopen the task in a fresh tab.
4. **Confirm:** banner appears reading *"You last annotated **3 of N** images here — last activity moments ago."*
5. Click **Resume there** — editor lands on the third image.

- [ ] **Step 4 — Verify multi-user isolation**

1. As user A, open the same task as in step 3 (banner still appears on a fresh tab).
2. As user B (different login), open the same task.
3. **Confirm:** user B sees no banner (no annotations of their own) or a different banner reflecting their own progress.

- [ ] **Step 5 — Verify Dismiss**

1. In a tab where the banner is shown, click **Dismiss**.
2. **Confirm:** banner disappears.
3. Navigate to a different asset in the same task.
4. **Confirm:** banner stays hidden.
5. Close and reopen the task tab.
6. **Confirm:** banner returns (session-only dismissal).

- [ ] **Step 6 — Verify "you're already there"**

1. Click **Resume there** to navigate to the resume target asset.
2. **Confirm:** banner hides itself once that asset is the current one.

- [ ] **Step 7 — Final commit (if anything tweaked)**

If any UI string or class needed adjustment during manual testing, commit those tweaks separately:

```bash
git add <changed files>
git commit -m "chore(web): adjust ResumeProgressBanner copy/styles after manual QA"
```

If nothing changed, skip this step.

---

## Self-Review Checklist

Before declaring the plan complete:

- [ ] All test files for this plan are green:
  - `apps/api/tests/projects/test_task_resume.py` (10 tests)
  - `apps/web/src/lib/__tests__/relativeTime.test.ts` (6 tests)
  - `apps/web/src/components/annotation/__tests__/ResumeProgressBanner.test.tsx` (6 tests)
- [ ] Backend regression suite green: `cd apps/api && uv run pytest tests/projects/`
- [ ] Type check is clean: `pnpm --filter @carve/web tsc --noEmit`
- [ ] Migration applies clean both up and down.
- [ ] All six manual verification steps in Task 10 pass.
- [ ] Commits follow the conventional-commits format (`feat`, `test`, `chore`).

## Out of Scope (Documented in Spec)

Explicitly **not** in this plan:
- Persisting Dismiss across task re-opens.
- Team-wide / shared progress banner.
- "Jump to next un-annotated frame" action.
- Per-asset "reviewed / empty" marker.
- Refactoring the `updated_at`-on-review-status-change quirk; documented in the spec for a follow-up if needed.
