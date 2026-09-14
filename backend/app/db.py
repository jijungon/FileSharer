from pathlib import Path

from alembic.config import Config
from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool

from alembic import command

BACKEND_DIR = Path(__file__).resolve().parent.parent


def build_engine(database_url: str) -> Engine:
    connect_args = {}
    engine_kwargs = {}
    if database_url.startswith("sqlite"):
        connect_args["check_same_thread"] = False
        # NullPool: 요청마다 새 커넥션. 풀에 남은 커넥션의 오래된 WAL 스냅샷 때문에
        # "방금 만든 노드가 다음 요청에서 404" 나던 read-after-write 불일치를 없앤다.
        engine_kwargs["poolclass"] = NullPool
    engine = create_engine(database_url, connect_args=connect_args, **engine_kwargs)
    if database_url.startswith("sqlite"):
        from sqlalchemy import event

        @event.listens_for(engine, "connect")
        def _sqlite_pragmas(dbapi_conn, _):  # noqa: ANN001
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA journal_mode=WAL")
            cur.execute("PRAGMA foreign_keys=ON")
            cur.execute("PRAGMA busy_timeout=5000")  # 쓰기 경합 시 최대 5초 대기(SQLITE_BUSY 방지)
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
