import asyncio
import contextlib
import logging
import threading
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from starlette.middleware.sessions import SessionMiddleware
from starlette.staticfiles import StaticFiles

from .api.admin import router as admin_router
from .api.auth import me_router
from .api.auth import router as auth_router
from .api.cli import router as cli_router
from .api.device import router as device_router
from .api.google_auth import router as google_router
from .api.nodes import router as nodes_router
from .api.public import router as public_router
from .api.shares import router as shares_router
from .api.spaces import router as spaces_router
from .api.system import router as system_router
from .api.tokens import router as tokens_router
from .bootstrap import run_bootstrap
from .config import get_settings
from .db import build_engine, make_sessionmaker, run_migrations
from .observability import bind_user, init_sentry
from .services import backup as backup_svc
from .services import search_index
from .services.storage import build_storage
from .services.trash import purge_expired

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
TRASH_SWEEP_INTERVAL_SECONDS = 6 * 3600
# uvicorn은 자기 로거만 설정한다. 루트에 핸들러가 없으면 앱의 INFO 로그(백업·휴지통 정리·
# 검색 색인)가 조용히 버려져, "정말 돌았나"를 로그로 확인할 수 없다.
# 이미 설정돼 있으면 basicConfig 는 아무것도 하지 않는다(uvicorn 설정을 덮지 않음).
logging.basicConfig(level=logging.INFO, format="%(levelname)-8s [%(name)s] %(message)s")
logger = logging.getLogger("filesharer")


def create_app() -> FastAPI:
    settings = get_settings()
    settings.validate_prod()
    Path(settings.data_dir, "blobs").mkdir(parents=True, exist_ok=True)

    run_migrations(settings.database_url)
    sentry_on = init_sentry(settings)

    engine = build_engine(settings.database_url)
    SessionLocal = make_sessionmaker(engine)
    with SessionLocal() as db:
        run_bootstrap(db)

    def _backfill_search_index() -> None:
        """기존 텍스트 파일을 내용 검색 인덱스에 채운다(기동 시 1회). 자체 세션·스토리지를
        열어 백그라운드로 돌며, 기동을 막지 않고 실패해도 앱을 죽이지 않는다."""
        try:
            with SessionLocal() as db:
                indexed = search_index.backfill(db, build_storage(settings))
            logger.info("내용 검색 인덱스 백필 완료: %d개 파일", indexed)
        except Exception:  # 백필 실패가 앱을 죽이면 안 된다
            logger.exception("내용 검색 인덱스 백필 실패")

    logger.info("내용 검색 인덱스 백필 시작(백그라운드)")
    threading.Thread(target=_backfill_search_index, name="fts-backfill", daemon=True).start()

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

    async def _run_backups() -> None:
        """주/월 백업. '이번 회차 키가 있는지'로 판단하므로 재시작해도 중복되지 않는다.

        prod에서만 돈다 — dev 머신이 같은 버킷을 보더라도 backup/ 을 건드리면
        운영 백업이 지워질 수 있기 때문.
        """
        if not (settings.backup_enabled and settings.is_prod):
            return

        def work() -> list[str]:
            store = backup_svc.build_backup_store(settings)
            with SessionLocal() as db:
                return backup_svc.run_due(db, build_storage(settings), store, settings)

        try:
            for line in await asyncio.to_thread(work):
                logger.info("백업 완료: %s", line)
        except Exception:  # 백업 실패가 앱을 죽이면 안 된다
            logger.exception("백업 실패")

    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI):
        await _sweep_trash()  # 기동 시 1회

        async def _loop() -> None:
            while True:
                await asyncio.sleep(TRASH_SWEEP_INTERVAL_SECONDS)
                await _sweep_trash()

        async def _backup_loop() -> None:
            await _run_backups()  # 기동 시 1회(이번 회차가 없으면 바로 찍는다)
            while True:
                await asyncio.sleep(max(60, settings.backup_tick_minutes * 60))
                await _run_backups()

        task = asyncio.create_task(_loop())
        backup_task = asyncio.create_task(_backup_loop())
        try:
            yield
        finally:
            for running in (task, backup_task):
                running.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await running

    app = FastAPI(title="FileSharer", docs_url=None, redoc_url=None, lifespan=lifespan)
    app.state.sessionmaker = SessionLocal

    @app.middleware("http")
    async def sentry_user_middleware(request, call_next):
        """이 요청이 누구 것인지 남긴다 — id 만(이메일은 보내지 않는다).
        세션 쿠키에서 바로 읽으므로 DB 조회가 없다."""
        if sentry_on:
            try:
                bind_user(request.session.get("uid"))
            except Exception:  # 세션이 없는 경로(공유 페이지 등)
                bind_user(None)
        return await call_next(request)

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
        # 화면 상단 뱃지가 이 값을 쓴다 — 번들에 박힌 문자열과 달리 CDN 캐시에 속지 않는다.
        return {
            "ok": True,
            "app": "filesharer",
            "version": settings.app_version or "dev",  # 제품 버전 (v1.0.0)
            "build": settings.app_build,  # main 커밋 수 — 큰 쪽이 최신
            "pr": settings.app_pr,  # 어느 작업이 들어갔는지 (#158)
            "built_at": settings.app_built_at,  # 언제 만든 이미지인지
            # 프런트가 런타임에 Sentry를 켠다. 브라우저용 DSN은 원래 공개값이라(번들에
            # 박는 게 일반적) 숨길 대상이 아니고, 이렇게 두면 환경마다 다시 빌드하지
            # 않아도 된다. **서버용(settings.sentry_dsn)은 절대 여기 싣지 않는다** —
            # 이 응답엔 인증이 없다(config.py 주석 참고).
            "sentry_dsn": settings.sentry_dsn_frontend,
            "environment": settings.app_env,
        }

    app.include_router(auth_router)
    app.include_router(me_router)
    app.include_router(admin_router)
    app.include_router(google_router)
    app.include_router(spaces_router)
    app.include_router(tokens_router)
    app.include_router(device_router)
    app.include_router(cli_router)
    app.include_router(nodes_router)
    app.include_router(shares_router)
    app.include_router(system_router)
    app.include_router(public_router)

    # 테스트 전용 데이터 초기화 라우트 — 플래그가 켜졌고 프로덕션이 아닐 때만 '존재'한다
    # (프로덕션엔 라우트 자체가 없어 404). e2e가 각 테스트 전 호출해 상태를 격리한다.
    if settings.enable_test_reset and not settings.is_prod:
        from .api.test_reset import router as test_reset_router

        app.include_router(test_reset_router)

    # 빌드된 SPA 서빙 (frontend/dist -> backend/static). API 외 경로는 index.html로 폴백.
    if STATIC_DIR.exists():
        assets = STATIC_DIR / "assets"
        if assets.exists():
            # /assets 의 파일 이름엔 내용 해시가 들어 있다(index-C2ITz2zb.js). 내용이 바뀌면
            # 이름이 바뀌므로 오래 캐시해도 안전하다 — 캐시 지시는 앞단(Caddy)이 붙인다.
            app.mount("/assets", StaticFiles(directory=assets), name="assets")

        # 여기로 나가는 건 **이름에 해시가 없는 것들**이다 — index.html, favicon 따위.
        # Cache-Control 을 안 붙이면 브라우저가 휴리스틱 캐싱을 쓴다: 대략
        # (지금 - Last-Modified) × 10% 를 유효기간으로 잡는다. 배포 직후엔 0 에 가까워
        # 문제가 없지만, **마지막 배포로부터 시간이 흐를수록 그 창이 커진다** —
        # 3일 전에 배포한 상태로 들어온 사람에겐 7시간쯤 유효한 걸로 읽힌다.
        # 그러면 오늘 배포해도 그 사람은 몇 시간 동안 옛 화면을 본다.
        #
        # no-cache 는 '저장하지 마라' 가 아니라 '쓰기 전에 물어봐라' 다.
        #
        # 비용은 **매번 껍데기를 다시 받는 것**이다 — starlette 의 FileResponse 는 조건부
        # 요청을 처리하지 않아서, If-None-Match/If-Modified-Since 를 보내도 304 가 아니라
        # 200 으로 전부 다시 온다(직접 확인했다). 여기로 나가는 건 index.html 907 바이트
        # 하나뿐이라 그걸로 충분하다. 6.3MB 짜리 /assets 는 해시가 붙어 있어 이 길로 안 온다.
        NO_CACHE = {"Cache-Control": "no-cache"}

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str):  # noqa: ARG001
            candidate = STATIC_DIR / path
            if path and candidate.is_file() and candidate.resolve().is_relative_to(STATIC_DIR):
                return FileResponse(candidate, headers=NO_CACHE)
            return FileResponse(STATIC_DIR / "index.html", headers=NO_CACHE)
    else:

        @app.get("/", include_in_schema=False)
        def dev_root() -> JSONResponse:
            return JSONResponse(
                {"app": "filesharer", "hint": "dev mode: run the Vite dev server (make dev)"}
            )

    return app


app = create_app()
