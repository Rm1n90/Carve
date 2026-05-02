"""Tests for Plan-13 Phase 7 Task 10 quality dashboard endpoints."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

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


def _hdr(t: str) -> dict:
    return {"Authorization": f"Bearer {t}"}


def _bootstrap_admin(client, email: str) -> str:
    """First register call creates the bootstrap admin and returns the token."""
    client.post("/auth/register", json={"email": email, "password": "hunter22"})
    return client.post(
        "/auth/login", json={"email": email, "password": "hunter22"}
    ).json()["access_token"]


def _register_member(client, *, admin_token: str, email: str) -> None:
    """Subsequent registrations require admin auth."""
    client.post(
        "/auth/register",
        json={"email": email, "password": "hunter22"},
        headers=_hdr(admin_token),
    )


def _user_id_for(db_session, email: str) -> str:
    from carve_api.auth.models import User

    return str(db_session.query(User).filter_by(email=email).one().id)


def _make_project(client, token: str) -> str:
    return client.post(
        "/projects", json={"name": "P"}, headers=_hdr(token)
    ).json()["id"]


def _make_task(client, token: str, pid: str, name: str = "T") -> str:
    return client.post(
        f"/projects/{pid}/tasks",
        json={"name": name, "kind": "image"},
        headers=_hdr(token),
    ).json()["id"]


def _make_class(client, token: str, pid: str, idx: int, name: str) -> str:
    return client.post(
        f"/projects/{pid}/classes",
        json={"idx": idx, "name": name, "color": "#ff0000"},
        headers=_hdr(token),
    ).json()["id"]


def _seed_reviewed_annotation(
    db_session,
    *,
    task_id: str,
    class_id: str,
    reviewer_id: str,
    status: str,
    reviewed_at: datetime,
) -> None:
    from carve_api.annotations.models import Annotation, AnnotationKind

    a = Annotation(
        task_id=uuid.UUID(task_id),
        class_id=uuid.UUID(class_id),
        kind=AnnotationKind.bbox,
        geometry={"x": 0, "y": 0, "w": 10, "h": 10},
        status=status,
        reviewed_by_id=uuid.UUID(reviewer_id),
        reviewed_at=reviewed_at,
    )
    db_session.add(a)
    db_session.flush()


def _seed_unreviewed_annotation(
    db_session, *, task_id: str, class_id: str, status: str = "proposed"
) -> None:
    from carve_api.annotations.models import Annotation, AnnotationKind

    a = Annotation(
        task_id=uuid.UUID(task_id),
        class_id=uuid.UUID(class_id),
        kind=AnnotationKind.bbox,
        geometry={"x": 0, "y": 0, "w": 10, "h": 10},
        status=status,
    )
    db_session.add(a)
    db_session.flush()


def _seed_weight(
    db_session,
    *,
    project_id: str,
    created_at: datetime,
    metadata_: dict | None,
) -> str:
    from carve_api.weights.models import Weight, WeightTaskKind

    w = Weight(
        project_id=uuid.UUID(project_id),
        name="w",
        task_kind=WeightTaskKind.detect,
        minio_key="key",
        size_bytes=1,
        class_names=[],
        metadata_=metadata_,
    )
    db_session.add(w)
    db_session.flush()
    if created_at is not None:
        w.created_at = created_at
        db_session.flush()
    return str(w.id)


def test_reviewer_quality_three_reviewers_five_each(db_session) -> None:
    client = _client(db_session)
    owner_token = _bootstrap_admin(client, "owner@x.com")
    pid = _make_project(client, owner_token)
    tid = _make_task(client, owner_token, pid)
    cid = _make_class(client, owner_token, pid, idx=0, name="car")

    # Three reviewers, 5 reviewed annotations each.
    # Reviewer A: 5/5 accepted; B: 3/5 accepted; C: 0/5 accepted.
    reviewers: list[str] = []
    for em in ("a@x.com", "b@x.com", "c@x.com"):
        _register_member(client, admin_token=owner_token, email=em)
        reviewers.append(_user_id_for(db_session, em))

    now = datetime.now(timezone.utc)
    plans = [
        (reviewers[0], ["accepted"] * 5),
        (reviewers[1], ["accepted"] * 3 + ["rejected"] * 2),
        (reviewers[2], ["rejected"] * 5),
    ]
    for rid, statuses in plans:
        for status in statuses:
            _seed_reviewed_annotation(
                db_session,
                task_id=tid,
                class_id=cid,
                reviewer_id=rid,
                status=status,
                reviewed_at=now - timedelta(days=1),
            )

    r = client.get(
        f"/projects/{pid}/stats/reviewer-quality", headers=_hdr(owner_token)
    )
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    by_email = {row["email"]: row for row in items}

    assert by_email["a@x.com"]["total_reviewed"] == 5
    assert by_email["a@x.com"]["accepted"] == 5
    assert by_email["a@x.com"]["accept_rate"] == 1.0

    assert by_email["b@x.com"]["total_reviewed"] == 5
    assert by_email["b@x.com"]["accepted"] == 3
    assert by_email["b@x.com"]["rejected"] == 2
    assert by_email["b@x.com"]["accept_rate"] == 0.6

    assert by_email["c@x.com"]["total_reviewed"] == 5
    assert by_email["c@x.com"]["accepted"] == 0
    assert by_email["c@x.com"]["accept_rate"] == 0.0


def test_reviewer_quality_omits_zero_review_users(db_session) -> None:
    client = _client(db_session)
    owner_token = _bootstrap_admin(client, "owner2@x.com")
    pid = _make_project(client, owner_token)
    tid = _make_task(client, owner_token, pid)
    _ = _make_class(client, owner_token, pid, idx=0, name="car")
    # No annotations seeded.

    r = client.get(
        f"/projects/{pid}/stats/reviewer-quality", headers=_hdr(owner_token)
    )
    assert r.status_code == 200, r.text
    assert r.json()["items"] == []
    _ = tid  # silence unused warning


def test_retrain_history_sorts_ascending_and_filters_null(db_session) -> None:
    client = _client(db_session)
    owner_token = _bootstrap_admin(client, "ret@x.com")
    pid = _make_project(client, owner_token)

    base = datetime.now(timezone.utc) - timedelta(days=10)
    # Three retrain-tagged weights (oldest → newest expected order),
    # plus one non-retrain weight that should be filtered out.
    w_old = _seed_weight(
        db_session,
        project_id=pid,
        created_at=base,
        metadata_={"retrain": {"epochs": 10, "imgsz": 640, "metrics": {"mAP50": 0.7}}},
    )
    w_mid = _seed_weight(
        db_session,
        project_id=pid,
        created_at=base + timedelta(days=2),
        metadata_={"retrain": {"epochs": 20, "imgsz": 640, "metrics": {"mAP50": 0.78}}},
    )
    w_new = _seed_weight(
        db_session,
        project_id=pid,
        created_at=base + timedelta(days=4),
        metadata_={"retrain": {"epochs": 30, "imgsz": 640, "metrics": {"mAP50": 0.81}}},
    )
    _seed_weight(
        db_session,
        project_id=pid,
        created_at=base + timedelta(days=5),
        metadata_=None,
    )

    r = client.get(
        f"/projects/{pid}/stats/retrain-history", headers=_hdr(owner_token)
    )
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    ids = [it["weight_id"] for it in items]
    assert ids == [w_old, w_mid, w_new]
    assert items[0]["epochs"] == 10
    assert items[-1]["metrics"]["mAP50"] == 0.81


def test_per_class_quality_math(db_session) -> None:
    client = _client(db_session)
    owner_token = _bootstrap_admin(client, "pcq@x.com")
    pid = _make_project(client, owner_token)
    tid = _make_task(client, owner_token, pid)
    _register_member(client, admin_token=owner_token, email="rev@x.com")
    reviewer_uid = _user_id_for(db_session, "rev@x.com")

    c_half = _make_class(client, owner_token, pid, idx=0, name="half")
    c_perfect = _make_class(client, owner_token, pid, idx=1, name="perfect")
    c_unreviewed = _make_class(client, owner_token, pid, idx=2, name="untouched")

    now = datetime.now(timezone.utc)
    # half: 5 accepted + 5 rejected => 0.5
    for _ in range(5):
        _seed_reviewed_annotation(
            db_session,
            task_id=tid,
            class_id=c_half,
            reviewer_id=reviewer_uid,
            status="accepted",
            reviewed_at=now,
        )
    for _ in range(5):
        _seed_reviewed_annotation(
            db_session,
            task_id=tid,
            class_id=c_half,
            reviewer_id=reviewer_uid,
            status="rejected",
            reviewed_at=now,
        )
    # perfect: 3 accepted + 0 rejected => 1.0
    for _ in range(3):
        _seed_reviewed_annotation(
            db_session,
            task_id=tid,
            class_id=c_perfect,
            reviewer_id=reviewer_uid,
            status="accepted",
            reviewed_at=now,
        )
    # untouched: 2 proposed (none reviewed) => proxy_precision is None
    for _ in range(2):
        _seed_unreviewed_annotation(db_session, task_id=tid, class_id=c_unreviewed)

    r = client.get(f"/tasks/{tid}/stats/per-class-quality", headers=_hdr(owner_token))
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    by_name = {row["name"]: row for row in items}

    assert by_name["half"]["accepted"] == 5
    assert by_name["half"]["rejected"] == 5
    assert by_name["half"]["proxy_precision"] == 0.5

    assert by_name["perfect"]["accepted"] == 3
    assert by_name["perfect"]["rejected"] == 0
    assert by_name["perfect"]["proxy_precision"] == 1.0

    assert by_name["untouched"]["proposed"] == 2
    assert by_name["untouched"]["proxy_precision"] is None
