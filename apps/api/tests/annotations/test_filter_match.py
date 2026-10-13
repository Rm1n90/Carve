"""``POST /tasks/{id}/annotations:matching-assets`` — the editor's filter,
evaluated on the server with the client evaluator's semantics."""

import io
import uuid

from fastapi.testclient import TestClient
from PIL import Image

from carve_api.annotations import router as ann_router
from carve_api.annotations.models import Annotation, AnnotationKind
from carve_api.deps import get_db
from carve_api.main import create_app


def _client(db_session):
    app = create_app()

    def _override():
        try:
            yield db_session
        finally:
            db_session.rollback()

    app.dependency_overrides[get_db] = _override
    return TestClient(app)


def _hdr(t):
    return {"Authorization": f"Bearer {t}"}


def _png(shade: int) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (4, 4), (shade, 0, 0)).save(buf, format="PNG")
    return buf.getvalue()


def _setup(client, monkeypatch, n_assets=4):
    from carve_api.assets import service as svc_mod

    class _FakeStorage:
        @classmethod
        def from_settings(cls):
            return cls()

        def ensure_bucket(self):
            pass

        def put_object(self, *a, **k):
            pass

        def get_object(self, key):
            return io.BytesIO(b"")

        def remove_object(self, key):
            pass

        def presigned_get(self, key, **k):
            return f"https://fake/{key}"

    monkeypatch.setattr(svc_mod, "MinioClient", _FakeStorage)
    client.post("/auth/register", json={"email": "fm@x.com", "password": "hunter22"})
    token = client.post("/auth/login", json={"email": "fm@x.com", "password": "hunter22"}).json()[
        "access_token"
    ]
    pid = client.post("/projects", json={"name": "P"}, headers=_hdr(token)).json()["id"]
    tid = client.post(
        f"/projects/{pid}/tasks", json={"name": "T", "kind": "image"}, headers=_hdr(token)
    ).json()["id"]
    classes = {}
    for i, name in enumerate(("Car", "person", "backdrop")):
        classes[name] = client.post(
            f"/projects/{pid}/classes",
            json={"idx": i, "name": name, "color": "#ff0000"},
            headers=_hdr(token),
        ).json()["id"]
    assets = []
    for i in range(n_assets):
        aid = client.post(
            f"/tasks/{tid}/assets",
            files={"file": (f"a{i}.png", io.BytesIO(_png(10 + i)), "image/png")},
            headers=_hdr(token),
        ).json()["id"]
        fid = client.get(f"/assets/{aid}", headers=_hdr(token)).json()["frame_id"]
        assets.append((aid, fid))
    return token, tid, classes, assets


def _add(db, tid, fid, cid, kind, geometry, confidence=None, visible=None):
    db.add(
        Annotation(
            task_id=uuid.UUID(tid),
            frame_id=uuid.UUID(fid),
            class_id=uuid.UUID(cid),
            kind=kind,
            geometry=geometry,
            confidence=confidence,
            visible=visible,
        )
    )
    # Committed: each request ends with a rollback of the shared session.
    db.commit()


def _box(w, h):
    return {"kind": "bbox", "x": 0, "y": 0, "w": w, "h": h}


def _rule(field, op, value, negate=False):
    return {"not": negate, "field": field, "op": op, "value": value}


def _match(client, token, tid, *rules, combinator="AND"):
    r = client.post(
        f"/tasks/{tid}/annotations:matching-assets",
        json={"filter": {"combinator": combinator, "rules": list(rules)}},
        headers=_hdr(token),
    )
    assert r.status_code == 200, r.text
    return set(r.json()["asset_ids"])


def _scene(db_session, monkeypatch):
    """a0: car box 50x20 (scored 0.9, 40% in view) · a1: person polygon 30 wide
    · a2: backdrop mask on a 1080x1920 canvas · a3: nothing."""
    client = _client(db_session)
    token, tid, cls, assets = _setup(client, monkeypatch)
    (a0, f0), (a1, f1), (a2, f2), (a3, _f3) = assets
    _add(
        db_session,
        tid,
        f0,
        cls["Car"],
        AnnotationKind.bbox,
        _box(50, 20),
        confidence=0.9,
        visible=40,
    )
    _add(
        db_session,
        tid,
        f1,
        cls["person"],
        AnnotationKind.polygon,
        {"kind": "polygon", "points": [[10, 5], [40, 5], [25, 80]]},
    )
    _add(
        db_session,
        tid,
        f2,
        cls["backdrop"],
        AnnotationKind.mask,
        {"kind": "mask_rle", "size": [1080, 1920], "counts": "0,10"},
    )
    return client, token, tid, (a0, a1, a2, a3)


def test_label_is_case_insensitive(db_session, monkeypatch):
    client, token, tid, (a0, a1, a2, _a3) = _scene(db_session, monkeypatch)
    assert _match(client, token, tid, _rule("label", "==", "car")) == {a0}
    assert _match(client, token, tid, _rule("label", "==", "BACKDROP")) == {a2}


def test_negated_rule_and_or_groups(db_session, monkeypatch):
    client, token, tid, (a0, a1, a2, _a3) = _scene(db_session, monkeypatch)
    assert _match(client, token, tid, _rule("label", "==", "car", negate=True)) == {a1, a2}
    nested = {
        "combinator": "AND",
        "rules": [_rule("label", "==", "person"), _rule("width", "<", 31)],
    }
    assert _match(client, token, tid, _rule("label", "==", "car"), nested, combinator="OR") == {
        a0,
        a1,
    }


def test_width_and_height_follow_each_geometry(db_session, monkeypatch):
    client, token, tid, (a0, a1, a2, _a3) = _scene(db_session, monkeypatch)
    # bbox 50x20, polygon 30x75, mask canvas 1920x1080.
    assert _match(client, token, tid, _rule("width", "==", 30)) == {a1}
    assert _match(client, token, tid, _rule("height", ">", "70")) == {a1, a2}
    assert _match(client, token, tid, _rule("width", ">=", 1920)) == {a2}


def test_scores_are_missing_on_unscored_boxes(db_session, monkeypatch):
    client, token, tid, (a0, a1, a2, _a3) = _scene(db_session, monkeypatch)
    assert _match(client, token, tid, _rule("confidence", ">", 0.5)) == {a0}
    assert _match(client, token, tid, _rule("visible", "<", 60)) == {a0}
    # A missing score fails the rule, so its negation passes.
    assert _match(client, token, tid, _rule("confidence", ">", 0.5, negate=True)) == {a1, a2}


def test_mask_kind_reads_as_the_dialog_offers_it(db_session, monkeypatch):
    client, token, tid, (_a0, _a1, a2, _a3) = _scene(db_session, monkeypatch)
    assert _match(client, token, tid, _rule("kind", "==", "mask_rle")) == {a2}


def test_empty_or_non_numeric_values(db_session, monkeypatch):
    client, token, tid, (a0, a1, a2, _a3) = _scene(db_session, monkeypatch)
    # An empty value filters nothing: every asset with an annotation.
    assert _match(client, token, tid, _rule("label", "==", "")) == {a0, a1, a2}
    assert _match(client, token, tid, _rule("width", ">", "wide")) == set()


def test_a_filter_too_large_is_refused(db_session, monkeypatch):
    client = _client(db_session)
    token, tid, _cls, _assets = _setup(client, monkeypatch, n_assets=1)
    group = {"combinator": "AND", "rules": [_rule("label", "==", "car")]}
    for _ in range(12):
        group = {"combinator": "AND", "rules": [group]}
    r = client.post(
        f"/tasks/{tid}/annotations:matching-assets", json={"filter": group}, headers=_hdr(token)
    )
    assert r.status_code == 422
    assert r.json()["error"] == "filter_too_large"


def test_listing_a_whole_huge_task_is_refused(db_session, monkeypatch):
    client, token, tid, (_a0, _a1, _a2, _a3) = _scene(db_session, monkeypatch)
    monkeypatch.setattr(ann_router, "LIST_ALL_MAX", 2)
    r = client.get(f"/tasks/{tid}/annotations", headers=_hdr(token))
    assert r.status_code == 413
    assert r.json()["error"] == "too_many_annotations_to_list"
    monkeypatch.setattr(ann_router, "LIST_ALL_MAX", 3)
    assert client.get(f"/tasks/{tid}/annotations", headers=_hdr(token)).status_code == 200
