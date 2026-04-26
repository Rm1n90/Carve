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
    minio_root_user: str = Field(alias="MINIO_ROOT_USER")
    minio_root_password: str = Field(alias="MINIO_ROOT_PASSWORD")
    minio_bucket: str = Field(alias="MINIO_BUCKET", default="carve-assets")
    redis_host: str = Field(alias="REDIS_HOST", default="redis")
    redis_port: int = Field(alias="REDIS_PORT", default=6379)

    model_base_url: str = Field(alias="MODEL_BASE_URL", default="http://model:8100")
    model_timeout_seconds: float = Field(alias="MODEL_TIMEOUT_SECONDS", default=120.0)

    cors_origins: str = Field(default="", alias="CORS_ORIGINS")
    api_env: str = Field(default="development", alias="API_ENV")

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


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
