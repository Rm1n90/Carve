# Armin Mehri — mehri.armin@gmail.com
"""Where candidate images come from.

Each source answers one search page at a time: give it a keyword, a
variant and a cursor, get back candidates and the next cursor (``None``
when that variant has nothing more). The run keeps the cursors, paces
the calls and decides what to download.

Measured from this server on 2026-11-07:

* **Bing** (``/images/async``, the endpoint Bing's own page and every
  open-source downloader use): 250–400 different images per phrase and
  filter, then it repeats itself. Its filters give partly different
  results, which is how a keyword reaches thousands: nine filters gave
  about 1,600 unique addresses. Results carry no dimensions.
* **Wikimedia Commons** (MediaWiki API): freely licensed, no watermarks,
  dimensions known before downloading. Its policy asks for a
  descriptive User-Agent and polite rates.
* **Openverse** (WordPress' open-licence index, anonymous): 20 per page,
  240 per query, and it rate-limits bursts (HTTP 429 behind Cloudflare).

* **Yandex** (its image page's embedded state): an independent index —
  97 % of its results for a test keyword were not among 1,566 from Bing
  — but it shows a CAPTCHA after a page or two of automated searching,
  which pauses it; so it is slow and opt-in.
* **Unsplash**, **Pexels**, **Pixabay** (official APIs, each with the
  admin's free key): free-licence photos without watermarks; good for
  general subjects, rarely for a brand.

The Yandex parsing follows imagedl (CharlesPikachu/imagedl, Apache-2.0),
rewritten so it runs under Carve's pacing, stop and resume. Not taken
from imagedl: its built-in third-party API keys (Google Custom Search,
SerpApi, Flickr, Pixabay, Pexels' site key — not ours to use), its
browser imitation (Yahoo's network fingerprint, Unsplash's browser
headers) and its proxy rotation.

Not here, because they answer this server's requests with a CAPTCHA or
an anti-bot check, and getting past those is not something Carve does
(tested 2026-11-07): Google (also to an automated browser), Yahoo,
DuckDuckGo.
"""

from __future__ import annotations

import html
import json
import re
from dataclasses import dataclass, field

import httpx

from carve_api.web_collect.models import (
    SOURCE_BING,
    SOURCE_COMMONS,
    SOURCE_OPENVERSE,
    SOURCE_PEXELS,
    SOURCE_PIXABAY,
    SOURCE_UNSPLASH,
    SOURCE_YANDEX,
)

# A browser's, for the search pages: Bing answers other agents with a
# different, thinner page. Wikimedia gets an honest one (see below).
BROWSER_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/130.0.0.0 Safari/537.36"
)


@dataclass
class Candidate:
    url: str
    page_url: str | None
    source: str
    width: int | None = None
    height: int | None = None
    title: str | None = None


@dataclass
class SearchPage:
    candidates: list[Candidate] = field(default_factory=list)
    # Where the next page starts; None when this variant is used up.
    next_cursor: int | None = None


class SourceBusy(Exception):
    """The source asked us to slow down or stop for a while (429, a
    challenge page, 403). The run pauses that source, not the run."""

    def __init__(self, message: str, retry_after: float) -> None:
        super().__init__(message)
        self.retry_after = retry_after


class SourceError(Exception):
    """A page that could not be had this time (timeout, 5xx, garbage)."""


def _retry_after(resp: httpx.Response, default: float) -> float:
    value = resp.headers.get("retry-after", "")
    try:
        return max(float(value), 5.0)
    except ValueError:
        return default


def _check(resp: httpx.Response, source: str) -> None:
    if resp.status_code == 429:
        raise SourceBusy(f"{source} rate limit (429)", _retry_after(resp, 300.0))
    if resp.status_code in (403, 503) and (
        "just a moment" in resp.text[:2000].lower() or "captcha" in resp.text[:4000].lower()
    ):
        raise SourceBusy(f"{source} challenge page ({resp.status_code})", 900.0)
    if resp.status_code == 403:
        raise SourceBusy(f"{source} refused ({resp.status_code})", 900.0)
    if resp.status_code >= 400:
        raise SourceError(f"{source} HTTP {resp.status_code}")


class Source:
    name: str
    # Seconds between two search calls, over every run at once.
    interval: float
    # Shown on the run.
    label: str

    def variants(self) -> tuple[str, ...]:
        raise NotImplementedError

    def search(self, client: httpx.Client, keyword: str, variant: str, cursor: int) -> SearchPage:
        raise NotImplementedError


# --------------------------------------------------------------------------- Bing

_LARGE = "+filterui:imagesize-large"
# Ordered by how many new images each added in the measurements above
# (aspect and age add the most; "wallpaper" added almost nothing and is
# left out). Filter names as Bing's own page uses them.
BING_VARIANTS: dict[str, str] = {
    "large": _LARGE,
    "1024": "+filterui:imagesize-custom_1024_768",
    "tall": _LARGE + "+filterui:aspect-tall",
    "square": _LARGE + "+filterui:aspect-square",
    "year": _LARGE + "+filterui:age-lt525600",
    "photo": _LARGE + "+filterui:photo-photo",
    "wide": _LARGE + "+filterui:aspect-wide",
    "clipart": _LARGE + "+filterui:photo-clipart",
    "transparent": _LARGE + "+filterui:photo-transparent",
    "black": _LARGE + "+filterui:color2-FGcls_BLACK",
    "white": _LARGE + "+filterui:color2-FGcls_WHITE",
    "red": _LARGE + "+filterui:color2-FGcls_RED",
    "blue": _LARGE + "+filterui:color2-FGcls_BLUE",
    "green": _LARGE + "+filterui:color2-FGcls_GREEN",
    "yellow": _LARGE + "+filterui:color2-FGcls_YELLOW",
    "gray": _LARGE + "+filterui:color2-FGcls_GRAY",
    "month": _LARGE + "+filterui:age-lt43200",
}
_BING_M = re.compile(r'\sm="(\{.*?\})"')
BING_PAGE = 35


class BingSource(Source):
    name = SOURCE_BING
    label = "Bing"
    interval = 1.0

    def variants(self) -> tuple[str, ...]:
        return tuple(BING_VARIANTS)

    def search(self, client: httpx.Client, keyword: str, variant: str, cursor: int) -> SearchPage:
        try:
            resp = client.get(
                "https://www.bing.com/images/async",
                params={
                    "q": keyword,
                    "first": cursor,
                    "count": BING_PAGE,
                    "qft": BING_VARIANTS[variant],
                    "mkt": "en-US",
                    "adlt": "moderate",
                },
                headers={"User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9"},
            )
        except httpx.HTTPError as exc:
            raise SourceError(f"bing: {type(exc).__name__}") from exc
        _check(resp, "Bing")
        found: list[Candidate] = []
        for raw in _BING_M.findall(resp.text):
            try:
                m = json.loads(html.unescape(raw))
            except ValueError:
                continue
            url = m.get("murl")
            if isinstance(url, str) and url.startswith(("http://", "https://")):
                found.append(
                    Candidate(url=url, page_url=m.get("purl"), source=self.name, title=m.get("t"))
                )
        # Bing answers past its end with its last page again, so the run
        # also ends a variant after pages with nothing new (see jobs).
        return SearchPage(found, cursor + BING_PAGE if found else None)


# --------------------------------------------------------------- Wikimedia Commons

COMMONS_MAX = 500  # results per keyword: relevance fades after that
_COMMONS_MIMES = {"image/jpeg", "image/png", "image/webp"}


class CommonsSource(Source):
    name = SOURCE_COMMONS
    label = "Wikimedia Commons"
    interval = 1.0

    def __init__(self, user_agent: str) -> None:
        self.user_agent = user_agent

    def variants(self) -> tuple[str, ...]:
        return ("search",)

    def search(self, client: httpx.Client, keyword: str, variant: str, cursor: int) -> SearchPage:
        try:
            resp = client.get(
                "https://commons.wikimedia.org/w/api.php",
                params={
                    "action": "query",
                    "format": "json",
                    "formatversion": 2,
                    "maxlag": 5,
                    "generator": "search",
                    "gsrsearch": keyword,
                    "gsrnamespace": 6,
                    "gsrlimit": 50,
                    "gsroffset": cursor,
                    "prop": "imageinfo",
                    "iiprop": "url|size|mime",
                    # A standard thumbnail step: originals can be 50 MB.
                    "iiurlwidth": 1920,
                },
                headers={"User-Agent": self.user_agent},
            )
        except httpx.HTTPError as exc:
            raise SourceError(f"commons: {type(exc).__name__}") from exc
        _check(resp, "Wikimedia Commons")
        try:
            data = resp.json()
        except ValueError as exc:
            raise SourceError("commons: not JSON") from exc
        if "error" in data:
            if data["error"].get("code") == "maxlag":
                raise SourceBusy("Wikimedia Commons is busy (maxlag)", 30.0)
            raise SourceError(f"commons: {data['error'].get('code')}")
        found: list[Candidate] = []
        pages = sorted(
            (data.get("query") or {}).get("pages") or [], key=lambda p: p.get("index", 0)
        )
        for page in pages:
            for info in page.get("imageinfo") or []:
                if info.get("mime") not in _COMMONS_MIMES:
                    continue
                url = info.get("thumburl") or info.get("url")
                w = info.get("thumbwidth") or info.get("width")
                h = info.get("thumbheight") or info.get("height")
                if url:
                    found.append(
                        Candidate(
                            url=url,
                            page_url=info.get("descriptionurl"),
                            source=self.name,
                            width=w,
                            height=h,
                            title=page.get("title"),
                        )
                    )
        nxt = (data.get("continue") or {}).get("gsroffset")
        if nxt is None or nxt >= COMMONS_MAX:
            return SearchPage(found, None)
        return SearchPage(found, int(nxt))


# --------------------------------------------------------------------- Openverse

OPENVERSE_PAGE = 20
OPENVERSE_MAX_PAGE = 12  # anonymous use stops at 240 results per query


class OpenverseSource(Source):
    name = SOURCE_OPENVERSE
    label = "Openverse"
    interval = 4.0

    def __init__(self, user_agent: str, wikimedia_ok: bool = True) -> None:
        self.user_agent = user_agent
        # Many results are Wikimedia files, which need a contact to download.
        self.wikimedia_ok = wikimedia_ok

    def variants(self) -> tuple[str, ...]:
        return ("large", "medium")

    def search(self, client: httpx.Client, keyword: str, variant: str, cursor: int) -> SearchPage:
        page = cursor or 1
        try:
            resp = client.get(
                "https://api.openverse.org/v1/images/",
                params={
                    "q": keyword,
                    "page": page,
                    "page_size": OPENVERSE_PAGE,
                    "size": variant,
                    "mature": "false",
                },
                headers={"User-Agent": self.user_agent},
            )
        except httpx.HTTPError as exc:
            raise SourceError(f"openverse: {type(exc).__name__}") from exc
        if resp.status_code in (400, 401) and page > 1:
            return SearchPage([], None)  # past the anonymous page limit
        _check(resp, "Openverse")
        try:
            data = resp.json()
        except ValueError as exc:
            raise SourceError("openverse: not JSON") from exc
        found = []
        for r in data.get("results") or []:
            url = str(r.get("url", "")) if isinstance(r, dict) else ""
            if not url.startswith(("http://", "https://")):
                continue
            if "wikimedia.org" in url and not self.wikimedia_ok:
                continue
            found.append(
                Candidate(
                    url=wikimedia_thumb(url, r.get("width")),
                    page_url=r.get("foreign_landing_url"),
                    source=self.name,
                    width=r.get("width"),
                    height=r.get("height"),
                    title=r.get("title"),
                )
            )
        last = min(int(data.get("page_count") or 0), OPENVERSE_MAX_PAGE)
        return SearchPage(found, page + 1 if found and page < last else None)


# ------------------------------------------------------------------- Yandex

_YANDEX_STATE = re.compile(r'id="ImagesApp-[^"]*"\s*data-state="(\{.*?\})"', re.S)
YANDEX_MAX_PAGE = 20  # 30 per page

YANDEX_VARIANTS: dict[str, dict[str, str]] = {
    "large": {"isize": "large"},
    "photo": {"isize": "large", "itype": "photo"},
    "horizontal": {"isize": "large", "iorient": "horizontal"},
    "vertical": {"isize": "large", "iorient": "vertical"},
    "square": {"isize": "large", "iorient": "square"},
    "clipart": {"isize": "large", "itype": "clipart"},
    "wallpaper": {"isize": "wallpaper"},
}


def _int(v) -> int | None:  # noqa: ANN001
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


class YandexSource(Source):
    """Yandex's image results page carries the results as JSON in the
    ``data-state`` attribute of its app element: original address,
    page, size. A CAPTCHA page instead means "slow down"."""

    name = SOURCE_YANDEX
    label = "Yandex"
    # Slow on purpose: Yandex asks for a CAPTCHA after a page or two at
    # a faster pace (2026-11-07), and a CAPTCHA pauses the source.
    interval = 15.0

    def variants(self) -> tuple[str, ...]:
        return tuple(YANDEX_VARIANTS)

    def search(self, client: httpx.Client, keyword: str, variant: str, cursor: int) -> SearchPage:
        try:
            resp = client.get(
                "https://yandex.com/images/search",
                params={"text": keyword, "p": cursor, **YANDEX_VARIANTS[variant]},
                headers={
                    "User-Agent": BROWSER_UA,
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.9",
                },
            )
        except httpx.HTTPError as exc:
            raise SourceError(f"yandex: {type(exc).__name__}") from exc
        if "showcaptcha" in str(resp.url) or (
            resp.status_code == 200
            and "ImagesApp-" not in resp.text
            and "captcha" in resp.text.lower()
        ):
            raise SourceBusy("Yandex CAPTCHA page", 1800.0)
        _check(resp, "Yandex")
        m = _YANDEX_STATE.search(resp.text)
        if not m:
            return SearchPage([], None)
        try:
            state = json.loads(html.unescape(m.group(1)))
            entities = state["initialState"]["serpList"]["items"]["entities"]
        except (ValueError, KeyError, TypeError):
            raise SourceError("yandex: page layout changed") from None
        found: list[Candidate] = []
        for item in (entities or {}).values():
            if not isinstance(item, dict):
                continue
            url = item.get("origUrl")
            if not (isinstance(url, str) and url.startswith(("http://", "https://"))):
                continue
            found.append(
                Candidate(
                    url=url,
                    page_url=(item.get("snippet") or {}).get("url")
                    if isinstance(item.get("snippet"), dict)
                    else None,
                    source=self.name,
                    width=_int(item.get("origWidth") or item.get("width")),
                    height=_int(item.get("origHeight") or item.get("height")),
                    title=item.get("alt"),
                )
            )
        nxt = cursor + 1 if found and cursor + 1 < YANDEX_MAX_PAGE else None
        return SearchPage(found, nxt)


# ------------------------------------------------------------------ Unsplash

UNSPLASH_MAX_PAGE = 34  # 30 per page


class UnsplashSource(Source):
    """Unsplash's official API with the admin's free access key
    (Settings; 50 requests an hour until Unsplash approves the app for
    more). Unsplash+ (paid) photos are left out. Files come at 2048 px
    through Unsplash's resizer."""

    name = SOURCE_UNSPLASH
    label = "Unsplash"
    # 50 requests an hour until Unsplash approves the app for more.
    interval = 72.0

    def __init__(self, key: str) -> None:
        self.key = (key or "").strip()

    def variants(self) -> tuple[str, ...]:
        return ("relevant", "latest")

    def search(self, client: httpx.Client, keyword: str, variant: str, cursor: int) -> SearchPage:
        page = cursor or 1
        try:
            resp = client.get(
                "https://api.unsplash.com/search/photos",
                params={"query": keyword, "per_page": 30, "page": page, "order_by": variant},
                headers={
                    "Authorization": f"Client-ID {self.key}",
                    "Accept-Version": "v1",
                    "User-Agent": "CarveWebCollector/1.0",
                },
            )
        except httpx.HTTPError as exc:
            raise SourceError(f"unsplash: {type(exc).__name__}") from exc
        if resp.status_code == 401:
            raise SourceBusy(
                "Unsplash refused the access key (Settings → Collect from web)", 3600.0
            )
        if resp.status_code == 403 and "rate limit" in resp.text.lower():
            raise SourceBusy("Unsplash hourly limit reached", 3600.0)
        _check(resp, "Unsplash")
        try:
            data = resp.json()
        except ValueError as exc:
            raise SourceError("unsplash: not JSON") from exc
        found: list[Candidate] = []
        for r in data.get("results") or []:
            raw = ((r or {}).get("urls") or {}).get("raw") if isinstance(r, dict) else None
            if not raw or r.get("premium") or "plus.unsplash.com" in raw:
                continue
            w, h = _int(r.get("width")), _int(r.get("height"))
            scale = min(1.0, 2048 / max(w or 1, h or 1))
            found.append(
                Candidate(
                    url=raw + ("&" if "?" in raw else "?") + "w=2048&fit=max&q=90&fm=jpg",
                    page_url=((r.get("links") or {}).get("html")),
                    source=self.name,
                    width=int((w or 0) * scale) or None,
                    height=int((h or 0) * scale) or None,
                    title=r.get("alt_description"),
                )
            )
        last = min(_int(data.get("total_pages")) or 0, UNSPLASH_MAX_PAGE)
        return SearchPage(found, page + 1 if found and page < last else None)


# ------------------------------------------------------------ Pexels, Pixabay


class PexelsSource(Source):
    """Pexels' official API with the admin's free key (Settings)."""

    name = SOURCE_PEXELS
    label = "Pexels"
    # 200 requests an hour by default (20,000 a month), shared by all runs.
    interval = 18.0

    def __init__(self, key: str) -> None:
        self.key = (key or "").strip()

    def variants(self) -> tuple[str, ...]:
        return ("search",)

    def search(self, client: httpx.Client, keyword: str, variant: str, cursor: int) -> SearchPage:
        page = cursor or 1
        try:
            resp = client.get(
                "https://api.pexels.com/v1/search",
                params={"query": keyword, "per_page": 80, "page": page},
                headers={"Authorization": self.key, "User-Agent": "CarveWebCollector/1.0"},
            )
        except httpx.HTTPError as exc:
            raise SourceError(f"pexels: {type(exc).__name__}") from exc
        if resp.status_code == 401:
            raise SourceBusy("Pexels refused the API key (Settings → Collect from web)", 3600.0)
        _check(resp, "Pexels")
        data = resp.json()
        found = []
        for r in data.get("photos") or []:
            src = (r or {}).get("src") or {}
            if not src.get("original"):
                continue
            w, h = _int(r.get("width")), _int(r.get("height"))
            scale = min(1.0, 2048 / max(w or 1, h or 1))
            found.append(
                Candidate(
                    url=src["original"] + "?auto=compress&cs=tinysrgb&w=2048",
                    page_url=r.get("url"),
                    source=self.name,
                    width=int((w or 0) * scale) or None,
                    height=int((h or 0) * scale) or None,
                    title=r.get("alt"),
                )
            )
        return SearchPage(found, page + 1 if found and data.get("next_page") else None)


class PixabaySource(Source):
    """Pixabay's official API with the admin's free key (Settings). At
    most 500 results a query; files at 1280 px (``largeImageURL``)."""

    name = SOURCE_PIXABAY
    label = "Pixabay"
    # 100 requests a minute.
    interval = 1.0

    def __init__(self, key: str) -> None:
        self.key = (key or "").strip()

    def variants(self) -> tuple[str, ...]:
        return ("photo", "illustration")

    def search(self, client: httpx.Client, keyword: str, variant: str, cursor: int) -> SearchPage:
        page = cursor or 1
        try:
            resp = client.get(
                "https://pixabay.com/api/",
                params={
                    "key": self.key,
                    "q": keyword[:100],
                    "image_type": variant,
                    "per_page": 200,
                    "page": page,
                    "safesearch": "true",
                },
                headers={"User-Agent": "CarveWebCollector/1.0"},
            )
        except httpx.HTTPError as exc:
            raise SourceError(f"pixabay: {type(exc).__name__}") from exc
        if resp.status_code in (400, 401) and "key" in resp.text.lower():
            raise SourceBusy("Pixabay refused the API key (Settings → Collect from web)", 3600.0)
        if resp.status_code == 400 and page > 1:
            return SearchPage([], None)  # past the 500-result end
        _check(resp, "Pixabay")
        data = resp.json()
        found = []
        for r in data.get("hits") or []:
            url = (r or {}).get("largeImageURL")
            if not url:
                continue
            w, h = _int(r.get("imageWidth")), _int(r.get("imageHeight"))
            scale = min(1.0, 1280 / max(w or 1, h or 1))
            found.append(
                Candidate(
                    url=url,
                    page_url=r.get("pageURL"),
                    source=self.name,
                    width=int((w or 0) * scale) or None,
                    height=int((h or 0) * scale) or None,
                    title=r.get("tags"),
                )
            )
        total = min(_int(data.get("totalHits")) or 0, 500)
        return SearchPage(found, page + 1 if found and page * 200 < total else None)


def honest_user_agent(contact: str) -> str:
    """For the APIs whose rules ask for one (Wikimedia's User-Agent policy)."""
    contact = (contact or "").strip()
    tail = f"; {contact}" if contact else ""
    return f"CarveWebCollector/1.0 (self-hosted dataset tool{tail}) httpx/{httpx.__version__}"


def unavailable(
    contact: str, pexels_key: str = "", pixabay_key: str = "", unsplash_key: str = ""
) -> dict[str, str]:
    """Sources that cannot be used yet, and what they need (set in
    Settings → Configuration → Collect from web). Wikimedia answers
    requests without a contact with 403 (checked 2026-11-07)."""
    out: dict[str, str] = {}
    if not (contact or "").strip():
        out[SOURCE_COMMONS] = "a contact address"
    if not (pexels_key or "").strip():
        out[SOURCE_PEXELS] = "a Pexels API key"
    if not (pixabay_key or "").strip():
        out[SOURCE_PIXABAY] = "a Pixabay API key"
    if not (unsplash_key or "").strip():
        out[SOURCE_UNSPLASH] = "an Unsplash access key"
    return out


def build_sources(
    names: list[str],
    contact: str,
    pexels_key: str = "",
    pixabay_key: str = "",
    unsplash_key: str = "",
) -> dict[str, Source]:
    ua = honest_user_agent(contact)
    available: dict[str, Source] = {
        SOURCE_BING: BingSource(),
        SOURCE_YANDEX: YandexSource(),
        SOURCE_COMMONS: CommonsSource(ua),
        SOURCE_OPENVERSE: OpenverseSource(ua, wikimedia_ok=bool((contact or "").strip())),
        SOURCE_UNSPLASH: UnsplashSource(unsplash_key),
        SOURCE_PEXELS: PexelsSource(pexels_key),
        SOURCE_PIXABAY: PixabaySource(pixabay_key),
    }
    blocked = unavailable(contact, pexels_key, pixabay_key, unsplash_key)
    return {n: available[n] for n in names if n in available and n not in blocked}


def wikimedia_thumb(url: str, width: int | None) -> str:
    """A Commons original wider than 1920 px as its standard 1920 px
    thumbnail: a fraction of the bytes, and the size Wikimedia serves
    from cache."""
    marker = "upload.wikimedia.org/wikipedia/commons/"
    if not width or width <= 1920 or marker not in url or "/thumb/" in url:
        return url
    head, tail = url.split(marker, 1)
    parts = tail.split("/")
    if len(parts) != 3:
        return url
    a, ab, name = parts
    low = name.lower()
    if low.endswith((".tif", ".tiff")):
        # TIFF pages are rendered to JPEG thumbnails.
        return f"{head}{marker}thumb/{a}/{ab}/{name}/lossy-page1-1920px-{name}.jpg"
    if not low.endswith((".jpg", ".jpeg", ".png", ".webp")):
        return url
    return f"{head}{marker}thumb/{a}/{ab}/{name}/1920px-{name}"


def step_order(sources: dict[str, Source]) -> list[str]:
    """Every "source:variant" of the chosen sources. Each source works
    through its own variants in this order; which source searches next
    is the run's rotation (jobs.ROTATION)."""
    return [f"{name}:{v}" for name, src in sources.items() for v in src.variants()]
