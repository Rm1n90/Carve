# Armin Mehri — mehri.armin@gmail.com
"""Task-wide box -> polygon / mask conversion on the worker, and the
endpoints the progress dialog uses."""

from __future__ import annotations

import io
import uuid

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import select

from carve_api.annotations.models import Annotation, AnnotationKind
from carve_api.assets import router as assets_router
from carve_api.deps import get_db
from carve_api.inference import box_convert_batch as bc
from carve_api.inference import box_convert_router as bcr
from carve_api.main import create_app


class FakeRedis:
    """The hash, list and string calls the job and the endpoints use."""

    def __init__(self) -> None:
        self.h: dict[str, dict[str, str]] = {}
        self.lists: dict[str, list[str]] = {}
        self.kv: dict[str, str] = {}

    def hset(self, k, f=None, v=None, mapping=None):
        d = self.h.setdefault(k, {})
        if mapping:
            d.update({kk: str(vv) for kk, vv in mapping.items()})
        else:
            d[f] = str(v)

    def hget(self, k, f):
        return self.h.get(k, {}).get(f)

    def hgetall(self, k):
        return dict(self.h.get(k, {}))

    def expire(self, k, ttl):
        pass

    def rpush(self, k, v):
        self.lists.setdefault(k, []).append(v)

    def ltrim(self, k, a, b):
        pass

    def lrange(self, k, a, b):
        xs = self.lists.get(k, [])
        a = max(0, len(xs) + a) if a < 0 else a
        b = len(xs) + b if b < 0 else b
        return xs[a : b + 1]

    def get(self, k):
        return self.kv.get(k)

    def set(self, k, v, ex=None):
        self.kv[k] = str(v)

    def ping(self):
        return True


class _FakeStorage:
    @classmethod
    def from_settings(cls):
        return cls()

    def ensure_bucket(self):
        pass

    def put_object(self, *a, **k):
        pass

    def get_object(self, key):
        return io.BytesIO(_png())

    def remove_object(self, key):
        pass

    def presigned_get(self, key, **k):
        return f"https://fake/{key}"


def _png() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (40, 30), (20, 30, 40)).save(buf, format="PNG")
    return buf.getvalue()


def _hdr(t):
    return {"Authorization": f"Bearer {t}"}


def _client(db_session, monkeypatch):
    from carve_api.assets import service as svc_mod
    from carve_api.inference import autoannotate

    monkeypatch.setattr(svc_mod, "MinioClient", _FakeStorage)
    monkeypatch.setattr(assets_router, "MinioClient", _FakeStorage)
    monkeypatch.setattr(autoannotate, "MinioClient", _FakeStorage)
    app = create_app()

    def _override():
        try:
            yield db_session
        finally:
            db_session.rollback()

    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def _bind_session_factory(db_session, monkeypatch):
    from sqlalchemy.orm import sessionmaker

    from carve_api import db as db_mod

    factory = sessionmaker(
        bind=db_session.get_bind(),
        autoflush=False,
        expire_on_commit=False,
        future=True,
        join_transaction_mode="create_savepoint",
    )
    monkeypatch.setattr(db_mod, "get_session_factory", lambda: factory)


def _box(db, tid, fid, cid, x=0, conf=0.9, status="proposed"):
    a = Annotation(
        task_id=uuid.UUID(tid),
        frame_id=uuid.UUID(fid),
        class_id=uuid.UUID(cid),
        kind=AnnotationKind.bbox,
        geometry={"kind": "bbox", "x": x, "y": 0, "w": 10, "h": 10},
        confidence=conf,
        visible=2,
        status=status,
    )
    db.add(a)
    db.commit()
    return a.id


def _scene(db_session, monkeypatch):
    """img1: person, crowd, crowd (joined), backdrop SAM misses; img2: none; img3: person."""
    client = _client(db_session, monkeypatch)
    client.post("/auth/register", json={"email": "bc@x.com", "password": "hunter22"})
    token = client.post("/auth/login", json={"email": "bc@x.com", "password": "hunter22"}).json()[
        "access_token"
    ]
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    cls = {}
    for i, name in enumerate(("person", "crowd", "backdrop")):
        cls[name] = client.post(
            f"/projects/{pid}/classes",
            json={"idx": i, "name": name, "color": "#ff0000"},
            headers=_hdr(token),
        ).json()["id"]
    tid = client.post(
        f"/projects/{pid}/tasks", json={"name": "T", "kind": "image"}, headers=_hdr(token)
    ).json()["id"]
    frames = []
    for n in range(3):
        r = client.post(
            f"/tasks/{tid}/assets",
            files={"file": (f"img{n + 1}.png", io.BytesIO(_png()), "image/png")},
            headers=_hdr(token),
        )
        assert r.status_code == 201, r.text
        aid = r.json()["id"]
        frames.append((aid, client.get(f"/assets/{aid}", headers=_hdr(token)).json()["frame_id"]))
    ids = {
        "person": _box(db_session, tid, frames[0][1], cls["person"], x=0, status="accepted"),
        "crowd_a": _box(db_session, tid, frames[0][1], cls["crowd"], x=1),
        "crowd_b": _box(db_session, tid, frames[0][1], cls["crowd"], x=2),
        "backdrop": _box(db_session, tid, frames[0][1], cls["backdrop"], x=3),
        "person3": _box(db_session, tid, frames[2][1], cls["person"], x=4),
    }
    return client, token, tid, frames, ids


def _fake_model(calls):
    """Per box, by its x: a polygon, a mask, merged into the box before
    it, nothing found, a polygon."""

    def convert(asset, boxes, *, frame_id=None, modes=None, **_):
        calls.append({"asset": str(asset.id), "boxes": boxes, "modes": modes})
        out = []
        for b in boxes:
            x = int(b[0])
            if x in (0, 4):
                out.append(
                    {
                        "polygon": [[0, 0], [5, 0], [5, 5]],
                        "score": 0.95 if x == 0 else 0.3,
                        "mask": None,
                        "merged_into": None,
                    }
                )
            elif x == 1:
                out.append(
                    {
                        "polygon": [],
                        "score": 0.9,
                        "mask": {"counts": "0,4,6", "size": [5, 2]},
                        "merged_into": None,
                    }
                )
            elif x == 2:
                out.append({"polygon": [], "score": 0.9, "mask": None, "merged_into": 1})
            else:
                out.append(None)
        return {"results": out, "ms": 1200, "encodes": 1}

    return convert


def test_class_modes_follow_the_spec():
    assert bc.mode_for_class("ground_surface") == "ground"
    assert bc.mode_for_class("crowd") == "crowd"
    assert bc.mode_for_class("graphic_overlay") == "overlay"
    assert bc.mode_for_class("glass_wall") == "carrier"
    assert bc.mode_for_class("goal_net_frame") == "net"
    assert bc.mode_for_class("ring_ropes_cage") == "ropes"
    assert bc.mode_for_class("board_led") == "flat"
    assert bc.mode_for_class("person") == "object"
    assert bc.mode_for_class(None) == "object"


def _run(db_session, monkeypatch, tid, *, window=50, redis=None):
    r = redis or FakeRedis()
    calls: list = []
    enqueued: list = []
    _bind_session_factory(db_session, monkeypatch)
    import redis as redis_mod

    monkeypatch.setattr(redis_mod, "Redis", lambda **k: r)
    from carve_api.inference import sam as sam_mod

    monkeypatch.setattr(sam_mod, "sam_boxes_to_polygons_for_asset", _fake_model(calls))
    monkeypatch.setattr(bc, "ensure_sam", lambda **k: None)
    monkeypatch.setattr(bc, "WINDOW", window)
    monkeypatch.setattr(
        bc, "_enqueue", lambda payload, rq_id, connection=None: enqueued.append(rq_id)
    )
    payload = bc.BoxConvertPayload(job_id="job-1", actor_id=str(uuid.uuid4()), task_id=tid)
    out = bc.run_box_convert_batch(payload)
    return out, r, calls, enqueued, payload


def test_every_box_becomes_its_shape(db_session, monkeypatch):
    _c, _t, tid, frames, ids = _scene(db_session, monkeypatch)
    out, r, calls, _enq, _p = _run(db_session, monkeypatch, tid)
    assert out["status"] == "completed"

    # One model call per image with boxes, each box with its class's mode.
    # (The test images share one created_at, so their order is the id's.)
    assert sorted(c["asset"] for c in calls) == sorted([frames[0][0], frames[2][0]])
    assert sorted(calls[0]["modes"]) == ["crowd", "crowd", "flat", "object"]

    db_session.expire_all()
    got = {k: db_session.get(Annotation, v) for k, v in ids.items()}
    assert got["person"].kind == AnnotationKind.polygon
    assert got["person"].geometry == {
        "kind": "polygon",
        "points": [[0.0, 0.0], [5.0, 0.0], [5.0, 5.0]],
    }
    # The model's scores stay with the object; a new shape needs a new review.
    assert got["person"].confidence == pytest.approx(0.9) and got["person"].visible == 2
    assert got["person"].status == "proposed" and got["person"].reviewed_by_id is None
    assert got["crowd_a"].kind == AnnotationKind.mask
    assert got["crowd_a"].geometry == {"kind": "mask_rle", "size": [5, 2], "counts": "0,4,6"}
    assert got["crowd_b"] is None  # joined into crowd_a
    assert got["backdrop"].kind == AnnotationKind.bbox  # SAM found nothing: kept
    assert got["person3"].kind == AnnotationKind.polygon

    p = bc.read_convert_progress(r, "job-1")
    assert (p["done"], p["total"], p["failed"]) == (3, 3, 0)
    assert (p["boxes"], p["polygons"], p["masks"], p["merged"], p["kept"], p["low_score"]) == (
        5,
        2,
        1,
        1,
        1,
        1,
    )
    assert p["images_with_boxes"] == 2
    # Newest first; an image without boxes is not logged.
    assert [e["index"] for e in p["recent"]] == sorted(
        (e["index"] for e in p["recent"]), reverse=True
    )
    one = next(e for e in p["recent"] if e["name"] == "img1.png")
    assert {e["name"] for e in p["recent"]} == {"img1.png", "img3.png"}
    assert one | {"s": 0, "index": 0} == {
        "index": 0,
        "asset_id": frames[0][0],
        "name": "img1.png",
        "boxes": 4,
        "polygons": 1,
        "masks": 1,
        "merged": 1,
        "kept": 1,
        "low_score": 0,
        "s": 0,
    }
    assert p["current"] is None and p["eta_seconds"] is None


def test_a_run_goes_on_in_windows_and_resumes_its_counts(db_session, monkeypatch):
    _c, _t, tid, _frames, _ids = _scene(db_session, monkeypatch)
    out, r, calls, enqueued, payload = _run(db_session, monkeypatch, tid, window=2)
    assert out["status"] == "continued"
    assert enqueued == ["job-1::c2"]
    assert bc.read_convert_progress(r, "job-1")["status"] == "running"

    out = bc.run_box_convert_batch(payload)
    assert out["status"] == "completed"
    p = bc.read_convert_progress(r, "job-1")
    assert (p["done"], p["polygons"], p["masks"], p["boxes"]) == (3, 2, 1, 5)


def test_cancel_stops_before_the_next_image(db_session, monkeypatch):
    _c, _t, tid, _frames, ids = _scene(db_session, monkeypatch)
    r = FakeRedis()
    r.hset("aa:job:job-1", mapping={"status": "canceled", "cursor": "0"})
    out, r, calls, enqueued, _p = _run(db_session, monkeypatch, tid, redis=r)
    assert out["status"] == "canceled" and calls == [] and enqueued == []
    db_session.expire_all()
    assert db_session.get(Annotation, ids["person"]).kind == AnnotationKind.bbox


def test_a_model_restart_waits_for_sam_instead_of_failing(db_session, monkeypatch):
    _c, _t, tid, _frames, ids = _scene(db_session, monkeypatch)
    from carve_api.inference import sam as sam_mod
    from carve_api.inference.sam import SamModelUnreachable

    good = _fake_model([])
    hits = {"n": 0}

    def flaky(*a, **k):
        hits["n"] += 1
        if hits["n"] == 1:
            raise SamModelUnreachable("boxes_to_polygons: restarting")
        return good(*a, **k)

    waits = []
    _bind_session_factory(db_session, monkeypatch)
    r = FakeRedis()
    import redis as redis_mod

    monkeypatch.setattr(redis_mod, "Redis", lambda **k: r)
    monkeypatch.setattr(sam_mod, "sam_boxes_to_polygons_for_asset", flaky)
    monkeypatch.setattr(bc, "ensure_sam", lambda **k: waits.append(1))
    monkeypatch.setattr(bc, "_enqueue", lambda *a, **k: None)
    out = bc.run_box_convert_batch(bc.BoxConvertPayload(job_id="job-1", actor_id="x", task_id=tid))
    assert out["status"] == "completed"
    assert len(waits) == 2  # at the start, and after the restart
    p = bc.read_convert_progress(r, "job-1")
    assert p["failed"] == 0 and p["polygons"] == 2


def test_another_sam_variant_stops_the_run(db_session, monkeypatch):
    _c, _t, tid, _frames, ids = _scene(db_session, monkeypatch)
    _bind_session_factory(db_session, monkeypatch)
    r = FakeRedis()
    import redis as redis_mod

    monkeypatch.setattr(redis_mod, "Redis", lambda **k: r)

    def wrong(**k):
        raise RuntimeError("SAM sam2.1-tiny is loaded; this conversion needs sam3.1")

    monkeypatch.setattr(bc, "ensure_sam", wrong)
    out = bc.run_box_convert_batch(bc.BoxConvertPayload(job_id="job-1", actor_id="x", task_id=tid))
    assert out["ok"] is False
    p = bc.read_convert_progress(r, "job-1")
    assert p["status"] == "failed" and "sam3.1" in p["error"]
    db_session.expire_all()
    assert db_session.get(Annotation, ids["person"]).kind == AnnotationKind.bbox


def test_ensure_sam_loads_sam_when_nothing_is_loaded():
    states = iter(
        [{"state": "idle"}, {"state": "loading"}, {"state": "ready", "variant": "sam3.1"}]
    )
    switched = []
    bc.ensure_sam(
        status_fn=lambda: next(states), switch_fn=lambda: switched.append(1), sleep=lambda s: None
    )
    assert switched == [1]
    with pytest.raises(RuntimeError, match="needs sam3.1"):
        bc.ensure_sam(
            status_fn=lambda: {"state": "ready", "variant": "sam2.1-tiny"}, sleep=lambda s: None
        )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


def _endpoints(db_session, monkeypatch):
    client, token, tid, frames, ids = _scene(db_session, monkeypatch)
    r = FakeRedis()
    monkeypatch.setattr(bcr, "_redis", lambda: r)
    monkeypatch.setattr(bc, "_sam_status", lambda: {"state": "ready", "variant": "sam3.1"})
    enqueued = []
    monkeypatch.setattr(
        bc, "_enqueue", lambda payload, rq_id, connection=None: enqueued.append((payload, rq_id))
    )
    return client, token, tid, frames, ids, r, enqueued


def test_start_then_watch_then_resume(db_session, monkeypatch):
    client, token, tid, _frames, _ids, r, enqueued = _endpoints(db_session, monkeypatch)
    body = client.get(f"/tasks/{tid}/sam/box-convert", headers=_hdr(token)).json()
    assert body == {"job": None, "left": {"boxes": 5, "images": 2}}

    res = client.post(f"/tasks/{tid}/sam/box-convert", json={}, headers=_hdr(token))
    assert res.status_code == 202, res.text
    job = res.json()["job"]
    assert job["status"] == "queued" and job["total"] == 3
    assert enqueued[0][1] == job["job_id"]

    # One run per task at a time.
    again = client.post(f"/tasks/{tid}/sam/box-convert", json={}, headers=_hdr(token))
    assert again.status_code == 409 and again.json()["error"] == "already_running"

    got = client.get(f"/tasks/{tid}/sam/box-convert", headers=_hdr(token)).json()
    assert got["job"]["job_id"] == job["job_id"]
    assert got["left"] is None  # not counted while it runs

    jid = job["job_id"]
    assert (
        client.post(f"/tasks/{tid}/sam/box-convert/{jid}/cancel", headers=_hdr(token)).status_code
        == 202
    )
    assert r.h[f"aa:job:{jid}"]["status"] == "canceled"
    r.hset(f"aa:job:{jid}", "cursor", "1")
    res = client.post(f"/tasks/{tid}/sam/box-convert/{jid}/resume", headers=_hdr(token))
    assert res.status_code == 202, res.text
    assert enqueued[-1][0].job_id == jid and enqueued[-1][1].startswith(f"{jid}::r1-")
    assert r.h[f"aa:job:{jid}"]["status"] == "queued"


def test_a_running_job_cannot_be_resumed_unless_it_stalled(db_session, monkeypatch):
    client, token, tid, _frames, _ids, r, _enq = _endpoints(db_session, monkeypatch)
    jid = client.post(f"/tasks/{tid}/sam/box-convert", json={}, headers=_hdr(token)).json()["job"][
        "job_id"
    ]
    r.hset(f"aa:job:{jid}", mapping={"status": "running", "cursor": "1", "updated_at": "1000"})
    import time
    from types import SimpleNamespace

    def clock(t):
        monkeypatch.setattr(
            bc, "time", SimpleNamespace(time=lambda: t, monotonic=time.monotonic, sleep=time.sleep)
        )

    clock(1000 + 60)
    assert (
        client.post(f"/tasks/{tid}/sam/box-convert/{jid}/resume", headers=_hdr(token)).status_code
        == 409
    )
    clock(1000 + bc.STALLED_AFTER_S + 1)
    assert (
        client.get(f"/tasks/{tid}/sam/box-convert", headers=_hdr(token)).json()["job"]["stalled"]
        is True
    )
    assert (
        client.post(f"/tasks/{tid}/sam/box-convert/{jid}/resume", headers=_hdr(token)).status_code
        == 202
    )


def test_start_refuses_another_sam_variant(db_session, monkeypatch):
    client, token, tid, _frames, _ids, _r, enqueued = _endpoints(db_session, monkeypatch)
    monkeypatch.setattr(bc, "_sam_status", lambda: {"state": "ready", "variant": "sam2.1-tiny"})
    res = client.post(f"/tasks/{tid}/sam/box-convert", json={}, headers=_hdr(token))
    assert res.status_code == 409 and res.json()["error"] == "wrong_sam_variant"
    assert enqueued == []


def test_the_log_lists_flagged_images(db_session, monkeypatch):
    client, token, tid, frames, _ids, r, _enq = _endpoints(db_session, monkeypatch)
    jid = client.post(f"/tasks/{tid}/sam/box-convert", json={}, headers=_hdr(token)).json()["job"][
        "job_id"
    ]
    import json

    for e in (
        {"index": 1, "name": "a", "kept": 1},
        {"index": 2, "name": "b"},
        {"index": 3, "name": "c", "error": "x"},
    ):
        r.rpush(bc.log_key(jid), json.dumps(e))
    all_ = client.get(f"/tasks/{tid}/sam/box-convert/{jid}/log", headers=_hdr(token)).json()
    assert [e["name"] for e in all_["items"]] == ["c", "b", "a"]
    flagged = client.get(
        f"/tasks/{tid}/sam/box-convert/{jid}/log?only=flagged", headers=_hdr(token)
    ).json()
    assert [e["name"] for e in flagged["items"]] == ["c", "a"]


def test_preview_draws_the_shapes(db_session, monkeypatch):
    client, token, tid, frames, ids, _r, _enq = _endpoints(db_session, monkeypatch)
    a = db_session.get(Annotation, ids["person"])
    a.kind, a.geometry = (
        AnnotationKind.polygon,
        {"kind": "polygon", "points": [[0, 0], [20, 0], [20, 20]]},
    )
    db_session.commit()
    res = client.get(
        f"/tasks/{tid}/assets/{frames[0][0]}/shapes-preview?w=200", headers=_hdr(token)
    )
    assert res.status_code == 200 and res.headers["content-type"] == "image/jpeg"
    img = Image.open(io.BytesIO(res.content)).convert("RGB")
    assert img.size == (40, 30)  # never enlarged
    r, g, b = img.getpixel((12, 4))  # inside the red polygon
    assert r > 100 and r > g + 40


def test_moving_images_waits_for_the_conversion(db_session, monkeypatch):
    client, token, tid, frames, _ids, r, _enq = _endpoints(db_session, monkeypatch)
    client.post(f"/tasks/{tid}/sam/box-convert", json={}, headers=_hdr(token))
    from carve_api.assets import bulk
    from carve_api.jobs import queue

    monkeypatch.setattr(queue, "rq_connection", lambda: r)
    import rq.queue
    import rq.registry

    monkeypatch.setattr(rq.queue.Queue, "job_ids", property(lambda self: []))
    monkeypatch.setattr(rq.registry.StartedJobRegistry, "get_job_ids", lambda self: [])
    monkeypatch.setattr("rq.job.Job.fetch_many", staticmethod(lambda ids, connection=None: []))
    assert bulk.busy_reason(db_session, [uuid.UUID(tid)]) == "job_running"
    assert db_session.execute(
        select(Annotation.id).where(Annotation.task_id == uuid.UUID(tid))
    ).first()
