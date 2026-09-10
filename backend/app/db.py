from pathlib import Path

from alembic.config import Config
from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker

from alembic import command

BACKEND_DIR = Path(__file__).resolve().parent.parent


def build_engine(database_url: str) -> Engine:
    connect_args = {}
    if database_url.startswith("sqlite"):
        connect_args["check_same_thread"] = False
    engine = create_engine(database_url, connect_args=connect_args)
    if database_url.startswith("sqlite"):
        from sqlalchemy import event

        @event.listens_for(engine, "connect")
        def _sqlite_pragmas(dbapi_conn, _):  # noqa: ANN001
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA journal_mode=WAL")
            cur.execute("PRAGMA foreign_keys=ON")
            cur.close()

    return engine


def run_migrations(database_url: str) -> None:
    """앱 기동 시 alembic upgrade head — 로컬/컨테이너/테스트 모두 동일 경로."""
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    cfg.set_main_option("sqlalchemy.url", database_url)
    command.upgrade(cfg, "head")


def make_sessionmaker(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(bind=engine, expire_on_commit=False)
