from logging.config import fileConfig

from sqlalchemy import engine_from_config, pool

from alembic import context
from app.config import get_settings

config = context.config
# 앱이 기동할 때 in-process 로도 마이그레이션을 돌린다(db.run_migrations).
# 그때 여기서 로깅을 재설정하면 fileConfig 가 **이미 있는 로거를 전부 비활성화**해서
# uvicorn과 앱(filesharer) 로그가 그 시점부터 통째로 사라진다 — 기동 이후 로그가
# 하나도 안 남던 원인. CLI로 직접 돌릴 때만 설정한다(db.py가 이 플래그를 끈다).
if config.config_file_name is not None and config.attributes.get("configure_logger", True):
    fileConfig(config.config_file_name, disable_existing_loggers=False)

config.set_main_option("sqlalchemy.url", get_settings().database_url)

# 모델 메타데이터 (autogenerate용) — 모델이 생기면 여기서 import
try:
    from app.models import Base  # noqa: F401

    target_metadata = Base.metadata
except ImportError:
    target_metadata = None


def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=True,  # SQLite ALTER 대응
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
