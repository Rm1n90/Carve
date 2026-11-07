# Armin Mehri — mehri.armin@gmail.com
"""Keyword clean-up and file names."""

from __future__ import annotations

import re
import unicodedata

_SPACES = re.compile(r"\s+")
_NOT_WORD = re.compile(r"[^a-z0-9]+")

SLUG_MAX = 60


def clean_keyword(text: str) -> str:
    """One line, single spaces, trimmed. Case is kept: it is the search."""
    return _SPACES.sub(" ", (text or "").replace("\u200b", " ")).strip()


def slugify(keyword: str) -> str:
    """ "Tenneco logo" → "tenneco_logo"; "Pérez & Bottas!" → "perez_bottas".

    Accents are folded to their letter, anything else that is not a
    letter or digit becomes one underscore. Never empty.
    """
    folded = unicodedata.normalize("NFKD", keyword).encode("ascii", "ignore").decode("ascii")
    slug = _NOT_WORD.sub("_", folded.lower()).strip("_")[:SLUG_MAX].strip("_")
    return slug or "image"


def file_name(slug: str, index: int, ext: str) -> str:
    return f"{slug}_{index:06d}.{ext}"
