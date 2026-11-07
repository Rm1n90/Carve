# Armin Mehri — mehri.armin@gmail.com
"""Download one candidate and decide whether it is a usable image.

Runs in the download threads. Everything here is about the file alone:
can it be read, is it big enough, is it a still picture. Duplicates and
the AI / watermark filters are decided by the run, which knows the task.
"""

from __future__ import annotations

import io
import warnings
from dataclasses import dataclass

import httpx
import numpy as np
import xxhash
from PIL import Image, ImageOps

try:  # AVIF for Pillow < 11.2; registers itself with Pillow on import
    import pillow_avif  # noqa: F401
except ImportError:  # pragma: no cover — without it AVIF is "not an image"
    pass

# Rejection reasons, as counted on the run.
REJECT_SMALL = "too_small"
REJECT_NOT_IMAGE = "not_an_image"
REJECT_VECTOR = "vector_graphic"  # SVG: no pixels to train on
REJECT_ANIMATED = "animated"
REJECT_TOO_BIG = "file_too_big"
REJECT_DUPLICATE = "duplicate"
REJECT_LOOKALIKE = "near_duplicate"
REJECT_AI = "ai_generated"
REJECT_WATERMARK = "watermark"
BLOCKED_PREFIX = "blocked_"  # + blocklist group

MAX_BYTES = 30 * 1024 * 1024
# Decompression-bomb ceiling (a 12,000 × 10,000 photo still passes).
MAX_PIXELS = 120_000_000

JPEG_QUALITY = 95
_EXIF_ORIENTATION = 0x0112


class DownloadFailed(Exception):
    def __init__(self, message: str, status: int | None = None, retry_after: float = 0.0) -> None:
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after

    @property
    def busy(self) -> bool:
        """The site said "later" (429 / 503): try again, not a failure."""
        return self.status in (429, 503)


@dataclass
class Prepared:
    body: bytes
    mime: str
    ext: str
    width: int
    height: int
    xxh3: str
    dhash: int


@dataclass
class Rejected:
    reason: str
    dhash: int | None = None


def download(client: httpx.Client, url: str, headers: dict[str, str]) -> bytes:
    try:
        with client.stream("GET", url, headers=headers) as resp:
            if resp.status_code >= 400:
                try:
                    retry = float(resp.headers.get("retry-after", "") or 0)
                except ValueError:
                    retry = 0.0
                raise DownloadFailed(f"HTTP {resp.status_code}", resp.status_code, retry)
            ctype = resp.headers.get("content-type", "").split(";")[0].strip().lower()
            if ctype.startswith(("text/", "application/json", "video/", "audio/")):
                raise DownloadFailed(f"not an image ({ctype})")
            length = resp.headers.get("content-length")
            if length and length.isdigit() and int(length) > MAX_BYTES:
                raise DownloadFailed("file too big")
            buf = bytearray()
            for chunk in resp.iter_bytes():
                buf += chunk
                if len(buf) > MAX_BYTES:
                    raise DownloadFailed("file too big")
            return bytes(buf)
    except httpx.HTTPError as exc:
        raise DownloadFailed(type(exc).__name__) from exc


def dhash(im: Image.Image) -> int:
    """64-bit difference hash, as a signed int64 (fits Postgres BIGINT).

    Survives resizing and recompression; two images within a few bits of
    each other are the same picture. Taken as stored (no EXIF rotation),
    like Carve's thumbnails, so the hash of a thumbnail matches."""
    g = im.convert("L").resize((9, 8), Image.Resampling.LANCZOS)
    px = np.asarray(g, dtype=np.int16)
    bits = (px[:, 1:] > px[:, :-1]).flatten()
    value = 0
    for b in bits:
        value = (value << 1) | int(b)
    return value - (1 << 64) if value >= (1 << 63) else value


def prepare(body: bytes, min_side: int) -> Prepared | Rejected:
    """Read ``body`` and keep it if it is a still image with its short
    side at least ``min_side``, as a JPEG.

    A plain JPEG (RGB or grey, upright) is kept byte for byte: encoding
    it again would only lose quality. Everything else is saved as a
    high-quality JPEG (quality 95, full colour resolution): PNG, WebP,
    AVIF, GIF, BMP, TIFF, CMYK JPEGs, and photos stored sideways with an
    EXIF rotation, which are turned upright first. Transparent areas
    become white.
    """
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    head = body[:256].lstrip().lower()
    if head.startswith(b"<svg") or (head.startswith(b"<?xml") and b"<svg" in body[:2048].lower()):
        return Rejected(REJECT_VECTOR)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)  # palette transparency notes
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            im = Image.open(io.BytesIO(body))
            fmt = im.format or ""
            if getattr(im, "n_frames", 1) > 1 and fmt not in ("MPO",):
                return Rejected(REJECT_ANIMATED)
            if min(im.size) < min_side:
                return Rejected(REJECT_SMALL)
            im.load()
            orientation = im.getexif().get(_EXIF_ORIENTATION, 1)
            keep = fmt in ("JPEG", "MPO") and im.mode in ("RGB", "L") and orientation in (0, 1)
            if not keep:
                im = _to_rgb(ImageOps.exif_transpose(im))
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        return Rejected(REJECT_TOO_BIG)
    except Exception:  # noqa: BLE001 — truncated, unknown or corrupt
        return Rejected(REJECT_NOT_IMAGE)

    w, h = im.size
    if min(w, h) < min_side:  # a rotation can not change this, but a crop could
        return Rejected(REJECT_SMALL)
    try:
        hash_ = dhash(im)
    except Exception:  # noqa: BLE001
        return Rejected(REJECT_NOT_IMAGE)
    if keep:
        out = body
    else:
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=JPEG_QUALITY, subsampling=0, optimize=True)
        out = buf.getvalue()
    return Prepared(
        body=out,
        mime="image/jpeg",
        ext="jpg",
        width=w,
        height=h,
        xxh3=xxhash.xxh3_128_hexdigest(out),
        dhash=hash_,
    )


def _to_rgb(im: Image.Image) -> Image.Image:
    """RGB, with any transparency laid on white (logos on a transparent
    background stay readable)."""
    if im.mode == "P" and "transparency" in im.info:
        im = im.convert("RGBA")
    if im.mode in ("RGBA", "LA", "PA"):
        im = im.convert("RGBA")
        white = Image.new("RGB", im.size, (255, 255, 255))
        white.paste(im, mask=im.getchannel("A"))
        return white
    return im.convert("RGB")


class LookalikeIndex:
    """The task's look-alike hashes; ``near`` is a vectorised Hamming
    search (≈1 ms for 30,000 images)."""

    def __init__(self, hashes: list[int] | None = None, max_bits: int = 6) -> None:
        self.max_bits = max_bits
        self._arr = np.array(hashes or [], dtype=np.int64)
        self._extra: list[int] = []

    def add(self, value: int) -> None:
        self._extra.append(value)
        if len(self._extra) >= 512:
            self._arr = np.concatenate([self._arr, np.array(self._extra, dtype=np.int64)])
            self._extra = []

    def near(self, value: int) -> bool:
        v = np.int64(value)
        if self._arr.size:
            x = np.bitwise_xor(self._arr, v).view(np.uint64)
            if (_popcount64(x) <= self.max_bits).any():
                return True
        return any(
            bin((e ^ value) & 0xFFFFFFFFFFFFFFFF).count("1") <= self.max_bits for e in self._extra
        )

    def __len__(self) -> int:
        return int(self._arr.size) + len(self._extra)


def _popcount64(x: np.ndarray) -> np.ndarray:
    x = x - ((x >> np.uint64(1)) & np.uint64(0x5555555555555555))
    x = (x & np.uint64(0x3333333333333333)) + ((x >> np.uint64(2)) & np.uint64(0x3333333333333333))
    x = (x + (x >> np.uint64(4))) & np.uint64(0x0F0F0F0F0F0F0F0F)
    return (x * np.uint64(0x0101010101010101)) >> np.uint64(56)
