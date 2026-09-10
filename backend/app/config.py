import os
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# 루트 .env를 cwd와 무관하게 읽는다 (uvicorn이 backend/에서 돌아도 동일).
# 테스트는 FILESHARER_ENV_FILE로 존재하지 않는 경로를 지정해 완전 격리한다.
ROOT_ENV_FILE = Path(__file__).resolve().parent.parent.parent / ".env"

# dev/CI 전용 placeholder — prod에서 이 값 그대로면 기동 실패 (fail-fast)
PLACEHOLDER_SECRETS = {"", "dev-only-not-for-prod"}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file_encoding="utf-8", extra="ignore")

    app_env: str = "dev"
    secret_key: str = "dev-only-not-for-prod"
    base_url: str = "http://localhost:8000"
    data_dir: str = "./data"
    database_url: str = "sqlite:///./data/app.db"
    max_upload_mb: int = 1024
    share_default_days: int = 7
    share_max_days: int = 30
    disk_warn_ratio: float = 0.8
    admin_email: str = ""
    admin_password: str = ""
    google_client_id: str = ""
    google_client_secret: str = ""
    allowed_google_domain: str = ""

    @property
    def is_prod(self) -> bool:
        return self.app_env == "prod"

    def validate_prod(self) -> None:
        if self.is_prod and self.secret_key in PLACEHOLDER_SECRETS:
            raise RuntimeError(
                "SECRET_KEY is unset or a dev placeholder. "
                "Set a real SECRET_KEY in .env before running with APP_ENV=prod."
            )


@lru_cache
def get_settings() -> Settings:
    env_file = os.environ.get("FILESHARER_ENV_FILE", str(ROOT_ENV_FILE))
    return Settings(_env_file=env_file)
