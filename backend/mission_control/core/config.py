from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "AI Company Mission Control"
    environment: str = "development"
    log_level: str = "INFO"
    database_url: str = (
        "postgresql+asyncpg://mission_control:mission_control_dev@localhost:5432/mission_control"
    )
    worker_mode: bool = False
    redis_url: str = "redis://localhost:6379/0"
    repository_root: str = "/repositories"
    provider_repository_root: str = "/workspaces/repositories"
    attachment_root: str = "/attachments"
    provider_attachment_root: str = "/workspaces/attachments"
    provider_gateway_url: str = "http://localhost:8100"
    provider_gateway_token: str = "replace-with-a-separate-long-random-token"
    local_admin_token: str = "replace-with-a-long-random-token"
    auto_admin_login: bool = True
    api_cors_origins: list[str] = Field(
        default_factory=lambda: [
            "http://localhost:3000",
            "http://127.0.0.1:3000",
        ]
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
