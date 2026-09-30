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
            # 파이썬 sqlite3 드라이버가 알아서 여는 트랜잭션을 끈다 — 아래 "begin" 훅에서
            # 우리가 직접 BEGIN IMMEDIATE 를 건다.
            dbapi_conn.isolation_level = None
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA journal_mode=WAL")
            cur.execute("PRAGMA foreign_keys=ON")
            # 쓰기 경합 시 기다리는 시간. SQLite 는 **쓰기가 한 번에 하나**라, 짧게 잡으면
            # 기다리면 될 것을 'database is locked' 로 500 을 낸다(e2e 를 워커 넷으로
            # 돌리자 실제로 났다). 기다리는 편이 낫다 — 사용자에게 에러를 주는 것보다.
            cur.execute("PRAGMA busy_timeout=30000")
            cur.close()

        @event.listens_for(engine, "begin")
        def _begin_immediate(conn):  # noqa: ANN001
            """모든 트랜잭션을 BEGIN IMMEDIATE 로 연다 — 쓰기 잠금을 **미리** 잡는다.

            기본(BEGIN DEFERRED)은 읽기로 시작했다가 나중에 쓰기로 올라간다. 그런데 WAL
            에서 그 사이에 다른 연결이 커밋해 버리면, SQLite 는 스냅샷을 올릴 수 없어
            **기다리지 않고 즉시** `database is locked` 를 낸다(SQLITE_BUSY_SNAPSHOT).
            busy_timeout 으로도 안 풀리는 종류다 — e2e 를 워커 넷으로 돌리자 커밋 단계에서
            실제로 터졌고, 타임아웃을 5초에서 30초로 늘려도 그대로였다.

            처음부터 쓰기 잠금을 잡으면 이 경합이 사라진다. 대가는 읽기만 하는 트랜잭션도
            줄을 선다는 것인데, 이 앱은 한 프로세스로 도는 사내 도구라 문제가 되지 않는다.
            사용자에게 500 을 주는 것보다 잠깐 기다리는 편이 낫다.
            """
            conn.exec_driver_sql("BEGIN IMMEDIATE")

    return engine


def run_migrations(database_url: str) -> None:
    """앱 기동 시 alembic upgrade head — 로컬/컨테이너/테스트 모두 동일 경로."""
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    cfg.set_main_option("sqlalchemy.url", database_url)
    # alembic.ini 의 로깅 설정을 적용하지 않는다 — in-process 라 uvicorn·앱 로거를 꺼버린다.
    cfg.attributes["configure_logger"] = False
    command.upgrade(cfg, "head")


def make_sessionmaker(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(bind=engine, expire_on_commit=False)
