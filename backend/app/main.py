import asyncio
import contextlib
import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from starlette.middleware.sessions import SessionMiddleware
from starlette.staticfiles import StaticFiles

from .api.admin import router as admin_router
from .api.auth import me_router
from .api.auth import router as auth_router
from .api.google_auth import router as google_router
from .api.nodes import router as nodes_router
from .api.public import router as public_router
from .api.shares import router as shares_router
from .api.spaces import router as spaces_router
from .api.system import router as system_router
from .bootstrap import run_bootstrap
from .config import get_settings
from .db import build_engine, make_sessionmaker, run_migrations
from .services.storage import build_storage
from .services.trash import purge_expired

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
TRASH_SWEEP_INTERVAL_SECONDS = 6 * 3600
logger = logging.getLogger("filesharer")


def create_app() -> FastAPI:
    settings = get_settings()
    settings.validate_prod()
    Path(settings.data_dir, "blobs").mkdir(parents=True, exist_ok=True)

    run_migrations(settings.database_url)
    engine = build_engine(settings.database_url)
    SessionLocal = make_sessionmaker(engine)
    with SessionLocal() as db:
        run_bootstrap(db)

    async def _sweep_trash() -> None:
        """휴지통 보존기간 지난 항목 자동 완전삭제. blocking I/O라 스레드에서 실행."""

        def work() -> int:
            with SessionLocal() as db:
                return purge_expired(
                    db, build_storage(settings), settings.trash_retention_days
                )

        try:
            removed = await asyncio.to_thread(work)
            if removed:
                logger.info("휴지통 자동삭제: %d개 행 제거", removed)
        except Exception:  # 스위퍼 실패가 앱을 죽이면 안 된다
            logger.exception("휴지통 자동삭제 실패")

    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI):
        await _sweep_trash()  # 기동 시 1회

        async def _loop() -> None:
            while True:
                await asyncio.sleep(TRASH_SWEEP_INTERVAL_SECONDS)
                await _sweep_trash()

        task = asyncio.create_task(_loop())
        try:
            yield
        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    app = FastAPI(title="FileSharer", docs_url=None, redoc_url=None, lifespan=lifespan)
    app.state.sessionmaker = SessionLocal

    @app.middleware("http")
    async def commit_db_middleware(request, call_next):
        # 요청 세션이 있으면 응답을 돌려보내기 '전에' 커밋한다 → 다음 요청이 방금 만든
        # 자원을 확실히 보게 된다(get_db teardown-after-response 경합 제거).
        response = await call_next(request)
        db = getattr(request.state, "db", None)
        if db is not None:
            try:
                db.commit()
            finally:
                db.close()
        return response

    app.add_middleware(
        SessionMiddleware,
        secret_key=settings.secret_key,
        https_only=settings.is_prod,
        same_site="lax",
    )

    @app.get("/api/health")
    def health() -> dict:
        return {"ok": True, "app": "filesharer"}

    app.include_router(auth_router)
    app.include_router(me_router)
    app.include_router(admin_router)
    app.include_router(google_router)
    app.include_router(spaces_router)
    app.include_router(nodes_router)
    app.include_router(shares_router)
    app.include_router(system_router)
    app.include_router(public_router)

    # 빌드된 SPA 서빙 (frontend/dist -> backend/static). API 외 경로는 index.html로 폴백.
    if STATIC_DIR.exists():
        assets = STATIC_DIR / "assets"
        if assets.exists():
            app.mount("/assets", StaticFiles(directory=assets), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str):  # noqa: ARG001
            candidate = STATIC_DIR / path
            if path and candidate.is_file() and candidate.resolve().is_relative_to(STATIC_DIR):
                return FileResponse(candidate)
            return FileResponse(STATIC_DIR / "index.html")
    else:

        @app.get("/", include_in_schema=False)
        def dev_root() -> JSONResponse:
            return JSONResponse(
                {"app": "filesharer", "hint": "dev mode: run the Vite dev server (make dev)"}
            )

    return app


app = create_app()
