# Armin Mehri — mehri.armin@gmail.com
import logging
import os
import threading
import time
from functools import lru_cache
from typing import Any

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

log = logging.getLogger(__name__)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    postgres_user: str = Field(alias="POSTGRES_USER")
    postgres_password: str = Field(alias="POSTGRES_PASSWORD")
    postgres_host: str = Field(default="postgres", alias="POSTGRES_HOST")
    postgres_port: int = Field(default=5432, alias="POSTGRES_PORT")
    postgres_db: str = Field(alias="POSTGRES_DB")

    jwt_secret: str = Field(alias="JWT_SECRET")
    jwt_access_ttl_min: int = Field(default=15, alias="JWT_ACCESS_TTL_MIN")
    jwt_refresh_ttl_days: int = Field(default=14, alias="JWT_REFRESH_TTL_DAYS")
    password_pepper: str = Field(alias="PASSWORD_PEPPER")

    minio_endpoint: str = Field(alias="MINIO_ENDPOINT", default="http://localhost:9000")
    # Public, host-reachable endpoint used only when generating presigned URLs
    # for the browser. When unset, falls back to `minio_endpoint` (back-compat).
    minio_public_endpoint: str | None = Field(alias="MINIO_PUBLIC_ENDPOINT", default=None)
    minio_root_user: str = Field(alias="MINIO_ROOT_USER")
    minio_root_password: str = Field(alias="MINIO_ROOT_PASSWORD")
    minio_bucket: str = Field(alias="MINIO_BUCKET", default="carve-assets")
    # Maximum single-asset upload size. Default 50 GiB. The upload path
    # streams to object storage in bounded-memory chunks and uses S3
    # multipart, so this ceiling is a disk/time budget, not API RAM — raise
    # it for larger source videos without touching code.
    asset_max_bytes: int = Field(
        default=50 * 1024 * 1024 * 1024, alias="ASSET_MAX_BYTES"
    )
    redis_host: str = Field(alias="REDIS_HOST", default="redis")
    redis_port: int = Field(alias="REDIS_PORT", default=6379)

    model_base_url: str = Field(alias="MODEL_BASE_URL", default="http://model:8100")
    model_timeout_seconds: float = Field(alias="MODEL_TIMEOUT_SECONDS", default=120.0)
    sam_model: str = Field(alias="SAM_MODEL", default="sam2.1-tiny")

    # Logo AI — logo detection through hosted vision LLMs. A provider is
    # offered in the editor only when its key is set; with none set the
    # feature is off. Images are sent to the chosen provider. These and
    # the other settings in ``app_settings.registry`` can also be saved
    # by a superadmin in Settings → Configuration, which takes precedence.
    anthropic_api_key: str = Field(default="", alias="ANTHROPIC_API_KEY")
    openai_api_key: str = Field(default="", alias="OPENAI_API_KEY")
    # A Gemini API key (Google AI Studio, paid tier: Gemini 4 Argon has
    # no free tier).
    gemini_api_key: str = Field(default="", alias="GEMINI_API_KEY")
    # Optional. An OpenAI *admin* key, used only to read the
    # organization's cost report and spend limit for the Billing tab.
    openai_admin_key: str = Field(default="", alias="OPENAI_ADMIN_KEY")
    # Requests in flight at once during a realtime run. Raise it if the
    # provider account's rate limits allow.
    logo_ai_concurrency: int = Field(default=4, alias="LOGO_AI_CONCURRENCY")
    # Requests per batch handed to the provider. A provider account has
    # a cap on what may wait in its batch queue; parts that do not fit
    # are sent later by themselves, but one part must fit on its own.
    # Lower this if a single part is larger than the account's cap.
    logo_ai_batch_part_requests: int = Field(default=300, alias="LOGO_AI_BATCH_PART_REQUESTS")
    # Logo AI spends money per image, so it is admin-only by default.
    # When true, members may also use it on tasks that grant them the
    # AI tools (``tasks.gpu_access_for_members``).
    logo_ai_allow_members: bool = Field(default=False, alias="LOGO_AI_ALLOW_MEMBERS")

    # Collect from web (web_collect). Downloads at once per run.
    web_collect_threads: int = Field(default=24, alias="WEB_COLLECT_THREADS")
    # Sites never collected from, besides the built-in stock / AI / Chinese
    # lists: domains separated by commas or new lines.
    web_collect_blocked_sites: str = Field(default="", alias="WEB_COLLECT_BLOCKED_SITES")
    # Scores at or above these are rejected (0–1, from the model service).
    web_collect_ai_threshold: float = Field(default=0.9, alias="WEB_COLLECT_AI_THRESHOLD")
    web_collect_watermark_threshold: float = Field(
        default=0.5, alias="WEB_COLLECT_WATERMARK_THRESHOLD"
    )
    # Images scoring below this against their keyword are off topic
    # (SigLIP2 similarity; 0.07 keeps ~99 % of on-topic images).
    web_collect_relevance_threshold: float = Field(
        default=0.07, alias="WEB_COLLECT_RELEVANCE_THRESHOLD"
    )
    # Contact put in the User-Agent sent to Wikimedia and Openverse, as
    # Wikimedia's User-Agent policy asks (an email or a URL).
    web_collect_contact: str = Field(default="", alias="WEB_COLLECT_CONTACT")
    # Free keys for the official Pexels, Pixabay and Unsplash APIs (optional sources).
    web_collect_pexels_key: str = Field(default="", alias="WEB_COLLECT_PEXELS_KEY")
    web_collect_pixabay_key: str = Field(default="", alias="WEB_COLLECT_PIXABAY_KEY")
    web_collect_unsplash_key: str = Field(default="", alias="WEB_COLLECT_UNSPLASH_KEY")

    # Who below admin may use each AI tool: "admins" (nobody), "opened_tasks"
    # (on tasks whose "AI tools for members" switch is on) or "all_tasks".
    # Set in Settings → Configuration → Member access.
    members_sam: str = Field(default="opened_tasks", alias="MEMBERS_SAM")
    members_my_model: str = Field(default="opened_tasks", alias="MEMBERS_MY_MODEL")
    members_yoloe: str = Field(default="opened_tasks", alias="MEMBERS_YOLOE")
    # Unset: follows the older LOGO_AI_ALLOW_MEMBERS (false → admins only,
    # true → tasks opened for members).
    members_logo_ai: str = Field(default="", alias="MEMBERS_LOGO_AI")

    @model_validator(mode="after")
    def _logo_ai_members_default(self) -> "Settings":
        if not self.members_logo_ai:
            self.members_logo_ai = "opened_tasks" if self.logo_ai_allow_members else "admins"
        return self

    cors_origins: str = Field(default="", alias="CORS_ORIGINS")
    api_env: str = Field(default="development", alias="API_ENV")

    # Plan-13 Phase 7 Task 5 -- OIDC SSO entry point. Comma-separated list
    # of provider names enabled for SSO (e.g. "google,microsoft"). When
    # empty, all /auth/sso/* routes return 404. Per-provider OIDC settings
    # follow the OIDC_<PROVIDER>_* convention; only Google is wired by
    # default but additional providers can be added by environment alone.
    sso_providers: str = Field(default="", alias="SSO_PROVIDERS")
    oidc_google_client_id: str = Field(default="", alias="OIDC_GOOGLE_CLIENT_ID")
    oidc_google_client_secret: str = Field(
        default="", alias="OIDC_GOOGLE_CLIENT_SECRET"
    )
    oidc_google_discovery_url: str = Field(
        default="https://accounts.google.com/.well-known/openid-configuration",
        alias="OIDC_GOOGLE_DISCOVERY_URL",
    )
    oidc_google_redirect_uri: str = Field(
        default="", alias="OIDC_GOOGLE_REDIRECT_URI"
    )
    oidc_microsoft_client_id: str = Field(
        default="", alias="OIDC_MICROSOFT_CLIENT_ID"
    )
    oidc_microsoft_client_secret: str = Field(
        default="", alias="OIDC_MICROSOFT_CLIENT_SECRET"
    )
    oidc_microsoft_discovery_url: str = Field(
        default="", alias="OIDC_MICROSOFT_DISCOVERY_URL"
    )
    oidc_microsoft_redirect_uri: str = Field(
        default="", alias="OIDC_MICROSOFT_REDIRECT_URI"
    )

    @field_validator("jwt_secret")
    @classmethod
    def _jwt_long(cls, v: str) -> str:
        if len(v) < 32:
            raise ValueError("JWT_SECRET must be at least 32 characters")
        return v

    @field_validator("password_pepper")
    @classmethod
    def _pepper_long(cls, v: str) -> str:
        if len(v) < 16:
            raise ValueError("PASSWORD_PEPPER must be at least 16 characters")
        return v

    @property
    def database_url(self) -> str:
        return (
            f"postgresql+psycopg://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def sso_provider_list(self) -> list[str]:
        return [p.strip().lower() for p in self.sso_providers.split(",") if p.strip()]


def get_enabled_sso_providers() -> list[str]:
    """Return the list of enabled OIDC SSO providers (lowercase, deduped).

    Empty list disables all /auth/sso/* routes (they return 404). Read at
    request time -- ``get_settings()`` is lru-cached so this stays cheap,
    but tests that monkeypatch the env then ``get_settings.cache_clear()``
    will see the new value immediately.
    """
    return list(dict.fromkeys(get_settings().sso_provider_list))


@lru_cache
def get_env_settings() -> Settings:
    """The settings from the environment alone: what the server starts
    with. Infrastructure (the database, storage, secrets that sign
    tokens) is read from here, never from the app's own table."""
    return Settings()  # type: ignore[call-arg]


# Saved values are read again at most this often, so a change made in
# one API process reaches the other processes and the worker within it.
OVERRIDES_TTL_SECONDS = 5.0
_overrides_lock = threading.Lock()
_cached: tuple[float, Settings] | None = None
_refreshing = False
# Bumped by ``cache_clear()``: a background read that started before it
# must not put back what it read.
_generation = 0
# The last overrides read successfully: a database blip keeps them in
# force rather than falling back to an (outdated) key in the environment
# in the middle of a paid run.
_last_overrides: dict[str, Any] = {}


def _reload(generation: int) -> Settings:
    """Read the saved values and lay them over the environment's. Called
    with ``_overrides_lock`` held."""
    global _cached, _last_overrides
    base = get_env_settings()
    try:
        from carve_api.app_settings.service import read_overrides

        _last_overrides = read_overrides()
    except Exception:  # noqa: BLE001 — e.g. before the table exists
        log.warning("app_settings.read_failed", exc_info=True)
    settings = base.model_copy(update=_last_overrides) if _last_overrides else base
    if generation == _generation:
        _cached = (time.monotonic(), settings)
    return settings


def _refresh(generation: int) -> None:
    global _refreshing
    try:
        with _overrides_lock:
            _reload(generation)
    finally:
        _refreshing = False


def get_settings() -> Settings:
    """The environment's settings with the values a superadmin saved in
    the app (``app_settings``) laid over them.

    Only the first call waits for the database. After that a caller
    always gets the settings in hand at once; once they are older than
    ``OVERRIDES_TTL_SECONDS`` a background thread reads them again, so
    no request or worker thread ever waits on that query."""
    global _refreshing
    cached = _cached
    if cached is not None:
        if time.monotonic() - cached[0] >= OVERRIDES_TTL_SECONDS and not _refreshing:
            _refreshing = True
            threading.Thread(
                target=_refresh, args=(_generation,), name="settings-refresh", daemon=True
            ).start()
        return cached[1]
    with _overrides_lock:
        if _cached is not None:
            return _cached[1]
        return _reload(_generation)


def _clear_settings_cache() -> None:
    """Re-read the environment and the saved values on the next call."""
    global _cached, _generation
    _generation += 1
    get_env_settings.cache_clear()
    _cached = None


def _after_fork_in_child() -> None:
    # A lock or a refresh flag held by another thread at the moment of a
    # fork would stay held for ever in the child.
    global _overrides_lock, _refreshing
    _overrides_lock = threading.Lock()
    _refreshing = False


os.register_at_fork(after_in_child=_after_fork_in_child)


# Tests change the environment and then call ``get_settings.cache_clear()``;
# saving a setting calls it so the saving process sees the value at once.
get_settings.cache_clear = _clear_settings_cache  # type: ignore[attr-defined]
