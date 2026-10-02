# Armin Mehri — mehri.armin@gmail.com
from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


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
    # offered in the editor only when its key is set; with neither set
    # the feature is off. Images are sent to the chosen provider.
    anthropic_api_key: str = Field(default="", alias="ANTHROPIC_API_KEY")
    openai_api_key: str = Field(default="", alias="OPENAI_API_KEY")
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
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
