# Armin Mehri — mehri.armin@gmail.com
"""Keywords in Chinese, for Baidu and 360 Search.

Both index mostly Chinese pages, so an English keyword finds what
English-language shops say about it: for "baseball dugout bench" Baidu
answered with football-bench catalogues, for "棒球场 球员休息区" with
baseball dugouts (2026-11-09). Each keyword is translated once by
whichever language model has a key in Settings (OpenAI's cheapest in
the Logo AI catalog first, then Gemini), and kept on the keyword; the
user can change it in the dialog. About 100 tokens a keyword: far below
a cent for a whole list.

Best effort: without a key, or when the model does not answer, Baidu
and 360 search in English as before and the run says so.
"""

from __future__ import annotations

import json
import logging
import time
from typing import TYPE_CHECKING

import httpx

from carve_api.config import Settings

if TYPE_CHECKING:
    from carve_api.web_collect.models import WebCollectKeyword

log = logging.getLogger(__name__)

OPENAI_MODEL = "gpt-6-luna"
GEMINI_MODEL = "gemini-4-argon"
# After a failed translation, saving the keyword list does not ask again
# for this long (a run always asks).
RETRY_AFTER_S = 600.0

INSTRUCTIONS = (
    "You translate image-search keywords for Baidu Images. For each keyword, give the "
    "Simplified Chinese words a person in mainland China would type to find photos of the "
    "same thing. Keep the meaning, not the word order: name the object and its setting the "
    "way Chinese pages do (e.g. 'baseball dugout bench' → '棒球场 球员休息区'). Brand and "
    "company names stay as Chinese pages usually write them: the common Chinese name if "
    "there is one, otherwise the Latin name. Answer only with the search words, no "
    "explanations or quotes."
)

_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "keyword": {"type": "string"},
                    "zh": {"type": "string"},
                },
                "required": ["keyword", "zh"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["items"],
    "additionalProperties": False,
}


class TranslateError(Exception):
    pass


def provider(settings: Settings) -> str | None:
    """The model that will translate, for the run's notes."""
    if (settings.openai_api_key or "").strip():
        return f"openai:{OPENAI_MODEL}"
    if (settings.gemini_api_key or "").strip():
        return f"gemini:{GEMINI_MODEL}"
    return None


def _timeout(seconds: float) -> httpx.Timeout:
    return httpx.Timeout(seconds, connect=min(8.0, seconds))


def _openai(key: str, keywords: list[str], timeout: float) -> str:
    body = {
        "model": OPENAI_MODEL,
        "input": [
            {"role": "developer", "content": INSTRUCTIONS},
            {"role": "user", "content": json.dumps(keywords, ensure_ascii=False)},
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "translations",
                "strict": True,
                "schema": _SCHEMA,
            }
        },
        "max_output_tokens": 4000,
        "store": False,
    }
    try:
        r = httpx.post(
            "https://api.openai.com/v1/responses",
            json=body,
            headers={"Authorization": f"Bearer {key}"},
            timeout=_timeout(timeout),
        )
    except httpx.HTTPError as exc:
        raise TranslateError(f"OpenAI unreachable ({type(exc).__name__})") from exc
    if r.status_code != 200:
        raise TranslateError(f"OpenAI answered {r.status_code}")
    for item in r.json().get("output") or []:
        if item.get("type") != "message":
            continue
        for part in item.get("content") or []:
            if part.get("type") == "output_text":
                return part.get("text") or ""
    raise TranslateError("OpenAI sent no text")


def _gemini(key: str, keywords: list[str], timeout: float) -> str:
    body = {
        "systemInstruction": {"parts": [{"text": INSTRUCTIONS}]},
        "contents": [
            {"role": "user", "parts": [{"text": json.dumps(keywords, ensure_ascii=False)}]}
        ],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseJsonSchema": _SCHEMA,
            "maxOutputTokens": 4000,
        },
    }
    try:
        r = httpx.post(
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"{GEMINI_MODEL}:generateContent",
            json=body,
            headers={"x-goog-api-key": key},
            timeout=_timeout(timeout),
        )
    except httpx.HTTPError as exc:
        raise TranslateError(f"Gemini unreachable ({type(exc).__name__})") from exc
    if r.status_code != 200:
        raise TranslateError(f"Gemini answered {r.status_code}")
    for cand in r.json().get("candidates") or []:
        for part in (cand.get("content") or {}).get("parts") or []:
            if part.get("text") and not part.get("thought"):
                return part["text"]
    raise TranslateError("Gemini sent no text")


def clean_zh(text: str) -> str:
    return " ".join(str(text or "").replace("\n", " ").split())[:200]


def to_chinese(keywords: list[str], settings: Settings, timeout: float = 30.0) -> dict[str, str]:
    """{keyword: Chinese search words} for those the model answered."""
    if not keywords:
        return {}
    openai_key = (settings.openai_api_key or "").strip()
    gemini_key = (settings.gemini_api_key or "").strip()
    if openai_key:
        raw = _openai(openai_key, keywords, timeout)
    elif gemini_key:
        raw = _gemini(gemini_key, keywords, timeout)
    else:
        raise TranslateError("no OpenAI or Gemini key in Settings → Configuration")
    try:
        items = json.loads(raw).get("items") or []
    except (ValueError, AttributeError) as exc:
        raise TranslateError("the model's answer was not JSON") from exc
    wanted = {k.lower(): k for k in keywords}
    out: dict[str, str] = {}
    for it in items:
        if not isinstance(it, dict):
            continue
        kw = wanted.get(str(it.get("keyword") or "").strip().lower())
        zh = clean_zh(it.get("zh") or "")
        if kw and zh:
            out[kw] = zh
    log.info("web_collect.translated asked=%d got=%d", len(keywords), len(out))
    return out


def fill_chinese(
    keywords: list[WebCollectKeyword],
    settings: Settings,
    *,
    timeout: float = 30.0,
    after_failure: bool = True,
) -> str | None:
    """Translate the keywords that have no Chinese words yet, keeping the
    words on each keyword (the caller commits). None when there was
    nothing to do or all went well, else why not. ``after_failure=False``
    leaves alone keywords whose translation failed in the last
    ``RETRY_AFTER_S`` (saving the list should not wait on a model that
    is down every time)."""
    now = time.time()
    todo = [
        k
        for k in keywords
        if not (k.terms or {}).get("zh")
        and (after_failure or now - float((k.terms or {}).get("zh_failed") or 0) > RETRY_AFTER_S)
    ]
    if not todo:
        return None
    by = provider(settings)
    if by is None:
        return "no OpenAI or Gemini key in Settings → Configuration"
    try:
        got = to_chinese([k.keyword for k in todo], settings, timeout)
    except TranslateError as exc:
        for k in todo:
            k.terms = {**(k.terms or {}), "zh_failed": now}
        return str(exc)
    missing = []
    for k in todo:
        zh = got.get(k.keyword)
        if zh:
            k.terms = {"zh": zh, "zh_by": by}
        else:
            k.terms = {**(k.terms or {}), "zh_failed": now}
            missing.append(k.keyword)
    return f"the model gave no Chinese for {', '.join(missing)}" if missing else None
