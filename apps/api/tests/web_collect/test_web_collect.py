# Armin Mehri — mehri.armin@gmail.com
"""Collect from web: the rules (blocklist, names, image checks) and the
run itself, against the test DB with scripted sources, downloads and
filters in place of the network and the model service."""

from __future__ import annotations

import hashlib
import io
import json
import random
import uuid

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from carve_api.assets.models import Asset, AssetKind, Frame
from carve_api.auth.models import User, UserRole
from carve_api.deps import get_current_user, get_db
from carve_api.projects.models import Project, Task, TaskKind
from carve_api.web_collect import images as img
from carve_api.web_collect import jobs as jobs_mod
from carve_api.web_collect import router as router_mod
from carve_api.web_collect.blocklist import Blocklist, parse_extra
from carve_api.web_collect.models import (
    KW_DONE,
    KW_EXHAUSTED,
    KW_LIMITED,
    OUTCOME_ADDED,
    OUTCOME_PENDING,
    STATUS_CANCELED,
    STATUS_CANCELING,
    STATUS_COMPLETED,
    STATUS_QUEUED,
    WebCollectJob,
    WebCollectJobKeyword,
    WebCollectKeyword,
    WebCollectUrl,
)
from carve_api.web_collect.naming import clean_keyword, file_name, slugify
from carve_api.web_collect.quality import FiltersUnavailable
from carve_api.web_collect.sources import Candidate, SearchPage, Source, SourceBusy, SourceError

# --------------------------------------------------------------------- rules


def test_blocklist_matches_image_and_page_hosts_by_suffix() -> None:
    bl = Blocklist(parse_extra("example.org, https://www.bad.net/x\n# note\n*.junk.io"))
    assert bl.reason("https://c8.alamy.com/comp/X.jpg") == "stock"
    # Adobe Stock previews come from a CDN with another name.
    assert bl.reason("https://t4.ftcdn.net/jpg/01/2.jpg") == "stock"
    # A clean host, found on a stock page.
    assert bl.reason("https://cdn.site.com/a.jpg", "https://www.dreamstime.com/p") == "stock"
    assert bl.reason("https://imgcdn.stablediffusionweb.com/a.jpg") == "ai"
    assert bl.reason("https://news.sina.com.cn/a.jpg") == "chinese"
    assert bl.reason("https://www.anything.cn/a.jpg") == "chinese"
    assert bl.reason("https://img.example.org/a.jpg") == "custom"
    assert bl.reason("https://bad.net/a.jpg") == "custom"
    assert bl.reason("https://a.junk.io/a.jpg") == "custom"
    assert bl.reason("https://media.formula1.com/a.jpg", "https://www.formula1.com/x") is None
    # Suffix on a label boundary only.
    assert bl.reason("https://notalamy.com/a.jpg") is None


def test_keyword_slugs_are_plain_and_never_empty() -> None:
    assert clean_keyword("  Tenneco \n  logo ") == "Tenneco logo"
    assert slugify("Tenneco logo") == "tenneco_logo"
    assert slugify("Pérez & Bottas!") == "perez_bottas"
    assert slugify("F1 — 2026 🏎️") == "f1_2026"
    assert slugify("日本") == "image"
    assert file_name("tenneco_logo", 42, "jpg") == "tenneco_logo_000042.jpg"


def _photo(seed: int, size: tuple[int, int] = (800, 600), fmt: str = "JPEG", marker=None) -> bytes:
    """A distinct picture per seed: blocks of random colours."""
    rnd = random.Random(seed)
    im = Image.new("RGB", (16, 12))
    im.putdata([tuple(rnd.randrange(256) for _ in range(3)) for _ in range(16 * 12)])
    im = im.resize(size, Image.Resampling.NEAREST)
    if marker:
        im.putpixel((0, 0), marker)
    out = io.BytesIO()
    im.save(out, fmt, quality=90) if fmt == "JPEG" else im.save(out, fmt)
    return out.getvalue()


def test_prepare_keeps_big_stills_and_rejects_the_rest() -> None:
    big = img.prepare(_photo(1), 500)
    assert isinstance(big, img.Prepared) and big.ext == "jpg" and (big.width, big.height) == (800, 600)
    assert img.prepare(_photo(1, (800, 400)), 500).reason == img.REJECT_SMALL
    assert img.prepare(b"<html>nope</html>", 500).reason == img.REJECT_NOT_IMAGE
    assert img.prepare(b'<?xml version="1.0"?><svg xmlns="x"></svg>', 500).reason == img.REJECT_VECTOR
    frames = [Image.new("RGB", (600, 600), c) for c in ((255, 0, 0), (0, 255, 0))]
    buf = io.BytesIO()
    frames[0].save(buf, "GIF", save_all=True, append_images=frames[1:])
    assert img.prepare(buf.getvalue(), 500).reason == img.REJECT_ANIMATED


def test_everything_is_stored_as_jpeg_and_plain_jpegs_are_untouched() -> None:
    plain = _photo(1)
    kept = img.prepare(plain, 500)
    assert kept.body == plain and kept.mime == "image/jpeg"
    for fmt in ("PNG", "WEBP", "GIF", "BMP", "TIFF"):
        out = img.prepare(_photo(2, fmt=fmt), 500)
        assert out.ext == "jpg" and out.mime == "image/jpeg", fmt
        im = Image.open(io.BytesIO(out.body))
        assert im.format == "JPEG" and im.mode == "RGB" and im.size == (800, 600), fmt


def test_transparency_becomes_white_and_sideways_photos_are_turned_upright() -> None:
    logo = Image.new("RGBA", (600, 600), (0, 0, 0, 0))
    logo.paste((200, 0, 0, 255), (200, 200, 400, 400))
    buf = io.BytesIO()
    logo.save(buf, "PNG")
    out = Image.open(io.BytesIO(img.prepare(buf.getvalue(), 500).body))
    assert out.getpixel((10, 10)) == (255, 255, 255)
    r, g, b = out.getpixel((300, 300))
    assert r > 180 and g < 40 and b < 40

    photo = Image.open(io.BytesIO(_photo(4, (800, 600))))
    exif = photo.getexif()
    exif[0x0112] = 6  # stored sideways: shown rotated 90°
    buf = io.BytesIO()
    photo.save(buf, "JPEG", exif=exif.tobytes())
    upright = img.prepare(buf.getvalue(), 500)
    assert (upright.width, upright.height) == (600, 800)
    assert Image.open(io.BytesIO(upright.body)).getexif().get(0x0112, 1) == 1


def test_avif_is_read_and_stored_as_jpeg() -> None:
    pytest.importorskip("pillow_avif")
    buf = io.BytesIO()
    Image.open(io.BytesIO(_photo(5))).save(buf, "AVIF")
    out = img.prepare(buf.getvalue(), 500)
    assert out.ext == "jpg" and Image.open(io.BytesIO(out.body)).format == "JPEG"


def test_referer_is_what_a_browser_would_send() -> None:
    page = "https://www.example.com/news/story?id=4#top"
    same_site = img.referer_for("https://www.example.com/i/a.jpg", page)
    assert same_site == "https://www.example.com/news/story?id=4"
    # Another site gets only the origin; nothing from https to http.
    assert img.referer_for("https://cdn.example.net/a.jpg", page) == "https://www.example.com/"
    assert img.referer_for("http://www.example.com/a.jpg", page) is None
    assert img.referer_for("https://cdn.example.net/a.jpg", None) is None
    assert img.referer_for("https://cdn.example.net/a.jpg", "javascript:void(0)") is None


def test_runs_started_before_the_keyword_check_keep_it_off() -> None:
    assert jobs_mod.Options.from_json({"sources": ["bing"]}).checks == ["ai", "watermark"]
    on = jobs_mod.Options.from_json({"sources": ["bing"], "filter_relevance": True})
    assert on.checks == ["ai", "watermark", "relevance"]


def test_a_model_service_that_skips_a_check_counts_as_unavailable(monkeypatch) -> None:
    from carve_api.web_collect import quality

    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        seen.append(body)
        # An older model service: knows ai and watermark only.
        scores = [{"ai": 0.1, "watermark": 0.1} for _ in body["images"]]
        return httpx.Response(200, json={"scores": scores})

    real = httpx.Client
    monkeypatch.setattr(
        quality.httpx, "Client", lambda **kw: real(transport=httpx.MockTransport(handler), **kw)
    )
    body = _photo(1)
    assert quality.score([body], ["ai", "watermark"]) == [{"ai": 0.1, "watermark": 0.1}]
    with pytest.raises(quality.FiltersUnavailable):
        quality.score([body], ["ai", "relevance"], ["Tenneco logo"])
    assert seen[-1]["texts"] == ["Tenneco logo"]


def test_lookalike_hash_survives_resize_and_recompression() -> None:
    a = img.prepare(_photo(7), 100)
    smaller = Image.open(io.BytesIO(_photo(7))).resize((400, 300))
    out = io.BytesIO()
    smaller.save(out, "JPEG", quality=60)
    b = img.prepare(out.getvalue(), 100)
    other = img.prepare(_photo(8), 100)
    index = img.LookalikeIndex([a.dhash])
    assert index.near(b.dhash)
    assert not index.near(other.dhash)
    # Numpy and Python paths agree once the extras are folded in.
    many = img.LookalikeIndex()
    for _ in range(600):
        many.add(other.dhash ^ 0xFFFF)  # far away
    many.add(a.dhash)
    assert many.near(b.dhash) and len(many) == 601


# ------------------------------------------------------------------- the run


URL = "https://img.example.com/{k}/{n}.jpg"


class FakeSource(Source):
    """Pages of ``per_page`` candidates for each variant, ``pages`` deep."""

    label = "Fake"
    interval = 0.0

    def __init__(self, name: str, variants=("a", "b"), pages: int = 3, per_page: int = 5) -> None:
        self.name = name
        self._variants = variants
        self.pages = pages
        self.per_page = per_page
        self.calls: list[tuple[str, str, int]] = []
        self.extra: dict[str, list[Candidate]] = {}
        self.busy_once: set[str] = set()
        self.always_busy = False
        self.always_fail = False
        self.fail_once: set[str] = set()
        self.off_topic: set[str] = set()  # keywords it answers with unrelated images

    def variants(self):  # noqa: ANN201
        return self._variants

    def search(self, client, keyword, variant, cursor):  # noqa: ANN001, ANN201
        self.calls.append((keyword, variant, cursor))
        if self.always_busy:
            raise SourceBusy("CAPTCHA page", 3600.0)
        if variant in self.busy_once:
            self.busy_once.discard(variant)
            raise SourceBusy("slow down", 0.0)
        if self.always_fail:
            raise SourceError("HTTP 502")
        if variant in self.fail_once:
            self.fail_once.discard(variant)
            raise SourceError("HTTP 502")
        if keyword in self.off_topic:
            return SearchPage([], None, off_topic=True)
        page = cursor // self.per_page
        if page >= self.pages:
            return SearchPage([], None)
        slug = slugify(keyword)
        cands = [
            Candidate(URL.format(k=slug, n=f"{self.name}-{variant}-{cursor + i}"), None, self.name)
            for i in range(self.per_page)
        ]
        cands += self.extra.pop(f"{variant}:{cursor}", [])
        return SearchPage(cands, cursor + self.per_page)


class FakePacer:
    # Pauses last this long (seconds) in the fake: 0 = over at once.
    hold = 0.0
    # Shared by every run, as Redis is (reset per test by the fixture).
    paused: dict[str, float] = {}

    def __init__(self, _redis=None) -> None:  # noqa: ANN001
        pass

    def wait_turn(self, key, interval, stop=None) -> bool:  # noqa: ANN001
        return not (stop and stop())

    def pause(self, source, seconds) -> float:  # noqa: ANN001
        self.paused[source] = self.hold
        return seconds

    def paused_for(self, source) -> float:  # noqa: ANN001
        return self.paused.get(source, 0.0)

    def ready_in(self, key) -> float:  # noqa: ANN001
        return 0.0


class FakeStorage:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    def ensure_bucket(self) -> None:
        pass

    def put_object(self, key, body, length, content_type) -> None:  # noqa: ANN001
        self.objects[key] = body.read()

    def get_object(self, key):  # noqa: ANN001
        return io.BytesIO(self.objects[key])


class World:
    """The web the run sees: what each address serves, what the filters say."""

    def __init__(self) -> None:
        self.bodies: dict[str, bytes] = {}
        self.ai: set[str] = set()       # xxh3 of images the AI check flags
        self.watermark: set[str] = set()
        self.off_topic: set[str] = set()
        self.downloads: list[str] = []
        self.headers: dict[str, dict[str, str]] = {}
        self.scored_keywords: list[str] = []
        self.filters_down = 0
        self.sources: dict[str, FakeSource] = {}
        self.busy_once: set[str] = set()

    def body(self, url: str) -> bytes:
        if url not in self.bodies:
            self.bodies[url] = _photo(int(hashlib.md5(url.encode()).hexdigest()[:8], 16))
        return self.bodies[url]

    def flag(self, url: str, kind: str) -> None:
        import xxhash

        flagged = {"ai": self.ai, "watermark": self.watermark, "off_topic": self.off_topic}[kind]
        flagged.add(xxhash.xxh3_128_hexdigest(self.body(url)))


@pytest.fixture
def world(db_session, monkeypatch) -> World:
    w = World()
    SessionLocal = sessionmaker(
        bind=db_session.get_bind(), autoflush=False, expire_on_commit=False, future=True,
        join_transaction_mode="create_savepoint",
    )
    monkeypatch.setattr(jobs_mod, "get_session_factory", lambda: SessionLocal)
    monkeypatch.setattr(jobs_mod, "Pacer", FakePacer)
    monkeypatch.setattr(FakePacer, "paused", {})
    monkeypatch.setattr(jobs_mod, "Redis", lambda **kw: None)
    monkeypatch.setattr(jobs_mod, "_enqueue_thumbnail", lambda *a, **k: None)
    monkeypatch.setattr(jobs_mod, "enqueue", lambda *a, **k: None)
    monkeypatch.setattr(router_mod, "enqueue", lambda *a, **k: None)
    monkeypatch.setattr(jobs_mod, "FILTERS_RETRY", 0.0)
    monkeypatch.setattr(jobs_mod, "HOST_PAUSE", 0.0)
    monkeypatch.setattr(jobs_mod, "ERROR_REST", 0.01)
    storage = FakeStorage()
    from carve_api.storage import client as storage_client

    monkeypatch.setattr(storage_client.MinioClient, "from_settings", classmethod(lambda cls: storage))
    w.storage = storage
    w.sources = {"bing": FakeSource("bing"), "commons": FakeSource("commons", ("search",), pages=1)}
    monkeypatch.setattr(
        jobs_mod, "build_sources",
        lambda names, contact, **keys: {n: w.sources[n] for n in names if n in w.sources},
    )

    def download(client, url, headers):  # noqa: ANN001
        w.downloads.append(url)
        w.headers[url] = dict(headers)
        if url.endswith("/broken.jpg"):
            raise img.DownloadFailed("HTTP 404", 404)
        if url in w.busy_once:
            w.busy_once.discard(url)
            raise img.DownloadFailed("HTTP 429", 429, 0.0)
        return w.body(url)

    monkeypatch.setattr(img, "download", download)

    def score(bodies, checks, keywords=None):  # noqa: ANN001
        import xxhash

        if w.filters_down:
            w.filters_down -= 1
            raise FiltersUnavailable("model service unreachable")
        if "relevance" in checks:
            w.scored_keywords += keywords
        out = []
        for b in bodies:
            h = xxhash.xxh3_128_hexdigest(b)
            sc = {
                "ai": 0.99 if h in w.ai else 0.01,
                "watermark": 0.99 if h in w.watermark else 0.01,
                "relevance": 0.01 if h in w.off_topic else 0.2,
            }
            out.append({c: sc[c] for c in checks})
        return out

    monkeypatch.setattr(jobs_mod, "score", score)
    return w


def _seed(db, *, existing: list[bytes] = ()) -> tuple[User, Task]:
    user = User(email=f"u-{uuid.uuid4()}@x.com", password_hash="x", role=UserRole.admin)
    db.add(user)
    db.flush()
    project = Project(name="P", owner_id=user.id)
    db.add(project)
    db.flush()
    task = Task(project_id=project.id, name="T", kind=TaskKind.image)
    db.add(task)
    db.flush()
    db.commit()
    return user, task


def _keyword(db, task, text: str, target: int) -> WebCollectKeyword:
    kw = WebCollectKeyword(task_id=task.id, keyword=text, slug=slugify(text), target=target, steps={})
    db.add(kw)
    db.commit()
    return kw


def _start(db, task, kws, **opts) -> WebCollectJob:
    options = {"sources": ["bing", "commons"], "min_side": 500, "filter_ai": True,
               "filter_watermark": True, "mode": "per_keyword", **opts}
    job = WebCollectJob(task_id=task.id, status=STATUS_QUEUED, options=options,
                        target=sum(w for _, w in kws), rejected_by={})
    db.add(job)
    db.flush()
    for pos, (kw, want) in enumerate(kws):
        db.add(WebCollectJobKeyword(job_id=job.id, keyword_id=kw.id, keyword=kw.keyword,
                                    position=pos, want=want))
    db.commit()
    return job


def _reload(db, obj):  # noqa: ANN001, ANN202
    db.expire_all()
    return db.get(type(obj), obj.id)


def _names(db, task) -> list[str]:
    return sorted(db.execute(select(Asset.original_name).where(Asset.task_id == task.id)).scalars())


def test_a_run_adds_exactly_the_target_and_names_files_by_keyword(db_session, world) -> None:
    _, task = _seed(db_session)
    kw = _keyword(db_session, task, "Tenneco logo", 7)
    job = _start(db_session, task, [(kw, 7)])

    jobs_mod.run_web_collect(str(job.id))

    job = _reload(db_session, job)
    assert job.status == STATUS_COMPLETED
    assert job.added == 7
    assert _names(db_session, task) == [f"tenneco_logo_{i:06d}.jpg" for i in range(1, 8)]
    row = db_session.get(WebCollectJobKeyword, (job.id, kw.id))
    assert row.status == KW_DONE and row.added == 7
    added = db_session.execute(
        select(WebCollectUrl).where(WebCollectUrl.task_id == task.id, WebCollectUrl.outcome == OUTCOME_ADDED)
    ).scalars().all()
    assert len(added) == 7 and all(u.asset_id for u in added)
    # Every asset is a real image with its size and a frame.
    asset = db_session.execute(select(Asset).where(Asset.task_id == task.id)).scalars().first()
    assert (asset.width, asset.height) == (800, 600) and asset.kind == AssetKind.image
    assert db_session.execute(select(Frame).where(Frame.asset_id == asset.id)).scalar_one()
    # The search position is kept on the keyword for the next run.
    assert _reload(db_session, kw).steps["bing:a"]["cursor"] > 0


def test_rejected_images_are_replaced_until_the_target_is_met(db_session, world) -> None:
    _, task = _seed(db_session)
    kw = _keyword(db_session, task, "F1 car", 10)
    bing = world.sources["bing"]
    slug = "f1_car"
    ai_url = URL.format(k=slug, n="bing-a-0")
    wm_url = URL.format(k=slug, n="bing-a-1")
    world.flag(ai_url, "ai")
    world.flag(wm_url, "watermark")
    off_url = URL.format(k=slug, n="bing-a-3")
    world.flag(off_url, "off_topic")
    small = "https://img.example.com/small.jpg"
    world.bodies[small] = _photo(99, (640, 300))
    copy = "https://mirror.example.net/copy.jpg"
    world.bodies[copy] = world.body(URL.format(k=slug, n="bing-a-2"))
    bing.extra["a:0"] = [
        Candidate("https://c8.alamy.com/x.jpg", None, "bing"),
        Candidate("https://img.example.com/known-small.jpg", None, "bing", width=300, height=200),
        Candidate(small, None, "bing"),
        Candidate(copy, None, "bing"),
        Candidate("https://img.example.com/broken.jpg", None, "bing"),
        Candidate(
            "https://img.example.com/shown.jpg", "https://img.example.com/gallery?id=3", "bing"
        ),
    ]
    job = _start(db_session, task, [(kw, 10)], filter_relevance=True)

    jobs_mod.run_web_collect(str(job.id))

    job = _reload(db_session, job)
    assert job.status == STATUS_COMPLETED and job.added == 10
    by = job.rejected_by
    assert by.get("ai_generated") == 1 and by.get("watermark") == 1 and by.get("off_topic") == 1
    # Each image is checked against its own keyword.
    assert set(world.scored_keywords) == {"F1 car"}
    # The page an image was found on goes along as Referer, as a browser does.
    assert world.headers["https://img.example.com/shown.jpg"]["Referer"] == (
        "https://img.example.com/gallery?id=3"
    )
    assert by.get("blocked_stock") == 1 and by.get("too_small") == 2
    assert by.get("duplicate", 0) + by.get("near_duplicate", 0) == 1
    assert job.failed == 1
    # Blocked and known-small addresses were never downloaded.
    assert "https://c8.alamy.com/x.jpg" not in world.downloads
    assert "https://img.example.com/known-small.jpg" not in world.downloads
    # The rejected AI image's look-alike hash is kept for next time.
    row = db_session.get(WebCollectUrl, (task.id, jobs_mod.url_key(ai_url)))
    assert row.outcome == "ai_generated" and row.dhash is not None


def test_an_image_already_in_the_task_is_not_added_again(db_session, world) -> None:
    _, task = _seed(db_session)
    kw = _keyword(db_session, task, "car", 3)
    # An image uploaded by hand earlier, identical to the first result.
    dup = world.body(URL.format(k="car", n="bing-a-0"))
    from carve_api.assets.service import AssetService

    AssetService(db_session).upload(task=task, original_name="mine.jpg", mime="image/jpeg", body=dup)
    db_session.commit()
    job = _start(db_session, task, [(kw, 3)])

    jobs_mod.run_web_collect(str(job.id))

    job = _reload(db_session, job)
    assert job.added == 3
    assert job.rejected_by.get("duplicate") == 1
    assert "mine.jpg" in _names(db_session, task)


def test_collecting_more_searches_on_and_never_repeats_an_address(db_session, world) -> None:
    _, task = _seed(db_session)
    kw = _keyword(db_session, task, "pit stop", 4)
    first = _start(db_session, task, [(kw, 4)])
    jobs_mod.run_web_collect(str(first.id))
    seen_first = set(world.downloads)

    second = _start(db_session, task, [(_reload(db_session, kw), 5)])
    jobs_mod.run_web_collect(str(second.id))

    second = _reload(db_session, second)
    assert second.added == 5
    names = _names(db_session, task)
    assert names == [f"pit_stop_{i:06d}.jpg" for i in range(1, 10)]
    repeated = [u for u in world.downloads[len(seen_first):] if u in seen_first]
    assert repeated == []


def test_a_keyword_that_runs_out_ends_short_and_others_continue(db_session, world) -> None:
    _, task = _seed(db_session)
    # 2 bing variants x 3 pages x 5 + commons 1 page x 5 = 35 candidates.
    rare = _keyword(db_session, task, "rare thing", 100)
    common = _keyword(db_session, task, "common thing", 4)
    job = _start(db_session, task, [(rare, 100), (common, 4)])

    jobs_mod.run_web_collect(str(job.id))

    job = _reload(db_session, job)
    assert job.status == STATUS_COMPLETED
    r = db_session.get(WebCollectJobKeyword, (job.id, rare.id))
    c = db_session.get(WebCollectJobKeyword, (job.id, common.id))
    assert r.status == KW_EXHAUSTED and r.added == 35
    assert c.status == KW_DONE and c.added == 4


def test_total_mode_gives_a_short_keywords_share_to_the_others(db_session, world) -> None:
    _, task = _seed(db_session)
    world.sources["bing"].pages = 1  # 10 candidates per keyword from bing, 5 from commons
    a = _keyword(db_session, task, "alpha", 30)
    b = _keyword(db_session, task, "beta", 5)
    job = _start(db_session, task, [(a, 30), (b, 5)], mode="total")

    jobs_mod.run_web_collect(str(job.id))

    ra = db_session.get(WebCollectJobKeyword, (job.id, a.id))
    rb = db_session.get(WebCollectJobKeyword, (job.id, b.id))
    assert ra.status == KW_EXHAUSTED and ra.added == 15
    # beta took over what alpha could not find, as far as it could.
    assert rb.want > 5


def test_stop_keeps_what_was_added_and_the_unfinished_addresses(db_session, world, monkeypatch) -> None:
    _, task = _seed(db_session)
    kw = _keyword(db_session, task, "helmet", 20)
    job = _start(db_session, task, [(kw, 20)])
    added = {"n": 0}
    real_add = jobs_mod._Run._add

    def add_then_stop(self, item, prep):  # noqa: ANN001
        real_add(self, item, prep)
        added["n"] += 1
        if added["n"] == 3:
            self.s.execute(
                WebCollectJob.__table__.update().where(WebCollectJob.id == self.job.id)
                .values(status=STATUS_CANCELING)
            )
            self.s.commit()
            self._last_stop_check = 0.0

    monkeypatch.setattr(jobs_mod._Run, "_add", add_then_stop)
    jobs_mod.run_web_collect(str(job.id))

    job = _reload(db_session, job)
    assert job.status == STATUS_CANCELED
    assert 3 <= job.added < 20
    assert len(_names(db_session, task)) == job.added
    pending = db_session.execute(
        select(WebCollectUrl).where(WebCollectUrl.task_id == task.id, WebCollectUrl.outcome == OUTCOME_PENDING)
    ).scalars().all()
    assert pending, "addresses found but not tried stay for the next run"
    pending_urls = {u.url for u in pending}

    # The next run starts with them.
    monkeypatch.setattr(jobs_mod._Run, "_add", real_add)
    before = len(world.downloads)
    nxt = _start(db_session, task, [(_reload(db_session, kw), 20 - job.added)])
    jobs_mod.run_web_collect(str(nxt.id))
    first_urls = world.downloads[before:before + len(pending)]
    assert pending_urls & set(first_urls)
    assert _reload(db_session, nxt).added == 20 - job.added


def test_nothing_is_added_unfiltered_while_the_filters_are_down(db_session, world) -> None:
    _, task = _seed(db_session)
    kw = _keyword(db_session, task, "banner", 4)
    world.filters_down = 2
    flagged = URL.format(k="banner", n="bing-a-0")
    world.flag(flagged, "ai")
    job = _start(db_session, task, [(kw, 4)])

    jobs_mod.run_web_collect(str(job.id))

    job = _reload(db_session, job)
    assert job.added == 4 and world.filters_down == 0
    assert job.rejected_by.get("ai_generated") == 1


def test_a_source_that_hits_a_limit_is_dropped_and_the_others_fill_in(db_session, world) -> None:
    _, task = _seed(db_session)
    kw = _keyword(db_session, task, "stadium", 4)
    world.sources["bing"].busy_once = {"a"}
    job = _start(db_session, task, [(kw, 4)])

    jobs_mod.run_web_collect(str(job.id))

    job = _reload(db_session, job)
    assert job.status == STATUS_COMPLETED and job.added == 4
    assert job.source_stats["bing"]["status"] == "stopped"
    assert job.source_stats["commons"]["added"] == 4
    # Bing was not asked again after it pushed back.
    assert [c for c in world.sources["bing"].calls] == [("stadium", "a", 0)]


def test_a_second_execution_of_a_run_is_refused(db_session, world) -> None:
    _, task = _seed(db_session)
    kw = _keyword(db_session, task, "x", 1)
    job = _start(db_session, task, [(kw, 1)])
    with jobs_mod._exclusive(db_session, job.id) as held:
        assert held
        assert jobs_mod.run_web_collect(str(job.id)) == {"ok": False, "busy": True}


# --------------------------------------------------------------------- API


def _client(db_session, user) -> TestClient:
    from carve_api.main import create_app

    app = create_app()

    def _db():
        try:
            yield db_session
        finally:
            db_session.rollback()

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(app)


def test_keywords_are_saved_cleaned_and_deduplicated(db_session, world) -> None:
    user, task = _seed(db_session)
    c = _client(db_session, user)
    r = c.put(f"/tasks/{task.id}/web-collect/keywords", json={"keywords": [
        {"keyword": "  Tenneco   logo ", "target": 300}, {"keyword": "Pérez helmet", "target": 50},
    ]})
    assert r.status_code == 200, r.text
    kws = r.json()["keywords"]
    assert [(k["keyword"], k["slug"], k["target"], k["have"]) for k in kws] == [
        ("Tenneco logo", "tenneco_logo", 300, 0), ("Pérez helmet", "perez_helmet", 50, 0),
    ]
    dup = c.put(f"/tasks/{task.id}/web-collect/keywords", json={"keywords": [
        {"keyword": "a"}, {"keyword": "A"},
    ]})
    assert dup.status_code == 400 and dup.json()["error"] == "web_collect_duplicate_keyword"
    # Same words again keep the same row (and its search position).
    again = c.put(f"/tasks/{task.id}/web-collect/keywords", json={"keywords": [
        {"keyword": "tenneco LOGO", "target": 500},
    ]})
    assert again.json()["keywords"][0]["id"] == kws[0]["id"]
    assert again.json()["keywords"][0]["target"] == 500


def test_starting_and_stopping_a_run(db_session, world) -> None:
    user, task = _seed(db_session)
    c = _client(db_session, user)
    c.put(f"/tasks/{task.id}/web-collect/keywords", json={"keywords": [{"keyword": "car", "target": 5}]})
    r = c.post(f"/tasks/{task.id}/web-collect/jobs", json={"options": {"sources": ["bing"], "min_side": 600}})
    assert r.status_code == 201, r.text
    job = r.json()
    assert job["target"] == 5 and job["options"]["min_side"] == 600
    assert job["keywords"][0]["want"] == 5
    busy = c.post(f"/tasks/{task.id}/web-collect/jobs", json={})
    assert busy.status_code == 409
    # A keyword in the run cannot be removed until it ends.
    locked = c.put(f"/tasks/{task.id}/web-collect/keywords", json={"keywords": []})
    assert locked.status_code == 409
    stop = c.post(f"/tasks/{task.id}/web-collect/jobs/{job['id']}/cancel")
    assert stop.json()["status"] == STATUS_CANCELED  # never started: closed at once


def test_nothing_to_collect_when_every_keyword_is_full(db_session, world) -> None:
    user, task = _seed(db_session)
    c = _client(db_session, user)
    c.put(f"/tasks/{task.id}/web-collect/keywords", json={"keywords": [{"keyword": "car", "target": 0}]})
    r = c.post(f"/tasks/{task.id}/web-collect/jobs", json={})
    assert r.status_code == 400 and r.json()["error"] == "web_collect_nothing_to_do"


def test_members_cannot_collect(db_session, world) -> None:
    user, task = _seed(db_session)
    member = User(email=f"m-{uuid.uuid4()}@x.com", password_hash="x", role=UserRole.member)
    db_session.add(member)
    db_session.commit()
    r = _client(db_session, member).get(f"/tasks/{task.id}/web-collect")
    assert r.status_code == 403


def test_a_site_that_says_too_many_requests_is_tried_again_later(db_session, world) -> None:
    _, task = _seed(db_session)
    # Exactly 15 candidates (bing 2 variants x 1 page x 5, commons 5), all
    # needed: the one that was refused at first has to be added too.
    world.sources["bing"].pages = 1
    kw = _keyword(db_session, task, "grid", 15)
    first = URL.format(k="grid", n="bing-a-0")
    world.busy_once.add(first)
    job = _start(db_session, task, [(kw, 15)])

    jobs_mod.run_web_collect(str(job.id))

    job = _reload(db_session, job)
    assert job.added == 15 and job.failed == 0
    assert world.downloads.count(first) == 2
    row = db_session.get(WebCollectUrl, (task.id, jobs_mod.url_key(first)))
    assert row.outcome == OUTCOME_ADDED


def test_wikimedia_needs_a_contact_and_big_originals_come_as_thumbnails() -> None:
    from carve_api.web_collect import sources

    assert "commons" not in sources.build_sources(["bing", "commons", "openverse"], "")
    assert "commons" in sources.build_sources(["bing", "commons"], "me@example.org")
    assert "me@example.org" in sources.honest_user_agent("me@example.org")
    orig = "https://upload.wikimedia.org/wikipedia/commons/e/ea/Swedish_GP_1973.jpg"
    assert sources.wikimedia_thumb(orig, 4000) == (
        "https://upload.wikimedia.org/wikipedia/commons/thumb/e/ea/Swedish_GP_1973.jpg/"
        "1920px-Swedish_GP_1973.jpg"
    )
    assert sources.wikimedia_thumb(orig, 1200) == orig
    assert sources.wikimedia_thumb("https://example.org/a.jpg", 4000) == "https://example.org/a.jpg"


# ------------------------------------------------------------ the sources


def _mock(handler) -> "httpx.Client":  # noqa: ANN001
    import httpx

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_yandex_reads_the_embedded_results_and_pauses_on_a_captcha() -> None:
    import html as html_mod
    import json as json_mod

    import httpx

    from carve_api.web_collect import sources

    state = {"initialState": {"serpList": {"items": {"entities": {
        "a": {"origUrl": "https://f1.example/car.jpg", "origWidth": 1600, "origHeight": 900,
              "snippet": {"url": "https://f1.example/story"}, "alt": "car"},
        "b": {"image": "//thumb.yandex/x"},
    }}}}}
    page = f'<div id="ImagesApp-x" data-state="{html_mod.escape(json_mod.dumps(state))}" data-x=1>'
    seen = {}

    def handler(req):  # noqa: ANN001
        seen.update(dict(req.url.params))
        return httpx.Response(200, text=page)

    got = sources.YandexSource().search(_mock(handler), "f1 car", "photo", 0)
    assert [(c.url, c.width, c.height, c.page_url) for c in got.candidates] == [
        ("https://f1.example/car.jpg", 1600, 900, "https://f1.example/story")
    ]
    assert got.next_cursor == 1 and seen["itype"] == "photo" and seen["text"] == "f1 car"

    captcha = _mock(lambda req: httpx.Response(200, text="<form>captcha</form>"))
    with pytest.raises(SourceBusy):
        sources.YandexSource().search(captcha, "f1 car", "large", 0)


def test_bing_uses_a_short_list_of_variants() -> None:
    from carve_api.web_collect import sources

    variants = sources.BingSource().variants()
    # Trimmed to the handful that add the most, so each keyword makes
    # fewer requests; every name still resolves to a real filter.
    assert 0 < len(variants) <= 10
    assert all(v in sources.BING_VARIANTS for v in variants)


def _bing_page(*results: tuple[str, str]) -> str:
    cells = "".join(
        f'<a class="iusc" m="{{&quot;murl&quot;:&quot;{u}&quot;,'
        f'&quot;purl&quot;:&quot;{p}&quot;,&quot;t&quot;:&quot;x&quot;}}">'
        for u, p in results
    )
    return f"<html><body>{cells}</body></html>"


# Bing's empty "ready" shell: small, no results.
_BING_SHELL = '<script>_d.body.classList.add("b_rdy");</script>'


def test_bing_reads_results_and_pages_on() -> None:
    from carve_api.web_collect import sources

    page = _bing_page(("https://img.example/car.jpg", "https://page.example/car"))
    sent = {}

    def handler(req):  # noqa: ANN001
        sent.update(dict(req.url.params))
        return httpx.Response(200, text=page)

    got = sources.BingSource().search(_mock(handler), "f1 car", "large", 0)
    # mkt=en-US made Bing answer this server with empty pages.
    assert "mkt" not in sent and sent["q"] == "f1 car" and sent["qft"]
    assert [(c.url, c.page_url) for c in got.candidates] == [
        ("https://img.example/car.jpg", "https://page.example/car")
    ]
    assert got.next_cursor == sources.BING_PAGE


def test_bing_an_empty_shell_before_any_result_is_read_as_a_block() -> None:
    from carve_api.web_collect import sources

    src = sources.BingSource()
    with pytest.raises(SourceBusy) as exc:
        src.search(_mock(lambda req: httpx.Response(200, text=_BING_SHELL)), "cat", "large", 0)
    # Dropped for a while so runs starting soon skip it too.
    assert exc.value.retry_after >= 600


def test_bing_an_empty_page_after_real_results_is_just_the_end() -> None:
    from carve_api.web_collect import sources

    src = sources.BingSource()
    page = _bing_page(("https://img.example/shell.jpg", "https://page.example/shell"))
    replies = iter([httpx.Response(200, text=page), httpx.Response(200, text=_BING_SHELL)])

    def handler(req):  # noqa: ANN001
        return next(replies)

    client = _mock(handler)
    assert src.search(client, "shell logo", "large", 0).candidates  # gets results first
    # Now an empty shell is read as this keyword/variant running out, not
    # a block — Bing stays in the run.
    done = src.search(client, "shell logo", "large", sources.BING_PAGE)
    assert done.candidates == [] and done.next_cursor is None


def test_bing_results_about_something_else_are_not_used() -> None:
    from carve_api.web_collect import sources

    # What Bing answered this server for "Tenneco logo": nothing about it,
    # though "logo" alone matches a logo-design page.
    junk = _bing_page(
        ("https://img.example/verity-poster.jpg", "https://films.example/verity"),
        ("https://img.example/logo-ideas.png", "https://design.example/logo-ideas"),
    )
    got = sources.BingSource().search(
        _mock(lambda req: httpx.Response(200, text=junk)), "Tenneco logo", "large", 0
    )
    assert got.off_topic and got.candidates == [] and got.next_cursor is None

    real = _bing_page(
        ("https://img.example/tenneco-logo.png", "https://brands.example/tenneco"),
        ("https://img.example/other.jpg", "https://page.example/other"),
    )
    got = sources.BingSource().search(
        _mock(lambda req: httpx.Response(200, text=real)), "Tenneco logo", "large", 0
    )
    assert not got.off_topic and len(got.candidates) == 2
    # A keyword without a telling word is never judged.
    assert sources.keyword_words("F1 logo") == []


def _ddg_world(search_page: str = '<script>vqd="4-12345678901"</script>'):  # noqa: ANN202
    calls: list[str] = []
    replies: dict[str, list[httpx.Response]] = {"i.js": []}

    def handler(req):  # noqa: ANN001
        if req.url.path == "/":
            calls.append("token")
            return httpx.Response(200, text=search_page, headers={"set-cookie": "s=1; Path=/"})
        calls.append(f"results s={req.url.params['s']} vqd={req.url.params['vqd']}")
        # The cookie set by the search page goes back, as a browser's would.
        assert req.headers.get("cookie") == "s=1"
        assert req.headers["x-requested-with"] == "XMLHttpRequest"
        if replies["i.js"]:
            return replies["i.js"].pop(0)
        return httpx.Response(200, json={
            "results": [
                {"image": "https://img.example/heuer.jpg", "url": "https://watch.example/heuer",
                 "title": "TAG Heuer logo", "width": 1600, "height": 900},
                {"image": "data:image/png;base64,xx"},
            ],
            "next": "i.js?q=TAG+Heuer+logo&o=json&p=1&s=100&u=bing&f=,,,,&l=us-en",
        })

    return httpx.Client(transport=httpx.MockTransport(handler)), calls, replies


def test_duckduckgo_gets_a_token_once_then_reads_results_with_sizes() -> None:
    from carve_api.web_collect import sources

    client, calls, _ = _ddg_world()
    src = sources.DuckDuckGoSource()
    got = src.search(client, "TAG Heuer logo", "search", 0)
    assert [(c.url, c.page_url, c.width, c.height) for c in got.candidates] == [
        ("https://img.example/heuer.jpg", "https://watch.example/heuer", 1600, 900)
    ]
    assert got.next_cursor == 100
    src.search(client, "TAG Heuer logo", "search", 100)
    assert calls == [
        "token",
        "results s=0 vqd=4-12345678901",
        "results s=100 vqd=4-12345678901",
    ]


def test_duckduckgo_renews_a_stale_token_and_stops_when_refused() -> None:
    from carve_api.web_collect import sources

    client, calls, replies = _ddg_world()
    src = sources.DuckDuckGoSource()
    src.search(client, "pirelli", "search", 0)
    replies["i.js"] = [httpx.Response(403)]
    assert src.search(client, "pirelli", "search", 100).candidates  # new token, then results
    assert calls.count("token") == 2

    replies["i.js"] = [httpx.Response(418)]
    with pytest.raises(SourceBusy):
        src.search(client, "pirelli", "search", 200)

    no_token, _, _ = _ddg_world(search_page="<html>Please verify you are human</html>")
    with pytest.raises(SourceBusy):
        sources.DuckDuckGoSource().search(no_token, "pirelli", "search", 0)


def _baidu_scramble(url: str) -> str:
    """Baidu's objURL form of an address (what baidu_address undoes)."""
    table = str.maketrans("7dgjmoru140852vsnkheb963wtqplifca", "0123456789abcdefghijklmnopqrstuvw")
    out = url.translate(table)
    for k, v in {":": "_z2C$q", ".": "_z&e3B", "/": "AzdH3F"}.items():
        out = out.replace(k, v)
    return out


def test_baidu_reads_clear_and_scrambled_addresses_and_stops_when_flagged() -> None:
    from carve_api.web_collect import sources

    body = json.dumps({"listNum": 80, "data": [
        {"replaceUrl": [{"ObjURL": "https://img.example/tenneco.jpg",
                         "FromURL": "http://news.example/tenneco"}],
         "objURL": "ignored", "width": 1280, "height": 853,
         "fromPageTitleEnc": "TENNECO_PLACEHOLDER"},
        {"objURL": _baidu_scramble("https://cdn.example/t2.png"),
         "fromURL": _baidu_scramble("https://site.example/p"), "width": "640", "height": "480",
         "fromPageTitle": "<strong>Tenneco</strong> &amp; logo"},
        {},
    ]}).replace("TENNECO_PLACEHOLDER", "Tenneco\\'s logo")  # a JS-style escape, not JSON
    sent = {}

    def handler(req):  # noqa: ANN001
        sent.update(dict(req.url.params))
        return httpx.Response(200, text=body)

    got = sources.BaiduSource().search(_mock(handler), "Tenneco logo", "search", 30)
    assert [(c.url, c.page_url, c.width, c.height, c.title) for c in got.candidates] == [
        ("https://img.example/tenneco.jpg", "http://news.example/tenneco", 1280, 853,
         "Tenneco's logo"),
        ("https://cdn.example/t2.png", "https://site.example/p", 640, 480, "Tenneco & logo"),
    ]
    assert sent["word"] == "Tenneco logo" and sent["pn"] == "30"
    assert got.next_cursor == 30 + sources.BAIDU_PAGE

    anti = {"antiFlag": 1, "message": "Forbid spider access"}
    flagged = _mock(lambda req: httpx.Response(200, json=anti))
    with pytest.raises(SourceBusy):
        sources.BaiduSource().search(flagged, "Tenneco logo", "search", 0)


def test_360_reads_results_and_pages_where_it_says() -> None:
    from carve_api.web_collect import sources

    replies = [
        {"end": False, "lastindex": 60, "list": [
            {"img": "http://img.example/a.jpg", "link": "http://auto.example/a",
             "title": "<em>Pirelli</em> logo", "width": "1080", "height": "720"},
            {"img": "", "title": "no address"},
        ]},
        {"end": True, "lastindex": 120, "list": [{"img": "https://img.example/b.jpg"}]},
    ]
    client = _mock(lambda req: httpx.Response(200, json=replies.pop(0)))
    first = sources.So360Source().search(client, "Pirelli logo", "search", 0)
    assert [(c.url, c.page_url, c.width, c.title) for c in first.candidates] == [
        ("http://img.example/a.jpg", "http://auto.example/a", 1080, "Pirelli logo")
    ]
    assert first.next_cursor == 60
    last = sources.So360Source().search(client, "Pirelli logo", "search", 60)
    assert len(last.candidates) == 1 and last.next_cursor is None


def test_chinese_sites_are_skipped_only_when_a_run_asks() -> None:
    allow = Blocklist(chinese=False)
    assert allow.reason("https://p0.sohu.com/a.jpg", "https://news.example.cn/x") is None
    assert allow.reason("https://www.alamy.com/x.jpg") == "stock"
    skip = Blocklist()
    assert skip.reason("https://p0.sohu.com/a.jpg") == "chinese"
    assert skip.reason("https://img.example.com.cn/a.jpg") == "chinese"
    # Runs started when Chinese sites were always left out keep that.
    assert jobs_mod.Options.from_json({"sources": ["bing"]}).skip_chinese_sites
    assert not router_mod.RunOptionsIn().skip_chinese_sites


def test_unsplash_leaves_out_paid_photos_and_keyed_sources_need_their_key() -> None:
    import httpx

    from carve_api.web_collect import sources

    data = {"total_pages": 3, "results": [
        {"urls": {"raw": "https://images.unsplash.com/a?ixid=1"}, "width": 4096, "height": 2048,
         "links": {"html": "https://unsplash.com/photos/a"}},
        {"urls": {"raw": "https://plus.unsplash.com/b"}, "premium": True, "width": 4000, "height": 3000},
    ]}
    def handler(req):  # noqa: ANN001
        assert req.headers["authorization"] == "Client-ID abc"
        assert req.url.host == "api.unsplash.com"
        return httpx.Response(200, json=data)

    page = sources.UnsplashSource("abc").search(_mock(handler), "x", "relevant", 0)
    assert [c.url for c in page.candidates] == ["https://images.unsplash.com/a?ixid=1&w=2048&fit=max&q=90&fm=jpg"]
    assert (page.candidates[0].width, page.candidates[0].height) == (2048, 1024) and page.next_cursor == 2

    missing = sources.unavailable("", "", "", "")
    assert set(missing) == {"commons", "pexels", "pixabay", "unsplash"}
    built = sources.build_sources(
        ["bing", "duckduckgo", "baidu", "so360", "yandex", "pexels", "pixabay"], "me@x.org",
        pexels_key="k",
    )
    assert set(built) == {"bing", "duckduckgo", "baidu", "so360", "yandex", "pexels"}


def test_a_source_answering_off_topic_is_skipped_for_that_keyword(db_session, world) -> None:
    _, task = _seed(db_session)
    kw = _keyword(db_session, task, "tenneco", 3)
    world.sources["bing"].off_topic = {"tenneco"}
    job = _start(db_session, task, [(kw, 3)])

    jobs_mod.run_web_collect(str(job.id))

    db_session.expire_all()
    job = db_session.get(WebCollectJob, job.id)
    # One search told the run; Bing's other variant was never searched.
    assert [c for c in world.sources["bing"].calls if c[0] == "tenneco"] == [("tenneco", "a", 0)]
    assert job.source_stats["bing"]["off_topic"] == 1
    assert job.source_stats["commons"]["added"] == 3
    steps = db_session.get(WebCollectKeyword, kw.id).steps
    assert steps["bing:a"]["done"] and steps["bing:b"]["done"]


def test_a_search_that_fails_once_is_retried(db_session, world) -> None:
    _, task = _seed(db_session)
    kw = _keyword(db_session, task, "kart", 8)
    world.sources["bing"].fail_once = {"a"}
    job = _start(db_session, task, [(kw, 8)])

    jobs_mod.run_web_collect(str(job.id))

    job = _reload(db_session, job)
    assert job.added == 8
    assert job.source_stats["bing"]["status"] == "ok"
    assert job.source_stats["bing"]["added"] + job.source_stats["commons"]["added"] == 8


def test_a_source_that_keeps_failing_is_dropped(db_session, world) -> None:
    _, task = _seed(db_session)
    world.sources["commons"].pages = 1  # only 5 images: Bing would be needed
    kw = _keyword(db_session, task, "kart", 10)
    world.sources["bing"].always_fail = True
    job = _start(db_session, task, [(kw, 10)])

    jobs_mod.run_web_collect(str(job.id))

    job = _reload(db_session, job)
    assert job.added == 5  # all commons had
    assert db_session.get(WebCollectJobKeyword, (job.id, kw.id)).status == KW_LIMITED
    assert job.source_stats["bing"]["status"] == "stopped"
    assert len(world.sources["bing"].calls) == jobs_mod.SOURCE_ERRORS


def test_when_no_source_can_give_more_the_run_ends_short_without_waiting(
    db_session, world, monkeypatch
) -> None:
    _, task = _seed(db_session)
    monkeypatch.setattr(FakePacer, "hold", 3600.0)
    world.sources["bing"].always_busy = True  # a CAPTCHA, an hour's pause
    world.sources["commons"].pages = 1  # 5 images, then nothing more
    kw = _keyword(db_session, task, "rare", 20)
    job = _start(db_session, task, [(kw, 20)])

    jobs_mod.run_web_collect(str(job.id))

    job = _reload(db_session, job)
    assert job.status == STATUS_COMPLETED
    row = db_session.get(WebCollectJobKeyword, (job.id, kw.id))
    assert row.status == KW_LIMITED and row.added == 5
    assert job.source_stats["bing"]["status"] == "stopped"
    assert "CAPTCHA" in job.source_stats["bing"]["note"]
    # A run started later, while the source is still paused, drops it at once.
    nxt = _start(db_session, task, [(_reload(db_session, kw), 15)])
    calls_before = len(world.sources["bing"].calls)
    jobs_mod.run_web_collect(str(nxt.id))
    assert len(world.sources["bing"].calls) == calls_before


def test_a_run_stops_if_the_image_filters_stay_unavailable(db_session, world, monkeypatch) -> None:
    _, task = _seed(db_session)
    monkeypatch.setattr(jobs_mod, "FILTERS_GIVE_UP", 0.0)
    world.filters_down = 1000
    kw = _keyword(db_session, task, "banner", 4)
    job = _start(db_session, task, [(kw, 4)])

    jobs_mod.run_web_collect(str(job.id))

    job = _reload(db_session, job)
    assert job.status == "failed" and job.added == 0
    assert "image filters were unavailable" in job.error
