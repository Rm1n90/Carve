# Armin Mehri — mehri.armin@gmail.com
"""Shared fixtures: a seeded task, a scripted provider, in-process jobs."""

import json
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from io import BytesIO

import pytest
from PIL import Image
from sqlalchemy.orm import sessionmaker

from carve_api.assets.models import Asset, AssetKind, Frame
from carve_api.auth.models import User, UserRole
from carve_api.logo_ai import jobs as jobs_mod
from carve_api.logo_ai import providers as providers_mod
from carve_api.logo_ai import router as router_mod
from carve_api.logo_ai import service as service_mod
from carve_api.logo_ai.models import DELIVERY_REALTIME, LogoAiJob
from carve_api.logo_ai.providers.base import (
    BatchState,
    ProviderClient,
    ProviderResult,
    Usage,
)
from carve_api.projects.models import Class, Project, Task, TaskKind

# Every seeded image is 400x200 and is sent as 392x196 (whole 28px patches).
IMAGE_W, IMAGE_H = 400, 200


def image_bytes() -> bytes:
    out = BytesIO()
    Image.new("RGB", (IMAGE_W, IMAGE_H), (10, 120, 200)).save(out, format="JPEG")
    return out.getvalue()


def answer(*boxes, confidence: float = 0.9, visible: int = 100) -> str:
    """A single-class answer: one ``[x1, y1, x2, y2, confidence, visible]``
    row per box."""
    return json.dumps(
        {"detections": [[*b, round(confidence * 100), visible] for b in boxes]}
    )


def ok(text: str | None = None) -> ProviderResult:
    return ProviderResult(
        text=text if text is not None else answer((49, 49, 147, 98)),
        usage=Usage(input_tokens=1000, cache_read_tokens=500, output_tokens=100, requests=1),
    )


def short(custom_id: str) -> str:
    """A request id without the part id the run puts in front of it."""
    return custom_id.rsplit("-", 1)[-1]


class FakeProvider(ProviderClient):
    """Answers from a script; records everything it was asked."""

    def __init__(self) -> None:
        self.ctx = None  # type: ignore[assignment] — set by make_client
        self.sent: list[dict] = []
        # Popped per realtime request; when empty, ``ok()`` is returned.
        self.script: list[ProviderResult | Exception] = []
        # batch id -> [(request id without its part prefix, request)]
        self.batches: dict[str, list[tuple[str, dict]]] = {}
        self.full_ids: dict[str, list[str]] = {}
        self.tags: dict[str, str] = {}
        self.batch_ended: dict[str, bool] = {}
        # "batch-1:0_0" -> the answer to that request.
        self.batch_answers: dict[str, ProviderResult] = {}
        self.batch_failed_reason: str | None = None
        # batch id -> reason, for batches the queue had no room for.
        self.queue_full: dict[str, str] = {}
        # Whether batches come with an uploaded input file (OpenAI) or
        # not (Anthropic), and whether a batch can be looked up by tag.
        self.uses_files = False
        self.files: dict[str, list[tuple[str, dict]]] = {}
        self.from_file: list[str] = []
        self.findable = True
        self.canceled: list[str] = []
        self.cleaned: list[str] = []

    def build_request(self, image_jpeg: bytes, request_text: str, *, batch: bool) -> dict:
        with Image.open(BytesIO(image_jpeg)) as im:
            size = im.size
        return {"size": size, "text": request_text, "batch": batch}

    def build_check_request(self, sheet_jpeg: bytes, request_text: str, *, system_text, schema) -> dict:
        with Image.open(BytesIO(sheet_jpeg)) as im:
            size = im.size
        return {"check": True, "size": size, "text": request_text, "system": system_text}

    def send(self, request: dict) -> ProviderResult:
        self.sent.append(request)
        if self.script:
            item = self.script.pop(0)
            if isinstance(item, Exception):
                raise item
            return item
        return ok()

    def _start(self, requests, tag: str, file_id: str | None) -> str:
        batch_id = f"batch-{len(self.batches) + 1}"
        self.batches[batch_id] = [(short(cid), r) for cid, r in requests]
        self.full_ids[batch_id] = [cid for cid, _ in requests]
        self.batch_ended[batch_id] = False
        self.tags[tag] = batch_id
        return batch_id

    def batch_create(self, requests, *, tag: str):
        file_id = None
        if self.uses_files:
            file_id = f"file-{len(self.files) + 1}"
            self.files[file_id] = list(requests)
        return self._start(requests, tag, file_id), file_id

    def batch_create_from_file(self, file_id: str, *, tag: str):
        if file_id not in self.files:
            return None
        self.from_file.append(file_id)
        return self._start(self.files[file_id], tag, file_id)

    def batch_find(self, tag: str, *, request_count, since, known):
        if self.findable and tag in self.tags:
            return self.tags[tag], None
        return None

    def batch_state(self, batch_id: str) -> BatchState:
        total = len(self.batches[batch_id])
        ended = self.batch_ended[batch_id]
        failed = self.queue_full.get(batch_id) or self.batch_failed_reason
        return BatchState(
            ended=ended or bool(failed),
            total=total,
            finished=total if ended else 0,
            failed_reason=failed,
            queue_full=batch_id in self.queue_full,
        )

    def batch_download(self, batch_id: str) -> bytes:
        lines = []
        for custom_id in self.full_ids[batch_id]:
            r = self.batch_answers.get(f"{batch_id}:{short(custom_id)}", ok())
            lines.append(
                {
                    "custom_id": custom_id,
                    "text": r.text,
                    "error": r.error,
                    "retryable": r.retryable,
                    "usage": r.usage.to_dict(),
                }
            )
        return json.dumps(lines).encode()

    def batch_parse(self, raw: bytes):
        for line in json.loads(raw):
            yield line["custom_id"], ProviderResult(
                text=line["text"],
                error=line["error"],
                retryable=line["retryable"],
                usage=Usage.from_dict(line["usage"]),
            )

    def batch_cancel(self, batch_id: str) -> None:
        self.canceled.append(batch_id)
        self.batch_ended[batch_id] = True

    def batch_cleanup(self, batch_id: str, file_id) -> None:
        self.cleaned.append(batch_id)


@dataclass
class Seeded:
    user: User
    project: Project
    task: Task
    classes: list[Class]
    assets: list[Asset]
    frames: list[Frame] = field(default_factory=list)

    def params(self, **overrides) -> dict:
        base = {
            "provider": "anthropic",
            "model": "claude-opus-5-5",
            "effort": "low",
            "prompts": [{"class_id": str(self.classes[0].id), "prompt": "the Acme mark"}],
        }
        return {**base, **overrides}

    def job(self, db, *, delivery: str = DELIVERY_REALTIME, **overrides) -> LogoAiJob:
        params = self.params(**overrides)
        job = LogoAiJob(
            task_id=self.task.id,
            created_by=self.user.id,
            delivery=delivery,
            provider=params["provider"],
            model=params["model"],
            effort=params["effort"],
            params=service_mod.RunOptions(**params).to_dict(),
            usage={},
            errors=[],
        )
        db.add(job)
        db.commit()
        return job


def seed(db, *, n_assets: int = 3, role: UserRole = UserRole.admin) -> Seeded:
    user = User(email=f"u-{uuid.uuid4()}@x.com", password_hash="x", role=role)
    db.add(user)
    db.flush()
    project = Project(name="P", owner_id=user.id)
    db.add(project)
    db.flush()
    task = Task(project_id=project.id, name="T", kind=TaskKind.image)
    db.add(task)
    db.flush()
    classes = [
        Class(project_id=project.id, idx=0, name="Acme", color="#ff0000"),
        Class(project_id=project.id, idx=1, name="Globex", color="#00ff00"),
    ]
    db.add_all(classes)
    db.flush()
    seeded = Seeded(user=user, project=project, task=task, classes=classes, assets=[])
    for i in range(n_assets):
        asset = Asset(
            task_id=task.id,
            kind=AssetKind.image,
            xxh3_128=f"{i:032x}",
            mime="image/jpeg",
            size_bytes=1,
            width=IMAGE_W,
            height=IMAGE_H,
            frames=1,
            original_name=f"img-{i}.jpg",
            # Runs walk assets by (created_at, id); rows seeded in one
            # transaction would otherwise share a timestamp and come
            # back in UUID order.
            created_at=datetime(2026, 1, 1, tzinfo=UTC) + timedelta(seconds=i),
        )
        db.add(asset)
        db.flush()
        frame = Frame(asset_id=asset.id, idx=0, pts_ms=0)
        db.add(frame)
        db.flush()
        seeded.assets.append(asset)
        seeded.frames.append(frame)
    # Release the savepoint so sessions bound to the same connection
    # (the jobs' own) see the seeded rows.
    db.commit()
    return seeded


@pytest.fixture
def provider(monkeypatch) -> FakeProvider:
    """Replace the vendor SDKs and MinIO with in-memory fakes."""
    fake = FakeProvider()

    def make_client(ctx):
        fake.ctx = ctx
        return fake

    monkeypatch.setattr(providers_mod, "make_client", make_client)
    monkeypatch.setattr(providers_mod, "is_configured", lambda _p: True)
    # The results archive, kept in memory instead of MinIO.
    fake.archive = {}
    monkeypatch.setattr(jobs_mod.archive, "save", fake.archive.__setitem__)
    monkeypatch.setattr(jobs_mod.archive, "load", fake.archive.get)
    for mod in (jobs_mod, router_mod, service_mod):
        monkeypatch.setattr(mod, "read_image_bytes", lambda _a, _f: image_bytes())
    return fake


@pytest.fixture
def queue(db_session, monkeypatch) -> list[tuple[str, str]]:
    """Run the job functions against the test transaction and record,
    instead of perform, every enqueue."""
    calls: list[tuple[str, str]] = []
    SessionLocal = sessionmaker(
        bind=db_session.get_bind(),
        autoflush=False,
        expire_on_commit=False,
        future=True,
        join_transaction_mode="create_savepoint",
    )
    monkeypatch.setattr(jobs_mod, "get_session_factory", lambda: SessionLocal)
    monkeypatch.setattr(
        jobs_mod,
        "enqueue",
        lambda fn, job_id, **kw: calls.append((fn.__name__, kw.get("suffix", ""))),
    )
    monkeypatch.setattr(
        jobs_mod,
        "enqueue_poll",
        lambda job_id, **kw: calls.append(("poll", "")) or True,
    )
    monkeypatch.setattr(
        jobs_mod,
        "enqueue_resend",
        lambda job_id, **kw: calls.append(("resend", "")) or True,
    )
    return calls
