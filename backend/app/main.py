from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from starlette.middleware.sessions import SessionMiddleware
from starlette.staticfiles import StaticFiles

from .config import get_settings

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


def create_app() -> FastAPI:
    settings = get_settings()
    settings.validate_prod()
    Path(settings.data_dir, "blobs").mkdir(parents=True, exist_ok=True)

    app = FastAPI(title="FileSharer", docs_url=None, redoc_url=None)
    app.add_middleware(
        SessionMiddleware,
        secret_key=settings.secret_key,
        https_only=settings.is_prod,
        same_site="lax",
    )

    @app.get("/api/health")
    def health() -> dict:
        return {"ok": True, "app": "filesharer"}

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
