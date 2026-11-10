"""Конфигурация отдельного сервиса; значения REVIEW_* читаются из окружения."""

from pathlib import Path

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="REVIEW_", env_file=".env", extra="ignore")
    database_url: str = "postgresql+psycopg://review:review@127.0.0.1:55581/review"
    web_origin: str = "http://127.0.0.1:5290"
    commit_sha: str = "local"
    api_host: str = "127.0.0.1"
    api_port: int = 8990
    environment: str = "production"
    cookie_secure: bool = True
    storage_dir: Path = Path(".local/attachments")
    web_dist: Path = Path("apps/web/dist")
    s3_bucket: str = ""
    s3_endpoint_url: str = ""
    s3_region: str = ""
    cookie_name: str = "notemora_session"

    @model_validator(mode="after")
    def production_transport(self) -> "Settings":
        """Production не запускается с HTTP-сессией; local режим задаётся явно."""
        if self.environment == "production" and (
            not self.cookie_secure or not self.web_origin.startswith("https://")
        ):
            raise ValueError("Production требует HTTPS web_origin и cookie_secure=true")
        if self.web_origin.endswith("/"):
            raise ValueError("web_origin задаётся без завершающего слеша")
        return self
