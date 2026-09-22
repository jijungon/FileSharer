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
    # True일 때만 /api/test/reset 라우트 마운트(테스트 격리 전용). 프로덕션 금지.
    enable_test_reset: bool = False
    secret_key: str = "dev-only-not-for-prod"
    base_url: str = "http://localhost:8000"
    # 로그인 후 돌아갈 프론트 오리진. dev(SPA=5173, API=8642)처럼 오리진이 다를 때만 지정.
    # prod는 same-origin이므로 비워둔다(상대경로 리다이렉트).
    frontend_url: str = ""
    data_dir: str = "./data"
    database_url: str = "sqlite:///./data/app.db"
    max_upload_mb: int = 1024
    # 스토리지 백엔드: local | r2. r2면 아래 R2_* 값이 필요하다.
    storage_backend: str = "local"
    r2_account_id: str = ""
    r2_access_key_id: str = ""
    r2_secret_access_key: str = ""
    r2_bucket: str = ""
    r2_endpoint: str = ""  # 비우면 account_id로 구성
    # 버킷 안 환경 구분용 키 프리픽스(예: "dev/", "prod/"). 한 버킷을 dev/prod가
    # 공유해도 객체가 섞이지 않게 한다. 빈 값이면 프리픽스 없음(기존 동작).
    r2_prefix: str = ""
    share_default_days: int = 7
    share_max_days: int = 30
    # 휴지통(soft delete) 보존 기간(일). 이보다 오래된 항목은 자동으로 완전삭제(purge).
    trash_retention_days: int = 7
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
